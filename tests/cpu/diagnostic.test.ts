/**
 * Diagnostic test: loads a minimal test ROM, runs it, and checks output.
 */
import { describe, it, expect } from 'vitest';
import { GBA } from '../../src/core/gba.js';

/**
 * Build a minimal ARM test ROM:
 *   0x00: B entrypoint  (branch over header)
 *   0xC0: entrypoint
 *         MOV R0, #0x04000000      ; I/O base
 *         MOV R1, #0x0400          ; DISPCNT = 0x0403 (Mode 3 + BG2)
 *         ADD R1, R1, #3
 *         STR R1, [R0]             ; write DISPCNT (32-bit, low 16 = 0x0403)
 *         MOV R2, #0x06000000      ; VRAM base
 *         MOV R3, #0               ; color counter
 *         MOV R5, #0x9600          ; 38400 = 240*160
 *   loop:
 *         STRH R3, [R2], #2        ; store color, advance R2
 *         ADD R3, R3, #1           ; next color
 *         SUB R5, R5, #1           ; decrement pixel count
 *         CMP R5, #0
 *         BNE loop
 *   hang:
 *         B hang
 */
function buildTestROM(): ArrayBuffer {
  const rom = new ArrayBuffer(256);
  const view = new DataView(rom);
  const w = (off: number, val: number) => view.setUint32(off, val, true);

  // 0x00: B 0xC0  =>  offset = (0xC0 - 8) / 4 = 0x2E
  w(0x00, 0xEA00002E);

  // Entry point at 0xC0
  let pc = 0xC0;
  w(pc, 0xE3A00301); pc += 4; // MOV R0, #0x04000000
  w(pc, 0xE3A01B01); pc += 4; // MOV R1, #0x400
  w(pc, 0xE2811003); pc += 4; // ADD R1, R1, #3  => R1 = 0x403
  w(pc, 0xE5801000); pc += 4; // STR R1, [R0]    => DISPCNT = 0x0403
  w(pc, 0xE3A02406); pc += 4; // MOV R2, #0x06000000 (0x06 ROR 8)
  w(pc, 0xE3A03000); pc += 4; // MOV R3, #0
  // MOV R5, #0x9600 => need to encode 38400 = 0x9600
  // 0x96 rotated right by 18 (rot_imm=9): 0x96 ROR 18 = 0x96 << 14 = no...
  // Use: MOV R5, #0x96, ROR #24 => 0x96 << 8 = 0x9600
  // rot_imm = 12, imm8 = 0x96 => encoding: cond=E, 001, 1101, S=0, Rn=0, Rd=5, rot=12, imm=0x96
  // = 0xE3A05C96
  w(pc, 0xE3A05C96); pc += 4; // MOV R5, #0x9600

  // loop:
  const loopAddr = pc;
  w(pc, 0xE0C230B2); pc += 4; // STRH R3, [R2], #2 (post-indexed)
  w(pc, 0xE2833001); pc += 4; // ADD R3, R3, #1
  w(pc, 0xE2555001); pc += 4; // SUBS R5, R5, #1
  // BNE loop: offset = (loopAddr - (pc + 8)) / 4
  const offset = ((loopAddr - (pc + 8)) / 4) & 0x00FFFFFF;
  w(pc, 0x1A000000 | offset); pc += 4; // BNE loop

  // hang:
  w(pc, 0xEAFFFFFE); // B hang (branch to self)

  return rom;
}

describe('GBA Diagnostic', () => {
  it('should correctly initialize CPU state after reset', () => {
    const gba = new GBA();
    const rom = buildTestROM();
    gba.loadROM(rom);

    // Check initial CPU state
    expect(gba.cpu.rf.regs[15]).toBe(0x08000008); // PC + 8 after flush
    expect(gba.cpu.rf.regs[13]).toBe(0x03007F00); // SP
    expect(gba.cpu.rf.mode).toBe(0x1F); // System mode
    expect(gba.cpu.rf.flagI).toBe(false); // IRQs enabled
    expect(gba.cpu.halted).toBe(false);
  });

  it('should execute first branch instruction correctly', () => {
    const gba = new GBA();
    const rom = buildTestROM();
    gba.loadROM(rom);

    // First instruction: B 0xC0
    // instrAddr = 0x08000000
    // Opcode at 0x08000000 should be 0xEA00002E
    const opcode = gba.mmu.read32(0x08000000);
    expect(opcode >>> 0).toBe(0xEA00002E); // B to 0xC0

    // Step one instruction
    gba.cpu.step();
    gba.scheduler.tick(gba.cpu.cycles);
    gba.cpu.cycles = 0;

    // After branch to 0x080000C0, PC should be 0x080000C8 (after pipeline flush)
    const newPC = gba.cpu.rf.regs[15];
    const instrAddr = (newPC - 8) >>> 0;
    expect(instrAddr).toBe(0x080000C0);
  });

  it('should set DISPCNT correctly after running setup code', () => {
    const gba = new GBA();
    const rom = buildTestROM();
    gba.loadROM(rom);

    // Run enough instructions to get past setup (branch + 7 setup instructions)
    for (let i = 0; i < 10; i++) {
      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;
    }

    // Check DISPCNT
    const dispcnt = gba.io.read16(0x000); // REG_DISPCNT offset
    expect(dispcnt).toBe(0x0403);

    // R2 may have been incremented by the loop (STRH post-increment +2)
    expect((gba.cpu.rf.regs[2] >>> 0) >= 0x06000000).toBe(true);
  });

  it('should write to VRAM during fill loop', () => {
    const gba = new GBA();
    const rom = buildTestROM();
    gba.loadROM(rom);

    // Run 200 instructions (enough for setup + some loop iterations)
    for (let i = 0; i < 200; i++) {
      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;
    }

    // Check VRAM has been written
    let nonZeroCount = 0;
    for (let i = 0; i < 100; i++) {
      if (gba.mmu.vram16[i] !== 0) nonZeroCount++;
    }
    expect(nonZeroCount).toBeGreaterThan(0);
  });

  it('should produce non-white framebuffer after one frame', () => {
    const gba = new GBA();
    const rom = buildTestROM();
    gba.loadROM(rom);

    // Run one full frame
    gba.runFrame();

    // Check DISPCNT
    const dispcnt = gba.io.read16(0x000);
    console.log('DISPCNT:', dispcnt.toString(16));

    // Check VRAM
    let vramNonZero = 0;
    for (let i = 0; i < 1000; i++) {
      if (gba.mmu.vram16[i] !== 0) vramNonZero++;
    }
    console.log('VRAM non-zero entries (first 1000):', vramNonZero);

    // Check framebuffer
    let fbNonWhite = 0;
    let fbNonBlack = 0;
    for (let i = 0; i < gba.ppu.framebuffer.length; i++) {
      const pixel = gba.ppu.framebuffer[i];
      if (pixel !== 0xFFFFFFFF) fbNonWhite++;
      if (pixel !== 0 && pixel !== 0xFF000000) fbNonBlack++;
    }
    console.log('Framebuffer pixels (240x160):');
    console.log('  Non-white:', fbNonWhite, '/', gba.ppu.framebuffer.length);
    console.log('  Non-black:', fbNonBlack, '/', gba.ppu.framebuffer.length);
    console.log('  First 10 pixels:', Array.from(gba.ppu.framebuffer.slice(0, 10)).map(p => '0x' + (p >>> 0).toString(16).padStart(8, '0')));

    // CPU state
    const pc = (gba.cpu.rf.regs[15] - 8) >>> 0;
    console.log('CPU PC:', pc.toString(16));
    console.log('CPU mode:', gba.cpu.rf.mode.toString(16));
    console.log('CPU halted:', gba.cpu.halted);

    // The framebuffer should not be all white
    expect(fbNonWhite).toBeGreaterThan(0);
  });
});
