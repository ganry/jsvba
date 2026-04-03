import type { InterruptController } from '../interrupts.js';
import type { Input } from '../input.js';
import type { TimerController } from '../timers.js';
import type { DMAController } from '../dma.js';
import type { APU } from '../apu/apu.js';
import * as R from '../types.js';

/**
 * GBA I/O Register Space (0x04000000 - 0x040003FF)
 *
 * Handles read/write side effects for memory-mapped I/O registers.
 * Backs non-special registers with a simple Uint8Array.
 */
export class IORegisters {
  /** Raw storage for I/O registers */
  data = new Uint8Array(R.IO_SIZE);
  private view16: DataView;
  private apu: APU | null = null;

  constructor(
    private irq: InterruptController,
    private input: Input,
    private timers: TimerController,
    private dma: DMAController,
  ) {
    this.view16 = new DataView(this.data.buffer);
  }

  /** Connect the APU (called after construction to break circular dependency) */
  setAPU(apu: APU): void {
    this.apu = apu;
  }

  /** PPU callback — set by PPU to read VCOUNT etc. */
  ppuReadCallback: ((offset: number) => number) | null = null;
  /** PPU write callback — set by PPU to handle DISPSTAT writes */
  ppuWriteCallback: ((offset: number, value: number) => void) | null = null;
  /** Halt callback — set by GBA to halt the CPU when HALTCNT is written */
  haltCallback: (() => void) | null = null;

  read8(offset: number): number {
    return this._read16(offset & ~1) >>> ((offset & 1) * 8) & 0xFF;
  }

  read16(offset: number): number {
    return this._read16(offset & 0x3FE);
  }

  read32(offset: number): number {
    const lo = this._read16(offset & 0x3FC);
    const hi = this._read16((offset & 0x3FC) + 2);
    return (lo | (hi << 16)) >>> 0;
  }

  write8(offset: number, val: number): void {
    const off = offset & 0x3FF;
    // HALTCNT (0x04000301) — writing halts the CPU until next interrupt
    if (off === R.REG_HALTCNT) {
      if (this.haltCallback) this.haltCallback();
      return;
    }
    // Most 8-bit writes are fine, some registers need special handling
    this.data[off] = val;
    // Handle side effects for the 16-bit register this byte belongs to
    this._onWrite16(off & ~1);
  }

  write16(offset: number, val: number): void {
    offset &= 0x3FE;
    this.view16.setUint16(offset, val, true);
    this._onWrite16(offset);
  }

  write32(offset: number, val: number): void {
    offset &= 0x3FC;

    // FIFO registers are 32-bit write-only — route directly to APU
    if (offset === R.REG_FIFO_A) {
      if (this.apu) this.apu.writeFifoA(val);
      return;
    }
    if (offset === R.REG_FIFO_B) {
      if (this.apu) this.apu.writeFifoB(val);
      return;
    }

    this.view16.setUint16(offset, val & 0xFFFF, true);
    this._onWrite16(offset);
    this.view16.setUint16(offset + 2, (val >>> 16) & 0xFFFF, true);
    this._onWrite16(offset + 2);
  }

  private _read16(offset: number): number {
    switch (offset) {
      // PPU registers read by PPU callback
      case R.REG_DISPSTAT:
      case R.REG_VCOUNT:
        if (this.ppuReadCallback) return this.ppuReadCallback(offset);
        return this.view16.getUint16(offset, true);

      // Input
      case R.REG_KEYINPUT:
        return this.input.readKeyInput();
      case R.REG_KEYCNT:
        return this.input.readKeyCnt();

      // Timers
      case R.REG_TM0CNT_L: return this.timers.readCounter(0);
      case R.REG_TM1CNT_L: return this.timers.readCounter(1);
      case R.REG_TM2CNT_L: return this.timers.readCounter(2);
      case R.REG_TM3CNT_L: return this.timers.readCounter(3);

      // DMA control (read-only meaningful bits)
      case R.REG_DMA0CNT_H: return this.dma.readControl(0);
      case R.REG_DMA1CNT_H: return this.dma.readControl(1);
      case R.REG_DMA2CNT_H: return this.dma.readControl(2);
      case R.REG_DMA3CNT_H: return this.dma.readControl(3);

      // Sound master status (bit 7 = master enable, bits 0-3 = channel active flags)
      case R.REG_SOUNDCNT_X:
        if (this.apu) return this.apu.readSoundcntX();
        return this.view16.getUint16(offset, true) & 0x008F;

      // Sound control registers (readable)
      case R.REG_SOUNDCNT_L:
      case R.REG_SOUNDCNT_H:
        return this.view16.getUint16(offset, true);

      // Interrupts
      case R.REG_IE: return this.irq.ie;
      case R.REG_IF: return this.irq.if_;
      case R.REG_IME: return this.irq.ime;

      default:
        return this.view16.getUint16(offset, true);
    }
  }

  private _onWrite16(offset: number): void {
    const val = this.view16.getUint16(offset, true);

    switch (offset) {
      // PPU
      case R.REG_DISPSTAT:
        if (this.ppuWriteCallback) this.ppuWriteCallback(offset, val);
        break;

      // Input
      case R.REG_KEYCNT:
        this.input.writeKeyCnt(val);
        break;

      // Timers
      case R.REG_TM0CNT_L: this.timers.writeReload(0, val); break;
      case R.REG_TM0CNT_H: this.timers.writeControl(0, val); break;
      case R.REG_TM1CNT_L: this.timers.writeReload(1, val); break;
      case R.REG_TM1CNT_H: this.timers.writeControl(1, val); break;
      case R.REG_TM2CNT_L: this.timers.writeReload(2, val); break;
      case R.REG_TM2CNT_H: this.timers.writeControl(2, val); break;
      case R.REG_TM3CNT_L: this.timers.writeReload(3, val); break;
      case R.REG_TM3CNT_H: this.timers.writeControl(3, val); break;

      // DMA
      case R.REG_DMA0CNT_L: this.dma.writeCount(0, val); break;
      case R.REG_DMA0CNT_H: this.dma.writeControl(0, val); break;
      case R.REG_DMA1CNT_L: this.dma.writeCount(1, val); break;
      case R.REG_DMA1CNT_H: this.dma.writeControl(1, val); break;
      case R.REG_DMA2CNT_L: this.dma.writeCount(2, val); break;
      case R.REG_DMA2CNT_H: this.dma.writeControl(2, val); break;
      case R.REG_DMA3CNT_L: this.dma.writeCount(3, val); break;
      case R.REG_DMA3CNT_H: this.dma.writeControl(3, val); break;

      // DMA addresses (split into low/high 16-bit writes)
      case R.REG_DMA0SAD: this.dma.writeSrcLow(0, val); break;
      case R.REG_DMA0SAD + 2: this.dma.writeSrcHigh(0, val); break;
      case R.REG_DMA0DAD: this.dma.writeDstLow(0, val); break;
      case R.REG_DMA0DAD + 2: this.dma.writeDstHigh(0, val); break;
      case R.REG_DMA1SAD: this.dma.writeSrcLow(1, val); break;
      case R.REG_DMA1SAD + 2: this.dma.writeSrcHigh(1, val); break;
      case R.REG_DMA1DAD: this.dma.writeDstLow(1, val); break;
      case R.REG_DMA1DAD + 2: this.dma.writeDstHigh(1, val); break;
      case R.REG_DMA2SAD: this.dma.writeSrcLow(2, val); break;
      case R.REG_DMA2SAD + 2: this.dma.writeSrcHigh(2, val); break;
      case R.REG_DMA2DAD: this.dma.writeDstLow(2, val); break;
      case R.REG_DMA2DAD + 2: this.dma.writeDstHigh(2, val); break;
      case R.REG_DMA3SAD: this.dma.writeSrcLow(3, val); break;
      case R.REG_DMA3SAD + 2: this.dma.writeSrcHigh(3, val); break;
      case R.REG_DMA3DAD: this.dma.writeDstLow(3, val); break;
      case R.REG_DMA3DAD + 2: this.dma.writeDstHigh(3, val); break;

      // ========== Sound Registers ==========

      // Channel 1: Pulse with sweep
      case R.REG_SOUND1CNT_L:
        if (this.apu) this.apu.ch1.writeSweep(val & 0xFF);
        break;
      case R.REG_SOUND1CNT_H:
        if (this.apu) {
          this.apu.ch1.writeDutyLength(val & 0xFF);
          this.apu.ch1.writeEnvelope(val >> 8);
        }
        break;
      case R.REG_SOUND1CNT_X:
        if (this.apu) {
          this.apu.ch1.writeFrequencyLow(val & 0xFF);
          this.apu.ch1.writeFrequency(val >> 8);
        }
        break;

      // Channel 2: Pulse (no sweep)
      case R.REG_SOUND2CNT_L:
        if (this.apu) {
          this.apu.ch2.writeDutyLength(val & 0xFF);
          this.apu.ch2.writeEnvelope(val >> 8);
        }
        break;
      case R.REG_SOUND2CNT_H:
        if (this.apu) {
          this.apu.ch2.writeFrequencyLow(val & 0xFF);
          this.apu.ch2.writeFrequency(val >> 8);
        }
        break;

      // Channel 3: Wave
      case R.REG_SOUND3CNT_L:
        if (this.apu) this.apu.ch3.writeDACEnable(val);
        break;
      case R.REG_SOUND3CNT_H:
        if (this.apu) {
          this.apu.ch3.writeLength(val & 0xFF);
          this.apu.ch3.writeVolume(val >> 8);
        }
        break;
      case R.REG_SOUND3CNT_X:
        if (this.apu) {
          this.apu.ch3.writeFrequencyLow(val & 0xFF);
          this.apu.ch3.writeFrequencyHigh(val >> 8);
        }
        break;

      // Channel 4: Noise
      case R.REG_SOUND4CNT_L:
        if (this.apu) {
          this.apu.ch4.writeLengthEnvelope(val & 0xFF);
          this.apu.ch4.writeEnvelope(val >> 8);
        }
        break;
      case R.REG_SOUND4CNT_H:
        if (this.apu) {
          this.apu.ch4.writeFrequency(val & 0xFF);
          this.apu.ch4.writeControl(val >> 8);
        }
        break;

      // Sound master controls
      case R.REG_SOUNDCNT_L:
        if (this.apu) this.apu.writeSoundcntL(val);
        break;
      case R.REG_SOUNDCNT_H:
        if (this.apu) this.apu.writeSoundcntH(val);
        break;
      case R.REG_SOUNDCNT_X:
        if (this.apu) this.apu.writeSoundcntX(val);
        // Store only master enable bit (bit 7) + read-only channel status
        this.view16.setUint16(offset, (this.view16.getUint16(offset, true) & 0x000F) | (val & 0x0080), true);
        break;

      // Wave RAM (0x090-0x09E, 16 bytes = 8 x 16-bit writes)
      case 0x090: case 0x092: case 0x094: case 0x096:
      case 0x098: case 0x09A: case 0x09C: case 0x09E:
        if (this.apu) {
          const waveOff = offset - R.REG_WAVE_RAM;
          this.apu.ch3.writeWaveRam(waveOff, val & 0xFF);
          this.apu.ch3.writeWaveRam(waveOff + 1, val >> 8);
        }
        break;

      // FIFO A (write-only, 32-bit)
      case R.REG_FIFO_A:
      case R.REG_FIFO_A + 2:
        // 16-bit writes to FIFO are unusual but can happen;
        // the real FIFO is fed via 32-bit DMA, this handles edge cases
        break;

      // FIFO B (write-only, 32-bit)
      case R.REG_FIFO_B:
      case R.REG_FIFO_B + 2:
        break;

      // Interrupts
      case R.REG_IE: this.irq.ie = val; break;
      case R.REG_IF: this.irq.acknowledge(val); break;
      case R.REG_IME: this.irq.ime = val; break;

      // HALTCNT (written via 8-bit write to 0x04000301)
      case R.REG_HALTCNT & ~1:
        // Handled at 8-bit level
        break;
    }
  }

  reset(): void {
    this.data.fill(0);

    // Post-BIOS defaults: mimic state after BIOS has run
    // POSTFLG = 0x01 (BIOS has completed)
    this.data[R.REG_POSTFLG] = 0x01;

    // SOUNDBIAS = 0x0200 (default bias level)
    this.view16.setUint16(R.REG_SOUNDBIAS, 0x0200, true);

    // SOUNDCNT_X bit 7 = sound master enable
    this.view16.setUint16(R.REG_SOUNDCNT_X, 0x0080, true);

    // WAITCNT = 0x4317 (post-BIOS default: 3/1 WS0, 4/1 WS1, 8/1 WS2, prefetch on)
    this.view16.setUint16(R.REG_WAITCNT, 0x4317, true);
  }
}
