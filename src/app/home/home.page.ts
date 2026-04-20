import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  HostBinding,
  OnDestroy,
} from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonRange,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';
import {
  ModulationType,
  TinnitusTherapyService,
} from './tinnitus-therapy.service';

type RangeValue = number | { lower: number; upper: number } | null;

interface SavedSettings {
  freqIndex: number;
  customFreq: number | null;
  volume: number;
  hearingProfile: string;
  modType: ModulationType;
  pan: number;
}

const SETTINGS_KEY = 'tinnitus-settings';
const THEME_KEY = 'tinnitus-theme';

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
    IonButtons,
    IonRange,
    IonSelect,
    IonSelectOption,
    IonToggle,
    IonItem,
    IonLabel,
  ],
})
export class HomePage implements AfterViewInit, OnDestroy {
  @HostBinding('class.theme-dark')
  public get darkThemeClass(): boolean {
    return this.isDarkTheme;
  }

  @HostBinding('class.theme-light')
  public get lightThemeClass(): boolean {
    return !this.isDarkTheme;
  }

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
  public readonly frequencyMin = 250;
  public readonly frequencyMax = 16000;
  public readonly frequencyStep = 10;

  public selectedFreqIndex = 12;
  public customFreq: number | null = null;
  public hearingProfile = '30';
  public modType: ModulationType = 'amp';
  public volume = 30;
  public pan = 0;

  public isPlaying = false;
  public statusText = 'Ready to start';
  public elapsedSeconds = 0;
  public isDarkTheme = false;

  public diagnosticLogs: string[] = [];
  public diagnosticCopyStatus = '';

  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private playbackStartedAt = 0;
  private diagnosticsInterval: ReturnType<typeof setInterval> | null = null;
  private nativeWarmupTimeout: ReturnType<typeof setTimeout> | null = null;
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

  public constructor(private readonly generator: TinnitusTherapyService) {
    this.loadThemePreference();
    this.loadInitialSettings();
  }

  public onThemeToggle(event: CustomEvent<{ checked: boolean }>): void {
    this.isDarkTheme = Boolean(event.detail.checked);
    localStorage.setItem(THEME_KEY, this.isDarkTheme ? 'dark' : 'light');
  }

  public ngAfterViewInit(): void {
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('blur', this.blurHandler);
    window.addEventListener('focus', this.focusHandler);
    window.addEventListener('pagehide', this.pageHideHandler);
    window.addEventListener('pageshow', this.pageShowHandler);
    this.addDiagnostic('diagnostics initialized');
    this.updateMediaSession();

    this.nativeWarmupTimeout = setTimeout(() => {
      this.generator.warmUpNativeAudio();
      this.addDiagnostic('native audio warmup requested');
      this.nativeWarmupTimeout = null;
    }, 300);
  }

  public ngOnDestroy(): void {
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    window.removeEventListener('blur', this.blurHandler);
    window.removeEventListener('focus', this.focusHandler);
    window.removeEventListener('pagehide', this.pageHideHandler);
    window.removeEventListener('pageshow', this.pageShowHandler);

    if (this.nativeWarmupTimeout) {
      clearTimeout(this.nativeWarmupTimeout);
      this.nativeWarmupTimeout = null;
    }

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
    if (this.customFreq !== null) {
      return `${this.formatFreq(this.customFreq)} (fine tuned)`;
    }

    return this.formatFreq(this.frequencies[this.selectedFreqIndex]);
  }

  public get frequencySliderValue(): number {
    return this.customFreq ?? this.frequencies[this.selectedFreqIndex];
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

  public selectFrequency(index: number): void {
    if (this.isPlaying) {
      return;
    }

    this.selectedFreqIndex = index;
    this.customFreq = null;

    this.generator.tinnitusFreq = this.frequencies[index];
    this.generator.previewTone(this.frequencies[index]);

    this.persistSettings();
  }

  public onFrequencySliderChange(
    event: CustomEvent<{ value: RangeValue }>,
  ): void {
    if (this.isPlaying) {
      return;
    }

    const rawFreq = this.extractRangeValue(
      event.detail.value,
      this.frequencySliderValue,
    );
    const boundedFreq = this.clampFrequency(rawFreq);
    const snappedFreq = this.snapFrequencyToStep(boundedFreq);

    this.customFreq = snappedFreq;
    this.selectedFreqIndex = this.findClosestFrequencyIndex(snappedFreq);
    this.generator.tinnitusFreq = snappedFreq;

    this.persistSettings();
  }

  public onFrequencySliderCommit(): void {
    if (this.isPlaying) {
      return;
    }

    if (this.customFreq !== null) {
      this.generator.previewTone(this.customFreq);
    }
  }

  public onPanChange(event: CustomEvent<{ value: RangeValue }>): void {
    this.pan = this.extractRangeValue(event.detail.value, this.pan);

    const deferNativePanApply =
      this.isPlaying && this.generator.usingNativeAudio;

    if (!deferNativePanApply) {
      this.generator.setPan(this.pan / 100);
    }
  }

  public onPanCommit(event: CustomEvent<{ value: RangeValue }>): void {
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
    if (this.isPlaying) {
      return;
    }

    this.hearingProfile = String(event.detail.value ?? this.hearingProfile);
    this.generator.hearingCorrectionMax = Number(this.hearingProfile);
    this.persistSettings();
  }

  public onModTypeChange(event: CustomEvent<{ value: ModulationType }>): void {
    if (this.isPlaying) {
      return;
    }

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

    this.isPlaying = true;
    this.statusText = 'Therapy in progress...';
    this.addDiagnostic('playback start requested');
    this.playbackStartedAt = Date.now();
    this.startTimer();
    this.startDiagnosticsLoop();
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

    this.isPlaying = false;
    this.statusText = 'Stopped';
    this.stopTimer();
    this.stopDiagnosticsLoop();
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
      customFreq: null,
      volume: 30,
      hearingProfile: '30',
      modType: 'amp',
      pan: 0,
    };

    const settings = this.loadSettings(defaults);
    this.selectedFreqIndex = settings.freqIndex;
    this.customFreq = settings.customFreq;
    this.volume = settings.volume;
    this.hearingProfile = settings.hearingProfile;
    this.modType = settings.modType;
    this.pan = settings.pan;

    const urlParams = new URLSearchParams(window.location.search);
    const customFreqParam = urlParams.get('freq');
    if (customFreqParam) {
      const parsed = Number.parseInt(customFreqParam, 10);
      if (parsed >= this.frequencyMin && parsed <= this.frequencyMax) {
        this.customFreq = this.snapFrequencyToStep(parsed);
        this.generator.tinnitusFreq = this.customFreq;
      }
    }

    if (this.customFreq === null) {
      this.generator.tinnitusFreq = this.frequencies[this.selectedFreqIndex];
    } else {
      this.selectedFreqIndex = this.findClosestFrequencyIndex(this.customFreq);
    }

    this.generator.hearingCorrectionMax = Number(this.hearingProfile);
    this.generator.modType = this.modType;
    this.generator.pan = this.pan / 100;
    this.generator.setVolume(this.volume / 100);
  }

  private loadThemePreference(): void {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark') {
      this.isDarkTheme = true;
      return;
    }

    if (saved === 'light') {
      this.isDarkTheme = false;
      return;
    }

    this.isDarkTheme = window.matchMedia(
      '(prefers-color-scheme: dark)',
    ).matches;
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
        customFreq:
          typeof parsed.customFreq === 'number' &&
          parsed.customFreq >= this.frequencyMin &&
          parsed.customFreq <= this.frequencyMax
            ? this.snapFrequencyToStep(parsed.customFreq)
            : defaults.customFreq,
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
      customFreq: this.customFreq,
      volume: this.volume,
      hearingProfile: this.hearingProfile,
      modType: this.modType,
      pan: this.pan,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  private clampFrequency(freq: number): number {
    return Math.max(this.frequencyMin, Math.min(this.frequencyMax, freq));
  }

  private snapFrequencyToStep(freq: number): number {
    return Math.round(freq / this.frequencyStep) * this.frequencyStep;
  }

  private findClosestFrequencyIndex(freq: number): number {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < this.frequencies.length; i += 1) {
      const distance = Math.abs(this.frequencies[i] - freq);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    return bestIndex;
  }

  private startDiagnosticsLoop(): void {
    this.stopDiagnosticsLoop();

    this.diagnosticsInterval = setInterval(() => {
      const info = this.generator.getRuntimeDiagnostics();
      if (!info) {
        this.addDiagnostic('audio context unavailable');
        return;
      }

      const nextStimulusText =
        info.nextStimulusInSec === null
          ? 'n/a'
          : `${info.nextStimulusInSec.toFixed(2)}s`;

      this.addDiagnostic(
        `settings: backend=${info.backend}, nativeLoaded=${info.nativeAssetLoaded}, freq=${Math.round(info.tinnitusFreqHz)}Hz, mod=${info.modulationType}, hearingCorr=${info.hearingCorrectionMaxDb}dB, vol=${Math.round(info.outputVolume * 100)}%, pan=${Math.round(info.outputPan * 100)}`,
      );
      this.addDiagnostic(
        `timing: state=${info.state}, t=${info.currentTime.toFixed(2)}s, sr=${info.sampleRate}, playing=${info.isPlaying}, scheduler=${info.schedulerActive ? 'on' : 'off'}, interval=${info.scheduledIntervalSec.toFixed(2)}s, silenceGap=${info.silenceGapSec.toFixed(2)}s, nextStimulus=${nextStimulusText}, queue=${info.queueHorizonSec.toFixed(2)}s/${info.scheduleAheadTimeSec.toFixed(2)}s, lookahead=${info.schedulerLookaheadMs}ms`,
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
