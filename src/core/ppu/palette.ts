/**
 * GBA Palette Conversion
 *
 * GBA uses 15-bit BGR555 color format: xBBBBBGG GGGRRRRR
 * We convert to RGBA8888 for canvas output.
 */

// Pre-built lookup table: 32768 entries mapping BGR555 → RGBA8888
const colorLUT = new Uint32Array(32768);

// Build the LUT once
for (let bgr = 0; bgr < 32768; bgr++) {
  const r5 = bgr & 0x1F;
  const g5 = (bgr >>> 5) & 0x1F;
  const b5 = (bgr >>> 10) & 0x1F;

  // Convert 5-bit to 8-bit with proper rounding
  const r8 = (r5 << 3) | (r5 >>> 2);
  const g8 = (g5 << 3) | (g5 >>> 2);
  const b8 = (b5 << 3) | (b5 >>> 2);

  // RGBA8888 in little-endian (ABGR when stored as uint32)
  colorLUT[bgr] = 0xFF000000 | (b8 << 16) | (g8 << 8) | r8;
}

/** Convert a 15-bit BGR555 color to RGBA8888 */
export function bgr555ToRGBA(color: number): number {
  return colorLUT[color & 0x7FFF];
}

/** Get the pre-built color lookup table */
export function getColorLUT(): Uint32Array {
  return colorLUT;
}
