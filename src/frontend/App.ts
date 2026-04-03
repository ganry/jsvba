import { GBA } from '../core/gba.js';
import { Screen } from './screen.js';
import { AudioOutput } from './audio-output.js';
import { InputManager, BUTTON_NAMES } from './input-manager.js';
import { RomLoader } from './rom-loader.js';
import { SaveStateManager } from './save-states.js';
import { DebugConsole } from './debug-console.js';
import { setLogSubscriber, setLogLevel, LogLevel } from '../utils/logger.js';
import {
  KEY_A, KEY_B, KEY_SELECT, KEY_START,
  KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT,
  KEY_L, KEY_R,
} from '../core/types.js';

const ALL_BUTTONS = [KEY_A, KEY_B, KEY_SELECT, KEY_START, KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_L, KEY_R];

export class App {
  readonly gba = new GBA();
  private screen = new Screen();
  private audio = new AudioOutput();
  private inputManager = new InputManager();
  private romLoader = new RomLoader();
  private saveStates = new SaveStateManager();
  private debugConsole = new DebugConsole();

  private root: HTMLElement;
  private screenContainer!: HTMLElement;
  private romPicker!: HTMLElement;
  private fileInput!: HTMLInputElement;
  private fpsDisplay!: HTMLElement;
  private gameTitleDisplay!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private settingsPanel!: HTMLElement;
  private settingsOverlay!: HTMLElement;
  private toastContainer!: HTMLElement;
  private settingsOpen = false;
  private romLoaded = false;
  private currentScale = 3;
  private frameCount = 0;
  private fpsTimer = 0;
  private displayFps = 0;

  constructor(rootElement: HTMLElement) {
    this.root = rootElement;
    this._buildUI();
    this._wireUp();
  }

  private _buildUI(): void {
    this.root.innerHTML = `
      <div class="shell">
        <!-- Toolbar -->
        <div class="toolbar">
          <div class="toolbar-brand">JSVBA<span>GBA Emulator</span></div>
          <div class="toolbar-divider"></div>

          <button class="toolbar-btn" id="btn-play" title="Play/Pause (Space)" disabled>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path class="play-icon" d="M4 2.5v11l9-5.5L4 2.5z"/>
            </svg>
          </button>
          <button class="toolbar-btn" id="btn-reset" title="Reset" disabled>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M2 8a6 6 0 1 1 1.76 4.24"/>
              <path d="M2 12V8h4"/>
            </svg>
          </button>

          <div class="toolbar-divider"></div>

          <div class="volume-group">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="color: var(--text-muted)">
              <path d="M8 2L4 6H1v4h3l4 4V2zM12.4 3.6a7 7 0 0 1 0 8.8M10.8 5.2a4 4 0 0 1 0 5.6"/>
            </svg>
            <input type="range" class="volume-slider" id="volume" min="0" max="100" value="50">
          </div>

          <div class="toolbar-spacer"></div>

          <span class="game-title" id="game-title"></span>
          <span class="fps-counter" id="fps-counter"></span>

          <div class="toolbar-divider"></div>

          <button class="toolbar-btn" id="btn-fullscreen" title="Fullscreen (F11)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3"/>
            </svg>
          </button>
          <button class="toolbar-btn" id="btn-settings" title="Settings">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="8" cy="8" r="2"/>
              <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M13.1 2.9l-1.4 1.4M4.3 11.7l-1.4 1.4"/>
            </svg>
          </button>
        </div>

        <!-- Screen Area -->
        <div class="screen-area">
          <!-- ROM Picker (shown before ROM load) -->
          <div class="rom-picker" id="rom-picker">
            <div class="rom-picker-icon"></div>
            <div class="rom-picker-text">Drop a .gba ROM here</div>
            <div class="rom-picker-hint">or click to browse</div>
          </div>

          <!-- Screen Container (shown after ROM load) -->
          <div class="screen-container" id="screen-container" style="display: none;"></div>
        </div>

        <!-- Settings Overlay -->
        <div class="settings-overlay" id="settings-overlay"></div>

        <!-- Settings Panel -->
        <div class="settings-panel" id="settings-panel">
          <div class="settings-header">
            <h2>Settings</h2>
            <button class="toolbar-btn" id="btn-settings-close">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 4l8 8M12 4l-8 8"/>
              </svg>
            </button>
          </div>
          <div class="settings-tabs">
            <button class="settings-tab active" data-tab="controls">Controls</button>
            <button class="settings-tab" data-tab="display">Display</button>
            <button class="settings-tab" data-tab="audio">Audio</button>
          </div>
          <div class="settings-body" id="settings-body"></div>
        </div>

        <!-- Toast Container -->
        <div class="toast-container" id="toast-container"></div>
      </div>
    `;

    // Cache DOM references
    this.screenContainer = this.root.querySelector('#screen-container')!;
    this.romPicker = this.root.querySelector('#rom-picker')!;
    this.fpsDisplay = this.root.querySelector('#fps-counter')!;
    this.gameTitleDisplay = this.root.querySelector('#game-title')!;
    this.playBtn = this.root.querySelector('#btn-play')!;
    this.settingsPanel = this.root.querySelector('#settings-panel')!;
    this.settingsOverlay = this.root.querySelector('#settings-overlay')!;
    this.toastContainer = this.root.querySelector('#toast-container')!;

    // Mount screen
    this.screen.mount(this.screenContainer);
    this.screen.setScale(this.currentScale);

    // Mount debug console on the screen area (so it overlays the game)
    const screenArea = this.root.querySelector('.screen-area')!;
    this.debugConsole.mount(screenArea as HTMLElement);

    // Route logger output to the debug console
    setLogLevel(LogLevel.Info);
    setLogSubscriber((level, msg) => this.debugConsole.log(level, msg));

    // File input
    this.fileInput = this.romLoader.createFileInput();
  }

  private _wireUp(): void {
    // Connect subsystems
    this.audio.connect(this.gba.getAPU());
    this.inputManager.connect(this.gba);
    this.inputManager.start();
    this.saveStates.connect(this.gba);

    // Frame callback — count actual GBA frames for FPS display
    this.gba.onFrame = (fb) => {
      this.screen.drawFrame(fb);
      this.frameCount++;
      const now = performance.now();
      if (now - this.fpsTimer >= 1000) {
        this.displayFps = this.frameCount;
        this.frameCount = 0;
        this.fpsTimer = now;
        this.fpsDisplay.textContent = `${this.displayFps} FPS`;
      }
    };

    // ROM loading
    this.romLoader.setCallback((data, filename) => {
      this._onRomLoaded(data, filename);
    });
    this.romLoader.setupDropZone(this.romPicker);

    this.romPicker.addEventListener('click', () => {
      this.fileInput.click();
    });

    // Toolbar buttons
    this.playBtn.addEventListener('click', () => this._togglePlay());

    this.root.querySelector('#btn-reset')!.addEventListener('click', () => {
      this.gba.reset();
      this.gba.start();
      this._showToast('Reset', 'info');
    });

    this.root.querySelector('#btn-fullscreen')!.addEventListener('click', () => {
      this.screen.enterFullscreen();
    });

    this.root.querySelector('#btn-settings')!.addEventListener('click', () => {
      this._toggleSettings();
    });

    this.root.querySelector('#btn-settings-close')!.addEventListener('click', () => {
      this._toggleSettings();
    });

    this.settingsOverlay.addEventListener('click', () => {
      this._toggleSettings();
    });

    // Volume
    const volumeSlider = this.root.querySelector('#volume') as HTMLInputElement;
    volumeSlider.addEventListener('input', () => {
      this.audio.volume = parseInt(volumeSlider.value) / 100;
    });

    // Settings tabs
    this.root.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.root.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this._renderSettingsTab((tab as HTMLElement).dataset.tab!);
      });
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') {
        e.preventDefault();
        this.debugConsole.toggle();
        return;
      }
      if (e.code === 'Space' && this.romLoaded && !this.settingsOpen) {
        e.preventDefault();
        this._togglePlay();
      }
      if (e.code === 'F11') {
        e.preventDefault();
        this.screen.enterFullscreen();
      }
      // Save states: F1-F4 save, Shift+F1-F4 load
      if (e.code.startsWith('F') && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const fNum = parseInt(e.code.slice(1));
        if (fNum >= 1 && fNum <= 4) {
          e.preventDefault();
          const slot = fNum - 1;
          if (e.shiftKey) {
            this.saveStates.loadState(slot).then(ok => {
              this._showToast(ok ? `Loaded slot ${fNum}` : `Slot ${fNum} empty`, ok ? 'success' : 'warning');
            });
          } else {
            this.saveStates.saveState(slot).then(() => {
              this._showToast(`Saved to slot ${fNum}`, 'success');
            });
          }
        }
      }
    });

    // Also allow drag-drop on the entire window
    this.romLoader.setupDropZone(document.body);

    // Initial settings render
    this._renderSettingsTab('controls');
    this.inputManager.onRebind = () => this._renderSettingsTab('controls');
  }

  private _onRomLoaded(data: ArrayBuffer, filename: string): void {
    this.gba.loadROM(data);
    this.romLoaded = true;

    // Switch UI from picker to screen
    this.romPicker.style.display = 'none';
    this.screenContainer.style.display = '';
    this.screenContainer.classList.add('scale-in');

    // Enable toolbar buttons
    this.playBtn.disabled = false;
    (this.root.querySelector('#btn-reset') as HTMLButtonElement).disabled = false;

    // Show game title
    this.gameTitleDisplay.textContent = this.gba.gameTitle || filename;

    // Start emulation
    this.gba.start();
    this.audio.start();
    this._updatePlayButton(true);

    this._showToast(`${this.gba.gameTitle || filename} loaded`, 'success');
  }

  private _togglePlay(): void {
    if (!this.romLoaded) return;
    this.gba.togglePause();
    this._updatePlayButton(this.gba.isRunning);

    if (this.gba.isRunning) {
      this.audio.start();
    }
  }

  private _updatePlayButton(playing: boolean): void {
    const svg = this.playBtn.querySelector('svg')!;
    if (playing) {
      svg.innerHTML = '<rect x="3" y="3" width="3.5" height="10" rx="0.5" fill="currentColor"/><rect x="9.5" y="3" width="3.5" height="10" rx="0.5" fill="currentColor"/>';
      this.screenContainer.classList.add('playing');
    } else {
      svg.innerHTML = '<path d="M4 2.5v11l9-5.5L4 2.5z" fill="currentColor"/>';
      this.screenContainer.classList.remove('playing');
    }
  }

  private _toggleSettings(): void {
    this.settingsOpen = !this.settingsOpen;
    this.settingsPanel.classList.toggle('open', this.settingsOpen);
    this.settingsOverlay.classList.toggle('open', this.settingsOpen);
    // Suppress game input while settings is open
    this.inputManager.settingsOpen = this.settingsOpen;
  }

  private _renderSettingsTab(tab: string): void {
    const body = this.root.querySelector('#settings-body')!;

    switch (tab) {
      case 'controls':
        body.innerHTML = `
          <div class="settings-section">
            <h3>Button Mapping</h3>
            ${ALL_BUTTONS.map(btn => `
              <div class="control-row">
                <span class="control-label">${BUTTON_NAMES[btn]}</span>
                <button class="control-key" data-button="${btn}">
                  ${this._formatKeyName(this.inputManager.getKeyForButton(btn))}
                </button>
              </div>
            `).join('')}
          </div>
          <div style="text-align: center; padding-top: 8px;">
            <button class="btn btn-sm" id="btn-reset-controls">Reset to Defaults</button>
          </div>
        `;

        // Bind click handlers for rebinding
        body.querySelectorAll('.control-key').forEach(el => {
          el.addEventListener('click', () => {
            const btn = parseInt((el as HTMLElement).dataset.button!);
            el.classList.add('listening');
            el.textContent = 'Press a key...';
            this.inputManager.rebind(btn).then(key => {
              el.classList.remove('listening');
              el.textContent = this._formatKeyName(key);
            });
          });
        });

        body.querySelector('#btn-reset-controls')?.addEventListener('click', () => {
          this.inputManager.resetToDefaults();
          this._showToast('Controls reset', 'info');
        });
        break;

      case 'display':
        body.innerHTML = `
          <div class="settings-section">
            <h3>Screen Scale</h3>
            <div class="scale-group">
              ${[1, 2, 3, 4].map(s => `
                <button class="scale-btn ${s === this.currentScale ? 'active' : ''}" data-scale="${s}">${s}x</button>
              `).join('')}
              <button class="scale-btn ${this.currentScale === 0 ? 'active' : ''}" data-scale="0">Fit</button>
            </div>
          </div>
          <div class="settings-section">
            <h3>Save States</h3>
            <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">
              F1-F4 to save, Shift+F1-F4 to load
            </p>
            <div class="save-slots" id="save-slots"></div>
          </div>
        `;

        body.querySelectorAll('.scale-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            this.currentScale = parseInt((btn as HTMLElement).dataset.scale!);
            this.screen.setScale(this.currentScale);
            body.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          });
        });

        this._renderSaveSlots();
        break;

      case 'audio':
        body.innerHTML = `
          <div class="settings-section">
            <h3>Volume</h3>
            <div style="display: flex; align-items: center; gap: 12px;">
              <input type="range" class="volume-slider" id="settings-volume" min="0" max="100" value="${(this.audio.volume * 100) | 0}" style="width: 100%;">
              <span style="font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); min-width: 36px;">${(this.audio.volume * 100) | 0}%</span>
            </div>
          </div>
        `;

        const sv = body.querySelector('#settings-volume') as HTMLInputElement;
        sv?.addEventListener('input', () => {
          this.audio.volume = parseInt(sv.value) / 100;
          const label = sv.nextElementSibling as HTMLElement;
          if (label) label.textContent = `${sv.value}%`;
          (this.root.querySelector('#volume') as HTMLInputElement).value = sv.value;
        });
        break;
    }
  }

  private _renderSaveSlots(): void {
    const container = this.root.querySelector('#save-slots');
    if (!container) return;

    const slots = this.saveStates.getSlots();
    container.innerHTML = slots.map((slot, i) => `
      <div class="save-slot" data-slot="${i}">
        <div class="save-slot-thumb">
          ${slot?.thumbnail
            ? `<img src="${slot.thumbnail}" alt="Slot ${i + 1}">`
            : `<span class="save-slot-empty">Empty</span>`
          }
        </div>
        <div class="save-slot-info">Slot ${i + 1} ${slot ? `- ${slot.title}` : ''}</div>
        ${slot ? `<div class="save-slot-time">${new Date(slot.timestamp).toLocaleString()}</div>` : ''}
      </div>
    `).join('');
  }

  private _formatKeyName(code: string): string {
    return code
      .replace('Key', '')
      .replace('Arrow', '')
      .replace('Digit', '')
      .replace('Backspace', 'Bksp');
  }

  private _showToast(message: string, type: 'success' | 'warning' | 'error' | 'info' = 'info'): void {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    this.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 200);
    }, 2500);
  }
}
