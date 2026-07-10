/* ============================================================
 * striker.js — the striker disc + the aiming model.
 *
 * The striker is just a heavier, larger Coin as far as the solver is
 * concerned. Everything else here is presentation and input maths.
 *
 * Look: a tournament-style acrylic striker — ivory body with bold
 * coloured rings and a coloured centre dot (the classic design), where
 * the ring colour comes from the player's chosen skin. Rendering is
 * sprite-cached per skin, same as the coins.
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

    const sprite = CoinSprite.get('striker:' + this.face + ':' + this.rim + ':' + q,
      this.r, (g, br) => this._paintStriker(g, br, q));

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.globalAlpha = this.potted ? Math.max(0, 1 - this.sinkT * 0.6) : 1;

    if (q !== 'low') {
      const sh = CoinSprite.shadow(this.r);
      ctx.save();
      ctx.translate(3 * shrink, 4.2 * shrink);
      CoinSprite.blit(ctx, sh, r * 1.3, this.r * 1.3);
      ctx.restore();
    }

    ctx.rotate(this.angle);
    CoinSprite.blit(ctx, sprite, r, this.r);
    ctx.restore();
  }

  /** Paints the striker once, centred on (0,0), at radius `r`. */
  _paintStriker(g, r, q) {
    /* ---- machined rim, lit from the top-left ---- */
    const rim = g.createLinearGradient(-r, -r, r, r);
    rim.addColorStop(0, this._lighten(this.rim, 0.75));
    rim.addColorStop(0.35, this.rim);
    rim.addColorStop(0.7, this._darken(this.rim, 0.42));
    rim.addColorStop(1, this._lighten(this.rim, 0.4));
    g.fillStyle = rim;
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fill();

    /* ---- glossy ivory body, faintly tinted by the skin ---- */
    const body = g.createRadialGradient(-r * 0.32, -r * 0.38, r * 0.05, 0, 0, r * 0.95);
    body.addColorStop(0, this._lighten(this.face, 0.7));
    body.addColorStop(0.5, this._lighten(this.face, 0.35));
    body.addColorStop(1, this.face);
    g.fillStyle = body;
    g.beginPath();
    g.arc(0, 0, r * 0.87, 0, Math.PI * 2);
    g.fill();

    /* ---- tournament rings in the skin colour ---- */
    g.strokeStyle = this.rim;
    g.globalAlpha = 0.9;
    g.lineWidth = r * 0.10;
    g.beginPath();
    g.arc(0, 0, r * 0.68, 0, Math.PI * 2);
    g.stroke();

    g.globalAlpha = 0.55;
    g.lineWidth = r * 0.035;
    g.beginPath();
    g.arc(0, 0, r * 0.48, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;

    /* ---- coloured centre boss with a bright pip ---- */
    const boss = g.createRadialGradient(-r * 0.05, -r * 0.07, r * 0.02, 0, 0, r * 0.2);
    boss.addColorStop(0, this._lighten(this.rim, 0.45));
    boss.addColorStop(1, this._darken(this.rim, 0.2));
    g.fillStyle = boss;
    g.beginPath();
    g.arc(0, 0, r * 0.17, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = this._lighten(this.face, 0.8);
    g.beginPath();
    g.arc(-r * 0.045, -r * 0.055, r * 0.05, 0, Math.PI * 2);
    g.fill();

    /* ---- specular sweep ---- */
    if (q === 'high') {
      const s = g.createRadialGradient(-r * 0.38, -r * 0.44, 0, -r * 0.38, -r * 0.44, r * 0.66);
      s.addColorStop(0, 'rgba(255,255,255,.85)');
      s.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = s;
      g.beginPath();
      g.arc(0, 0, r * 0.87, 0, Math.PI * 2);
      g.fill();
    }
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

  /** The origin follows the striker while it is being repositioned. */
  setOrigin(ox, oy) { this.originX = ox; this.originY = oy; }

  cancel() { this.active = false; }

  /** Vector from the pointer back to the striker == the shot direction. */
  get dx() { return this.originX - this.pointerX; }
  get dy() { return this.originY - this.pointerY; }
  get pull() { return Math.hypot(this.dx, this.dy); }

  get angle() { return Math.atan2(this.dy, this.dx); }

  /**
   * Pointer is close enough to the striker that there is no shot to speak of.
   * The controller turns this into "slide the striker along its rail", so a
   * player can wind back to 0% to re-place the disc without lifting a finger.
   */
  get inDeadzone() { return this.pull <= CONFIG.AIM_DEADZONE; }

  /**
   * 0..1. Stays at exactly 0 through the whole deadzone, then ramps to full
   * power at CONFIG.MAX_PULL — so "0%" is a region you can aim for, not a
   * single pixel.
   */
  get power() {
    const span = CONFIG.MAX_PULL - CONFIG.AIM_DEADZONE;
    return Utils.clamp((this.pull - CONFIG.AIM_DEADZONE) / span, 0, 1);
  }

  /** Releasing inside the deadzone never fires: it is the cancel gesture. */
  get valid() { return !this.inDeadzone; }

  get dir() {
    const l = this.pull || 1;
    return { x: this.dx / l, y: this.dy / l };
  }
};

globalThis.Striker = Striker;
globalThis.Aim = Aim;
