import { RegisterFile, PC, LR, SP } from './registers.js';
import type { ArmHandler } from './arm.js';
import type { ThumbHandler } from './thumb.js';
import { conditionTable } from './conditions.js';
import type { MMU } from '../memory/mmu.js';
import { handleSWI } from '../memory/bios.js';
import { CPSR_T, CPSR_I, MODE_SVC, MODE_IRQ } from '../types.js';

/**
 * ARM7TDMI CPU
 *
 * 3-stage pipeline (fetch, decode, execute).
 * Supports both ARM (32-bit) and Thumb (16-bit) instruction sets.
 * Pipeline modeled by reading PC+8 (ARM) or PC+4 (Thumb).
 */
export class ARM7TDMI {
  rf = new RegisterFile();
  cycles = 0;
  halted = false;

  /** IntrWait: which IRQ flags we're waiting for (0 = not in IntrWait) */
  waitIrqFlags = 0;

  /** Counter incremented each time VBlankIntrWait is called (for hang detection) */
  vblankIntrWaitCount = 0;

  private armLut: ArmHandler[] = [];
  private thumbLut: ThumbHandler[] = [];
  private mmu!: MMU;

  /** Set the memory bus */
  setMMU(mmu: MMU): void {
    this.mmu = mmu;
  }

  /** Set instruction lookup tables (called after construction) */
  setLUTs(armLut: ArmHandler[], thumbLut: ThumbHandler[]): void {
    this.armLut = armLut;
    this.thumbLut = thumbLut;
  }

  // =========================================================================
  // Memory access (delegates to MMU)
  // =========================================================================

  read8(addr: number): number { return this.mmu.read8(addr); }
  read16(addr: number): number { return this.mmu.read16(addr); }
  read32(addr: number): number { return this.mmu.read32(addr); }
  write8(addr: number, val: number): void { this.mmu.write8(addr, val); }
  write16(addr: number, val: number): void { this.mmu.write16(addr, val); }
  write32(addr: number, val: number): void { this.mmu.write32(addr, val); }

  // =========================================================================
  // Pipeline
  // =========================================================================

  /** Flush pipeline after branch — adjust PC to account for prefetch */
  flushPipeline(): void {
    if (this.rf.flagT) {
      // Thumb: PC should point 2 instructions ahead
      this.rf.regs[PC] &= ~1; // Align to halfword
      this.rf.regs[PC] += 4;
    } else {
      // ARM: PC should point 2 instructions ahead
      this.rf.regs[PC] &= ~3; // Align to word
      this.rf.regs[PC] += 8;
    }
  }

  // =========================================================================
  // Execution
  // =========================================================================

  /** Execute one instruction */
  step(): void {
    if (this.halted) {
      this.cycles += 1;
      return;
    }

    if (this.rf.flagT) {
      this._stepThumb();
    } else {
      this._stepArm();
    }
  }

  private _stepArm(): void {
    // PC points to current instruction + 8, so instruction address is PC - 8
    const instrAddr = (this.rf.regs[PC] - 8) >>> 0;
    // BIOS read protection: allow BIOS reads only while executing in BIOS
    this.mmu.biosRegion = instrAddr < 0x4000;
    const opcode = this.mmu.read32(instrAddr);

    // Advance PC
    this.rf.regs[PC] += 4;
    this.cycles += 1;

    // Check condition code (bits [31:28])
    const cond = (opcode >>> 28) & 0xF;
    if (!conditionTable[cond](this.rf)) {
      return; // Condition not met, skip
    }

    // Decode and execute via LUT
    // LUT index: bits [27:20] as high nibble, bits [7:4] as low nibble
    const lutIdx = ((opcode >>> 16) & 0xFF0) | ((opcode >>> 4) & 0xF);
    this.armLut[lutIdx](this, opcode);
  }

  private _stepThumb(): void {
    // PC points to current instruction + 4, so instruction address is PC - 4
    const instrAddr = (this.rf.regs[PC] - 4) >>> 0;
    this.mmu.biosRegion = instrAddr < 0x4000;
    const opcode = this.mmu.read16(instrAddr);

    // Advance PC
    this.rf.regs[PC] += 2;
    this.cycles += 1;

    // Decode and execute via LUT
    const lutIdx = opcode >>> 6;
    this.thumbLut[lutIdx](this, opcode);
  }

  // =========================================================================
  // SWI handling (called by instruction decoders)
  // =========================================================================

  executeSWI(comment: number): void {
    handleSWI(this, comment);
  }

  // =========================================================================
  // Mode switching helpers for instruction decoders
  // =========================================================================

  /** Enter SVC mode for SWI */
  enterSVC(): void {
    const oldCpsr = this.rf.cpsr;
    this.rf.switchMode(MODE_SVC);
    this.rf.spsr = oldCpsr;
    this.rf.cpsr |= CPSR_I; // Disable IRQs
    this.rf.cpsr &= ~CPSR_T; // Enter ARM state

    // LR = return address
    if (oldCpsr & CPSR_T) {
      this.rf.regs[LR] = this.rf.regs[PC] - 2; // Thumb: next instruction
    } else {
      this.rf.regs[LR] = this.rf.regs[PC] - 4; // ARM: next instruction
    }
  }

  // =========================================================================
  // Reset
  // =========================================================================

  reset(): void {
    this.rf.reset();
    this.cycles = 0;
    this.halted = false;
    this.waitIrqFlags = 0;
    this.flushPipeline();
  }
}
