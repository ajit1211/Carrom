/* ============================================================
 * coin.js — a carrom man (coin).
 *
 * The class is split cleanly: everything above `draw()` is pure data
 * and is executed on the server too. `draw()` only ever touches the
 * CanvasRenderingContext2D it is handed, so the server never calls it.
 * ============================================================ */
'use strict';

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

    const C = CONFIG.COLORS;
    const face = this.isQueen ? C.queen : (this.type === 'white' ? C.white : C.black);
    const edge = this.isQueen ? C.queenEdge : (this.type === 'white' ? C.whiteEdge : C.blackEdge);

    ctx.save();
    ctx.globalAlpha = this.potted ? Math.max(0, 1 - this.sinkT * 0.6) : 1;
    ctx.translate(this.x, this.y);

    /* ---- contact shadow (a soft radial fake — ctx.filter is far too
       expensive to run 19 times a frame) ---- */
    if (q !== 'low') {
      const sh = ctx.createRadialGradient(2.4, 3.6, r * 0.5, 2.4, 3.6, r * 1.25);
      sh.addColorStop(0, 'rgba(0,0,0,.42)');
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sh;
      ctx.beginPath();
      ctx.arc(2.4, 3.6, r * 1.25, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.rotate(this.angle + this.grain);

    /* ---- bevelled rim ---- */
    const rim = ctx.createLinearGradient(-r, -r, r, r);
    rim.addColorStop(0, edge);
    rim.addColorStop(0.5, this.type === 'black' ? '#3a3a3a' : edge);
    rim.addColorStop(1, '#000');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    /* ---- lacquered face ---- */
    const g = ctx.createRadialGradient(-r * 0.34, -r * 0.4, r * 0.05, 0, 0, r * 0.94);
    g.addColorStop(0, this._lighten(face, 0.35));
    g.addColorStop(0.55, face);
    g.addColorStop(1, this._darken(face, 0.3));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.88, 0, Math.PI * 2);
    ctx.fill();

    /* ---- turned concentric grooves ---- */
    if (q !== 'low') {
      ctx.strokeStyle = this.type === 'black' ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.13)';
      ctx.lineWidth = 0.8;
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, r * (0.24 + i * 0.19), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    /* ---- queen's engraved star ---- */
    if (this.isQueen) {
      ctx.strokeStyle = 'rgba(255,225,225,.6)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const rr = i % 2 ? r * 0.22 : r * 0.5;
        const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    /* ---- specular highlight ---- */
    if (q === 'high') {
      const s = ctx.createRadialGradient(-r * 0.36, -r * 0.42, 0, -r * 0.36, -r * 0.42, r * 0.62);
      s.addColorStop(0, 'rgba(255,255,255,.55)');
      s.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = s;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.88, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    /* ---- "I was just hit" glow ---- */
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

globalThis.Coin = Coin;
