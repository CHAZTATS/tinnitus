import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonRange,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

type ModulationType = 'amp' | 'phase';
type RangeValue = number | { lower: number; upper: number } | null;

interface SessionEntry {
  start: number;
  end: number;
  duration: number;
}

interface DaySummary {
  day: string;
  durationMs: number;
}

interface SavedSettings {
  freqIndex: number;
  volume: number;
  hearingProfile: string;
  modType: ModulationType;
  pan: number;
}

class SessionTracker {
  private readonly storageKey = 'tinnitus-sessions';
  private currentSessionStart: number | null = null;

  public getSessions(): SessionEntry[] {
    const data = localStorage.getItem(this.storageKey);
    if (!data) {
      return [];
    }

    try {
      const parsed = JSON.parse(data) as SessionEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveSessions(sessions: SessionEntry[]): void {
    localStorage.setItem(this.storageKey, JSON.stringify(sessions));
  }

  public startSession(): void {
    this.currentSessionStart = Date.now();
  }

  public endSession(): void {
    if (!this.currentSessionStart) {
      return;
    }

    const end = Date.now();
    const durationMs = end - this.currentSessionStart;
    const durationMinutes = durationMs / 60000;

    if (durationMinutes >= 1) {
      const sessions = this.getSessions();
      sessions.push({
        start: this.currentSessionStart,
        end,
        duration: durationMs,
      });
      this.saveSessions(sessions);
    }

    this.currentSessionStart = null;
  }

  public getSessionsByDay(): DaySummary[] {
    const sessions = this.getSessions();
    const byDay = new Map<string, number>();

    for (const session of sessions) {
      const day = new Date(session.start).toLocaleDateString('fr-FR', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      byDay.set(day, (byDay.get(day) ?? 0) + session.duration);
    }

    return Array.from(byDay.entries()).map(([day, durationMs]) => ({
      day,
      durationMs,
    }));
  }
}

class TinnitusTherapyGenerator {
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private pannerNode: StereoPannerNode | null = null;
  private analyser: AnalyserNode | null = null;

  private isPlaying = false;
  private nextScheduleTime = 0;
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly sampleRate = 44100;
  private readonly stimulusDuration = 4;
  private readonly rampProportion = 0.25;
  private readonly f0Range = [96, 256] as const;
  private readonly tmr = 1;
  private readonly smrRange = [1.5, 7.5] as const;
  private readonly smrCycleDuration = 8;
  private readonly depth = 1;
  private readonly loud = 0.1;

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
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;

      this.masterGain.connect(this.pannerNode);
      this.pannerNode.connect(this.audioContext.destination);
      this.pannerNode.connect(this.analyser);
    }

    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume();
    }
  }

  public getAnalyser(): AnalyserNode | null {
    return this.analyser;
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
    this.scheduleNextStimulus();
  }

  public stop(): void {
    this.isPlaying = false;

    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }

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
      this.analyser = null;
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

  private scheduleNextStimulus(): void {
    if (!this.audioContext || !this.masterGain || !this.isPlaying) {
      return;
    }

    const buffer = this.generateStimulus();
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.masterGain);

    const currentTime = this.audioContext.currentTime;
    const startTime = Math.max(currentTime, this.nextScheduleTime);
    source.start(startTime);
    this.nextScheduleTime = startTime + this.stimulusDuration;

    const scheduleAhead = (this.stimulusDuration - 0.5) * 1000;
    this.schedulerTimer = setTimeout(
      () => this.scheduleNextStimulus(),
      scheduleAhead,
    );
  }
}

const SETTINGS_KEY = 'tinnitus-settings';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [
    CommonModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonButton,
    IonRange,
    IonSelect,
    IonSelectOption,
    IonItem,
    IonLabel,
    IonList,
  ],
})
export class HomePage implements AfterViewInit, OnDestroy {
  @ViewChild('visualizer', { static: false })
  private visualizerRef?: ElementRef<HTMLCanvasElement>;

  public readonly frequencies = [
    1000, 1200, 1400, 1700, 2000, 2400, 2800, 3400, 4000, 4800, 5700, 6700,
    8000, 9500, 11000, 13000, 16000,
  ];
  public readonly hearingProfiles = [
    { label: 'Normal hearing', value: '0' },
    { label: 'Mild hearing loss', value: '15' },
    { label: 'Moderate hearing loss', value: '30' },
    { label: 'Severe hearing loss', value: '45' },
  ];

  public selectedFreqIndex = 12;
  public customFreq: number | null = null;
  public hearingProfile = '30';
  public modType: ModulationType = 'amp';
  public volume = 30;
  public pan = 0;

  public isPlaying = false;
  public statusText = 'Ready to start';
  public elapsedSeconds = 0;

  public historyDays: Array<{ day: string; durationLabel: string }> = [];
  public totalHistoryLabel = '0 min';
  public diagnosticLogs: string[] = [];
  public diagnosticCopyStatus = '';

  private readonly generator = new TinnitusTherapyGenerator();
  private readonly sessionTracker = new SessionTracker();

  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private animationId: number | null = null;
  private playbackStartedAt = 0;
  private diagnosticsInterval: ReturnType<typeof setInterval> | null = null;
  private readonly resizeHandler = (): void => this.resizeCanvas();
  private readonly visibilityHandler = (): void => {
    this.addDiagnostic(`visibility: ${document.hidden ? 'hidden' : 'visible'}`);
  };
  private readonly blurHandler = (): void => this.addDiagnostic('window blur');
  private readonly focusHandler = (): void =>
    this.addDiagnostic('window focus');
  private readonly pageHideHandler = (): void =>
    this.addDiagnostic('pagehide event');
  private readonly pageShowHandler = (): void =>
    this.addDiagnostic('pageshow event');

  public constructor() {
    this.loadInitialSettings();
    this.refreshHistory();
  }

  public ngAfterViewInit(): void {
    this.resizeCanvas();
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('blur', this.blurHandler);
    window.addEventListener('focus', this.focusHandler);
    window.addEventListener('pagehide', this.pageHideHandler);
    window.addEventListener('pageshow', this.pageShowHandler);
    this.addDiagnostic('diagnostics initialized');
    this.updateMediaSession();
  }

  public ngOnDestroy(): void {
    window.removeEventListener('resize', this.resizeHandler);
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    window.removeEventListener('blur', this.blurHandler);
    window.removeEventListener('focus', this.focusHandler);
    window.removeEventListener('pagehide', this.pageHideHandler);
    window.removeEventListener('pageshow', this.pageShowHandler);
    this.stopPlayback(false);
    this.generator.destroy();
  }

  public get diagnosticsText(): string {
    return this.diagnosticLogs.join('\n');
  }

  public clearDiagnostics(): void {
    this.diagnosticLogs = [];
    this.diagnosticCopyStatus = 'Log cleared';
  }

  public async copyDiagnostics(): Promise<void> {
    const payload = this.diagnosticsText;
    if (!payload) {
      this.diagnosticCopyStatus = 'No diagnostics to copy';
      return;
    }

    try {
      await navigator.clipboard.writeText(payload);
      this.diagnosticCopyStatus = 'Diagnostics copied';
    } catch {
      this.diagnosticCopyStatus = 'Clipboard unavailable';
    }
  }

  public get selectedFrequencyLabel(): string {
    if (this.customFreq) {
      const suffix =
        this.customFreq < 1000
          ? ' (URL override - experimental)'
          : ' (URL override)';
      return `${this.formatFreq(this.customFreq)}${suffix}`;
    }

    return this.formatFreq(this.frequencies[this.selectedFreqIndex]);
  }

  public get panLabel(): string {
    if (this.pan < 0) {
      return '(left)';
    }
    if (this.pan > 0) {
      return '(right)';
    }
    return '(center)';
  }

  public get timerLabel(): string {
    const hours = Math.floor(this.elapsedSeconds / 3600);
    const minutes = Math.floor((this.elapsedSeconds % 3600) / 60);
    const seconds = this.elapsedSeconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  public get hasHistory(): boolean {
    return this.historyDays.length > 0;
  }

  public selectFrequency(index: number): void {
    this.selectedFreqIndex = index;

    if (!this.customFreq) {
      this.generator.tinnitusFreq = this.frequencies[index];
      this.generator.previewTone(this.frequencies[index]);
    }

    this.persistSettings();
  }

  public onPanChange(event: CustomEvent<{ value: RangeValue }>): void {
    this.pan = this.extractRangeValue(event.detail.value, this.pan);
    this.generator.setPan(this.pan / 100);
    this.persistSettings();
  }

  public onVolumeChange(event: CustomEvent<{ value: RangeValue }>): void {
    this.volume = this.extractRangeValue(event.detail.value, this.volume);
    this.generator.setVolume(this.volume / 100);
    this.persistSettings();
  }

  public onHearingProfileChange(event: CustomEvent<{ value: string }>): void {
    this.hearingProfile = String(event.detail.value ?? this.hearingProfile);
    this.generator.hearingCorrectionMax = Number(this.hearingProfile);
    this.persistSettings();
  }

  public onModTypeChange(event: CustomEvent<{ value: ModulationType }>): void {
    this.modType = event.detail.value ?? this.modType;
    this.generator.modType = this.modType;
    this.persistSettings();
  }

  public togglePlay(): void {
    if (this.isPlaying) {
      return;
    }

    this.generator.hearingCorrectionMax = Number(this.hearingProfile);
    this.generator.modType = this.modType;
    this.generator.setVolume(this.volume / 100);
    this.generator.setPan(this.pan / 100);

    this.generator.start();
    this.sessionTracker.startSession();

    this.isPlaying = true;
    this.statusText = 'Therapy in progress...';
    this.addDiagnostic('playback start requested');
    this.playbackStartedAt = Date.now();
    this.startTimer();
    this.startDiagnosticsLoop();
    this.startVisualizer();
    this.updateMediaSession();
  }

  public stopPlay(): void {
    this.stopPlayback(true);
  }

  private readonly beforeUnloadHandler = (): void => {
    if (this.isPlaying) {
      this.stopPlayback(true);
    }
  };

  private stopPlayback(recordSession: boolean): void {
    if (!this.isPlaying && !recordSession) {
      return;
    }

    this.generator.stop();
    this.addDiagnostic('playback stop requested');

    if (recordSession) {
      this.sessionTracker.endSession();
      this.refreshHistory();
    }

    this.isPlaying = false;
    this.statusText = 'Stopped';
    this.stopTimer();
    this.stopDiagnosticsLoop();
    this.stopVisualizer();
    this.updateMediaSession();
  }

  private startTimer(): void {
    this.stopTimer();
    this.elapsedSeconds = 0;

    this.timerInterval = setInterval(() => {
      this.elapsedSeconds = Math.floor(
        (Date.now() - this.playbackStartedAt) / 1000,
      );
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  private startVisualizer(): void {
    const canvas = this.visualizerRef?.nativeElement;
    const analyser = this.generator.getAnalyser();
    if (!canvas || !analyser) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = (): void => {
      if (!this.isPlaying) {
        return;
      }

      this.animationId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.fillStyle = '#111827';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i += 1) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        const hue = 180 + (i / bufferLength) * 60;
        ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
    };

    draw();
  }

  private stopVisualizer(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    const canvas = this.visualizerRef?.nativeElement;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) {
      ctx.fillStyle = '#111827';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  private resizeCanvas(): void {
    const canvas = this.visualizerRef?.nativeElement;
    if (!canvas) {
      return;
    }

    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
  }

  private refreshHistory(): void {
    const byDay = this.sessionTracker.getSessionsByDay();
    this.historyDays = byDay.map((day) => ({
      day: day.day,
      durationLabel: this.formatDuration(day.durationMs),
    }));

    const totalMs = byDay.reduce((acc, day) => acc + day.durationMs, 0);
    this.totalHistoryLabel = this.formatDuration(totalMs);
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}min`;
    }
    return `${minutes} min`;
  }

  private formatFreq(freq: number): string {
    if (freq >= 1000) {
      return `${(freq / 1000).toFixed(1).replace('.0', '')} kHz`;
    }
    return `${freq} Hz`;
  }

  private extractRangeValue(value: RangeValue, fallback: number): number {
    if (typeof value === 'number') {
      return value;
    }

    if (value && typeof value === 'object' && typeof value.lower === 'number') {
      return value.lower;
    }

    return fallback;
  }

  private loadInitialSettings(): void {
    const defaults: SavedSettings = {
      freqIndex: 12,
      volume: 30,
      hearingProfile: '30',
      modType: 'amp',
      pan: 0,
    };

    const settings = this.loadSettings(defaults);
    this.selectedFreqIndex = settings.freqIndex;
    this.volume = settings.volume;
    this.hearingProfile = settings.hearingProfile;
    this.modType = settings.modType;
    this.pan = settings.pan;

    const urlParams = new URLSearchParams(window.location.search);
    const customFreqParam = urlParams.get('freq');
    if (customFreqParam) {
      const parsed = Number.parseInt(customFreqParam, 10);
      if (parsed >= 100 && parsed <= 20000) {
        this.customFreq = parsed;
        this.generator.tinnitusFreq = parsed;
      }
    }

    if (!this.customFreq) {
      this.generator.tinnitusFreq = this.frequencies[this.selectedFreqIndex];
    }

    this.generator.hearingCorrectionMax = Number(this.hearingProfile);
    this.generator.modType = this.modType;
    this.generator.pan = this.pan / 100;
    this.generator.setVolume(this.volume / 100);
  }

  private loadSettings(defaults: SavedSettings): SavedSettings {
    const data = localStorage.getItem(SETTINGS_KEY);
    if (!data) {
      return defaults;
    }

    try {
      const parsed = JSON.parse(data) as Partial<SavedSettings>;
      return {
        freqIndex:
          typeof parsed.freqIndex === 'number'
            ? parsed.freqIndex
            : defaults.freqIndex,
        volume:
          typeof parsed.volume === 'number' ? parsed.volume : defaults.volume,
        hearingProfile:
          typeof parsed.hearingProfile === 'string'
            ? parsed.hearingProfile
            : defaults.hearingProfile,
        modType: parsed.modType === 'phase' ? 'phase' : 'amp',
        pan: typeof parsed.pan === 'number' ? parsed.pan : defaults.pan,
      };
    } catch {
      return defaults;
    }
  }

  private persistSettings(): void {
    const settings: SavedSettings = {
      freqIndex: this.selectedFreqIndex,
      volume: this.volume,
      hearingProfile: this.hearingProfile,
      modType: this.modType,
      pan: this.pan,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  private startDiagnosticsLoop(): void {
    this.stopDiagnosticsLoop();

    this.diagnosticsInterval = setInterval(() => {
      const info = this.generator.getRuntimeDiagnostics();
      if (!info) {
        this.addDiagnostic('audio context unavailable');
        return;
      }

      this.addDiagnostic(
        `audio state=${info.state}, t=${info.currentTime.toFixed(2)}s, sr=${info.sampleRate}`,
      );
    }, 5000);
  }

  private stopDiagnosticsLoop(): void {
    if (this.diagnosticsInterval) {
      clearInterval(this.diagnosticsInterval);
      this.diagnosticsInterval = null;
    }
  }

  private addDiagnostic(message: string): void {
    const timestamp = new Date().toISOString();
    this.diagnosticLogs = [
      `[${timestamp}] ${message}`,
      ...this.diagnosticLogs,
    ].slice(0, 80);
  }

  private updateMediaSession(): void {
    if (!('mediaSession' in navigator)) {
      return;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Tinnitus Sound Therapy',
      artist: 'Therapy Session',
      album: 'Mobile Session',
    });

    navigator.mediaSession.playbackState = this.isPlaying
      ? 'playing'
      : 'paused';
    this.addDiagnostic(
      `media session updated: ${navigator.mediaSession.playbackState}`,
    );

    navigator.mediaSession.setActionHandler('play', () => {
      if (!this.isPlaying) {
        this.addDiagnostic('media session play action');
        this.togglePlay();
      }
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (this.isPlaying) {
        this.addDiagnostic('media session pause action');
        this.stopPlay();
      }
    });
    navigator.mediaSession.setActionHandler('stop', () => {
      if (this.isPlaying) {
        this.addDiagnostic('media session stop action');
        this.stopPlay();
      }
    });
  }
}
