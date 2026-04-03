/**
 * Game Pak — ROM + Save Media
 *
 * ROM is mirrored across 0x08, 0x0A, 0x0C regions.
 * Save type is auto-detected by scanning ROM for ID strings.
 */

export const enum SaveType {
  None,
  SRAM,
  Flash64K,
  Flash128K,
  EEPROM,
}

/** EEPROM serial protocol states */
const enum EepromState {
  Idle,
  ReadAddress,
  ReadDummy,
  ReadData,
  WriteAddress,
  WriteData,
  WriteConfirm,
}

export class GamePak {
  rom = new Uint8Array(0);
  romView16!: Uint16Array;
  romView32!: DataView;
  romMask = 0;

  saveType = SaveType.None;
  sram = new Uint8Array(0x10000); // 64KB max SRAM
  flash = new Uint8Array(0x20000); // 128KB max flash
  eeprom = new Uint8Array(0x2000); // 8KB max EEPROM

  // Flash state machine
  private flashState = 0;
  private flashBank = 0;
  private flashChipId = false;

  // EEPROM serial protocol state
  private eepromState = EepromState.Idle;
  private eepromCmd = 0;        // 2-bit command being built
  private eepromCmdBits = 0;    // bits received for command
  private eepromAddr = 0;       // address being built
  private eepromAddrBits = 0;   // address bits received
  eepromAddrSize = 0;   // 6 or 14 (auto-detected from DMA word count)
  private eepromBuffer = 0n;    // 64-bit data buffer (BigInt for 64 bits)
  private eepromDataBits = 0;   // data bits received/sent
  private eepromOutput = 1;     // output bit (read returns this)

  title = '';
  gameCode = '';

  loadROM(data: ArrayBuffer): void {
    this.rom = new Uint8Array(data);

    // Create aligned views — ROM must be power-of-2 for masking
    const size = this._nextPow2(this.rom.length);
    if (size !== this.rom.length) {
      const padded = new Uint8Array(size);
      padded.set(this.rom);
      this.rom = padded;
    }
    this.romMask = size - 1;

    // DataView for 32-bit reads (handles alignment)
    const buf = this.rom.buffer;
    this.romView32 = new DataView(buf, this.rom.byteOffset, this.rom.byteLength);

    // 16-bit view if aligned
    if (this.rom.byteOffset % 2 === 0) {
      this.romView16 = new Uint16Array(buf, this.rom.byteOffset, this.rom.byteLength >> 1);
    }

    this._parseHeader();
    this._detectSaveType();
  }

  read8(addr: number): number {
    return this.rom[addr & this.romMask];
  }

  read16(addr: number): number {
    const offset = addr & this.romMask;
    return this.rom[offset] | (this.rom[offset + 1] << 8);
  }

  read32(addr: number): number {
    const offset = addr & this.romMask;
    return (
      this.rom[offset] |
      (this.rom[offset + 1] << 8) |
      (this.rom[offset + 2] << 16) |
      (this.rom[offset + 3] << 24)
    ) >>> 0;
  }

  // SRAM read/write
  readSRAM(addr: number): number {
    if (this.saveType === SaveType.SRAM) {
      return this.sram[addr & 0x7FFF];
    }
    if (this.saveType === SaveType.Flash64K || this.saveType === SaveType.Flash128K) {
      return this._readFlash(addr);
    }
    return 0xFF;
  }

  writeSRAM(addr: number, val: number): void {
    if (this.saveType === SaveType.SRAM) {
      this.sram[addr & 0x7FFF] = val;
      return;
    }
    if (this.saveType === SaveType.Flash64K || this.saveType === SaveType.Flash128K) {
      this._writeFlash(addr, val);
    }
  }

  private _readFlash(addr: number): number {
    if (this.flashChipId) {
      // Return chip ID
      const offset = addr & 1;
      if (this.saveType === SaveType.Flash128K) {
        return offset === 0 ? 0x62 : 0x13; // Sanyo 128K
      }
      return offset === 0 ? 0xBF : 0xD4; // SST 64K
    }
    const bankOffset = this.flashBank * 0x10000;
    return this.flash[(addr & 0xFFFF) + bankOffset];
  }

  private _writeFlash(addr: number, val: number): void {
    const a = addr & 0xFFFF;

    switch (this.flashState) {
      case 0:
        if (a === 0x5555 && val === 0xAA) this.flashState = 1;
        break;
      case 1:
        if (a === 0x2AAA && val === 0x55) this.flashState = 2;
        else this.flashState = 0;
        break;
      case 2:
        if (a === 0x5555) {
          switch (val) {
            case 0x90: // Enter chip ID mode
              this.flashChipId = true;
              this.flashState = 0;
              break;
            case 0xF0: // Exit chip ID mode
              this.flashChipId = false;
              this.flashState = 0;
              break;
            case 0x80: // Erase prepare
              this.flashState = 3;
              break;
            case 0xA0: // Write byte prepare
              this.flashState = 4;
              break;
            case 0xB0: // Bank switch (128K only)
              this.flashState = 5;
              break;
            default:
              this.flashState = 0;
          }
        } else {
          this.flashState = 0;
        }
        break;
      case 3: // Erase - waiting for second AA/55 sequence
        if (a === 0x5555 && val === 0xAA) this.flashState = 6;
        else this.flashState = 0;
        break;
      case 4: // Write single byte
        {
          const bankOffset = this.flashBank * 0x10000;
          this.flash[a + bankOffset] &= val; // Flash can only clear bits
          this.flashState = 0;
        }
        break;
      case 5: // Bank switch
        if (a === 0x0000) {
          this.flashBank = val & 1;
        }
        this.flashState = 0;
        break;
      case 6:
        if (a === 0x2AAA && val === 0x55) this.flashState = 7;
        else this.flashState = 0;
        break;
      case 7: // Erase command
        if (a === 0x5555 && val === 0x10) {
          // Erase entire chip
          this.flash.fill(0xFF);
        } else if (val === 0x30) {
          // Erase 4KB sector
          const sector = (a & 0xF000) + this.flashBank * 0x10000;
          this.flash.fill(0xFF, sector, sector + 0x1000);
        }
        this.flashState = 0;
        break;
    }
  }

  // =========================================================================
  // EEPROM serial protocol
  // =========================================================================

  /** Read EEPROM ready/busy status without advancing the serial protocol.
   *  Used for CPU reads — games poll this after a write to check completion. */
  readEEPROMStatus(): number {
    return this.eepromOutput;
  }

  /** Read one bit from EEPROM (returns 0 or 1 in bit 0) — advances serial clock.
   *  Only called during DMA reads. */
  readEEPROM(): number {
    // Return current output bit, then advance the serial clock
    // During DMA reads, each read clocks the EEPROM to shift out the next bit
    const output = this.eepromOutput;

    switch (this.eepromState) {
      case EepromState.ReadDummy:
        this.eepromDataBits++;
        if (this.eepromDataBits >= 4) {
          this.eepromDataBits = 0;
          this.eepromState = EepromState.ReadData;
          // Set first data bit (MSB of 64-bit buffer)
          this.eepromOutput = Number((this.eepromBuffer >> 63n) & 1n);
        }
        break;

      case EepromState.ReadData:
        this.eepromDataBits++;
        if (this.eepromDataBits < 64) {
          this.eepromBuffer <<= 1n;
          this.eepromOutput = Number((this.eepromBuffer >> 63n) & 1n);
        } else {
          this.eepromOutput = 1; // bus idles high
          this.eepromState = EepromState.Idle;
        }
        break;
    }

    return output;
  }

  /** Write one bit to EEPROM (bit 0 of value) */
  writeEEPROM(val: number): void {
    const bit = val & 1;

    switch (this.eepromState) {
      case EepromState.Idle:
        // Receiving 2-bit command (MSB first): 11 = read, 10 = write
        this.eepromCmd = (this.eepromCmd << 1) | bit;
        this.eepromCmdBits++;
        if (this.eepromCmdBits >= 2) {
          this.eepromAddr = 0;
          this.eepromAddrBits = 0;
          if (this.eepromCmd === 0b11) {
            this.eepromState = EepromState.ReadAddress;
          } else if (this.eepromCmd === 0b10) {
            this.eepromState = EepromState.WriteAddress;
          }
          this.eepromCmd = 0;
          this.eepromCmdBits = 0;
        }
        break;

      case EepromState.ReadAddress:
        // Receiving address bits (MSB first)
        this.eepromAddr = (this.eepromAddr << 1) | bit;
        this.eepromAddrBits++;
        // Auto-detect address size: if we get the end-of-address marker
        if (this._isAddressComplete()) {
          // Load 64 bits (8 bytes) from EEPROM into buffer
          this._loadEepromBlock();
          this.eepromDataBits = 0;
          this.eepromState = EepromState.ReadDummy;
        }
        break;

      case EepromState.ReadDummy:
      case EepromState.ReadData:
        // End bit after address — absorbed without advancing state.
        // The read phase is driven entirely by readEEPROM() during DMA reads.
        break;

      case EepromState.WriteAddress:
        // Receiving address bits (MSB first)
        this.eepromAddr = (this.eepromAddr << 1) | bit;
        this.eepromAddrBits++;
        if (this._isAddressComplete()) {
          this.eepromBuffer = 0n;
          this.eepromDataBits = 0;
          this.eepromState = EepromState.WriteData;
        }
        break;

      case EepromState.WriteData:
        // Receiving 64 data bits (MSB first)
        this.eepromBuffer = (this.eepromBuffer << 1n) | BigInt(bit);
        this.eepromDataBits++;
        if (this.eepromDataBits >= 64) {
          this.eepromState = EepromState.WriteConfirm;
        }
        break;

      case EepromState.WriteConfirm:
        // Final dummy bit — commit the write
        this._storeEepromBlock();
        this.eepromOutput = 1; // ready
        this.eepromState = EepromState.Idle;
        break;
    }
  }

  private _isAddressComplete(): boolean {
    // eepromAddrSize is set externally by the DMA controller based on
    // the DMA word count (the only reliable detection method).
    // Fallback: if not yet set, use ROM size heuristic.
    if (this.eepromAddrSize === 0) {
      // Still no DMA-based detection — use ROM size as last resort
      if (this.eepromAddrBits >= 14) {
        this.eepromAddrSize = 14;
        return true;
      }
      if (this.eepromAddrBits >= 6) {
        if (this.rom.length <= 0x1000000) {
          // ROMs ≤ 16MB: assume 6-bit addressing (512B EEPROM)
          this.eepromAddrSize = 6;
          return true;
        }
      }
      return false;
    }
    return this.eepromAddrBits >= this.eepromAddrSize;
  }

  private _loadEepromBlock(): void {
    const addr = this.eepromAddr * 8; // Each block is 8 bytes
    this.eepromBuffer = 0n;
    for (let i = 0; i < 8; i++) {
      const byte = addr + i < this.eeprom.length ? this.eeprom[addr + i] : 0xFF;
      this.eepromBuffer = (this.eepromBuffer << 8n) | BigInt(byte);
    }
  }

  private _storeEepromBlock(): void {
    const addr = this.eepromAddr * 8;
    for (let i = 7; i >= 0; i--) {
      if (addr + i < this.eeprom.length) {
        this.eeprom[addr + i] = Number(this.eepromBuffer & 0xFFn);
      }
      this.eepromBuffer >>= 8n;
    }
  }

  /** Get save data for persistence */
  getSaveData(): Uint8Array | null {
    switch (this.saveType) {
      case SaveType.SRAM:
        return new Uint8Array(this.sram.buffer.slice(0, 0x8000));
      case SaveType.Flash64K:
        return new Uint8Array(this.flash.buffer.slice(0, 0x10000));
      case SaveType.Flash128K:
        return new Uint8Array(this.flash.buffer.slice(0, 0x20000));
      case SaveType.EEPROM:
        return new Uint8Array(this.eeprom.buffer.slice(0));
      default:
        return null;
    }
  }

  /** Load save data from persistence */
  loadSaveData(data: Uint8Array): void {
    switch (this.saveType) {
      case SaveType.SRAM:
        this.sram.set(data.subarray(0, 0x8000));
        break;
      case SaveType.Flash64K:
        this.flash.set(data.subarray(0, 0x10000));
        break;
      case SaveType.Flash128K:
        this.flash.set(data.subarray(0, 0x20000));
        break;
      case SaveType.EEPROM:
        this.eeprom.set(data.subarray(0, this.eeprom.length));
        break;
    }
  }

  private _parseHeader(): void {
    // Game title at 0xA0 (12 bytes)
    let title = '';
    for (let i = 0; i < 12; i++) {
      const c = this.rom[0xA0 + i];
      if (c === 0) break;
      title += String.fromCharCode(c);
    }
    this.title = title;

    // Game code at 0xAC (4 bytes)
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += String.fromCharCode(this.rom[0xAC + i]);
    }
    this.gameCode = code;
  }

  private _detectSaveType(): void {
    // Scan ROM for save type ID strings
    const text = new TextDecoder('ascii').decode(this.rom);

    if (text.includes('EEPROM_V')) {
      this.saveType = SaveType.EEPROM;
    } else if (text.includes('SRAM_V') || text.includes('SRAM_F_V')) {
      this.saveType = SaveType.SRAM;
    } else if (text.includes('FLASH1M_V')) {
      this.saveType = SaveType.Flash128K;
    } else if (text.includes('FLASH512_V') || text.includes('FLASH_V')) {
      this.saveType = SaveType.Flash64K;
    } else {
      this.saveType = SaveType.None;
    }
  }

  private _nextPow2(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  reset(): void {
    this.sram.fill(0xFF);
    this.flash.fill(0xFF);
    this.eeprom.fill(0xFF);
    this.flashState = 0;
    this.flashBank = 0;
    this.flashChipId = false;
    this.eepromState = EepromState.Idle;
    this.eepromCmd = 0;
    this.eepromCmdBits = 0;
    this.eepromAddr = 0;
    this.eepromAddrBits = 0;
    // Don't reset eepromAddrSize — it persists after detection
    this.eepromBuffer = 0n;
    this.eepromDataBits = 0;
    this.eepromOutput = 1;
  }
}
