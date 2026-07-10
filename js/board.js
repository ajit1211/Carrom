/* ============================================================
 * board.js — draws the wooden board once into an offscreen canvas
 * and blits it every frame. Everything (grain, pockets, markings)
 * is generated procedurally: the project ships zero image assets,
 * so nothing can 404 on GitHub Pages and no artwork is borrowed.
 * ============================================================ */
'use strict';

var Board = class Board {
  /** @param {'low'|'medium'|'high'} quality */
  constructor(quality = 'high') {
    this.quality = quality;
    this.canvas = null;
    this.dirty = true;
  }

  setQuality(q) {
    if (q === this.quality) return;
    this.quality = q;
    this.dirty = true;
  }

  /** Blit the cached board. Rebuilds lazily. */
  draw(ctx) {
    if (this.dirty || !this.canvas) this._build();
    ctx.drawImage(this.canvas, 0, 0);
  }

  /* ---------------- texture construction ---------------- */

  _build() {
    const S = CONFIG.BOARD_SIZE;
    const cv = (typeof document !== 'undefined')
      ? Object.assign(document.createElement('canvas'), { width: S, height: S })
      : new OffscreenCanvas(S, S);
    const c = cv.getContext('2d');

    this._frame(c);
    this._playfield(c);
    this._markings(c);
    this._pockets(c);
    this._lighting(c);

    this.canvas = cv;
    this.dirty = false;
  }

  /* Outer wooden frame. */
  _frame(c) {
    const S = CONFIG.BOARD_SIZE;

    const g = c.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, '#7a4d1c');
    g.addColorStop(0.35, '#5d3712');
    g.addColorStop(0.7, '#4a2b0d');
    g.addColorStop(1, '#6b431a');
    c.fillStyle = g;
    this._roundRect(c, 0, 0, S, S, 16);
    c.fill();

    this._grain(c, 0, 0, S, S, '#2b1806', this.quality === 'high' ? 220 : 90, 0.10);

    // bevel highlight around the outside
    c.strokeStyle = 'rgba(255, 210, 150, .18)';
    c.lineWidth = 3;
    this._roundRect(c, 1.5, 1.5, S - 3, S - 3, 15);
    c.stroke();
  }

  /* Inner playing bed. */
  _playfield(c) {
    const a = CONFIG.PLAY_MIN, s = CONFIG.PLAY;

    // recessed shadow where the bed meets the frame
    c.save();
    c.shadowColor = 'rgba(0,0,0,.65)';
    c.shadowBlur = 18;
    c.fillStyle = '#000';
    c.fillRect(a - 3, a - 3, s + 6, s + 6);
    c.restore();

    const g = c.createLinearGradient(a, a, a + s, a + s);
    g.addColorStop(0, '#e8c98f');
    g.addColorStop(0.3, '#dcb877');
    g.addColorStop(0.62, '#d0a862');
    g.addColorStop(1, '#e2c084');
    c.fillStyle = g;
    c.fillRect(a, a, s, s);

    this._grain(c, a, a, s, s, '#8a5f28', this.quality === 'low' ? 60 : 200, 0.055);

    // ply edge
    c.strokeStyle = 'rgba(60,32,8,.55)';
    c.lineWidth = 2;
    c.strokeRect(a - 1, a - 1, s + 2, s + 2);
  }

  /**
   * Deterministic wood grain: sinusoidal fibres with an LCG jitter so the
   * pattern is stable across reloads (and identical for both players).
   */
  _grain(c, x, y, w, h, color, lines, alpha) {
    let seed = 987654321;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    c.globalAlpha = alpha;
    c.strokeStyle = color;

    for (let i = 0; i < lines; i++) {
      const yy = y + rnd() * h;
      const amp = 2 + rnd() * 9;
      const freq = 0.006 + rnd() * 0.016;
      const phase = rnd() * Math.PI * 2;
      c.lineWidth = 0.4 + rnd() * 1.5;
      c.beginPath();
      for (let px = x; px <= x + w; px += 8) {
        const py = yy + Math.sin(px * freq + phase) * amp;
        px === x ? c.moveTo(px, py) : c.lineTo(px, py);
      }
      c.stroke();
    }
    c.restore();
  }

  /* Base lines, red circles, arrows, centre rosette. */
  _markings(c) {
    const L = CONFIG.LAYOUT;
    const CEN = CONFIG.CENTER;
    const OUT_A = CONFIG.PLAY_MIN + L.INSET;      // 193
    const IN_A = OUT_A + L.GAP;                   // 206
    const OUT_B = CONFIG.PLAY_MAX - L.INSET;      // 707
    const IN_B = OUT_B - L.GAP;                   // 694

    c.save();
    c.lineCap = 'round';

    /* --- the two-line base rails on all four sides --- */
    c.strokeStyle = 'rgba(30,20,10,.72)';
    c.lineWidth = 2.4;
    const rail = (x1, y1, x2, y2) => { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); };

    rail(OUT_A, OUT_A, OUT_B, OUT_A); rail(OUT_A, IN_A, OUT_B, IN_A);   // top
    rail(OUT_A, OUT_B, OUT_B, OUT_B); rail(OUT_A, IN_B, OUT_B, IN_B);   // bottom
    rail(OUT_A, OUT_A, OUT_A, OUT_B); rail(IN_A, OUT_A, IN_A, OUT_B);   // left
    rail(OUT_B, OUT_A, OUT_B, OUT_B); rail(IN_B, OUT_A, IN_B, OUT_B);   // right

    /* --- red base circles at the four corners of the rail square --- */
    const corners = [[OUT_A, OUT_A], [OUT_B, OUT_A], [OUT_A, OUT_B], [OUT_B, OUT_B]];
    for (const [x, y] of corners) {
      c.beginPath();
      c.arc(x, y, L.BASE_CIRCLE_R, 0, Math.PI * 2);
      c.fillStyle = '#b5202c';
      c.fill();
      c.lineWidth = 1.6;
      c.strokeStyle = 'rgba(40,10,10,.75)';
      c.stroke();
      // a bright dot in the middle, as on a real board
      c.beginPath();
      c.arc(x, y, L.BASE_CIRCLE_R * 0.32, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,220,220,.75)';
      c.fill();
    }

    /* --- diagonal arrows pointing from each red circle to the centre --- */
    for (const [x, y] of corners) {
      const dx = CEN - x, dy = CEN - y;
      const len = Math.hypot(dx, dy);
      const ux = dx / len, uy = dy / len;
      const start = L.BASE_CIRCLE_R + 6;
      const end = len - L.CENTER_CIRCLE_R - 6;

      c.strokeStyle = 'rgba(30,20,10,.62)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x + ux * start, y + uy * start);
      c.lineTo(x + ux * end, y + uy * end);
      c.stroke();

      // arrowhead at the centre end
      const hx = x + ux * end, hy = y + uy * end;
      const a = Math.atan2(uy, ux), w = 0.42, hl = 13;
      c.beginPath();
      c.moveTo(hx, hy);
      c.lineTo(hx - Math.cos(a - w) * hl, hy - Math.sin(a - w) * hl);
      c.lineTo(hx - Math.cos(a + w) * hl, hy - Math.sin(a + w) * hl);
      c.closePath();
      c.fillStyle = 'rgba(30,20,10,.62)';
      c.fill();
    }

    /* --- centre rosette --- */
    c.beginPath();
    c.arc(CEN, CEN, L.CENTER_CIRCLE_R, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(30,20,10,.68)';
    c.lineWidth = 2.2;
    c.stroke();

    // 8 petals
    c.strokeStyle = 'rgba(30,20,10,.36)';
    c.lineWidth = 1.4;
    const pr = L.CENTER_CIRCLE_R * 0.62;
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      c.beginPath();
      c.arc(CEN + Math.cos(a) * pr * 0.72, CEN + Math.sin(a) * pr * 0.72, pr * 0.55, 0, Math.PI * 2);
      c.stroke();
    }

    // inner ring + red heart
    c.beginPath();
    c.arc(CEN, CEN, L.INNER_CIRCLE_R + 6, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(30,20,10,.55)';
    c.lineWidth = 1.6;
    c.stroke();

    c.beginPath();
    c.arc(CEN, CEN, L.INNER_CIRCLE_R, 0, Math.PI * 2);
    c.fillStyle = 'rgba(181,32,44,.20)';
    c.fill();
    c.strokeStyle = 'rgba(181,32,44,.6)';
    c.lineWidth = 1.4;
    c.stroke();

    c.restore();
  }

  /* Four corner pockets: hole, lip, brass ring. */
  _pockets(c) {
    for (const p of CONFIG.POCKETS) {
      const R = CONFIG.POCKET_R;

      // dark hole with a hint of depth
      const g = c.createRadialGradient(p.x, p.y, 1, p.x, p.y, R);
      g.addColorStop(0, '#000');
      g.addColorStop(0.72, '#05070c');
      g.addColorStop(1, '#1b1206');
      c.fillStyle = g;
      c.beginPath();
      c.arc(p.x, p.y, R, 0, Math.PI * 2);
      c.fill();

      // ambient occlusion around the mouth
      if (this.quality !== 'low') {
        const ao = c.createRadialGradient(p.x, p.y, R, p.x, p.y, R + 12);
        ao.addColorStop(0, 'rgba(0,0,0,.55)');
        ao.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = ao;
        c.beginPath();
        c.arc(p.x, p.y, R + 12, 0, Math.PI * 2);
        c.fill();
      }

      // brass ring, lit from the top-left
      const ring = c.createLinearGradient(p.x - R, p.y - R, p.x + R, p.y + R);
      ring.addColorStop(0, '#f5d98b');
      ring.addColorStop(0.45, '#b8862f');
      ring.addColorStop(1, '#6b4a12');
      c.strokeStyle = ring;
      c.lineWidth = 3;
      c.beginPath();
      c.arc(p.x, p.y, R + 1.5, 0, Math.PI * 2);
      c.stroke();
    }
  }

  /* Global sheen + vignette so the bed looks lacquered. */
  _lighting(c) {
    if (this.quality === 'low') return;
    const S = CONFIG.BOARD_SIZE;

    const sheen = c.createLinearGradient(0, 0, S * 0.8, S);
    sheen.addColorStop(0, 'rgba(255,255,255,.16)');
    sheen.addColorStop(0.32, 'rgba(255,255,255,.04)');
    sheen.addColorStop(0.6, 'rgba(255,255,255,0)');
    c.fillStyle = sheen;
    c.fillRect(0, 0, S, S);

    const vig = c.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S * 0.78);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,.32)');
    c.fillStyle = vig;
    c.fillRect(0, 0, S, S);
  }

  /* ---------------- overlays drawn on top of the coins ---------------- */

  /** Highlights the base rail the current shooter is allowed to use. */
  drawActiveRail(ctx, seat, color, t) {
    const L = CONFIG.LAYOUT;
    const a = Utils.strikerPos(seat, L.STRIKER_MIN);
    const b = Utils.strikerPos(seat, L.STRIKER_MAX);
    const pulse = 0.35 + 0.25 * Math.sin(t * 2.6);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = pulse;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  /** Debug: pocket capture radii + playfield bounds. */
  drawDebug(ctx, world) {
    ctx.save();
    ctx.strokeStyle = '#35d39a';
    ctx.lineWidth = 1;
    ctx.strokeRect(CONFIG.PLAY_MIN, CONFIG.PLAY_MIN, CONFIG.PLAY, CONFIG.PLAY);

    ctx.strokeStyle = '#ff5d6c';
    for (const p of world.pockets) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.strokeStyle = '#7ab8ff';
    for (const b of world.live) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.stroke();
      if (b.moving) {
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x + b.vx * 0.08, b.y + b.vy * 0.08);
        ctx.strokeStyle = '#f0b429';
        ctx.stroke();
        ctx.strokeStyle = '#7ab8ff';
      }
    }
    ctx.restore();
  }

  _roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
};

globalThis.Board = Board;
