import type { Scheduler } from '../scheduler.js';
import type { DMAController } from '../dma.js';
import { SoundFIFO } from './fifo.js';
import { PulseChannel, WaveChannel, NoiseChannel } from './psg.js';
import { CPU_FREQ } from '../types.js';

const SAMPLE_RATE = 48000;
const CYCLES_PER_SAMPLE = (CPU_FREQ / SAMPLE_RATE) | 0;
const BUFFER_SIZE = 4096;

/**
 * GBA Audio Processing Unit
 *
 * Manages 4 PSG channels + 2 Direct Sound (FIFO) channels.
 * Outputs to a ring buffer consumed by Web Audio API.
 */
export class APU {
  // PSG channels
  readonly ch1 = new PulseChannel();
  readonly ch2 = new PulseChannel(); // No sweep for ch2
  readonly ch3 = new WaveChannel();
  readonly ch4 = new NoiseChannel();

  // Direct Sound FIFOs
  readonly fifoA = new SoundFIFO();
  readonly fifoB = new SoundFIFO();

  // Output ring buffer (stereo interleaved: L, R, L, R, ...)
  readonly sampleBuffer = new Float32Array(BUFFER_SIZE * 2);
  sampleWritePos = 0;
  sampleReadPos = 0;

  // Sound control registers
  private soundcntL = 0; // PSG master volume/panning
  private soundcntH = 0; // Direct Sound volume/timer selection
  private soundcntX = 0; // Master enable
  // soundBias = 0x200 (unused for now)

  // Frame sequencer for PSG timing
  private frameSequencerStep = 0;
  private frameSequencerTimer = 0;
  private static FRAME_SEQUENCER_RATE = CPU_FREQ / 512; // ~32768 cycles

  private eventId = -1;

  constructor(
    private scheduler: Scheduler,
    private dma: DMAController,
  ) {}

  start(): void {
    // Schedule periodic sample generation
    this.eventId = this.scheduler.schedule(CYCLES_PER_SAMPLE, () => this._generateSample());
  }

  /** Called when a timer overflows — feeds FIFO if timer matches */
  onTimerOverflow(timerIdx: number): void {
    const fifoATimer = (this.soundcntH >>> 10) & 1;
    const fifoBTimer = (this.soundcntH >>> 14) & 1;

    if (timerIdx === fifoATimer) {
      this.fifoA.read();
      if (this.fifoA.needsRefill) {
        this.dma.triggerSoundFifo(1);
      }
    }

    if (timerIdx === fifoBTimer) {
      this.fifoB.read();
      if (this.fifoB.needsRefill) {
        this.dma.triggerSoundFifo(2);
      }
    }
  }

  writeFifoA(value: number): void {
    this.fifoA.write32(value);
  }

  writeFifoB(value: number): void {
    this.fifoB.write32(value);
  }

  writeSoundcntL(value: number): void {
    this.soundcntL = value;
  }

  writeSoundcntH(value: number): void {
    this.soundcntH = value;
    // Reset FIFOs if bits are set
    if (value & (1 << 11)) this.fifoA.reset();
    if (value & (1 << 15)) this.fifoB.reset();
  }

  writeSoundcntX(value: number): void {
    this.soundcntX = (this.soundcntX & 0xF) | (value & 0x80); // Only bit 7 writable
    if (!(value & 0x80)) {
      // Master disable: silence everything
      this.ch1.reset();
      this.ch2.reset();
      this.ch3.reset();
      this.ch4.reset();
    }
  }

  readSoundcntX(): number {
    let val = this.soundcntX & 0x80;
    if (this.ch1.enabled) val |= 1;
    if (this.ch2.enabled) val |= 2;
    if (this.ch3.enabled) val |= 4;
    if (this.ch4.enabled) val |= 8;
    return val;
  }

  /** Get number of available samples in the buffer */
  get availableSamples(): number {
    const diff = this.sampleWritePos - this.sampleReadPos;
    return diff >= 0 ? diff : diff + BUFFER_SIZE * 2;
  }

  /** Read samples into an output buffer (called by AudioWorklet) */
  readSamples(output: Float32Array): number {
    const count = Math.min(output.length, this.availableSamples);
    for (let i = 0; i < count; i++) {
      output[i] = this.sampleBuffer[this.sampleReadPos];
      this.sampleReadPos = (this.sampleReadPos + 1) % (BUFFER_SIZE * 2);
    }
    return count;
  }

  private _generateSample(): void {
    // Reschedule
    this.eventId = this.scheduler.schedule(CYCLES_PER_SAMPLE, () => this._generateSample());

    if (!(this.soundcntX & 0x80)) {
      // Master sound disabled
      this._writeSample(0, 0);
      return;
    }

    // Clock PSG frame sequencer
    this.frameSequencerTimer += CYCLES_PER_SAMPLE;
    while (this.frameSequencerTimer >= APU.FRAME_SEQUENCER_RATE) {
      this.frameSequencerTimer -= APU.FRAME_SEQUENCER_RATE;
      this._clockFrameSequencer();
    }

    // Clock PSG channels
    this.ch1.clock(CYCLES_PER_SAMPLE);
    this.ch2.clock(CYCLES_PER_SAMPLE);
    this.ch3.clock(CYCLES_PER_SAMPLE);
    this.ch4.clock(CYCLES_PER_SAMPLE);

    // Mix PSG
    const psgMasterVolR = this.soundcntL & 7;
    const psgMasterVolL = (this.soundcntL >>> 4) & 7;

    let psgLeft = 0;
    let psgRight = 0;

    const ch1Sample = this.ch1.sample();
    const ch2Sample = this.ch2.sample();
    const ch3Sample = this.ch3.sample();
    const ch4Sample = this.ch4.sample();

    // Panning (bits 8-15 of SOUNDCNT_L)
    const pan = this.soundcntL >>> 8;
    if (pan & 0x01) psgRight += ch1Sample;
    if (pan & 0x02) psgRight += ch2Sample;
    if (pan & 0x04) psgRight += ch3Sample;
    if (pan & 0x08) psgRight += ch4Sample;
    if (pan & 0x10) psgLeft += ch1Sample;
    if (pan & 0x20) psgLeft += ch2Sample;
    if (pan & 0x40) psgLeft += ch3Sample;
    if (pan & 0x80) psgLeft += ch4Sample;

    psgLeft *= (psgMasterVolL + 1) / 8;
    psgRight *= (psgMasterVolR + 1) / 8;

    // PSG volume ratio (bits 0-1 of SOUNDCNT_H)
    const psgRatio = this.soundcntH & 3;
    const psgScale = [0.25, 0.5, 1.0, 0][psgRatio];
    psgLeft *= psgScale;
    psgRight *= psgScale;

    // Direct Sound channels
    const fifoAVolume = (this.soundcntH & (1 << 2)) ? 1.0 : 0.5;
    const fifoBVolume = (this.soundcntH & (1 << 3)) ? 1.0 : 0.5;
    const fifoASample = (this.fifoA.sample / 128.0) * fifoAVolume;
    const fifoBSample = (this.fifoB.sample / 128.0) * fifoBVolume;

    // Direct Sound panning
    let left = psgLeft;
    let right = psgRight;

    if (this.soundcntH & (1 << 9)) left += fifoASample;   // FIFO A → Left
    if (this.soundcntH & (1 << 8)) right += fifoASample;  // FIFO A → Right
    if (this.soundcntH & (1 << 13)) left += fifoBSample;  // FIFO B → Left
    if (this.soundcntH & (1 << 12)) right += fifoBSample; // FIFO B → Right

    // Clamp
    left = Math.max(-1, Math.min(1, left * 0.5));
    right = Math.max(-1, Math.min(1, right * 0.5));

    this._writeSample(left, right);
  }

  private _writeSample(left: number, right: number): void {
    this.sampleBuffer[this.sampleWritePos] = left;
    this.sampleBuffer[(this.sampleWritePos + 1) % (BUFFER_SIZE * 2)] = right;
    this.sampleWritePos = (this.sampleWritePos + 2) % (BUFFER_SIZE * 2);
  }

  private _clockFrameSequencer(): void {
    // Frame sequencer runs at 512Hz, cycling through 8 steps
    switch (this.frameSequencerStep) {
      case 0: // Length
        this.ch1.clockLength();
        this.ch2.clockLength();
        this.ch3.clockLength();
        this.ch4.clockLength();
        break;
      case 2: // Length + Sweep
        this.ch1.clockLength();
        this.ch2.clockLength();
        this.ch3.clockLength();
        this.ch4.clockLength();
        this.ch1.clockSweep();
        break;
      case 4: // Length
        this.ch1.clockLength();
        this.ch2.clockLength();
        this.ch3.clockLength();
        this.ch4.clockLength();
        break;
      case 6: // Length + Sweep
        this.ch1.clockLength();
        this.ch2.clockLength();
        this.ch3.clockLength();
        this.ch4.clockLength();
        this.ch1.clockSweep();
        break;
      case 7: // Envelope
        this.ch1.clockEnvelope();
        this.ch2.clockEnvelope();
        this.ch4.clockEnvelope();
        break;
    }
    this.frameSequencerStep = (this.frameSequencerStep + 1) & 7;
  }

  reset(): void {
    this.ch1.reset();
    this.ch2.reset();
    this.ch3.reset();
    this.ch4.reset();
    this.fifoA.reset();
    this.fifoB.reset();
    this.sampleWritePos = 0;
    this.sampleReadPos = 0;
    this.sampleBuffer.fill(0);
    this.soundcntL = 0;
    this.soundcntH = 0;
    this.soundcntX = 0;
    this.frameSequencerStep = 0;
    this.frameSequencerTimer = 0;
    if (this.eventId >= 0) {
      this.scheduler.cancel(this.eventId);
      this.eventId = -1;
    }
  }
}
