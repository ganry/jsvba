// ============================================================================
// GBA Hardware Constants
// ============================================================================

// CPU Clock
export const CPU_FREQ = 16_777_216; // 16.78 MHz (2^24)

// Display Timing
export const SCREEN_WIDTH = 240;
export const SCREEN_HEIGHT = 160;
export const HDRAW_CYCLES = 960; // visible pixels (240 * 4)
export const HBLANK_CYCLES = 272; // HBlank period (68 * 4)
export const SCANLINE_CYCLES = 1232; // HDRAW + HBLANK
export const VDRAW_LINES = 160;
export const VBLANK_LINES = 68;
export const TOTAL_LINES = 228; // VDRAW + VBLANK
export const FRAME_CYCLES = SCANLINE_CYCLES * TOTAL_LINES; // 280,896

// Memory Region Sizes
export const BIOS_SIZE = 0x4000; // 16 KB
export const EWRAM_SIZE = 0x40000; // 256 KB
export const IWRAM_SIZE = 0x8000; // 32 KB
export const IO_SIZE = 0x400; // 1 KB
export const PALETTE_SIZE = 0x400; // 1 KB
export const VRAM_SIZE = 0x18000; // 96 KB
export const OAM_SIZE = 0x400; // 1 KB
export const ROM_MAX_SIZE = 0x2000000; // 32 MB
export const SRAM_SIZE = 0x10000; // 64 KB (max)

// Memory Region Base Addresses
export const BIOS_BASE = 0x00000000;
export const EWRAM_BASE = 0x02000000;
export const IWRAM_BASE = 0x03000000;
export const IO_BASE = 0x04000000;
export const PALETTE_BASE = 0x05000000;
export const VRAM_BASE = 0x06000000;
export const OAM_BASE = 0x07000000;
export const ROM_BASE_0 = 0x08000000;
export const ROM_BASE_1 = 0x0A000000;
export const ROM_BASE_2 = 0x0C000000;
export const SRAM_BASE = 0x0E000000;

// Memory Region Masks
export const EWRAM_MASK = 0x3FFFF;
export const IWRAM_MASK = 0x7FFF;
export const IO_MASK = 0x3FF;
export const PALETTE_MASK = 0x3FF;
export const VRAM_MASK = 0x1FFFF; // 128KB mirrored (96KB real)
export const OAM_MASK = 0x3FF;

// ============================================================================
// I/O Register Addresses (offsets from 0x04000000)
// ============================================================================

// Display
export const REG_DISPCNT = 0x000;
export const REG_GREENSWAP = 0x002;
export const REG_DISPSTAT = 0x004;
export const REG_VCOUNT = 0x006;

// Backgrounds
export const REG_BG0CNT = 0x008;
export const REG_BG1CNT = 0x00A;
export const REG_BG2CNT = 0x00C;
export const REG_BG3CNT = 0x00E;
export const REG_BG0HOFS = 0x010;
export const REG_BG0VOFS = 0x012;
export const REG_BG1HOFS = 0x014;
export const REG_BG1VOFS = 0x016;
export const REG_BG2HOFS = 0x018;
export const REG_BG2VOFS = 0x01A;
export const REG_BG3HOFS = 0x01C;
export const REG_BG3VOFS = 0x01E;

// BG2/3 Affine Parameters
export const REG_BG2PA = 0x020;
export const REG_BG2PB = 0x022;
export const REG_BG2PC = 0x024;
export const REG_BG2PD = 0x026;
export const REG_BG2X = 0x028; // 32-bit
export const REG_BG2Y = 0x02C; // 32-bit
export const REG_BG3PA = 0x030;
export const REG_BG3PB = 0x032;
export const REG_BG3PC = 0x034;
export const REG_BG3PD = 0x036;
export const REG_BG3X = 0x038; // 32-bit
export const REG_BG3Y = 0x03C; // 32-bit

// Windows
export const REG_WIN0H = 0x040;
export const REG_WIN1H = 0x042;
export const REG_WIN0V = 0x044;
export const REG_WIN1V = 0x046;
export const REG_WININ = 0x048;
export const REG_WINOUT = 0x04A;

// Mosaic & Effects
export const REG_MOSAIC = 0x04C;
export const REG_BLDCNT = 0x050;
export const REG_BLDALPHA = 0x052;
export const REG_BLDY = 0x054;

// Sound
export const REG_SOUND1CNT_L = 0x060;
export const REG_SOUND1CNT_H = 0x062;
export const REG_SOUND1CNT_X = 0x064;
export const REG_SOUND2CNT_L = 0x068;
export const REG_SOUND2CNT_H = 0x06C;
export const REG_SOUND3CNT_L = 0x070;
export const REG_SOUND3CNT_H = 0x072;
export const REG_SOUND3CNT_X = 0x074;
export const REG_SOUND4CNT_L = 0x078;
export const REG_SOUND4CNT_H = 0x07C;
export const REG_SOUNDCNT_L = 0x080;
export const REG_SOUNDCNT_H = 0x082;
export const REG_SOUNDCNT_X = 0x084;
export const REG_SOUNDBIAS = 0x088;
export const REG_WAVE_RAM = 0x090; // 0x090 - 0x09F

// FIFO
export const REG_FIFO_A = 0x0A0;
export const REG_FIFO_B = 0x0A4;

// DMA
export const REG_DMA0SAD = 0x0B0;
export const REG_DMA0DAD = 0x0B4;
export const REG_DMA0CNT_L = 0x0B8;
export const REG_DMA0CNT_H = 0x0BA;
export const REG_DMA1SAD = 0x0BC;
export const REG_DMA1DAD = 0x0C0;
export const REG_DMA1CNT_L = 0x0C4;
export const REG_DMA1CNT_H = 0x0C6;
export const REG_DMA2SAD = 0x0C8;
export const REG_DMA2DAD = 0x0CC;
export const REG_DMA2CNT_L = 0x0D0;
export const REG_DMA2CNT_H = 0x0D2;
export const REG_DMA3SAD = 0x0D4;
export const REG_DMA3DAD = 0x0D8;
export const REG_DMA3CNT_L = 0x0DC;
export const REG_DMA3CNT_H = 0x0DE;

// Timers
export const REG_TM0CNT_L = 0x100;
export const REG_TM0CNT_H = 0x102;
export const REG_TM1CNT_L = 0x104;
export const REG_TM1CNT_H = 0x106;
export const REG_TM2CNT_L = 0x108;
export const REG_TM2CNT_H = 0x10A;
export const REG_TM3CNT_L = 0x10C;
export const REG_TM3CNT_H = 0x10E;

// Serial / Joybus (stubbed)
export const REG_SIODATA32 = 0x120;
export const REG_SIOMULTI0 = 0x120;
export const REG_SIOMULTI1 = 0x122;
export const REG_SIOMULTI2 = 0x124;
export const REG_SIOMULTI3 = 0x126;
export const REG_SIOCNT = 0x128;
export const REG_SIOMLT_SEND = 0x12A;
export const REG_SIODATA8 = 0x12A;

// Keypad
export const REG_KEYINPUT = 0x130;
export const REG_KEYCNT = 0x132;

// Serial (cont.)
export const REG_RCNT = 0x134;
export const REG_JOYCNT = 0x140;
export const REG_JOY_RECV = 0x150;
export const REG_JOY_TRANS = 0x154;
export const REG_JOYSTAT = 0x158;

// Interrupts
export const REG_IE = 0x200;
export const REG_IF = 0x202;
export const REG_WAITCNT = 0x204;
export const REG_IME = 0x208;

// Post-Boot Flag
export const REG_POSTFLG = 0x300;
export const REG_HALTCNT = 0x301;

// ============================================================================
// Interrupt Bit Flags
// ============================================================================
export const IRQ_VBLANK = 1 << 0;
export const IRQ_HBLANK = 1 << 1;
export const IRQ_VCOUNT = 1 << 2;
export const IRQ_TIMER0 = 1 << 3;
export const IRQ_TIMER1 = 1 << 4;
export const IRQ_TIMER2 = 1 << 5;
export const IRQ_TIMER3 = 1 << 6;
export const IRQ_SERIAL = 1 << 7;
export const IRQ_DMA0 = 1 << 8;
export const IRQ_DMA1 = 1 << 9;
export const IRQ_DMA2 = 1 << 10;
export const IRQ_DMA3 = 1 << 11;
export const IRQ_KEYPAD = 1 << 12;
export const IRQ_GAMEPAK = 1 << 13;

// ============================================================================
// CPU Modes
// ============================================================================
export const MODE_USR = 0x10;
export const MODE_FIQ = 0x11;
export const MODE_IRQ = 0x12;
export const MODE_SVC = 0x13;
export const MODE_ABT = 0x17;
export const MODE_UND = 0x1B;
export const MODE_SYS = 0x1F;

// CPSR Flag Bits
export const CPSR_N = 1 << 31; // Negative
export const CPSR_Z = 1 << 30; // Zero
export const CPSR_C = 1 << 29; // Carry
export const CPSR_V = 1 << 28; // Overflow
export const CPSR_I = 1 << 7;  // IRQ disable
export const CPSR_F = 1 << 6;  // FIQ disable
export const CPSR_T = 1 << 5;  // Thumb state

// ============================================================================
// DMA Constants
// ============================================================================
export const DMA_TIMING_IMMEDIATE = 0;
export const DMA_TIMING_VBLANK = 1;
export const DMA_TIMING_HBLANK = 2;
export const DMA_TIMING_SPECIAL = 3;

export const DMA_INC = 0;
export const DMA_DEC = 1;
export const DMA_FIXED = 2;
export const DMA_INC_RELOAD = 3;

// ============================================================================
// Timer Prescaler Values
// ============================================================================
export const TIMER_PRESCALER = [1, 64, 256, 1024] as const;

// ============================================================================
// Display Constants
// ============================================================================
export const DISPCNT_MODE_MASK = 0x7;
export const DISPCNT_CGB = 1 << 3;
export const DISPCNT_FRAME_SELECT = 1 << 4;
export const DISPCNT_HBLANK_FREE = 1 << 5;
export const DISPCNT_OBJ_1D = 1 << 6;
export const DISPCNT_FORCED_BLANK = 1 << 7;
export const DISPCNT_BG0 = 1 << 8;
export const DISPCNT_BG1 = 1 << 9;
export const DISPCNT_BG2 = 1 << 10;
export const DISPCNT_BG3 = 1 << 11;
export const DISPCNT_OBJ = 1 << 12;
export const DISPCNT_WIN0 = 1 << 13;
export const DISPCNT_WIN1 = 1 << 14;
export const DISPCNT_OBJWIN = 1 << 15;

export const DISPSTAT_VBLANK = 1 << 0;
export const DISPSTAT_HBLANK = 1 << 1;
export const DISPSTAT_VCOUNTER = 1 << 2;
export const DISPSTAT_VBLANK_IRQ = 1 << 3;
export const DISPSTAT_HBLANK_IRQ = 1 << 4;
export const DISPSTAT_VCOUNTER_IRQ = 1 << 5;

// ============================================================================
// Button Bits (low-active in KEYINPUT, but we track as high-active internally)
// ============================================================================
export const KEY_A = 1 << 0;
export const KEY_B = 1 << 1;
export const KEY_SELECT = 1 << 2;
export const KEY_START = 1 << 3;
export const KEY_RIGHT = 1 << 4;
export const KEY_LEFT = 1 << 5;
export const KEY_UP = 1 << 6;
export const KEY_DOWN = 1 << 7;
export const KEY_R = 1 << 8;
export const KEY_L = 1 << 9;

// ============================================================================
// Scheduler Event Types
// ============================================================================
export const enum SchedulerEvent {
  HBlank,
  HBlankEnd,
  VBlank,
  VBlankEnd,
  Timer0Overflow,
  Timer1Overflow,
  Timer2Overflow,
  Timer3Overflow,
  DMA0,
  DMA1,
  DMA2,
  DMA3,
  APUSample,
}

// ============================================================================
// OAM / Sprite Constants
// ============================================================================
export const OAM_ENTRY_COUNT = 128;
export const OAM_ENTRY_SIZE = 8; // bytes

// Sprite sizes: indexed by [shape][size]
// shape: 0=square, 1=horizontal, 2=vertical
// size: 0-3
export const SPRITE_WIDTHS: readonly (readonly number[])[] = [
  [8, 16, 32, 64],  // Square
  [16, 32, 32, 64], // Horizontal
  [8, 8, 16, 32],   // Vertical
] as const;

export const SPRITE_HEIGHTS: readonly (readonly number[])[] = [
  [8, 16, 32, 64],  // Square
  [8, 8, 16, 32],   // Horizontal
  [16, 32, 32, 64], // Vertical
] as const;
