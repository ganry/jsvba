import {
  MODE_USR, MODE_FIQ, MODE_IRQ, MODE_SVC, MODE_ABT, MODE_UND, MODE_SYS,
  CPSR_N, CPSR_Z, CPSR_C, CPSR_V, CPSR_I, CPSR_F, CPSR_T,
} from '../types.js';

// General-purpose register indices
export const R0 = 0;
export const R1 = 1;
export const R2 = 2;
export const R3 = 3;
export const R4 = 4;
export const R5 = 5;
export const R6 = 6;
export const R7 = 7;
export const R8 = 8;
export const R9 = 9;
export const R10 = 10;
export const R11 = 11;
export const R12 = 12;
export const SP = 13;
export const LR = 14;
export const PC = 15;

/**
 * ARM7TDMI Register File
 *
 * The ARM7TDMI has 37 registers total:
 * - R0-R15 (current, visible)
 * - R8_fiq-R12_fiq, R13_fiq, R14_fiq, SPSR_fiq (FIQ banked)
 * - R13_svc, R14_svc, SPSR_svc
 * - R13_abt, R14_abt, SPSR_abt
 * - R13_irq, R14_irq, SPSR_irq
 * - R13_und, R14_und, SPSR_und
 * - CPSR
 *
 * We store current R0-R15 in regs[0..15], CPSR separately.
 * Banked registers are stored in separate arrays and swapped on mode change.
 */
export class RegisterFile {
  /** Current visible registers R0-R15 */
  regs = new Int32Array(16);

  /** Current Program Status Register */
  cpsr = 0;

  // Banked registers for each mode
  // FIQ banks R8-R14, others only bank R13-R14
  private fiqRegs = new Int32Array(7); // R8_fiq - R14_fiq
  private usrRegs = new Int32Array(7); // R8_usr - R14_usr (saved when switching to FIQ)
  private svcRegs = new Int32Array(2); // R13_svc, R14_svc
  private abtRegs = new Int32Array(2); // R13_abt, R14_abt
  private irqRegs = new Int32Array(2); // R13_irq, R14_irq
  private undRegs = new Int32Array(2); // R13_und, R14_und

  // Saved Program Status Registers
  private spsrFiq = 0;
  private spsrSvc = 0;
  private spsrAbt = 0;
  private spsrIrq = 0;
  private spsrUnd = 0;

  get flagN(): boolean { return (this.cpsr & CPSR_N) !== 0; }
  get flagZ(): boolean { return (this.cpsr & CPSR_Z) !== 0; }
  get flagC(): boolean { return (this.cpsr & CPSR_C) !== 0; }
  get flagV(): boolean { return (this.cpsr & CPSR_V) !== 0; }
  get flagI(): boolean { return (this.cpsr & CPSR_I) !== 0; }
  get flagT(): boolean { return (this.cpsr & CPSR_T) !== 0; }
  get mode(): number { return this.cpsr & 0x1F; }

  set flagN(v: boolean) { this.cpsr = v ? (this.cpsr | CPSR_N) : (this.cpsr & ~CPSR_N); }
  set flagZ(v: boolean) { this.cpsr = v ? (this.cpsr | CPSR_Z) : (this.cpsr & ~CPSR_Z); }
  set flagC(v: boolean) { this.cpsr = v ? (this.cpsr | CPSR_C) : (this.cpsr & ~CPSR_C); }
  set flagV(v: boolean) { this.cpsr = v ? (this.cpsr | CPSR_V) : (this.cpsr & ~CPSR_V); }

  setNZ(value: number): void {
    this.flagN = value < 0;
    this.flagZ = value === 0;
  }

  /** Get the SPSR for the current mode */
  get spsr(): number {
    switch (this.mode) {
      case MODE_FIQ: return this.spsrFiq;
      case MODE_SVC: return this.spsrSvc;
      case MODE_ABT: return this.spsrAbt;
      case MODE_IRQ: return this.spsrIrq;
      case MODE_UND: return this.spsrUnd;
      default: return this.cpsr; // USR/SYS have no SPSR
    }
  }

  set spsr(value: number) {
    switch (this.mode) {
      case MODE_FIQ: this.spsrFiq = value; break;
      case MODE_SVC: this.spsrSvc = value; break;
      case MODE_ABT: this.spsrAbt = value; break;
      case MODE_IRQ: this.spsrIrq = value; break;
      case MODE_UND: this.spsrUnd = value; break;
      // USR/SYS: write ignored
    }
  }

  /** Switch CPU mode, banking registers as needed */
  switchMode(newMode: number): void {
    const oldMode = this.mode;
    if (oldMode === newMode) return;

    // Save banked registers from current mode
    this._saveBanked(oldMode);
    // Load banked registers for new mode
    this._loadBanked(newMode);
    // Update mode bits in CPSR
    this.cpsr = (this.cpsr & ~0x1F) | newMode;
  }

  private _saveBanked(mode: number): void {
    if (mode === MODE_FIQ) {
      // FIQ banks R8-R14
      for (let i = 0; i < 7; i++) {
        this.fiqRegs[i] = this.regs[8 + i];
      }
      // Restore USR R8-R14 is done in _loadBanked
    } else {
      // Non-FIQ modes: save R8-R12 as USR
      for (let i = 0; i < 5; i++) {
        this.usrRegs[i] = this.regs[8 + i];
      }
      // Save R13, R14 to mode-specific bank
      const bank = this._getBank(mode);
      if (bank) {
        bank[0] = this.regs[SP];
        bank[1] = this.regs[LR];
      } else {
        // USR/SYS
        this.usrRegs[5] = this.regs[SP];
        this.usrRegs[6] = this.regs[LR];
      }
    }
  }

  private _loadBanked(mode: number): void {
    if (mode === MODE_FIQ) {
      // Save USR R8-R12 before overwriting
      for (let i = 0; i < 5; i++) {
        this.usrRegs[i] = this.regs[8 + i];
      }
      this.usrRegs[5] = this.regs[SP];
      this.usrRegs[6] = this.regs[LR];
      // Load FIQ R8-R14
      for (let i = 0; i < 7; i++) {
        this.regs[8 + i] = this.fiqRegs[i];
      }
    } else {
      // Restore USR R8-R12
      for (let i = 0; i < 5; i++) {
        this.regs[8 + i] = this.usrRegs[i];
      }
      // Load mode-specific R13, R14
      const bank = this._getBank(mode);
      if (bank) {
        this.regs[SP] = bank[0];
        this.regs[LR] = bank[1];
      } else {
        // USR/SYS
        this.regs[SP] = this.usrRegs[5];
        this.regs[LR] = this.usrRegs[6];
      }
    }
  }

  private _getBank(mode: number): Int32Array | null {
    switch (mode) {
      case MODE_SVC: return this.svcRegs;
      case MODE_ABT: return this.abtRegs;
      case MODE_IRQ: return this.irqRegs;
      case MODE_UND: return this.undRegs;
      default: return null; // USR/SYS use usrRegs directly
    }
  }

  /** Restore CPSR from SPSR, properly switching banked registers */
  restoreCpsrFromSpsr(): void {
    const newCpsr = this.spsr;
    const oldMode = this.mode;
    const newMode = newCpsr & 0x1F;
    if (oldMode !== newMode) {
      this._saveBanked(oldMode);
      this._loadBanked(newMode);
    }
    this.cpsr = newCpsr;
  }

  /** Reset to power-on state */
  reset(): void {
    this.regs.fill(0);
    this.cpsr = MODE_SVC | CPSR_I | CPSR_F; // Start in SVC mode, IRQ+FIQ disabled
    this.fiqRegs.fill(0);
    this.usrRegs.fill(0);
    this.svcRegs.fill(0);
    this.abtRegs.fill(0);
    this.irqRegs.fill(0);
    this.undRegs.fill(0);
    this.spsrFiq = 0;
    this.spsrSvc = 0;
    this.spsrAbt = 0;
    this.spsrIrq = 0;
    this.spsrUnd = 0;

    // Post-boot state (skip BIOS): PC at ROM entry, SP initialized
    this.regs[PC] = 0x08000000;
    this.regs[SP] = 0x03007F00;
    this.irqRegs[0] = 0x03007FA0; // SP_irq
    this.svcRegs[0] = 0x03007FE0; // SP_svc
    this.cpsr = MODE_SYS; // System mode, IRQ/FIQ enabled
  }
}
