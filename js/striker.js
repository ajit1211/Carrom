/* ============================================================
 * striker.js — the striker disc + the aiming model.
 *
 * The striker is just a heavier, larger Coin as far as the solver is
 * concerned (mass 2.6x, radius 20.5 vs 15.5). Everything else here is
 * presentation and input maths.
 * ============================================================ */
'use strict';

var Striker = class Striker extends Coin {
  constructor(x, y) {
    super(99, 'striker', x, y);
    // Override the disc properties the Coin constructor guessed.
    this.r = CONFIG.STRIKER_R;
    this.m = CONFIG.STRIKER_MASS;
    this.invM = 1 / this.m;
    this.grain = 0;

    /** Purely cosmetic. Never touched by the solver, so it cannot desync. */
    this.face = CONFIG.DEFAULT_STRIKER_COLOR;
    this.rim = '#8d97a8';
  }

  /** @param {{face:string, rim:string}|null} skin */
  setSkin(skin) {
    this.face = (skin && skin.face) || CONFIG.DEFAULT_STRIKER_COLOR;
    this.rim = (skin && skin.rim) || '#8d97a8';
  }

  draw(ctx, opts) {
    if (!this.active) return;
    if (this.potted && this.sinkT >= 1) return;

    const q = (opts && opts.quality) || 'high';
    const shrink = this.potted ? (1 - this.sinkT) : 1;
    const r = this.r * shrink;
    if (r <= 0.4) return;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.globalAlpha = this.potted ? Math.max(0, 1 - this.sinkT * 0.6) : 1;

    if (q !== 'low') {
      const sh = ctx.createRadialGradient(3, 4.2, r * 0.5, 3, 4.2, r * 1.3);
      sh.addColorStop(0, 'rgba(0,0,0,.5)');
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sh;
      ctx.beginPath();
      ctx.arc(3, 4.2, r * 1.3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.rotate(this.angle);

    // machined rim, lit from the top-left
    const rim = ctx.createLinearGradient(-r, -r, r, r);
    rim.addColorStop(0, this._lighten(this.rim, 0.75));
    rim.addColorStop(0.35, this.rim);
    rim.addColorStop(0.7, this._darken(this.rim, 0.42));
    rim.addColorStop(1, this._lighten(this.rim, 0.4));
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // lacquered face, tinted to the player's chosen colour
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.05, 0, 0, r);
    g.addColorStop(0, this._lighten(this.face, 0.55));
    g.addColorStop(0.5, this.face);
    g.addColorStop(1, this._darken(this.face, 0.24));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.87, 0, Math.PI * 2);
    ctx.fill();

    if (q !== 'low') {
      // machined rings
      ctx.strokeStyle = 'rgba(20,26,36,.20)';
      ctx.lineWidth = 0.9;
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, r * (0.22 + i * 0.2), 0, Math.PI * 2);
        ctx.stroke();
      }
      // centre dimple
      ctx.fillStyle = 'rgba(20,26,36,.30)';
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.11, 0, Math.PI * 2);
      ctx.fill();
    }

    if (q === 'high') {
      const s = ctx.createRadialGradient(-r * 0.38, -r * 0.44, 0, -r * 0.38, -r * 0.44, r * 0.66);
      s.addColorStop(0, 'rgba(255,255,255,.85)');
      s.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = s;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.87, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /** Pulsing halo drawn while it is this player's turn and nothing is moving. */
  drawIdleHalo(ctx, t, color) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.4);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.25 + pulse * 0.4;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r + 4 + pulse * 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
};

/* ------------------------------------------------------------------
 * Aim — converts a slingshot drag into (angle, power).
 *
 * Pull *away* from the intended direction, like a real flick: the
 * striker fires along `origin - pointer`.
 * ------------------------------------------------------------------ */
var Aim = class Aim {
  constructor() {
    this.active = false;
    this.originX = 0;
    this.originY = 0;
    this.pointerX = 0;
    this.pointerY = 0;
  }

  begin(ox, oy, px, py) {
    this.active = true;
    this.originX = ox; this.originY = oy;
    this.pointerX = px; this.pointerY = py;
  }

  move(px, py) { this.pointerX = px; this.pointerY = py; }

  cancel() { this.active = false; }

  /** Vector from the pointer back to the striker == the shot direction. */
  get dx() { return this.originX - this.pointerX; }
  get dy() { return this.originY - this.pointerY; }
  get pull() { return Math.hypot(this.dx, this.dy); }

  get angle() { return Math.atan2(this.dy, this.dx); }

  /** 0..1, capped at CONFIG.MAX_PULL logical pixels of drag. */
  get power() { return Utils.clamp(this.pull / CONFIG.MAX_PULL, 0, 1); }

  /** Below this, releasing does nothing (protects against stray taps). */
  get valid() { return this.pull > 14; }

  get dir() {
    const l = this.pull || 1;
    return { x: this.dx / l, y: this.dy / l };
  }
};

globalThis.Striker = Striker;
globalThis.Aim = Aim;
