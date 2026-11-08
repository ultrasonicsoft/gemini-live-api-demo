/**
 * Runs on the audio thread. The AudioContext is created at 16 kHz, so the browser handles resampling.
 * Emits two message types:
 *  - level: every 20 ms, so voice timing stays accurate whatever the chunk size is
 *  - pcm:   16-bit PCM chunks of the configured size
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.setChunk(options.processorOptions?.chunkMs ?? 40);
    this.buffer = new Int16Array(16000 * 2);
    this.length = 0;
    this.levelSum = 0;
    this.levelCount = 0;
    this.port.onmessage = ({ data }) => {
      if (data.chunkMs) this.setChunk(data.chunkMs);
    };
  }

  setChunk(ms) {
    this.chunkSamples = Math.round((16000 * ms) / 1000);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.length++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.levelSum += sample * sample;
      this.levelCount++;

      if (this.levelCount >= 320) {
        this.port.postMessage({ type: 'level', rms: Math.sqrt(this.levelSum / this.levelCount) });
        this.levelSum = 0;
        this.levelCount = 0;
      }

      if (this.length >= this.chunkSamples) {
        const pcm = this.buffer.slice(0, this.length);
        this.length = 0;
        this.port.postMessage({ type: 'pcm', pcm: pcm.buffer }, [pcm.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
