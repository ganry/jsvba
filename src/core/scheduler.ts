/**
 * Event-driven scheduler using a binary min-heap.
 * The CPU runs in a tight loop until the next scheduled event timestamp.
 * Subsystems (PPU, timers, DMA, APU) schedule events at specific cycle counts.
 */

interface ScheduledEvent {
  timestamp: number;
  callback: () => void;
  id: number;
}

export class Scheduler {
  private heap: ScheduledEvent[] = [];
  private nextId = 0;
  cycles = 0;

  get nextEventTime(): number {
    return this.heap.length > 0 ? this.heap[0].timestamp : Infinity;
  }

  schedule(delay: number, callback: () => void): number {
    const id = this.nextId++;
    const event: ScheduledEvent = {
      timestamp: this.cycles + delay,
      callback,
      id,
    };
    this.heap.push(event);
    this._bubbleUp(this.heap.length - 1);
    return id;
  }

  scheduleAt(timestamp: number, callback: () => void): number {
    const id = this.nextId++;
    const event: ScheduledEvent = { timestamp, callback, id };
    this.heap.push(event);
    this._bubbleUp(this.heap.length - 1);
    return id;
  }

  cancel(id: number): void {
    const idx = this.heap.findIndex(e => e.id === id);
    if (idx === -1) return;

    const last = this.heap.pop()!;
    if (idx < this.heap.length) {
      this.heap[idx] = last;
      this._bubbleUp(idx);
      this._sinkDown(idx);
    }
  }

  tick(cycles: number): void {
    this.cycles += cycles;
  }

  processEvents(): void {
    while (this.heap.length > 0 && this.heap[0].timestamp <= this.cycles) {
      const event = this._pop()!;
      event.callback();
    }
  }

  reset(): void {
    this.heap.length = 0;
    this.cycles = 0;
    this.nextId = 0;
  }

  private _pop(): ScheduledEvent | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  private _bubbleUp(idx: number): void {
    const heap = this.heap;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (heap[idx].timestamp >= heap[parent].timestamp) break;
      [heap[idx], heap[parent]] = [heap[parent], heap[idx]];
      idx = parent;
    }
  }

  private _sinkDown(idx: number): void {
    const heap = this.heap;
    const len = heap.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      if (left < len && heap[left].timestamp < heap[smallest].timestamp) {
        smallest = left;
      }
      if (right < len && heap[right].timestamp < heap[smallest].timestamp) {
        smallest = right;
      }
      if (smallest === idx) break;
      [heap[idx], heap[smallest]] = [heap[smallest], heap[idx]];
      idx = smallest;
    }
  }
}
