import { GamePak } from './gamepak.js';
import { IORegisters } from './io.js';
import {
  BIOS_SIZE, EWRAM_SIZE, IWRAM_SIZE, PALETTE_SIZE, VRAM_SIZE, OAM_SIZE,
  EWRAM_MASK, IWRAM_MASK, PALETTE_MASK, VRAM_MASK, OAM_MASK,
} from '../types.js';
import { logWarn, logInfo } from '../../utils/logger.js';
import { ror32 } from '../../utils/bit-ops.js';

const BIOS_MASK = BIOS_SIZE - 1;

/**
 * GBA Memory Management Unit
 *
 * Routes memory reads/writes to the appropriate region based on the top 8 bits
 * of the address. Each region has its own backing ArrayBuffer.
 */
export class MMU {
  // Memory regions
  readonly bios: ArrayBuffer;
  readonly ewram: ArrayBuffer;
  readonly iwram: ArrayBuffer;
  readonly palette: ArrayBuffer;
  readonly vram: ArrayBuffer;
  readonly oam: ArrayBuffer;

  // Typed array views for fast access
  readonly bios8: Uint8Array;
  readonly ewram8: Uint8Array;
  readonly iwram8: Uint8Array;
  readonly palette8: Uint8Array;
  readonly vram8: Uint8Array;
  readonly oam8: Uint8Array;

  // 16-bit views
  readonly palette16: Uint16Array;
  readonly vram16: Uint16Array;
  readonly oam16: Uint16Array;

  // DataViews for mixed-size access
  private biosView: DataView;
  private ewramView: DataView;
  private iwramView: DataView;
  private paletteView: DataView;
  private vramView: DataView;
  private oamView: DataView;

  // Subsystems
  gamepak: GamePak;
  io: IORegisters;

  // Open bus value (last prefetched value)
  private lastRead = 0;

  // BIOS read protection: the real GBA only allows BIOS reads while the CPU
  // is executing code within the BIOS region (0x00-0x3FFF). Reads from
  // outside return the last value successfully read from BIOS.
  private biosLatch = 0;
  /** Set by the CPU before each instruction fetch so the MMU knows
   *  whether the current code is inside the BIOS region. */
  biosRegion = false;

  // Memory watchpoint — logs writes to a specific address range
  // Set via console: app.gba.mmu.setWatchpoint(0x03001794, 4)
  private _watchAddr = 0;
  private _watchLen = 0;
  private _watchCount = 0;
  private _watchLimit = 50;

  /** Set a memory write watchpoint. Logs up to `limit` writes to [addr, addr+len). */
  setWatchpoint(addr: number, len: number, limit = 50): void {
    this._watchAddr = addr;
    this._watchLen = len;
    this._watchCount = 0;
    this._watchLimit = limit;
    logInfo(`Watchpoint set: 0x${addr.toString(16)}-0x${(addr + len - 1).toString(16)} (limit=${limit})`);
  }

  clearWatchpoint(): void {
    this._watchAddr = 0;
    this._watchLen = 0;
  }

  private _checkWatchpoint(addr: number, val: number, size: number): void {
    if (this._watchLen === 0) return;
    const wEnd = this._watchAddr + this._watchLen;
    const aEnd = addr + size;
    if (addr < wEnd && aEnd > this._watchAddr) {
      if (this._watchCount < this._watchLimit) {
        logInfo(`WATCH: write${size * 8} 0x${addr.toString(16)} = 0x${(val >>> 0).toString(16)}`);
        this._watchCount++;
        if (this._watchCount === this._watchLimit) {
          logInfo('(watchpoint limit reached)');
        }
      }
    }
  }

  constructor(gamepak: GamePak, io: IORegisters) {
    this.gamepak = gamepak;
    this.io = io;

    // Allocate memory regions
    this.bios = new ArrayBuffer(BIOS_SIZE);
    this.ewram = new ArrayBuffer(EWRAM_SIZE);
    this.iwram = new ArrayBuffer(IWRAM_SIZE);
    this.palette = new ArrayBuffer(PALETTE_SIZE);
    this.vram = new ArrayBuffer(VRAM_SIZE);
    this.oam = new ArrayBuffer(OAM_SIZE);

    // Create views
    this.bios8 = new Uint8Array(this.bios);
    this.ewram8 = new Uint8Array(this.ewram);
    this.iwram8 = new Uint8Array(this.iwram);
    this.palette8 = new Uint8Array(this.palette);
    this.vram8 = new Uint8Array(this.vram);
    this.oam8 = new Uint8Array(this.oam);

    this.palette16 = new Uint16Array(this.palette);
    this.vram16 = new Uint16Array(this.vram);
    this.oam16 = new Uint16Array(this.oam);

    this.biosView = new DataView(this.bios);
    this.ewramView = new DataView(this.ewram);
    this.iwramView = new DataView(this.iwram);
    this.paletteView = new DataView(this.palette);
    this.vramView = new DataView(this.vram);
    this.oamView = new DataView(this.oam);

    // Write the HLE BIOS stub (IRQ handler)
    this._initBiosStub();
  }

  /**
   * Write a minimal BIOS stub that implements the IRQ handler dispatch.
   *
   * When an IRQ fires, the CPU vectors to 0x18. Our stub matches the
   * real GBA BIOS at 0x128-0x13C:
   *   1. Saves R0-R3, R12, LR to IRQ stack
   *   2. Sets LR to return address
   *   3. Loads PC from [0x03FFFFFC] → jumps to game handler at [0x03007FFC]
   *   4. Game handler returns via BX LR
   *   5. Restores R0-R3, R12, LR from IRQ stack
   *   6. Returns via SUBS PC, LR, #4
   *
   * The game handler runs in IRQ mode and is responsible for:
   * - Reading IE/IF and dispatching to individual handlers
   * - Acknowledging IF and updating BIOS IF mirror at [0x03007FF8]
   * - Managing mode switches to System mode for nested interrupts
   */
  private _initBiosStub(): void {
    const w = (offset: number, value: number) => {
      this.biosView.setUint32(offset, value, true);
    };

    // Exception vectors — safe traps to prevent NOP slides
    // If the CPU accidentally jumps to address 0 (e.g., null function pointer),
    // it must NOT slide through to the IRQ handler at 0x80.
    w(0x00, 0xEAFFFFFE);  // Reset:     B self (infinite loop)
    w(0x04, 0xEAFFFFFE);  // Undefined: B self
    w(0x08, 0xEAFFFFFE);  // SWI:       B self (we use HLE)
    w(0x0C, 0xEAFFFFFE);  // Prefetch:  B self
    w(0x10, 0xEAFFFFFE);  // Data Abort:B self
    w(0x14, 0xEAFFFFFE);  // Reserved:  B self

    // IRQ vector at 0x18: B 0x80
    w(0x18, 0xEA000018);

    // FIQ vector
    w(0x1C, 0xEAFFFFFE);  // FIQ: B self

    // IRQ handler body at 0x80 (matches real BIOS at 0x128-0x13C):
    w(0x80, 0xE92D500F);  // STMFD SP!, {R0-R3, R12, LR}
    w(0x84, 0xE3A00301);  // MOV R0, #0x04000000
    w(0x88, 0xE28FE000);  // ADR LR, 0x90 (= ADD LR, PC, #0; PC=0x90)
    w(0x8C, 0xE510F004);  // LDR PC, [R0, #-4]  → loads [0x03FFFFFC] = [0x03007FFC]
    w(0x90, 0xE8BD500F);  // LDMFD SP!, {R0-R3, R12, LR}
    w(0x94, 0xE25EF004);  // SUBS PC, LR, #4    → return from IRQ
  }

  // =========================================================================
  // 8-bit reads
  // =========================================================================

  read8(addr: number): number {
    const region = (addr >>> 24) & 0xFF;

    switch (region) {
      case 0x00: // BIOS — protected: only readable while CPU executes in BIOS
        if (this.biosRegion) {
          const val = this.bios8[addr & BIOS_MASK];
          this.biosLatch = this.biosView.getInt32(addr & BIOS_MASK & ~3, true);
          return val;
        }
        return (this.biosLatch >>> ((addr & 3) * 8)) & 0xFF;
      case 0x02: // EWRAM
        return this.ewram8[addr & EWRAM_MASK];
      case 0x03: // IWRAM
        return this.iwram8[addr & IWRAM_MASK];
      case 0x04: // I/O
        return this.io.read8(addr & 0x3FF);
      case 0x05: // Palette
        return this.palette8[addr & PALETTE_MASK];
      case 0x06: // VRAM
        return this.vram8[this._vramAddr(addr)];
      case 0x07: // OAM
        return this.oam8[addr & OAM_MASK];
      case 0x08: case 0x09: // ROM mirror 0
      case 0x0A: case 0x0B: // ROM mirror 1
      case 0x0C:            // ROM mirror 2
        return this.gamepak.read8(addr & 0x01FFFFFF);
      case 0x0D:            // ROM mirror 2 / EEPROM
        if (this.gamepak.saveType === 4 /* EEPROM */) return this.gamepak.readEEPROM();
        return this.gamepak.read8(addr & 0x01FFFFFF);
      case 0x0E: case 0x0F: // SRAM
        return this.gamepak.readSRAM(addr & 0xFFFF);
      default:
        return (this.lastRead >>> ((addr & 3) * 8)) & 0xFF;
    }
  }

  // =========================================================================
  // 16-bit reads (aligned)
  // =========================================================================

  read16(addr: number): number {
    const aligned = addr & ~1;
    const region = (aligned >>> 24) & 0xFF;
    let val: number;

    switch (region) {
      case 0x00: // BIOS — protected
        if (this.biosRegion) {
          val = this.biosView.getUint16(aligned & BIOS_MASK, true);
          this.biosLatch = this.biosView.getInt32(aligned & BIOS_MASK & ~3, true);
        } else {
          val = (this.biosLatch >>> ((aligned & 2) * 8)) & 0xFFFF;
        }
        break;
      case 0x02:
        val = this.ewramView.getUint16(aligned & EWRAM_MASK, true);
        break;
      case 0x03:
        val = this.iwramView.getUint16(aligned & IWRAM_MASK, true);
        break;
      case 0x04:
        val = this.io.read16(aligned & 0x3FE);
        break;
      case 0x05:
        val = this.paletteView.getUint16(aligned & PALETTE_MASK, true);
        break;
      case 0x06:
        val = this.vramView.getUint16(this._vramAddr(aligned), true);
        break;
      case 0x07:
        val = this.oamView.getUint16(aligned & OAM_MASK, true);
        break;
      case 0x08: case 0x09:
      case 0x0A: case 0x0B:
      case 0x0C:
        val = this.gamepak.read16(aligned & 0x01FFFFFF);
        break;
      case 0x0D:
        if (this.gamepak.saveType === 4 /* EEPROM */) {
          val = this.gamepak.readEEPROM();
        } else {
          val = this.gamepak.read16(aligned & 0x01FFFFFF);
        }
        break;
      case 0x0E: case 0x0F:
        val = this.gamepak.readSRAM(aligned & 0xFFFF);
        val |= val << 8;
        break;
      default:
        val = this.lastRead & 0xFFFF;
        break;
    }

    this.lastRead = val;
    return val;
  }

  // =========================================================================
  // 32-bit reads (with rotation for unaligned)
  // =========================================================================

  read32(addr: number): number {
    const aligned = addr & ~3;
    const region = (aligned >>> 24) & 0xFF;
    let val: number;

    switch (region) {
      case 0x00: // BIOS — protected
        if (this.biosRegion) {
          val = this.biosView.getInt32(aligned & BIOS_MASK, true);
          this.biosLatch = val;
        } else {
          val = this.biosLatch;
        }
        break;
      case 0x02:
        val = this.ewramView.getInt32(aligned & EWRAM_MASK, true);
        break;
      case 0x03:
        val = this.iwramView.getInt32(aligned & IWRAM_MASK, true);
        break;
      case 0x04:
        val = this.io.read32(aligned & 0x3FC);
        break;
      case 0x05:
        val = this.paletteView.getInt32(aligned & PALETTE_MASK, true);
        break;
      case 0x06:
        val = this.vramView.getInt32(this._vramAddr(aligned), true);
        break;
      case 0x07:
        val = this.oamView.getInt32(aligned & OAM_MASK, true);
        break;
      case 0x08: case 0x09:
      case 0x0A: case 0x0B:
      case 0x0C:
        val = this.gamepak.read32(aligned & 0x01FFFFFF);
        break;
      case 0x0D:
        if (this.gamepak.saveType === 4 /* EEPROM */) {
          val = this.gamepak.readEEPROM();
        } else {
          val = this.gamepak.read32(aligned & 0x01FFFFFF);
        }
        break;
      case 0x0E: case 0x0F: {
        const b = this.gamepak.readSRAM(aligned & 0xFFFF);
        val = b | (b << 8) | (b << 16) | (b << 24);
        break;
      }
      default:
        val = this.lastRead;
        break;
    }

    this.lastRead = val;

    // ARM7TDMI rotates unaligned 32-bit reads
    const misalign = addr & 3;
    if (misalign) {
      val = ror32(val, misalign * 8) | 0;
    }

    return val;
  }

  // =========================================================================
  // 8-bit writes
  // =========================================================================

  write8(addr: number, val: number): void {
    val &= 0xFF;
    const region = (addr >>> 24) & 0xFF;

    switch (region) {
      case 0x02:
        this.ewram8[addr & EWRAM_MASK] = val;
        break;
      case 0x03:
        this._checkWatchpoint(addr, val, 1);
        this.iwram8[addr & IWRAM_MASK] = val;
        break;
      case 0x04:
        this.io.write8(addr & 0x3FF, val);
        break;
      case 0x05:
        // Palette: 8-bit writes write to both bytes of the halfword
        {
          const a = addr & PALETTE_MASK & ~1;
          this.palette8[a] = val;
          this.palette8[a + 1] = val;
        }
        break;
      case 0x06:
        // VRAM: 8-bit writes write to both bytes of the halfword (BG area only)
        {
          const a = this._vramAddr(addr) & ~1;
          // Only BG VRAM (first 64KB in tile modes, 80KB in bitmap modes) accepts 8-bit writes
          if (a < 0x10000) {
            this.vram8[a] = val;
            this.vram8[a + 1] = val;
          }
        }
        break;
      case 0x07:
        // OAM: 8-bit writes ignored
        break;
      case 0x0E: case 0x0F:
        this.gamepak.writeSRAM(addr & 0xFFFF, val);
        break;
      default:
        break;
    }
  }

  // =========================================================================
  // 16-bit writes
  // =========================================================================

  write16(addr: number, val: number): void {
    const aligned = addr & ~1;
    val &= 0xFFFF;
    const region = (aligned >>> 24) & 0xFF;

    switch (region) {
      case 0x02:
        this.ewramView.setUint16(aligned & EWRAM_MASK, val, true);
        break;
      case 0x03:
        this._checkWatchpoint(aligned, val, 2);
        this.iwramView.setUint16(aligned & IWRAM_MASK, val, true);
        break;
      case 0x04:
        this.io.write16(aligned & 0x3FE, val);
        break;
      case 0x05:
        this.paletteView.setUint16(aligned & PALETTE_MASK, val, true);
        break;
      case 0x06:
        this.vramView.setUint16(this._vramAddr(aligned), val, true);
        break;
      case 0x07:
        this.oamView.setUint16(aligned & OAM_MASK, val, true);
        break;
      case 0x08: case 0x09:
      case 0x0A: case 0x0B:
      case 0x0C:
        // ROM is read-only
        break;
      case 0x0D:
        if (this.gamepak.saveType === 4 /* EEPROM */) {
          this.gamepak.writeEEPROM(val);
        }
        // else ROM is read-only
        break;
      case 0x0E: case 0x0F:
        this.gamepak.writeSRAM(aligned & 0xFFFF, val & 0xFF);
        break;
      default:
        break;
    }
  }

  // =========================================================================
  // 32-bit writes
  // =========================================================================

  write32(addr: number, val: number): void {
    const aligned = addr & ~3;
    const region = (aligned >>> 24) & 0xFF;

    switch (region) {
      case 0x02:
        this.ewramView.setInt32(aligned & EWRAM_MASK, val, true);
        break;
      case 0x03:
        this._checkWatchpoint(aligned, val, 4);
        this.iwramView.setInt32(aligned & IWRAM_MASK, val, true);
        break;
      case 0x04:
        this.io.write32(aligned & 0x3FC, val);
        break;
      case 0x05:
        this.paletteView.setInt32(aligned & PALETTE_MASK, val, true);
        break;
      case 0x06:
        this.vramView.setInt32(this._vramAddr(aligned), val, true);
        break;
      case 0x07:
        this.oamView.setInt32(aligned & OAM_MASK, val, true);
        break;
      case 0x08: case 0x09:
      case 0x0A: case 0x0B:
      case 0x0C:
        break;
      case 0x0D:
        if (this.gamepak.saveType === 4 /* EEPROM */) {
          this.gamepak.writeEEPROM(val);
        }
        break;
      case 0x0E: case 0x0F:
        this.gamepak.writeSRAM(aligned & 0xFFFF, val & 0xFF);
        break;
      default:
        break;
    }
  }

  /** Map VRAM address handling the 96KB mirroring */
  private _vramAddr(addr: number): number {
    let offset = addr & VRAM_MASK;
    // VRAM is 96KB (0x18000). Addresses 0x18000-0x1FFFF mirror 0x10000-0x17FFF
    if (offset >= 0x18000) {
      offset -= 0x8000;
    }
    return offset;
  }

  reset(): void {
    // BIOS stub is not cleared on reset (it's ROM)
    this.ewram8.fill(0);
    this.iwram8.fill(0);
    this.palette8.fill(0);
    this.vram8.fill(0);
    this.oam8.fill(0);
    this.lastRead = 0;
    this.biosLatch = 0;
    this.biosRegion = false;
  }
}
