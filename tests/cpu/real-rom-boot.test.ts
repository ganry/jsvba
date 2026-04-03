/**
 * Real ROM Boot Test
 *
 * This test creates a binary that closely mimics what a real GBA game does
 * during startup, using carefully verified ARM instruction encodings.
 */
import { describe, it, expect } from 'vitest';
import { GBA } from '../../src/core/gba.js';

// ============================================================================
// ARM opcode helpers — produce correct encodings
// ============================================================================

/** ARM B (branch) to an absolute ROM address from a given ROM offset */
function armB(fromOff: number, toOff: number): number {
  // B offset: PC = instrAddr + 8, target = instrAddr + 8 + (offset << 2)
  // offset = (toOff - fromOff - 8) >> 2
  const offset = ((toOff - fromOff - 8) >> 2) & 0x00FFFFFF;
  return (0xEA000000 | offset) >>> 0;
}

/** ARM BNE (branch if not equal) */
function armBNE(fromOff: number, toOff: number): number {
  const offset = ((toOff - fromOff - 8) >> 2) & 0x00FFFFFF;
  return (0x1A000000 | offset) >>> 0;
}

/** ARM MOV Rd, #imm (data processing immediate) */
function armMOV(rd: number, imm32: number): number {
  // Find an 8-bit value and rotation that produces imm32
  for (let rot = 0; rot < 16; rot++) {
    const rotAmt = rot * 2;
    // ROR by rotAmt: value = imm8 ROR rotAmt → imm8 = value ROL rotAmt
    const imm8 = ((imm32 << rotAmt) | (imm32 >>> (32 - rotAmt))) & 0xFF;
    // Verify: ROR(imm8, rotAmt) should give imm32
    const check = rotAmt === 0 ? imm8 : ((imm8 >>> rotAmt) | (imm8 << (32 - rotAmt))) >>> 0;
    if (check === (imm32 >>> 0)) {
      return (0xE3A00000 | (rd << 12) | (rot << 8) | imm8) >>> 0;
    }
  }
  throw new Error(`Cannot encode MOV #${imm32.toString(16)} as immediate`);
}

/** ARM ADD Rd, Rn, #imm */
function armADD(rd: number, rn: number, imm32: number): number {
  for (let rot = 0; rot < 16; rot++) {
    const rotAmt = rot * 2;
    const imm8 = ((imm32 << rotAmt) | (imm32 >>> (32 - rotAmt))) & 0xFF;
    const check = rotAmt === 0 ? imm8 : ((imm8 >>> rotAmt) | (imm8 << (32 - rotAmt))) >>> 0;
    if (check === (imm32 >>> 0)) {
      return (0xE2800000 | (rn << 16) | (rd << 12) | (rot << 8) | imm8) >>> 0;
    }
  }
  throw new Error(`Cannot encode ADD #${imm32.toString(16)} as immediate`);
}

/** ARM SUBS Rd, Rn, #imm (with S bit) */
function armSUBS(rd: number, rn: number, imm32: number): number {
  for (let rot = 0; rot < 16; rot++) {
    const rotAmt = rot * 2;
    const imm8 = ((imm32 << rotAmt) | (imm32 >>> (32 - rotAmt))) & 0xFF;
    const check = rotAmt === 0 ? imm8 : ((imm8 >>> rotAmt) | (imm8 << (32 - rotAmt))) >>> 0;
    if (check === (imm32 >>> 0)) {
      return (0xE2500000 | (rn << 16) | (rd << 12) | (rot << 8) | imm8) >>> 0;
    }
  }
  throw new Error(`Cannot encode SUBS #${imm32.toString(16)}`);
}

/** ARM ORR Rd, Rn, Rm, LSL #imm */
function armORR_LSL(rd: number, rn: number, rm: number, shiftAmt: number): number {
  return (0xE1800000 | (rn << 16) | (rd << 12) | (shiftAmt << 7) | rm) >>> 0;
}

/** ARM MSR CPSR_c, Rn */
function armMSR_c(rn: number): number {
  return (0xE121F000 | rn) >>> 0;
}

/** ARM LDR Rd, [Rn, #offset] */
function armLDR(rd: number, rn: number, offset: number): number {
  if (offset >= 0) {
    return (0xE5900000 | (rn << 16) | (rd << 12) | (offset & 0xFFF)) >>> 0;
  } else {
    return (0xE5100000 | (rn << 16) | (rd << 12) | ((-offset) & 0xFFF)) >>> 0;
  }
}

/** ARM STR Rd, [Rn, #offset] */
function armSTR(rd: number, rn: number, offset: number): number {
  return (0xE5800000 | (rn << 16) | (rd << 12) | (offset & 0xFFF)) >>> 0;
}

/** ARM STR Rd, [Rn], #offset (post-increment) */
function armSTR_post(rd: number, rn: number, offset: number): number {
  return (0xE4800000 | (rn << 16) | (rd << 12) | (offset & 0xFFF)) >>> 0;
}

/** ARM STRH Rd, [Rn, #offset] */
function armSTRH(rd: number, rn: number, offset: number): number {
  const hi = (offset >>> 4) & 0xF;
  const lo = offset & 0xF;
  return (0xE1C000B0 | (rn << 16) | (rd << 12) | (hi << 8) | lo) >>> 0;
}

/** ARM STRH Rd, [Rn], #offset (post-increment) */
function armSTRH_post(rd: number, rn: number, offset: number): number {
  const hi = (offset >>> 4) & 0xF;
  const lo = offset & 0xF;
  return (0xE0C000B0 | (rn << 16) | (rd << 12) | (hi << 8) | lo) >>> 0;
}

/** ARM SWI #n (GBA convention: number in bits [23:16]) */
function armSWI(n: number): number {
  return (0xEF000000 | (n << 16)) >>> 0;
}

/** ARM BX Rn */
function armBX(rn: number): number {
  return (0xE12FFF10 | rn) >>> 0;
}

// Register aliases
const R0 = 0, R1 = 1, R2 = 2, R3 = 3;
const SP = 13, LR = 14, PC = 15;

function buildRealisticROM(): ArrayBuffer {
  const rom = new ArrayBuffer(4096);
  const dv = new DataView(rom);
  const w32 = (off: number, val: number) => dv.setUint32(off, val, true);

  // ===== ROM HEADER =====
  w32(0x00, armB(0x00, 0xC0)); // B 0xC0

  // ===== ENTRY POINT (0xC0) =====
  let pc = 0xC0;

  // --- Mode switching and stack setup ---
  // Switch to IRQ mode (0xD2 = IRQ + I + F), set SP_irq = 0x03007FA0
  w32(pc, armMOV(R0, 0xD2)); pc += 4;
  w32(pc, armMSR_c(R0)); pc += 4;
  w32(pc, armMOV(SP, 0x03000000)); pc += 4;
  w32(pc, armADD(SP, SP, 0x7F00)); pc += 4;
  w32(pc, armADD(SP, SP, 0xA0)); pc += 4;

  // Switch to SVC mode (0xD3), set SP_svc = 0x03007FE0
  w32(pc, armMOV(R0, 0xD3)); pc += 4;
  w32(pc, armMSR_c(R0)); pc += 4;
  w32(pc, armMOV(SP, 0x03000000)); pc += 4;
  w32(pc, armADD(SP, SP, 0x7F00)); pc += 4;
  w32(pc, armADD(SP, SP, 0xE0)); pc += 4;

  // Switch to SYS mode (0x1F), set SP_sys = 0x03007F00
  w32(pc, armMOV(R0, 0x1F)); pc += 4;
  w32(pc, armMSR_c(R0)); pc += 4;
  w32(pc, armMOV(SP, 0x03000000)); pc += 4;
  w32(pc, armADD(SP, SP, 0x7F00)); pc += 4;

  // --- Set up IRQ handler ---
  // Store handler address (0x08000300) at [0x03007FFC]
  w32(pc, armMOV(R1, 0x03000000)); pc += 4;
  w32(pc, armADD(R1, R1, 0x7F00)); pc += 4;
  w32(pc, armADD(R1, R1, 0xFC)); pc += 4;
  // LDR R0, [PC, #offset_to_pool] - need to skip the STR and B instructions
  const ldrHandlerPC = pc;
  w32(pc, 0); pc += 4; // placeholder - will fill after knowing pool offset
  w32(pc, armSTR(R0, R1, 0)); pc += 4; // STR R0, [R1]
  const skipPool1Target = pc + 8; // after B instruction AND literal word
  w32(pc, armB(pc, skipPool1Target)); pc += 4; // B skip_pool
  const pool1Offset = pc;
  w32(pc, 0x08000300); pc += 4; // literal: handler address
  // Now fill in the LDR with correct offset
  const ldrOffset1 = pool1Offset - (ldrHandlerPC + 8);
  dv.setUint32(ldrHandlerPC, armLDR(R0, PC, ldrOffset1), true);

  // --- Set DISPCNT = 0x0080 (forced blank) ---
  pc = skipPool1Target;
  w32(pc, armMOV(R0, 0x04000000)); pc += 4;
  w32(pc, armMOV(R1, 0x80)); pc += 4;
  w32(pc, armSTRH(R1, R0, 0)); pc += 4;

  // --- SWI RegisterRamReset (clear palette + VRAM + OAM) ---
  w32(pc, armMOV(R0, 0x1C)); pc += 4;
  w32(pc, armSWI(0x01)); pc += 4;

  // --- Write palette data ---
  // palette[0] = 0x0000 (black), palette[1] = 0x7C00 (blue)
  w32(pc, armMOV(R0, 0x05000000)); pc += 4;
  w32(pc, armMOV(R1, 0)); pc += 4;
  w32(pc, armSTRH(R1, R0, 0)); pc += 4;

  // Load 0x7C00 from literal pool
  const ldrPalPC = pc;
  w32(pc, 0); pc += 4; // placeholder
  w32(pc, armSTRH(R1, R0, 2)); pc += 4;
  const skipPool2Target = pc + 8; // after B + literal
  w32(pc, armB(pc, skipPool2Target)); pc += 4;
  const pool2Offset = pc;
  w32(pc, 0x00007C00); pc += 4;
  dv.setUint32(ldrPalPC, armLDR(R1, PC, pool2Offset - (ldrPalPC + 8)), true);

  // --- Write VRAM tile data ---
  pc = skipPool2Target;
  // Tile 1 at VRAM offset 0x20 (4bpp tile = 32 bytes)
  w32(pc, armMOV(R0, 0x06000000)); pc += 4;
  w32(pc, armADD(R0, R0, 0x20)); pc += 4;
  // Build 0x11111111 pattern
  w32(pc, armMOV(R1, 0x11)); pc += 4;
  w32(pc, armORR_LSL(R1, R1, R1, 8)); pc += 4;  // ORR R1, R1, R1, LSL #8 → 0x1111
  w32(pc, armORR_LSL(R1, R1, R1, 16)); pc += 4; // ORR R1, R1, R1, LSL #16 → 0x11111111
  // Write 8 words (32 bytes)
  for (let i = 0; i < 8; i++) {
    w32(pc, armSTR_post(R1, R0, 4)); pc += 4;
  }

  // --- Write tilemap ---
  // BG0 map at screen base block 4 = 0x06002000
  w32(pc, armMOV(R0, 0x06000000)); pc += 4;
  w32(pc, armADD(R0, R0, 0x2000)); pc += 4;
  w32(pc, armMOV(R1, 1)); pc += 4; // tile index 1
  w32(pc, armMOV(R2, 30)); pc += 4; // 30 tiles per row
  const tileLoopPC = pc;
  w32(pc, armSTRH_post(R1, R0, 2)); pc += 4;
  w32(pc, armSUBS(R2, R2, 1)); pc += 4;
  w32(pc, armBNE(pc, tileLoopPC)); pc += 4;

  // --- Set BG0CNT ---
  // BG0CNT: screen base block 4 → bits [12:8] = 00100 = 0x0400
  w32(pc, armMOV(R0, 0x04000000)); pc += 4;
  w32(pc, armMOV(R1, 0x400)); pc += 4;
  w32(pc, armSTRH(R1, R0, 8)); pc += 4;

  // --- Enable VBlank IRQ ---
  // DISPSTAT bit 3 = VBlank IRQ enable
  w32(pc, armMOV(R1, 8)); pc += 4;
  w32(pc, armSTRH(R1, R0, 4)); pc += 4;

  // IE = 1 (VBlank)
  w32(pc, armADD(R0, R0, 0x200)); pc += 4;
  w32(pc, armMOV(R1, 1)); pc += 4;
  w32(pc, armSTRH(R1, R0, 0)); pc += 4;

  // IME = 1
  w32(pc, armADD(R0, R0, 8)); pc += 4;
  w32(pc, armSTR(R1, R0, 0)); pc += 4;

  // --- Clear forced blank: DISPCNT = 0x0100 (Mode 0, BG0 enabled) ---
  w32(pc, armMOV(R0, 0x04000000)); pc += 4;
  w32(pc, armMOV(R1, 0x100)); pc += 4;
  w32(pc, armSTRH(R1, R0, 0)); pc += 4;

  // --- Main loop ---
  const mainLoopPC = pc;
  w32(pc, armSWI(0x05)); pc += 4; // VBlankIntrWait
  w32(pc, armB(pc, mainLoopPC)); pc += 4;

  // ===== IRQ HANDLER at 0x300 =====
  pc = 0x300;
  // Acknowledge VBlank: write 1 to IF (0x04000202)
  w32(pc, armMOV(R0, 0x04000000)); pc += 4;
  w32(pc, armADD(R0, R0, 0x200)); pc += 4;
  w32(pc, armMOV(R1, 1)); pc += 4;
  w32(pc, armSTRH(R1, R0, 2)); pc += 4;
  w32(pc, armBX(LR)); pc += 4;

  return rom;
}

describe('Real ROM Boot Simulation', () => {
  it('should execute mode switching and stack setup', () => {
    const gba = new GBA();
    gba.loadROM(buildRealisticROM());
    gba.debugTraceEnabled = false;

    // Step through mode switching
    for (let i = 0; i < 16; i++) {
      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;
    }

    // After 15 instructions: B, 5 IRQ setup, 5 SVC setup, 4 SYS setup
    expect(gba.cpu.rf.mode).toBe(0x1F); // SYS mode
    expect((gba.cpu.rf.regs[13] >>> 0)).toBe(0x03007F00);
  });

  it('should set up IRQ handler correctly', () => {
    const gba = new GBA();
    gba.loadROM(buildRealisticROM());
    gba.debugTraceEnabled = false;

    // Run enough for mode setup + handler setup
    for (let i = 0; i < 25; i++) {
      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;
    }

    const handler = gba.mmu.read32(0x03007FFC);
    expect((handler >>> 0)).toBe(0x08000300);
  });

  it('should write palette and tile data correctly', () => {
    const gba = new GBA();
    gba.loadROM(buildRealisticROM());
    gba.debugTraceEnabled = false;

    // Run until halted
    for (let i = 0; i < 200; i++) {
      if (gba.cpu.halted) break;
      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;
    }

    expect(gba.mmu.read16(0x05000000)).toBe(0x0000); // Black backdrop
    expect(gba.mmu.read16(0x05000002)).toBe(0x7C00); // Blue
    expect((gba.mmu.read32(0x06000020) >>> 0)).toBe(0x11111111); // Tile data
    expect(gba.mmu.read16(0x06002000)).toBe(1); // Tilemap entry
  });

  it('should configure IO registers and halt (VBlankIntrWait)', () => {
    const gba = new GBA();
    gba.loadROM(buildRealisticROM());
    gba.debugTraceEnabled = false;

    for (let i = 0; i < 200; i++) {
      if (gba.cpu.halted) break;
      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;
    }

    expect(gba.io.read16(0x000)).toBe(0x0100); // DISPCNT: Mode 0, BG0
    expect(gba.io.read16(0x008)).toBe(0x0400); // BG0CNT
    expect(gba.irq.ie).toBe(1);
    expect(gba.irq.ime).toBe(1);
    expect(gba.cpu.halted).toBe(true);
  });

  it('should complete a full frame with VBlank IRQ', () => {
    const gba = new GBA();
    gba.loadROM(buildRealisticROM());
    gba.debugTraceEnabled = false;

    gba.runFrame();

    const mode = gba.cpu.rf.cpsr & 0x1F;
    expect(mode).toBe(0x1F); // SYS mode
    expect(gba.io.read16(0x000)).toBe(0x0100); // forced blank off

    // Framebuffer should not be all white
    let whiteCount = 0;
    for (const p of gba.ppu.framebuffer) {
      if (p === 0xFFFFFFFF) whiteCount++;
    }
    expect(whiteCount).toBeLessThan(gba.ppu.framebuffer.length / 2);
  });

  it('should trace full startup for debugging', () => {
    const gba = new GBA();
    gba.loadROM(buildRealisticROM());
    gba.debugTraceEnabled = false;

    const log: string[] = [];
    for (let i = 0; i < 200; i++) {
      const thumb = gba.cpu.rf.flagT;
      const ipc = thumb
        ? (gba.cpu.rf.regs[15] - 4) >>> 0
        : (gba.cpu.rf.regs[15] - 8) >>> 0;
      const opcode = thumb ? gba.mmu.read16(ipc) : gba.mmu.read32(ipc);
      const mode = gba.cpu.rf.cpsr & 0x1F;
      const r = gba.cpu.rf.regs;

      log.push(
        `${String(i).padStart(3)}: ${thumb ? 'T' : 'A'} ` +
        `${ipc.toString(16).padStart(8, '0')} ` +
        `${(opcode >>> 0).toString(16).padStart(thumb ? 4 : 8, '0')} ` +
        `r0=${(r[0]>>>0).toString(16)} r1=${(r[1]>>>0).toString(16)} r2=${(r[2]>>>0).toString(16)} ` +
        `sp=${(r[13]>>>0).toString(16)} m=${mode.toString(16)}` +
        `${gba.cpu.halted ? ' HALT' : ''}`
      );

      if (gba.cpu.halted) break;
      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;
    }

    console.log('\n=== STARTUP TRACE ===');
    log.forEach(l => console.log(l));

    expect(gba.cpu.halted).toBe(true);
  });
});
