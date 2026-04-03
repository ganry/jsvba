import type { GBA } from '../core/gba.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../core/types.js';

export interface SaveSlot {
  id: number;
  timestamp: number;
  title: string;
  thumbnail: string; // data URL
}

const MAX_SLOTS = 4;
const STORAGE_PREFIX = 'jsvba-save-';

/**
 * Save State Manager
 * Stores emulator snapshots to localStorage (or IndexedDB in future).
 */
export class SaveStateManager {
  private gba: GBA | null = null;
  private slots: (SaveSlot | null)[] = new Array(MAX_SLOTS).fill(null);

  connect(gba: GBA): void {
    this.gba = gba;
    this._loadSlotInfo();
  }

  /** Save current state to a slot (0-3) */
  async saveState(slotId: number): Promise<SaveSlot | null> {
    if (!this.gba || slotId < 0 || slotId >= MAX_SLOTS) return null;

    // Create thumbnail from current framebuffer
    const thumbnail = this._createThumbnail();

    const slot: SaveSlot = {
      id: slotId,
      timestamp: Date.now(),
      title: this.gba.gameTitle || 'Unknown',
      thumbnail,
    };

    // Save game SRAM/Flash data
    const saveData = this.gba.gamepak.getSaveData();
    if (saveData) {
      try {
        const key = `${STORAGE_PREFIX}${this.gba.gameTitle}-slot${slotId}-save`;
        localStorage.setItem(key, this._arrayToBase64(saveData));
      } catch { /* storage full */ }
    }

    this.slots[slotId] = slot;
    this._saveSlotInfo();
    return slot;
  }

  /** Load state from a slot */
  async loadState(slotId: number): Promise<boolean> {
    if (!this.gba || slotId < 0 || slotId >= MAX_SLOTS) return false;
    const slot = this.slots[slotId];
    if (!slot) return false;

    // Restore save data
    try {
      const key = `${STORAGE_PREFIX}${this.gba.gameTitle}-slot${slotId}-save`;
      const data = localStorage.getItem(key);
      if (data) {
        const saveData = this._base64ToArray(data);
        this.gba.gamepak.loadSaveData(saveData);
      }
    } catch { /* ignore */ }

    return true;
  }

  /** Get info about all save slots */
  getSlots(): (SaveSlot | null)[] {
    return [...this.slots];
  }

  private _createThumbnail(): string {
    if (!this.gba) return '';

    const canvas = document.createElement('canvas');
    canvas.width = SCREEN_WIDTH;
    canvas.height = SCREEN_HEIGHT;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    new Uint32Array(imageData.data.buffer).set(this.gba.ppu.framebuffer);
    ctx.putImageData(imageData, 0, 0);

    // Scale down for storage
    const thumb = document.createElement('canvas');
    thumb.width = 80;
    thumb.height = 53;
    const tCtx = thumb.getContext('2d')!;
    tCtx.drawImage(canvas, 0, 0, 80, 53);

    return thumb.toDataURL('image/png');
  }

  private _saveSlotInfo(): void {
    try {
      const key = `${STORAGE_PREFIX}slots`;
      localStorage.setItem(key, JSON.stringify(this.slots));
    } catch { /* ignore */ }
  }

  private _loadSlotInfo(): void {
    try {
      const key = `${STORAGE_PREFIX}slots`;
      const data = localStorage.getItem(key);
      if (data) {
        this.slots = JSON.parse(data);
      }
    } catch { /* ignore */ }
  }

  private _arrayToBase64(arr: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < arr.length; i++) {
      binary += String.fromCharCode(arr[i]);
    }
    return btoa(binary);
  }

  private _base64ToArray(base64: string): Uint8Array {
    const binary = atob(base64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      arr[i] = binary.charCodeAt(i);
    }
    return arr;
  }
}
