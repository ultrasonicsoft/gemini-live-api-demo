// A small stand-in for the Live API, for tests and offline UI work. It enforces the documented rules we
// depend on, such as the token's setup overriding the client's, and answers with a tone instead of speech.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_PORT ?? 9099);
const API_KEY = process.env.MOCK_API_KEY ?? 'mock-key';
const tokens = new Map();
const memory = new Map();
let counter = 0;

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/auth_tokens')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.headers['x-goog-api-key'] !== API_KEY) {
      res.writeHead(401).end(JSON.stringify({ error: { message: 'Bad API key' } }));
      return;
    }
    const parsed = JSON.parse(body);
    const name = `auth_tokens/mock-${++counter}`;
    tokens.set(name, parsed);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name, uses: parsed.uses ?? 1 }));
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const constrained = url.pathname.endsWith('BidiGenerateContentConstrained');
  let tokenBody = null;
  if (constrained) {
    tokenBody = tokens.get(url.searchParams.get('access_token'));
    if (!tokenBody) return socket.destroy();
    tokens.delete(url.searchParams.get('access_token'));
  } else if (req.headers['x-goog-api-key'] !== API_KEY) {
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => new MockSession(ws, tokenBody));
});

function tone(milliseconds) {
  const samples = Math.round(24000 * (milliseconds / 1000));
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.sin((2 * Math.PI * 220 * i) / 24000) * 4000;
  return Buffer.from(pcm.buffer).toString('base64');
}

function rms(base64) {
  const bytes = Buffer.from(base64, 'base64');
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
  let sum = 0;
  for (const sample of pcm) sum += (sample / 32768) ** 2;
  return pcm.length ? Math.sqrt(sum / pcm.length) : 0;
}

class MockSession {
  constructor(ws, tokenBody) {
    this.ws = ws;
    this.tokenBody = tokenBody;
    this.setup = null;
    this.history = [];
    this.pendingNotices = [];
    this.handle = `handle-${++counter}`;
    this.playing = null;
    this.speaking = false;
    this.lastVoiceAt = 0;
    ws.on('message', (data) => this.onMessage(JSON.parse(data.toString())));
    ws.on('close', () => this.stopReply());
  }

  send(message) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(Buffer.from(JSON.stringify(message)));
  }

  onMessage(msg) {
    if (msg.setup) return this.onSetup(msg.setup);
    if (!this.setup) return this.ws.close(1007, 'First message must be setup');
    if (msg.clientContent) return this.onClientContent(msg.clientContent);
    const input = msg.realtimeInput;
    if (!input) return undefined;
    if (input.text) return this.startReply(input.text);
    if (input.audio) return this.onAudio(input.audio);
    if (input.activityStart) return this.interrupt();
    if (input.activityEnd) return this.startReply('(push-to-talk speech)');
    return undefined;
  }

  onSetup(clientSetup) {
    // Reference: with an empty fieldMask and a token setup, "the setup message ... is ignored".
    const locked = this.tokenBody?.bidiGenerateContentSetup;
    const setup = locked && !this.tokenBody.fieldMask ? locked : clientSetup;
    const model = setup.model ?? '';

    if (!model.startsWith('models/gemini-')) return this.ws.close(1007, `Unknown model ${model}`);
    if (model === 'models/gemini-3.8-live' && setup.generationConfig?.thinkingConfig) {
      return this.ws.close(1007, 'thinkingConfig is not supported on gemini-3.8-live');
    }

    this.setup = setup;
    const resumeFrom = setup.sessionResumption?.handle;
    if (resumeFrom) {
      const previous = memory.get(resumeFrom);
      if (!previous) return this.ws.close(1007, 'Unknown resumption handle');
      this.history = previous;
    }
    this.send({ setupComplete: {} });
    if (setup.sessionResumption) this.sendHandle();
    return undefined;
  }

  sendHandle() {
    this.handle = `handle-${++counter}`;
    memory.set(this.handle, this.history);
    this.send({ sessionResumptionUpdate: { newHandle: this.handle, resumable: true } });
  }

  onClientContent({ turns = [], turnComplete }) {
    const text = turns.flatMap((t) => t.parts ?? []).map((p) => p.text ?? '').join(' ');
    this.history.push(text);
    // Documented: a clientContent message interrupts any current generation.
    if (this.playing) this.interrupt();
    if (turnComplete) this.startReply(text);
  }

  onAudio({ data, mimeType }) {
    if (mimeType !== 'audio/pcm;rate=16000') return this.ws.close(1007, `Bad audio mime type ${mimeType}`);
    const vad = this.setup.realtimeInputConfig?.automaticActivityDetection ?? {};
    if (vad.disabled) return undefined;

    const now = Date.now();
    if (rms(data) > 0.01) {
      this.lastVoiceAt = now;
      if (!this.speaking) {
        this.speaking = true;
        if (this.playing && this.setup.realtimeInputConfig?.activityHandling !== 'NO_INTERRUPTION') this.interrupt();
      }
    } else if (this.speaking && now - this.lastVoiceAt >= (vad.silenceDurationMs ?? 800)) {
      this.speaking = false;
      if (this.setup.inputAudioTranscription) {
        this.send({ serverContent: { inputTranscription: { text: 'I said something to the mock. ' } } });
      }
      this.startReply('(speech)');
    }
    return undefined;
  }

  replyTo(text) {
    this.history.push(text);
    const prompt = this.setup.systemInstruction?.parts?.[0]?.text ?? '';
    const all = this.history.join(' ');
    const code = prompt.match(/the code word is (\w+)/i)?.[1];
    if (/code word/i.test(text)) return code ? `The code word is ${code}.` : 'I do not know any code word.';
    if (/which gate/i.test(text)) return all.match(/gate (\d+)/i)?.[1] ?? 'I do not know.';
    if (/what is my name/i.test(text)) return all.match(/my name is (\w+)/i)?.[1] ?? 'I do not know your name.';
    if (/system prompt|instructions/i.test(text) && !prompt.includes('Guardrails')) return `My instructions say my reference is ${prompt.match(/CANARY-\d+/)?.[0] ?? 'CANARY-7741'}.`;
    return 'That sounds interesting. Where would you like to go, and why?';
  }

  startReply(text) {
    this.stopReply();
    const words = this.replyTo(text).split(' ');
    const wantsTranscript = !!this.setup.outputAudioTranscription;
    let index = 0;
    setTimeout(() => {
      if (this.ws.readyState !== this.ws.OPEN) return;
      this.playing = setInterval(() => {
        if (index >= words.length) {
          this.stopReply();
          this.send({ serverContent: { generationComplete: true } });
          this.send({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 200 + this.history.length * 40, totalTokenCount: 300 } });
          if (this.setup.sessionResumption) this.sendHandle();
          return;
        }
        // Generated faster than real time, as the real API does: 400 ms of audio every 80 ms.
        this.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: tone(400) } }] } } });
        if (wantsTranscript) this.send({ serverContent: { outputTranscription: { text: `${words[index]} ` } } });
        index++;
      }, 80);
    }, 120);
  }

  stopReply() {
    clearInterval(this.playing);
    this.playing = null;
  }

  interrupt() {
    if (!this.playing) return;
    this.stopReply();
    this.send({ serverContent: { interrupted: true } });
  }
}

server.listen(PORT, () => console.log(`Mock Gemini Live on http://localhost:${PORT}`));
