import { Injectable, signal } from '@angular/core';

export interface MicOptions {
  chunkMs: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
}

/** Microphone at 16 kHz PCM in, model speech at 24 kHz PCM out. */
@Injectable({ providedIn: 'root' })
export class AudioEngine {
  readonly micLevel = signal(0);
  readonly outputLevel = signal(0);
  /** Milliseconds of model speech scheduled but not yet played. */
  readonly queuedMs = signal(0);

  onChunk: ((pcm: ArrayBuffer) => void) | null = null;
  /** Called every 20 ms with the mic's loudness. */
  onLevel: ((rms: number) => void) | null = null;

  private micContext: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;

  private speakerContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private nextPlayTime = 0;
  private readonly scheduled = new Set<AudioBufferSourceNode>();
  private meterTimer: ReturnType<typeof setInterval> | null = null;

  async startMic(options: MicOptions): Promise<void> {
    await this.stopMic();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: options.echoCancellation,
        noiseSuppression: options.noiseSuppression,
        autoGainControl: true,
      },
    });

    this.micContext = new AudioContext({ sampleRate: 16000 });
    await this.micContext.audioWorklet.addModule('worklets/pcm-capture.js');
    this.worklet = new AudioWorkletNode(this.micContext, 'pcm-capture', {
      numberOfOutputs: 0,
      processorOptions: { chunkMs: options.chunkMs },
    });
    this.worklet.port.onmessage = ({ data }) => {
      if (data.type === 'pcm') {
        this.onChunk?.(data.pcm);
      } else {
        this.micLevel.set(data.rms);
        this.onLevel?.(data.rms);
      }
    };
    this.micContext.createMediaStreamSource(this.stream).connect(this.worklet);
  }

  setChunkMs(chunkMs: number): void {
    this.worklet?.port.postMessage({ chunkMs });
  }

  async stopMic(): Promise<void> {
    this.worklet?.disconnect();
    this.worklet = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    await this.micContext?.close().catch(() => undefined);
    this.micContext = null;
    this.micLevel.set(0);
  }

  /** Must be called from a click handler: browsers only start audio after a user gesture. */
  startSpeaker(): void {
    if (!this.speakerContext) {
      this.speakerContext = new AudioContext({ sampleRate: 24000 });
      this.analyser = this.speakerContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.connect(this.speakerContext.destination);
    }
    void this.speakerContext.resume();
    this.meterTimer ??= setInterval(() => this.updateMeters(), 60);
  }

  play(pcm: ArrayBuffer): void {
    if (!this.speakerContext || !this.analyser) return;
    const samples = new Int16Array(pcm);
    const buffer = this.speakerContext.createBuffer(1, samples.length, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;

    const source = this.speakerContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    source.onended = () => this.scheduled.delete(source);

    // Chunks arrive faster than real time, so each one is scheduled after the previous one.
    const startAt = Math.max(this.speakerContext.currentTime, this.nextPlayTime);
    source.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;
    this.scheduled.add(source);
  }

  /** What the server cannot do for you: drop everything queued locally. */
  flushPlayback(): void {
    for (const source of this.scheduled) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    this.scheduled.clear();
    this.nextPlayTime = 0;
    this.queuedMs.set(0);
  }

  async stopAll(): Promise<void> {
    this.flushPlayback();
    await this.stopMic();
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    await this.speakerContext?.close().catch(() => undefined);
    this.speakerContext = null;
    this.analyser = null;
    this.outputLevel.set(0);
  }

  private updateMeters(): void {
    if (!this.speakerContext || !this.analyser) return;
    this.queuedMs.set(Math.max(0, Math.round((this.nextPlayTime - this.speakerContext.currentTime) * 1000)));
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    this.outputLevel.set(rms);
  }
}
