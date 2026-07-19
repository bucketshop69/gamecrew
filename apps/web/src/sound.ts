/**
 * Stadium soundscape for the landing page, using the app's own Game View
 * audio assets (apps/mobile/assets/audio, Mixkit royalty-free — see
 * SOURCES.md there) and the app's tuned volume levels from
 * game-view-sound-logic.ts, halved across the board: on a marketing page the
 * crowd should sit further back than in the app itself.
 *
 * Construct inside a user gesture (the Sound pill) — browsers block audio
 * before the first interaction.
 */

/* App levels halved for the landing page — background presence, per Bibhu. */
const AMBIENT_MIN = 0.025;
const AMBIENT_MAX = 0.06;
const VOLUME = {
  whistle: 0.075,
  strike: 0.09,
  swell: 0.07,
  roar: 0.11,
} as const;

const FADE_STEP_MS = 50;
const FADE_MS = 850;

export class MatchSound {
  private ambient: HTMLAudioElement;
  private effects: Record<keyof typeof VOLUME, HTMLAudioElement>;
  private muted = false;
  private fadeTimer: number | undefined;

  constructor() {
    this.ambient = new Audio('/sound/stadium-ambient.mp3');
    this.ambient.loop = true;
    this.ambient.volume = 0;
    this.ambient.preload = 'auto';
    void this.ambient.play().catch(() => undefined);

    const load = (file: string) => {
      const audio = new Audio(`/sound/${file}`);
      audio.preload = 'auto';
      return audio;
    };
    this.effects = {
      whistle: load('referee-whistle.mp3'),
      strike: load('ball-strike.mp3'),
      swell: load('crowd-swell.mp3'),
      roar: load('goal-roar.mp3'),
    };
  }

  private fadeAmbientTo(target: number) {
    window.clearInterval(this.fadeTimer);
    const start = this.ambient.volume;
    const steps = Math.max(1, Math.round(FADE_MS / FADE_STEP_MS));
    let step = 0;
    this.fadeTimer = window.setInterval(() => {
      step += 1;
      const t = step / steps;
      this.ambient.volume = start + (target - start) * t;
      if (step >= steps) window.clearInterval(this.fadeTimer);
    }, FADE_STEP_MS);
  }

  private playEffect(name: keyof typeof VOLUME, volume: number = VOLUME[name]) {
    if (this.muted) return;
    const effect = this.effects[name];
    effect.currentTime = 0;
    effect.volume = volume;
    void effect.play().catch(() => undefined);
  }

  /** 0..1 match intensity → ambient bed level (app: quiet→danger range). */
  setIntensity(value: number) {
    const clamped = Math.min(1, Math.max(0, value));
    this.fadeAmbientTo(this.muted ? 0 : AMBIENT_MIN + clamped * (AMBIENT_MAX - AMBIENT_MIN));
  }

  /** Goal moment: ball strike, then the roar right behind it. */
  goal(strength = 1) {
    this.playEffect('strike');
    window.setTimeout(() => this.playEffect('roar', VOLUME.roar * Math.max(0.6, strength)), 180);
  }

  /** Pressure rising — one crowd swell. */
  swell() {
    this.playEffect('swell');
  }

  /** Full-time whistle. */
  whistle() {
    this.playEffect('whistle');
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.ambient.muted = muted;
    for (const effect of Object.values(this.effects)) effect.muted = muted;
  }

  resume() {
    void this.ambient.play().catch(() => undefined);
  }

  dispose() {
    window.clearInterval(this.fadeTimer);
    this.ambient.pause();
    this.ambient.src = '';
    for (const effect of Object.values(this.effects)) {
      effect.pause();
      effect.src = '';
    }
  }
}
