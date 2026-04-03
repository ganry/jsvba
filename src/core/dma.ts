import type { Scheduler } from './scheduler.js';
import type { InterruptController } from './interrupts.js';
import type { GamePak } from './memory/gamepak.js';
import { SaveType } from './memory/gamepak.js';
import {
  IRQ_DMA0, IRQ_DMA1, IRQ_DMA2, IRQ_DMA3,
  DMA_TIMING_IMMEDIATE, DMA_TIMING_VBLANK, DMA_TIMING_HBLANK, DMA_TIMING_SPECIAL,
  DMA_INC, DMA_DEC, DMA_FIXED, DMA_INC_RELOAD,
} from './types.js';

const DMA_IRQ_FLAGS = [IRQ_DMA0, IRQ_DMA1, IRQ_DMA2, IRQ_DMA3];

// Max word counts for each channel
const DMA_MAX_COUNT = [0x4000, 0x4000, 0x4000, 0x10000];

export interface DMAReadWrite {
  read16(addr: number): number;
  read32(addr: number): number;
  write16(addr: number, val: number): void;
  write32(addr: number, val: number): void;
}

interface DMAChannel {
  srcAddr: number;
  dstAddr: number;
  count: number;
  control: number;
  // Internal latched values
  internalSrc: number;
  internalDst: number;
  internalCount: number;
  enabled: boolean;
}

export class DMAController {
  channels: DMAChannel[] = [];
  private bus!: DMAReadWrite;
  private gamepak: GamePak | null = null;

  constructor(
    private scheduler: Scheduler,
    private irq: InterruptController,
  ) {
    for (let i = 0; i < 4; i++) {
      this.channels.push({
        srcAddr: 0,
        dstAddr: 0,
        count: 0,
        control: 0,
        internalSrc: 0,
        internalDst: 0,
        internalCount: 0,
        enabled: false,
      });
    }
  }

  setGamePak(gamepak: GamePak): void {
    this.gamepak = gamepak;
  }

  setBus(bus: DMAReadWrite): void {
    this.bus = bus;
  }

  writeSrcLow(ch: number, value: number): void {
    this.channels[ch].srcAddr = (this.channels[ch].srcAddr & 0xFFFF0000) | (value & 0xFFFF);
  }

  writeSrcHigh(ch: number, value: number): void {
    // DMA0: 27-bit source (internal only), DMA1-3: 28-bit source
    const mask = ch === 0 ? 0x07FF : 0x0FFF;
    this.channels[ch].srcAddr = (this.channels[ch].srcAddr & 0xFFFF) | ((value & mask) << 16);
  }

  writeDstLow(ch: number, value: number): void {
    this.channels[ch].dstAddr = (this.channels[ch].dstAddr & 0xFFFF0000) | (value & 0xFFFF);
  }

  writeDstHigh(ch: number, value: number): void {
    // DMA0-2: 27-bit dest, DMA3: 28-bit dest
    const mask = ch === 3 ? 0x0FFF : 0x07FF;
    this.channels[ch].dstAddr = (this.channels[ch].dstAddr & 0xFFFF) | ((value & mask) << 16);
  }

  writeCount(ch: number, value: number): void {
    this.channels[ch].count = value & 0xFFFF;
  }

  writeControl(ch: number, value: number): void {
    const wasEnabled = this.channels[ch].enabled;
    this.channels[ch].control = value;
    this.channels[ch].enabled = (value & (1 << 15)) !== 0;

    // Latch on rising edge of enable bit
    if (!wasEnabled && this.channels[ch].enabled) {
      const c = this.channels[ch];
      c.internalSrc = c.srcAddr;
      c.internalDst = c.dstAddr;
      c.internalCount = c.count === 0 ? DMA_MAX_COUNT[ch] : c.count;

      const timing = (value >>> 12) & 3;
      if (timing === DMA_TIMING_IMMEDIATE) {
        this._runTransfer(ch);
      }
    }
  }

  readControl(ch: number): number {
    return this.channels[ch].control;
  }

  /** Trigger DMA channels waiting for VBlank */
  triggerVBlank(): void {
    for (let i = 0; i < 4; i++) {
      if (this.channels[i].enabled && ((this.channels[i].control >>> 12) & 3) === DMA_TIMING_VBLANK) {
        this._runTransfer(i);
      }
    }
  }

  /** Trigger DMA channels waiting for HBlank */
  triggerHBlank(): void {
    for (let i = 0; i < 4; i++) {
      if (this.channels[i].enabled && ((this.channels[i].control >>> 12) & 3) === DMA_TIMING_HBLANK) {
        this._runTransfer(i);
      }
    }
  }

  /** Trigger DMA channels 1/2 for sound FIFO refill */
  triggerSoundFifo(channel: 1 | 2): void {
    const c = this.channels[channel];
    if (!c.enabled) return;
    if (((c.control >>> 12) & 3) !== DMA_TIMING_SPECIAL) return;

    // Sound DMA: always 4 words, 32-bit, fixed destination
    const src = c.internalSrc;
    for (let i = 0; i < 4; i++) {
      const val = this.bus.read32(src + i * 4);
      this.bus.write32(c.internalDst, val);
    }
    c.internalSrc = src + 16;


    // Sound DMA always repeats
  }

  private _runTransfer(ch: number): void {
    const c = this.channels[ch];
    const wordSize = (c.control & (1 << 10)) ? 4 : 2; // 32-bit or 16-bit
    const srcAdj = this._getAdjustment((c.control >>> 7) & 3, wordSize);
    const dstAdj = this._getAdjustment((c.control >>> 5) & 3, wordSize);
    const count = c.internalCount;

    // Auto-detect EEPROM address size from DMA3 word count.
    // DMA3 is the only channel that can access EEPROM (0x0D region).
    // Word counts: 9/73 → 6-bit addressing, 17/81 → 14-bit addressing
    if (ch === 3 && this.gamepak && this.gamepak.saveType === SaveType.EEPROM && this.gamepak.eepromAddrSize === 0) {
      const dstRegion = (c.internalDst >>> 24) & 0xFF;
      const srcRegion = (c.internalSrc >>> 24) & 0xFF;
      if (dstRegion === 0x0D || srcRegion === 0x0D) {
        if (count === 9 || count === 73) {
          this.gamepak.eepromAddrSize = 6;
        } else if (count === 17 || count === 81) {
          this.gamepak.eepromAddrSize = 14;
        }
      }
    }

    let src = c.internalSrc;
    let dst = c.internalDst;

    if (wordSize === 4) {
      for (let i = 0; i < count; i++) {
        this.bus.write32(dst & ~3, this.bus.read32(src & ~3));
        src += srcAdj;
        dst += dstAdj;
      }
    } else {
      for (let i = 0; i < count; i++) {
        this.bus.write16(dst & ~1, this.bus.read16(src & ~1));
        src += srcAdj;
        dst += dstAdj;
      }
    }



    c.internalSrc = src;
    c.internalDst = dst;

    // Add cycles (approximate)
    this.scheduler.tick(count * 2);

    // IRQ on completion
    if (c.control & (1 << 14)) {
      this.irq.requestInterrupt(DMA_IRQ_FLAGS[ch]);
    }

    // Repeat
    if (c.control & (1 << 9)) {
      // Reload count
      c.internalCount = c.count === 0 ? DMA_MAX_COUNT[ch] : c.count;
      // Reload dest if increment+reload
      if (((c.control >>> 5) & 3) === DMA_INC_RELOAD) {
        c.internalDst = c.dstAddr;
      }
    } else {
      // Disable channel
      c.enabled = false;
      c.control &= ~(1 << 15);
    }
  }

  private _getAdjustment(mode: number, wordSize: number): number {
    switch (mode) {
      case DMA_INC: return wordSize;
      case DMA_DEC: return -wordSize;
      case DMA_FIXED: return 0;
      case DMA_INC_RELOAD: return wordSize;
      default: return wordSize;
    }
  }

  reset(): void {
    for (const c of this.channels) {
      c.srcAddr = 0;
      c.dstAddr = 0;
      c.count = 0;
      c.control = 0;
      c.internalSrc = 0;
      c.internalDst = 0;
      c.internalCount = 0;
      c.enabled = false;
    }
  }
}
