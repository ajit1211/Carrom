/* ============================================================
 * board.js — draws the wooden board once into an offscreen canvas
 * and blits it every frame. Everything (grain, pockets, markings)
 * is generated procedurally: the project ships zero image assets,
 * so nothing can 404 on GitHub Pages and no artwork is borrowed.
 *
 * The board is themeable: CONFIG.BOARD_THEMES lists the palettes,
 * the player picks one in Settings, and setTheme() rebuilds the
 * cached texture. Purely cosmetic — physics never reads a theme.
 * ============================================================ */
'use strict';

var Board = class Board {
  /**
   * @param {'low'|'medium'|'high'} quality
   * @param {string} [themeId] one of CONFIG.BOARD_THEMES ids
   */
  constructor(quality = 'high', themeId) {
    this.quality = quality;
    this.canvas = null;
    this.dirty = true;
    this.theme = Board.themeById(themeId);
  }

  static themeById(id) {
    return CONFIG.BOARD_THEMES.find(t => t.id === id) || CONFIG.BOARD_THEMES[0];
  }

  setQuality(q) {
    if (q === this.quality) return;
    this.quality = q;
    this.dirty = true;
  }

  setTheme(id) {
    const t = Board.themeById(id);
    if (t === this.theme) return;
    this.theme = t;
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
    this._corners(c);
    this._playfield(c);
    this._markings(c);
    this._pockets(c);
    this._lighting(c);

    this.canvas = cv;
    this.dirty = false;
  }

  /* Outer lacquered frame. */
  _frame(c) {
    const S = CONFIG.BOARD_SIZE;
    const T = this.theme;

    const g = c.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, T.frame[0]);
    g.addColorStop(0.35, T.frame[1]);
    g.addColorStop(0.7, T.frame[2]);
    g.addColorStop(1, T.frame[3]);
    c.fillStyle = g;
    this._roundRect(c, 0, 0, S, S, 20);
    c.fill();

    this._grain(c, 0, 0, S, S, '#2b1806', this.quality === 'high' ? 220 : 90, 0.08);

    // twin bevel: bright highlight outside, dark groove just inside —
    // reads as a thick lacquered edge like a tournament frame
    c.strokeStyle = T.frameEdge;
    c.lineWidth = 3;
    this._roundRect(c, 1.5, 1.5, S - 3, S - 3, 19);
    c.stroke();

    c.strokeStyle = 'rgba(0,0,0,.35)';
    c.lineWidth = 2;
    this._roundRect(c, 7, 7, S - 14, S - 14, 15);
    c.stroke();

    // brass screws along the frame mid-line, like a real board
    if (this.quality !== 'low') {
      const m = CONFIG.FRAME / 2;
      const spots = [
        [S / 2, m], [S / 2, S - m], [m, S / 2], [S - m, S / 2]
      ];
      for (const [x, y] of spots) {
        const sg = c.createRadialGradient(x - 1, y - 1, 0.5, x, y, 4);
        sg.addColorStop(0, '#ffe9ac');
        sg.addColorStop(0.6, '#b8862f');
        sg.addColorStop(1, '#5f430f');
        c.fillStyle = sg;
        c.beginPath();
        c.arc(x, y, 3.4, 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  /* Black rounded corner plates on the frame (as on club boards). */
  _corners(c) {
    const S = CONFIG.BOARD_SIZE;
    const T = this.theme;
    const R = CONFIG.FRAME + 26;

    c.save();
    this._roundRect(c, 0, 0, S, S, 20);
    c.clip();

    for (const [x, y] of [[0, 0], [S, 0], [0, S], [S, S]]) {
      const g = c.createRadialGradient(x, y, R * 0.3, x, y, R);
      g.addColorStop(0, this._shade(T.corner, 26));
      g.addColorStop(0.75, T.corner);
      g.addColorStop(1, this._shade(T.corner, -14));
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, R, 0, Math.PI * 2);
      c.fill();

      // thin gold trim on the plate's arc
      c.strokeStyle = 'rgba(255,215,140,.28)';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(x, y, R - 2, 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
  }

  /* Inner playing bed. */
  _playfield(c) {
    const a = CONFIG.PLAY_MIN, s = CONFIG.PLAY;
    const T = this.theme;

    // recessed shadow where the bed meets the frame
    c.save();
    c.shadowColor = 'rgba(0,0,0,.65)';
    c.shadowBlur = 18;
    c.fillStyle = '#000';
    c.fillRect(a - 3, a - 3, s + 6, s + 6);
    c.restore();

    const g = c.createLinearGradient(a, a, a + s, a + s);
    g.addColorStop(0, T.bed[0]);
    g.addColorStop(0.3, T.bed[1]);
    g.addColorStop(0.62, T.bed[2]);
    g.addColorStop(1, T.bed[3]);
    c.fillStyle = g;
    c.fillRect(a, a, s, s);

    this._grain(c, a, a, s, s, T.grain, this.quality === 'low' ? 60 : 200, 0.05);

    // ply edge
    c.strokeStyle = 'rgba(40,22,6,.55)';
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
    const T = this.theme;
    const OUT_A = CONFIG.PLAY_MIN + L.INSET;
    const IN_A = OUT_A + L.GAP;
    const OUT_B = CONFIG.PLAY_MAX - L.INSET;
    const IN_B = OUT_B - L.GAP;

    c.save();
    c.lineCap = 'round';

    /* --- the two-line base rails on all four sides --- */
    c.strokeStyle = T.line;
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
      c.fillStyle = T.accent;
      c.fill();
      c.lineWidth = 1.6;
      c.strokeStyle = 'rgba(40,10,10,.75)';
      c.stroke();
      // a bright dot in the middle, as on a real board
      c.beginPath();
      c.arc(x, y, L.BASE_CIRCLE_R * 0.32, 0, Math.PI * 2);
      c.fillStyle = T.accentDot;
      c.fill();
    }

    /* --- diagonal arrows pointing from each red circle to the centre --- */
    for (const [x, y] of corners) {
      const dx = CEN - x, dy = CEN - y;
      const len = Math.hypot(dx, dy);
      const ux = dx / len, uy = dy / len;
      const start = L.BASE_CIRCLE_R + 6;
      const end = len - L.CENTER_CIRCLE_R - 6;

      c.strokeStyle = T.line;
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
      c.fillStyle = T.line;
      c.fill();
    }

    /* --- centre rosette --- */
    c.beginPath();
    c.arc(CEN, CEN, L.CENTER_CIRCLE_R, 0, Math.PI * 2);
    c.strokeStyle = T.line;
    c.lineWidth = 2.2;
    c.stroke();

    // 8 petals
    c.strokeStyle = this._fade(T.line, 0.5);
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
    c.strokeStyle = this._fade(T.line, 0.78);
    c.lineWidth = 1.6;
    c.stroke();

    c.beginPath();
    c.arc(CEN, CEN, L.INNER_CIRCLE_R, 0, Math.PI * 2);
    c.fillStyle = T.centerFill;
    c.fill();
    c.strokeStyle = T.accent;
    c.globalAlpha = 0.6;
    c.lineWidth = 1.4;
    c.stroke();
    c.globalAlpha = 1;

    c.restore();
  }

  /* Four corner pockets: hole, ambient occlusion, coloured ring. */
  _pockets(c) {
    const T = this.theme;
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

      // chunky themed ring, lit from the top-left (orange on Classic Club)
      const ring = c.createLinearGradient(p.x - R, p.y - R, p.x + R, p.y + R);
      ring.addColorStop(0, T.pocketRing[0]);
      ring.addColorStop(0.45, T.pocketRing[1]);
      ring.addColorStop(1, T.pocketRing[2]);
      c.strokeStyle = ring;
      c.lineWidth = 4.5;
      c.beginPath();
      c.arc(p.x, p.y, R + 2, 0, Math.PI * 2);
      c.stroke();

      // hairline inside the ring so it reads as turned metal/wood
      c.strokeStyle = 'rgba(0,0,0,.5)';
      c.lineWidth = 1;
      c.beginPath();
      c.arc(p.x, p.y, R - 0.5, 0, Math.PI * 2);
      c.stroke();
    }
  }

  /* Global sheen + vignette so the bed looks lacquered. */
  _lighting(c) {
    if (this.quality === 'low') return;
    const S = CONFIG.BOARD_SIZE;

    const sheen = c.createLinearGradient(0, 0, S * 0.8, S);
    sheen.addColorStop(0, 'rgba(255,255,255,.15)');
    sheen.addColorStop(0.32, 'rgba(255,255,255,.04)');
    sheen.addColorStop(0.6, 'rgba(255,255,255,0)');
    c.fillStyle = sheen;
    c.fillRect(0, 0, S, S);

    const vig = c.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S * 0.78);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,.30)');
    c.fillStyle = vig;
    c.fillRect(0, 0, S, S);
  }

  /* ---------------- colour helpers ---------------- */

  /** Shift a #rrggbb by +/- amount per channel. */
  _shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const cl = (v) => Math.max(0, Math.min(255, v + amt));
    const r = cl((n >> 16) & 255), g = cl((n >> 8) & 255), b = cl(n & 255);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /** Multiply the alpha of an rgba()/rgb() string. */
  _fade(rgba, mul) {
    const m = /rgba?\(([^)]+)\)/.exec(rgba);
    if (!m) return rgba;
    const parts = m[1].split(',').map(s => s.trim());
    const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
    return 'rgba(' + parts[0] + ',' + parts[1] + ',' + parts[2] + ',' + (a * mul).toFixed(3) + ')';
  }

  /* ---------------- overlays drawn on top of the coins ---------------- */

  /**
   * A name plate on the frame beside every occupied seat, so it is always
   * obvious who is sitting on which side.
   *
   * Each plate starts rotated by -rot(seat) — the inverse of the view rotation
   * that seat's own player uses — so it sits square to its own side of the
   * board. It is then flipped if that would leave it upside-down on THIS
   * screen: a name you cannot read tells you nothing about who is sitting
   * there. Plates on the left/right bands stay at 90 degrees, which is
   * readable and fits the narrow frame.
   *
   * @param {Array<{seat:number,name:string,color:'white'|'black',active:boolean}>} labels
   * @param {number} viewRot the canvas rotation this player is looking through
   */
  drawSeatLabels(ctx, labels, viewRot) {
    const S = CONFIG.BOARD_SIZE, m = CONFIG.FRAME / 2, C = CONFIG.CENTER;
    const anchor = [
      { x: C, y: S - m }, { x: m, y: C }, { x: C, y: m }, { x: S - m, y: C }
    ];

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    for (const L of labels) {
      const a = anchor[L.seat];
      if (!a) continue;

      let rot = -Utils.railFor(L.seat).rot;
      const onScreen = Math.atan2(Math.sin(rot + (viewRot || 0)), Math.cos(rot + (viewRot || 0)));
      if (Math.abs(onScreen) > Math.PI / 2 + 0.01) rot += Math.PI;

      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(rot);

      ctx.font = '700 21px Outfit, system-ui, sans-serif';
      const name = this._ellipsis(ctx, L.name, 190);
      const tw = ctx.measureText(name).width;
      const padL = 11, dotR = 6.5, gap = 9, padR = 15, h = 30;
      const w = padL + dotR * 2 + gap + tw + padR;

      ctx.fillStyle = L.active ? 'rgba(240,180,41,.94)' : 'rgba(10,12,18,.74)';
      this._roundRect(ctx, -w / 2, -h / 2, w, h, h / 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = L.active ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.20)';
      ctx.stroke();

      // the coin colour this seat plays
      ctx.beginPath();
      ctx.arc(-w / 2 + padL + dotR, 0, dotR, 0, Math.PI * 2);
      ctx.fillStyle = L.color === 'white' ? CONFIG.COLORS.white : CONFIG.COLORS.black;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.stroke();

      ctx.fillStyle = L.active ? '#16130a' : '#e8ecf4';
      ctx.fillText(name, -w / 2 + padL + dotR * 2 + gap, 1);
      ctx.restore();
    }
    ctx.restore();
  }

  /** Trim `text` with an ellipsis until it fits `max` px in the current font. */
  _ellipsis(ctx, text, max) {
    let s = String(text == null ? '' : text);
    if (ctx.measureText(s).width <= max) return s;
    while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  }

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
