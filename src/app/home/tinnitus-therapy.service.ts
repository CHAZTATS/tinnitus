import { Injectable } from '@angular/core';

export type ModulationType = 'amp' | 'phase';

@Injectable({
  providedIn: 'root',
})
export class TinnitusTherapyService {
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private pannerNode: StereoPannerNode | null = null;

  private isPlaying = false;
  private nextScheduleTime = 0;
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;

  private readonly sampleRate = 44100;
  private readonly stimulusDuration = 4;
  private readonly rampProportion = 0.25;
  private readonly f0Range = [96, 256] as const;
  private readonly tmr = 1;
  private readonly smrRange = [1.5, 7.5] as const;
  private readonly smrCycleDuration = 8;
  private readonly depth = 1;
  private readonly loud = 0.1;
  private readonly scheduleAheadTime = 8;
  private readonly schedulerLookaheadMs = 1000;

  private readonly fbands: [number, number][];
  private readonly standardBandOffset = 4;
  private readonly hlCorrTemplate = [
    0, 0, 0, 0, 0, 0, 0, 0.125, 0.25, 0.375, 0.5, 0.5,
  ];

  public tinnitusFreq = 8000;
  public hearingCorrectionMax = 30;
  public modType: ModulationType = 'amp';
  public volume = 0.3;
  public pan = 0;

  public constructor() {
    const fb: number[] = [];
    for (let i = -4; i <= 8; i += 1) {
      fb.push(1000 * Math.pow(2, i * 0.5));
    }

    const bands: [number, number][] = [];
    for (let i = 0; i < 12; i += 1) {
      bands.push([fb[i], fb[i + 1]]);
    }
    this.fbands = bands;
  }

  private ensureContext(): void {
    if (!this.audioContext) {
      this.audioContext = new (
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext!
      )({
        sampleRate: this.sampleRate,
      });

      this.masterGain = this.audioContext.createGain();
      this.pannerNode = this.audioContext.createStereoPanner();

      this.masterGain.connect(this.pannerNode);
      this.pannerNode.connect(this.audioContext.destination);
    }

    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume();
    }
  }

  public getRuntimeDiagnostics(): {
    state: AudioContextState;
    currentTime: number;
    sampleRate: number;
  } | null {
    if (!this.audioContext) {
      return null;
    }

    return {
      state: this.audioContext.state,
      currentTime: this.audioContext.currentTime,
      sampleRate: this.audioContext.sampleRate,
    };
  }

  public setVolume(value: number): void {
    this.volume = value;
    if (this.masterGain && this.audioContext) {
      this.masterGain.gain.setValueAtTime(value, this.audioContext.currentTime);
    }
  }

  public setPan(value: number): void {
    this.pan = value;
    if (this.pannerNode && this.audioContext) {
      this.pannerNode.pan.setValueAtTime(value, this.audioContext.currentTime);
    }
  }

  public start(): void {
    this.ensureContext();
    if (!this.audioContext || !this.masterGain) {
      return;
    }

    this.isPlaying = true;
    this.nextScheduleTime = this.audioContext.currentTime;
    this.masterGain.gain.setValueAtTime(
      this.volume,
      this.audioContext.currentTime,
    );
    this.setPan(this.pan);
    this.runScheduler();
    this.startSchedulerLoop();
  }

  public stop(): void {
    this.isPlaying = false;

    this.stopSchedulerLoop();

    if (this.masterGain && this.audioContext) {
      this.masterGain.gain.setValueAtTime(0, this.audioContext.currentTime);
    }
  }

  public previewTone(freq: number, duration = 0.5): void {
    this.ensureContext();
    if (!this.audioContext) {
      return;
    }

    const numSamples = Math.floor(duration * this.sampleRate);
    const buffer = this.audioContext.createBuffer(
      1,
      numSamples,
      this.sampleRate,
    );
    const data = buffer.getChannelData(0);

    for (let i = 0; i < numSamples; i += 1) {
      const t = i / this.sampleRate;
      data[i] = 0.2 * Math.sin(2 * Math.PI * freq * t);
    }

    const rampSamples = Math.floor(0.05 * this.sampleRate);
    for (let i = 0; i < rampSamples; i += 1) {
      const rampValue = 0.5 * (1 - Math.cos((Math.PI * i) / rampSamples));
      data[i] *= rampValue;
      data[numSamples - 1 - i] *= rampValue;
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    const gain = this.audioContext.createGain();
    gain.gain.setValueAtTime(this.volume, this.audioContext.currentTime);
    source.connect(gain);
    gain.connect(this.audioContext.destination);
    source.start();
  }

  public destroy(): void {
    this.stop();
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
      this.masterGain = null;
      this.pannerNode = null;
    }
  }

  private getModulationBandIndex(tinnitusFreq: number): number {
    let bestIndex = this.standardBandOffset + 5;
    let minDist = Number.POSITIVE_INFINITY;

    for (let b = 0; b < this.fbands.length - 1; b += 1) {
      const lowFreq = this.fbands[b][0];
      const highFreq = this.fbands[b + 1][1];
      const center = Math.sqrt(lowFreq * highFreq);
      const dist = Math.abs(Math.log2(tinnitusFreq / center));
      if (dist < minDist) {
        minDist = dist;
        bestIndex = b;
      }
    }

    return bestIndex;
  }

  private generateFallbackBuffer(numSamples: number): AudioBuffer {
    if (!this.audioContext) {
      throw new Error('AudioContext not initialized');
    }

    const buffer = this.audioContext.createBuffer(
      1,
      numSamples,
      this.sampleRate,
    );
    const data = buffer.getChannelData(0);
    for (let i = 0; i < numSamples; i += 1) {
      data[i] = (Math.random() * 2 - 1) * 0.1;
    }
    return buffer;
  }

  private generateStimulus(): AudioBuffer {
    if (!this.audioContext) {
      throw new Error('AudioContext not initialized');
    }

    const duration = this.stimulusDuration;
    const numSamples = Math.floor(duration * this.sampleRate);
    const rampDuration = duration * this.rampProportion;

    const f0 = Math.round(
      this.f0Range[0] + Math.random() * (this.f0Range[1] - this.f0Range[0]),
    );

    const modBandIndex = this.getModulationBandIndex(this.tinnitusFreq);
    const modBandIndices = [modBandIndex, modBandIndex + 1];

    const phaseOff = Math.random() * 2 * Math.PI;
    const phaseS = Math.random() * 2 * Math.PI;

    const fbandDb = this.hlCorrTemplate.map(
      (t) => t * this.hearingCorrectionMax,
    );

    const minFreq = modBandIndices.some((i) => i < this.standardBandOffset)
      ? 250
      : 1000;

    const harmonics: Array<{
      freq: number;
      bandIdx: number;
      isModulated: boolean;
      intensity: number;
    }> = [];

    for (let bandIdx = 0; bandIdx < this.fbands.length; bandIdx += 1) {
      const frange = this.fbands[bandIdx];
      const nMin = Math.ceil(frange[0] / f0);
      const nMax = Math.floor((frange[1] - 1) / f0);

      for (let n = nMin; n <= nMax; n += 1) {
        const freq = n * f0;
        if (freq >= minFreq && freq < 16000) {
          harmonics.push({
            freq,
            bandIdx,
            isModulated: modBandIndices.includes(bandIdx),
            intensity: Math.pow(10, fbandDb[bandIdx] / 20),
          });
        }
      }
    }

    const modulatedHarmonics = harmonics.filter((h) => h.isModulated);
    if (modulatedHarmonics.length === 0) {
      return this.generateFallbackBuffer(numSamples);
    }

    const modulatedFreqs = modulatedHarmonics.map((h) => h.freq);
    const minModFreq = Math.min(...modulatedFreqs);

    const logDistances = modulatedFreqs.map((f) => Math.log2(f / minModFreq));
    const meanLogDist =
      logDistances.reduce((a, b) => a + b, 0) / logDistances.length;
    const centeredDistances = logDistances.map((d) => d - meanLogDist);

    const freqToDistance = new Map<number, number>();
    modulatedFreqs.forEach((f, i) => {
      freqToDistance.set(f, centeredDistances[i]);
    });

    const smrMean = (this.smrRange[0] + this.smrRange[1]) / 2;
    const smrAmplitude = (this.smrRange[1] - this.smrRange[0]) / 2;

    const buffer = this.audioContext.createBuffer(
      1,
      numSamples,
      this.sampleRate,
    );
    const data = buffer.getChannelData(0);

    for (const harmonic of harmonics) {
      const freq = harmonic.freq;
      const intensity = harmonic.intensity;

      for (let i = 0; i < numSamples; i += 1) {
        const t = (i + 1) / this.sampleRate;
        let sample: number;

        if (harmonic.isModulated) {
          const smr =
            smrMean +
            smrAmplitude *
              Math.sin(phaseS + (2 * Math.PI * t) / this.smrCycleDuration);
          const fDist = freqToDistance.get(freq) ?? 0;
          const modPhase =
            2 * Math.PI * (phaseOff + this.tmr * t + smr * fDist);

          if (this.modType === 'amp') {
            const modValue = 1 + this.depth * Math.sin(modPhase);
            sample = modValue * Math.sin(2 * Math.PI * freq * t) * intensity;
          } else {
            const phaseShift =
              (Math.PI * (1 + this.depth * Math.sin(modPhase))) / 2;
            sample = Math.sin(2 * Math.PI * freq * t + phaseShift) * intensity;
          }
        } else {
          sample = Math.sin(2 * Math.PI * freq * t) * intensity;
        }

        data[i] += sample;
      }
    }

    let sumSq = 0;
    for (let i = 0; i < numSamples; i += 1) {
      sumSq += data[i] * data[i];
    }

    const rms = Math.sqrt(sumSq / numSamples);
    const scale = this.loud / (10 * rms);
    for (let i = 0; i < numSamples; i += 1) {
      data[i] *= scale;
    }

    const rampSamples = Math.round(2 * rampDuration * this.sampleRate);
    const halfRamp = Math.round(rampSamples / 2);

    for (let i = 0; i < halfRamp; i += 1) {
      const w = -Math.PI / 2 + 2 * Math.PI * (i / (rampSamples - 1));
      const rampValue = (Math.sin(w) + 1) / 2;
      data[i] *= rampValue;
    }

    for (let i = 0; i < halfRamp; i += 1) {
      const idx = numSamples - halfRamp + i;
      const wIdx = halfRamp + i;
      const w = -Math.PI / 2 + 2 * Math.PI * (wIdx / (rampSamples - 1));
      const rampValue = (Math.sin(w) + 1) / 2;
      if (idx < numSamples) {
        data[idx] *= rampValue;
      }
    }

    let maxAbs = 0;
    for (let i = 0; i < numSamples; i += 1) {
      maxAbs = Math.max(maxAbs, Math.abs(data[i]));
    }

    if (maxAbs > 1) {
      for (let i = 0; i < numSamples; i += 1) {
        data[i] /= maxAbs;
      }
    }

    return buffer;
  }

  private startSchedulerLoop(): void {
    this.stopSchedulerLoop();

    this.schedulerInterval = setInterval(() => {
      this.runScheduler();
    }, this.schedulerLookaheadMs);
  }

  private stopSchedulerLoop(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
  }

  private runScheduler(): void {
    if (!this.audioContext || !this.masterGain || !this.isPlaying) {
      return;
    }

    const currentTime = this.audioContext.currentTime;
    if (this.nextScheduleTime < currentTime) {
      this.nextScheduleTime = currentTime;
    }

    while (this.nextScheduleTime < currentTime + this.scheduleAheadTime) {
      this.scheduleStimulusAt(this.nextScheduleTime);
      this.nextScheduleTime += this.stimulusDuration;
    }
  }

  private scheduleStimulusAt(startTime: number): void {
    if (!this.audioContext || !this.masterGain || !this.isPlaying) {
      return;
    }

    const buffer = this.generateStimulus();
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.masterGain);
    source.start(startTime);
  }
}
