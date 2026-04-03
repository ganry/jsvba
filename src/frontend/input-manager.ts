import type { GBA } from '../core/gba.js';
import {
  KEY_A, KEY_B, KEY_SELECT, KEY_START,
  KEY_RIGHT, KEY_LEFT, KEY_UP, KEY_DOWN,
  KEY_R, KEY_L,
} from '../core/types.js';

export interface KeyMapping {
  [key: string]: number;
}

const DEFAULT_MAPPING: KeyMapping = {
  'KeyX': KEY_A,
  'KeyZ': KEY_B,
  'Backspace': KEY_SELECT,
  'Enter': KEY_START,
  'ArrowRight': KEY_RIGHT,
  'ArrowLeft': KEY_LEFT,
  'ArrowUp': KEY_UP,
  'ArrowDown': KEY_DOWN,
  'KeyS': KEY_R,
  'KeyA': KEY_L,
};

// Friendly names for display
export const BUTTON_NAMES: Record<number, string> = {
  [KEY_A]: 'A',
  [KEY_B]: 'B',
  [KEY_SELECT]: 'Select',
  [KEY_START]: 'Start',
  [KEY_RIGHT]: 'Right',
  [KEY_LEFT]: 'Left',
  [KEY_UP]: 'Up',
  [KEY_DOWN]: 'Down',
  [KEY_R]: 'R',
  [KEY_L]: 'L',
};

export class InputManager {
  private gba: GBA | null = null;
  mapping: KeyMapping;
  private _onRebind: (() => void) | null = null;
  private _rebinding = false;

  /** Set to true when settings panel is open to suppress game input */
  settingsOpen = false;

  constructor() {
    this.mapping = { ...DEFAULT_MAPPING };
    this._loadMapping();
  }

  connect(gba: GBA): void {
    this.gba = gba;
  }

  /** Start listening for keyboard input */
  start(): void {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  stop(): void {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }

  /** Rebind a button. Returns a promise that resolves when user presses a key. */
  rebind(button: number): Promise<string> {
    this._rebinding = true;
    return new Promise((resolve) => {
      const handler = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // Remove old binding for this button
        for (const [key, btn] of Object.entries(this.mapping)) {
          if (btn === button) delete this.mapping[key];
        }

        // Set new binding
        this.mapping[e.code] = button;
        this._saveMapping();
        window.removeEventListener('keydown', handler, true);
        this._rebinding = false;

        if (this._onRebind) this._onRebind();
        resolve(e.code);
      };
      window.addEventListener('keydown', handler, true);
    });
  }

  /** Get the current key bound to a button */
  getKeyForButton(button: number): string {
    for (const [key, btn] of Object.entries(this.mapping)) {
      if (btn === button) return key;
    }
    return '---';
  }

  set onRebind(cb: (() => void) | null) {
    this._onRebind = cb;
  }

  resetToDefaults(): void {
    this.mapping = { ...DEFAULT_MAPPING };
    this._saveMapping();
    if (this._onRebind) this._onRebind();
  }

  private _onKeyDown = (e: KeyboardEvent): void => {
    if (this.settingsOpen || this._rebinding) return;
    const button = this.mapping[e.code];
    if (button !== undefined && this.gba) {
      e.preventDefault();
      this.gba.pressButton(button);
    }
  };

  private _onKeyUp = (e: KeyboardEvent): void => {
    if (this.settingsOpen || this._rebinding) return;
    const button = this.mapping[e.code];
    if (button !== undefined && this.gba) {
      e.preventDefault();
      this.gba.releaseButton(button);
    }
  };

  private _saveMapping(): void {
    try {
      localStorage.setItem('jsvba-keymapping', JSON.stringify(this.mapping));
    } catch { /* ignore */ }
  }

  private _loadMapping(): void {
    try {
      const saved = localStorage.getItem('jsvba-keymapping');
      if (saved) {
        this.mapping = JSON.parse(saved);
      }
    } catch { /* ignore */ }
  }
}
