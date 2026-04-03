/**
 * GBA PSG (Programmable Sound Generator)
 * 4 legacy Game Boy sound channels.
 */

/** Channel 1: Square wave with sweep and envelope */
export class PulseChannel {
  enabled = false;
  private sweepPeriod = 0;
  private sweepShift = 0;
  private sweepNegate = false;
  private sweepTimer = 0;
  private sweepShadow = 0;
  private sweepEnabled = false;

  private duty = 2; // 0-3
  private lengthCounter = 0;
  private lengthEnabled = false;

  private envelopeVolume = 0;
  private envelopeDirection = 0; // 0=decrease, 1=increase
  private envelopePeriod = 0;
  private envelopeTimer = 0;
  private volume = 0;

  private frequency = 0;
  private timer = 0;
  private phase = 0;

  private static DUTY_TABLE = [
    [0, 0, 0, 0, 0, 0, 0, 1], // 12.5%
    [1, 0, 0, 0, 0, 0, 0, 1], // 25%
    [1, 0, 0, 0, 0, 1, 1, 1], // 50%
    [0, 1, 1, 1, 1, 1, 1, 0], // 75%
  ];

  writeSweep(value: number): void {
    this.sweepPeriod = (value >>> 4) & 7;
    this.sweepNegate = ((value >>> 3) & 1) !== 0;
    this.sweepShift = value & 7;
  }

  writeDutyLength(value: number): void {
    this.duty = (value >>> 6) & 3;
    this.lengthCounter = 64 - (value & 0x3F);
  }

  writeEnvelope(value: number): void {
    this.volume = (value >>> 4) & 0xF;
    this.envelopeDirection = (value >>> 3) & 1;
    this.envelopePeriod = value & 7;
    // Writing envelope configures DAC power but does NOT enable the channel.
    // Only _trigger() enables the channel. However, if DAC is powered off
    // (volume=0 AND direction=decrease), the channel is forced off.
    if (this.volume === 0 && this.envelopeDirection === 0) {
      this.enabled = false;
    }
  }

  writeFrequency(value: number): void {
    this.frequency = ((value & 7) << 8) | (this.frequency & 0xFF);
    this.lengthEnabled = ((value >>> 6) & 1) !== 0;
    if (value & (1 << 7)) this._trigger();
  }

  writeFrequencyLow(value: number): void {
    this.frequency = (this.frequency & 0x700) | (value & 0xFF);
  }

  private _trigger(): void {
    this.enabled = true;
    if (this.lengthCounter === 0) this.lengthCounter = 64;
    this.timer = (2048 - this.frequency) * 4;
    this.envelopeVolume = this.volume;
    this.envelopeTimer = this.envelopePeriod;
    this.sweepShadow = this.frequency;
    this.sweepTimer = this.sweepPeriod || 8;
    this.sweepEnabled = this.sweepPeriod > 0 || this.sweepShift > 0;
  }

  /** Generate one sample (-1.0 to 1.0) */
  sample(): number {
    if (!this.enabled) return 0;
    return PulseChannel.DUTY_TABLE[this.duty][this.phase] * (this.envelopeVolume / 15.0) * 2 - (this.envelopeVolume / 15.0);
  }

  /** Clock at sample rate */
  clock(ticks: number): void {
    this.timer -= ticks;
    while (this.timer <= 0) {
      this.timer += (2048 - this.frequency) * 4;
      this.phase = (this.phase + 1) & 7;
    }
  }

  clockLength(): void {
    if (this.lengthEnabled && this.lengthCounter > 0) {
      this.lengthCounter--;
      if (this.lengthCounter === 0) this.enabled = false;
    }
  }

  clockEnvelope(): void {
    if (this.envelopePeriod === 0) return;
    this.envelopeTimer--;
    if (this.envelopeTimer <= 0) {
      this.envelopeTimer = this.envelopePeriod;
      if (this.envelopeDirection === 1 && this.envelopeVolume < 15) {
        this.envelopeVolume++;
      } else if (this.envelopeDirection === 0 && this.envelopeVolume > 0) {
        this.envelopeVolume--;
      }
    }
  }

  clockSweep(): void {
    if (!this.sweepEnabled || this.sweepPeriod === 0) return;
    this.sweepTimer--;
    if (this.sweepTimer <= 0) {
      this.sweepTimer = this.sweepPeriod;
      const delta = this.sweepShadow >> this.sweepShift;
      const newFreq = this.sweepNegate ? this.sweepShadow - delta : this.sweepShadow + delta;
      if (newFreq > 2047) {
        this.enabled = false;
      } else if (this.sweepShift > 0) {
        this.sweepShadow = newFreq;
        this.frequency = newFreq;
      }
    }
  }

  reset(): void {
    this.enabled = false;
    this.phase = 0;
    this.timer = 0;
    this.volume = 0;
    this.envelopeVolume = 0;
  }
}

/** Channel 3: Wave channel (4-bit samples) */
export class WaveChannel {
  enabled = false;
  private waveRam = new Uint8Array(16); // 32 4-bit samples
  private lengthCounter = 0;
  private lengthEnabled = false;
  private volumeShift = 0; // 0=mute, 1=100%, 2=50%, 3=25%
  private frequency = 0;
  private timer = 0;
  private position = 0;
  private bankMode = 0;
  private currentBank = 0;
  private dacEnabled = false;

  writeDACEnable(value: number): void {
    this.dacEnabled = (value & (1 << 7)) !== 0;
    this.bankMode = (value >>> 5) & 1;
    this.currentBank = (value >>> 6) & 1;
    if (!this.dacEnabled) this.enabled = false;
  }

  writeLength(value: number): void {
    this.lengthCounter = 256 - (value & 0xFF);
  }

  writeVolume(value: number): void {
    this.volumeShift = (value >>> 5) & 3;
  }

  writeFrequencyLow(value: number): void {
    this.frequency = (this.frequency & 0x700) | (value & 0xFF);
  }

  writeFrequencyHigh(value: number): void {
    this.frequency = ((value & 7) << 8) | (this.frequency & 0xFF);
    this.lengthEnabled = ((value >>> 6) & 1) !== 0;
    if (value & (1 << 7)) this._trigger();
  }

  writeWaveRam(offset: number, value: number): void {
    this.waveRam[offset & 0xF] = value;
  }

  readWaveRam(offset: number): number {
    return this.waveRam[offset & 0xF];
  }

  private _trigger(): void {
    this.enabled = this.dacEnabled;
    if (this.lengthCounter === 0) this.lengthCounter = 256;
    this.timer = (2048 - this.frequency) * 2;
    this.position = 0;
  }

  sample(): number {
    if (!this.enabled) return 0;
    const byteIdx = this.position >>> 1;
    const nibble = (this.position & 1) === 0
      ? (this.waveRam[byteIdx] >>> 4)
      : (this.waveRam[byteIdx] & 0xF);

    let shifted: number;
    switch (this.volumeShift) {
      case 0: shifted = 0; break;
      case 1: shifted = nibble; break;
      case 2: shifted = nibble >> 1; break;
      case 3: shifted = nibble >> 2; break;
      default: shifted = 0;
    }

    return (shifted / 15.0) * 2 - 1;
  }

  clock(ticks: number): void {
    this.timer -= ticks;
    while (this.timer <= 0) {
      this.timer += (2048 - this.frequency) * 2;
      this.position = (this.position + 1) & 31;
    }
  }

  clockLength(): void {
    if (this.lengthEnabled && this.lengthCounter > 0) {
      this.lengthCounter--;
      if (this.lengthCounter === 0) this.enabled = false;
    }
  }

  reset(): void {
    this.enabled = false;
    this.position = 0;
    this.timer = 0;
    this.waveRam.fill(0);
  }
}

/** Channel 4: Noise channel (LFSR) */
export class NoiseChannel {
  enabled = false;
  private lengthCounter = 0;
  private lengthEnabled = false;
  private envelopeVolume = 0;
  private envelopeDirection = 0;
  private envelopePeriod = 0;
  private envelopeTimer = 0;
  private volume = 0;
  private shiftClockFreq = 0;
  private counterWidth = 0; // 0=15-bit, 1=7-bit
  private dividingRatio = 0;
  private timer = 0;
  private lfsr = 0x7FFF;

  writeLengthEnvelope(value: number): void {
    this.lengthCounter = 64 - (value & 0x3F);
  }

  writeEnvelope(value: number): void {
    this.volume = (value >>> 4) & 0xF;
    this.envelopeDirection = (value >>> 3) & 1;
    this.envelopePeriod = value & 7;
    // DAC power off: volume=0 and direction=decrease → disable channel
    if (this.volume === 0 && this.envelopeDirection === 0) {
      this.enabled = false;
    }
  }

  writeFrequency(value: number): void {
    this.shiftClockFreq = (value >>> 4) & 0xF;
    this.counterWidth = (value >>> 3) & 1;
    this.dividingRatio = value & 7;
    this.timer = this._getPeriod();
  }

  writeControl(value: number): void {
    this.lengthEnabled = ((value >>> 6) & 1) !== 0;
    if (value & (1 << 7)) this._trigger();
  }

  private _trigger(): void {
    this.enabled = true;
    if (this.lengthCounter === 0) this.lengthCounter = 64;
    this.timer = this._getPeriod();
    this.lfsr = this.counterWidth ? 0x7F : 0x7FFF;
    this.envelopeVolume = this.volume;
    this.envelopeTimer = this.envelopePeriod;
  }

  private _getPeriod(): number {
    const r = this.dividingRatio === 0 ? 0.5 : this.dividingRatio;
    return (r * (1 << (this.shiftClockFreq + 1))) | 0;
  }

  sample(): number {
    if (!this.enabled) return 0;
    const bit = ~this.lfsr & 1;
    return bit * (this.envelopeVolume / 15.0) * 2 - (this.envelopeVolume / 15.0);
  }

  clock(ticks: number): void {
    this.timer -= ticks;
    while (this.timer <= 0) {
      this.timer += this._getPeriod() || 1;
      const bit = (this.lfsr ^ (this.lfsr >>> 1)) & 1;
      this.lfsr = (this.lfsr >>> 1) | (bit << (this.counterWidth ? 6 : 14));
    }
  }

  clockLength(): void {
    if (this.lengthEnabled && this.lengthCounter > 0) {
      this.lengthCounter--;
      if (this.lengthCounter === 0) this.enabled = false;
    }
  }

  clockEnvelope(): void {
    if (this.envelopePeriod === 0) return;
    this.envelopeTimer--;
    if (this.envelopeTimer <= 0) {
      this.envelopeTimer = this.envelopePeriod;
      if (this.envelopeDirection === 1 && this.envelopeVolume < 15) {
        this.envelopeVolume++;
      } else if (this.envelopeDirection === 0 && this.envelopeVolume > 0) {
        this.envelopeVolume--;
      }
    }
  }

  reset(): void {
    this.enabled = false;
    this.lfsr = 0x7FFF;
    this.timer = 0;
    this.volume = 0;
    this.envelopeVolume = 0;
  }
}
