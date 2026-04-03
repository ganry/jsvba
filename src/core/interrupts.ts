import type { ARM7TDMI } from './cpu/arm7tdmi.js';
import { LR, PC } from './cpu/registers.js';
import { MODE_IRQ, CPSR_I } from './types.js';

/**
 * GBA Interrupt Controller
 *
 * Registers:
 *   IME (0x04000208): Master interrupt enable (bit 0)
 *   IE  (0x04000200): Individual interrupt enable mask (14 bits)
 *   IF  (0x04000202): Interrupt request flags (write 1 to acknowledge)
 */
export class InterruptController {
  ime = 0;  // Master enable
  ie = 0;   // Individual enable
  if_ = 0;  // Request flags

  /** Raise an interrupt request */
  requestInterrupt(flag: number): void {
    this.if_ |= flag;
  }

  /** Acknowledge (clear) interrupt flags by writing 1s */
  acknowledge(value: number): void {
    this.if_ &= ~value;
  }

  /** Check if any enabled interrupts are pending */
  get hasPending(): boolean {
    return (this.ime & 1) !== 0 && (this.ie & this.if_) !== 0;
  }

  /** Service a pending IRQ on the CPU */
  serviceIRQ(cpu: ARM7TDMI): void {
    if (!this.hasPending) return;
    if (cpu.rf.flagI) return; // IRQs disabled in CPSR

    // Don't dispatch if no handler is installed
    const handlerAddr = cpu.read32(0x03007FFC);
    if (handlerAddr === 0) {
      cpu.halted = false;
      return;
    }

    const matched = this.ie & this.if_;

    // If IntrWait is active (CPU halted waiting for a specific interrupt),
    // only wake when the waited-for interrupt fires.
    // Non-matching interrupts stay pending in IF for later dispatch.
    if (cpu.waitIrqFlags !== 0 && cpu.halted) {
      if (!(matched & cpu.waitIrqFlags)) {
        return; // Not the interrupt we're waiting for — stay halted
      }
      // Waited interrupt fired — clear wait state
      cpu.waitIrqFlags = 0;
    }

    // Update BIOS IF mirror — the game handler will also OR into this,
    // and IntrWait checks it on return. We set it here so the game
    // handler can see which interrupts fired.
    {
      const biosIF = cpu.read16(0x03007FF8);
      cpu.write16(0x03007FF8, biosIF | matched);
    }

    const oldCpsr = cpu.rf.cpsr;
    const wasThumb = (oldCpsr & (1 << 5)) !== 0;

    cpu.rf.switchMode(MODE_IRQ);
    cpu.rf.spsr = oldCpsr;
    cpu.rf.cpsr |= CPSR_I; // Disable IRQs
    cpu.rf.cpsr &= ~(1 << 5); // Clear T bit (enter ARM state)

    // LR_irq = nextInstrAddr + 4 (return via SUBS PC, LR, #4)
    // Between steps: ARM regs[PC] = nextInstr + 8, Thumb regs[PC] = nextInstr + 4
    if (wasThumb) {
      cpu.rf.regs[LR] = cpu.rf.regs[PC]; // (nextInstr + 4) = nextInstr + 4
    } else {
      cpu.rf.regs[LR] = (cpu.rf.regs[PC] - 4) | 0; // (nextInstr + 8) - 4 = nextInstr + 4
    }

    // Jump to BIOS IRQ vector at 0x18
    // The BIOS stub saves registers, calls game handler at [0x03007FFC],
    // restores registers, and returns via SUBS PC, LR, #4
    cpu.rf.regs[PC] = 0x00000018;
    cpu.flushPipeline();

    cpu.halted = false; // Wake from halt
  }

  reset(): void {
    this.ime = 0;
    this.ie = 0;
    this.if_ = 0;
  }
}
