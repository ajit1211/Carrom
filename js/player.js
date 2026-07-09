/* ============================================================
 * player.js — seat metadata + persisted local profile/stats.
 * ============================================================ */
'use strict';

var Player = class Player {
  /**
   * @param {number} index 0 (bottom, white) or 1 (top, black)
   * @param {object} o {name, id, local, spectator}
   */
  constructor(index, o = {}) {
    this.index = index;
    this.name = o.name || (index === 0 ? 'Player 1' : 'Player 2');
    this.id = o.id || null;          // socket-level player token, online only
    this.local = o.local !== false;  // can this seat be driven by this device?
    this.ready = false;
    this.connected = true;
    this.color = index === 0 ? 'white' : 'black';
  }

  get initial() { return (this.name || '?').trim().charAt(0).toUpperCase() || '?'; }

  serialize() {
    return { index: this.index, name: this.name, id: this.id, ready: this.ready, connected: this.connected, color: this.color };
  }

  static from(o) {
    const p = new Player(o.index, { name: o.name, id: o.id, local: false });
    p.ready = !!o.ready;
    p.connected = o.connected !== false;
    p.color = o.color || p.color;
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
    return Profile.save({ name: p.name, wins: 0, losses: 0, draws: 0, coinsPocketed: 0, queens: 0, playerId: p.playerId });
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
