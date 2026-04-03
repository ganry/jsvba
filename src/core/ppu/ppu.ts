import type { Scheduler } from '../scheduler.js';
import type { InterruptController } from '../interrupts.js';
import type { DMAController } from '../dma.js';
import type { MMU } from '../memory/mmu.js';
import type { IORegisters } from '../memory/io.js';
import { getColorLUT } from './palette.js';
import { renderTextBG, renderAffineBG, renderMode3, renderMode4, renderMode5 } from './backgrounds.js';
import { renderSprites } from './sprites.js';
import { computeWindowMask, alphaBlend, brighten, darken } from './effects.js';
import {
  SCREEN_WIDTH, SCREEN_HEIGHT,
  SCANLINE_CYCLES, HDRAW_CYCLES, HBLANK_CYCLES,
  VDRAW_LINES, TOTAL_LINES,
  IRQ_VBLANK, IRQ_HBLANK, IRQ_VCOUNT,
  REG_DISPCNT, REG_DISPSTAT, REG_VCOUNT,
  REG_BLDCNT, REG_BLDALPHA, REG_BLDY,
  DISPCNT_MODE_MASK, DISPCNT_BG0, DISPCNT_BG1, DISPCNT_BG2, DISPCNT_BG3,
  DISPCNT_OBJ, DISPCNT_FORCED_BLANK, DISPCNT_WIN0, DISPCNT_WIN1, DISPCNT_OBJWIN,
  DISPSTAT_VBLANK, DISPSTAT_HBLANK, DISPSTAT_VCOUNTER,
  DISPSTAT_VBLANK_IRQ, DISPSTAT_HBLANK_IRQ, DISPSTAT_VCOUNTER_IRQ,
} from '../types.js';

const colorLUT = getColorLUT();

// Blend modes from BLDCNT bits 6-7
const BLEND_NONE = 0;
const BLEND_ALPHA = 1;
const BLEND_BRIGHTEN = 2;
const BLEND_DARKEN = 3;

export class PPU {
  /** RGBA8888 framebuffer (240x160) */
  framebuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);

  /** Current scanline */
  vcount = 0;

  /** DISPSTAT register (managed here, read via IO callback) */
  private dispstat = 0;

  /** Callback when a frame is complete */
  onFrameComplete: (() => void) | null = null;

  // Per-layer color buffers: 0=BG0, 1=BG1, 2=BG2, 3=BG3, 4=OBJ
  private layerColors: Uint32Array[] = [
    new Uint32Array(SCREEN_WIDTH),
    new Uint32Array(SCREEN_WIDTH),
    new Uint32Array(SCREEN_WIDTH),
    new Uint32Array(SCREEN_WIDTH),
    new Uint32Array(SCREEN_WIDTH),
  ];

  // OBJ per-pixel priority (0-3 from OAM attr2)
  private objPriorities = new Uint8Array(SCREEN_WIDTH);
  // OBJ semi-transparent flag (GFX mode 1)
  private objSemiTransparent = new Uint8Array(SCREEN_WIDTH);
  // OBJ window mask (GFX mode 2 sprites)
  private objWindowLine = new Uint8Array(SCREEN_WIDTH);
  // Per-pixel window flags
  private windowMask = new Uint8Array(SCREEN_WIDTH);

  // Compositing output line
  private compositeLine = new Uint32Array(SCREEN_WIDTH);

  // Temp buffer for BG priority output (not used in compositing, but needed by render functions)
  private _bgPriTemp = new Uint8Array(SCREEN_WIDTH);

  // Affine BG reference points (latched on VBlank, incremented per scanline)
  private bg2RefX = 0;
  private bg2RefY = 0;
  private bg3RefX = 0;
  private bg3RefY = 0;

  constructor(
    private scheduler: Scheduler,
    private irq: InterruptController,
    private dma: DMAController,
    private mmu: MMU,
    private io: IORegisters,
  ) {
    // Register IO read/write callbacks for PPU registers
    io.ppuReadCallback = (offset: number) => this._readPpuReg(offset);
    io.ppuWriteCallback = (_offset: number, value: number) => this.writeDispstat(value);
  }

  start(startScanline = 0): void {
    this.vcount = startScanline;

    // Set VBlank flag if starting in VBlank period
    if (startScanline >= VDRAW_LINES && startScanline < TOTAL_LINES) {
      this.dispstat |= DISPSTAT_VBLANK;
    }

    // Schedule the first HBlank
    this.scheduler.schedule(HDRAW_CYCLES, () => this._onHBlank());
  }

  private _readPpuReg(offset: number): number {
    switch (offset) {
      case REG_DISPSTAT:
        return this.dispstat;
      case REG_VCOUNT:
        return this.vcount;
      default:
        return 0;
    }
  }

  private _onHBlank(): void {
    // Set HBlank flag
    this.dispstat |= DISPSTAT_HBLANK;

    // Render the scanline (during visible lines)
    if (this.vcount < VDRAW_LINES) {
      this._renderScanline();
    }

    // HBlank IRQ
    if (this.dispstat & DISPSTAT_HBLANK_IRQ) {
      this.irq.requestInterrupt(IRQ_HBLANK);
    }

    // Trigger HBlank DMAs
    if (this.vcount < VDRAW_LINES) {
      this.dma.triggerHBlank();
    }

    // Schedule end of HBlank (start of next scanline)
    this.scheduler.schedule(HBLANK_CYCLES, () => this._onHBlankEnd());
  }

  private _onHBlankEnd(): void {
    // Clear HBlank flag
    this.dispstat &= ~DISPSTAT_HBLANK;

    // Advance to next scanline
    this.vcount = (this.vcount + 1) % TOTAL_LINES;

    // VCount match check
    const vCountSetting = (this.dispstat >>> 8) & 0xFF;
    if (this.vcount === vCountSetting) {
      this.dispstat |= DISPSTAT_VCOUNTER;
      if (this.dispstat & DISPSTAT_VCOUNTER_IRQ) {
        this.irq.requestInterrupt(IRQ_VCOUNT);
      }
    } else {
      this.dispstat &= ~DISPSTAT_VCOUNTER;
    }

    if (this.vcount === VDRAW_LINES) {
      // Enter VBlank
      this._onVBlank();
    } else if (this.vcount === 0) {
      // End of VBlank — new frame
      this.dispstat &= ~DISPSTAT_VBLANK;

      // Latch affine reference points
      this._latchAffineRefPoints();
    }

    // Schedule next HBlank
    this.scheduler.schedule(HDRAW_CYCLES, () => this._onHBlank());
  }

  private _onVBlank(): void {
    this.dispstat |= DISPSTAT_VBLANK;

    // VBlank IRQ
    if (this.dispstat & DISPSTAT_VBLANK_IRQ) {
      this.irq.requestInterrupt(IRQ_VBLANK);
    }

    // Trigger VBlank DMAs
    this.dma.triggerVBlank();

    // Frame complete callback
    if (this.onFrameComplete) {
      this.onFrameComplete();
    }
  }

  private _dbgCounter = 0;

  private _renderScanline(): void {
    const dispcnt = this.io.read16(REG_DISPCNT);
    const mode = dispcnt & DISPCNT_MODE_MASK;
    const y = this.vcount;
    const lineOffset = y * SCREEN_WIDTH;

    // Forced blank — white screen
    if (dispcnt & DISPCNT_FORCED_BLANK) {
      this.framebuffer.fill(0xFFFFFFFF, lineOffset, lineOffset + SCREEN_WIDTH);
      return;
    }

    // Get backdrop color (palette entry 0)
    const backdrop = colorLUT[this.mmu.palette16[0] & 0x7FFF];

    // Clear per-layer buffers (0 = transparent)
    for (let i = 0; i < 5; i++) this.layerColors[i].fill(0);
    this.objPriorities.fill(4);
    this.objSemiTransparent.fill(0);
    this.objWindowLine.fill(0);

    // Render BG layers into separate per-layer buffers
    switch (mode) {
      case 0:
        // Mode 0: 4 text BGs
        if (dispcnt & DISPCNT_BG0) renderTextBG(this.layerColors[0], this._bgPriTemp, 0, y, this.mmu, this.io);
        if (dispcnt & DISPCNT_BG1) renderTextBG(this.layerColors[1], this._bgPriTemp, 1, y, this.mmu, this.io);
        if (dispcnt & DISPCNT_BG2) renderTextBG(this.layerColors[2], this._bgPriTemp, 2, y, this.mmu, this.io);
        if (dispcnt & DISPCNT_BG3) renderTextBG(this.layerColors[3], this._bgPriTemp, 3, y, this.mmu, this.io);
        break;
      case 1:
        // Mode 1: 2 text BGs + 1 affine BG (BG2)
        if (dispcnt & DISPCNT_BG0) renderTextBG(this.layerColors[0], this._bgPriTemp, 0, y, this.mmu, this.io);
        if (dispcnt & DISPCNT_BG1) renderTextBG(this.layerColors[1], this._bgPriTemp, 1, y, this.mmu, this.io);
        if (dispcnt & DISPCNT_BG2) this._renderAffineToLayer(2, y);
        break;
      case 2:
        // Mode 2: 2 affine BGs
        if (dispcnt & DISPCNT_BG2) this._renderAffineToLayer(2, y);
        if (dispcnt & DISPCNT_BG3) this._renderAffineToLayer(3, y);
        break;
      case 3:
        // Mode 3: 240x160 16-bit bitmap (BG2)
        if (dispcnt & DISPCNT_BG2) renderMode3(this.layerColors[2], y, this.mmu);
        break;
      case 4:
        // Mode 4: 240x160 8-bit indexed (BG2)
        if (dispcnt & DISPCNT_BG2) renderMode4(this.layerColors[2], y, this.mmu, this.io);
        break;
      case 5:
        // Mode 5: 160x128 16-bit bitmap (BG2)
        if (dispcnt & DISPCNT_BG2) renderMode5(this.layerColors[2], y, this.mmu, this.io);
        break;
    }

    // Render sprites (fills layerColors[4], objPriorities, objSemiTransparent, objWindowLine)
    if (dispcnt & DISPCNT_OBJ) {
      renderSprites(
        this.layerColors[4], this.objPriorities,
        this.objSemiTransparent, this.objWindowLine,
        y, this.mmu, this.io,
      );
    }

    // Compute per-pixel window mask
    const hasObjWin = (dispcnt & DISPCNT_OBJWIN) !== 0;
    computeWindowMask(this.windowMask, y, this.io, hasObjWin ? this.objWindowLine : null);

    // Debug: log PPU state every ~2 seconds
    if (y === 80 && ++this._dbgCounter % 120 === 0) {
      const bldcnt = this.io.read16(REG_BLDCNT);
      const bldy = this.io.read16(REG_BLDY);
      const bldalpha_dbg = this.io.read16(REG_BLDALPHA);
      const win0h = this.io.read16(0x040);
      const win0v = this.io.read16(0x044);
      const winin = this.io.read16(0x048);
      const winout = this.io.read16(0x04A);
      let layerInfo = '';
      for (let l = 0; l < 5; l++) {
        let count = 0;
        for (let x = 0; x < 240; x++) if (this.layerColors[l][x] !== 0) count++;
        if (count > 0) layerInfo += ` L${l}:${count}`;
      }
      console.log(`[PPU] DISPCNT=0x${dispcnt.toString(16)} mode=${mode} ` +
        `BGs=${(dispcnt>>8)&0xF} OBJ=${(dispcnt>>12)&1} ` +
        `WIN0=${(dispcnt>>13)&1} WIN1=${(dispcnt>>14)&1} ` +
        `BLDCNT=0x${bldcnt.toString(16)} blend=${(bldcnt>>6)&3} ` +
        `1st=0x${(bldcnt&0x3F).toString(16)} 2nd=0x${((bldcnt>>8)&0x3F).toString(16)} ` +
        `BLDALPHA=0x${bldalpha_dbg.toString(16)} BLDY=0x${bldy.toString(16)} ` +
        `WIN0H=0x${win0h.toString(16)} WIN0V=0x${win0v.toString(16)} ` +
        `WININ=0x${winin.toString(16)} WINOUT=0x${winout.toString(16)} ` +
        `winMask[120]=0x${this.windowMask[120].toString(16)} ` +
        `Layers:${layerInfo || ' NONE'} ` +
        `backdrop=0x${this.mmu.palette16[0].toString(16)}`);
    }

    // Read blend registers
    const bldcnt = this.io.read16(REG_BLDCNT);
    const bldalpha = this.io.read16(REG_BLDALPHA);
    const bldy = this.io.read16(REG_BLDY);
    const blendMode = (bldcnt >>> 6) & 3;
    const firstTarget = bldcnt & 0x3F;
    const secondTarget = (bldcnt >>> 8) & 0x3F;
    let eva = bldalpha & 0x1F;
    if (eva > 16) eva = 16;
    let evb = (bldalpha >>> 8) & 0x1F;
    if (evb > 16) evb = 16;
    let evy = bldy & 0x1F;
    if (evy > 16) evy = 16;

    // Read BG priorities from BGxCNT (bits 0-1)
    const bgPri0 = this.io.read16(0x008) & 3;
    const bgPri1 = this.io.read16(0x00A) & 3;
    const bgPri2 = this.io.read16(0x00C) & 3;
    const bgPri3 = this.io.read16(0x00E) & 3;

    // Which BGs are enabled in DISPCNT
    const bg0On = (dispcnt & DISPCNT_BG0) !== 0;
    const bg1On = (dispcnt & DISPCNT_BG1) !== 0;
    const bg2On = (dispcnt & DISPCNT_BG2) !== 0;
    const bg3On = (dispcnt & DISPCNT_BG3) !== 0;
    const objOn = (dispcnt & DISPCNT_OBJ) !== 0;

    // Pre-build sorted list of (priority, layerIndex) for BGs that are enabled
    // Lower priority number = higher priority. At same priority, lower BG number wins.
    // We also need OBJ interleaved per-pixel (since OBJ priority varies per pixel).
    const bgPriArr = [bgPri0, bgPri1, bgPri2, bgPri3];
    const bgEnabled = [bg0On, bg1On, bg2On, bg3On];

    // Per-pixel compositing with window masking and blending
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      const winFlags = this.windowMask[x];
      let topColor = backdrop;
      let topLayer = 5; // 5 = backdrop
      let botColor = backdrop;
      let botLayer = 5;
      let foundTop = false;
      let semiTrans = false;

      // Find top two visible layers in priority order (0 = highest, 3 = lowest)
      // At each priority level: OBJ first, then BG0, BG1, BG2, BG3
      layerSearch:
      for (let pri = 0; pri <= 3; pri++) {
        // Check OBJ at this priority
        if (objOn && (winFlags & 0x10) && this.layerColors[4][x] !== 0 && this.objPriorities[x] === pri) {
          if (!foundTop) {
            topColor = this.layerColors[4][x];
            topLayer = 4;
            semiTrans = this.objSemiTransparent[x] !== 0;
            foundTop = true;
          } else {
            botColor = this.layerColors[4][x];
            botLayer = 4;
            break layerSearch;
          }
        }

        // Check BGs at this priority (BG0 first = highest sub-priority)
        for (let bg = 0; bg < 4; bg++) {
          if (!bgEnabled[bg]) continue;
          if (!(winFlags & (1 << bg))) continue;
          if (bgPriArr[bg] !== pri) continue;
          if (this.layerColors[bg][x] === 0) continue;

          if (!foundTop) {
            topColor = this.layerColors[bg][x];
            topLayer = bg;
            foundTop = true;
          } else {
            botColor = this.layerColors[bg][x];
            botLayer = bg;
            break layerSearch;
          }
        }
      }

      // Apply blending effects
      let finalColor = topColor;
      const effectsOn = (winFlags & 0x20) !== 0;

      if (semiTrans && effectsOn) {
        // Semi-transparent OBJ: always alpha blend (ignores BLDCNT mode),
        // but second target must still match BLDCNT second target bits
        if (secondTarget & (1 << botLayer)) {
          finalColor = alphaBlend(topColor, botColor, eva, evb);
        }
      } else if (effectsOn && blendMode !== BLEND_NONE) {
        if (blendMode === BLEND_ALPHA) {
          if ((firstTarget & (1 << topLayer)) && (secondTarget & (1 << botLayer))) {
            finalColor = alphaBlend(topColor, botColor, eva, evb);
          }
        } else if (blendMode === BLEND_BRIGHTEN) {
          if (firstTarget & (1 << topLayer)) {
            finalColor = brighten(topColor, evy);
          }
        } else if (blendMode === BLEND_DARKEN) {
          if (firstTarget & (1 << topLayer)) {
            finalColor = darken(topColor, evy);
          }
        }
      }

      this.compositeLine[x] = finalColor;
    }

    // Copy to framebuffer
    this.framebuffer.set(this.compositeLine, lineOffset);
  }

  /** Render an affine BG directly into its layer buffer */
  private _renderAffineToLayer(bgIndex: number, y: number): void {
    const refX = bgIndex === 2 ? this.bg2RefX : this.bg3RefX;
    const refY = bgIndex === 2 ? this.bg2RefY : this.bg3RefY;

    const [newRefX, newRefY] = renderAffineBG(
      this.layerColors[bgIndex], this._bgPriTemp, bgIndex, y, this.mmu, this.io, refX, refY
    );

    if (bgIndex === 2) {
      this.bg2RefX = newRefX;
      this.bg2RefY = newRefY;
    } else {
      this.bg3RefX = newRefX;
      this.bg3RefY = newRefY;
    }
  }

  private _latchAffineRefPoints(): void {
    // Read BG2 reference point from I/O
    const bg2xLo = this.io.read16(0x028);
    const bg2xHi = this.io.read16(0x02A);
    this.bg2RefX = ((bg2xHi << 16) | bg2xLo) << 4 >> 4; // Sign extend 28-bit

    const bg2yLo = this.io.read16(0x02C);
    const bg2yHi = this.io.read16(0x02E);
    this.bg2RefY = ((bg2yHi << 16) | bg2yLo) << 4 >> 4;

    const bg3xLo = this.io.read16(0x038);
    const bg3xHi = this.io.read16(0x03A);
    this.bg3RefX = ((bg3xHi << 16) | bg3xLo) << 4 >> 4;

    const bg3yLo = this.io.read16(0x03C);
    const bg3yHi = this.io.read16(0x03E);
    this.bg3RefY = ((bg3yHi << 16) | bg3yLo) << 4 >> 4;
  }

  /** Write to DISPSTAT register (only writable bits) */
  writeDispstat(value: number): void {
    // Bits 0-2 are read-only (status flags), bits 3-15 are writable
    this.dispstat = (this.dispstat & 0x07) | (value & 0xFFF8);
  }

  reset(): void {
    this.framebuffer.fill(0);
    this.vcount = 0;
    this.dispstat = 0;
    this.bg2RefX = 0;
    this.bg2RefY = 0;
    this.bg3RefX = 0;
    this.bg3RefY = 0;
  }

}
