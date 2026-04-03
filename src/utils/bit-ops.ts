/** Sign-extend a value from the given bit width to 32 bits */
export function signExtend(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

/** Test bit at position */
export function testBit(value: number, bit: number): boolean {
  return (value & (1 << bit)) !== 0;
}

/** Set bit at position */
export function setBit(value: number, bit: number): number {
  return value | (1 << bit);
}

/** Clear bit at position */
export function clearBit(value: number, bit: number): number {
  return value & ~(1 << bit);
}

/** Extract a range of bits [hi:lo] inclusive */
export function bits(value: number, hi: number, lo: number): number {
  return (value >>> lo) & ((1 << (hi - lo + 1)) - 1);
}

/** Rotate right by amount */
export function ror32(value: number, amount: number): number {
  amount &= 31;
  if (amount === 0) return value;
  return ((value >>> amount) | (value << (32 - amount))) >>> 0;
}

/** Check if adding a + b produces a carry out of bit 31 */
export function addCarry(a: number, b: number): boolean {
  return ((a >>> 0) + (b >>> 0)) > 0xFFFFFFFF;
}

/** Check if adding a + b produces signed overflow */
export function addOverflow(a: number, b: number, result: number): boolean {
  return ((a ^ result) & (b ^ result)) < 0;
}

/** Check if subtracting a - b produces a borrow (no carry) */
export function subCarry(a: number, b: number): boolean {
  return (a >>> 0) >= (b >>> 0);
}

/** Check if subtracting a - b produces signed overflow */
export function subOverflow(a: number, b: number, result: number): boolean {
  return ((a ^ b) & (a ^ result)) < 0;
}
