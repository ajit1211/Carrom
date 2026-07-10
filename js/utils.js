/* ============================================================
 * utils.js — shared constants + helpers.
 *
 * IMPORTANT: this file is loaded BOTH by the browser (as a classic
 * <script>) and by the Node server (evaluated inside a `vm` sandbox so
 * that client and server run *literally the same* physics code).
 * Therefore it must never touch `window`, `document` or `require`.
 * Anything the other modules need is published on `globalThis` at the
 * bottom of the file.
 * ============================================================ */
'use strict';

/* ------------------------------------------------------------------
 * Geometry, in "logical board units". The canvas is always 900x900
 * logical units and is scaled to whatever CSS size it ends up with,
 * so physics never depends on screen resolution.
 * ------------------------------------------------------------------ */
var CONFIG = (function buildConfig() {
  var BOARD_SIZE = 900;      // full wooden board incl. frame
  var FRAME = 78;            // wooden frame thickness
  var PLAY_MIN = FRAME;      // inner playfield bounds
  var PLAY_MAX = BOARD_SIZE - FRAME;
  var PLAY = PLAY_MAX - PLAY_MIN;   // 744
  var CENTER = BOARD_SIZE / 2;      // 450

  var COIN_R = 18;           // enlarged for readability (was ratio-accurate 15.5)
  var STRIKER_R = 24;        // enlarged striker to match
  var POCKET_R = 31;         // pocket scaled up so the bigger striker still drops
  var POCKET_INSET = 6;      // pocket centre pushed slightly into the corner

  // Base-line block (repeated on all four sides; rotated per side).
  var INSET = 115;                       // distance from playfield edge to the outer base line
  var GAP = 13;                          // distance between the two base lines
  var BASE_CIRCLE_R = 12.5;              // red circles that terminate each base line
  var BASE_X0 = PLAY_MIN + INSET;        // 193
  var BASE_X1 = PLAY_MAX - INSET;        // 707

  var CENTER_CIRCLE_R = 94;              // big centre circle, scaled with the coins
  var INNER_CIRCLE_R = COIN_R + 3;

  return {
    BOARD_SIZE: BOARD_SIZE,
    FRAME: FRAME,
    PLAY_MIN: PLAY_MIN,
    PLAY_MAX: PLAY_MAX,
    PLAY: PLAY,
    CENTER: CENTER,

    COIN_R: COIN_R,
    STRIKER_R: STRIKER_R,
    POCKET_R: POCKET_R,

    /* Masses in arbitrary but proportional units (real: ~5.5g vs ~15g). */
    COIN_MASS: 1.0,
    QUEEN_MASS: 1.0,
    STRIKER_MASS: 2.6,

    /* --- Physics tuning ---
     * The bed is 0.7366 m wide and maps to 744 px, so 1 m ~= 1010 px.
     * A powdered carrom bed has mu ~= 0.085, i.e. a = mu*g ~= 0.84 m/s^2
     * ~= 850 px/s^2. Deceleration is independent of mass: that is why a
     * heavy striker and a light coin coast equally far at equal speed. */
    FRICTION_DECEL: 850,       // px/s^2
    ANGULAR_DAMP: 3.0,         // 1/s, purely cosmetic spin decay
    RESTITUTION: 0.94,         // coin <-> coin (ivory-ish discs are springy)
    WALL_RESTITUTION: 0.72,    // cushion absorbs more
    TANGENT_FRICTION: 0.06,    // surface friction during contact (adds spin)
    SLEEP_SPEED: 7,            // px/s below which a body is snapped to rest
    SUBSTEP: 1 / 360,          // fixed step: 3200 px/s moves 8.9 px < coin radius
    MAX_SETTLE_TIME: 16,       // seconds; hard cap for a headless simulation
    POSITION_SLOP: 0.02,
    POSITION_PERCENT: 0.85,

    /* --- Shot ---
     * A real flick leaves the fingernail at roughly 3-5 m/s. 3200 px/s is
     * ~3.2 m/s, which coasts ~6 board-widths before stopping — exactly the
     * ricochet-happy feel of a hard carrom shot. */
    MIN_SHOT_SPEED: 300,
    MAX_SHOT_SPEED: 3200,
    MAX_PULL: 190,             // logical px of drag == full power

    /* Pull less than this and the shot reads 0%: the drag becomes a
     * "reposition the striker" gesture instead. Releasing inside the
     * deadzone never fires, so it doubles as a cancel. */
    AIM_DEADZONE: 22,

    /* --- Board markings --- */
    LAYOUT: {
      INSET: INSET,
      GAP: GAP,
      BASE_CIRCLE_R: BASE_CIRCLE_R,
      BASE_X0: BASE_X0,
      BASE_X1: BASE_X1,
      CENTER_CIRCLE_R: CENTER_CIRCLE_R,
      INNER_CIRCLE_R: INNER_CIRCLE_R,
      // Striker rests centred between the two base lines: the outer line sits
      // INSET from the cushion, the inner one GAP further in.
      STRIKER_OFFSET: INSET + GAP / 2,
      // Striker must not overlap the red circles at the line ends.
      STRIKER_MIN: BASE_X0 + BASE_CIRCLE_R + STRIKER_R,
      STRIKER_MAX: BASE_X1 - BASE_CIRCLE_R - STRIKER_R
    },

    POCKETS: [
      { x: PLAY_MIN + POCKET_INSET, y: PLAY_MIN + POCKET_INSET },
      { x: PLAY_MAX - POCKET_INSET, y: PLAY_MIN + POCKET_INSET },
      { x: PLAY_MIN + POCKET_INSET, y: PLAY_MAX - POCKET_INSET },
      { x: PLAY_MAX - POCKET_INSET, y: PLAY_MAX - POCKET_INSET }
    ],

    /* --- Rules --- */
    COINS_PER_SIDE: 9,
    QUEEN_POINTS: 3,
    MAX_TURNS: 200,            // safety valve -> draw (a real game ends in ~40)
    DEFAULT_TURN_TIME: 30,

    /* --- Seats ---
     * Singles uses seats 0 and 2 (facing each other). Doubles uses all four,
     * turn order running clockwise, partners opposite:
     *
     *              seat 2  (Black)
     *      seat 1                  seat 3
     *      (White)                 (Black)
     *              seat 0  (White)
     *
     * so team 0 = seats {0, 1}? No — partners must face each other:
     * team 0 = {0, 2}, team 1 = {1, 3}, and play alternates between teams.
     */
    SEATS: 4,

    /* --- Striker skins. `face` is the disc, `rim` the machined edge. --- */
    STRIKER_COLORS: [
      { id: 'pearl',  name: 'Pearl',   face: '#eef2f8', rim: '#8d97a8' },
      { id: 'gold',   name: 'Gold',    face: '#ffd98a', rim: '#9c6f16' },
      { id: 'ruby',   name: 'Ruby',    face: '#ff8b96', rim: '#8e1b26' },
      { id: 'jade',   name: 'Jade',    face: '#8bf0c4', rim: '#14795a' },
      { id: 'azure',  name: 'Azure',   face: '#93c8ff', rim: '#1b5590' },
      { id: 'violet', name: 'Violet',  face: '#c9b1ff', rim: '#4a2f96' },
      { id: 'ember',  name: 'Ember',   face: '#ffb37a', rim: '#9a4410' },
      { id: 'onyx',   name: 'Onyx',    face: '#8e97a6', rim: '#171a20' }
    ],
    DEFAULT_STRIKER_COLOR: '#eef2f8',

    /* --- Board themes. Purely cosmetic: never touches physics, so two
     * online players can each look at a different board. --- */
    DEFAULT_BOARD_THEME: 'classic',
    BOARD_THEMES: [
      {
        id: 'classic', name: 'Classic Club',
        frame: ['#e8973a', '#c86f1d', '#a85512', '#d8842a'],
        frameEdge: 'rgba(255,224,170,.30)',
        corner: '#171310',
        bed: ['#f4dfae', '#eccd8f', '#e2bc75', '#efd49b'],
        grain: '#c09045',
        line: 'rgba(66,38,12,.78)',
        accent: '#c22f2b', accentDot: 'rgba(255,232,232,.85)',
        pocketRing: ['#ffb45e', '#e07b18', '#8a4a0c'],
        centerFill: 'rgba(194,47,43,.18)'
      },
      {
        id: 'walnut', name: 'Walnut Pro',
        frame: ['#7a4d1c', '#5d3712', '#4a2b0d', '#6b431a'],
        frameEdge: 'rgba(255,210,150,.18)',
        corner: '#221302',
        bed: ['#e8c98f', '#dcb877', '#d0a862', '#e2c084'],
        grain: '#8a5f28',
        line: 'rgba(30,20,10,.72)',
        accent: '#b5202c', accentDot: 'rgba(255,220,220,.75)',
        pocketRing: ['#f5d98b', '#b8862f', '#6b4a12'],
        centerFill: 'rgba(181,32,44,.20)'
      },
      {
        id: 'birch', name: 'Tournament Birch',
        frame: ['#3a2a20', '#2b1d15', '#20140e', '#332318'],
        frameEdge: 'rgba(255,235,205,.16)',
        corner: '#0e0c0a',
        bed: ['#f8ecd2', '#f2e1bf', '#e9d5ab', '#f5e7ca'],
        grain: '#c9ab77',
        line: 'rgba(52,40,24,.72)',
        accent: '#b83030', accentDot: 'rgba(255,235,235,.85)',
        pocketRing: ['#e8e8ee', '#9aa2b2', '#4c5361'],
        centerFill: 'rgba(184,48,48,.16)'
      },
      {
        id: 'royal', name: 'Royal Rosewood',
        frame: ['#3a1626', '#2a0e1b', '#200a14', '#331321'],
        frameEdge: 'rgba(255,205,120,.26)',
        corner: '#0d0b0f',
        bed: ['#dcae70', '#cd9a58', '#bf8a46', '#d6a563'],
        grain: '#7c5222',
        line: 'rgba(28,16,8,.80)',
        accent: '#8e1b26', accentDot: 'rgba(255,220,200,.80)',
        pocketRing: ['#ffe08a', '#c99a2e', '#7a5a10'],
        centerFill: 'rgba(142,27,38,.22)'
      }
    ],

    /* --- Colours --- */
    COLORS: {
      white: '#f2e7cd',
      whiteEdge: '#a48b5c',
      black: '#232323',
      blackEdge: '#0a0a0a',
      queen: '#c0293a',
      queenEdge: '#6d1119',
      striker: '#eef2f8',
      strikerEdge: '#8d97a8'
    },

    /* --- Networking --- */
    NET: {
      /* If you host the frontend on GitHub Pages, either put your server
       * URL here or set it in Settings (it is stored in localStorage). */
      PUBLIC_SERVER: '',
      RECONNECT_KEY: 'carrom.session'
    }
  };
})();

/* ------------------------------------------------------------------
 * Small maths / misc helpers.
 * ------------------------------------------------------------------ */
var Utils = {
  clamp: function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); },
  lerp: function (a, b, t) { return a + (b - a) * t; },
  dist2: function (ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; },
  dist: function (ax, ay, bx, by) { return Math.sqrt(Utils.dist2(ax, ay, bx, by)); },
  deg: function (r) { return r * 180 / Math.PI; },
  rad: function (d) { return d * Math.PI / 180; },

  /** Shortest signed difference between two angles. */
  angleDiff: function (a, b) {
    var d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  },

  /** "1:05" from 65 seconds. */
  formatTime: function (sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  },

  /** Non-physics id (never used inside the deterministic simulation). */
  uid: function (n) {
    n = n || 8;
    var s = '', abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (var i = 0; i < n; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return s;
  },

  /**
   * The canonical 19-coin opening arrangement, generated deterministically.
   * Queen in the middle, an inner ring of 6 alternating coins touching her,
   * and an outer ring of 12 alternating coins touching the inner ring.
   * Result: 9 white, 9 black, 1 queen.
   */
  initialLayout: function () {
    var C = CONFIG.CENTER, R = CONFIG.COIN_R, out = [];
    var id = 0;

    out.push({ id: id++, type: 'queen', x: C, y: C });

    var i, a;
    // Inner ring — 6 coins, centres at exactly 2R (touching the queen).
    for (i = 0; i < 6; i++) {
      a = -Math.PI / 2 + i * (Math.PI * 2 / 6);
      out.push({
        id: id++,
        type: i % 2 === 0 ? 'white' : 'black',
        x: C + Math.cos(a) * (2 * R),
        y: C + Math.sin(a) * (2 * R)
      });
    }

    // Outer ring — 12 coins at 4R, rotated 15deg so they nest in the gaps.
    for (i = 0; i < 12; i++) {
      a = -Math.PI / 2 + Utils.rad(15) + i * (Math.PI * 2 / 12);
      out.push({
        id: id++,
        type: i % 2 === 0 ? 'black' : 'white',
        x: C + Math.cos(a) * (4 * R),
        y: C + Math.sin(a) * (4 * R)
      });
    }
    return out;
  },

  /* ------------------------------------------------------------------
   * Seats & rails.
   *
   * Four base lines, one per side. A striker position along a rail is a
   * single scalar `u` (an x for the horizontal rails, a y for the vertical
   * ones), always inside [STRIKER_MIN, STRIKER_MAX].
   *
   *   seat 0 = bottom   seat 1 = left   seat 2 = top   seat 3 = right
   *
   * `rot` is the angle the whole board is rotated by when that seat is the
   * local player, so your own rail is always at the bottom of your screen.
   * ------------------------------------------------------------------ */

  railFor: function (seat) {
    var L = CONFIG.LAYOUT, off = L.STRIKER_OFFSET;
    switch (seat) {
      case 1: return { horizontal: false, fixed: CONFIG.PLAY_MIN + off, inward: { x: 1, y: 0 },  rot: -Math.PI / 2 };
      case 2: return { horizontal: true,  fixed: CONFIG.PLAY_MIN + off, inward: { x: 0, y: 1 },  rot: Math.PI };
      case 3: return { horizontal: false, fixed: CONFIG.PLAY_MAX - off, inward: { x: -1, y: 0 }, rot: Math.PI / 2 };
      default: return { horizontal: true, fixed: CONFIG.PLAY_MAX - off, inward: { x: 0, y: -1 }, rot: 0 };
    }
  },

  /** Clamp a rail coordinate to the legal span of the base line. */
  clampStrikerU: function (u) {
    return Utils.clamp(u, CONFIG.LAYOUT.STRIKER_MIN, CONFIG.LAYOUT.STRIKER_MAX);
  },

  /** Board-space point for a striker sitting at `u` on `seat`'s rail. */
  strikerPos: function (seat, u) {
    var r = Utils.railFor(seat);
    u = Utils.clampStrikerU(u);
    return r.horizontal ? { x: u, y: r.fixed } : { x: r.fixed, y: u };
  },

  /** Inverse of strikerPos: pull the rail coordinate out of a point. */
  strikerU: function (seat, pos) {
    return Utils.railFor(seat).horizontal ? pos.x : pos.y;
  },

  strikerHome: function (seat) { return Utils.strikerPos(seat, CONFIG.CENTER); },

  /**
   * Rail coordinate <-> slider position, oriented to what the player SEES.
   * After the board is rotated for their seat, t=0 is always screen-left.
   */
  railTFromU: function (seat, u) {
    var L = CONFIG.LAYOUT, span = L.STRIKER_MAX - L.STRIKER_MIN;
    var n = (Utils.clampStrikerU(u) - L.STRIKER_MIN) / span;
    return (seat === 0 || seat === 1) ? n : 1 - n;
  },

  uFromRailT: function (seat, t) {
    var L = CONFIG.LAYOUT, span = L.STRIKER_MAX - L.STRIKER_MIN;
    t = Utils.clamp(t, 0, 1);
    var n = (seat === 0 || seat === 1) ? t : 1 - t;
    return L.STRIKER_MIN + n * span;
  },

  /* ------------------------------------------------------------------
   * Teams.
   *
   * Both formats seat the two sides facing each other, but they mean
   * different things, so team membership depends on the headcount:
   *
   *   Singles (2): seats 0 (bottom) and 2 (top) are OPPONENTS.
   *   Doubles (4): seats 0 and 2 are PARTNERS (team 0), 1 and 3 are the
   *                other pair (team 1). Turn order 0->1->2->3 therefore
   *                alternates between the teams, exactly as at a real board.
   * ------------------------------------------------------------------ */

  /** Which seats are in play for a given headcount. */
  seatsFor: function (playerCount) {
    return playerCount === 4 ? [0, 1, 2, 3] : [0, 2];
  },

  teamOf: function (seat, playerCount) {
    return playerCount === 4 ? (seat % 2) : (seat === 0 ? 0 : 1);
  },

  colorOfTeam: function (team) { return team === 0 ? 'white' : 'black'; },

  colorOfSeat: function (seat, playerCount) {
    return Utils.colorOfTeam(Utils.teamOf(seat, playerCount));
  },

  /** Your partner's seat, or your own in singles. */
  partnerOf: function (seat, playerCount) {
    return playerCount === 4 ? (seat + 2) % 4 : seat;
  },

  /** Next seat to shoot, skipping the seats a singles game does not use. */
  nextSeat: function (seat, playerCount) {
    var seats = Utils.seatsFor(playerCount);
    var i = seats.indexOf(seat);
    return seats[(i + 1) % seats.length];
  },

  /** Look up a striker skin, falling back to a raw CSS colour string. */
  strikerFace: function (color) {
    return color || CONFIG.DEFAULT_STRIKER_COLOR;
  },

  /** Human-readable label for a coin type. */
  typeLabel: function (t) { return t === 'queen' ? 'Queen' : (t === 'white' ? 'White' : 'Black'); }
};

/* ------------------------------------------------------------------
 * A tiny synchronous event bus (used by Game -> UI, Network -> Game).
 * ------------------------------------------------------------------ */
var EventBus = class EventBus {
  constructor() { this._h = Object.create(null); }

  on(evt, fn) {
    (this._h[evt] || (this._h[evt] = [])).push(fn);
    return () => this.off(evt, fn);
  }

  once(evt, fn) {
    const off = this.on(evt, (...a) => { off(); fn(...a); });
    return off;
  }

  off(evt, fn) {
    const list = this._h[evt];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(evt, ...args) {
    const list = this._h[evt];
    if (!list) return;
    // copy: handlers may unsubscribe during dispatch
    for (const fn of list.slice()) {
      try { fn(...args); } catch (e) { console.error('[bus:' + evt + ']', e); }
    }
  }
};

/* ------------------------------------------------------------------
 * Particles — purely cosmetic, never affects the simulation.
 * ------------------------------------------------------------------ */
var ParticleSystem = class ParticleSystem {
  constructor(max = 320) {
    this.max = max;
    this.items = [];
  }

  /** Ring of sparks at a collision point. */
  burst(x, y, count, color, speed = 160, life = 0.35) {
    if (this.items.length > this.max) return;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.items.push({
        x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life, maxLife: life, color,
        size: 1 + Math.random() * 2.2
      });
    }
  }

  /** Coins swirling down into a pocket. */
  pocketSwirl(x, y, color) {
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      this.items.push({
        x: x + Math.cos(a) * 14, y: y + Math.sin(a) * 14,
        vx: -Math.cos(a) * 60, vy: -Math.sin(a) * 60,
        life: 0.55, maxLife: 0.55, color, size: 2.4, swirl: true
      });
    }
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.life -= dt;
      if (p.life <= 0) { this.items.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const damp = p.swirl ? 0.90 : 0.94;
      p.vx *= damp; p.vy *= damp;
    }
  }

  draw(ctx) {
    for (const p of this.items) {
      const t = p.life / p.maxLife;
      ctx.globalAlpha = t;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * t, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  clear() { this.items.length = 0; }
};

/* ------------------------------------------------------------------
 * localStorage wrapper that degrades gracefully (private mode, Node).
 * ------------------------------------------------------------------ */
var Store = {
  get(key, fallback) {
    try {
      const raw = globalThis.localStorage && localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) { return fallback; }
  },
  set(key, value) {
    try { globalThis.localStorage && localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  },
  del(key) {
    try { globalThis.localStorage && localStorage.removeItem(key); } catch (_) {}
  }
};

/* Publish for the Node `vm` sandbox (and harmlessly for the browser). */
globalThis.CONFIG = CONFIG;
globalThis.Utils = Utils;
globalThis.EventBus = EventBus;
globalThis.ParticleSystem = ParticleSystem;
globalThis.Store = Store;
