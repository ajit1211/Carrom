/* ============================================================
 * audio.js — every sound is synthesised with the Web Audio API.
 *
 * No .mp3/.wav files means: nothing to 404 on GitHub Pages, no
 * licensing questions, and a ~0 KB audio payload. Impact sounds are
 * modulated by the actual collision speed the physics engine reports,
 * so a soft kiss and a hard smash genuinely sound different.
 * ============================================================ */
'use strict';

class AudioManager {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;

    this.enabledSfx = true;
    this.enabledMusic = false;
    this.volume = 0.7;

    this._noise = null;
    this._musicTimer = null;
    this._step = 0;
    this._lastHit = 0;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = this.enabledSfx ? 1 : 0;
    this.sfxBus.connect(this.master);

    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0;
    this.musicBus.connect(this.master);

    this._buildNoise();
    if (this.enabledMusic) this.startMusic();
  }

  _buildNoise() {
    const len = this.ctx.sampleRate * 0.5;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noise = buf;
  }

  /* ---------------- settings ---------------- */

  setVolume(v) {
    this.volume = Utils.clamp(v, 0, 1);
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  setSfx(on) {
    this.enabledSfx = on;
    if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  setMusic(on) {
    this.enabledMusic = on;
    if (!this.ctx) return;
    on ? this.startMusic() : this.stopMusic();
  }

  /* ---------------- primitives ---------------- */

  _now() { return this.ctx.currentTime; }

  /** Short pitched blip. */
  _tone({ freq = 440, type = 'sine', dur = 0.12, gain = 0.3, slideTo = null, delay = 0, bus = null }) {
    if (!this.ctx) return;
    const t = this._now() + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);

    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(g).connect(bus || this.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Band-passed noise burst — the "clack" of two discs. */
  _burst({ freq = 2200, q = 6, dur = 0.09, gain = 0.4, delay = 0 }) {
    if (!this.ctx || !this._noise) return;
    const t = this._now() + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /* ---------------- game sounds ---------------- */

  click() {
    this.unlock();
    this._tone({ freq: 900, type: 'square', dur: 0.045, gain: 0.12, slideTo: 1500 });
  }

  /**
   * Coin-on-coin. `speed` is px/s straight from the solver.
   * Harder hits are louder, brighter and a touch higher pitched.
   */
  coinHit(speed, isStriker) {
    if (!this.ctx) return;
    // Throttle: a big break can generate 30 contacts in one frame.
    const now = this._now();
    if (now - this._lastHit < 0.012) return;
    this._lastHit = now;

    const k = Utils.clamp(speed / 1400, 0.06, 1);
    this._burst({ freq: (isStriker ? 2600 : 3200) * (0.7 + k * 0.6), q: 5, dur: 0.05 + k * 0.05, gain: 0.10 + k * 0.42 });
    this._tone({ freq: (isStriker ? 520 : 760) * (0.85 + k * 0.35), type: 'triangle', dur: 0.07 + k * 0.06, gain: 0.05 + k * 0.2, slideTo: 220 });
  }

  wallHit(speed) {
    if (!this.ctx) return;
    const k = Utils.clamp(speed / 1200, 0.05, 1);
    this._burst({ freq: 420 * (0.8 + k * 0.5), q: 2.2, dur: 0.08, gain: 0.06 + k * 0.26 });
    this._tone({ freq: 170, type: 'sine', dur: 0.1, gain: 0.05 + k * 0.14, slideTo: 90 });
  }

  pocket(isQueen) {
    if (!this.ctx) return;
    this._tone({ freq: isQueen ? 900 : 700, type: 'sine', dur: 0.16, gain: 0.28, slideTo: 200 });
    this._burst({ freq: 900, q: 1.4, dur: 0.22, gain: 0.16, delay: 0.02 });
    this._tone({ freq: 140, type: 'sine', dur: 0.22, gain: 0.22, slideTo: 60, delay: 0.05 });
    if (isQueen) this._tone({ freq: 1320, type: 'triangle', dur: 0.3, gain: 0.14, delay: 0.1 });
  }

  foul() {
    if (!this.ctx) return;
    this._tone({ freq: 300, type: 'sawtooth', dur: 0.18, gain: 0.2, slideTo: 120 });
    this._tone({ freq: 220, type: 'sawtooth', dur: 0.24, gain: 0.16, slideTo: 90, delay: 0.09 });
  }

  turn() {
    if (!this.ctx) return;
    this._tone({ freq: 660, type: 'sine', dur: 0.1, gain: 0.16 });
    this._tone({ freq: 990, type: 'sine', dur: 0.12, gain: 0.12, delay: 0.08 });
  }

  tick() {
    if (!this.ctx) return;
    this._tone({ freq: 1200, type: 'square', dur: 0.03, gain: 0.07 });
  }

  win() {
    if (!this.ctx) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      this._tone({ freq: f, type: 'triangle', dur: 0.32, gain: 0.22, delay: i * 0.11 }));
  }

  lose() {
    if (!this.ctx) return;
    [440, 392, 329.63, 261.63].forEach((f, i) =>
      this._tone({ freq: f, type: 'sawtooth', dur: 0.3, gain: 0.14, delay: i * 0.13 }));
  }

  charge(power) {
    if (!this.ctx) return;
    this._tone({ freq: 200 + power * 700, type: 'sine', dur: 0.04, gain: 0.05 });
  }

  /* ---------------- background music ---------------- */

  /**
   * A slow, non-intrusive arpeggio over a warm pad. Purely generative,
   * scheduled 8 steps at a time from a plain interval.
   */
  startMusic() {
    if (!this.ctx || this._musicTimer) return;
    this.musicBus.gain.setTargetAtTime(0.18, this._now(), 0.8);

    const scale = [220, 261.63, 293.66, 329.63, 392, 440, 523.25, 587.33];
    const pattern = [0, 2, 4, 6, 5, 3, 4, 2, 0, 3, 5, 7, 6, 4, 2, 1];

    const pad = this.ctx.createOscillator();
    const padG = this.ctx.createGain();
    const padF = this.ctx.createBiquadFilter();
    pad.type = 'sawtooth';
    pad.frequency.value = 110;
    padF.type = 'lowpass';
    padF.frequency.value = 380;
    padG.gain.value = 0.06;
    pad.connect(padF).connect(padG).connect(this.musicBus);
    pad.start();
    this._pad = pad;

    const stepDur = 0.42;
    const play = () => {
      if (!this.enabledMusic) return;
      for (let i = 0; i < 4; i++) {
        const n = pattern[(this._step + i) % pattern.length];
        this._tone({
          freq: scale[n] * (((this._step + i) % 8 === 0) ? 0.5 : 1),
          type: 'triangle',
          dur: stepDur * 0.9,
          gain: 0.09,
          delay: i * stepDur,
          bus: this.musicBus
        });
      }
      this._step += 4;
    };

    play();
    this._musicTimer = setInterval(play, stepDur * 4 * 1000);
  }

  stopMusic() {
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(0, this._now(), 0.4);
    if (this._pad) { try { this._pad.stop(this._now() + 1); } catch (_) {} this._pad = null; }
  }
}

globalThis.AudioManager = AudioManager;
globalThis.audio = new AudioManager();
