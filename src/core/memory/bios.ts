import type { ARM7TDMI } from '../cpu/arm7tdmi.js';
import { PC, LR, R0, R1, R2, R3 } from '../cpu/registers.js';
import { logWarn, logInfo } from '../../utils/logger.js';

/**
 * HLE BIOS — High-Level Emulation of GBA BIOS SWI calls.
 * Instead of executing the real BIOS ROM, we implement the ~40 functions directly.
 */
let _swiWarnCount = 0;
const _SWI_WARN_LIMIT = 10;

let _swiLog: Record<number, number> = {};
let _swiLogTimer = 0;

export function handleSWI(cpu: ARM7TDMI, comment: number): void {
  // Debug: log SWI call frequency every 2 seconds
  _swiLog[comment] = (_swiLog[comment] || 0) + 1;
  const now = performance.now();
  if (now - _swiLogTimer > 2000) {
    console.log('[SWI] calls:', Object.entries(_swiLog).map(([k,v]) => `0x${Number(k).toString(16)}:${v}`).join(' '));
    _swiLog = {};
    _swiLogTimer = now;
  }

  switch (comment) {
    case 0x00: swiSoftReset(cpu); break;
    case 0x01: swiRegisterRamReset(cpu); break;
    case 0x02: swiHalt(cpu); break;
    case 0x03: swiStop(cpu); break;
    case 0x04: swiIntrWait(cpu); break;
    case 0x05: swiVBlankIntrWait(cpu); break;
    case 0x06: swiDiv(cpu); break;
    case 0x07: swiDivArm(cpu); break;
    case 0x08: swiSqrt(cpu); break;
    case 0x09: swiArcTan(cpu); break;
    case 0x0A: swiArcTan2(cpu); break;
    case 0x0B: swiCpuSet(cpu); break;
    case 0x0C: swiCpuFastSet(cpu); break;
    case 0x0E: swiBgAffineSet(cpu); break;
    case 0x0F: swiObjAffineSet(cpu); break;
    case 0x10: swiBitUnPack(cpu); break;
    case 0x11: swiLZ77UnCompWram(cpu); break;
    case 0x12: swiLZ77UnCompVram(cpu); break;
    case 0x13: swiHuffUnComp(cpu); break;
    case 0x14: swiRLUnCompWram(cpu); break;
    case 0x15: swiRLUnCompVram(cpu); break;
    case 0x16: swiDiff8bitUnFilterWram(cpu); break;
    case 0x17: swiDiff8bitUnFilterVram(cpu); break;
    case 0x18: swiDiff16bitUnFilter(cpu); break;
    case 0x19: /* SoundBias — no-op for HLE */ break;
    case 0x1F: swiMidiKey2Freq(cpu); break;
    case 0x25: swiSoundDriverInit(cpu); break;
    case 0x26: swiSoundDriverMain(cpu); break;
    case 0x27: swiSoundDriverVSync(cpu); break;
    case 0x28: swiSoundChannelClear(cpu); break;
    default:
      if (_swiWarnCount < _SWI_WARN_LIMIT) {
        logWarn(`Unimplemented SWI 0x${comment.toString(16).padStart(2, '0')}`);
        _swiWarnCount++;
        if (_swiWarnCount === _SWI_WARN_LIMIT) {
          logWarn('(suppressing further SWI warnings)');
        }
      }
  }
}

function swiSoftReset(cpu: ARM7TDMI): void {
  // Clear IWRAM 0x03007E00-0x03007FFF, reset registers, jump to ROM
  for (let i = 0x03007E00; i < 0x03008000; i++) {
    cpu.write8(i, 0);
  }
  cpu.rf.regs.fill(0);
  cpu.rf.regs[PC] = 0x08000000;
  cpu.rf.regs[13] = 0x03007F00; // SP
  cpu.rf.cpsr = 0x1F; // System mode
  cpu.flushPipeline();
}

function swiRegisterRamReset(cpu: ARM7TDMI): void {
  const flags = cpu.rf.regs[R0];
  if (flags & 0x01) {
    // Clear 256KB EWRAM
    for (let i = 0x02000000; i < 0x02040000; i += 4) cpu.write32(i, 0);
  }
  if (flags & 0x02) {
    // Clear 32KB IWRAM (except last 512 bytes)
    for (let i = 0x03000000; i < 0x03007E00; i += 4) cpu.write32(i, 0);
  }
  if (flags & 0x04) {
    // Clear Palette
    for (let i = 0x05000000; i < 0x05000400; i += 4) cpu.write32(i, 0);
  }
  if (flags & 0x08) {
    // Clear VRAM
    for (let i = 0x06000000; i < 0x06018000; i += 4) cpu.write32(i, 0);
  }
  if (flags & 0x10) {
    // Clear OAM
    for (let i = 0x07000000; i < 0x07000400; i += 4) cpu.write32(i, 0);
  }
  if (flags & 0x20) {
    // Reset SIO
    cpu.write16(0x04000128, 0);
  }
  if (flags & 0x40) {
    // Reset Sound
    for (let i = 0x04000060; i < 0x040000A0; i += 2) cpu.write16(i, 0);
  }
  if (flags & 0x80) {
    // Reset other I/O
    // Minimal — just clear DISPCNT
    cpu.write16(0x04000000, 0);
  }
}

function swiHalt(cpu: ARM7TDMI): void {
  cpu.halted = true;
}

function swiStop(cpu: ARM7TDMI): void {
  cpu.halted = true; // Same as halt for our purposes
}

function swiIntrWait(cpu: ARM7TDMI): void {
  const discardOld = cpu.rf.regs[R0];
  const waitFlags = cpu.rf.regs[R1];
  const ifAddr = 0x03007FF8; // BIOS IF mirror in IWRAM

  if (discardOld) {
    // Clear old flags for the waited interrupts first
    const current = cpu.read16(ifAddr);
    cpu.write16(ifAddr, current & ~waitFlags);
  }

  // Check if the waited interrupt has already occurred
  const current = cpu.read16(ifAddr);
  if (current & waitFlags) {
    // Flag is already set — clear it and return immediately
    cpu.write16(ifAddr, current & ~waitFlags);
    return;
  }

  // Set wait flags so serviceIRQ only wakes on the correct interrupt
  cpu.waitIrqFlags = waitFlags;
  cpu.halted = true;
}

function swiVBlankIntrWait(cpu: ARM7TDMI): void {
  cpu.rf.regs[R0] = 1;
  cpu.rf.regs[R1] = 1; // VBlank flag
  cpu.vblankIntrWaitCount++;
  swiIntrWait(cpu);
}

function swiDiv(cpu: ARM7TDMI): void {
  const num = cpu.rf.regs[R0] | 0; // Treat as signed 32-bit
  const den = cpu.rf.regs[R1] | 0;
  if (den === 0) {
    logWarn('Division by zero in SWI Div');
    return;
  }
  const result = (num / den) | 0;
  cpu.rf.regs[R0] = result;
  cpu.rf.regs[R1] = (num % den) | 0;
  cpu.rf.regs[R3] = Math.abs(result);
}

function swiDivArm(cpu: ARM7TDMI): void {
  // Same as Div but arguments swapped
  const tmp = cpu.rf.regs[R0];
  cpu.rf.regs[R0] = cpu.rf.regs[R1];
  cpu.rf.regs[R1] = tmp;
  swiDiv(cpu);
}

function swiSqrt(cpu: ARM7TDMI): void {
  cpu.rf.regs[R0] = Math.sqrt(cpu.rf.regs[R0] >>> 0) | 0;
}

function swiArcTan(cpu: ARM7TDMI): void {
  let a = cpu.rf.regs[R0] / 16384.0;
  a = Math.atan(a);
  cpu.rf.regs[R0] = (a * 16384.0 / (Math.PI / 2)) | 0;
}

function swiArcTan2(cpu: ARM7TDMI): void {
  const x = cpu.rf.regs[R0] / 16384.0;
  const y = cpu.rf.regs[R1] / 16384.0;
  let angle = Math.atan2(y, x);
  if (angle < 0) angle += 2 * Math.PI;
  cpu.rf.regs[R0] = (angle * 32768.0 / Math.PI) | 0;
}

function swiCpuSet(cpu: ARM7TDMI): void {
  const src = cpu.rf.regs[R0];
  const dst = cpu.rf.regs[R1];
  const ctrl = cpu.rf.regs[R2];
  const count = ctrl & 0x1FFFFF;
  const fill = (ctrl & (1 << 24)) !== 0;
  const wordSize = (ctrl & (1 << 26)) !== 0 ? 4 : 2;

  if (wordSize === 4) {
    const fillVal = fill ? cpu.read32(src) : 0;
    for (let i = 0; i < count; i++) {
      const val = fill ? fillVal : cpu.read32(src + i * 4);
      cpu.write32(dst + i * 4, val);
    }
  } else {
    const fillVal = fill ? cpu.read16(src) : 0;
    for (let i = 0; i < count; i++) {
      const val = fill ? fillVal : cpu.read16(src + i * 2);
      cpu.write16(dst + i * 2, val);
    }
  }
  // Approximate cycle cost
  cpu.cycles += count * 2;
}

function swiCpuFastSet(cpu: ARM7TDMI): void {
  const src = cpu.rf.regs[R0];
  const dst = cpu.rf.regs[R1];
  const ctrl = cpu.rf.regs[R2];
  const count = ctrl & 0x1FFFFF;
  const fill = (ctrl & (1 << 24)) !== 0;

  // Always 32-bit, count must be multiple of 8
  const alignedCount = (count + 7) & ~7;

  if (fill) {
    const val = cpu.read32(src);
    for (let i = 0; i < alignedCount; i++) {
      cpu.write32(dst + i * 4, val);
    }
  } else {
    for (let i = 0; i < alignedCount; i++) {
      cpu.write32(dst + i * 4, cpu.read32(src + i * 4));
    }
  }
  // Approximate cycle cost
  cpu.cycles += alignedCount * 2;
}

function swiBgAffineSet(cpu: ARM7TDMI): void {
  const src = cpu.rf.regs[R0];
  const dst = cpu.rf.regs[R1];
  const count = cpu.rf.regs[R2];

  for (let i = 0; i < count; i++) {
    const srcOff = src + i * 20;
    const dstOff = dst + i * 16;

    const cx = cpu.read32(srcOff) | 0;     // Center X (signed 32-bit)
    const cy = cpu.read32(srcOff + 4) | 0;  // Center Y
    const dispX = (cpu.read16(srcOff + 8) << 16 >> 16); // Display X (signed 16)
    const dispY = (cpu.read16(srcOff + 10) << 16 >> 16); // Display Y
    const sx = (cpu.read16(srcOff + 12) << 16 >> 16); // Scale X
    const sy = (cpu.read16(srcOff + 14) << 16 >> 16); // Scale Y
    const angle = (cpu.read16(srcOff + 16) >>> 0) * 2 * Math.PI / 65536;

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const pa = (cosA * 256 / sx * 256) | 0;
    const pb = (sinA * 256 / sx * 256) | 0;
    const pc = (-sinA * 256 / sy * 256) | 0;
    const pd = (cosA * 256 / sy * 256) | 0;

    const startX = cx - (pa * dispX + pb * dispY);
    const startY = cy - (pc * dispX + pd * dispY);

    cpu.write16(dstOff, pa & 0xFFFF);
    cpu.write16(dstOff + 2, pb & 0xFFFF);
    cpu.write16(dstOff + 4, pc & 0xFFFF);
    cpu.write16(dstOff + 6, pd & 0xFFFF);
    cpu.write32(dstOff + 8, startX);
    cpu.write32(dstOff + 12, startY);
  }
}

function swiObjAffineSet(cpu: ARM7TDMI): void {
  const src = cpu.rf.regs[R0];
  const dst = cpu.rf.regs[R1];
  const count = cpu.rf.regs[R2];
  const stride = cpu.rf.regs[R3]; // Offset between PA,PB,PC,PD entries in OAM

  for (let i = 0; i < count; i++) {
    const srcOff = src + i * 8;
    const sx = (cpu.read16(srcOff) << 16 >> 16);
    const sy = (cpu.read16(srcOff + 2) << 16 >> 16);
    const angle = (cpu.read16(srcOff + 4) >>> 0) * 2 * Math.PI / 65536;

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const pa = (cosA * 256 / sx * 256) | 0;
    const pb = (sinA * 256 / sx * 256) | 0;
    const pc = (-sinA * 256 / sy * 256) | 0;
    const pd = (cosA * 256 / sy * 256) | 0;

    const base = dst + i * stride * 4;
    cpu.write16(base, pa & 0xFFFF);
    cpu.write16(base + stride, pb & 0xFFFF);
    cpu.write16(base + stride * 2, pc & 0xFFFF);
    cpu.write16(base + stride * 3, pd & 0xFFFF);
  }
}

function swiBitUnPack(cpu: ARM7TDMI): void {
  const src = cpu.rf.regs[R0];
  const dst = cpu.rf.regs[R1];
  const infoPtr = cpu.rf.regs[R2];

  const len = cpu.read16(infoPtr);
  const srcBits = cpu.read8(infoPtr + 2);
  const dstBits = cpu.read8(infoPtr + 3);
  const dataOffset = cpu.read32(infoPtr + 4);
  const zeroFlag = (dataOffset & 0x80000000) !== 0;
  const offset = dataOffset & 0x7FFFFFFF;

  const srcMask = (1 << srcBits) - 1;
  let srcIdx = 0;
  let dstIdx = 0;
  let dstWord = 0;
  let dstBitsUsed = 0;

  for (let i = 0; i < len; i++) {
    let byte = cpu.read8(src + i);
    for (let b = 0; b < 8; b += srcBits) {
      let val = byte & srcMask;
      byte >>= srcBits;

      if (val !== 0 || zeroFlag) {
        val += offset;
      }

      dstWord |= (val & ((1 << dstBits) - 1)) << dstBitsUsed;
      dstBitsUsed += dstBits;

      if (dstBitsUsed >= 32) {
        cpu.write32(dst + dstIdx * 4, dstWord);
        dstIdx++;
        dstWord = 0;
        dstBitsUsed = 0;
      }

      srcIdx++;
    }
  }

  if (dstBitsUsed > 0) {
    cpu.write32(dst + dstIdx * 4, dstWord);
  }
}

function swiLZ77UnCompWram(cpu: ARM7TDMI): void {
  _lz77Decompress(cpu, false);
}

function swiLZ77UnCompVram(cpu: ARM7TDMI): void {
  _lz77Decompress(cpu, true);
}

function _lz77Decompress(cpu: ARM7TDMI, vram: boolean): void {
  const src = cpu.rf.regs[R0];
  const dst = cpu.rf.regs[R1];

  const header = cpu.read32(src);
  const decompSize = header >>> 8;

  if (vram) {
    // VRAM variant: decompress to temporary buffer first, then write 16-bit
    // This is necessary because VRAM doesn't support 8-bit writes, and
    // LZ77 back-references need to read from already-written output bytes
    const buf = new Uint8Array(decompSize);
    let srcIdx = 4;
    let dstIdx = 0;

    while (dstIdx < decompSize) {
      const flags = cpu.read8(src + srcIdx++);
      for (let i = 7; i >= 0 && dstIdx < decompSize; i--) {
        if (flags & (1 << i)) {
          const b1 = cpu.read8(src + srcIdx++);
          const b2 = cpu.read8(src + srcIdx++);
          const length = ((b1 >> 4) & 0xF) + 3;
          const offset = ((b1 & 0xF) << 8) | b2;
          for (let j = 0; j < length && dstIdx < decompSize; j++) {
            buf[dstIdx] = buf[dstIdx - offset - 1];
            dstIdx++;
          }
        } else {
          buf[dstIdx++] = cpu.read8(src + srcIdx++);
        }
      }
    }

    // Write to VRAM in 16-bit halfwords
    for (let i = 0; i < decompSize - 1; i += 2) {
      cpu.write16(dst + i, buf[i] | (buf[i + 1] << 8));
    }
    // Handle odd trailing byte
    if (decompSize & 1) {
      cpu.write16(dst + decompSize - 1, buf[decompSize - 1]);
    }
  } else {
    // WRAM variant: write bytes directly
    let srcIdx = 4;
    let dstIdx = 0;

    while (dstIdx < decompSize) {
      const flags = cpu.read8(src + srcIdx++);
      for (let i = 7; i >= 0 && dstIdx < decompSize; i--) {
        if (flags & (1 << i)) {
          const b1 = cpu.read8(src + srcIdx++);
          const b2 = cpu.read8(src + srcIdx++);
          const length = ((b1 >> 4) & 0xF) + 3;
          const offset = ((b1 & 0xF) << 8) | b2;
          for (let j = 0; j < length && dstIdx < decompSize; j++) {
            cpu.write8(dst + dstIdx, cpu.read8(dst + dstIdx - offset - 1));
            dstIdx++;
          }
        } else {
          cpu.write8(dst + dstIdx++, cpu.read8(src + srcIdx++));
        }
      }
    }
  }
}

function swiHuffUnComp(cpu: ARM7TDMI): void {
  const src = cpu.rf.regs[R0];
  const dst = cpu.rf.regs[R1];

  const header = cpu.read32(src);
  const bitSize = header & 0xF;
  const decompSize = header >>> 8;

  const treeSize = cpu.read8(src + 4);
  const treeStart = src + 5;
  // Tree table = treeSize * 2 + 1 bytes (per GBATEK: stored value = (table_size+1)/2 - 1)
  const dataStart = treeStart + (treeSize * 2 + 1);

  let srcIdx = dataStart;
  let dstIdx = 0;
  let dstWord = 0;
  let dstBitsWritten = 0;

  let currentBits = cpu.read32(srcIdx);
  srcIdx += 4;
  let bitsLeft = 32;

  let node = treeStart; // Start at root

  while (dstIdx < decompSize) {
    if (bitsLeft === 0) {
      currentBits = cpu.read32(srcIdx);
      srcIdx += 4;
      bitsLeft = 32;
    }

    const bit = (currentBits >>> 31) & 1;
    currentBits <<= 1;
    bitsLeft--;

    // Read current node and compute child pair address
    const nodeData = cpu.read8(node);
    const childPairAddr = (node & ~1) + (nodeData & 0x3F) * 2 + 2;

    // Check if the selected child is a leaf
    // bit 7: left child (bit=0) is leaf; bit 6: right child (bit=1) is leaf
    const isLeaf = bit === 0 ? (nodeData & 0x80) : (nodeData & 0x40);
    const childAddr = childPairAddr + bit;

    if (isLeaf) {
      const leafValue = cpu.read8(childAddr);
      dstWord |= (leafValue << dstBitsWritten);
      dstBitsWritten += bitSize;

      if (dstBitsWritten >= 32) {
        cpu.write32(dst + dstIdx, dstWord);
        dstIdx += 4;
        dstWord = 0;
        dstBitsWritten = 0;
      }

      node = treeStart; // Back to root
    } else {
      node = childAddr; // Follow child branch
    }
  }
}

function swiRLUnCompWram(cpu: ARM7TDMI): void {
  _rlDecompress(cpu, false);
}

function swiRLUnCompVram(cpu: ARM7TDMI): void {
  _rlDecompress(cpu, true);
}

function _rlDecompress(cpu: ARM7TDMI, vram: boolean): void {
  const src = cpu.rf.regs[R0];
  const dst = cpu.rf.regs[R1];

  const header = cpu.read32(src);
  const decompSize = header >>> 8;

  if (vram) {
    // VRAM variant: decompress to temp buffer, write 16-bit
    const buf = new Uint8Array(decompSize);
    let srcIdx = 4;
    let dstIdx = 0;

    while (dstIdx < decompSize) {
      const flag = cpu.read8(src + srcIdx++);
      if (flag & 0x80) {
        const length = (flag & 0x7F) + 3;
        const data = cpu.read8(src + srcIdx++);
        for (let i = 0; i < length && dstIdx < decompSize; i++) {
          buf[dstIdx++] = data;
        }
      } else {
        const length = (flag & 0x7F) + 1;
        for (let i = 0; i < length && dstIdx < decompSize; i++) {
          buf[dstIdx++] = cpu.read8(src + srcIdx++);
        }
      }
    }

    for (let i = 0; i < decompSize - 1; i += 2) {
      cpu.write16(dst + i, buf[i] | (buf[i + 1] << 8));
    }
    if (decompSize & 1) {
      cpu.write16(dst + decompSize - 1, buf[decompSize - 1]);
    }
  } else {
    // WRAM variant: write bytes directly
    let srcIdx = 4;
    let dstIdx = 0;

    while (dstIdx < decompSize) {
      const flag = cpu.read8(src + srcIdx++);
      if (flag & 0x80) {
        const length = (flag & 0x7F) + 3;
        const data = cpu.read8(src + srcIdx++);
        for (let i = 0; i < length && dstIdx < decompSize; i++) {
          cpu.write8(dst + dstIdx++, data);
        }
      } else {
        const length = (flag & 0x7F) + 1;
        for (let i = 0; i < length && dstIdx < decompSize; i++) {
          cpu.write8(dst + dstIdx++, cpu.read8(src + srcIdx++));
        }
      }
    }
  }
}

// =========================================================================
// Diff Unfilter (SWI 0x16, 0x17, 0x18)
// =========================================================================

function swiDiff8bitUnFilterWram(cpu: ARM7TDMI): void {
  _diff8bitUnFilter(cpu, false);
}

function swiDiff8bitUnFilterVram(cpu: ARM7TDMI): void {
  _diff8bitUnFilter(cpu, true);
}

function _diff8bitUnFilter(cpu: ARM7TDMI, vram: boolean): void {
  const src = cpu.rf.regs[R0];
  const dst = cpu.rf.regs[R1];

  const header = cpu.read32(src);
  const size = header >>> 8;

  let srcIdx = 4;
  let dstIdx = 0;
  let prev = 0;

  if (vram) {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      const diff = cpu.read8(src + srcIdx++);
      prev = (prev + diff) & 0xFF;
      buf[i] = prev;
    }
    for (let i = 0; i < size - 1; i += 2) {
      cpu.write16(dst + i, buf[i] | (buf[i + 1] << 8));
    }
    if (size & 1) {
      cpu.write16(dst + size - 1, buf[size - 1]);
    }
  } else {
    for (let i = 0; i < size; i++) {
      const diff = cpu.read8(src + srcIdx++);
      prev = (prev + diff) & 0xFF;
      cpu.write8(dst + dstIdx++, prev);
    }
  }
}

function swiDiff16bitUnFilter(cpu: ARM7TDMI): void {
  const src = cpu.rf.regs[R0];
  const dst = cpu.rf.regs[R1];

  const header = cpu.read32(src);
  const size = header >>> 8;
  const count = size >>> 1; // 16-bit units

  let srcIdx = 4;
  let prev = 0;

  for (let i = 0; i < count; i++) {
    const diff = cpu.read16(src + srcIdx) << 16 >> 16; // Sign extend
    srcIdx += 2;
    prev = (prev + diff) & 0xFFFF;
    cpu.write16(dst + i * 2, prev);
  }
}

// =========================================================================
// MidiKey2Freq (SWI 0x1F)
// =========================================================================

function swiMidiKey2Freq(cpu: ARM7TDMI): void {
  const base = cpu.rf.regs[R0];
  const mk = cpu.rf.regs[R1];
  const fp = cpu.rf.regs[R2];

  // Read frequency from wave data header
  const freq = cpu.read32(base + 4);
  // Calculate: freq * 2^((mk-69)/12 + fp/768)
  const exponent = (mk - 69) / 12.0 + fp / 768.0;
  cpu.rf.regs[R0] = (freq * Math.pow(2, exponent)) | 0;
}

// =========================================================================
// m4a / Sappy Sound Driver (SWI 0x25-0x28)
//
// The GBA BIOS contains a software mixer called "m4a" (also known as
// "Sappy" or "MusicPlayer2000"). Many first-party and third-party games
// use it. The driver manages a SoundArea structure in IWRAM containing:
//   - Mixer state (ident, DMA counter, channel count, etc.)
//   - An array of SoundChannel structs for active voices
//   - PCM mixing buffers
//
// SoundArea layout (offsets from base address in R0):
//   0x00: u32 ident          — magic value 0x68736D53 ("Smsh") when ready
//   0x04: u8  pcmDmaCounter  — DMA refill counter (set by VSync)
//   0x05: u8  reverb         — reverb amount
//   0x06: u8  maxChans       — max direct sound channels
//   0x07: u8  masterVol      — master volume (1-15)
//   0x08: u8  freq           — playback frequency index
//   0x09: 3 bytes padding
//   0x0C: u32 pcmSamplesPerVBlank
//   0x10: u32 pcmFreq        — actual sample rate in Hz
//   0x14: u32 divFreq        — CPU_FREQ / pcmFreq
//   0x18: u32 cgbMixerFunc   — pointer to CGB mixer (PSG channels)
//   0x1C: u32 cgbNoteOffFunc
//   0x20: u32 pcmMixerFunc   — pointer to mixer callback (unused in HLE)
//   0x24: u32 pcmBuffer      — pointer to PCM mix buffer
//   0x28: u32 cgbChans       — number of CGB channels (PSG)
//   0x2C: u32 pcmChansPerFrame
//   0x30-0x34C: SoundChannel[maxChans] — 0x40 bytes each
//
// After init, the game loads music via MusicPlayerOpen etc. (game code,
// not BIOS). SoundDriverMain processes all tracks each frame.
// =========================================================================

/** Address of the SoundArea in IWRAM (set by SoundDriverInit) */
let _soundAreaAddr = 0;

// SoundArea field offsets
const SA_IDENT       = 0x00;
const SA_DMA_CNT     = 0x04;
const SA_REVERB      = 0x05;
const SA_MAX_CHANS   = 0x06;
const SA_MASTER_VOL  = 0x07;
const SA_FREQ_IDX    = 0x08;
const SA_PCM_SPV     = 0x0C;
const SA_PCM_FREQ    = 0x10;
const SA_DIV_FREQ    = 0x14;
const SA_PCM_BUF     = 0x24;
const SA_CHAN_BASE    = 0x350; // Start of first SoundChannel (varies, but 0x350 is common)

// SoundChannel offsets (each channel is 0x40 bytes)
const SC_STATUS      = 0x00;
const SC_TYPE        = 0x01;
const SC_RIGHT_VOL   = 0x02;
const SC_LEFT_VOL    = 0x03;
const SC_ATTACK      = 0x04;
const SC_DECAY       = 0x05;
const SC_SUSTAIN     = 0x06;
const SC_RELEASE     = 0x07;
const SC_FREQ        = 0x20;
const SC_SIZE        = 0x40;

// Frequency table: index → sample rate
const FREQ_TABLE = [0, 5734, 7884, 10512, 13379, 15768, 18157, 21024, 26758, 31536, 36314, 40137, 42048];

// Magic identifier: "Smsh" in little-endian
const SOUND_IDENT_READY = 0x68736D53;

/**
 * SWI 0x25 — SoundDriverInit
 * R0 = pointer to SoundArea in IWRAM
 * Initializes the sound work area structure so music/SFX processing works.
 */
function swiSoundDriverInit(cpu: ARM7TDMI): void {
  const sa = cpu.rf.regs[R0];
  _soundAreaAddr = sa;

  logInfo(`SoundDriverInit: area=0x${sa.toString(16)}`);

  // Clear entire SoundArea (header + channels)
  // Typical size is ~0x350 (header) + maxChans * 0x40.
  // We'll clear a generous range — games usually allocate enough.
  for (let i = 0; i < 0x700; i += 4) {
    cpu.write32(sa + i, 0);
  }

  // Set defaults
  const maxChans = 8; // Default max channels
  cpu.write8(sa + SA_MAX_CHANS, maxChans);
  cpu.write8(sa + SA_MASTER_VOL, 15);     // Full volume
  cpu.write8(sa + SA_FREQ_IDX, 4);        // Default freq index = 4

  // Set default sample rate (index 4 = 13379 Hz)
  const freqIdx = 4;
  const pcmFreq = FREQ_TABLE[freqIdx] || 13379;
  cpu.write32(sa + SA_PCM_FREQ, pcmFreq);

  // Samples per VBlank ≈ pcmFreq / 60
  const samplesPerVBlank = ((pcmFreq * 2) / 60) | 0; // Doubled for stereo interleave
  cpu.write32(sa + SA_PCM_SPV, samplesPerVBlank);

  // CPU_FREQ / pcmFreq
  const cpuFreq = 16777216; // 16.78 MHz
  cpu.write32(sa + SA_DIV_FREQ, (cpuFreq / pcmFreq) | 0);

  // Write the magic identifier last — signals "ready"
  cpu.write32(sa + SA_IDENT, SOUND_IDENT_READY);
}

/**
 * SWI 0x26 — SoundDriverMain
 * Called once per frame to process music tracks, mix PCM audio, and
 * update envelope states. In HLE we do minimal processing:
 * just reset the DMA counter and mark channels as processed.
 */
function swiSoundDriverMain(cpu: ARM7TDMI): void {
  if (_soundAreaAddr === 0) return;
  const sa = _soundAreaAddr;

  // Check the ident is valid
  const ident = cpu.read32(sa + SA_IDENT);
  if (ident !== SOUND_IDENT_READY) return;

  // Reset DMA counter (signals to the game that a frame of audio was "mixed")
  cpu.write8(sa + SA_DMA_CNT, 0);

  // Process sound channels: advance envelopes and mark finished channels
  const maxChans = cpu.read8(sa + SA_MAX_CHANS) || 8;
  for (let i = 0; i < maxChans; i++) {
    const ch = sa + SA_CHAN_BASE + i * SC_SIZE;
    const status = cpu.read8(ch + SC_STATUS);

    // Status: 0 = inactive, non-zero = active
    // If a channel has the "release" flag, decrement and clear when done
    if (status === 0x04) {
      // Channel in release phase — clear it
      cpu.write8(ch + SC_STATUS, 0);
    }
  }
}

/**
 * SWI 0x27 — SoundDriverVSync
 * Called during VBlank. Sets the DMA counter so SoundDriverMain knows
 * it's time to mix a new frame of audio.
 */
function swiSoundDriverVSync(cpu: ARM7TDMI): void {
  if (_soundAreaAddr === 0) return;
  const sa = _soundAreaAddr;

  const ident = cpu.read32(sa + SA_IDENT);
  if (ident !== SOUND_IDENT_READY) return;

  // Increment DMA counter — SoundDriverMain checks this
  const cnt = cpu.read8(sa + SA_DMA_CNT);
  cpu.write8(sa + SA_DMA_CNT, cnt + 1);
}

/**
 * SWI 0x28 — SoundChannelClear
 * Stops all active sound channels by zeroing their status bytes.
 */
function swiSoundChannelClear(cpu: ARM7TDMI): void {
  if (_soundAreaAddr === 0) return;
  const sa = _soundAreaAddr;

  const maxChans = cpu.read8(sa + SA_MAX_CHANS) || 8;
  for (let i = 0; i < maxChans; i++) {
    const ch = sa + SA_CHAN_BASE + i * SC_SIZE;
    // Clear the entire channel struct
    for (let j = 0; j < SC_SIZE; j += 4) {
      cpu.write32(ch + j, 0);
    }
  }
}
