/* ============================================================
 * coin.js — a carrom man (coin).
 *
 * The class is split cleanly: everything above `draw()` is pure data
 * and is executed on the server too. `draw()` only ever touches the
 * CanvasRenderingContext2D it is handed, so the server never calls it.
 *
 * Rendering is SPRITE-CACHED: the first draw of each (kind, quality,
 * colour) paints the disc once into an offscreen canvas at 3x
 * resolution; every later frame is two drawImage calls (shadow +
 * face). That removes ~120 gradient allocations per frame and is the
 * main reason aiming and online play stay at 60 fps.
 * ============================================================ */
'use strict';

/* ------------------------------------------------------------------
 * Shared offscreen sprite cache. Browser-only; the server never draws.
 * ------------------------------------------------------------------ */
var CoinSprite = {
  SS: 3,       // supersample so sprites stay crisp at 2x devicePixelRatio
  PAD: 3,      // logical px of padding around the disc
  _m: null,

  /**
   * @param {string} key    cache key — MUST encode everything that changes pixels
   * @param {number} r      logical radius the painter draws at
   * @param {(g:CanvasRenderingContext2D, r:number)=>void} paint centred painter
   */
  get(key, r, paint) {
    if (typeof document === 'undefined') return null;
    if (!this._m) this._m = new Map();
    let cv = this._m.get(key);
    if (!cv) {
      const half = (r + this.PAD) * this.SS;
      cv = document.createElement('canvas');
      cv.width = cv.height = Math.ceil(half * 2);
      const g = cv.getContext('2d');
      g.scale(this.SS, this.SS);
      g.translate(r + this.PAD, r + this.PAD);
      paint(g, r);
      this._m.set(key, cv);
    }
    return cv;
  },

  /** Blit a cached sprite centred on (0,0) of the current transform. */
  blit(ctx, cv, r, baseR) {
    const half = (baseR + this.PAD) * (r / baseR);
    ctx.drawImage(cv, -half, -half, half * 2, half * 2);
  },

  /** Soft round contact shadow, shared by every disc of radius `r`. */
  shadow(r) {
    return this.get('shadow:' + r, r * 1.3, (g) => {
      const sh = g.createRadialGradient(0, 0, r * 0.5, 0, 0, r * 1.28);
      sh.addColorStop(0, 'rgba(0,0,0,.45)');
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sh;
      g.beginPath();
      g.arc(0, 0, r * 1.28, 0, Math.PI * 2);
      g.fill();
    });
  }
};

var Coin = class Coin extends Body {
  /**
   * @param {number} id
   * @param {'white'|'black'|'queen'} type
   */
  constructor(id, type, x, y) {
    super({
      id,
      type,
      x, y,
      r: CONFIG.COIN_R,
      m: type === 'queen' ? CONFIG.QUEEN_MASS : CONFIG.COIN_MASS
    });

    // Deterministic per-coin grain rotation so the wood grain of each
    // coin looks unique without using Math.random().
    this.grain = (id * 0.618034) % 1 * Math.PI * 2;

    // Cosmetic-only pocket animation state.
    this.sinkT = 0;
    this.glow = 0;
  }

  get isQueen() { return this.type === 'queen'; }

  /** Cosmetic per-frame update. Never affects physics. */
  updateVisual(dt) {
    if (this.potted && this.sinkT < 1) this.sinkT = Math.min(1, this.sinkT + dt * 3.2);
    if (!this.potted) this.sinkT = 0;
    if (this.glow > 0) this.glow = Math.max(0, this.glow - dt * 2.2);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {{quality:'low'|'medium'|'high'}} opts
   */
  draw(ctx, opts) {
    if (!this.active) return;
    if (this.potted && this.sinkT >= 1) return;

    const q = (opts && opts.quality) || 'high';
    const shrink = this.potted ? (1 - this.sinkT) : 1;
    const r = this.r * shrink;
    if (r <= 0.4) return;

    const sprite = CoinSprite.get('coin:' + this.type + ':' + q, this.r,
      (g, br) => this._paint(g, br, q));

    ctx.save();
    ctx.globalAlpha = this.potted ? Math.max(0, 1 - this.sinkT * 0.6) : 1;
    ctx.translate(this.x, this.y);

    if (q !== 'low') {
      const sh = CoinSprite.shadow(this.r);
      ctx.save();
      ctx.translate(2.4 * shrink, 3.6 * shrink);
      CoinSprite.blit(ctx, sh, r * 1.3, this.r * 1.3);
      ctx.restore();
    }

    ctx.rotate(this.angle + this.grain);
    CoinSprite.blit(ctx, sprite, r, this.r);
    ctx.restore();

    /* ---- "I was just hit" glow (rare, kept as cheap vector) ---- */
    if (this.glow > 0 && q !== 'low') {
      ctx.save();
      ctx.globalAlpha = this.glow * 0.5;
      ctx.strokeStyle = this.isQueen ? '#ff8fa3' : '#ffd66b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.x, this.y, r + 3 + (1 - this.glow) * 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Paints the disc once, centred on (0,0), at radius `r`. */
  _paint(g, r, q) {
    const C = CONFIG.COLORS;
    const face = this.isQueen ? C.queen : (this.type === 'white' ? C.white : C.black);
    const edge = this.isQueen ? C.queenEdge : (this.type === 'white' ? C.whiteEdge : C.blackEdge);

    /* ---- bevelled rim ---- */
    const rim = g.createLinearGradient(-r, -r, r, r);
    rim.addColorStop(0, edge);
    rim.addColorStop(0.5, this.type === 'black' ? '#3a3a3a' : edge);
    rim.addColorStop(1, '#000');
    g.fillStyle = rim;
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fill();

    /* ---- lacquered face ---- */
    const gr = g.createRadialGradient(-r * 0.34, -r * 0.4, r * 0.05, 0, 0, r * 0.94);
    gr.addColorStop(0, this._lighten(face, 0.35));
    gr.addColorStop(0.55, face);
    gr.addColorStop(1, this._darken(face, 0.3));
    g.fillStyle = gr;
    g.beginPath();
    g.arc(0, 0, r * 0.88, 0, Math.PI * 2);
    g.fill();

    /* ---- turned concentric grooves ---- */
    if (q !== 'low') {
      g.strokeStyle = this.type === 'black' ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.13)';
      g.lineWidth = 0.8;
      for (let i = 1; i <= 3; i++) {
        g.beginPath();
        g.arc(0, 0, r * (0.24 + i * 0.19), 0, Math.PI * 2);
        g.stroke();
      }
    }

    /* ---- queen's engraved star ---- */
    if (this.isQueen) {
      g.strokeStyle = 'rgba(255,225,225,.6)';
      g.lineWidth = 1.1;
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const rr = i % 2 ? r * 0.22 : r * 0.5;
        const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      g.stroke();
    }

    /* ---- specular highlight ---- */
    if (q === 'high') {
      const s = g.createRadialGradient(-r * 0.36, -r * 0.42, 0, -r * 0.36, -r * 0.42, r * 0.62);
      s.addColorStop(0, 'rgba(255,255,255,.55)');
      s.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = s;
      g.beginPath();
      g.arc(0, 0, r * 0.88, 0, Math.PI * 2);
      g.fill();
    }
  }

  /* ---------------- colour helpers ---------------- */

  _mix(hex, target, t) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const mr = Math.round(r + (target - r) * t);
    const mg = Math.round(g + (target - g) * t);
    const mb = Math.round(b + (target - b) * t);
    return 'rgb(' + mr + ',' + mg + ',' + mb + ')';
  }
  _lighten(hex, t) { return this._mix(hex, 255, t); }
  _darken(hex, t) { return this._mix(hex, 0, t); }
};

globalThis.CoinSprite = CoinSprite;
globalThis.Coin = Coin;
