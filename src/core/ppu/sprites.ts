import type { MMU } from '../memory/mmu.js';
import type { IORegisters } from '../memory/io.js';
import { getColorLUT } from './palette.js';
import {
  SCREEN_WIDTH, SCREEN_HEIGHT,
  SPRITE_WIDTHS, SPRITE_HEIGHTS,
  OAM_ENTRY_COUNT,
  REG_DISPCNT, DISPCNT_OBJ_1D,
  VRAM_SIZE,
} from '../types.js';

const colorLUT = getColorLUT();

/**
 * Render sprites for one scanline.
 * Sprites are rendered to a separate line buffer, then composited with BG layers.
 *
 * GFX modes (attr0 bits 10-11):
 *   0 = Normal
 *   1 = Semi-transparent (alpha blend with layer below)
 *   2 = OBJ Window (marks window mask, not drawn)
 *   3 = Prohibited (skipped)
 */
export function renderSprites(
  line: Uint32Array,
  priorities: Uint8Array,
  semiTransparent: Uint8Array,
  objWindow: Uint8Array,
  scanline: number,
  mmu: MMU,
  io: IORegisters,
): void {
  const dispcnt = io.read16(REG_DISPCNT);
  const objMapping1D = (dispcnt & DISPCNT_OBJ_1D) !== 0;
  const videoMode = dispcnt & 7;

  // Iterate sprites in reverse order (lower index = higher priority)
  for (let i = OAM_ENTRY_COUNT - 1; i >= 0; i--) {
    const oamBase = i * 8;

    // Read OAM attributes
    const attr0 = mmu.oam16[oamBase >>> 1];
    const attr1 = mmu.oam16[(oamBase >>> 1) + 1];
    const attr2 = mmu.oam16[(oamBase >>> 1) + 2];

    // OBJ mode (rotation/scaling): 0=normal, 1=affine, 2=disabled, 3=affine+double-size
    const objMode = (attr0 >>> 8) & 3;
    if (objMode === 2) continue; // Disabled

    // GFX mode: 0=normal, 1=semi-transparent, 2=OBJ window, 3=prohibited
    const gfxMode = (attr0 >>> 10) & 3;
    if (gfxMode === 3) continue; // Prohibited

    const isAffine = objMode === 1 || objMode === 3;
    const doubleSize = objMode === 3;

    // Get sprite dimensions
    const shape = (attr0 >>> 14) & 3;
    if (shape === 3) continue; // Invalid shape
    const size = (attr1 >>> 14) & 3;
    const sprW = SPRITE_WIDTHS[shape][size];
    const sprH = SPRITE_HEIGHTS[shape][size];

    // Sprite position
    let sprY = attr0 & 0xFF;
    if (sprY >= 160) sprY -= 256; // Signed Y

    const renderH = doubleSize ? sprH * 2 : sprH;
    const renderW = doubleSize ? sprW * 2 : sprW;

    // Check if sprite is on this scanline
    let localY = scanline - sprY;
    if (localY < 0 || localY >= renderH) continue;

    let sprX = attr1 & 0x1FF;
    if (sprX >= 240) sprX -= 512; // Signed X

    const priority = (attr2 >>> 10) & 3;
    const tileNum = attr2 & 0x3FF;
    // In bitmap modes (3/4/5), lower OBJ VRAM is used by the framebuffer;
    // only sprite tiles 512+ are valid.
    if (videoMode >= 3 && tileNum < 512) continue;
    const palBank = (attr2 >>> 12) & 0xF;
    const is256Color = (attr0 >>> 13) & 1;

    const hFlip = !isAffine && ((attr1 >>> 12) & 1);
    const vFlip = !isAffine && ((attr1 >>> 13) & 1);

    // Sprite tile base is always at 0x10000 in VRAM
    const tileBase = 0x10000;

    if (isAffine) {
      // Affine sprite rendering
      const affineGroup = (attr1 >>> 9) & 0x1F;
      const affineBase = affineGroup * 32;

      // Read affine parameters from OAM (interleaved with regular entries)
      const pa = (mmu.oam16[(affineBase + 6) >>> 1] << 16 >> 16);
      const pb = (mmu.oam16[(affineBase + 14) >>> 1] << 16 >> 16);
      const pc = (mmu.oam16[(affineBase + 22) >>> 1] << 16 >> 16);
      const pd = (mmu.oam16[(affineBase + 30) >>> 1] << 16 >> 16);

      const halfW = renderW >>> 1;
      const halfH = renderH >>> 1;
      const halfSprW = sprW >>> 1;
      const halfSprH = sprH >>> 1;

      const iy = localY - halfH;

      for (let screenX = sprX; screenX < sprX + renderW; screenX++) {
        if (screenX < 0 || screenX >= SCREEN_WIDTH) continue;

        const ix = screenX - sprX - halfW;

        // Apply inverse affine transform
        let texX = ((pa * ix + pb * iy) >> 8) + halfSprW;
        let texY = ((pc * ix + pd * iy) >> 8) + halfSprH;

        if (texX < 0 || texX >= sprW || texY < 0 || texY >= sprH) continue;

        const colorIdx = _getPixel(texX, texY, tileNum, sprW, is256Color, palBank, tileBase, objMapping1D, mmu);
        if (colorIdx !== 0) {
          if (gfxMode === 2) {
            // OBJ window: mark pixel, don't draw
            objWindow[screenX] = 1;
          } else {
            const bgr = mmu.palette16[256 + colorIdx];
            line[screenX] = colorLUT[bgr & 0x7FFF];
            priorities[screenX] = priority;
            if (gfxMode === 1) {
              semiTransparent[screenX] = 1;
            }
          }
        }
      }
    } else {
      // Regular sprite rendering
      let texY = vFlip ? (sprH - 1 - localY) : localY;

      for (let px = 0; px < sprW; px++) {
        const screenX = sprX + px;
        if (screenX < 0 || screenX >= SCREEN_WIDTH) continue;

        let texX = hFlip ? (sprW - 1 - px) : px;

        const colorIdx = _getPixel(texX, texY, tileNum, sprW, is256Color, palBank, tileBase, objMapping1D, mmu);
        if (colorIdx !== 0) {
          if (gfxMode === 2) {
            // OBJ window: mark pixel, don't draw
            objWindow[screenX] = 1;
          } else {
            const bgr = mmu.palette16[256 + colorIdx];
            line[screenX] = colorLUT[bgr & 0x7FFF];
            priorities[screenX] = priority;
            if (gfxMode === 1) {
              semiTransparent[screenX] = 1;
            }
          }
        }
      }
    }
  }
}

function _getPixel(
  texX: number, texY: number,
  tileNum: number, sprW: number,
  is256Color: number, palBank: number,
  tileBase: number, mapping1D: boolean,
  mmu: MMU,
): number {
  const tileX = texX >>> 3;
  const tileY = texY >>> 3;
  const pixelX = texX & 7;
  const pixelY = texY & 7;

  let tileIdx: number;
  if (mapping1D) {
    const tilesPerRow = sprW >>> 3;
    tileIdx = tileNum + tileY * tilesPerRow * (is256Color ? 2 : 1) + tileX * (is256Color ? 2 : 1);
  } else {
    // 2D mapping: tiles laid out in 32-tile-wide grid
    tileIdx = tileNum + tileY * 32 * (is256Color ? 2 : 1) + tileX * (is256Color ? 2 : 1);
  }

  if (is256Color) {
    // 8bpp tiles are 64 bytes each (8×8 pixels × 1 byte per pixel)
    const addr = tileBase + tileIdx * 64 + pixelY * 8 + pixelX;
    if (addr >= VRAM_SIZE) return 0;
    return mmu.vram8[addr];
  } else {
    const addr = tileBase + tileIdx * 32 + pixelY * 4 + (pixelX >>> 1);
    if (addr >= VRAM_SIZE) return 0;
    const byte = mmu.vram8[addr];
    const idx = (pixelX & 1) ? (byte >>> 4) : (byte & 0xF);
    return idx === 0 ? 0 : idx + palBank * 16;
  }
}
