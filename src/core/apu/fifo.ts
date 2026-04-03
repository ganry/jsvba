/**
 * Direct Sound FIFO Channel (A or B)
 *
 * 32-byte circular buffer of 8-bit signed PCM samples.
 * Fed by DMA on timer overflow.
 */
export class SoundFIFO {
  private buffer = new Int8Array(32);
  private readPos = 0;
  private writePos = 0;
  private count = 0;

  /** Current output sample */
  sample = 0;

  /** Write a 32-bit word (4 samples) into the FIFO */
  write32(value: number): void {
    for (let i = 0; i < 4; i++) {
      if (this.count < 32) {
        this.buffer[this.writePos] = (value >> (i * 8)) << 24 >> 24; // Sign extend byte
        this.writePos = (this.writePos + 1) & 31;
        this.count++;
      }
    }
  }

  /** Read the next sample from the FIFO */
  read(): number {
    if (this.count > 0) {
      this.sample = this.buffer[this.readPos];
      this.readPos = (this.readPos + 1) & 31;
      this.count--;
    }
    return this.sample;
  }

  /** Check if FIFO needs refill (less than 16 bytes remaining) */
  get needsRefill(): boolean {
    return this.count < 16;
  }

  get size(): number {
    return this.count;
  }

  reset(): void {
    this.buffer.fill(0);
    this.readPos = 0;
    this.writePos = 0;
    this.count = 0;
    this.sample = 0;
  }
}
