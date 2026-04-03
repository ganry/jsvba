/**
 * Thumb (16-bit) instruction decoder and handlers for the GBA's ARM7TDMI CPU.
 *
 * The decoder uses a 1024-entry lookup table indexed by the top 10 bits
 * of the 16-bit opcode (opcode >>> 6).
 */

import type { ARM7TDMI } from './arm7tdmi.js';
import { SP, LR, PC } from './registers.js';
import { addCarry, addOverflow, subCarry, subOverflow } from '../../utils/bit-ops.js';
import { MODE_SVC, CPSR_I, CPSR_T } from '../types.js';
import { conditionTable } from './conditions.js';

export type ThumbHandler = (cpu: ARM7TDMI, opcode: number) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read PC as seen by the executing instruction (instrAddr + 4 in Thumb).
 *  After _stepThumb advances PC: regs[PC] = instrAddr + 6, so spec PC = regs[PC] - 2. */
function readPC(cpu: ARM7TDMI): number {
  return (cpu.rf.regs[PC] - 2) | 0;
}

/** Write to PC: set address and flush pipeline for refill. */
function writePC(cpu: ARM7TDMI, addr: number): void {
  cpu.rf.regs[PC] = addr;
  cpu.flushPipeline();
}

/** Unaligned 32-bit load: rotate into register like real hardware. */
function ldrUnaligned(cpu: ARM7TDMI, addr: number): number {
  const aligned = addr & ~3;
  const rot = (addr & 3) << 3;
  const val = cpu.read32(aligned);
  if (rot === 0) return val;
  return ((val >>> rot) | (val << (32 - rot))) | 0;
}

// ---------------------------------------------------------------------------
// Undefined instruction handler
// ---------------------------------------------------------------------------

let _undefCount = 0;
function thumbUndefined(cpu: ARM7TDMI, opcode: number): void {
  _undefCount++;
  if (_undefCount <= 5 || (_undefCount % 1000 === 0)) {
    const pc = ((cpu.rf.regs[15] - 6) >>> 0).toString(16).padStart(8, '0');
    const lr = (cpu.rf.regs[14] >>> 0).toString(16).padStart(8, '0');
    console.warn(`Thumb undefined #${_undefCount} @ PC=0x${pc} LR=0x${lr}: 0x${(opcode & 0xFFFF).toString(16).padStart(4, '0')} CPSR=0x${(cpu.rf.cpsr >>> 0).toString(16)}`);
  }
}

// ---------------------------------------------------------------------------
// Format 1: Move Shifted Register  000xxyyy...
//   LSL Rd, Rs, #Imm5   000 00 xxxxx yyy ddd
//   LSR Rd, Rs, #Imm5   000 01 xxxxx yyy ddd
//   ASR Rd, Rs, #Imm5   000 10 xxxxx yyy ddd
// ---------------------------------------------------------------------------

function thumbLSLImm(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const imm = (opcode >>> 6) & 0x1F;
  const val = cpu.rf.regs[rs];
  let result: number;
  if (imm === 0) {
    result = val;
    // carry unchanged
  } else {
    cpu.rf.flagC = ((val >>> (32 - imm)) & 1) !== 0;
    result = (val << imm) | 0;
  }
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
}

function thumbLSRImm(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const imm = (opcode >>> 6) & 0x1F;
  const val = cpu.rf.regs[rs];
  let result: number;
  if (imm === 0) {
    // LSR #32
    cpu.rf.flagC = val < 0;
    result = 0;
  } else {
    cpu.rf.flagC = ((val >>> (imm - 1)) & 1) !== 0;
    result = val >>> imm;
  }
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
}

function thumbASRImm(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const imm = (opcode >>> 6) & 0x1F;
  const val = cpu.rf.regs[rs];
  let result: number;
  if (imm === 0) {
    // ASR #32
    cpu.rf.flagC = val < 0;
    result = val < 0 ? -1 : 0;
  } else {
    cpu.rf.flagC = ((val >> (imm - 1)) & 1) !== 0;
    result = val >> imm;
  }
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
}

// ---------------------------------------------------------------------------
// Format 2: Add/Subtract
//   ADD Rd, Rs, Rn      000 11 0 0 nnn sss ddd
//   SUB Rd, Rs, Rn      000 11 0 1 nnn sss ddd
//   ADD Rd, Rs, #imm3   000 11 1 0 nnn sss ddd
//   SUB Rd, Rs, #imm3   000 11 1 1 nnn sss ddd
// ---------------------------------------------------------------------------

function thumbADDReg(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const rn = (opcode >>> 6) & 7;
  const a = cpu.rf.regs[rs];
  const b = cpu.rf.regs[rn];
  const result = (a + b) | 0;
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  cpu.rf.flagC = addCarry(a, b);
  cpu.rf.flagV = addOverflow(a, b, result);
}

function thumbSUBReg(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const rn = (opcode >>> 6) & 7;
  const a = cpu.rf.regs[rs];
  const b = cpu.rf.regs[rn];
  const result = (a - b) | 0;
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  cpu.rf.flagC = subCarry(a, b);
  cpu.rf.flagV = subOverflow(a, b, result);
}

function thumbADDImm3(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const imm = (opcode >>> 6) & 7;
  const a = cpu.rf.regs[rs];
  const result = (a + imm) | 0;
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  cpu.rf.flagC = addCarry(a, imm);
  cpu.rf.flagV = addOverflow(a, imm, result);
}

function thumbSUBImm3(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const imm = (opcode >>> 6) & 7;
  const a = cpu.rf.regs[rs];
  const result = (a - imm) | 0;
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  cpu.rf.flagC = subCarry(a, imm);
  cpu.rf.flagV = subOverflow(a, imm, result);
}

// ---------------------------------------------------------------------------
// Format 3: Move/Compare/Add/Subtract Immediate (8-bit)
//   MOV Rd, #imm8    001 00 ddd xxxxxxxx
//   CMP Rd, #imm8    001 01 ddd xxxxxxxx
//   ADD Rd, #imm8    001 10 ddd xxxxxxxx
//   SUB Rd, #imm8    001 11 ddd xxxxxxxx
// ---------------------------------------------------------------------------

function thumbMOVImm8(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode >>> 8) & 7;
  const imm = opcode & 0xFF;
  cpu.rf.regs[rd] = imm;
  cpu.rf.setNZ(imm);
}

function thumbCMPImm8(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode >>> 8) & 7;
  const imm = opcode & 0xFF;
  const a = cpu.rf.regs[rd];
  const result = (a - imm) | 0;
  cpu.rf.setNZ(result);
  cpu.rf.flagC = subCarry(a, imm);
  cpu.rf.flagV = subOverflow(a, imm, result);
}

function thumbADDImm8(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode >>> 8) & 7;
  const imm = opcode & 0xFF;
  const a = cpu.rf.regs[rd];
  const result = (a + imm) | 0;
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  cpu.rf.flagC = addCarry(a, imm);
  cpu.rf.flagV = addOverflow(a, imm, result);
}

function thumbSUBImm8(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode >>> 8) & 7;
  const imm = opcode & 0xFF;
  const a = cpu.rf.regs[rd];
  const result = (a - imm) | 0;
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  cpu.rf.flagC = subCarry(a, imm);
  cpu.rf.flagV = subOverflow(a, imm, result);
}

// ---------------------------------------------------------------------------
// Format 4: ALU Operations  010000 xxxx sss ddd
// ---------------------------------------------------------------------------

function thumbAND(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const result = cpu.rf.regs[rd] & cpu.rf.regs[rs];
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
}

function thumbEOR(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const result = cpu.rf.regs[rd] ^ cpu.rf.regs[rs];
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
}

function thumbLSL(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const amount = cpu.rf.regs[rs] & 0xFF;
  const val = cpu.rf.regs[rd];
  let result: number;
  if (amount === 0) {
    result = val;
  } else if (amount < 32) {
    cpu.rf.flagC = ((val >>> (32 - amount)) & 1) !== 0;
    result = (val << amount) | 0;
  } else if (amount === 32) {
    cpu.rf.flagC = (val & 1) !== 0;
    result = 0;
  } else {
    cpu.rf.flagC = false;
    result = 0;
  }
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  cpu.cycles += 1; // internal cycle for register-shifted
}

function thumbLSR(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const amount = cpu.rf.regs[rs] & 0xFF;
  const val = cpu.rf.regs[rd];
  let result: number;
  if (amount === 0) {
    result = val;
  } else if (amount < 32) {
    cpu.rf.flagC = ((val >>> (amount - 1)) & 1) !== 0;
    result = val >>> amount;
  } else if (amount === 32) {
    cpu.rf.flagC = val < 0;
    result = 0;
  } else {
    cpu.rf.flagC = false;
    result = 0;
  }
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  cpu.cycles += 1;
}

function thumbASR(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const amount = cpu.rf.regs[rs] & 0xFF;
  const val = cpu.rf.regs[rd];
  let result: number;
  if (amount === 0) {
    result = val;
  } else if (amount < 32) {
    cpu.rf.flagC = ((val >> (amount - 1)) & 1) !== 0;
    result = val >> amount;
  } else {
    cpu.rf.flagC = val < 0;
    result = val < 0 ? -1 : 0;
  }
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  cpu.cycles += 1;
}

function thumbADC(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const a = cpu.rf.regs[rd];
  const b = cpu.rf.regs[rs];
  const c = cpu.rf.flagC ? 1 : 0;
  const result = (a + b + c) | 0;
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  // Carry: (a + b + c) > 0xFFFFFFFF
  cpu.rf.flagC = ((a >>> 0) + (b >>> 0) + c) > 0xFFFFFFFF;
  // Overflow: check if sign of result differs from both operands
  // For ADC, overflow = ((a ^ result) & (b ^ result)) < 0 when c=0,
  // but with carry we need a different approach
  cpu.rf.flagV = ((a ^ result) & (b ^ result)) < 0;
}

function thumbSBC(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const a = cpu.rf.regs[rd];
  const b = cpu.rf.regs[rs];
  const c = cpu.rf.flagC ? 0 : 1; // borrow = NOT carry
  const result = (a - b - c) | 0;
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  // Carry (no borrow): a >= b + c
  cpu.rf.flagC = (a >>> 0) >= ((b >>> 0) + c);
  cpu.rf.flagV = ((a ^ b) & (a ^ result)) < 0;
}

function thumbROR(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const amount = cpu.rf.regs[rs] & 0xFF;
  const val = cpu.rf.regs[rd];
  let result: number;
  if (amount === 0) {
    result = val;
  } else {
    const rot = amount & 31;
    if (rot === 0) {
      cpu.rf.flagC = val < 0;
      result = val;
    } else {
      cpu.rf.flagC = ((val >>> (rot - 1)) & 1) !== 0;
      result = ((val >>> rot) | (val << (32 - rot))) | 0;
    }
  }
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  cpu.cycles += 1;
}

function thumbTST(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const result = cpu.rf.regs[rd] & cpu.rf.regs[rs];
  cpu.rf.setNZ(result);
}

function thumbNEG(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const b = cpu.rf.regs[rs];
  const result = (0 - b) | 0;
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  cpu.rf.flagC = subCarry(0, b);
  cpu.rf.flagV = subOverflow(0, b, result);
}

function thumbCMP(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const a = cpu.rf.regs[rd];
  const b = cpu.rf.regs[rs];
  const result = (a - b) | 0;
  cpu.rf.setNZ(result);
  cpu.rf.flagC = subCarry(a, b);
  cpu.rf.flagV = subOverflow(a, b, result);
}

function thumbCMN(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const a = cpu.rf.regs[rd];
  const b = cpu.rf.regs[rs];
  const result = (a + b) | 0;
  cpu.rf.setNZ(result);
  cpu.rf.flagC = addCarry(a, b);
  cpu.rf.flagV = addOverflow(a, b, result);
}

function thumbORR(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const result = cpu.rf.regs[rd] | cpu.rf.regs[rs];
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
}

function thumbMUL(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const result = Math.imul(cpu.rf.regs[rd], cpu.rf.regs[rs]);
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
  // MUL internal cycles depend on the multiplier value
  // Simplified: 1 internal cycle (real hardware: 1-4 based on value)
  cpu.cycles += 1;
}

function thumbBIC(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const result = cpu.rf.regs[rd] & ~cpu.rf.regs[rs];
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
}

function thumbMVN(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const result = ~cpu.rf.regs[rs];
  cpu.rf.regs[rd] = result;
  cpu.rf.setNZ(result);
}

/** ALU operation dispatch table (Format 4, bits [9:6]) */
const aluOps: ThumbHandler[] = [
  thumbAND, // 0x0
  thumbEOR, // 0x1
  thumbLSL, // 0x2
  thumbLSR, // 0x3
  thumbASR, // 0x4
  thumbADC, // 0x5
  thumbSBC, // 0x6
  thumbROR, // 0x7
  thumbTST, // 0x8
  thumbNEG, // 0x9
  thumbCMP, // 0xA
  thumbCMN, // 0xB
  thumbORR, // 0xC
  thumbMUL, // 0xD
  thumbBIC, // 0xE
  thumbMVN, // 0xF
];

function thumbALU(cpu: ARM7TDMI, opcode: number): void {
  const op = (opcode >>> 6) & 0xF;
  aluOps[op](cpu, opcode);
}

// ---------------------------------------------------------------------------
// Format 5: Hi Register Operations / Branch Exchange
//   010001 xx H2 H1 sss ddd
//   ADD Rd, Rs   (00)
//   CMP Rd, Rs   (01)
//   MOV Rd, Rs   (10)
//   BX  Rs       (11)
// ---------------------------------------------------------------------------

function thumbHiADD(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode & 7) | ((opcode >>> 4) & 8); // H1 flag -> bit 3
  const rs = ((opcode >>> 3) & 7) | ((opcode >>> 3) & 8); // H2 flag -> bit 3
  let a = cpu.rf.regs[rd];
  if (rd === PC) a = readPC(cpu);
  let b = cpu.rf.regs[rs];
  if (rs === PC) b = readPC(cpu);
  const result = (a + b) | 0;
  if (rd === PC) {
    writePC(cpu, result & ~1);
  } else {
    cpu.rf.regs[rd] = result;
  }
  // Flags NOT affected by Hi ADD
}

function thumbHiCMP(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode & 7) | ((opcode >>> 4) & 8);
  const rs = ((opcode >>> 3) & 7) | ((opcode >>> 3) & 8);
  let a = cpu.rf.regs[rd];
  if (rd === PC) a = readPC(cpu);
  let b = cpu.rf.regs[rs];
  if (rs === PC) b = readPC(cpu);
  const result = (a - b) | 0;
  cpu.rf.setNZ(result);
  cpu.rf.flagC = subCarry(a, b);
  cpu.rf.flagV = subOverflow(a, b, result);
}

function thumbHiMOV(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode & 7) | ((opcode >>> 4) & 8);
  const rs = ((opcode >>> 3) & 7) | ((opcode >>> 3) & 8);
  let val = cpu.rf.regs[rs];
  if (rs === PC) val = readPC(cpu);
  if (rd === PC) {
    writePC(cpu, val & ~1);
  } else {
    cpu.rf.regs[rd] = val;
  }
  // Flags NOT affected
}

function thumbBX(cpu: ARM7TDMI, opcode: number): void {
  const rs = ((opcode >>> 3) & 7) | ((opcode >>> 3) & 8);
  let addr = cpu.rf.regs[rs];
  if (rs === PC) addr = readPC(cpu);
  // Bit 0 determines Thumb/ARM state
  if (addr & 1) {
    // Stay in Thumb
    cpu.rf.cpsr |= CPSR_T;
    writePC(cpu, addr & ~1);
  } else {
    // Switch to ARM
    cpu.rf.cpsr &= ~CPSR_T;
    writePC(cpu, addr & ~3);
  }
}

function thumbHiReg(cpu: ARM7TDMI, opcode: number): void {
  const op = (opcode >>> 8) & 3;
  switch (op) {
    case 0: thumbHiADD(cpu, opcode); break;
    case 1: thumbHiCMP(cpu, opcode); break;
    case 2: thumbHiMOV(cpu, opcode); break;
    case 3: thumbBX(cpu, opcode); break;
  }
}

// ---------------------------------------------------------------------------
// Format 6: PC-Relative Load
//   01001 ddd xxxxxxxx    LDR Rd, [PC, #imm8*4]
// ---------------------------------------------------------------------------

function thumbLDRPC(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode >>> 8) & 7;
  const imm = (opcode & 0xFF) << 2;
  // PC is word-aligned: (PC+4) & ~2
  const addr = ((readPC(cpu) & ~2) + imm) >>> 0;
  cpu.rf.regs[rd] = cpu.read32(addr);
}

// ---------------------------------------------------------------------------
// Format 7: Load/Store with Register Offset
//   0101 LB 0 rrr sss ddd
//   L=0,B=0: STR   Rd, [Rs, Rn]
//   L=0,B=1: STRB  Rd, [Rs, Rn]
//   L=1,B=0: LDR   Rd, [Rs, Rn]
//   L=1,B=1: LDRB  Rd, [Rs, Rn]
// ---------------------------------------------------------------------------

function thumbSTRReg(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const ro = (opcode >>> 6) & 7;
  const addr = ((cpu.rf.regs[rb] + cpu.rf.regs[ro]) & 0xFFFFFFFF) >>> 0;
  cpu.write32(addr & ~3, cpu.rf.regs[rd]);
}

function thumbSTRBReg(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const ro = (opcode >>> 6) & 7;
  const addr = ((cpu.rf.regs[rb] + cpu.rf.regs[ro]) & 0xFFFFFFFF) >>> 0;
  cpu.write8(addr, cpu.rf.regs[rd] & 0xFF);
}

function thumbLDRReg(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const ro = (opcode >>> 6) & 7;
  const addr = ((cpu.rf.regs[rb] + cpu.rf.regs[ro]) & 0xFFFFFFFF) >>> 0;
  cpu.rf.regs[rd] = ldrUnaligned(cpu, addr);
}

function thumbLDRBReg(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const ro = (opcode >>> 6) & 7;
  const addr = ((cpu.rf.regs[rb] + cpu.rf.regs[ro]) & 0xFFFFFFFF) >>> 0;
  cpu.rf.regs[rd] = cpu.read8(addr);
}

// ---------------------------------------------------------------------------
// Format 8: Load/Store Sign-Extended Byte/Halfword
//   0101 xx 1 rrr sss ddd
//   H=0,S=0: STRH  Rd, [Rs, Rn]
//   H=0,S=1: LDSB  Rd, [Rs, Rn]
//   H=1,S=0: LDRH  Rd, [Rs, Rn]
//   H=1,S=1: LDSH  Rd, [Rs, Rn]
// ---------------------------------------------------------------------------

function thumbSTRH(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const ro = (opcode >>> 6) & 7;
  const addr = ((cpu.rf.regs[rb] + cpu.rf.regs[ro]) & 0xFFFFFFFF) >>> 0;
  cpu.write16(addr & ~1, cpu.rf.regs[rd] & 0xFFFF);
}

function thumbLDSB(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const ro = (opcode >>> 6) & 7;
  const addr = ((cpu.rf.regs[rb] + cpu.rf.regs[ro]) & 0xFFFFFFFF) >>> 0;
  // Sign-extend byte
  cpu.rf.regs[rd] = (cpu.read8(addr) << 24) >> 24;
}

function thumbLDRH(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const ro = (opcode >>> 6) & 7;
  const addr = ((cpu.rf.regs[rb] + cpu.rf.regs[ro]) & 0xFFFFFFFF) >>> 0;
  // Unaligned LDRH: if bit 0 set, result is rotated
  if (addr & 1) {
    const val = cpu.read16(addr & ~1);
    cpu.rf.regs[rd] = ((val >>> 8) | (val << 24)) | 0;
  } else {
    cpu.rf.regs[rd] = cpu.read16(addr);
  }
}

function thumbLDSH(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const ro = (opcode >>> 6) & 7;
  const addr = ((cpu.rf.regs[rb] + cpu.rf.regs[ro]) & 0xFFFFFFFF) >>> 0;
  if (addr & 1) {
    // Misaligned LDSH: loads byte, sign-extends
    cpu.rf.regs[rd] = (cpu.read8(addr) << 24) >> 24;
  } else {
    // Sign-extend halfword
    cpu.rf.regs[rd] = (cpu.read16(addr) << 16) >> 16;
  }
}

// ---------------------------------------------------------------------------
// Format 9: Load/Store with Immediate Offset
//   011 BL xxxxx sss ddd
//   B=0,L=0: STR  Rd, [Rs, #imm5*4]
//   B=0,L=1: LDR  Rd, [Rs, #imm5*4]
//   B=1,L=0: STRB Rd, [Rs, #imm5]
//   B=1,L=1: LDRB Rd, [Rs, #imm5]
// ---------------------------------------------------------------------------

function thumbSTRImm(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const imm = ((opcode >>> 6) & 0x1F) << 2;
  const addr = ((cpu.rf.regs[rb] + imm) & 0xFFFFFFFF) >>> 0;
  cpu.write32(addr & ~3, cpu.rf.regs[rd]);
}

function thumbLDRImm(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const imm = ((opcode >>> 6) & 0x1F) << 2;
  const addr = ((cpu.rf.regs[rb] + imm) & 0xFFFFFFFF) >>> 0;
  cpu.rf.regs[rd] = ldrUnaligned(cpu, addr);
}

function thumbSTRBImm(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const imm = (opcode >>> 6) & 0x1F;
  const addr = ((cpu.rf.regs[rb] + imm) & 0xFFFFFFFF) >>> 0;
  cpu.write8(addr, cpu.rf.regs[rd] & 0xFF);
}

function thumbLDRBImm(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const imm = (opcode >>> 6) & 0x1F;
  const addr = ((cpu.rf.regs[rb] + imm) & 0xFFFFFFFF) >>> 0;
  cpu.rf.regs[rd] = cpu.read8(addr);
}

// ---------------------------------------------------------------------------
// Format 10: Load/Store Halfword with Immediate Offset
//   1000 L xxxxx sss ddd
//   L=0: STRH Rd, [Rs, #imm5*2]
//   L=1: LDRH Rd, [Rs, #imm5*2]
// ---------------------------------------------------------------------------

function thumbSTRHImm(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const imm = ((opcode >>> 6) & 0x1F) << 1;
  const addr = ((cpu.rf.regs[rb] + imm) & 0xFFFFFFFF) >>> 0;
  cpu.write16(addr & ~1, cpu.rf.regs[rd] & 0xFFFF);
}

function thumbLDRHImm(cpu: ARM7TDMI, opcode: number): void {
  const rd = opcode & 7;
  const rb = (opcode >>> 3) & 7;
  const imm = ((opcode >>> 6) & 0x1F) << 1;
  const addr = ((cpu.rf.regs[rb] + imm) & 0xFFFFFFFF) >>> 0;
  cpu.rf.regs[rd] = cpu.read16(addr);
}

// ---------------------------------------------------------------------------
// Format 11: SP-Relative Load/Store
//   1001 L ddd xxxxxxxx
//   L=0: STR Rd, [SP, #imm8*4]
//   L=1: LDR Rd, [SP, #imm8*4]
// ---------------------------------------------------------------------------

function thumbSTRSP(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode >>> 8) & 7;
  const imm = (opcode & 0xFF) << 2;
  const addr = ((cpu.rf.regs[SP] + imm) & 0xFFFFFFFF) >>> 0;
  cpu.write32(addr & ~3, cpu.rf.regs[rd]);
}

function thumbLDRSP(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode >>> 8) & 7;
  const imm = (opcode & 0xFF) << 2;
  const addr = ((cpu.rf.regs[SP] + imm) & 0xFFFFFFFF) >>> 0;
  cpu.rf.regs[rd] = ldrUnaligned(cpu, addr);
}

// ---------------------------------------------------------------------------
// Format 12: Load Address (ADD Rd, PC/SP, #imm8*4)
//   1010 S ddd xxxxxxxx
//   S=0: ADD Rd, PC, #imm8*4
//   S=1: ADD Rd, SP, #imm8*4
// ---------------------------------------------------------------------------

function thumbADDPC(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode >>> 8) & 7;
  const imm = (opcode & 0xFF) << 2;
  // PC is word-aligned
  cpu.rf.regs[rd] = ((readPC(cpu) & ~2) + imm) | 0;
}

function thumbADDSP(cpu: ARM7TDMI, opcode: number): void {
  const rd = (opcode >>> 8) & 7;
  const imm = (opcode & 0xFF) << 2;
  cpu.rf.regs[rd] = (cpu.rf.regs[SP] + imm) | 0;
}

// ---------------------------------------------------------------------------
// Format 13: Add Offset to Stack Pointer
//   10110000 S xxxxxxx
//   S=0: ADD SP, #imm7*4
//   S=1: SUB SP, #imm7*4
// ---------------------------------------------------------------------------

function thumbADDSPImm(cpu: ARM7TDMI, opcode: number): void {
  const imm = (opcode & 0x7F) << 2;
  if (opcode & 0x80) {
    cpu.rf.regs[SP] = (cpu.rf.regs[SP] - imm) | 0;
  } else {
    cpu.rf.regs[SP] = (cpu.rf.regs[SP] + imm) | 0;
  }
}

// ---------------------------------------------------------------------------
// Format 14: Push/Pop Registers
//   1011 L 10 R xxxxxxxx
//   L=0: PUSH {Rlist, LR?}
//   L=1: POP  {Rlist, PC?}
// ---------------------------------------------------------------------------

function thumbPUSH(cpu: ARM7TDMI, opcode: number): void {
  const rbit = (opcode >>> 8) & 1; // R bit: push LR
  const rlist = opcode & 0xFF;

  // Count registers to push
  let count = 0;
  for (let i = 0; i < 8; i++) {
    if (rlist & (1 << i)) count++;
  }
  if (rbit) count++;

  // PUSH decrements SP, then stores
  let addr = (cpu.rf.regs[SP] - (count << 2)) | 0;
  cpu.rf.regs[SP] = addr;

  // Store in ascending order of register number
  for (let i = 0; i < 8; i++) {
    if (rlist & (1 << i)) {
      cpu.write32(addr & ~3, cpu.rf.regs[i]);
      addr = (addr + 4) | 0;
    }
  }
  // Optionally push LR
  if (rbit) {
    cpu.write32(addr & ~3, cpu.rf.regs[LR]);
  }
}

function thumbPOP(cpu: ARM7TDMI, opcode: number): void {
  const rbit = (opcode >>> 8) & 1; // R bit: pop PC
  const rlist = opcode & 0xFF;

  let addr = cpu.rf.regs[SP];

  // Load in ascending order of register number
  for (let i = 0; i < 8; i++) {
    if (rlist & (1 << i)) {
      cpu.rf.regs[i] = cpu.read32(addr & ~3);
      addr = (addr + 4) | 0;
    }
  }
  // Optionally pop PC
  if (rbit) {
    const val = cpu.read32(addr & ~3);
    addr = (addr + 4) | 0;
    // ARMv4: BX-like behavior on pop PC
    // In Thumb mode on GBA (ARMv4T), bit 0 of popped value is ignored for
    // state switching; we simply mask to halfword boundary
    writePC(cpu, val & ~1);
  }

  cpu.rf.regs[SP] = addr;
}

// ---------------------------------------------------------------------------
// Format 15: Multiple Load/Store (STMIA / LDMIA)
//   1100 L nnn xxxxxxxx
//   L=0: STMIA Rn!, {Rlist}
//   L=1: LDMIA Rn!, {Rlist}
// ---------------------------------------------------------------------------

function thumbSTMIA(cpu: ARM7TDMI, opcode: number): void {
  const rb = (opcode >>> 8) & 7;
  const rlist = opcode & 0xFF;
  let addr = cpu.rf.regs[rb];
  const baseAddr = addr;

  // If register list is empty, store PC and add 0x40 to base (ARM7TDMI quirk)
  if (rlist === 0) {
    cpu.write32(addr & ~3, readPC(cpu));
    cpu.rf.regs[rb] = (addr + 0x40) | 0;
    return;
  }

  // Determine if base register is in the list
  const baseInList = (rlist & (1 << rb)) !== 0;
  let firstStore = true;

  for (let i = 0; i < 8; i++) {
    if (rlist & (1 << i)) {
      // ARM7TDMI quirk: if Rb is in the list, first store uses old value,
      // subsequent stores use updated value. However in STMIA, if Rb is
      // first in list it stores old value; if not first, stores new value.
      if (i === rb && baseInList && !firstStore) {
        // Count total registers to determine final write-back value
        let total = 0;
        for (let j = 0; j < 8; j++) if (rlist & (1 << j)) total++;
        cpu.write32(addr & ~3, (baseAddr + (total << 2)) | 0);
      } else {
        cpu.write32(addr & ~3, cpu.rf.regs[i]);
      }
      addr = (addr + 4) | 0;
      firstStore = false;
    }
  }

  cpu.rf.regs[rb] = addr;
}

function thumbLDMIA(cpu: ARM7TDMI, opcode: number): void {
  const rb = (opcode >>> 8) & 7;
  const rlist = opcode & 0xFF;
  let addr = cpu.rf.regs[rb];

  // If register list is empty, load PC and add 0x40 to base (ARM7TDMI quirk)
  if (rlist === 0) {
    writePC(cpu, cpu.read32(addr & ~3));
    cpu.rf.regs[rb] = (addr + 0x40) | 0;
    return;
  }

  for (let i = 0; i < 8; i++) {
    if (rlist & (1 << i)) {
      cpu.rf.regs[i] = cpu.read32(addr & ~3);
      addr = (addr + 4) | 0;
    }
  }

  // Write-back: only if Rb is NOT in the register list
  if (!(rlist & (1 << rb))) {
    cpu.rf.regs[rb] = addr;
  }
}

// ---------------------------------------------------------------------------
// Format 16: Conditional Branch
//   1101 cccc xxxxxxxx   B{cond} #offset
// ---------------------------------------------------------------------------

function thumbBCond(cpu: ARM7TDMI, opcode: number): void {
  const cond = (opcode >>> 8) & 0xF;
  if (conditionTable[cond](cpu.rf)) {
    // Sign-extend 8-bit offset, shift left 1
    const offset = ((opcode & 0xFF) << 24) >> 24;
    const dest = (readPC(cpu) + (offset << 1)) | 0;
    writePC(cpu, dest);
  }
}

// ---------------------------------------------------------------------------
// Format 17: Software Interrupt (SWI)
//   11011111 xxxxxxxx
// ---------------------------------------------------------------------------

function thumbSWI(cpu: ARM7TDMI, opcode: number): void {
  // HLE: extract SWI comment number and dispatch directly
  const comment = opcode & 0xFF;
  cpu.executeSWI(comment);
}

// ---------------------------------------------------------------------------
// Format 18: Unconditional Branch
//   11100 xxxxxxxxxxx   B #offset
// ---------------------------------------------------------------------------

function thumbB(cpu: ARM7TDMI, opcode: number): void {
  // Sign-extend 11-bit offset, shift left 1
  const offset = ((opcode & 0x7FF) << 21) >> 21;
  const dest = (readPC(cpu) + (offset << 1)) | 0;
  writePC(cpu, dest);
}

// ---------------------------------------------------------------------------
// Format 19: Long Branch with Link (BL) — two-instruction sequence
//   1111 0 xxxxxxxxxxx   first: LR = PC + (sign_ext(offset11) << 12)
//   1111 1 xxxxxxxxxxx   second: temp = next_instr, PC = LR + (offset11 << 1), LR = temp | 1
// ---------------------------------------------------------------------------

function thumbBLSetup(cpu: ARM7TDMI, opcode: number): void {
  // H=0: first instruction
  const offset = ((opcode & 0x7FF) << 21) >> 21; // sign-extend 11 bits
  cpu.rf.regs[LR] = (readPC(cpu) + (offset << 12)) | 0;
}

function thumbBLExec(cpu: ARM7TDMI, opcode: number): void {
  // H=1: second instruction
  const offset = (opcode & 0x7FF) << 1;
  const nextAddr = (cpu.rf.regs[PC] - 4) | 0; // address of next instruction (instrAddr + 2)
  const dest = (cpu.rf.regs[LR] + offset) | 0;
  cpu.rf.regs[LR] = nextAddr | 1;
  writePC(cpu, dest);
}

// ---------------------------------------------------------------------------
// LUT Builder
// ---------------------------------------------------------------------------

export function buildThumbLut(): ThumbHandler[] {
  const lut: ThumbHandler[] = new Array(1024);
  lut.fill(thumbUndefined);

  for (let i = 0; i < 1024; i++) {
    // Reconstruct the top 10 bits from the index
    // i = opcode >>> 6, so bits [15:6]
    const top = i << 6;

    // Format 1: Move Shifted Register  000 xx xxxxx yyy ddd
    // bits[15:13] = 000, bits[12:11] = shift type (00=LSL, 01=LSR, 10=ASR)
    // but NOT 0001_1 (that's format 2)
    if ((top & 0xE000) === 0x0000) {
      const shiftType = (top >>> 11) & 3;
      if (shiftType === 0) {
        // 000 00: LSL
        lut[i] = thumbLSLImm;
      } else if (shiftType === 1) {
        // 000 01: LSR
        lut[i] = thumbLSRImm;
      } else if (shiftType === 2) {
        // 000 10: ASR
        lut[i] = thumbASRImm;
      } else {
        // shiftType === 3 => 000 11: Format 2 (Add/Subtract)
        const isImm = (top >>> 10) & 1;
        const isSub = (top >>> 9) & 1;
        if (isImm === 0 && isSub === 0) lut[i] = thumbADDReg;
        else if (isImm === 0 && isSub === 1) lut[i] = thumbSUBReg;
        else if (isImm === 1 && isSub === 0) lut[i] = thumbADDImm3;
        else lut[i] = thumbSUBImm3;
      }
    }

    // Format 3: Move/Compare/Add/Subtract Immediate
    // bits[15:13] = 001
    else if ((top & 0xE000) === 0x2000) {
      const op = (top >>> 11) & 3;
      switch (op) {
        case 0: lut[i] = thumbMOVImm8; break;
        case 1: lut[i] = thumbCMPImm8; break;
        case 2: lut[i] = thumbADDImm8; break;
        case 3: lut[i] = thumbSUBImm8; break;
      }
    }

    // Format 4: ALU Operations  010000 xxxx sss ddd
    // bits[15:10] = 010000
    else if ((top & 0xFC00) === 0x4000) {
      lut[i] = thumbALU;
    }

    // Format 5: Hi Register Operations / Branch Exchange
    // bits[15:10] = 010001
    else if ((top & 0xFC00) === 0x4400) {
      lut[i] = thumbHiReg;
    }

    // Format 6: PC-Relative Load
    // bits[15:11] = 01001
    else if ((top & 0xF800) === 0x4800) {
      lut[i] = thumbLDRPC;
    }

    // Format 7: Load/Store with Register Offset
    // bits[15:12] = 0101, bit[9] = 0
    else if ((top & 0xF200) === 0x5000) {
      const L = (top >>> 11) & 1;
      const B = (top >>> 10) & 1;
      if (L === 0 && B === 0) lut[i] = thumbSTRReg;
      else if (L === 0 && B === 1) lut[i] = thumbSTRBReg;
      else if (L === 1 && B === 0) lut[i] = thumbLDRReg;
      else lut[i] = thumbLDRBReg;
    }

    // Format 8: Load/Store Sign-Extended Byte/Halfword
    // bits[15:12] = 0101, bit[9] = 1
    else if ((top & 0xF200) === 0x5200) {
      const S = (top >>> 10) & 1;
      const H = (top >>> 11) & 1;
      if (H === 0 && S === 0) lut[i] = thumbSTRH;
      else if (H === 0 && S === 1) lut[i] = thumbLDSB;
      else if (H === 1 && S === 0) lut[i] = thumbLDRH;
      else lut[i] = thumbLDSH;
    }

    // Format 9: Load/Store with Immediate Offset
    // bits[15:13] = 011
    else if ((top & 0xE000) === 0x6000) {
      const B = (top >>> 12) & 1;
      const L = (top >>> 11) & 1;
      if (B === 0 && L === 0) lut[i] = thumbSTRImm;
      else if (B === 0 && L === 1) lut[i] = thumbLDRImm;
      else if (B === 1 && L === 0) lut[i] = thumbSTRBImm;
      else lut[i] = thumbLDRBImm;
    }

    // Format 10: Load/Store Halfword with Immediate Offset
    // bits[15:12] = 1000
    else if ((top & 0xF000) === 0x8000) {
      const L = (top >>> 11) & 1;
      if (L === 0) lut[i] = thumbSTRHImm;
      else lut[i] = thumbLDRHImm;
    }

    // Format 11: SP-Relative Load/Store
    // bits[15:12] = 1001
    else if ((top & 0xF000) === 0x9000) {
      const L = (top >>> 11) & 1;
      if (L === 0) lut[i] = thumbSTRSP;
      else lut[i] = thumbLDRSP;
    }

    // Format 12: Load Address
    // bits[15:12] = 1010
    else if ((top & 0xF000) === 0xA000) {
      const S = (top >>> 11) & 1;
      if (S === 0) lut[i] = thumbADDPC;
      else lut[i] = thumbADDSP;
    }

    // Format 13: Add Offset to Stack Pointer
    // bits[15:8] = 10110000
    else if ((top & 0xFF00) === 0xB000) {
      lut[i] = thumbADDSPImm;
    }

    // Format 14: Push/Pop Registers
    // bits[15:12] = 1011, bit 11 = L, bits[10:9] = 10, bit 8 = R
    // PUSH: 1011 0 10 R  = 0xB400 mask 0xFE00
    // POP:  1011 1 10 R  = 0xBC00 mask 0xFE00
    else if ((top & 0xFE00) === 0xB400) {
      lut[i] = thumbPUSH;
    }
    else if ((top & 0xFE00) === 0xBC00) {
      lut[i] = thumbPOP;
    }

    // Format 15: Multiple Load/Store
    // bits[15:12] = 1100
    else if ((top & 0xF000) === 0xC000) {
      const L = (top >>> 11) & 1;
      if (L === 0) lut[i] = thumbSTMIA;
      else lut[i] = thumbLDMIA;
    }

    // Format 16: Conditional Branch
    // bits[15:12] = 1101, bits[11:8] != 1110 and != 1111
    else if ((top & 0xF000) === 0xD000) {
      const cond = (top >>> 8) & 0xF;
      if (cond === 0xE) {
        // 0xDE: undefined in Thumb
        lut[i] = thumbUndefined;
      } else if (cond === 0xF) {
        // 0xDF: SWI (Format 17)
        lut[i] = thumbSWI;
      } else {
        lut[i] = thumbBCond;
      }
    }

    // Format 18: Unconditional Branch
    // bits[15:11] = 11100
    else if ((top & 0xF800) === 0xE000) {
      lut[i] = thumbB;
    }

    // Format 19: Long Branch with Link
    // bits[15:12] = 1111
    else if ((top & 0xF000) === 0xF000) {
      const H = (top >>> 11) & 1;
      if (H === 0) lut[i] = thumbBLSetup;
      else lut[i] = thumbBLExec;
    }
  }

  return lut;
}
