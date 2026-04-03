/**
 * ARM Barrel Shifter
 *
 * Computes shifted values and carry-out for data processing and load/store instructions.
 * The ARM7TDMI barrel shifter supports 4 shift types:
 *   LSL (Logical Shift Left)
 *   LSR (Logical Shift Right)
 *   ASR (Arithmetic Shift Right)
 *   ROR (Rotate Right) — includes RRX (Rotate Right Extended) when amount=0
 */

export interface ShiftResult {
  value: number;
  carry: boolean;
}

// Pre-allocated result object to avoid allocations in the hot loop
const _result: ShiftResult = { value: 0, carry: false };

/** LSL by immediate amount (0-31). amount=0 means no shift. */
export function lslImm(value: number, amount: number, carryIn: boolean): ShiftResult {
  if (amount === 0) {
    _result.value = value;
    _result.carry = carryIn;
  } else {
    _result.carry = ((value >>> (32 - amount)) & 1) !== 0;
    _result.value = (value << amount) | 0;
  }
  return _result;
}

/** LSL by register amount (0-255). */
export function lslReg(value: number, amount: number, carryIn: boolean): ShiftResult {
  if (amount === 0) {
    _result.value = value;
    _result.carry = carryIn;
  } else if (amount < 32) {
    _result.carry = ((value >>> (32 - amount)) & 1) !== 0;
    _result.value = (value << amount) | 0;
  } else if (amount === 32) {
    _result.carry = (value & 1) !== 0;
    _result.value = 0;
  } else {
    _result.carry = false;
    _result.value = 0;
  }
  return _result;
}

/** LSR by immediate amount (1-32). amount=0 encodes LSR#32. */
export function lsrImm(value: number, amount: number, _carryIn: boolean): ShiftResult {
  if (amount === 0) {
    // Encoded as LSR#32
    _result.carry = value < 0; // bit 31
    _result.value = 0;
  } else {
    _result.carry = ((value >>> (amount - 1)) & 1) !== 0;
    _result.value = value >>> amount;
  }
  return _result;
}

/** LSR by register amount (0-255). */
export function lsrReg(value: number, amount: number, carryIn: boolean): ShiftResult {
  if (amount === 0) {
    _result.value = value;
    _result.carry = carryIn;
  } else if (amount < 32) {
    _result.carry = ((value >>> (amount - 1)) & 1) !== 0;
    _result.value = value >>> amount;
  } else if (amount === 32) {
    _result.carry = value < 0; // bit 31
    _result.value = 0;
  } else {
    _result.carry = false;
    _result.value = 0;
  }
  return _result;
}

/** ASR by immediate amount (1-32). amount=0 encodes ASR#32. */
export function asrImm(value: number, amount: number, _carryIn: boolean): ShiftResult {
  if (amount === 0) {
    // Encoded as ASR#32
    _result.carry = value < 0;
    _result.value = value < 0 ? -1 : 0; // all 1s or all 0s
  } else {
    _result.carry = ((value >> (amount - 1)) & 1) !== 0;
    _result.value = value >> amount;
  }
  return _result;
}

/** ASR by register amount (0-255). */
export function asrReg(value: number, amount: number, carryIn: boolean): ShiftResult {
  if (amount === 0) {
    _result.value = value;
    _result.carry = carryIn;
  } else if (amount < 32) {
    _result.carry = ((value >> (amount - 1)) & 1) !== 0;
    _result.value = value >> amount;
  } else {
    // amount >= 32
    _result.carry = value < 0;
    _result.value = value < 0 ? -1 : 0;
  }
  return _result;
}

/** ROR by immediate amount (1-31). amount=0 encodes RRX. */
export function rorImm(value: number, amount: number, carryIn: boolean): ShiftResult {
  if (amount === 0) {
    // RRX: rotate right through carry (33-bit rotation by 1)
    _result.carry = (value & 1) !== 0;
    _result.value = ((carryIn ? 0x80000000 : 0) | (value >>> 1)) | 0;
  } else {
    _result.carry = ((value >>> (amount - 1)) & 1) !== 0;
    _result.value = (((value >>> amount) | (value << (32 - amount))) >>> 0) | 0;
  }
  return _result;
}

/** ROR by register amount (0-255). */
export function rorReg(value: number, amount: number, carryIn: boolean): ShiftResult {
  if (amount === 0) {
    _result.value = value;
    _result.carry = carryIn;
  } else {
    const rot = amount & 31;
    if (rot === 0) {
      _result.carry = value < 0; // bit 31
      _result.value = value;
    } else {
      _result.carry = ((value >>> (rot - 1)) & 1) !== 0;
      _result.value = (((value >>> rot) | (value << (32 - rot))) >>> 0) | 0;
    }
  }
  return _result;
}

/**
 * Apply immediate shift for a data processing operand.
 * shiftType: 0=LSL, 1=LSR, 2=ASR, 3=ROR
 */
export function applyShiftImm(value: number, shiftType: number, amount: number, carryIn: boolean): ShiftResult {
  switch (shiftType) {
    case 0: return lslImm(value, amount, carryIn);
    case 1: return lsrImm(value, amount, carryIn);
    case 2: return asrImm(value, amount, carryIn);
    case 3: return rorImm(value, amount, carryIn);
    default: return lslImm(value, 0, carryIn);
  }
}

/**
 * Apply register shift for a data processing operand.
 * shiftType: 0=LSL, 1=LSR, 2=ASR, 3=ROR
 */
export function applyShiftReg(value: number, shiftType: number, amount: number, carryIn: boolean): ShiftResult {
  switch (shiftType) {
    case 0: return lslReg(value, amount, carryIn);
    case 1: return lsrReg(value, amount, carryIn);
    case 2: return asrReg(value, amount, carryIn);
    case 3: return rorReg(value, amount, carryIn);
    default: return lslReg(value, 0, carryIn);
  }
}
