import type { APU } from '../core/apu/apu.js';

/**
 * Web Audio API bridge.
 * Connects the emulator's APU sample buffer to browser audio output.
 */
export class AudioOutput {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private apu: APU | null = null;
  private _volume = 0.5;
  private _tempBuf: Float32Array | null = null;

  /** Connect to an APU instance */
  connect(apu: APU): void {
    this.apu = apu;
  }

  /** Start audio output (must be called from user gesture) */
  async start(): Promise<void> {
    if (this.ctx) return;

    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this._volume;
    this.gainNode.connect(this.ctx.destination);

    // Use ScriptProcessorNode for broad compatibility
    // (AudioWorklet would be better but requires separate file + COOP/COEP headers)
    const bufferSize = 2048;
    this.scriptNode = this.ctx.createScriptProcessor(bufferSize, 0, 2);
    this._tempBuf = new Float32Array(bufferSize * 2);

    this.scriptNode.onaudioprocess = (event) => {
      const left = event.outputBuffer.getChannelData(0);
      const right = event.outputBuffer.getChannelData(1);

      if (!this.apu || !this._tempBuf) {
        left.fill(0);
        right.fill(0);
        return;
      }

      const tempBuf = this._tempBuf;
      const read = this.apu.readSamples(tempBuf);

      for (let i = 0; i < bufferSize; i++) {
        const idx = i * 2;
        if (idx < read) {
          left[i] = tempBuf[idx];
          right[i] = tempBuf[idx + 1];
        } else {
          left[i] = 0;
          right[i] = 0;
        }
      }
    };

    this.scriptNode.connect(this.gainNode);

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  /** Stop audio output */
  stop(): void {
    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.gainNode = null;
  }

  /** Set volume (0.0 - 1.0) */
  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.gainNode) {
      this.gainNode.gain.value = this._volume;
    }
  }

  get volume(): number {
    return this._volume;
  }
}
