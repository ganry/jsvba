import type { InterruptController } from './interrupts.js';
import { IRQ_KEYPAD } from './types.js';

/**
 * GBA Keypad Input
 *
 * KEYINPUT (0x04000130): 10-bit button state, LOW-active (0 = pressed)
 * KEYCNT   (0x04000132): Keypad interrupt control
 */
export class Input {
  /** Internal button state: high-active (1 = pressed) */
  private buttonState = 0;
  private keycnt = 0;

  constructor(private irq: InterruptController) {}

  /** Set a button as pressed (high-active bitmask) */
  press(button: number): void {
    this.buttonState |= button;
    this._checkKeypadIRQ();
  }

  /** Release a button */
  release(button: number): void {
    this.buttonState &= ~button;
  }

  /** Read KEYINPUT register: returns LOW-active 10-bit value */
  readKeyInput(): number {
    return (~this.buttonState) & 0x3FF;
  }

  readKeyCnt(): number {
    return this.keycnt;
  }

  writeKeyCnt(value: number): void {
    this.keycnt = value;
    this._checkKeypadIRQ();
  }

  private _checkKeypadIRQ(): void {
    if (!(this.keycnt & (1 << 14))) return; // IRQ not enabled

    const selectedKeys = this.keycnt & 0x3FF;
    const pressedKeys = this.buttonState & selectedKeys;

    if (this.keycnt & (1 << 15)) {
      // AND mode: all selected keys must be pressed
      if (pressedKeys === selectedKeys && selectedKeys !== 0) {
        this.irq.requestInterrupt(IRQ_KEYPAD);
      }
    } else {
      // OR mode: any selected key pressed
      if (pressedKeys !== 0) {
        this.irq.requestInterrupt(IRQ_KEYPAD);
      }
    }
  }

  reset(): void {
    this.buttonState = 0;
    this.keycnt = 0;
  }
}
