import type { Scheduler } from './scheduler.js';
import type { InterruptController } from './interrupts.js';
import { TIMER_PRESCALER, IRQ_TIMER0, IRQ_TIMER1, IRQ_TIMER2, IRQ_TIMER3 } from './types.js';

const TIMER_IRQ_FLAGS = [IRQ_TIMER0, IRQ_TIMER1, IRQ_TIMER2, IRQ_TIMER3];

interface Timer {
  counter: number;       // Current counter value (16-bit)
  reload: number;        // Reload value
  control: number;       // Control register
  prescaler: number;     // Prescaler divider (1, 64, 256, 1024)
  enabled: boolean;
  cascade: boolean;      // Count on previous timer overflow
  irqEnable: boolean;
  // Scheduling
  eventId: number;       // Scheduler event ID
  startCycle: number;    // Cycle count when timer was started
}

export class TimerController {
  private timers: Timer[] = [];
  private _onFifoTimer: ((timer: number) => void) | null = null;

  constructor(
    private scheduler: Scheduler,
    private irq: InterruptController,
  ) {
    for (let i = 0; i < 4; i++) {
      this.timers.push({
        counter: 0,
        reload: 0,
        control: 0,
        prescaler: 1,
        enabled: false,
        cascade: false,
        irqEnable: false,
        eventId: -1,
        startCycle: 0,
      });
    }
  }

  /** Set callback for when timer 0 or 1 overflows (for audio FIFO) */
  setFifoCallback(cb: (timer: number) => void): void {
    this._onFifoTimer = cb;
  }

  readCounter(idx: number): number {
    const t = this.timers[idx];
    if (!t.enabled || t.cascade) return t.counter;

    // Calculate current value from elapsed cycles
    const elapsed = this.scheduler.cycles - t.startCycle;
    const ticks = (elapsed / t.prescaler) | 0;
    return (t.counter + ticks) & 0xFFFF;
  }

  writeReload(idx: number, value: number): void {
    this.timers[idx].reload = value & 0xFFFF;
  }

  writeControl(idx: number, value: number): void {
    const t = this.timers[idx];
    const wasEnabled = t.enabled;

    t.control = value;
    t.prescaler = TIMER_PRESCALER[value & 3];
    t.cascade = idx > 0 && (value & (1 << 2)) !== 0;
    t.irqEnable = (value & (1 << 6)) !== 0;
    t.enabled = (value & (1 << 7)) !== 0;

    if (t.eventId >= 0) {
      this.scheduler.cancel(t.eventId);
      t.eventId = -1;
    }

    if (!wasEnabled && t.enabled) {
      // Reload counter on enable rising edge
      t.counter = t.reload;
      t.startCycle = this.scheduler.cycles;

      if (!t.cascade) {
        this._scheduleOverflow(idx);
      }
    } else if (t.enabled && !t.cascade) {
      // Re-sync counter
      t.counter = this.readCounter(idx);
      t.startCycle = this.scheduler.cycles;
      this._scheduleOverflow(idx);
    }
  }

  private _scheduleOverflow(idx: number): void {
    const t = this.timers[idx];
    const ticksUntilOverflow = (0x10000 - t.counter) | 0;
    const cyclesUntilOverflow = ticksUntilOverflow * t.prescaler;

    t.eventId = this.scheduler.schedule(cyclesUntilOverflow, () => {
      this._onOverflow(idx);
    });
  }

  private _onOverflow(idx: number): void {
    const t = this.timers[idx];
    t.counter = t.reload;
    t.startCycle = this.scheduler.cycles;
    t.eventId = -1;

    // Fire IRQ
    if (t.irqEnable) {
      this.irq.requestInterrupt(TIMER_IRQ_FLAGS[idx]);
    }

    // Fire audio FIFO callback for timers 0 and 1
    if (idx <= 1 && this._onFifoTimer) {
      this._onFifoTimer(idx);
    }

    // Cascade to next timer
    if (idx < 3) {
      const next = this.timers[idx + 1];
      if (next.enabled && next.cascade) {
        next.counter = (next.counter + 1) & 0xFFFF;
        if (next.counter === 0) {
          this._onOverflow(idx + 1);
          return;
        }
      }
    }

    // Reschedule if still enabled and not cascade
    if (t.enabled && !t.cascade) {
      this._scheduleOverflow(idx);
    }
  }

  reset(): void {
    for (const t of this.timers) {
      if (t.eventId >= 0) {
        this.scheduler.cancel(t.eventId);
      }
      t.counter = 0;
      t.reload = 0;
      t.control = 0;
      t.prescaler = 1;
      t.enabled = false;
      t.cascade = false;
      t.irqEnable = false;
      t.eventId = -1;
      t.startCycle = 0;
    }
  }
}
