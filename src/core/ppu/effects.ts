/**
 * PPU Special Effects — Windows, Alpha Blending, Brightness
 *
 * Window priority: WIN0 > WIN1 > OBJWIN > Outside
 * Each pixel gets a 6-bit mask: bits 0-4 = BG0-BG3/OBJ visibility, bit 5 = effects enable.
 */

import type { IORegisters } from '../memory/io.js';
import {
  SCREEN_WIDTH,
  REG_DISPCNT,
  REG_WIN0H, REG_WIN1H, REG_WIN0V, REG_WIN1V,
  REG_WININ, REG_WINOUT,
  DISPCNT_WIN0, DISPCNT_WIN1, DISPCNT_OBJWIN,
} from '../types.js';

/**
 * Compute per-pixel window mask for a scanline.
 * Each byte: bits 0-4 = BG0-BG3, OBJ visibility; bit 5 = effects enable.
 * If no windows are active in DISPCNT, all pixels get 0x3F (everything visible + effects).
 */
export function computeWindowMask(
  mask: Uint8Array,
  scanline: number,
  io: IORegisters,
  objWindowLine: Uint8Array | null,
): void {
  const dispcnt = io.read16(REG_DISPCNT);
  const win0 = (dispcnt & DISPCNT_WIN0) !== 0;
  const win1 = (dispcnt & DISPCNT_WIN1) !== 0;
  const objWin = (dispcnt & DISPCNT_OBJWIN) !== 0;

  // No windows enabled → everything visible with effects
  if (!win0 && !win1 && !objWin) {
    mask.fill(0x3F);
    return;
  }

  const winin = io.read16(REG_WININ);
  const winout = io.read16(REG_WINOUT);
  const win0Flags = winin & 0x3F;
  const win1Flags = (winin >>> 8) & 0x3F;
  const outsideFlags = winout & 0x3F;
  const objWinFlags = (winout >>> 8) & 0x3F;

  // Start with outside-window flags
  mask.fill(outsideFlags);

  // Apply OBJ window (lowest priority window)
  if (objWin && objWindowLine) {
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      if (objWindowLine[x]) mask[x] = objWinFlags;
    }
  }

  // Apply WIN1 (overrides OBJ window and outside)
  if (win1) {
    const v = io.read16(REG_WIN1V);
    const y1 = (v >>> 8) & 0xFF;
    const y2 = v & 0xFF;
    const active = y2 > y1
      ? (scanline >= y1 && scanline < y2)
      : (y2 < y1 && (scanline >= y1 || scanline < y2));
    if (active) {
      const h = io.read16(REG_WIN1H);
      _fillWindow(mask, (h >>> 8) & 0xFF, h & 0xFF, win1Flags);
    }
  }

  // Apply WIN0 (highest priority, overrides everything)
  if (win0) {
    const v = io.read16(REG_WIN0V);
    const y1 = (v >>> 8) & 0xFF;
    const y2 = v & 0xFF;
    const active = y2 > y1
      ? (scanline >= y1 && scanline < y2)
      : (y2 < y1 && (scanline >= y1 || scanline < y2));
    if (active) {
      const h = io.read16(REG_WIN0H);
      _fillWindow(mask, (h >>> 8) & 0xFF, h & 0xFF, win0Flags);
    }
  }
}

function _fillWindow(mask: Uint8Array, x1: number, x2: number, flags: number): void {
  if (x2 > x1) {
    // Normal range
    const end = x2 > SCREEN_WIDTH ? SCREEN_WIDTH : x2;
    for (let x = x1; x < end; x++) mask[x] = flags;
  } else if (x2 < x1) {
    // Wrapping: 0..x2-1 and x1..239
    const end = x2 > SCREEN_WIDTH ? SCREEN_WIDTH : x2;
    for (let x = 0; x < end; x++) mask[x] = flags;
    for (let x = x1; x < SCREEN_WIDTH; x++) mask[x] = flags;
  }
  // x1 === x2: empty window, do nothing
}

/** Alpha blend two RGBA8888 colors with EVA/EVB coefficients (0-16). */
export function alphaBlend(topColor: number, botColor: number, eva: number, evb: number): number {
  const tr = topColor & 0xFF;
  const tg = (topColor >>> 8) & 0xFF;
  const tb = (topColor >>> 16) & 0xFF;
  const br = botColor & 0xFF;
  const bg = (botColor >>> 8) & 0xFF;
  const bb = (botColor >>> 16) & 0xFF;

  let r = (tr * eva + br * evb) >> 4;
  let g = (tg * eva + bg * evb) >> 4;
  let b = (tb * eva + bb * evb) >> 4;
  if (r > 255) r = 255;
  if (g > 255) g = 255;
  if (b > 255) b = 255;

  return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
}

/** Increase brightness of an RGBA8888 color by EVY (0-16). */
export function brighten(color: number, evy: number): number {
  const r = color & 0xFF;
  const g = (color >>> 8) & 0xFF;
  const b = (color >>> 16) & 0xFF;

  return (0xFF000000 |
    (((b + (((255 - b) * evy) >> 4)) & 0xFF) << 16) |
    (((g + (((255 - g) * evy) >> 4)) & 0xFF) << 8) |
    ((r + (((255 - r) * evy) >> 4)) & 0xFF)
  ) >>> 0;
}

/** Decrease brightness of an RGBA8888 color by EVY (0-16). */
export function darken(color: number, evy: number): number {
  const r = color & 0xFF;
  const g = (color >>> 8) & 0xFF;
  const b = (color >>> 16) & 0xFF;

  return (0xFF000000 |
    (((b - ((b * evy) >> 4)) & 0xFF) << 16) |
    (((g - ((g * evy) >> 4)) & 0xFF) << 8) |
    ((r - ((r * evy) >> 4)) & 0xFF)
  ) >>> 0;
}
