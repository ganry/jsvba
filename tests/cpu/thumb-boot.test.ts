/**
 * Test: ARM → Thumb transition and Thumb code execution.
 */
import { describe, it, expect } from 'vitest';
import { GBA } from '../../src/core/gba.js';

// ARM instruction encoding helpers
function armMOVImm(rd: number, imm8: number, rotImm: number): number {
  // MOV Rd, #imm8 ROR (rotImm*2)
  // cond=E, 001, 1101, S=0, Rn=0, Rd, rotImm, imm8
  return (0xE3A00000 | (rd << 12) | (rotImm << 8) | imm8) >>> 0;
}

function armADDImm(rd: number, rn: number, imm8: number, rotImm: number = 0): number {
  return (0xE2800000 | (rn << 16) | (rd << 12) | (rotImm << 8) | imm8) >>> 0;
}

function armSTR(rd: number, rn: number, imm12: number = 0): number {
  // STR Rd, [Rn, #imm12] pre-indexed
  return (0xE5800000 | (rn << 16) | (rd << 12) | imm12) >>> 0;
}

function armSTRH(rd: number, rn: number, imm8: number = 0): number {
  // STRH Rd, [Rn, #imm8] pre-indexed, immediate offset
  const hiNibble = (imm8 >>> 4) & 0xF;
  const loNibble = imm8 & 0xF;
  return (0xE1C000B0 | (rn << 16) | (rd << 12) | (hiNibble << 8) | loNibble) >>> 0;
}

function armBX(rm: number): number {
  return (0xE12FFF10 | rm) >>> 0;
}

function armLDR_PC(rd: number, offset: number): number {
  // LDR Rd, [PC, #offset]
  return (0xE59F0000 | (rd << 12) | offset) >>> 0;
}

function armB(offset24: number): number {
  // B offset (offset is the signed 24-bit word offset)
  return (0xEA000000 | (offset24 & 0x00FFFFFF)) >>> 0;
}

function buildThumbTestROM(): ArrayBuffer {
  const rom = new ArrayBuffer(512);
  const view = new DataView(rom);
  const w32 = (off: number, val: number) => view.setUint32(off, val, true);
  const w16 = (off: number, val: number) => view.setUint16(off, val, true);

  // Branch over header: B to 0xC0
  // offset = (0xC0 - (0x00 + 8)) / 4 = (0xB8) / 4 = 0x2E
  w32(0x00, armB(0x2E));

  let pc = 0xC0;
  // MOV R0, #0x04000000 = 0x01 ROR 6 → rot_imm=3
  w32(pc, armMOVImm(0, 0x01, 3)); pc += 4;  // R0 = 0x04000000

  // MOV R1, #0x0403 = two-step: MOV R1, #0x400 then ADD R1, #3
  // 0x400 = 0x01 ROR 22 → rot_imm=11
  w32(pc, armMOVImm(1, 0x01, 11)); pc += 4; // R1 = 0x400
  w32(pc, armADDImm(1, 1, 3)); pc += 4;     // R1 = 0x403

  // STR R1, [R0] → write DISPCNT
  w32(pc, armSTR(1, 0)); pc += 4;

  // MOV R0, #0x05000000 = 0x05 ROR 8 → rot_imm=4
  w32(pc, armMOVImm(0, 0x05, 4)); pc += 4;  // R0 = 0x05000000

  // MOV R1, #0x1F (red in BGR555)
  w32(pc, armMOVImm(1, 0x1F, 0)); pc += 4;  // R1 = 0x1F

  // STRH R1, [R0] → write palette[0] = red
  w32(pc, armSTRH(1, 0)); pc += 4;

  // BX to Thumb code: load address from literal pool
  // LDR R4, [PC, #0] → loads from instrAddr + 8
  const ldrAddr = pc;
  w32(pc, armLDR_PC(4, 0)); pc += 4;  // LDR R4, [PC, #0]
  w32(pc, armBX(4)); pc += 4;          // BX R4

  // Literal pool: at ldrAddr + 8 = the word right after BX
  w32(ldrAddr + 8, 0x08000101);        // Thumb entry (bit 0 set)
  pc = ldrAddr + 12; // skip past literal

  // === Thumb code at 0x08000100 ===
  pc = 0x100;

  // Load VRAM address into R0 via LDR R0, [PC, #N]
  // We'll put the literal pool at a known offset
  // LDR R0, [PC, #20] → addr = ((PC+4) & ~2) + 20
  // At instrAddr=0x100: PC_read = 0x100+4=0x104, (0x104 & ~2) = 0x104
  // addr = 0x104 + 20 = 0x118
  w16(pc, 0x4805); pc += 2;  // LDR R0, [PC, #20]  (imm8=5, offset=5*4=20)

  // MOV R1, #0
  w16(pc, 0x2100); pc += 2;

  // MOV R2, #10
  w16(pc, 0x220A); pc += 2;

  // loop:
  const loopAddr = pc;
  // MOV R3, #0x1F (red color)
  w16(pc, 0x231F); pc += 2;

  // STRH R3, [R0, R1] (format 8)
  // 0101_00_0_RRR_SSS_DDD = STRH Rd, [Rs, Rn]
  // We need STRH R3, [R0, #0] instead. Format 10: STRH Rd, [Rb, #imm5*2]
  // 1000_0_00000_000_011 = STRH R3, [R0, #0]
  w16(pc, 0x8003); pc += 2;  // STRH R3, [R0, #0]

  // ADD R0, #2
  w16(pc, 0x3002); pc += 2;

  // SUBS R2, #1
  w16(pc, 0x3A01); pc += 2;

  // BNE loop
  // offset = (loopAddr - (pc + 4)) / 2
  const brOff = ((loopAddr - (pc + 4)) / 2) & 0xFF;
  w16(pc, 0xD100 | brOff); pc += 2;  // BNE loop

  // hang: B self
  w16(pc, 0xE7FE); pc += 2;

  // Literal pool at 0x118
  w32(0x118, 0x06000000);

  return rom;
}

describe('Thumb Boot Sequence', () => {
  it('should trace ARM setup and Thumb transition', () => {
    const gba = new GBA();
    gba.loadROM(buildThumbTestROM());

    // Trace each instruction
    const trace: string[] = [];
    for (let i = 0; i < 30; i++) {
      const thumb = gba.cpu.rf.flagT;
      const pcVal = thumb
        ? (gba.cpu.rf.regs[15] - 4) >>> 0
        : (gba.cpu.rf.regs[15] - 8) >>> 0;
      const opcode = thumb
        ? gba.mmu.read16(pcVal)
        : gba.mmu.read32(pcVal);

      const regs = `R0=${(gba.cpu.rf.regs[0]>>>0).toString(16)} R1=${(gba.cpu.rf.regs[1]>>>0).toString(16)} R2=${(gba.cpu.rf.regs[2]>>>0).toString(16)} R3=${(gba.cpu.rf.regs[3]>>>0).toString(16)} R4=${(gba.cpu.rf.regs[4]>>>0).toString(16)}`;
      trace.push(
        `${i}: ${thumb?'T':'A'} ${pcVal.toString(16).padStart(8,'0')}: ` +
        `${(opcode>>>0).toString(16).padStart(thumb?4:8,'0')} ${regs} ` +
        `mode=${(gba.cpu.rf.cpsr & 0x1F).toString(16)}`
      );

      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;

      // Stop if we're in a tight loop
      if (i > 20) {
        const newPC = thumb
          ? (gba.cpu.rf.regs[15] - 4) >>> 0
          : (gba.cpu.rf.regs[15] - 8) >>> 0;
        if (newPC === pcVal) {
          trace.push(`  → tight loop detected at ${newPC.toString(16)}`);
          break;
        }
      }
    }

    console.log('Instruction trace:');
    trace.forEach(l => console.log(l));

    // Check DISPCNT was written
    const dispcnt = gba.io.read16(0x000);
    console.log('DISPCNT:', dispcnt.toString(16));

    // Check palette
    const pal0 = gba.mmu.palette16[0];
    console.log('Palette[0]:', pal0.toString(16));

    // Check VRAM
    console.log('VRAM[0:5]:', Array.from(gba.mmu.vram16.slice(0, 5)).map(v => v.toString(16)));

    // Check Thumb mode was reached
    expect(gba.cpu.rf.flagT).toBe(true);
  });
});
