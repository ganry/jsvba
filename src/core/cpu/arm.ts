/**
 * ARM (32-bit) Instruction Decoder and Handlers for the ARM7TDMI
 *
 * Implements the full ARMv4T instruction set:
 *   - Data Processing (AND, EOR, SUB, RSB, ADD, ADC, SBC, RSC, TST, TEQ, CMP, CMN, ORR, MOV, BIC, MVN)
 *   - Multiply / Multiply Long (MUL, MLA, UMULL, UMLAL, SMULL, SMLAL)
 *   - Single Data Swap (SWP, SWPB)
 *   - Branch and Exchange (BX)
 *   - Halfword / Signed Data Transfer (LDRH, STRH, LDRSB, LDRSH)
 *   - Single Data Transfer (LDR, STR, LDRB, STRB)
 *   - Block Data Transfer (LDM, STM)
 *   - Branch (B, BL)
 *   - Software Interrupt (SWI)
 *   - MRS / MSR (PSR transfer)
 *
 * The decoder uses a 4096-entry LUT indexed by:
 *   (opcode >>> 16) & 0xFF0 | (opcode >>> 4) & 0xF
 */

import type { ARM7TDMI } from './arm7tdmi.js';
import { SP, LR, PC } from './registers.js';
import { applyShiftImm, applyShiftReg } from './barrel-shifter.js';
import { addCarry, addOverflow, subCarry, subOverflow } from '../../utils/bit-ops.js';
import { MODE_USR, MODE_SYS, MODE_IRQ, MODE_SVC, MODE_FIQ, MODE_ABT, MODE_UND, CPSR_T, CPSR_I, CPSR_F } from '../types.js';

export type ArmHandler = (cpu: ARM7TDMI, opcode: number) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rotate right a 32-bit value */
function ror32(value: number, amount: number): number {
  amount &= 31;
  if (amount === 0) return value;
  return ((value >>> amount) | (value << (32 - amount))) >>> 0;
}

/** Undefined / unimplemented instruction handler */
function armUnimplemented(cpu: ARM7TDMI, opcode: number): void {
  const pc = ((cpu.rf.regs[15] - 12) >>> 0).toString(16).padStart(8, '0');
  console.warn(`ARM undefined @ 0x${pc}: 0x${(opcode >>> 0).toString(16).padStart(8, '0')}`);
}

// ---------------------------------------------------------------------------
// Data Processing Operand Helpers
// ---------------------------------------------------------------------------

/**
 * Immediate operand: 8-bit value rotated right by 2 * rotate_imm.
 * Shared result object to avoid allocations.
 */
let _opVal = 0;
let _opCarry = false;

function dpGetOperandImm(cpu: ARM7TDMI, opcode: number): void {
  const imm = opcode & 0xFF;
  const rot = ((opcode >>> 8) & 0xF) * 2;
  if (rot === 0) {
    _opVal = imm;
    _opCarry = cpu.rf.flagC;
  } else {
    const result = ror32(imm, rot);
    _opVal = result | 0;
    _opCarry = (result & 0x80000000) !== 0;
  }
}

function dpGetOperandRegImm(cpu: ARM7TDMI, opcode: number): void {
  const rm = opcode & 0xF;
  const shiftType = (opcode >>> 5) & 3;
  const shiftAmt = (opcode >>> 7) & 0x1F;
  let rmVal = cpu.rf.regs[rm];
  // regs[PC] = instrAddr + 12, spec PC = instrAddr + 8 = regs[PC] - 4
  if (rm === PC) rmVal = (rmVal - 4) | 0;
  const res = applyShiftImm(rmVal, shiftType, shiftAmt, cpu.rf.flagC);
  _opVal = res.value;
  _opCarry = res.carry;
}

function dpGetOperandRegReg(cpu: ARM7TDMI, opcode: number): void {
  const rm = opcode & 0xF;
  const shiftType = (opcode >>> 5) & 3;
  const rs = (opcode >>> 8) & 0xF;
  let rmVal = cpu.rf.regs[rm];
  let rsVal = cpu.rf.regs[rs] & 0xFF;
  // Register-specified shift: PC reads as instrAddr + 12 (extra prefetch).
  // regs[PC] = instrAddr + 12 already, so no adjustment needed.
  // (leave rmVal and rsVal as-is when rm/rs === PC)
  cpu.cycles += 1; // extra internal cycle for register shift
  const res = applyShiftReg(rmVal, shiftType, rsVal, cpu.rf.flagC);
  _opVal = res.value;
  _opCarry = res.carry;
}

// ---------------------------------------------------------------------------
// Data Processing Core
// ---------------------------------------------------------------------------

/**
 * Execute a data processing instruction.
 * Assumes _opVal and _opCarry have been set by one of the dpGetOperand* functions.
 */
function execDataProcessing(cpu: ARM7TDMI, opcode: number): void {
  const dpOp = (opcode >>> 21) & 0xF;
  const sBit = (opcode & (1 << 20)) !== 0;
  const rn = (opcode >>> 16) & 0xF;
  const rd = (opcode >>> 12) & 0xF;
  const op2 = _opVal;
  const shifterCarry = _opCarry;

  let rnVal = cpu.rf.regs[rn];
  // After _stepArm advances PC by 4: regs[PC] = instrAddr + 12
  // ARM spec: PC reads as instrAddr + 8 = regs[PC] - 4
  if (rn === PC) rnVal = (rnVal - 4) | 0;

  let result = 0;

  switch (dpOp) {
    // -- Logical operations --
    case 0: // AND
      result = (rnVal & op2) | 0;
      if (sBit) { if (rd === PC) { cpu.rf.restoreCpsrFromSpsr(); } else { cpu.rf.setNZ(result); cpu.rf.flagC = shifterCarry; } }
      cpu.rf.regs[rd] = result;
      if (rd === PC) cpu.flushPipeline();
      return;

    case 1: // EOR
      result = (rnVal ^ op2) | 0;
      if (sBit) { if (rd === PC) { cpu.rf.restoreCpsrFromSpsr(); } else { cpu.rf.setNZ(result); cpu.rf.flagC = shifterCarry; } }
      cpu.rf.regs[rd] = result;
      if (rd === PC) cpu.flushPipeline();
      return;

    case 12: // ORR
      result = (rnVal | op2) | 0;
      if (sBit) { if (rd === PC) { cpu.rf.restoreCpsrFromSpsr(); } else { cpu.rf.setNZ(result); cpu.rf.flagC = shifterCarry; } }
      cpu.rf.regs[rd] = result;
      if (rd === PC) cpu.flushPipeline();
      return;

    case 13: // MOV
      result = op2 | 0;
      if (sBit) { if (rd === PC) { cpu.rf.restoreCpsrFromSpsr(); } else { cpu.rf.setNZ(result); cpu.rf.flagC = shifterCarry; } }
      cpu.rf.regs[rd] = result;
      if (rd === PC) cpu.flushPipeline();
      return;

    case 14: // BIC
      result = (rnVal & ~op2) | 0;
      if (sBit) { if (rd === PC) { cpu.rf.restoreCpsrFromSpsr(); } else { cpu.rf.setNZ(result); cpu.rf.flagC = shifterCarry; } }
      cpu.rf.regs[rd] = result;
      if (rd === PC) cpu.flushPipeline();
      return;

    case 15: // MVN
      result = (~op2) | 0;
      if (sBit) { if (rd === PC) { cpu.rf.restoreCpsrFromSpsr(); } else { cpu.rf.setNZ(result); cpu.rf.flagC = shifterCarry; } }
      cpu.rf.regs[rd] = result;
      if (rd === PC) cpu.flushPipeline();
      return;

    // -- Arithmetic operations --
    case 2: { // SUB
      result = (rnVal - op2) | 0;
      if (sBit) {
        if (rd === PC) { cpu.rf.restoreCpsrFromSpsr(); }
        else { cpu.rf.setNZ(result); cpu.rf.flagC = subCarry(rnVal, op2); cpu.rf.flagV = subOverflow(rnVal, op2, result); }
      }
      cpu.rf.regs[rd] = result;
      if (rd === PC) cpu.flushPipeline();
      return;
    }

    case 3: { // RSB
      result = (op2 - rnVal) | 0;
      if (sBit) {
        if (rd === PC) { cpu.rf.restoreCpsrFromSpsr(); }
        else { cpu.rf.setNZ(result); cpu.rf.flagC = subCarry(op2, rnVal); cpu.rf.flagV = subOverflow(op2, rnVal, result); }
      }
      cpu.rf.regs[rd] = result;
      if (rd === PC) cpu.flushPipeline();
      return;
    }

    case 4: { // ADD
      result = (rnVal + op2) | 0;
      if (sBit) {
        if (rd === PC) { cpu.rf.restoreCpsrFromSpsr(); }
        else { cpu.rf.setNZ(result); cpu.rf.flagC = addCarry(rnVal, op2); cpu.rf.flagV = addOverflow(rnVal, op2, result); }
      }
      cpu.rf.regs[rd] = result;
      if (rd === PC) cpu.flushPipeline();
      return;
    }

    case 5: { // ADC
      const c = cpu.rf.flagC ? 1 : 0;
      result = (rnVal + op2 + c) | 0;
      if (sBit) {
        if (rd === PC) { cpu.rf.restoreCpsrFromSpsr(); }
        else {
          cpu.rf.setNZ(result);
          cpu.rf.flagC = (rnVal >>> 0) + (op2 >>> 0) + c > 0xFFFFFFFF;
          cpu.rf.flagV = addOverflow(rnVal, op2, result);
        }
      }
      cpu.rf.regs[rd] = result;
      if (rd === PC) cpu.flushPipeline();
      return;
    }

    case 6: { // SBC
      const c = cpu.rf.flagC ? 0 : 1;
      result = (rnVal - op2 - c) | 0;
      if (sBit) {
        if (rd === PC) { cpu.rf.restoreCpsrFromSpsr(); }
        else {
          cpu.rf.setNZ(result);
          cpu.rf.flagC = (rnVal >>> 0) - (op2 >>> 0) - c >= 0;
          cpu.rf.flagV = subOverflow(rnVal, op2, result);
        }
      }
      cpu.rf.regs[rd] = result;
      if (rd === PC) cpu.flushPipeline();
      return;
    }

    case 7: { // RSC
      const c = cpu.rf.flagC ? 0 : 1;
      result = (op2 - rnVal - c) | 0;
      if (sBit) {
        if (rd === PC) { cpu.rf.restoreCpsrFromSpsr(); }
        else {
          cpu.rf.setNZ(result);
          cpu.rf.flagC = (op2 >>> 0) - (rnVal >>> 0) - c >= 0;
          cpu.rf.flagV = subOverflow(op2, rnVal, result);
        }
      }
      cpu.rf.regs[rd] = result;
      if (rd === PC) cpu.flushPipeline();
      return;
    }

    // -- Test operations (no writeback) --
    case 8: // TST
      result = (rnVal & op2) | 0;
      cpu.rf.setNZ(result);
      cpu.rf.flagC = shifterCarry;
      return;

    case 9: // TEQ
      result = (rnVal ^ op2) | 0;
      cpu.rf.setNZ(result);
      cpu.rf.flagC = shifterCarry;
      return;

    case 10: // CMP
      result = (rnVal - op2) | 0;
      cpu.rf.setNZ(result);
      cpu.rf.flagC = subCarry(rnVal, op2);
      cpu.rf.flagV = subOverflow(rnVal, op2, result);
      return;

    case 11: // CMN
      result = (rnVal + op2) | 0;
      cpu.rf.setNZ(result);
      cpu.rf.flagC = addCarry(rnVal, op2);
      cpu.rf.flagV = addOverflow(rnVal, op2, result);
      return;
  }
}

// Data processing entry points for each operand type
function armDpImm(cpu: ARM7TDMI, opcode: number): void {
  dpGetOperandImm(cpu, opcode);
  execDataProcessing(cpu, opcode);
}

function armDpRegImm(cpu: ARM7TDMI, opcode: number): void {
  dpGetOperandRegImm(cpu, opcode);
  execDataProcessing(cpu, opcode);
}

function armDpRegReg(cpu: ARM7TDMI, opcode: number): void {
  dpGetOperandRegReg(cpu, opcode);
  execDataProcessing(cpu, opcode);
}

// ---------------------------------------------------------------------------
// Multiply (MUL, MLA)
// ---------------------------------------------------------------------------

function armMultiply(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode >>> 16) & 0xF;
  const rn = (opcode >>> 12) & 0xF;
  const rs = (opcode >>> 8) & 0xF;
  const rm = opcode & 0xF;
  const accumulate = (opcode & (1 << 21)) !== 0;
  const sBit = (opcode & (1 << 20)) !== 0;

  let result = Math.imul(cpu.rf.regs[rm], cpu.rf.regs[rs]);
  if (accumulate) {
    result = (result + cpu.rf.regs[rn]) | 0;
  }

  cpu.rf.regs[rd] = result;

  if (sBit) {
    cpu.rf.setNZ(result);
    // C is destroyed (unpredictable) in ARMv4, V unaffected
  }

  // Multiply timing: 1-4 internal cycles depending on Rs magnitude
  let rsAbs = cpu.rf.regs[rs];
  if (rsAbs < 0) rsAbs = ~rsAbs;
  if ((rsAbs >>> 8) === 0) cpu.cycles += 1;
  else if ((rsAbs >>> 16) === 0) cpu.cycles += 2;
  else if ((rsAbs >>> 24) === 0) cpu.cycles += 3;
  else cpu.cycles += 4;
}

// ---------------------------------------------------------------------------
// Multiply Long (UMULL, UMLAL, SMULL, SMLAL)
// ---------------------------------------------------------------------------

function armMultiplyLong(cpu: ARM7TDMI, opcode: number): void {
  const rdHi = (opcode >>> 16) & 0xF;
  const rdLo = (opcode >>> 12) & 0xF;
  const rs = (opcode >>> 8) & 0xF;
  const rm = opcode & 0xF;
  const isSigned = (opcode & (1 << 22)) !== 0;
  const accumulate = (opcode & (1 << 21)) !== 0;
  const sBit = (opcode & (1 << 20)) !== 0;

  let resultHi: number;
  let resultLo: number;

  if (isSigned) {
    const product = BigInt(cpu.rf.regs[rm]) * BigInt(cpu.rf.regs[rs]);
    resultLo = Number(product & 0xFFFFFFFFn) | 0;
    resultHi = Number((product >> 32n) & 0xFFFFFFFFn) | 0;
  } else {
    const product = BigInt(cpu.rf.regs[rm] >>> 0) * BigInt(cpu.rf.regs[rs] >>> 0);
    resultLo = Number(product & 0xFFFFFFFFn) | 0;
    resultHi = Number((product >> 32n) & 0xFFFFFFFFn) | 0;
  }

  if (accumulate) {
    const accLo = cpu.rf.regs[rdLo] >>> 0;
    const accHi = cpu.rf.regs[rdHi] >>> 0;
    const sumLo = (resultLo >>> 0) + accLo;
    resultLo = sumLo | 0;
    resultHi = ((resultHi >>> 0) + accHi + (sumLo > 0xFFFFFFFF ? 1 : 0)) | 0;
  }

  cpu.rf.regs[rdLo] = resultLo;
  cpu.rf.regs[rdHi] = resultHi;

  if (sBit) {
    cpu.rf.flagZ = resultHi === 0 && resultLo === 0;
    cpu.rf.flagN = resultHi < 0;
    // C and V are destroyed/unpredictable in ARMv4
  }

  // Long multiply timing: 2-5 internal cycles
  let rsAbs = cpu.rf.regs[rs];
  if (isSigned && rsAbs < 0) rsAbs = ~rsAbs;
  else rsAbs = rsAbs >>> 0;
  if ((rsAbs >>> 8) === 0) cpu.cycles += 2;
  else if ((rsAbs >>> 16) === 0) cpu.cycles += 3;
  else if ((rsAbs >>> 24) === 0) cpu.cycles += 4;
  else cpu.cycles += 5;
}

// ---------------------------------------------------------------------------
// Single Data Swap (SWP, SWPB)
// ---------------------------------------------------------------------------

function armSwap(cpu: ARM7TDMI, opcode: number): void {
  const rn = (opcode >>> 16) & 0xF;
  const rd = (opcode >>> 12) & 0xF;
  const rm = opcode & 0xF;
  const byteSwap = (opcode & (1 << 22)) !== 0;

  const addr = cpu.rf.regs[rn];

  if (byteSwap) {
    const tmp = cpu.read8(addr);
    cpu.write8(addr, cpu.rf.regs[rm] & 0xFF);
    cpu.rf.regs[rd] = tmp;
  } else {
    const alignedAddr = addr & ~3;
    let tmp = cpu.read32(alignedAddr);
    const rot = (addr & 3) * 8;
    if (rot !== 0) {
      tmp = ((tmp >>> rot) | (tmp << (32 - rot))) | 0;
    }
    cpu.write32(alignedAddr, cpu.rf.regs[rm]);
    cpu.rf.regs[rd] = tmp;
  }

  cpu.cycles += 1; // extra internal cycle
}

// ---------------------------------------------------------------------------
// Branch and Exchange (BX)
// ---------------------------------------------------------------------------

function armBranchExchange(cpu: ARM7TDMI, opcode: number): void {
  const rm = opcode & 0xF;
  let addr = cpu.rf.regs[rm];
  // If Rm is PC, it reads as instrAddr + 8, but we've already advanced by 4
  // so regs[PC] = instrAddr + 12 → spec PC = instrAddr + 8 = regs[PC] - 4
  if (rm === PC) addr = (cpu.rf.regs[PC] - 4) | 0;

  if (addr & 1) {
    // Switch to Thumb mode
    cpu.rf.cpsr = cpu.rf.cpsr | CPSR_T;
    cpu.rf.regs[PC] = addr & ~1;
  } else {
    cpu.rf.cpsr = cpu.rf.cpsr & ~CPSR_T;
    cpu.rf.regs[PC] = addr & ~3;
  }
  cpu.flushPipeline();
}

// ---------------------------------------------------------------------------
// Halfword / Signed Data Transfer (LDRH, STRH, LDRSB, LDRSH)
// ---------------------------------------------------------------------------

function armHalfwordTransfer(cpu: ARM7TDMI, opcode: number): void {
  const pre = (opcode & (1 << 24)) !== 0;
  const up = (opcode & (1 << 23)) !== 0;
  const immOffset = (opcode & (1 << 22)) !== 0;
  const writeback = (opcode & (1 << 21)) !== 0;
  const load = (opcode & (1 << 20)) !== 0;
  const rn = (opcode >>> 16) & 0xF;
  const rd = (opcode >>> 12) & 0xF;
  const sh = (opcode >>> 5) & 3; // SH bits: 01=H, 10=SB, 11=SH

  let offset: number;
  if (immOffset) {
    offset = ((opcode >>> 4) & 0xF0) | (opcode & 0xF);
  } else {
    offset = cpu.rf.regs[opcode & 0xF];
  }

  let base = cpu.rf.regs[rn];
  // regs[PC] = instrAddr + 12, spec PC = instrAddr + 8 = regs[PC] - 4
  if (rn === PC) base = (base - 4) | 0;

  let addr = base;
  if (pre) {
    addr = up ? (base + offset) | 0 : (base - offset) | 0;
  }

  if (load) {
    switch (sh) {
      case 1: { // LDRH - unsigned halfword
        // ARM7TDMI: misaligned LDRH rotates the 16-bit value
        const alignedAddr = addr & ~1;
        const raw = cpu.read16(alignedAddr);
        if (addr & 1) {
          cpu.rf.regs[rd] = ((raw >>> 8) | (raw << 24)) | 0;
        } else {
          cpu.rf.regs[rd] = raw;
        }
        break;
      }
      case 2: { // LDRSB - signed byte
        const value = cpu.read8(addr);
        cpu.rf.regs[rd] = (value << 24) >> 24;
        break;
      }
      case 3: { // LDRSH - signed halfword
        if (addr & 1) {
          const value = cpu.read8(addr);
          cpu.rf.regs[rd] = (value << 24) >> 24;
        } else {
          const value = cpu.read16(addr);
          cpu.rf.regs[rd] = (value << 16) >> 16;
        }
        break;
      }
    }

    if (rd === PC) {
      cpu.rf.regs[PC] &= ~3;
      cpu.flushPipeline();
    }
  } else {
    // Store (STRH, sh=1)
    // STR Rd=PC: ARM7TDMI stores instrAddr + 12, which is already regs[PC]
    const value = cpu.rf.regs[rd];
    cpu.write16(addr & ~1, value & 0xFFFF);
  }

  // Post-index always writes back; pre-index only if W bit set
  if (!pre) {
    cpu.rf.regs[rn] = up ? (base + offset) | 0 : (base - offset) | 0;
  } else if (writeback) {
    cpu.rf.regs[rn] = addr;
  }
}

// ---------------------------------------------------------------------------
// Single Data Transfer (LDR, STR, LDRB, STRB)
// ---------------------------------------------------------------------------

function armSingleTransfer(cpu: ARM7TDMI, opcode: number): void {
  const regOffset = (opcode & (1 << 25)) !== 0; // bit 25=1 means register offset
  const pre = (opcode & (1 << 24)) !== 0;
  const up = (opcode & (1 << 23)) !== 0;
  const byteTransfer = (opcode & (1 << 22)) !== 0;
  const writeback = (opcode & (1 << 21)) !== 0;
  const load = (opcode & (1 << 20)) !== 0;
  const rn = (opcode >>> 16) & 0xF;
  const rd = (opcode >>> 12) & 0xF;

  let offset: number;
  if (!regOffset) {
    // Immediate 12-bit offset
    offset = opcode & 0xFFF;
  } else {
    // Register offset with immediate shift
    const rm = opcode & 0xF;
    const shiftType = (opcode >>> 5) & 3;
    const shiftAmt = (opcode >>> 7) & 0x1F;
    const res = applyShiftImm(cpu.rf.regs[rm], shiftType, shiftAmt, cpu.rf.flagC);
    offset = res.value;
  }

  let base = cpu.rf.regs[rn];
  // regs[PC] = instrAddr + 12, spec PC = instrAddr + 8 = regs[PC] - 4
  if (rn === PC) base = (base - 4) | 0;

  let addr = base;
  if (pre) {
    addr = up ? (base + offset) | 0 : (base - offset) | 0;
  }

  if (load) {
    if (byteTransfer) {
      cpu.rf.regs[rd] = cpu.read8(addr);
    } else {
      // LDR: unaligned access rotates result
      const alignedAddr = addr & ~3;
      let value = cpu.read32(alignedAddr);
      const rot = (addr & 3) * 8;
      if (rot !== 0) {
        value = ((value >>> rot) | (value << (32 - rot))) | 0;
      }
      cpu.rf.regs[rd] = value;
    }

    if (rd === PC) {
      cpu.rf.regs[PC] &= ~3;
      cpu.flushPipeline();
    }
  } else {
    // STR Rd=PC: ARM7TDMI stores instrAddr + 12, which is already regs[PC]
    const value = cpu.rf.regs[rd];

    if (byteTransfer) {
      cpu.write8(addr, value & 0xFF);
    } else {
      cpu.write32(addr & ~3, value);
    }
  }

  // Post-index always writes back; pre-index only if W bit set
  if (!pre) {
    cpu.rf.regs[rn] = up ? (base + offset) | 0 : (base - offset) | 0;
  } else if (writeback) {
    cpu.rf.regs[rn] = addr;
  }
}

// ---------------------------------------------------------------------------
// Block Data Transfer (LDM, STM)
// ---------------------------------------------------------------------------

function armBlockTransfer(cpu: ARM7TDMI, opcode: number): void {
  const pre = (opcode & (1 << 24)) !== 0;
  const up = (opcode & (1 << 23)) !== 0;
  const sBit = (opcode & (1 << 22)) !== 0;
  const writeback = (opcode & (1 << 21)) !== 0;
  const load = (opcode & (1 << 20)) !== 0;
  const rn = (opcode >>> 16) & 0xF;
  const regList = opcode & 0xFFFF;

  // Edge case: empty register list transfers PC and offsets by 0x40
  if (regList === 0) {
    const base = cpu.rf.regs[rn];
    if (load) {
      cpu.rf.regs[PC] = cpu.read32(base) & ~3;
      cpu.flushPipeline();
    } else {
      // STM PC: ARM7TDMI stores instrAddr + 12, which is already regs[PC]
      cpu.write32(base, cpu.rf.regs[PC]);
    }
    cpu.rf.regs[rn] = up ? (base + 0x40) | 0 : (base - 0x40) | 0;
    return;
  }

  // Count registers
  let count = 0;
  for (let i = 0; i < 16; i++) {
    if (regList & (1 << i)) count++;
  }

  const base = cpu.rf.regs[rn];
  const writebackValue = up ? (base + (count << 2)) | 0 : (base - (count << 2)) | 0;

  // Calculate lowest transfer address (ARM always transfers in ascending order)
  let addr: number;
  if (up) {
    addr = pre ? (base + 4) | 0 : base;
  } else {
    addr = pre ? (base - (count << 2)) | 0 : (base - (count << 2) + 4) | 0;
  }

  // User-bank transfer: S bit set AND (store, or load without PC in list)
  const useUserBank = sBit && (!load || !(regList & (1 << PC)));
  const oldMode = cpu.rf.mode;
  if (useUserBank && oldMode !== MODE_USR && oldMode !== MODE_SYS) {
    cpu.rf.switchMode(MODE_USR);
  }

  if (load) {
    let loadedPC = false;
    for (let i = 0; i < 16; i++) {
      if (!(regList & (1 << i))) continue;

      if (i === PC && sBit) {
        // LDM with S bit and PC in list: restore CPSR from SPSR
        // Don't mask here — restoreCpsrFromSpsr may switch to Thumb mode,
        // and flushPipeline will apply the correct alignment based on restored T bit
        cpu.rf.regs[PC] = cpu.read32(addr);
        cpu.rf.restoreCpsrFromSpsr();
        loadedPC = true;
      } else if (i === PC) {
        cpu.rf.regs[PC] = cpu.read32(addr) & ~3;
        loadedPC = true;
      } else {
        cpu.rf.regs[i] = cpu.read32(addr);
      }
      addr = (addr + 4) | 0;
    }
    if (loadedPC) cpu.flushPipeline();
  } else {
    // STM
    let isFirst = true;
    for (let i = 0; i < 16; i++) {
      if (!(regList & (1 << i))) continue;

      let value: number;
      if (i === PC) {
        // STM PC: ARM7TDMI stores instrAddr + 12, which is already regs[PC]
        value = cpu.rf.regs[PC];
      } else if (i === rn && !isFirst && writeback) {
        // ARM7TDMI: if Rn is not the first in list, store the updated base
        value = writebackValue;
      } else {
        value = cpu.rf.regs[i];
      }

      cpu.write32(addr, value);
      addr = (addr + 4) | 0;
      isFirst = false;
    }
  }

  // Restore mode if we switched
  if (useUserBank && oldMode !== MODE_USR && oldMode !== MODE_SYS) {
    cpu.rf.switchMode(oldMode);
  }

  // ARM7TDMI: LDM with writeback — if Rn is in the register list, writeback is suppressed
  // STM with writeback — always writes back (already handled store value above)
  if (writeback && !(load && (regList & (1 << rn)))) {
    cpu.rf.regs[rn] = writebackValue;
  }
}

// ---------------------------------------------------------------------------
// Branch (B, BL)
// ---------------------------------------------------------------------------

function armBranch(cpu: ARM7TDMI, opcode: number): void {
  const link = (opcode & (1 << 24)) !== 0;

  // 24-bit signed offset, shifted left by 2
  let offset = opcode & 0x00FFFFFF;
  if (offset & 0x00800000) {
    offset |= 0xFF000000; // sign extend
  }
  offset = (offset << 2) | 0;

  // After _stepArm advances PC, regs[PC] = instrAddr + 12
  // ARM spec PC = instrAddr + 8 = regs[PC] - 4
  // Next instruction = instrAddr + 4 = regs[PC] - 8

  if (link) {
    cpu.rf.regs[LR] = (cpu.rf.regs[PC] - 8) | 0; // address of next instruction
  }

  // Branch target = (ARM spec PC) + offset = (regs[PC] - 4) + offset
  cpu.rf.regs[PC] = ((cpu.rf.regs[PC] - 4) + offset) | 0;
  cpu.flushPipeline();
}

// ---------------------------------------------------------------------------
// Software Interrupt (SWI)
// ---------------------------------------------------------------------------

function armSWI(cpu: ARM7TDMI, opcode: number): void {
  // HLE: extract SWI comment number and dispatch directly
  const comment = (opcode >>> 16) & 0xFF;
  cpu.executeSWI(comment);
}

// ---------------------------------------------------------------------------
// MRS (Move PSR to register)
// ---------------------------------------------------------------------------

function armMRS(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode >>> 12) & 0xF;
  const useSPSR = (opcode & (1 << 22)) !== 0;
  cpu.rf.regs[rd] = useSPSR ? cpu.rf.spsr : cpu.rf.cpsr;
}

// ---------------------------------------------------------------------------
// MSR (Move register/immediate to PSR)
// ---------------------------------------------------------------------------

function armMSRReg(cpu: ARM7TDMI, opcode: number): void {
  msrWrite(cpu, opcode, cpu.rf.regs[opcode & 0xF]);
}

function armMSRImm(cpu: ARM7TDMI, opcode: number): void {
  const imm = opcode & 0xFF;
  const rot = ((opcode >>> 8) & 0xF) * 2;
  msrWrite(cpu, opcode, ror32(imm, rot) | 0);
}

function msrWrite(cpu: ARM7TDMI, opcode: number, value: number): void {
  const useSPSR = (opcode & (1 << 22)) !== 0;

  // Field mask: bits [19:16] select which bytes to write
  let mask = 0;
  if (opcode & (1 << 19)) mask |= 0xFF000000; // flags (N, Z, C, V)
  if (opcode & (1 << 18)) mask |= 0x00FF0000; // status
  if (opcode & (1 << 17)) mask |= 0x0000FF00; // extension
  if (opcode & (1 << 16)) mask |= 0x000000FF; // control (mode, IRQ/FIQ disable, Thumb)

  // User mode can only write the flags byte
  if (cpu.rf.mode === MODE_USR) {
    mask &= 0xFF000000;
  }

  if (useSPSR) {
    cpu.rf.spsr = (cpu.rf.spsr & ~mask) | (value & mask);
  } else {
    const oldMode = cpu.rf.mode;
    const newCpsr = (cpu.rf.cpsr & ~mask) | (value & mask);
    const newMode = newCpsr & 0x1F;
    if (newMode !== oldMode && (mask & 0x1F) !== 0) {
      cpu.rf.switchMode(newMode);
    }
    cpu.rf.cpsr = newCpsr;
  }
}

// ---------------------------------------------------------------------------
// LUT Builder
// ---------------------------------------------------------------------------

/**
 * Build the 4096-entry ARM instruction LUT.
 *
 * LUT index = ((opcode >>> 16) & 0xFF0) | ((opcode >>> 4) & 0xF)
 *
 * From the 32-bit opcode:
 *   - Bits [27:20] -> LUT bits [11:4]
 *   - Bits [7:4]   -> LUT bits [3:0]
 */
export function buildArmLut(): ArmHandler[] {
  const lut = new Array<ArmHandler>(4096);

  for (let i = 0; i < 4096; i++) {
    const bits27_20 = (i >>> 4) & 0xFF;
    const bits7_4 = i & 0xF;
    lut[i] = decodeArmEntry(bits27_20, bits7_4);
  }

  return lut;
}

/**
 * Decode a single LUT entry from the significant opcode bits.
 *
 * The ARM instruction encoding can be decoded hierarchically:
 *   bits[27:25] = major group
 *   Within group 000: multiply, swap, halfword transfer, BX, MRS, MSR, data processing
 *   Within group 001: data processing immediate, MSR immediate
 *   010: single data transfer (immediate offset)
 *   011: single data transfer (register offset) or undefined
 *   100: block data transfer
 *   101: branch
 *   110: coprocessor (unused on GBA)
 *   111: SWI or coprocessor
 */
function decodeArmEntry(bits27_20: number, bits7_4: number): ArmHandler {
  const bits27_25 = (bits27_20 >>> 5) & 7;

  switch (bits27_25) {
    case 0b000:
      return decodeGroup000(bits27_20 & 0x1F, bits7_4);

    case 0b001:
      return decodeGroup001(bits27_20 & 0x1F);

    case 0b010:
      return armSingleTransfer;

    case 0b011:
      // bit 4 = 0: register offset single data transfer
      // bit 4 = 1: undefined (media instructions in ARMv5+)
      return (bits7_4 & 1) === 0 ? armSingleTransfer : armUnimplemented;

    case 0b100:
      return armBlockTransfer;

    case 0b101:
      return armBranch;

    case 0b110:
      return armUnimplemented; // Coprocessor

    case 0b111:
      // bit 24 = 1: SWI; bit 24 = 0: coprocessor
      return (bits27_20 & 0x10) ? armSWI : armUnimplemented;

    default:
      return armUnimplemented;
  }
}

/**
 * Decode group 000: bits[27:25] = 000
 * This is the most complex group containing:
 *   - Multiply (MUL/MLA): 0000_00AS, bits[7:4] = 1001
 *   - Multiply long (xMULL/xMLAL): 0000_1UAS, bits[7:4] = 1001
 *   - Swap (SWP/SWPB): 0001_0B00, bits[7:4] = 1001
 *   - BX: 0001_0010, bits[7:4] = 0001
 *   - Halfword transfer: bit7=1, bit4=1, bits[6:5]!=00
 *   - MRS: 0001_0R00, bits[7:4] = 0000
 *   - MSR (reg): 0001_0R10, bits[7:4] = 0000 (or field mask variants 0xx1_0R10)
 *   - Data processing (register shift): bit4=1, bit7=0
 *   - Data processing (immediate shift): bit4=0
 */
function decodeGroup000(bits24_20: number, bits7_4: number): ArmHandler {
  const bit4 = bits7_4 & 1;
  const bit7 = (bits7_4 >>> 3) & 1;

  // Check for multiply/swap: bits[7:4] = 1001
  if (bits7_4 === 0b1001) {
    const bit24_23 = (bits24_20 >>> 3) & 3;
    if (bit24_23 === 0b00) {
      // bits[27:23] = 00000: MUL/MLA
      return armMultiply;
    }
    if (bit24_23 === 0b01) {
      // bits[27:23] = 00001: Multiply long
      return armMultiplyLong;
    }
    // bits[27:23] = 00010: SWP/SWPB
    // Encoding: 0001_0B00, bits[7:4] = 1001
    if ((bits24_20 & 0x1B) === 0x10) {
      return armSwap;
    }
    return armUnimplemented;
  }

  // Halfword / signed transfer: bit7=1, bit4=1, SH bits != 00
  if (bit7 === 1 && bit4 === 1) {
    const sh = (bits7_4 >>> 1) & 3;
    if (sh !== 0) {
      return armHalfwordTransfer;
    }
    // SH=00 with bit7=1, bit4=1 is undefined
    return armUnimplemented;
  }

  // BX: bits[24:20] = 10010, bits[7:4] = 0001
  if (bits24_20 === 0x12 && bits7_4 === 0x01) {
    return armBranchExchange;
  }

  // MRS / MSR (register): these occupy the "TEQ/CMP/TST/CMN without S bit" space
  // MRS: bits[24:20] = 10x00, bits[7:4] = 0000 (bit21=0)
  // MSR: bits[24:20] = 10x10, bits[7:4] = 0000 (bit21=1)
  // Also MSR with field mask: bits[24:23]=10, bit20=0, bit21=1
  if ((bits24_20 & 0x19) === 0x10 && bits7_4 === 0x00) {
    // bits[24:23]=10, bit20=0
    if (bits24_20 & 0x02) {
      // bit21=1: MSR (register)
      return armMSRReg;
    } else {
      // bit21=0: MRS
      return armMRS;
    }
  }

  // Data processing with register operand
  if (bit4 === 0) {
    return armDpRegImm; // immediate shift
  }

  // bit4=1, bit7=0: register shift
  if (bit7 === 0) {
    return armDpRegReg;
  }

  return armUnimplemented;
}

/**
 * Decode group 001: bits[27:25] = 001
 * Data processing with immediate operand, or MSR immediate.
 *
 * MSR immediate steals the TST/TEQ/CMP/CMN opcode space where S=0:
 *   bits[24:23]=10, bit20=0, bit21=1 -> MSR immediate
 *   bits[24:23]=10, bit20=0, bit21=0 -> undefined (would be MRS imm, doesn't exist)
 */
function decodeGroup001(bits24_20: number): ArmHandler {
  const bit24_23 = (bits24_20 >>> 3) & 3;
  const bit20 = bits24_20 & 1;

  if (bit24_23 === 0b10 && bit20 === 0) {
    const bit21 = (bits24_20 >>> 1) & 1;
    if (bit21 === 1) {
      return armMSRImm;
    }
    // bit21=0: no MRS with immediate operand
    return armUnimplemented;
  }

  return armDpImm;
}
