/* ============================================================
 * player.js — seat metadata + persisted local profile/stats.
 * ============================================================ */
'use strict';

var Player = class Player {
  /**
   * @param {number} index seat: 0 bottom, 1 left, 2 top, 3 right
   * @param {object} o {name, id, local, strikerColor, playerCount, colorSwap}
   */
  constructor(index, o = {}) {
    this.index = index;
    this.name = o.name || ('Player ' + (index + 1));
    this.id = o.id || null;          // socket-level player token, online only
    this.local = o.local !== false;  // can this seat be driven by this device?
    this.ready = false;
    this.connected = true;
    this.strikerColor = o.strikerColor || CONFIG.DEFAULT_STRIKER_COLOR;

    const count = o.playerCount || 2;
    this.team = Utils.teamOf(index, count);
    this.color = Utils.colorOfTeam(this.team, o.colorSwap);
  }

  get initial() { return (this.name || '?').trim().charAt(0).toUpperCase() || '?'; }

  /** Face + rim for the striker. A custom colour derives its own rim. */
  get skin() { return Player.skinFor(this.strikerColor); }

  static skinFor(face) {
    const preset = CONFIG.STRIKER_COLORS.find(c => c.face.toLowerCase() === String(face).toLowerCase());
    if (preset) return { face: preset.face, rim: preset.rim };
    return { face: face || CONFIG.DEFAULT_STRIKER_COLOR, rim: Player._darken(face, 0.45) };
  }

  static _darken(hex, t) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '#8d97a8';
    const n = parseInt(hex.slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * (1 - t));
    const g = Math.round(((n >> 8) & 255) * (1 - t));
    const b = Math.round((n & 255) * (1 - t));
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  serialize() {
    return {
      index: this.index, name: this.name, id: this.id, ready: this.ready,
      connected: this.connected, color: this.color, team: this.team,
      strikerColor: this.strikerColor
    };
  }

  static from(o, playerCount, colorSwap) {
    const p = new Player(o.index, {
      name: o.name, id: o.id, local: false,
      strikerColor: o.strikerColor, playerCount: playerCount || 2,
      colorSwap: colorSwap
    });
    p.ready = !!o.ready;
    p.connected = o.connected !== false;
    return p;
  }
};

/* ------------------------------------------------------------------
 * Profile — the single local identity, persisted in localStorage.
 * ------------------------------------------------------------------ */
var Profile = {
  KEY: 'carrom.profile',

  load() {
    const p = Store.get(Profile.KEY, null);
    return Object.assign({
      name: 'Player',
      wins: 0,
      losses: 0,
      draws: 0,
      coinsPocketed: 0,
      queens: 0,
      strikerColor: CONFIG.DEFAULT_STRIKER_COLOR,
      playerId: Utils.uid(12)      // stable across reconnects
    }, p || {});
  },

  save(p) { Store.set(Profile.KEY, p); return p; },

  record(result) {
    const p = Profile.load();
    if (result === 'win') p.wins++;
    else if (result === 'loss') p.losses++;
    else p.draws++;
    return Profile.save(p);
  },

  addCoins(n, queen) {
    const p = Profile.load();
    p.coinsPocketed += n;
    if (queen) p.queens++;
    return Profile.save(p);
  },

  reset() {
    const p = Profile.load();
    return Profile.save({
      name: p.name, wins: 0, losses: 0, draws: 0, coinsPocketed: 0, queens: 0,
      strikerColor: p.strikerColor, playerId: p.playerId
    });
  }
};

/* ------------------------------------------------------------------
 * Settings — persisted preferences.
 * ------------------------------------------------------------------ */
var Settings = {
  KEY: 'carrom.settings',

  defaults: {
    music: false,
    sound: true,
    volume: 70,
    quality: 'high',
    theme: 'midnight',
    boardTheme: CONFIG.DEFAULT_BOARD_THEME,
    turnTime: CONFIG.DEFAULT_TURN_TIME,
    aimGuide: true,
    showFps: false,
    debug: false,
    serverUrl: ''
  },

  load() { return Object.assign({}, Settings.defaults, Store.get(Settings.KEY, {})); },
  save(s) { Store.set(Settings.KEY, s); return s; },
  patch(partial) { return Settings.save(Object.assign(Settings.load(), partial)); }
};

globalThis.Player = Player;
globalThis.Profile = Profile;
globalThis.Settings = Settings;
