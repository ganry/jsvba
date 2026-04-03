# JSVBA

A fast, cycle-accurate Game Boy Advance emulator that runs entirely in your browser. Built from scratch with TypeScript.

**[Launch Emulator](https://indeveloper.de/jsvba-app/)** | **[Product Page](https://indeveloper.de/jsvba/)**

## Features

- **Drag & Drop** — Load any `.gba` ROM file instantly
- **Save States** — 4 persistent slots with thumbnails (F1-F4 save, Shift+F1-F4 load)
- **Full Audio** — 4 PSG channels + 2 DMA FIFO channels via Web Audio API
- **Custom Controls** — Rebindable keyboard mappings, persistent between sessions
- **Pixel Perfect** — 1x-4x scaling, fit-to-window, fullscreen, no interpolation
- **Debug Console** — Toggleable overlay for emulator diagnostics (backtick key)
- **Zero Server** — Runs 100% client-side, no data ever leaves your browser

## Architecture

| Component | Description |
|-----------|-------------|
| **CPU** | Full ARM7TDMI with ARM and Thumb instruction sets |
| **PPU** | Scanline renderer, 6 display modes, sprites, backgrounds, blending, windows |
| **APU** | PSG (pulse, wave, noise) + DMA FIFO sound channels |
| **Memory** | BIOS (HLE), EWRAM, IWRAM, VRAM, OAM, Palette, I/O registers |
| **DMA** | 4-channel DMA controller with immediate, VBlank, HBlank, and sound triggers |
| **Timers** | 4 hardware timers with cascade and prescaler support |
| **Saves** | SRAM, Flash (64K/128K), and EEPROM with auto-detection |

## Getting Started

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Run tests
npm run test

# Production build
npm run build
```

## Tech Stack

- **TypeScript** — Strict mode, ES2022 target
- **Vite** — Dev server and production bundler
- **Vitest** — Unit and integration testing
- **Web Audio API** — Real-time audio output
- **Canvas 2D** — Pixel-perfect rendering

## Legal Notice

JSVBA is an independently developed, open-source software emulator. It does not host, distribute, store, or temporarily cache any ROM files or copyrighted game data. No ROM data is ever uploaded to or transmitted through any server. Users are responsible for providing their own legally obtained ROM files.

Game Boy Advance and Nintendo are trademarks of Nintendo Co., Ltd. JSVBA is not affiliated with or endorsed by Nintendo.

## License

MIT

---

Built by [garrik.design](https://garrik.design)
