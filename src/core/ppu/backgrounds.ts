import type { MMU } from '../memory/mmu.js';
import type { IORegisters } from '../memory/io.js';
import { getColorLUT } from './palette.js';
import {
  SCREEN_WIDTH,
  REG_DISPCNT, REG_BG0CNT, REG_BG0HOFS, REG_BG0VOFS,
  REG_BG2PA, REG_BG2PB, REG_BG2PC, REG_BG2PD, REG_BG2X, REG_BG2Y,
  REG_BG3PA, REG_BG3PB, REG_BG3PC, REG_BG3PD, REG_BG3X, REG_BG3Y,
  DISPCNT_FRAME_SELECT,
} from '../types.js';

const colorLUT = getColorLUT();

// Screen size lookup for text BGs (bits [15:14] of BGxCNT)
const TEXT_SCREEN_SIZES: readonly [number, number][] = [
  [256, 256], [512, 256], [256, 512], [512, 512],
];

// Tile map base offsets (bits [12:8] >> 8 of BGxCNT * 0x800)
// Character base (bits [3:2] >> 2 of BGxCNT * 0x4000)

/**
 * Render one scanline of a text-mode background (Mode 0/1).
 */
export function renderTextBG(
  line: Uint32Array,
  priorities: Uint8Array,
  bgIndex: number,
  scanline: number,
  mmu: MMU,
  io: IORegisters,
): void {
  const bgcntOffset = REG_BG0CNT + bgIndex * 2;
  const bgcnt = io.read16(bgcntOffset);

  const priority = bgcnt & 3;
  const charBase = ((bgcnt >>> 2) & 3) * 0x4000;
  const mosaic = (bgcnt >>> 6) & 1;
  const is256Color = (bgcnt >>> 7) & 1;
  const screenBase = ((bgcnt >>> 8) & 0x1F) * 0x800;
  const screenSize = (bgcnt >>> 14) & 3;
  const [screenW, screenH] = TEXT_SCREEN_SIZES[screenSize];

  const hofsOffset = REG_BG0HOFS + bgIndex * 4;
  const vofsOffset = REG_BG0VOFS + bgIndex * 4;
  const hofs = io.read16(hofsOffset) & 0x1FF;
  const vofs = io.read16(vofsOffset) & 0x1FF;

  const py = (scanline + vofs) % screenH;
  const tileRow = (py >>> 3);
  const pixelY = py & 7;

  for (let x = 0; x < SCREEN_WIDTH; x++) {
    const px = (x + hofs) % screenW;
    const tileCol = (px >>> 3);
    const pixelX = px & 7;

    // Determine which screen block we're in (for multi-screen BGs)
    let screenBlockOffset = screenBase;
    if (screenW === 512 && tileCol >= 32) {
      screenBlockOffset += 0x800;
    }
    if (screenH === 512 && tileRow >= 32) {
      screenBlockOffset += screenW === 512 ? 0x1000 : 0x800;
    }

    const mapAddr = screenBlockOffset + ((tileRow & 31) * 32 + (tileCol & 31)) * 2;
    const mapEntry = mmu.vram16[mapAddr >>> 1];

    const tileNum = mapEntry & 0x3FF;
    const hFlip = (mapEntry >>> 10) & 1;
    const vFlip = (mapEntry >>> 11) & 1;
    const palBank = (mapEntry >>> 12) & 0xF;

    const finalPixelX = hFlip ? (7 - pixelX) : pixelX;
    const finalPixelY = vFlip ? (7 - pixelY) : pixelY;

    let colorIdx: number;

    if (is256Color) {
      // 256-color mode: 1 byte per pixel, 64 bytes per tile
      const tileAddr = charBase + tileNum * 64 + finalPixelY * 8 + finalPixelX;
      colorIdx = mmu.vram8[tileAddr];
    } else {
      // 16-color mode: 4 bits per pixel, 32 bytes per tile
      const tileAddr = charBase + tileNum * 32 + finalPixelY * 4 + (finalPixelX >>> 1);
      const byte = mmu.vram8[tileAddr];
      colorIdx = (finalPixelX & 1) ? (byte >>> 4) : (byte & 0xF);
      if (colorIdx !== 0) {
        colorIdx += palBank * 16;
      }
    }

    if (colorIdx !== 0) {
      const bgr = mmu.palette16[colorIdx];
      line[x] = colorLUT[bgr & 0x7FFF];
      priorities[x] = priority;
    }
  }
}

/**
 * Render one scanline of an affine background (Mode 1/2).
 */
export function renderAffineBG(
  line: Uint32Array,
  priorities: Uint8Array,
  bgIndex: number,
  scanline: number,
  mmu: MMU,
  io: IORegisters,
  refX: number,
  refY: number,
): [number, number] {
  const bgcntOffset = REG_BG0CNT + bgIndex * 2;
  const bgcnt = io.read16(bgcntOffset);

  const priority = bgcnt & 3;
  const charBase = ((bgcnt >>> 2) & 3) * 0x4000;
  const screenBase = ((bgcnt >>> 8) & 0x1F) * 0x800;
  const wrap = (bgcnt >>> 13) & 1;
  const sizeIdx = (bgcnt >>> 14) & 3;
  const size = [128, 256, 512, 1024][sizeIdx];

  // Affine parameters: PA=dx/pixel, PB=dx/scanline, PC=dy/pixel, PD=dy/scanline
  const paOffset = bgIndex === 2 ? REG_BG2PA : REG_BG3PA;
  const pcOffset = bgIndex === 2 ? REG_BG2PC : REG_BG3PC;
  const pa = (io.read16(paOffset) << 16 >> 16); // signed
  const pb = (io.read16(paOffset + 2) << 16 >> 16);
  const pc = (io.read16(pcOffset) << 16 >> 16);
  const pd = (io.read16(pcOffset + 2) << 16 >> 16);

  let cx = refX;
  let cy = refY;

  for (let x = 0; x < SCREEN_WIDTH; x++) {
    let texX = cx >> 8;
    let texY = cy >> 8;

    if (wrap) {
      texX = ((texX % size) + size) % size;
      texY = ((texY % size) + size) % size;
    }

    if (texX >= 0 && texX < size && texY >= 0 && texY < size) {
      const tileCol = texX >>> 3;
      const tileRow = texY >>> 3;
      const tilesPerRow = size >>> 3;

      const mapAddr = screenBase + tileRow * tilesPerRow + tileCol;
      const tileNum = mmu.vram8[mapAddr];

      const pixelX = texX & 7;
      const pixelY = texY & 7;
      const tileAddr = charBase + tileNum * 64 + pixelY * 8 + pixelX;
      const colorIdx = mmu.vram8[tileAddr];

      if (colorIdx !== 0) {
        const bgr = mmu.palette16[colorIdx];
        line[x] = colorLUT[bgr & 0x7FFF];
        priorities[x] = priority;
      }
    }

    cx += pa;  // dx per pixel
    cy += pc;  // dy per pixel
  }

  // Advance reference point for next scanline (PB for X, PD for Y)
  return [refX + pb, refY + pd];
}

/**
 * Render one scanline of Mode 3 (240x160 16-bit bitmap).
 */
export function renderMode3(
  line: Uint32Array,
  scanline: number,
  mmu: MMU,
): void {
  const base = scanline * SCREEN_WIDTH;
  for (let x = 0; x < SCREEN_WIDTH; x++) {
    const bgr = mmu.vram16[base + x];
    line[x] = colorLUT[bgr & 0x7FFF];
  }
}

/**
 * Render one scanline of Mode 4 (240x160 8-bit indexed, double-buffered).
 */
export function renderMode4(
  line: Uint32Array,
  scanline: number,
  mmu: MMU,
  io: IORegisters,
): void {
  const frameOffset = (io.read16(REG_DISPCNT) & DISPCNT_FRAME_SELECT) ? 0xA000 : 0;
  const base = frameOffset + scanline * SCREEN_WIDTH;

  for (let x = 0; x < SCREEN_WIDTH; x++) {
    const colorIdx = mmu.vram8[base + x];
    if (colorIdx !== 0) {
      const bgr = mmu.palette16[colorIdx];
      line[x] = colorLUT[bgr & 0x7FFF];
    }
  }
}

/**
 * Render one scanline of Mode 5 (160x128 16-bit bitmap, double-buffered).
 */
export function renderMode5(
  line: Uint32Array,
  scanline: number,
  mmu: MMU,
  io: IORegisters,
): void {
  if (scanline >= 128) return;

  const frameOffset = (io.read16(REG_DISPCNT) & DISPCNT_FRAME_SELECT) ? 0xA000 : 0;
  const base = (frameOffset + scanline * 160) >>> 1; // divide by 2 for uint16 index

  for (let x = 0; x < 160; x++) {
    const bgr = mmu.vram16[base + x];
    line[x] = colorLUT[bgr & 0x7FFF];
  }
}
