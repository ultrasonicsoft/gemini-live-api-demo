import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AudioEngine } from './audio-engine.service';
import { BASELINE, DemoSettings, LIVE_KEYS, LogEntry, Phase, SessionResponse, TranscriptEntry } from './models';

const VOICE_THRESHOLD = 0.015;
const SETUP_TIMEOUT_MS = 15000;
const MIC_TIMEOUT_MS = 10000;
const CLOSE_WAIT_MS = 2000;
const RESUME_RETRY_MS = 800;
const MAX_RESUME_RETRIES = 3;
const MAX_LOG = 150;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Owns the WebSocket and the Live API protocol. Everything the UI shows comes from these signals. */
@Injectable({ providedIn: 'root' })
export class LiveSession {
  private readonly http = inject(HttpClient);
  private readonly audio = inject(AudioEngine);

  readonly settings = signal<DemoSettings>({ ...BASELINE });
  readonly phase = signal<Phase>('idle');
  readonly error = signal<string | null>(null);
  readonly transcript = signal<TranscriptEntry[]>([]);
  readonly log = signal<LogEntry[]>([]);
  readonly pttHeld = signal(false);

  // Metrics
  readonly connectMs = signal<number | null>(null);
  readonly latencies = signal<number[]>([]);
  readonly interruptions = signal(0);
  readonly guardHits = signal(0);
  readonly promptTokens = signal<number | null>(null);
  readonly totalTokens = signal<number | null>(null);
  readonly upstreamRate = signal({ messages: 0, kilobytes: 0 });
  readonly hasHandle = signal(false);
  readonly sessionSeconds = signal(0);

  readonly lastLatency = computed(() => this.latencies().at(-1) ?? null);
  readonly isActive = computed(() => !['idle', 'error'].includes(this.phase()));
  readonly micGated = computed(() => {
    const s = this.settings();
    if (!this.isActive()) return false;
    if (this.openingTurn()) return true;
    if (!s.autoVad) return !this.pttHeld();
    return s.muteWhileAiSpeaks && (this.phase() === 'ai-speaking' || this.audio.queuedMs() > 0);
  });
  /** True when a setting that only takes effect in a new session has changed since connecting. */
  readonly needsReconnect = computed(() => this.isActive() && this.appliedSnapshot() !== this.snapshot(this.settings()));

  private readonly appliedSnapshot = signal('');
  /** Like production: the mic stays closed until the partner finishes her opening line. */
  private readonly openingTurn = signal(false);
  private openingTimer: ReturnType<typeof setTimeout> | null = null;
  private ws: WebSocket | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private connectStartedAt = 0;
  private sessionStartedAt = 0;
  private handle: string | null = null;
  private reconnecting = false;
  private isResume = false;
  private resumeRetries = 0;
  private runId = 0;

  private lastVoiceAt = 0;
  private awaitingReply = false;
  private readonly generationDone = signal(true);
  private openUser: number | null = null;
  private openAi: number | null = null;
  private nextId = 1;
  private sentMessages = 0;
  private sentBytes = 0;

  constructor() {
    this.audio.onChunk = (pcm) => this.sendAudio(pcm);
    this.audio.onLevel = (rms) => this.onMicLevel(rms);

    // Client-only settings take effect immediately. No reconnect needed.
    effect(() => this.audio.setChunkMs(this.settings().chunkMs));

    // The model finishes generating long before the speaker finishes playing, and turnComplete can
    // arrive after the queue is already empty. Both must be signals, or this never runs again.
    effect(() => {
      if (this.phase() === 'ai-speaking' && this.generationDone() && this.audio.queuedMs() === 0) {
        this.phase.set('listening');
      }
    });
  }

  patch(patch: Partial<DemoSettings>): void {
    this.settings.update((current) => ({ ...current, ...patch }));
  }

  async start(): Promise<void> {
    const run = ++this.runId;
    this.resetSessionState();
    this.audio.startSpeaker();
    this.phase.set('connecting');
    try {
      const s = this.settings();
      await Promise.race([
        this.audio.startMic({
          chunkMs: s.chunkMs,
          echoCancellation: s.echoCancellation,
          noiseSuppression: s.noiseSuppression,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('it did not start within 10 seconds')), MIC_TIMEOUT_MS)),
      ]);
    } catch (err) {
      if (run !== this.runId) return;
      this.fail(`Microphone unavailable: ${(err as Error).message}. Allow mic access in Chrome and try again.`);
      return;
    }
    if (run !== this.runId) return; // End was pressed while the mic was starting.
    this.sessionStartedAt = Date.now();
    this.statsTimer = setInterval(() => this.sampleStats(), 1000);
    await this.connect();
  }

  async stop(): Promise<void> {
    this.runId++;
    void this.closeSocket(1000, 'Stopped by user');
    this.clearTimers();
    await this.audio.stopAll();
    this.phase.set('idle');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Cuts the socket to show what session resumption does and does not save. */
  async simulateDrop(): Promise<void> {
    if (!this.ws) return;
    this.addSystem('Connection dropped (simulated).', 'drop');
    await this.reconnect();
  }

  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.transcript.update((items) => [...items, { id: this.nextId++, role: 'user', text: trimmed, typed: true }]);
    this.markUserFinished();
    this.send({ realtimeInput: { text: trimmed } });
    this.addLog('send realtimeInput.text', true);
  }

  pushToTalk(down: boolean): void {
    if (this.settings().autoVad || !this.isActive() || down === this.pttHeld()) return;
    this.pttHeld.set(down);
    this.send({ realtimeInput: down ? { activityStart: {} } : { activityEnd: {} } });
    this.addLog(down ? 'send activityStart' : 'send activityEnd', true);
    if (!down) this.markUserFinished();
  }

  // ---- Connection --------------------------------------------------------------------------

  private async connect(): Promise<void> {
    const run = this.runId;
    const s = this.settings();
    this.appliedSnapshot.set(this.snapshot(s));
    this.connectStartedAt = performance.now();

    let session: SessionResponse;
    try {
      session = await firstValueFrom(
        this.http.post<SessionResponse>('/api/session', {
          ...s,
          resumeHandle: this.isResume ? this.handle : null,
        }),
      );
    } catch (err) {
      const body = (err as { error?: { message?: string }; message?: string });
      this.fail(body.error?.message ?? body.message ?? 'Could not create a session. Is the backend running?');
      return;
    }

    if (run !== this.runId) return; // End was pressed while the session was being created.

    const url =
      session.mode === 'direct'
        ? session.wsUrl
        : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${session.wsUrl}`;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.addLog(`socket open (${session.mode})`, false);
      // In relay mode the backend sends the setup. In direct mode the client must send one,
      // and the setup locked inside the token overrides it.
      if (session.clientSetup) ws.send(JSON.stringify(session.clientSetup));
    };
    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      this.onServerMessage(JSON.parse(text), session.initialTrigger);
    };
    ws.onclose = (event) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.onSocketClosed(event.code, event.reason);
    };

    this.setupTimer = setTimeout(() => {
      this.fail('No setupComplete within 15 seconds. Check the API key, model name and network.');
      this.closeSocket(1000, 'Setup timeout');
    }, SETUP_TIMEOUT_MS);
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.resumeRetries = 0;
    this.phase.set('reconnecting');
    // Gemini rejects a handle while the old connection is still open, so wait for it to close.
    await this.closeSocket(1000, 'Reconnecting');
    this.audio.flushPlayback();
    this.generationDone.set(true);
    this.closeTurn();
    this.isResume = this.settings().resumption && !!this.handle;
    await this.connect();
    this.reconnecting = false;
  }

  private onSocketClosed(code: number, reason: string): void {
    this.clearSetupTimer();
    this.addLog(`socket closed ${code}${reason ? ` ${reason}` : ''}`, true);
    if (this.isResume && this.phase() === 'reconnecting' && this.resumeRetries < MAX_RESUME_RETRIES) {
      // Closed before setupComplete: the previous connection may still be winding down on Gemini's side.
      this.resumeRetries++;
      setTimeout(() => {
        if (this.phase() === 'reconnecting') void this.connect();
      }, RESUME_RETRY_MS);
      return;
    }
    if (code === 1000) {
      this.phase.set('idle');
    } else {
      this.fail(`Gemini closed the connection (${code}). ${reason || 'No reason given.'}`);
    }
    this.clearTimers();
    void this.audio.stopAll();
  }

  /** Resolves once the socket has really closed, or after a short wait if the close never completes. */
  private closeSocket(code: number, reason: string): Promise<void> {
    this.clearSetupTimer();
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, CLOSE_WAIT_MS);
      ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      if (ws.readyState <= WebSocket.OPEN) ws.close(code, reason);
    });
  }

  private send(message: object): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(message);
    this.ws.send(payload);
    this.sentMessages++;
    this.sentBytes += payload.length;
  }

  // ---- Microphone ----------------------------------------------------------------------------

  private sendAudio(pcm: ArrayBuffer): void {
    if (this.phase() === 'connecting' || this.phase() === 'reconnecting' || this.micGated()) return;
    this.send({ realtimeInput: { audio: { data: toBase64(pcm), mimeType: 'audio/pcm;rate=16000' } } });
  }

  private onMicLevel(rms: number): void {
    if (rms < VOICE_THRESHOLD || this.micGated()) return;
    this.lastVoiceAt = performance.now();
    if (this.phase() === 'listening') this.awaitingReply = true;
  }

  private markUserFinished(): void {
    this.lastVoiceAt = performance.now();
    this.awaitingReply = true;
  }

  // ---- Protocol ------------------------------------------------------------------------------

  private onServerMessage(msg: any, trigger: string): void {
    if (msg.setupComplete !== undefined) return this.onSetupComplete(trigger);
    if (msg.relayEvent) return this.onRelayEvent(msg.relayEvent);
    if (msg.goAway) return this.onGoAway(msg.goAway);

    if (msg.sessionResumptionUpdate) {
      const { newHandle, resumable } = msg.sessionResumptionUpdate;
      if (resumable && newHandle) {
        this.handle = newHandle;
        this.hasHandle.set(true);
      }
      this.addLog('sessionResumptionUpdate', false);
    }

    if (msg.usageMetadata) {
      if (msg.usageMetadata.promptTokenCount) this.promptTokens.set(msg.usageMetadata.promptTokenCount);
      if (msg.usageMetadata.totalTokenCount) {
        this.totalTokens.update((total) => (total ?? 0) + msg.usageMetadata.totalTokenCount);
      }
      this.addLog('usageMetadata', false);
    }

    if (msg.toolCall) this.addLog('toolCall (no tools configured)', true);
    if (msg.serverContent) this.onServerContent(msg.serverContent);
  }

  private onSetupComplete(trigger: string): void {
    this.clearSetupTimer();
    this.connectMs.set(Math.round(performance.now() - this.connectStartedAt));
    this.phase.set('listening');
    this.addLog('setupComplete', true);

    if (this.isResume) {
      this.addSystem('Resumed with a session handle. The model still has the conversation.', 'resume');
    } else if (this.transcript().some((entry) => entry.kind === 'drop')) {
      this.addSystem('New session with no handle. The model remembers nothing.', 'resume');
    } else {
      this.markUserFinished();
      this.openingTurn.set(true);
      // Safety net so a silent model cannot leave the mic closed.
      this.openingTimer = setTimeout(() => this.openingTurn.set(false), 8000);
      this.send({ realtimeInput: { text: trigger } });
    }
  }

  private onGoAway(goAway: { timeLeft?: string }): void {
    this.addLog(`goAway, ${goAway.timeLeft ?? 'unknown'} left`, true);
    if (this.settings().resumption && this.handle) {
      this.addSystem('Server asked us to move (goAway). Reconnecting with the session handle.', 'resume');
      void this.reconnect();
    } else {
      this.addSystem('Server sent goAway, and resumption is off. This session will end.', 'drop');
    }
  }

  private onRelayEvent(event: { kind: string; detail: string }): void {
    if (event.kind.startsWith('guard')) this.guardHits.update((n) => n + 1);
    this.addSystem(event.detail, event.kind);
    this.addLog(`relay: ${event.kind}`, true);
  }

  private onServerContent(content: any): void {
    if (content.inputTranscription?.text) {
      this.appendUser(content.inputTranscription.text);
      this.addLog('inputTranscription', false);
    }
    if (content.outputTranscription?.text) this.appendAi(content.outputTranscription.text);

    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && !part.thought) this.onModelAudio(part.inlineData.data);
    }

    if (content.interrupted) this.onInterrupted();
    if (content.generationComplete) this.addLog('generationComplete', false);

    if (content.turnComplete) {
      this.generationDone.set(true);
      this.endOpeningTurn();
      this.closeTurn();
      this.addLog('turnComplete', true);
    }
  }

  private onModelAudio(data: string): void {
    if (this.awaitingReply) {
      this.awaitingReply = false;
      const latency = Math.round(performance.now() - this.lastVoiceAt);
      this.latencies.update((values) => [...values.slice(-11), latency]);
      this.addLog(`first audio after ${latency} ms`, true);
    }
    this.generationDone.set(false);
    this.phase.set('ai-speaking');
    this.audio.play(fromBase64(data));
    this.addLog('modelTurn audio + outputTranscription', false);
  }

  private onInterrupted(): void {
    this.interruptions.update((n) => n + 1);
    this.generationDone.set(true);
    this.endOpeningTurn();
    this.awaitingReply = true;
    this.addLog('interrupted', true);

    if (this.openAi !== null) {
      const id = this.openAi;
      this.transcript.update((items) => items.map((e) => (e.id === id ? { ...e, interrupted: true } : e)));
      this.openAi = null;
    }

    if (this.settings().flushOnInterrupt) {
      this.audio.flushPlayback();
      this.phase.set('listening');
    } else {
      this.addSystem(`Ignored "interrupted": ${this.audio.queuedMs()} ms of speech is still queued.`, 'drop');
    }
  }

  // ---- Transcript and log --------------------------------------------------------------------

  private appendUser(text: string): void {
    if (this.openUser !== null) {
      const id = this.openUser;
      this.transcript.update((items) => items.map((e) => (e.id === id ? { ...e, text: e.text + text } : e)));
      return;
    }
    // Input transcription can arrive after the reply has started. Keep the order readable.
    const entry: TranscriptEntry = { id: this.nextId++, role: 'user', text };
    this.openUser = entry.id;
    this.transcript.update((items) => {
      const aiIndex = this.openAi === null ? -1 : items.findIndex((e) => e.id === this.openAi);
      return aiIndex < 0 ? [...items, entry] : [...items.slice(0, aiIndex), entry, ...items.slice(aiIndex)];
    });
  }

  private appendAi(text: string): void {
    if (this.openAi !== null) {
      const id = this.openAi;
      this.transcript.update((items) => items.map((e) => (e.id === id ? { ...e, text: e.text + text } : e)));
      return;
    }
    const entry: TranscriptEntry = { id: this.nextId++, role: 'ai', text };
    this.openAi = entry.id;
    this.transcript.update((items) => [...items, entry]);
  }

  private closeTurn(): void {
    this.openUser = null;
    this.openAi = null;
  }

  private addSystem(text: string, kind: string): void {
    this.transcript.update((items) => [...items, { id: this.nextId++, role: 'system', text, kind }]);
  }

  /** Repeated events such as audio chunks collapse into one row with a count. */
  private addLog(label: string, hot: boolean): void {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    this.log.update((items) => {
      const last = items.at(-1);
      if (last && last.label === label) {
        return [...items.slice(0, -1), { ...last, count: last.count + 1, time }];
      }
      return [...items.slice(-(MAX_LOG - 1)), { id: this.nextId++, time, label, count: 1, hot }];
    });
  }

  // ---- Housekeeping --------------------------------------------------------------------------

  private snapshot(s: DemoSettings): string {
    const copy: Partial<DemoSettings> = { ...s };
    for (const key of LIVE_KEYS) delete copy[key];
    return JSON.stringify(copy);
  }

  private sampleStats(): void {
    this.upstreamRate.set({ messages: this.sentMessages, kilobytes: Math.round(this.sentBytes / 1024) });
    this.sentMessages = 0;
    this.sentBytes = 0;
    this.sessionSeconds.set(Math.round((Date.now() - this.sessionStartedAt) / 1000));
  }

  private resetSessionState(): void {
    this.error.set(null);
    this.transcript.set([]);
    this.log.set([]);
    this.latencies.set([]);
    this.connectMs.set(null);
    this.interruptions.set(0);
    this.guardHits.set(0);
    this.promptTokens.set(null);
    this.totalTokens.set(null);
    this.hasHandle.set(false);
    this.sessionSeconds.set(0);
    this.pttHeld.set(false);
    this.endOpeningTurn();
    this.handle = null;
    this.isResume = false;
    this.awaitingReply = false;
    this.generationDone.set(true);
    this.closeTurn();
  }

  private endOpeningTurn(): void {
    if (this.openingTimer) clearTimeout(this.openingTimer);
    this.openingTimer = null;
    this.openingTurn.set(false);
  }

  private fail(message: string): void {
    this.error.set(message);
    this.phase.set('error');
    this.clearTimers();
    void this.audio.stopAll();
  }

  private clearSetupTimer(): void {
    if (this.setupTimer) clearTimeout(this.setupTimer);
    this.setupTimer = null;
  }

  private clearTimers(): void {
    this.clearSetupTimer();
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.upstreamRate.set({ messages: 0, kilobytes: 0 });
  }
}
