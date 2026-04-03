/**
 * Detailed IRQ flow test: traces the full path through the BIOS IRQ stub
 * to verify real ROM patterns work correctly.
 */
import { describe, it, expect } from 'vitest';
import { GBA } from '../../src/core/gba.js';
import { FRAME_CYCLES, IRQ_VBLANK, SCANLINE_CYCLES, HDRAW_CYCLES, VDRAW_LINES } from '../../src/core/types.js';

describe('IRQ Flow', () => {
  it('should trace VBlankIntrWait through full BIOS IRQ stub', () => {
    const gba = new GBA();
    const rom = new ArrayBuffer(512);
    const view = new DataView(rom);
    const w32 = (off: number, val: number) => view.setUint32(off, val, true);

    // Simple ROM: set up IRQ, call VBlankIntrWait, write marker after
    w32(0x00, 0xEA00002E); // B 0xC0

    let pc = 0xC0;
    // DISPCNT = 0x0403 (Mode 3 + BG2)
    w32(pc, 0xE3A00301); pc += 4; // MOV R0, #0x04000000
    w32(pc, 0xE3A01B01); pc += 4; // MOV R1, #0x400
    w32(pc, 0xE2811003); pc += 4; // ADD R1, R1, #3
    w32(pc, 0xE5801000); pc += 4; // STR R1, [R0]

    // DISPSTAT = 0x0008 (VBlank IRQ enable)
    w32(pc, 0xE3A01008); pc += 4; // MOV R1, #8
    w32(pc, 0xE1C010B4); pc += 4; // STRH R1, [R0, #4]

    // IE = 1 (VBlank)
    w32(pc, 0xE3A01001); pc += 4; // MOV R1, #1
    w32(pc, 0xE2800C02); pc += 4; // ADD R0, R0, #0x200 → 0x04000200
    w32(pc, 0xE1C010B0); pc += 4; // STRH R1, [R0]

    // IME = 1
    w32(pc, 0xE2800008); pc += 4; // ADD R0, R0, #8 → 0x04000208
    w32(pc, 0xE5801000); pc += 4; // STR R1, [R0]

    // SWI #5 (VBlankIntrWait)
    w32(pc, 0xEF050000); pc += 4;

    // After VBlank returns: write marker to IWRAM
    w32(pc, 0xE3A02403); pc += 4; // MOV R2, #0x03000000
    w32(pc, 0xE3A030FF); pc += 4; // MOV R3, #0xFF
    w32(pc, 0xE5823000); pc += 4; // STR R3, [R2]

    // Infinite loop
    w32(pc, 0xEAFFFFFE); pc += 4;

    gba.loadROM(rom);

    // Install IRQ handler at 0x03000100 (ARM code)
    // Handler: read IF, acknowledge, BX LR
    gba.mmu.write32(0x03000100, 0xE3A00301); // MOV R0, #0x04000000
    gba.mmu.write32(0x03000104, 0xE2800C02); // ADD R0, R0, #0x200
    gba.mmu.write32(0x03000108, 0xE5901002); // LDR R1, [R0, #2] (IF)
    gba.mmu.write32(0x0300010C, 0xE5801002); // STR R1, [R0, #2] (acknowledge IF)
    gba.mmu.write32(0x03000110, 0xE12FFF1E); // BX LR

    // Set handler address at 0x03007FFC
    gba.mmu.write32(0x03007FFC, 0x03000100);

    // Step through initialization code
    let traceLog: string[] = [];
    for (let i = 0; i < 50; i++) {
      if (gba.cpu.halted) break;
      const thumb = gba.cpu.rf.flagT;
      const ipc = thumb
        ? (gba.cpu.rf.regs[15] - 4) >>> 0
        : (gba.cpu.rf.regs[15] - 8) >>> 0;
      const opcode = thumb ? gba.mmu.read16(ipc) : gba.mmu.read32(ipc);
      const mode = gba.cpu.rf.cpsr & 0x1F;
      traceLog.push(
        `${i}: ${thumb ? 'T' : 'A'} ${ipc.toString(16).padStart(8, '0')} ` +
        `${(opcode >>> 0).toString(16).padStart(thumb ? 4 : 8, '0')} ` +
        `m=${mode.toString(16)} halted=${gba.cpu.halted}`
      );
      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;
    }

    console.log('=== Init trace ===');
    traceLog.forEach(l => console.log(l));

    // Now the CPU should be halted (VBlankIntrWait)
    console.log('\n=== State after VBlankIntrWait ===');
    console.log('Halted:', gba.cpu.halted);
    console.log('IE:', gba.irq.ie.toString(16));
    console.log('IF:', gba.irq.if_.toString(16));
    console.log('IME:', gba.irq.ime);
    console.log('DISPSTAT:', gba.ppu['dispstat'].toString(16));
    console.log('Handler at 0x03007FFC:', (gba.mmu.read32(0x03007FFC) >>> 0).toString(16));

    expect(gba.cpu.halted).toBe(true);
    expect(gba.irq.ie).toBe(1);
    expect(gba.irq.ime).toBe(1);

    // Fast-forward to VBlank by advancing the scheduler
    // VBlank occurs after 160 scanlines. Each scanline = SCANLINE_CYCLES.
    // We need to advance past the remaining scanlines to reach VBlank.
    const cyclesPerFrame = FRAME_CYCLES;
    const currentCycles = gba.scheduler.cycles;
    console.log('\nCurrent scheduler cycles:', currentCycles);
    console.log('VBlank at cycle:', VDRAW_LINES * SCANLINE_CYCLES);

    // Run cycles until we reach VBlank (or beyond)
    // The CPU is halted, so the main loop will fast-forward through events
    traceLog = [];
    const preRunPC = (gba.cpu.rf.regs[15] - 8) >>> 0;
    console.log('Pre-run PC:', preRunPC.toString(16));

    // Run a full frame - this should process VBlank
    gba.runFrame();

    const postPC = gba.cpu.rf.flagT
      ? (gba.cpu.rf.regs[15] - 4) >>> 0
      : (gba.cpu.rf.regs[15] - 8) >>> 0;

    console.log('\n=== After full frame ===');
    console.log('PC:', postPC.toString(16));
    console.log('Mode:', (gba.cpu.rf.cpsr & 0x1F).toString(16));
    console.log('Halted:', gba.cpu.halted);
    console.log('T flag:', gba.cpu.rf.flagT);
    console.log('I flag:', gba.cpu.rf.flagI);
    console.log('IE:', gba.irq.ie.toString(16));
    console.log('IF:', gba.irq.if_.toString(16));
    console.log('IWRAM marker:', (gba.mmu.read32(0x03000000) >>> 0).toString(16));

    // The marker should have been written (0xFF) if VBlankIntrWait returned
    // If it's still 0, the CPU got stuck
    if (gba.mmu.read32(0x03000000) !== 0xFF) {
      console.log('\n!!! VBlankIntrWait did NOT return !!!');
      console.log('Dumping BIOS IRQ stub area:');
      for (let i = 0; i < 26; i++) {
        const addr = 0x80 + i * 4;
        const val = gba.mmu.read32(addr);
        console.log(`  [${addr.toString(16)}] = ${(val >>> 0).toString(16).padStart(8, '0')}`);
      }
    }

    expect(gba.mmu.read32(0x03000000)).toBe(0xFF);
  });

  it('should correctly execute BIOS IRQ stub step by step', () => {
    const gba = new GBA();
    const rom = new ArrayBuffer(256);
    const view = new DataView(rom);
    view.setUint32(0x00, 0xEAFFFFFE, true); // B self (infinite loop)

    gba.loadROM(rom);

    // Install a simple handler
    gba.mmu.write32(0x03000100, 0xE12FFF1E); // BX LR
    gba.mmu.write32(0x03007FFC, 0x03000100);

    // Enable VBlank IRQ
    gba.irq.ie = 1;
    gba.irq.ime = 1;

    // Request a VBlank IRQ
    gba.irq.requestInterrupt(IRQ_VBLANK);

    console.log('=== Before serviceIRQ ===');
    console.log('PC:', ((gba.cpu.rf.regs[15] - 8) >>> 0).toString(16));
    console.log('Mode:', (gba.cpu.rf.cpsr & 0x1F).toString(16));
    console.log('IE:', gba.irq.ie.toString(16));
    console.log('IF:', gba.irq.if_.toString(16));
    console.log('IME:', gba.irq.ime);
    console.log('flagI:', gba.cpu.rf.flagI);
    console.log('hasPending:', gba.irq.hasPending);

    // Service the IRQ
    gba.irq.serviceIRQ(gba.cpu);

    console.log('\n=== After serviceIRQ ===');
    const pc = (gba.cpu.rf.regs[15] - 8) >>> 0;
    console.log('PC:', pc.toString(16));
    console.log('Mode:', (gba.cpu.rf.cpsr & 0x1F).toString(16));
    console.log('SPSR:', gba.cpu.rf.spsr.toString(16));
    console.log('LR:', (gba.cpu.rf.regs[14] >>> 0).toString(16));
    console.log('SP:', (gba.cpu.rf.regs[13] >>> 0).toString(16));
    console.log('flagI:', gba.cpu.rf.flagI);

    // PC should be at the BIOS stub entry (after pipeline: 0x18 + 8 = 0x20)
    // But after flushPipeline: regs[PC] = 0x18 + 8 = 0x20
    // instrAddr = regs[PC] - 8 = 0x18... wait, after service IRQ, PC = 0x18 + flush = 0x20
    // Actually, serviceIRQ sets regs[PC] = 0x18 then calls flushPipeline
    // flushPipeline: ARM mode, so regs[PC] = (0x18 & ~3) + 8 = 0x20
    // instrAddr = 0x20 - 8 = 0x18 ✓
    expect(pc).toBe(0x18);
    expect(gba.cpu.rf.mode).toBe(0x12); // IRQ mode

    // Now step through the BIOS stub
    console.log('\n=== Stepping through BIOS IRQ stub ===');
    for (let i = 0; i < 30; i++) {
      const thumb = gba.cpu.rf.flagT;
      const ipc = thumb
        ? (gba.cpu.rf.regs[15] - 4) >>> 0
        : (gba.cpu.rf.regs[15] - 8) >>> 0;
      const opcode = thumb ? gba.mmu.read16(ipc) : gba.mmu.read32(ipc);
      const mode = gba.cpu.rf.cpsr & 0x1F;
      const sp = (gba.cpu.rf.regs[13] >>> 0);
      const lr = (gba.cpu.rf.regs[14] >>> 0);
      console.log(
        `${i}: ${thumb ? 'T' : 'A'} ${ipc.toString(16).padStart(8, '0')} ` +
        `${(opcode >>> 0).toString(16).padStart(thumb ? 4 : 8, '0')} ` +
        `m=${mode.toString(16)} sp=${sp.toString(16)} lr=${lr.toString(16)} ` +
        `r0=${(gba.cpu.rf.regs[0] >>> 0).toString(16)} r1=${(gba.cpu.rf.regs[1] >>> 0).toString(16)} ` +
        `r2=${(gba.cpu.rf.regs[2] >>> 0).toString(16)}`
      );

      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;

      // Check for infinite loop or error
      const newPC = thumb
        ? (gba.cpu.rf.regs[15] - 4) >>> 0
        : (gba.cpu.rf.regs[15] - 8) >>> 0;

      // If we returned to the ROM's B self loop (0x08000000), we're done
      if (newPC === 0x08000000 && !thumb) {
        console.log(`→ Returned to ROM at step ${i + 1}`);
        break;
      }
    }

    const finalMode = gba.cpu.rf.cpsr & 0x1F;
    console.log('\n=== After BIOS stub ===');
    console.log('Mode:', finalMode.toString(16));
    console.log('flagI:', gba.cpu.rf.flagI);
    console.log('flagT:', gba.cpu.rf.flagT);

    // Should have returned to the original mode (SYS = 0x1F)
    expect(finalMode).toBe(0x1F);
    expect(gba.cpu.rf.flagI).toBe(false); // IRQs re-enabled
  });

  it('should handle the full VBlank cycle: halt → IRQ → stub → handler → resume', () => {
    const gba = new GBA();
    const rom = new ArrayBuffer(256);
    const view = new DataView(rom);
    view.setUint32(0x00, 0xEAFFFFFE, true); // B self

    gba.loadROM(rom);

    // Set up everything for VBlank IRQ
    // Handler must acknowledge IF, otherwise IRQ keeps re-firing
    let h = 0x03000100;
    gba.mmu.write32(h, 0xE3A00301); h += 4; // MOV R0, #0x04000000
    gba.mmu.write32(h, 0xE2800C02); h += 4; // ADD R0, R0, #0x200
    gba.mmu.write32(h, 0xE3A01001); h += 4; // MOV R1, #1
    gba.mmu.write32(h, 0xE1C010B2); h += 4; // STRH R1, [R0, #2] → IF = 1 (ack VBlank)
    gba.mmu.write32(h, 0xE12FFF1E); h += 4; // BX LR
    gba.mmu.write32(0x03007FFC, 0x03000100);
    gba.irq.ie = 1;
    gba.irq.ime = 1;
    gba.ppu.writeDispstat(0x0008); // Enable VBlank IRQ in DISPSTAT

    // Halt the CPU (as VBlankIntrWait would)
    gba.cpu.halted = true;

    // Run a full frame
    const startPC = (gba.cpu.rf.regs[15] - 8) >>> 0;
    gba.runFrame();

    const endPC = gba.cpu.rf.flagT
      ? (gba.cpu.rf.regs[15] - 4) >>> 0
      : (gba.cpu.rf.regs[15] - 8) >>> 0;

    console.log('Start PC:', startPC.toString(16));
    console.log('End PC:', endPC.toString(16));
    console.log('Halted:', gba.cpu.halted);
    console.log('Mode:', (gba.cpu.rf.cpsr & 0x1F).toString(16));

    // CPU should NOT be halted anymore (VBlank woke it up)
    expect(gba.cpu.halted).toBe(false);
    // Should be back in SYS mode
    expect(gba.cpu.rf.mode).toBe(0x1F);
  });

  it('should verify SWI does not corrupt CPU state', () => {
    const gba = new GBA();
    const rom = new ArrayBuffer(256);
    const view = new DataView(rom);
    view.setUint32(0x00, 0xEA00002E, true); // B 0xC0

    let pc = 0xC0;
    // Set up some known register values
    view.setUint32(pc, 0xE3A04042, true); pc += 4; // MOV R4, #0x42
    view.setUint32(pc, 0xE3A05099, true); pc += 4; // MOV R5, #0x99
    view.setUint32(pc, 0xE3A060FF, true); pc += 4; // MOV R6, #0xFF

    // Call SWI Div (R0/R1)
    view.setUint32(pc, 0xE3A0000A, true); pc += 4; // MOV R0, #10
    view.setUint32(pc, 0xE3A01003, true); pc += 4; // MOV R1, #3
    view.setUint32(pc, 0xEF060000, true); pc += 4; // SWI #6 (Div)

    // After SWI: verify R4-R6 unchanged, check R0,R1,R3
    view.setUint32(pc, 0xEAFFFFFE, true); // B self

    gba.loadROM(rom);

    // Step through
    for (let i = 0; i < 20; i++) {
      if (gba.cpu.halted) break;
      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;
    }

    console.log('After SWI Div(10, 3):');
    console.log('R0 (quotient):', gba.cpu.rf.regs[0]);
    console.log('R1 (remainder):', gba.cpu.rf.regs[1]);
    console.log('R3 (abs quotient):', gba.cpu.rf.regs[3]);
    console.log('R4 (should be 0x42):', gba.cpu.rf.regs[4].toString(16));
    console.log('R5 (should be 0x99):', gba.cpu.rf.regs[5].toString(16));
    console.log('R6 (should be 0xFF):', gba.cpu.rf.regs[6].toString(16));
    console.log('Mode:', (gba.cpu.rf.cpsr & 0x1F).toString(16));

    expect(gba.cpu.rf.regs[0]).toBe(3);    // 10/3 = 3
    expect(gba.cpu.rf.regs[1]).toBe(1);    // 10%3 = 1
    expect(gba.cpu.rf.regs[3]).toBe(3);    // |10/3| = 3
    expect(gba.cpu.rf.regs[4]).toBe(0x42); // preserved
    expect(gba.cpu.rf.regs[5]).toBe(0x99); // preserved
    expect(gba.cpu.rf.regs[6]).toBe(0xFF); // preserved
    expect(gba.cpu.rf.mode).toBe(0x1F);    // still in SYS mode
  });

  it('should verify IO register writes reach the PPU', () => {
    const gba = new GBA();
    const rom = new ArrayBuffer(256);
    const view = new DataView(rom);
    view.setUint32(0x00, 0xEAFFFFFE, true); // B self
    gba.loadROM(rom);

    // Write DISPSTAT via IO
    gba.io.write16(0x004, 0x0038); // Enable VBlank, HBlank, VCount IRQs

    // Read it back through the PPU callback
    const dispstat = gba.io.read16(0x004);
    console.log('DISPSTAT after write 0x0038:', dispstat.toString(16));

    // Only bits 3-5 should be set (bits 0-2 are read-only status)
    expect(dispstat & 0x0038).toBe(0x0038);
    // After reset(), PPU starts at scanline 167 (VBlank), so bit 0 (VBlank status) is set
    expect(dispstat & 0x0001).toBe(1); // VBlank status set (scanline 167 is in VBlank)

    // Write DISPCNT directly
    gba.io.write16(0x000, 0x0403);
    const dispcnt = gba.io.read16(0x000);
    console.log('DISPCNT after write 0x0403:', dispcnt.toString(16));
    expect(dispcnt).toBe(0x0403);

    // Write IE/IF/IME through IO
    gba.io.write16(0x200, 0x0001); // IE = VBlank
    gba.io.write16(0x208, 0x0001); // IME = 1

    expect(gba.irq.ie).toBe(1);
    expect(gba.irq.ime).toBe(1);
  });

  it('should handle ARM LDR/STR with IO registers correctly', () => {
    const gba = new GBA();
    const rom = new ArrayBuffer(512);
    const view = new DataView(rom);
    const w32 = (off: number, val: number) => view.setUint32(off, val, true);

    // Test that STR to IO registers works correctly
    w32(0x00, 0xEA00002E); // B 0xC0

    let pc = 0xC0;
    // MOV R0, #0x04000000
    w32(pc, 0xE3A00301); pc += 4;
    // MOV R1, #0x0403
    w32(pc, 0xE3A01B01); pc += 4; // MOV R1, #0x400
    w32(pc, 0xE2811003); pc += 4; // ADD R1, R1, #3

    // STR R1, [R0] → write 0x0403 to DISPCNT (32-bit write to IO)
    w32(pc, 0xE5801000); pc += 4;

    // Also write DISPSTAT using STRH
    // MOV R1, #0x08
    w32(pc, 0xE3A01008); pc += 4;
    // STRH R1, [R0, #4]
    w32(pc, 0xE1C010B4); pc += 4;

    // Write to IE using STRH
    // ADD R0, R0, #0x200
    w32(pc, 0xE2800C02); pc += 4;
    // MOV R1, #1
    w32(pc, 0xE3A01001); pc += 4;
    // STRH R1, [R0]
    w32(pc, 0xE1C010B0); pc += 4;

    // Write to IME using STR (32-bit)
    // ADD R0, R0, #8
    w32(pc, 0xE2800008); pc += 4;
    // STR R1, [R0]
    w32(pc, 0xE5801000); pc += 4;

    // B self
    w32(pc, 0xEAFFFFFE); pc += 4;

    gba.loadROM(rom);

    // Execute all instructions
    for (let i = 0; i < 20; i++) {
      gba.cpu.step();
      gba.scheduler.tick(gba.cpu.cycles);
      gba.cpu.cycles = 0;
    }

    console.log('DISPCNT:', gba.io.read16(0x000).toString(16));
    console.log('DISPSTAT:', gba.io.read16(0x004).toString(16));
    console.log('IE:', gba.irq.ie.toString(16));
    console.log('IME:', gba.irq.ime);

    expect(gba.io.read16(0x000)).toBe(0x0403);
    expect(gba.irq.ie).toBe(1);
    expect(gba.irq.ime).toBe(1);

    // Now check: does DISPSTAT have bit 3 set?
    const dispstat = gba.io.read16(0x004);
    expect(dispstat & 0x0008).toBe(0x0008);
  });
});
