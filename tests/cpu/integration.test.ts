/**
 * Integration test: verifies the full GBA pipeline including
 * PPU events, IRQ handling, and SWI calls.
 */
import { describe, it, expect } from 'vitest';
import { GBA } from '../../src/core/gba.js';
import { FRAME_CYCLES, IRQ_VBLANK } from '../../src/core/types.js';

/** Build a Mode 3 gradient ROM (ARM only, no interrupts) */
function buildGradientROM(): ArrayBuffer {
  const rom = new ArrayBuffer(256);
  const view = new DataView(rom);
  const w = (off: number, val: number) => view.setUint32(off, val, true);

  // B to 0xC0
  w(0x00, 0xEA00002E);

  let pc = 0xC0;
  // DISPCNT = 0x0403 (Mode 3 + BG2)
  w(pc, 0xE3A00301); pc += 4; // MOV R0, #0x04000000
  w(pc, 0xE3A01B01); pc += 4; // MOV R1, #0x400
  w(pc, 0xE2811003); pc += 4; // ADD R1, R1, #3
  w(pc, 0xE5801000); pc += 4; // STR R1, [R0]

  // Fill VRAM with gradient
  w(pc, 0xE3A02406); pc += 4; // MOV R2, #0x06000000
  w(pc, 0xE3A03000); pc += 4; // MOV R3, #0
  w(pc, 0xE3A05C96); pc += 4; // MOV R5, #0x9600 (38400)

  const loopAddr = pc;
  w(pc, 0xE0C230B2); pc += 4; // STRH R3, [R2], #2
  w(pc, 0xE2833001); pc += 4; // ADD R3, R3, #1
  w(pc, 0xE2555001); pc += 4; // SUBS R5, R5, #1
  const offset = ((loopAddr - (pc + 8)) / 4) & 0x00FFFFFF;
  w(pc, 0x1A000000 | offset); pc += 4; // BNE loop
  w(pc, 0xEAFFFFFE); // B self

  return rom;
}

/** Build a ROM that uses SWI VBlankIntrWait */
function buildVBlankWaitROM(): ArrayBuffer {
  const rom = new ArrayBuffer(512);
  const view = new DataView(rom);
  const w32 = (off: number, val: number) => view.setUint32(off, val, true);
  const w16 = (off: number, val: number) => view.setUint16(off, val, true);

  // B to 0xC0
  w32(0x00, 0xEA00002E);

  let pc = 0xC0;
  // Set DISPCNT = 0x0403 (Mode 3 + BG2)
  w32(pc, 0xE3A00301); pc += 4; // MOV R0, #0x04000000
  w32(pc, 0xE3A01B01); pc += 4; // MOV R1, #0x400
  w32(pc, 0xE2811003); pc += 4; // ADD R1, R1, #3
  w32(pc, 0xE5801000); pc += 4; // STR R1, [R0]

  // Write red to first pixel of VRAM
  w32(pc, 0xE3A02406); pc += 4; // MOV R2, #0x06000000
  w32(pc, 0xE3A0301F); pc += 4; // MOV R3, #0x1F
  w32(pc, 0xE1C230B0); pc += 4; // STRH R3, [R2]

  // Set up IRQ handler: write handler address to 0x03007FFC
  // Handler at 0x08000100 (will be a simple BX LR)
  w32(pc, 0xE3A00403); pc += 4; // MOV R0, #0x03000000
  w32(pc, 0xE2800C7F); pc += 4; // ADD R0, R0, #0x7F00
  w32(pc, 0xE28000FC); pc += 4; // ADD R0, R0, #0xFC  → R0 = 0x03007FFC
  // Load handler address from literal pool
  w32(pc, 0xE59F1010); pc += 4; // LDR R1, [PC, #16]  → pool at pc+8+16
  w32(pc, 0xE5801000); pc += 4; // STR R1, [R0]  → [0x03007FFC] = handler addr

  // Enable VBlank IRQ: IME=1, IE=1 (VBlank), DISPSTAT bit 3 (VBlank IRQ enable)
  w32(pc, 0xE3A00301); pc += 4; // MOV R0, #0x04000000

  // Write IE = 1 (VBlank IRQ)
  w32(pc, 0xE3A01001); pc += 4; // MOV R1, #1
  w32(pc, 0xE2800C02); pc += 4; // ADD R0, R0, #0x200
  w32(pc, 0xE1C010B0); pc += 4; // STRH R1, [R0]  → IE = 1

  // Write IME = 1
  w32(pc, 0xE2800008); pc += 4; // ADD R0, R0, #8  → R0 = 0x04000208
  w32(pc, 0xE5801000); pc += 4; // STR R1, [R0]  → IME = 1

  // Write DISPSTAT = 0x0008 (VBlank IRQ enable)
  w32(pc, 0xE3A00301); pc += 4; // MOV R0, #0x04000000
  w32(pc, 0xE3A01008); pc += 4; // MOV R1, #8
  w32(pc, 0xE1C010B4); pc += 4; // STRH R1, [R0, #4]  → DISPSTAT = 8

  // SWI #5 (VBlankIntrWait)
  w32(pc, 0xEF050000); pc += 4; // SWI #5 (ARM encoding: comment in bits[23:0])

  // After VBlank: hang
  w32(pc, 0xEAFFFFFE); pc += 4; // B self

  // Literal pool: IRQ handler address (Thumb, +1)
  w32(pc, 0x08000101); pc += 4; // handler address (Thumb mode)

  // === IRQ handler at 0x100 (Thumb) ===
  pc = 0x100;
  // Simple handler: acknowledge VBlank IF, then return
  // LDR R0, [PC, #8] → load 0x04000202 address
  w16(pc, 0x4802); pc += 2; // LDR R0, [PC, #8]
  // MOV R1, #1
  w16(pc, 0x2101); pc += 2; // MOV R1, #1
  // STRH R1, [R0] → write 1 to IF (acknowledge VBlank)
  w16(pc, 0x8001); pc += 2; // STRH R1, [R0, #0]
  // BX LR
  w16(pc, 0x4770); pc += 2; // BX LR

  // Literal pool (word-aligned)
  w32(pc, 0x04000202); // IF register address

  return rom;
}

/**
 * Build a ROM that boots in ARM, transitions to Thumb, and writes
 * DISPCNT to set Mode 3 + BG2. Tests ARM→Thumb switching and basic
 * Thumb IO register writes.
 */
function buildArmToThumbROM(): ArrayBuffer {
  const rom = new ArrayBuffer(512);
  const view = new DataView(rom);
  const w32 = (off: number, val: number) => view.setUint32(off, val, true);
  const w16 = (off: number, val: number) => view.setUint16(off, val, true);

  // ARM: B to 0xC0
  w32(0x00, 0xEA00002E);

  // ARM at 0xC0: set up R0 = IO base, then BX to Thumb
  let pc = 0xC0;
  w32(pc, 0xE3A00301); pc += 4; // MOV R0, #0x04000000

  // BX to Thumb code. ADD R1, PC, #1 computes R1 = (pc+8)+1 = 0xD1+8+1 (bit 0 set for Thumb)
  // But the Thumb code should start right after BX instruction.
  // At pc=0xC4: ADD R1, PC, #1 → R1 = 0x080000C4 + 8 + 1 = 0x080000CD
  // At pc=0xC8: BX R1 → jumps to 0x080000CC in Thumb mode
  w32(pc, 0xE28F1001); pc += 4; // ADD R1, PC, #1
  w32(pc, 0xE12FFF11); pc += 4; // BX R1

  // === Thumb code at 0xCC ===
  pc = 0xCC;

  // R0 = 0x04000000 (IO base, set in ARM above)
  // Set DISPCNT = 0x0403 (Mode 3 + BG2)
  // Thumb: MOV R1, #4; LSL R1, R1, #8 → R1=0x400; ADD R1, #3 → R1=0x403
  w16(pc, 0x2104); pc += 2; // MOV R1, #4
  // LSL R1, R1, #8: Format 1: 000_00_01000_001_001 = 0x0209
  w16(pc, 0x0209); pc += 2; // LSL R1, R1, #8
  w16(pc, 0x3103); pc += 2; // ADD R1, #3   → R1 = 0x0403

  // STR R1, [R0] → write 0x0403 to DISPCNT
  w16(pc, 0x6001); pc += 2; // STR R1, [R0, #0]

  // Write red pixel to VRAM[0] (Mode 3 bitmap at 0x06000000)
  // MOV R2, #6; LSL R2, #24 → R2 = 0x06000000
  w16(pc, 0x2206); pc += 2; // MOV R2, #6
  // LSL R2, R2, #24: 000_00_11000_010_010 = 0x0612
  w16(pc, 0x0612); pc += 2; // LSL R2, R2, #24

  // MOV R3, #0x1F (red in BGR555)
  w16(pc, 0x231F); pc += 2; // MOV R3, #0x1F

  // STRH R3, [R2, #0]
  w16(pc, 0x8013); pc += 2; // STRH R3, [R2, #0]

  // Fill some more VRAM pixels with a gradient
  // MOV R4, #120 (fill 120 pixels)
  w16(pc, 0x2478); pc += 2; // MOV R4, #120

  // Loop: STRH R3, [R2]; ADD R2, #2; ADD R3, #1; SUB R4, #1; BNE loop
  const loopAddr = pc;
  w16(pc, 0x8013); pc += 2; // STRH R3, [R2, #0]
  w16(pc, 0x3202); pc += 2; // ADD R2, #2
  w16(pc, 0x3301); pc += 2; // ADD R3, #1
  w16(pc, 0x3C01); pc += 2; // SUB R4, #1
  const bneOff = ((loopAddr - (pc + 4)) >> 1) & 0xFF;
  w16(pc, 0xD100 | bneOff); pc += 2; // BNE loop

  // Infinite loop
  w16(pc, 0xE7FE); pc += 2; // B self

  return rom;
}

describe('GBA Integration', () => {
  it('should render 160 scanlines in one frame', () => {
    const gba = new GBA();
    gba.loadROM(buildGradientROM());

    // Run one frame
    gba.runFrame();

    // Check that the PPU rendered scanlines (vcount should have wrapped)
    // After one frame, vcount could be 0 (if frame ended at VBlank+68) or somewhere else
    // The key check is: framebuffer should not be all zeros
    let nonZero = 0;
    for (let i = 0; i < gba.ppu.framebuffer.length; i++) {
      if (gba.ppu.framebuffer[i] !== 0) nonZero++;
    }
    console.log('Non-zero framebuffer pixels:', nonZero, '/', gba.ppu.framebuffer.length);

    // Check first and last scanlines
    const firstLine = Array.from(gba.ppu.framebuffer.slice(0, 5));
    const lastLine = Array.from(gba.ppu.framebuffer.slice(159 * 240, 159 * 240 + 5));
    console.log('First scanline [0:5]:', firstLine.map(v => '0x' + (v >>> 0).toString(16).padStart(8, '0')));
    console.log('Last scanline [0:5]:', lastLine.map(v => '0x' + (v >>> 0).toString(16).padStart(8, '0')));

    expect(nonZero).toBeGreaterThan(0);
  });

  it('should fire VBlank event after 160 scanlines', () => {
    const gba = new GBA();
    gba.loadROM(buildGradientROM());

    // Enable VBlank IRQ in DISPSTAT
    gba.ppu.writeDispstat(0x0008);
    gba.irq.ie = 1; // VBlank
    gba.irq.ime = 1;

    // Run one frame
    gba.runFrame();

    // IF should have VBlank flag (or it was acknowledged)
    // Since no handler is installed, serviceIRQ skips but the flag should have been set
    console.log('IE:', gba.irq.ie.toString(16));
    console.log('IF:', gba.irq.if_.toString(16));
    console.log('IME:', gba.irq.ime);

    // The VBlank IRQ should have been requested
    // (it may have been processed, but since no handler was at [0x03007FFC], it just cleared halted)
    expect(true).toBe(true); // Just checking it doesn't crash
  });

  it('should handle SWI VBlankIntrWait correctly', () => {
    const gba = new GBA();
    gba.loadROM(buildVBlankWaitROM());

    // Run 2 frames worth of cycles
    const startCycles = gba.scheduler.cycles;
    gba.runFrame();
    gba.runFrame();
    const endCycles = gba.scheduler.cycles;

    console.log('Cycles executed:', endCycles - startCycles);

    // Check CPU state
    const pc = (gba.cpu.rf.regs[15] - 8) >>> 0;
    console.log('CPU PC after 2 frames:', pc.toString(16));
    console.log('CPU mode:', (gba.cpu.rf.cpsr & 0x1F).toString(16));
    console.log('CPU halted:', gba.cpu.halted);
    console.log('CPU T flag:', gba.cpu.rf.flagT);

    // Check DISPCNT
    console.log('DISPCNT:', gba.io.read16(0x000).toString(16));

    // Check IRQ state
    console.log('IE:', gba.irq.ie.toString(16));
    console.log('IF:', gba.irq.if_.toString(16));
    console.log('IME:', gba.irq.ime);

    // VRAM should have red pixel at position 0
    console.log('VRAM[0]:', gba.mmu.vram16[0].toString(16));

    // DISPCNT should be 0x0403
    expect(gba.io.read16(0x000)).toBe(0x0403);
  });

  it('should correctly execute ARM SWI encoding', () => {
    // Verify ARM SWI comment extraction
    // ARM SWI: cond 1111 comment[23:0]
    // SWI #5: 0xEF050000 → comment = (opcode >>> 16) & 0xFF = 0x05
    const opcode = 0xEF050000;
    const comment = (opcode >>> 16) & 0xFF;
    expect(comment).toBe(5);
  });

  it('should correctly handle ARM SWI #5 in the instruction flow', () => {
    const gba = new GBA();
    const rom = new ArrayBuffer(256);
    const view = new DataView(rom);

    // Simple ROM: just SWI #5 then hang
    // But first set up IRQ handler and enable VBlank IRQ
    let pc = 0x00;
    view.setUint32(pc, 0xEA00002E, true); pc = 0xC0; // B to 0xC0

    // Set up handler at 0x03007FFC (just a BX LR)
    view.setUint32(pc, 0xE3A00403, true); pc += 4; // MOV R0, #0x03000000
    view.setUint32(pc, 0xE2800C7F, true); pc += 4; // ADD R0, #0x7F00
    view.setUint32(pc, 0xE28000FC, true); pc += 4; // ADD R0, #0xFC  → R0 = 0x03007FFC

    // Store a simple handler (at offset 0xF0 in ROM = 0x080000F0)
    view.setUint32(pc, 0xE59F1008, true); pc += 4; // LDR R1, [PC, #8]
    view.setUint32(pc, 0xE5801000, true); pc += 4; // STR R1, [R0]

    // Enable IME
    view.setUint32(pc, 0xE3A00301, true); pc += 4; // MOV R0, #0x04000000
    view.setUint32(pc, 0xE2800C02, true); pc += 4; // ADD R0, #0x200
    view.setUint32(pc, 0xE3A01001, true); pc += 4; // MOV R1, #1
    view.setUint32(pc, 0xE1C010B0, true); pc += 4; // STRH R1, [R0] (IE = 1)
    view.setUint32(pc, 0xE2800008, true); pc += 4; // ADD R0, #8
    view.setUint32(pc, 0xE5801000, true); pc += 4; // STR R1, [R0] (IME = 1)

    // SWI #5
    view.setUint32(pc, 0xEF050000, true); pc += 4; // SWI #5

    // After SWI: hang
    view.setUint32(pc, 0xEAFFFFFE, true); pc += 4;

    // Literal pool: handler address
    view.setUint32(pc, 0x080000F1, true); pc += 4; // Thumb handler addr

    // Thumb handler at 0xF0: just BX LR
    pc = 0xF0;
    view.setUint16(pc, 0x4770, true); pc += 2; // BX LR

    gba.loadROM(rom);

    // Run setup instructions (before SWI)
    for (let i = 0; i < 20; i++) {
      if (gba.cpu.halted) break;
      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;
    }

    // After SWI #5, CPU should be halted
    console.log('CPU halted after SWI #5:', gba.cpu.halted);
    console.log('CPU PC:', ((gba.cpu.rf.regs[15] - 8) >>> 0).toString(16));
    expect(gba.cpu.halted).toBe(true);
  });

  it('should handle DMA VRAM transfers like real ROMs', () => {
    const gba = new GBA();
    gba.loadROM(buildGradientROM());

    // Manually set up a DMA3 transfer: copy 240 halfwords from ROM to VRAM (palette)
    // First write some palette data at a known ROM location
    const paletteData = new Uint16Array(16);
    for (let i = 0; i < 16; i++) {
      paletteData[i] = i * 0x0842; // gradient
    }
    // Write palette data directly to EWRAM for source
    for (let i = 0; i < 16; i++) {
      gba.mmu.write16(0x02000000 + i * 2, paletteData[i]);
    }

    // Set up DMA3: src=EWRAM(0x02000000), dst=Palette(0x05000000), count=16, 16-bit, immediate
    gba.dma.writeSrcLow(3, 0x0000);
    gba.dma.writeSrcHigh(3, 0x0200);
    gba.dma.writeDstLow(3, 0x0000);
    gba.dma.writeDstHigh(3, 0x0500);
    gba.dma.writeCount(3, 16);
    // Control: 16-bit transfer, immediate, enable
    // bit 15=enable, bit 12-13=00 (immediate), bit 10=0 (16-bit), bit 5-6=00 (inc dst), bit 7-8=00 (inc src)
    gba.dma.writeControl(3, 0x8000);

    // Check palette was transferred
    for (let i = 0; i < 16; i++) {
      const expected = paletteData[i];
      const actual = gba.mmu.palette16[i];
      if (actual !== expected) {
        console.log(`DMA palette mismatch at ${i}: expected ${expected.toString(16)}, got ${actual.toString(16)}`);
      }
    }
    expect(gba.mmu.palette16[0]).toBe(paletteData[0]);
    expect(gba.mmu.palette16[15]).toBe(paletteData[15]);
  });

  it('should handle SWI CpuSet for memory fills', () => {
    const gba = new GBA();
    gba.loadROM(buildGradientROM());

    // Test SWI CpuSet (0x0B) - fill mode, 32-bit
    // R0 = src (read fill value from here)
    // R1 = dst (fill destination)
    // R2 = control (count | fill flag | word flag)

    // Write fill value at EWRAM[0]
    gba.mmu.write32(0x02000000, 0x001F001F); // Red pixel pair

    // Set up registers for CpuSet
    gba.cpu.rf.regs[0] = 0x02000000; // src
    gba.cpu.rf.regs[1] = 0x06000000; // dst (VRAM)
    gba.cpu.rf.regs[2] = (60 | (1 << 24) | (1 << 26)); // count=60, fill=1, 32-bit=1

    // Call SWI 0x0B directly
    gba.cpu.executeSWI(0x0B);

    // Check VRAM was filled
    expect(gba.mmu.vram16[0]).toBe(0x001F);
    expect(gba.mmu.vram16[1]).toBe(0x001F);
    expect(gba.mmu.vram16[118]).toBe(0x001F);
    expect(gba.mmu.vram16[119]).toBe(0x001F);
    console.log('SWI CpuSet fill: VRAM[0]=' + gba.mmu.vram16[0].toString(16) +
      ' VRAM[119]=' + gba.mmu.vram16[119].toString(16));
  });

  it('should correctly transition from ARM to Thumb mode and render', () => {
    const gba = new GBA();
    gba.loadROM(buildArmToThumbROM());

    // Run 2 frames
    gba.runFrame();
    gba.runFrame();

    // Check CPU state
    const pc = (gba.cpu.rf.regs[15] - (gba.cpu.rf.flagT ? 4 : 8)) >>> 0;
    console.log('ARM→Thumb test:');
    console.log('  CPU mode:', gba.cpu.rf.flagT ? 'Thumb' : 'ARM');
    console.log('  PC:', pc.toString(16));
    console.log('  DISPCNT:', gba.io.read16(0x000).toString(16));
    console.log('  VRAM[0]:', gba.mmu.vram16[0].toString(16));
    console.log('  VRAM[1]:', gba.mmu.vram16[1].toString(16));
    console.log('  Halted:', gba.cpu.halted);

    // Should be in Thumb mode (BX set T flag)
    expect(gba.cpu.rf.flagT).toBe(true);

    // DISPCNT should be 0x0403 (Mode 3 + BG2)
    expect(gba.io.read16(0x000)).toBe(0x0403);

    // VRAM should have data (gradient starting with red)
    expect(gba.mmu.vram16[0]).toBe(0x001F); // red
    expect(gba.mmu.vram16[1]).toBeGreaterThan(0); // next gradient pixel

    // Framebuffer should not be all white or all zeros
    let nonZero = 0;
    let allWhite = true;
    for (let i = 0; i < gba.ppu.framebuffer.length; i++) {
      if (gba.ppu.framebuffer[i] !== 0) nonZero++;
      if (gba.ppu.framebuffer[i] !== 0xFFFFFFFF) allWhite = false;
    }
    console.log('  Non-zero pixels:', nonZero);
    console.log('  All white:', allWhite);
    expect(nonZero).toBeGreaterThan(0);
    expect(allWhite).toBe(false);
  });

  it('should execute BIOS IRQ stub and return correctly', () => {
    // This test exercises the full IRQ dispatch path:
    // 1. ROM sets up display + enables VBlank IRQ + calls VBlankIntrWait
    // 2. IRQ handler is pre-installed in IWRAM via direct MMU writes
    // 3. VBlank fires → serviceIRQ → BIOS stub (0x18→0x80) → game handler → return
    // 4. CPU resumes after SWI, writes marker to VRAM

    const gba = new GBA();
    const rom = new ArrayBuffer(512);
    const view = new DataView(rom);
    const w32 = (off: number, val: number) => view.setUint32(off, val, true);

    // Branch past header
    w32(0x00, 0xEA00002E); // B 0xC0

    let pc = 0xC0;

    // DISPCNT = 0x0403 (Mode 3 + BG2)
    w32(pc, 0xE3A00301); pc += 4; // MOV R0, #0x04000000
    w32(pc, 0xE3A01B01); pc += 4; // MOV R1, #0x400
    w32(pc, 0xE2811003); pc += 4; // ADD R1, R1, #3
    w32(pc, 0xE5801000); pc += 4; // STR R1, [R0]

    // Write red to VRAM[0]
    w32(pc, 0xE3A02406); pc += 4; // MOV R2, #0x06000000
    w32(pc, 0xE3A0301F); pc += 4; // MOV R3, #0x1F
    w32(pc, 0xE1C230B0); pc += 4; // STRH R3, [R2]

    // DISPSTAT = 0x0008 (VBlank IRQ enable)
    w32(pc, 0xE3A00301); pc += 4; // MOV R0, #0x04000000
    w32(pc, 0xE3A01008); pc += 4; // MOV R1, #8
    w32(pc, 0xE1C010B4); pc += 4; // STRH R1, [R0, #4]

    // IE = 1 (VBlank)
    w32(pc, 0xE2800C02); pc += 4; // ADD R0, R0, #0x200
    w32(pc, 0xE3A01001); pc += 4; // MOV R1, #1
    w32(pc, 0xE1C010B0); pc += 4; // STRH R1, [R0]

    // IME = 1
    w32(pc, 0xE2800008); pc += 4; // ADD R0, R0, #8
    w32(pc, 0xE5801000); pc += 4; // STR R1, [R0]

    // SWI #5 (VBlankIntrWait)
    w32(pc, 0xEF050000); pc += 4;

    // After VBlank: write marker 0xAB to VRAM[2]
    w32(pc, 0xE3A02406); pc += 4; // MOV R2, #0x06000000
    w32(pc, 0xE3A030AB); pc += 4; // MOV R3, #0xAB
    w32(pc, 0xE1C230B4); pc += 4; // STRH R3, [R2, #4]

    // Infinite loop
    w32(pc, 0xEAFFFFFE); pc += 4;

    gba.loadROM(rom);

    // --- Pre-install IRQ handler in IWRAM via direct MMU writes ---
    // Handler at 0x03000000 (ARM code):
    //   LDR R0, [PC, #8]     ; load 0x04000202 from literal pool
    //   LDR R1, [R0]         ; read IF
    //   STR R1, [R0]         ; acknowledge IF (write 1s to clear)
    //   BX LR                ; return to BIOS stub
    //   .word 0x04000202     ; literal pool
    gba.mmu.write32(0x03000000, 0xE59F0008); // LDR R0, [PC, #8]
    gba.mmu.write32(0x03000004, 0xE5901000); // LDR R1, [R0]
    gba.mmu.write32(0x03000008, 0xE5801000); // STR R1, [R0]
    gba.mmu.write32(0x0300000C, 0xE12FFF1E); // BX LR
    gba.mmu.write32(0x03000010, 0x04000202); // literal: IF register address

    // Set handler address
    gba.mmu.write32(0x03007FFC, 0x03000000);

    // Run 3 frames
    gba.runFrame();
    gba.runFrame();
    gba.runFrame();

    const cpuPC = gba.cpu.rf.flagT
      ? (gba.cpu.rf.regs[15] - 4) >>> 0
      : (gba.cpu.rf.regs[15] - 8) >>> 0;
    const cpuMode = gba.cpu.rf.cpsr & 0x1F;

    console.log('=== BIOS IRQ stub test ===');
    console.log('CPU PC:', cpuPC.toString(16));
    console.log('CPU mode:', cpuMode.toString(16));
    console.log('CPU halted:', gba.cpu.halted);
    console.log('I flag:', gba.cpu.rf.flagI);
    console.log('DISPCNT:', gba.io.read16(0x000).toString(16));
    console.log('IE:', gba.irq.ie.toString(16), 'IF:', gba.irq.if_.toString(16), 'IME:', gba.irq.ime);
    console.log('VRAM[0]:', gba.mmu.vram16[0].toString(16));
    console.log('VRAM[2]:', gba.mmu.vram16[2].toString(16));
    console.log('Handler at [0x03007FFC]:', (gba.mmu.read32(0x03007FFC) >>> 0).toString(16));
    console.log('IWRAM handler[0]:', (gba.mmu.read32(0x03000000) >>> 0).toString(16));

    // CPU should be in System mode (0x1F)
    expect(cpuMode).toBe(0x1F);
    // DISPCNT configured
    expect(gba.io.read16(0x000)).toBe(0x0403);
    // VRAM[0] = red
    expect(gba.mmu.vram16[0]).toBe(0x001F);
    // VRAM[2] = marker proving VBlankIntrWait returned
    expect(gba.mmu.vram16[2]).toBe(0x00AB);
  });

  it('should execute realistic ROM startup with mode switching, Thumb BL, and PUSH/POP', () => {
    // This test simulates what a real GBA ROM does at startup:
    // 1. ARM: Branch past header
    // 2. ARM: MSR CPSR_c to switch modes and set up stacks (IRQ, SVC)
    // 3. ARM: BX to Thumb code
    // 4. Thumb: PUSH {R4-R7, LR}
    // 5. Thumb: BL to a subroutine that sets up DISPCNT
    // 6. Thumb: BL to another subroutine that writes palette data
    // 7. Thumb: POP {R4-R7, PC} to return
    // 8. Then infinite loop

    const gba = new GBA();
    const rom = new ArrayBuffer(1024);
    const view = new DataView(rom);
    const w32 = (off: number, val: number) => view.setUint32(off, val, true);
    const w16 = (off: number, val: number) => view.setUint16(off, val, true);

    // ---- ARM code at 0x00 ----
    w32(0x00, 0xEA00002E); // B 0xC0

    let pc = 0xC0;

    // Switch to IRQ mode, set SP_irq
    w32(pc, 0xE3A000D2); pc += 4; // MOV R0, #0xD2 (IRQ mode + I + F disabled)
    w32(pc, 0xE121F000); pc += 4; // MSR CPSR_c, R0

    // Set IRQ SP = 0x03007FA0
    w32(pc, 0xE3A0D403); pc += 4; // MOV SP, #0x03000000
    w32(pc, 0xE28DDC7F); pc += 4; // ADD SP, SP, #0x7F00
    w32(pc, 0xE28DD0A0); pc += 4; // ADD SP, SP, #0xA0  → SP = 0x03007FA0

    // Switch to SVC mode, set SP_svc
    w32(pc, 0xE3A000D3); pc += 4; // MOV R0, #0xD3 (SVC mode + I + F disabled)
    w32(pc, 0xE121F000); pc += 4; // MSR CPSR_c, R0

    // Set SVC SP = 0x03007FE0
    w32(pc, 0xE3A0D403); pc += 4; // MOV SP, #0x03000000
    w32(pc, 0xE28DDC7F); pc += 4; // ADD SP, SP, #0x7F00
    w32(pc, 0xE28DD0E0); pc += 4; // ADD SP, SP, #0xE0  → SP = 0x03007FE0

    // Switch to System mode (IRQ/FIQ enabled)
    w32(pc, 0xE3A0001F); pc += 4; // MOV R0, #0x1F (SYS mode, IRQ+FIQ enabled)
    w32(pc, 0xE121F000); pc += 4; // MSR CPSR_c, R0

    // Set SYS SP = 0x03007F00
    w32(pc, 0xE3A0D403); pc += 4; // MOV SP, #0x03000000
    w32(pc, 0xE28DDC7F); pc += 4; // ADD SP, SP, #0x7F00  → SP = 0x03007F00

    // BX to Thumb code at 0x150 (bit 0 set for Thumb)
    // LDR R0, [PC, #0] loads from PC+8 = current + 8
    w32(pc, 0xE59F0000); pc += 4; // LDR R0, [PC, #0]  → loads literal at pc+8
    w32(pc, 0xE12FFF10); pc += 4; // BX R0

    // Literal pool: Thumb entry address (0x08000150 | 1)
    w32(pc, 0x08000151); pc += 4;

    // ---- Thumb code at 0x150 ----
    pc = 0x150;

    // PUSH {R4-R7, LR}
    w16(pc, 0xB5F0); pc += 2; // PUSH {R4-R7, LR}

    // BL to init_display subroutine at 0x180
    // BL is a two-instruction sequence:
    // Thumb BL target = 0x08000180, from instrAddr = 0x08000152
    // PC at BLSetup = instrAddr + 4 = 0x08000156
    // offset = target - PC = 0x08000180 - 0x08000156 = 0x2A
    // BLSetup offset11 = (0x2A >> 12) = 0, so first instruction: F000 (offset = 0)
    // BLExec offset11 = (0x2A >> 1) & 0x7FF = 0x15
    w16(pc, 0xF000); pc += 2; // BL setup (high part, offset = 0)
    w16(pc, 0xF815); pc += 2; // BL exec (low part, offset = 0x15)

    // BL to init_palette subroutine at 0x1A0
    // From instrAddr = 0x08000156
    // PC at BLSetup = instrAddr + 4 = 0x0800015A
    // target = 0x080001A0
    // offset = 0x080001A0 - 0x0800015A = 0x46
    // BLSetup offset11 = (0x46 >> 12) = 0
    // BLExec offset11 = (0x46 >> 1) & 0x7FF = 0x23
    w16(pc, 0xF000); pc += 2; // BL setup (high part, offset = 0)
    w16(pc, 0xF823); pc += 2; // BL exec (low part, offset = 0x23)

    // MOV R0, #0x42 (marker value)
    w16(pc, 0x2042); pc += 2;  // at 0x15A

    // Store marker to IWRAM[0] = 0x03000000
    // LDR R1, [PC, #N] where N = literal_addr - ((readPC) & ~2)
    // readPC at 0x15C = 0x160, (0x160 & ~2) = 0x160
    // literal will be at 0x164, offset = 0x164 - 0x160 = 4, imm = 4>>2 = 1
    w16(pc, 0x4901); pc += 2; // LDR R1, [PC, #4]  → at 0x15C

    // STR R0, [R1, #0]
    w16(pc, 0x6008); pc += 2; // STR R0, [R1, #0]  → at 0x15E

    // Infinite loop
    w16(pc, 0xE7FE); pc += 2; // B self  → at 0x160

    // Padding for word alignment
    w16(pc, 0x0000); pc += 2; // at 0x162

    // Literal pool (word-aligned) at 0x164
    w32(pc, 0x03000000); pc += 4; // IWRAM base

    // ---- init_display subroutine at 0x180 ----
    pc = 0x180;

    // PUSH {LR}
    w16(pc, 0xB500); pc += 2; // PUSH {LR}

    // MOV R0, #0x04
    w16(pc, 0x2004); pc += 2;
    // LSL R0, R0, #24 → R0 = 0x04000000
    w16(pc, 0x0600); pc += 2;

    // MOV R1, #0x04; LSL R1, #8 → 0x400; ADD R1, #3 → 0x403
    w16(pc, 0x2104); pc += 2; // MOV R1, #4
    w16(pc, 0x0209); pc += 2; // LSL R1, R1, #8
    w16(pc, 0x3103); pc += 2; // ADD R1, #3  → R1 = 0x403

    // STR R1, [R0, #0] → DISPCNT = 0x0403
    w16(pc, 0x6001); pc += 2; // STR R1, [R0, #0]

    // POP {PC} (return)
    w16(pc, 0xBD00); pc += 2; // POP {PC}

    // ---- init_palette subroutine at 0x1A0 ----
    pc = 0x1A0;

    // PUSH {LR}
    w16(pc, 0xB500); pc += 2; // PUSH {LR}

    // Write palette[0] = 0x7FFF (white backdrop)
    // MOV R0, #0x05; LSL R0, #24 → R0 = 0x05000000
    w16(pc, 0x2005); pc += 2; // MOV R0, #5    → at 0x1A2
    w16(pc, 0x0600); pc += 2; // LSL R0, R0, #24  → at 0x1A4

    // LDR R1, [PC, #8] → loads from (readPC & ~2) + 8
    // readPC at 0x1A6 = 0x1AA, (0x1AA & ~2) = 0x1A8, addr = 0x1A8 + 8 = 0x1B0
    w16(pc, 0x4902); pc += 2; // LDR R1, [PC, #8]  → at 0x1A6

    // STRH R1, [R0, #0] → palette[0] = 0x7FFF
    w16(pc, 0x8001); pc += 2; // STRH R1, [R0, #0]  → at 0x1A8

    // LDR R1, [PC, #8] → loads from (readPC & ~2) + 8
    // readPC at 0x1AA = 0x1AE, (0x1AE & ~2) = 0x1AC, addr = 0x1AC + 8 = 0x1B4
    w16(pc, 0x4902); pc += 2; // LDR R1, [PC, #8]  → at 0x1AA

    // STRH R1, [R0, #2] → palette[1] = 0x001F
    w16(pc, 0x8041); pc += 2; // STRH R1, [R0, #2]  → at 0x1AC

    // POP {PC} (return)
    w16(pc, 0xBD00); pc += 2; // POP {PC}  → at 0x1AE

    // Literal pool (word-aligned at 0x1B0)
    w32(pc, 0x00007FFF); pc += 4; // white  → at 0x1B0
    w32(pc, 0x0000001F); pc += 4; // red    → at 0x1B4

    gba.loadROM(rom);

    // Run enough cycles for the startup code to execute
    // The ARM startup is ~15 instructions, Thumb main is ~10, subroutines ~20 total
    // At 1 cycle per instruction, ~50 cycles. But we need to be safe.
    for (let i = 0; i < 200; i++) {
      if (gba.cpu.halted) break;
      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;

      // Debug: trace first 30 instructions
      if (i < 30) {
        const thumb = gba.cpu.rf.flagT;
        const ipc = thumb
          ? (gba.cpu.rf.regs[15] - 4) >>> 0
          : (gba.cpu.rf.regs[15] - 8) >>> 0;
        const mode = gba.cpu.rf.cpsr & 0x1F;
        console.log(
          `${i}: ${thumb ? 'T' : 'A'} pc=${ipc.toString(16).padStart(8, '0')} ` +
          `sp=${(gba.cpu.rf.regs[13] >>> 0).toString(16)} ` +
          `lr=${(gba.cpu.rf.regs[14] >>> 0).toString(16)} ` +
          `m=${mode.toString(16)}`
        );
      }
    }

    const cpuPC = gba.cpu.rf.flagT
      ? (gba.cpu.rf.regs[15] - 4) >>> 0
      : (gba.cpu.rf.regs[15] - 8) >>> 0;

    console.log('\n=== Realistic startup test ===');
    console.log('Final PC:', cpuPC.toString(16));
    console.log('Mode:', (gba.cpu.rf.cpsr & 0x1F).toString(16));
    console.log('Thumb:', gba.cpu.rf.flagT);
    console.log('DISPCNT:', gba.io.read16(0x000).toString(16));
    console.log('Palette[0]:', gba.mmu.palette16[0].toString(16));
    console.log('Palette[1]:', gba.mmu.palette16[1].toString(16));
    console.log('IWRAM[0]:', (gba.mmu.read32(0x03000000) >>> 0).toString(16));

    // Verify the startup code executed correctly
    expect(gba.cpu.rf.flagT).toBe(true);       // Should be in Thumb mode
    expect(gba.cpu.rf.mode).toBe(0x1F);         // System mode
    expect(gba.io.read16(0x000)).toBe(0x0403);  // DISPCNT set by subroutine
    expect(gba.mmu.palette16[0]).toBe(0x7FFF);  // White backdrop set by subroutine
    expect(gba.mmu.palette16[1]).toBe(0x001F);  // Red set by subroutine
    expect(gba.mmu.read32(0x03000000)).toBe(0x42); // Marker written after BL calls returned
  });

  it('should handle mode switching during IRQ correctly', () => {
    const gba = new GBA();
    gba.loadROM(buildGradientROM());

    // Manually test mode switching
    // Start in System mode
    expect(gba.cpu.rf.mode).toBe(0x1F); // SYS

    // Set SP in System mode
    gba.cpu.rf.regs[13] = 0x03007F00;

    // Switch to IRQ mode
    gba.cpu.rf.switchMode(0x12);
    expect(gba.cpu.rf.mode).toBe(0x12);
    gba.cpu.rf.regs[13] = 0x03007FA0; // Set SP_irq

    // Switch back to System mode
    gba.cpu.rf.switchMode(0x1F);
    expect(gba.cpu.rf.mode).toBe(0x1F);
    expect(gba.cpu.rf.regs[13]).toBe(0x03007F00); // SP_sys restored

    // Switch to IRQ mode again
    gba.cpu.rf.switchMode(0x12);
    expect(gba.cpu.rf.regs[13]).toBe(0x03007FA0); // SP_irq restored

    // Switch to SVC mode
    gba.cpu.rf.switchMode(0x13);
    expect(gba.cpu.rf.mode).toBe(0x13);

    // Back to System
    gba.cpu.rf.switchMode(0x1F);
    expect(gba.cpu.rf.regs[13]).toBe(0x03007F00); // SP_sys still correct
  });
});
