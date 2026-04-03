import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../core/types.js';

/**
 * Screen renderer — manages the canvas and displays GBA framebuffer output.
 */
export class Screen {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private imageData: ImageData;
  private pixels: Uint32Array;
  private scale = 3;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SCREEN_WIDTH;
    this.canvas.height = SCREEN_HEIGHT;
    this.canvas.className = 'gba-screen';

    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.ctx.imageSmoothingEnabled = false;

    this.imageData = this.ctx.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    this.pixels = new Uint32Array(this.imageData.data.buffer);
  }

  /** Render a framebuffer (Uint32Array RGBA8888) to the canvas */
  drawFrame(framebuffer: Uint32Array): void {
    this.pixels.set(framebuffer);
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  /** Set display scale (1x, 2x, 3x, or 0 for fit) */
  setScale(scale: number): void {
    this.scale = scale;
    this._updateSize();
  }

  /** Enter fullscreen */
  async enterFullscreen(): Promise<void> {
    // Fullscreen on the .shell element so toolbar + screen are both inside
    const shell = this.canvas.closest('.shell') as HTMLElement;
    if (shell) {
      await shell.requestFullscreen();
    }
  }

  private _updateSize(): void {
    if (this.scale === 0) {
      // Fit mode — handled by CSS
      this.canvas.style.width = '';
      this.canvas.style.height = '';
    } else {
      this.canvas.style.width = `${SCREEN_WIDTH * this.scale}px`;
      this.canvas.style.height = `${SCREEN_HEIGHT * this.scale}px`;
    }
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.canvas);
    this._updateSize();
  }
}
