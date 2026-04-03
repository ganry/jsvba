import { Scheduler } from './scheduler.js';
import { ARM7TDMI } from './cpu/arm7tdmi.js';
import { buildArmLut } from './cpu/arm.js';
import { buildThumbLut } from './cpu/thumb.js';
import { MMU } from './memory/mmu.js';
import { IORegisters } from './memory/io.js';
import { GamePak } from './memory/gamepak.js';
import { PPU } from './ppu/ppu.js';
import { APU } from './apu/apu.js';
import { InterruptController } from './interrupts.js';
import { DMAController } from './dma.js';
import { TimerController } from './timers.js';
import { Input } from './input.js';
import { FRAME_CYCLES, CPU_FREQ } from './types.js';
import { logWarn, logInfo } from '../utils/logger.js';

/**
 * Top-level GBA system.
 * Owns and connects all subsystems.
 */
export class GBA {
  readonly scheduler = new Scheduler();
  readonly irq = new InterruptController();
  readonly input: Input;
  readonly gamepak = new GamePak();
  readonly dma: DMAController;
  readonly timers: TimerController;
  readonly io: IORegisters;
  readonly mmu: MMU;
  readonly cpu: ARM7TDMI;
  readonly ppu: PPU;
  readonly apu: APU;

  private running = false;
  private animFrameId = 0;
  private lastFrameTime = 0;
  fps = 0;

  /** CPU cycles per millisecond of real time */
  private static readonly CYCLES_PER_MS = CPU_FREQ / 1000;

  /** Enable debug tracing (set via console: app.gba.debugTraceEnabled = true) */
  debugTraceEnabled = false;
  private _debugTraceCount = 0;
  private _debugTraceLimit = 200;

  /** Hang detector state */
  private _hangDetectTimer = 0;
  private _hangDetectLastVBI = 0;
  private _hangDetected = false;

  /** Callback: frame ready to display */
  onFrame: ((framebuffer: Uint32Array) => void) | null = null;

  constructor() {
    // Create subsystems (order matters — dependencies)
    this.input = new Input(this.irq);
    this.dma = new DMAController(this.scheduler, this.irq);
    this.timers = new TimerController(this.scheduler, this.irq);
    this.io = new IORegisters(this.irq, this.input, this.timers, this.dma);
    this.mmu = new MMU(this.gamepak, this.io);
    this.cpu = new ARM7TDMI();
    this.ppu = new PPU(this.scheduler, this.irq, this.dma, this.mmu, this.io);
    this.apu = new APU(this.scheduler, this.dma);

    // Wire up CPU
    this.cpu.setMMU(this.mmu);
    this.cpu.setLUTs(buildArmLut(), buildThumbLut());

    // Wire up DMA bus access and GamePak reference for EEPROM detection
    this.dma.setBus(this.mmu);
    this.dma.setGamePak(this.gamepak);

    // Wire up APU to I/O registers
    this.io.setAPU(this.apu);

    // Wire up HALTCNT → CPU halt
    this.io.haltCallback = () => {
      this.cpu.halted = true;
    };

    // Wire up timer → audio FIFO
    this.timers.setFifoCallback((timerIdx) => {
      this.apu.onTimerOverflow(timerIdx);
    });

    // Wire up PPU frame callback
    this.ppu.onFrameComplete = () => {
      if (this.onFrame) {
        this.onFrame(this.ppu.framebuffer);
      }
    };
  }

  /** Load a ROM file */
  loadROM(data: ArrayBuffer): void {
    this.gamepak.loadROM(data);
    this.reset();

    // Log ROM info (non-destructive)
    console.log(`ROM loaded: "${this.gamepak.title}" (${this.gamepak.gameCode}) ${data.byteLength} bytes, save=${this.gamepak.saveType}`);
  }

  /** Reset all subsystems */
  reset(): void {
    this.scheduler.reset();
    this.cpu.reset();
    this.irq.reset();
    this.input.reset();
    this.dma.reset();
    this.timers.reset();
    this.io.reset();
    this.mmu.reset();
    this.gamepak.reset();
    this.ppu.reset();
    this.apu.reset();

    // Start PPU at mid-VBlank to simulate post-BIOS state.
    // The real GBA BIOS runs for about 1 frame (~287K cycles) before
    // jumping to the ROM. Starting the PPU at scanline 167 gives the game
    // the remaining VBlank period + a full frame to initialize before
    // the first VBlank IRQ fires.
    this.ppu.start(167);
    this.apu.start();
  }

  /** Start emulation */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this._emulationLoop();
  }

  /** Pause emulation */
  pause(): void {
    this.running = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
  }

  /** Toggle play/pause */
  togglePause(): void {
    if (this.running) {
      this.pause();
    } else {
      this.start();
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Run one frame worth of CPU cycles */
  runFrame(): void {
    const targetCycles = this.scheduler.cycles + FRAME_CYCLES;

    while (this.scheduler.cycles < targetCycles) {
      if (this.cpu.halted) {
        // CPU is halted (waiting for interrupt) — fast-forward to next event
        const nextEvent = this.scheduler.nextEventTime;
        if (nextEvent <= targetCycles) {
          this.scheduler.cycles = nextEvent;
          this.scheduler.processEvents();
          // Check if interrupt wakes the CPU
          this.irq.serviceIRQ(this.cpu);
        } else {
          // No event before frame end — skip to end
          this.scheduler.cycles = targetCycles;
        }
        continue;
      }

      // Run CPU until next event
      const nextEvent = this.scheduler.nextEventTime;
      const runUntil = Math.min(nextEvent, targetCycles);

      while (this.scheduler.cycles < runUntil && !this.cpu.halted) {
        if (this.debugTraceEnabled && this._debugTraceCount < this._debugTraceLimit) {
          this._traceStep();
        }

        this.cpu.step();
        this.scheduler.tick(this.cpu.cycles);
        this.cpu.cycles = 0;
      }

      // Process pending events FIRST (e.g. VBlank requests an IRQ)
      if (this.scheduler.cycles >= nextEvent) {
        this.scheduler.processEvents();
      }

      // Then service interrupts (so IRQs requested by events are handled immediately)
      this.irq.serviceIRQ(this.cpu);
    }
  }

  /** Main emulation loop using requestAnimationFrame.
   *  Runs CPU cycles proportional to real elapsed time, so emulation speed
   *  is correct regardless of display refresh rate (60Hz, 120Hz, 144Hz, etc.).
   *  PPU/APU events fire naturally via the scheduler within those cycles. */
  private _emulationLoop(): void {
    if (!this.running) return;

    const now = performance.now();
    const delta = now - this.lastFrameTime;
    this.lastFrameTime = now;

    // Cap delta to ~2 frames to avoid spiral of death after pauses / tab switches
    const clampedDelta = Math.min(delta, 33.4);
    const cyclesToRun = (clampedDelta * GBA.CYCLES_PER_MS) | 0;

    this._runCycles(cyclesToRun);

    // Hang detection: check if VBlankIntrWait hasn't been called recently
    if (now - this._hangDetectTimer > 3000) {
      this._hangDetectTimer = now;
      const currentVBI = this.cpu.vblankIntrWaitCount;
      if (!this._hangDetected && currentVBI === this._hangDetectLastVBI && currentVBI > 0) {
        this._hangDetected = true;
        this._dumpHangDiagnostic();
      }
      this._hangDetectLastVBI = currentVBI;
    }

    this.fps = 1000 / delta;
    this.animFrameId = requestAnimationFrame(() => this._emulationLoop());
  }

  /** Run an arbitrary number of CPU cycles (used by the time-based emulation loop) */
  private _runCycles(cycles: number): void {
    const targetCycles = this.scheduler.cycles + cycles;

    while (this.scheduler.cycles < targetCycles) {
      if (this.cpu.halted) {
        const nextEvent = this.scheduler.nextEventTime;
        if (nextEvent <= targetCycles) {
          this.scheduler.cycles = nextEvent;
          this.scheduler.processEvents();
          this.irq.serviceIRQ(this.cpu);
        } else {
          this.scheduler.cycles = targetCycles;
        }
        continue;
      }

      const nextEvent = this.scheduler.nextEventTime;
      const runUntil = Math.min(nextEvent, targetCycles);

      while (this.scheduler.cycles < runUntil && !this.cpu.halted) {
        if (this.debugTraceEnabled && this._debugTraceCount < this._debugTraceLimit) {
          this._traceStep();
        }

        this.cpu.step();
        this.scheduler.tick(this.cpu.cycles);
        this.cpu.cycles = 0;
      }

      if (this.scheduler.cycles >= nextEvent) {
        this.scheduler.processEvents();
      }

      this.irq.serviceIRQ(this.cpu);
    }
  }

  /** Press a button (high-active bitmask from types.ts KEY_* constants) */
  pressButton(button: number): void {
    this.input.press(button);
  }

  /** Release a button */
  releaseButton(button: number): void {
    this.input.release(button);
  }

  /** Get the game title from ROM header */
  get gameTitle(): string {
    return this.gamepak.title;
  }

  /** Debug: trace N instructions from current PC */
  debugTrace(count: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      const thumb = this.cpu.rf.flagT;
      const pc = thumb
        ? (this.cpu.rf.regs[15] - 4) >>> 0
        : (this.cpu.rf.regs[15] - 8) >>> 0;
      const opcode = thumb
        ? this.mmu.read16(pc)
        : this.mmu.read32(pc);
      const mode = this.cpu.rf.cpsr & 0x1F;
      const flags = (this.cpu.rf.flagN ? 'N' : '-') +
        (this.cpu.rf.flagZ ? 'Z' : '-') +
        (this.cpu.rf.flagC ? 'C' : '-') +
        (this.cpu.rf.flagV ? 'V' : '-');
      lines.push(
        `${thumb ? 'T' : 'A'} ${pc.toString(16).padStart(8, '0')}: ` +
        `${opcode.toString(16).padStart(thumb ? 4 : 8, '0')} ` +
        `[${flags} m=${mode.toString(16)}] ` +
        `SP=${(this.cpu.rf.regs[13] >>> 0).toString(16)} ` +
        `LR=${(this.cpu.rf.regs[14] >>> 0).toString(16)}`
      );
      this.cpu.step();
      this.scheduler.tick(this.cpu.cycles);
      this.cpu.cycles = 0;
    }
    return lines;
  }

  /** Internal trace for runtime debugging */
  private _traceStep(): void {
    const thumb = this.cpu.rf.flagT;
    const pc = thumb
      ? (this.cpu.rf.regs[15] - 4) >>> 0
      : (this.cpu.rf.regs[15] - 8) >>> 0;
    const opcode = thumb
      ? this.mmu.read16(pc)
      : this.mmu.read32(pc);
    const mode = this.cpu.rf.cpsr & 0x1F;
    const r = this.cpu.rf.regs;
    console.log(
      `${this._debugTraceCount}: ${thumb ? 'T' : 'A'} ` +
      `${pc.toString(16).padStart(8, '0')}: ` +
      `${(opcode >>> 0).toString(16).padStart(thumb ? 4 : 8, '0')} ` +
      `r0=${(r[0]>>>0).toString(16)} r1=${(r[1]>>>0).toString(16)} ` +
      `r2=${(r[2]>>>0).toString(16)} r3=${(r[3]>>>0).toString(16)} ` +
      `sp=${(r[13]>>>0).toString(16)} lr=${(r[14]>>>0).toString(16)} ` +
      `m=${mode.toString(16)}`
    );
    this._debugTraceCount++;
    if (this._debugTraceCount === this._debugTraceLimit) {
      console.log('--- trace limit reached ---');
    }
  }

  /** Dump diagnostic info when a hang is detected */
  private _dumpHangDiagnostic(): void {
    const thumb = this.cpu.rf.flagT;
    const pc = thumb
      ? (this.cpu.rf.regs[15] - 4) >>> 0
      : (this.cpu.rf.regs[15] - 8) >>> 0;
    const mode = this.cpu.rf.cpsr & 0x1F;
    const r = this.cpu.rf.regs;

    logWarn('=== HANG DETECTED (no VBlankIntrWait for 3+ seconds) ===');
    logWarn(`CPU: ${thumb ? 'Thumb' : 'ARM'} mode=0x${mode.toString(16)} halted=${this.cpu.halted}`);
    logWarn(`PC=0x${pc.toString(16).padStart(8, '0')} SP=0x${(r[13] >>> 0).toString(16)} LR=0x${(r[14] >>> 0).toString(16)}`);
    logWarn(`Flags: N=${this.cpu.rf.flagN ? 1 : 0} Z=${this.cpu.rf.flagZ ? 1 : 0} C=${this.cpu.rf.flagC ? 1 : 0} V=${this.cpu.rf.flagV ? 1 : 0} I=${this.cpu.rf.flagI ? 1 : 0}`);
    logWarn(`R0-R7: ${Array.from(r.slice(0, 8)).map(v => (v >>> 0).toString(16)).join(' ')}`);
    logWarn(`R8-R12: ${Array.from(r.slice(8, 13)).map(v => (v >>> 0).toString(16)).join(' ')}`);
    logWarn(`IME=${this.irq.ime} IE=0x${this.irq.ie.toString(16)} IF=0x${this.irq.if_.toString(16)}`);
    logWarn(`BIOS IF mirror=0x${(this.mmu.read16(0x03007FF8) >>> 0).toString(16)} Handler=0x${(this.mmu.read32(0x03007FFC) >>> 0).toString(16)}`);
    logWarn(`DISPCNT=0x${this.io.read16(0x000).toString(16).padStart(4, '0')} VCOUNT=${this.ppu.vcount}`);

    // Read a window of instructions around current PC (non-destructive)
    logWarn('--- Instructions at current PC: ---');
    if (thumb) {
      for (let off = -8; off <= 16; off += 2) {
        const a = (pc + off) >>> 0;
        const op = this.mmu.read16(a);
        const marker = off === 0 ? ' >>>' : '    ';
        logWarn(`${marker} ${a.toString(16).padStart(8, '0')}: ${op.toString(16).padStart(4, '0')}`);
      }
    } else {
      for (let off = -8; off <= 16; off += 4) {
        const a = (pc + off) >>> 0;
        const op = this.mmu.read32(a);
        const marker = off === 0 ? ' >>>' : '    ';
        logWarn(`${marker} ${a.toString(16).padStart(8, '0')}: ${(op >>> 0).toString(16).padStart(8, '0')}`);
      }
    }

    logWarn(`waitIrqFlags=${this.cpu.waitIrqFlags} vblankIntrWaitCount=${this.cpu.vblankIntrWaitCount}`);

    // Check if we're in a known function (look at call stack via LR)
    const lr = (r[14] >>> 0);
    logWarn(`Call return address (LR): 0x${lr.toString(16).padStart(8, '0')}`);

    logWarn('=== END HANG DIAGNOSTIC ===');
  }

  /** Get the APU for audio output connection */
  getAPU(): APU {
    return this.apu;
  }

  /** Diagnostic dump — call from console: app.gba.diagnose() */
  diagnose(): void {
    const thumb = this.cpu.rf.flagT;
    const pc = thumb
      ? (this.cpu.rf.regs[15] - 4) >>> 0
      : (this.cpu.rf.regs[15] - 8) >>> 0;
    const mode = this.cpu.rf.cpsr & 0x1F;
    const modeNames: Record<number, string> = {
      0x10: 'USR', 0x11: 'FIQ', 0x12: 'IRQ', 0x13: 'SVC',
      0x17: 'ABT', 0x1B: 'UND', 0x1F: 'SYS'
    };

    logInfo('=== GBA Diagnostic ===');
    logInfo(`CPU: ${thumb ? 'Thumb' : 'ARM'} mode=${modeNames[mode] || mode.toString(16)} halted=${this.cpu.halted}`);
    logInfo(`PC=0x${pc.toString(16).padStart(8, '0')} SP=0x${(this.cpu.rf.regs[13] >>> 0).toString(16)} LR=0x${(this.cpu.rf.regs[14] >>> 0).toString(16)}`);
    logInfo(`Flags: N=${this.cpu.rf.flagN ? 1 : 0} Z=${this.cpu.rf.flagZ ? 1 : 0} C=${this.cpu.rf.flagC ? 1 : 0} V=${this.cpu.rf.flagV ? 1 : 0} I=${this.cpu.rf.flagI ? 1 : 0}`);

    const r = this.cpu.rf.regs;
    logInfo(`R0-R3: ${(r[0]>>>0).toString(16)} ${(r[1]>>>0).toString(16)} ${(r[2]>>>0).toString(16)} ${(r[3]>>>0).toString(16)}`);
    logInfo(`R4-R7: ${(r[4]>>>0).toString(16)} ${(r[5]>>>0).toString(16)} ${(r[6]>>>0).toString(16)} ${(r[7]>>>0).toString(16)}`);
    logInfo(`R8-R12: ${(r[8]>>>0).toString(16)} ${(r[9]>>>0).toString(16)} ${(r[10]>>>0).toString(16)} ${(r[11]>>>0).toString(16)} ${(r[12]>>>0).toString(16)}`);

    logInfo(`DISPCNT=0x${this.io.read16(0x000).toString(16).padStart(4, '0')} (mode=${this.io.read16(0).toString(2).slice(-3)}, forced_blank=${(this.io.read16(0) >>> 7) & 1})`);
    logInfo(`DISPSTAT=0x${this.io.read16(0x004).toString(16).padStart(4, '0')} VCOUNT=${this.ppu.vcount}`);
    logInfo(`BG0CNT=0x${this.io.read16(0x008).toString(16)} BG1CNT=0x${this.io.read16(0x00A).toString(16)} BG2CNT=0x${this.io.read16(0x00C).toString(16)} BG3CNT=0x${this.io.read16(0x00E).toString(16)}`);
    logInfo(`IME=${this.irq.ime} IE=0x${this.irq.ie.toString(16)} IF=0x${this.irq.if_.toString(16)}`);

    logInfo(`Scheduler: cycles=${this.scheduler.cycles} nextEvent=${this.scheduler.nextEventTime}`);

    // Check framebuffer state
    let fb_zero = 0, fb_white = 0, fb_other = 0;
    for (let i = 0; i < this.ppu.framebuffer.length; i++) {
      const p = this.ppu.framebuffer[i];
      if (p === 0) fb_zero++;
      else if (p === 0xFFFFFFFF) fb_white++;
      else fb_other++;
    }
    logInfo(`Framebuffer: black=${fb_zero} white=${fb_white} other=${fb_other} total=${this.ppu.framebuffer.length}`);

    logInfo(`Palette[0-3]: ${this.mmu.palette16[0].toString(16)} ${this.mmu.palette16[1].toString(16)} ${this.mmu.palette16[2].toString(16)} ${this.mmu.palette16[3].toString(16)}`);
    logInfo(`VRAM[0-7]: ${Array.from(this.mmu.vram16.slice(0, 8)).map(v => v.toString(16)).join(' ')}`);
    logInfo(`OAM[0-3]: ${Array.from(this.mmu.oam16.slice(0, 4)).map(v => v.toString(16)).join(' ')}`);

    const handler = this.mmu.read32(0x03007FFC);
    const biosIF = this.mmu.read32(0x03007FF8);
    logInfo(`IRQ handler: 0x${(handler>>>0).toString(16)} BIOS IF mirror: 0x${(biosIF>>>0).toString(16)}`);

    // Check if PC is in a tight loop
    if (!this.cpu.halted) {
      const opcode = thumb ? this.mmu.read16(pc) : this.mmu.read32(pc);
      logInfo(`Current opcode: 0x${(opcode>>>0).toString(16).padStart(thumb ? 4 : 8, '0')}`);
      if (thumb && opcode === 0xE7FE) logInfo('  → Thumb B self (infinite loop)');
      if (!thumb && opcode === 0xEAFFFFFE) logInfo('  → ARM B self (infinite loop)');
    }

    logInfo('=== End Diagnostic ===');
  }
}
