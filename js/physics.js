/* ============================================================
 * physics.js — the real thing.
 *
 * Rigid discs with mass, momentum, restitution and sliding friction.
 * Fixed 240 Hz sub-stepping (a 2200 px/s striker moves 9.2 px per
 * sub-step against a 31 px coin diameter, so nothing ever tunnels).
 *
 * The whole file is DETERMINISTIC: no Math.random, no Date, no
 * iteration over unordered maps. Feed the same shot into the same
 * state on the client and the server and you get bit-identical
 * results — that is what makes the server-authoritative online mode
 * cheap (the server only has to confirm, not stream, the outcome).
 *
 * Loaded by the browser AND by the Node server (inside a `vm`).
 * ============================================================ */
'use strict';

/* ------------------------------------------------------------------
 * Body — a solid disc.
 * ------------------------------------------------------------------ */
var Body = class Body {
  /**
   * @param {object} o {id, type, x, y, r, m}
   */
  constructor(o) {
    this.id = o.id;
    this.type = o.type;          // 'white' | 'black' | 'queen' | 'striker'
    this.x = o.x;
    this.y = o.y;
    this.vx = 0;
    this.vy = 0;
    this.r = o.r;
    this.m = o.m;
    this.invM = o.m > 0 ? 1 / o.m : 0;

    this.angle = 0;              // cosmetic spin
    this.angVel = 0;

    this.potted = false;         // sunk in a pocket
    this.active = true;          // false == removed from the playfield
    this.pottedAt = 0;           // animation clock, cosmetic only
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
  get moving() { return (this.vx * this.vx + this.vy * this.vy) > 0.0001; }

  setVelocity(vx, vy) { this.vx = vx; this.vy = vy; }

  stop() { this.vx = 0; this.vy = 0; this.angVel = 0; }

  /** Place the body and clear all motion. */
  place(x, y) { this.x = x; this.y = y; this.stop(); }

  serialize() {
    return { id: this.id, t: this.type, x: this.x, y: this.y, vx: this.vx, vy: this.vy, p: this.potted, a: this.active };
  }

  restore(s) {
    this.x = s.x; this.y = s.y;
    this.vx = s.vx; this.vy = s.vy;
    this.potted = s.p; this.active = s.a;
  }
};

/* ------------------------------------------------------------------
 * World — integrator, collision solver, pocket detector.
 * ------------------------------------------------------------------ */
var World = class World {
  constructor() {
    /** @type {Body[]} every disc, striker last. Order is fixed => determinism. */
    this.bodies = [];
    this.coins = [];
    this.striker = null;

    this.pockets = CONFIG.POCKETS.map(p => ({ x: p.x, y: p.y, r: CONFIG.POCKET_R }));

    /** Drained by the game layer each frame: collisions, pockets, wall hits. */
    this.events = [];

    this._acc = 0;   // leftover time for the fixed step
  }

  /* ---------------- construction ---------------- */

  /** Build the standard opening position. Requires Coin/Striker to exist. */
  static fromLayout() {
    const w = new World();
    for (const c of Utils.initialLayout()) {
      w.addCoin(new Coin(c.id, c.type, c.x, c.y));
    }
    const home = Utils.strikerHome(0);
    w.setStriker(new Striker(home.x, home.y));
    return w;
  }

  addCoin(coin) {
    this.coins.push(coin);
    this._rebuild();
    return coin;
  }

  setStriker(striker) {
    this.striker = striker;
    this._rebuild();
    return striker;
  }

  _rebuild() {
    this.bodies = this.striker ? this.coins.concat([this.striker]) : this.coins.slice();
  }

  /** Bodies currently on the playfield, in stable id order. */
  get live() { return this.bodies.filter(b => b.active && !b.potted); }

  /* ---------------- queries ---------------- */

  coinsLeft(type) { return this.coins.filter(c => c.active && !c.potted && c.type === type).length; }
  queenOnBoard() { return this.coins.some(c => c.type === 'queen' && c.active && !c.potted); }

  isSettled() {
    for (const b of this.bodies) {
      if (b.active && !b.potted && b.moving) return false;
    }
    return true;
  }

  /* ---------------- shooting ---------------- */

  /**
   * Fire the striker.
   * @param {number} angle  radians, direction of travel
   * @param {number} power  0..1
   */
  shoot(angle, power) {
    const s = this.striker;
    if (!s) return;
    s.active = true;
    s.potted = false;
    const speed = CONFIG.MIN_SHOT_SPEED + Utils.clamp(power, 0, 1) * (CONFIG.MAX_SHOT_SPEED - CONFIG.MIN_SHOT_SPEED);
    s.vx = Math.cos(angle) * speed;
    s.vy = Math.sin(angle) * speed;
    s.angVel = 0;
  }

  /* ---------------- stepping ---------------- */

  /**
   * Advance by `dt` seconds using fixed sub-steps.
   * Any remainder is carried over, so the simulation is frame-rate
   * independent AND reproducible.
   */
  step(dt) {
    const H = CONFIG.SUBSTEP;
    this._acc += Math.min(dt, 0.1);       // never spiral after a tab-switch
    let guard = 0;
    while (this._acc >= H && guard++ < 600) {
      this._subStep(H);
      this._acc -= H;
    }
  }

  /** Run headlessly until everything stops. Used by the server. */
  simulate() {
    const H = CONFIG.SUBSTEP;
    const maxSteps = Math.ceil(CONFIG.MAX_SETTLE_TIME / H);
    let steps = 0;
    while (steps++ < maxSteps) {
      this._subStep(H);
      if (this.isSettled()) break;
    }
    this._acc = 0;
    return steps * H;
  }

  _subStep(h) {
    this._integrate(h);
    this._solveCollisions();
    this._solveWalls();
    this._checkPockets();
  }

  /**
   * Semi-implicit Euler + Coulomb sliding friction.
   * Friction gives a CONSTANT deceleration, independent of mass — that is
   * why a heavy striker and a light coin coast for the same distance at
   * the same speed, exactly like on a real board.
   */
  _integrate(h) {
    const decel = CONFIG.FRICTION_DECEL * h;
    for (const b of this.bodies) {
      if (!b.active || b.potted) continue;

      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0) {
        const ns = sp - decel;
        if (ns <= CONFIG.SLEEP_SPEED) {
          b.vx = 0; b.vy = 0;
        } else {
          const k = ns / sp;
          b.vx *= k; b.vy *= k;
        }
      }

      b.x += b.vx * h;
      b.y += b.vy * h;

      // cosmetic spin
      b.angle += b.angVel * h;
      b.angVel *= Math.max(0, 1 - CONFIG.ANGULAR_DAMP * h);
    }
  }

  /** Impulse-based elastic collision resolution for every disc pair. */
  _solveCollisions() {
    const list = this.bodies;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.active || a.potted) continue;

      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.active || b.potted) continue;

        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const rr = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;

        let d = Math.sqrt(d2);
        // Perfectly stacked bodies: pick a deterministic separation axis.
        if (d < 1e-6) { dx = 1; dy = 0; d = 1e-6; }

        const nx = dx / d, ny = dy / d;

        /* ---- 1. positional correction (Baumgarte-ish) ---- */
        const pen = rr - d;
        const invSum = a.invM + b.invM;
        if (invSum > 0 && pen > CONFIG.POSITION_SLOP) {
          const corr = (pen - CONFIG.POSITION_SLOP) * CONFIG.POSITION_PERCENT / invSum;
          a.x -= nx * corr * a.invM; a.y -= ny * corr * a.invM;
          b.x += nx * corr * b.invM; b.y += ny * corr * b.invM;
        }

        /* ---- 2. normal impulse ---- */
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const vn = rvx * nx + rvy * ny;
        if (vn > 0) continue;                    // already separating

        const e = CONFIG.RESTITUTION;
        const jn = -(1 + e) * vn / invSum;

        a.vx -= jn * nx * a.invM; a.vy -= jn * ny * a.invM;
        b.vx += jn * nx * b.invM; b.vy += jn * ny * b.invM;

        /* ---- 3. tangential impulse -> a little spin & scrub ---- */
        const tx = -ny, ty = nx;
        const vt = rvx * tx + rvy * ty;
        const jt = Utils.clamp(-vt / invSum, -CONFIG.TANGENT_FRICTION * jn, CONFIG.TANGENT_FRICTION * jn);
        a.vx -= jt * tx * a.invM; a.vy -= jt * ty * a.invM;
        b.vx += jt * tx * b.invM; b.vy += jt * ty * b.invM;

        a.angVel -= (jt * a.invM) / a.r * 3;
        b.angVel += (jt * b.invM) / b.r * 3;

        /* ---- 4. report ---- */
        const impact = -vn;
        if (impact > 12) {
          this.events.push({
            kind: 'hit',
            a: a.id, b: b.id,
            aType: a.type, bType: b.type,
            x: a.x + nx * a.r, y: a.y + ny * a.r,
            speed: impact
          });
        }
      }
    }
  }

  /** Reflect off the four cushions. Corners are handled by the pockets. */
  _solveWalls() {
    const lo = CONFIG.PLAY_MIN, hi = CONFIG.PLAY_MAX, e = CONFIG.WALL_RESTITUTION;

    for (const b of this.bodies) {
      if (!b.active || b.potted) continue;
      let hit = 0;

      if (b.x - b.r < lo) { b.x = lo + b.r; if (b.vx < 0) { b.vx = -b.vx * e; hit = Math.abs(b.vx); } }
      else if (b.x + b.r > hi) { b.x = hi - b.r; if (b.vx > 0) { b.vx = -b.vx * e; hit = Math.abs(b.vx); } }

      if (b.y - b.r < lo) { b.y = lo + b.r; if (b.vy < 0) { b.vy = -b.vy * e; hit = Math.max(hit, Math.abs(b.vy)); } }
      else if (b.y + b.r > hi) { b.y = hi - b.r; if (b.vy > 0) { b.vy = -b.vy * e; hit = Math.max(hit, Math.abs(b.vy)); } }

      if (hit > 40) {
        this.events.push({ kind: 'wall', id: b.id, type: b.type, x: b.x, y: b.y, speed: hit });
      }
    }
  }

  /** A disc drops when its CENTRE crosses the mouth of a pocket. */
  _checkPockets() {
    for (const b of this.bodies) {
      if (!b.active || b.potted) continue;
      for (let i = 0; i < this.pockets.length; i++) {
        const p = this.pockets[i];
        if (Utils.dist2(b.x, b.y, p.x, p.y) < p.r * p.r) {
          b.potted = true;
          b.stop();
          b.pottedAt = 0;
          this.events.push({ kind: 'pocket', id: b.id, type: b.type, pocket: i, x: p.x, y: p.y });
          break;
        }
      }
    }
  }

  /* ---------------- helpers used by the rules layer ---------------- */

  /**
   * Find a free spot for a coin being returned to the board, spiralling out
   * from the centre. Deterministic: no randomness.
   */
  freeSpotNearCentre(radius) {
    const C = CONFIG.CENTER;
    const isFree = (x, y) => {
      if (x - radius < CONFIG.PLAY_MIN || x + radius > CONFIG.PLAY_MAX) return false;
      if (y - radius < CONFIG.PLAY_MIN || y + radius > CONFIG.PLAY_MAX) return false;
      for (const b of this.bodies) {
        if (!b.active || b.potted) continue;
        const rr = radius + b.r + 0.6;
        if (Utils.dist2(x, y, b.x, b.y) < rr * rr) return false;
      }
      return true;
    };

    if (isFree(C, C)) return { x: C, y: C };

    for (let ring = 1; ring <= 14; ring++) {
      const rad = ring * (radius * 0.9);
      const n = 8 * ring;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const x = C + Math.cos(a) * rad;
        const y = C + Math.sin(a) * rad;
        if (isFree(x, y)) return { x, y };
      }
    }
    return { x: C, y: C }; // board is impossibly crowded; overlap solver will fix it
  }

  /** Bring a potted coin back onto the board. */
  restoreCoin(coin) {
    const spot = this.freeSpotNearCentre(coin.r);
    coin.potted = false;
    coin.active = true;
    coin.place(spot.x, spot.y);
  }

  /**
   * Park the striker on a seat's base line without letting it overlap a coin.
   * @param {number} seat 0=bottom 1=left 2=top 3=right
   * @param {number} [u]  position along that rail; defaults to its centre
   */
  resetStriker(seat, u) {
    const s = this.striker;
    let pu = Utils.clampStrikerU(typeof u === 'number' ? u : CONFIG.CENTER);

    // If a coin is sitting on the base line, slide along it until clear.
    if (this.strikerBlockedAt(pu, seat)) {
      for (let off = 4; off <= CONFIG.PLAY; off += 4) {
        const lo = Utils.clampStrikerU(pu - off);
        const hi = Utils.clampStrikerU(pu + off);
        if (!this.strikerBlockedAt(lo, seat)) { pu = lo; break; }
        if (!this.strikerBlockedAt(hi, seat)) { pu = hi; break; }
      }
    }

    const p = Utils.strikerPos(seat, pu);
    s.potted = false;
    s.active = true;
    s.place(p.x, p.y);
    s.angle = 0;
  }

  /**
   * Would the striker overlap a live coin at rail position `u`?
   * Always false now: the striker may be placed ON TOP of coins sitting on
   * the base line (like the popular mobile games). The collision solver's
   * positional correction separates them on the first sub-steps of the
   * shot, so an overlapped start simply shoves the coin aside.
   * Kept as a function so client, server and any future rule can share one
   * definition. MUST stay deterministic and identical on both sides.
   */
  strikerBlockedAt(u, seat) {
    return false;
  }

  /* ---------------- aim prediction (pure geometry, no side effects) ---------------- */

  /**
   * Cast the striker along `dir` and report the first thing it touches,
   * bouncing off cushions up to `maxBounces` times.
   * @returns {{points:{x,y}[], hit:Body|null, hitPoint:{x,y}|null, hitNormal:{x,y}|null, ghost:{x,y}|null}}
   */
  predict(ox, oy, dirX, dirY, radius, maxBounces = 2) {
    const pts = [{ x: ox, y: oy }];
    let px = ox, py = oy, dx = dirX, dy = dirY;
    const lo = CONFIG.PLAY_MIN + radius, hi = CONFIG.PLAY_MAX - radius;

    for (let bounce = 0; bounce <= maxBounces; bounce++) {
      let bestT = Infinity, bestBody = null;

      // 1) nearest coin along the ray
      for (const b of this.coins) {
        if (!b.active || b.potted) continue;
        const t = this._rayCircle(px, py, dx, dy, b.x, b.y, radius + b.r);
        if (t !== null && t > 1e-4 && t < bestT) { bestT = t; bestBody = b; }
      }

      // 2) nearest cushion
      let wallT = Infinity, nx = 0, ny = 0;
      if (dx > 1e-9) { const t = (hi - px) / dx; if (t < wallT) { wallT = t; nx = -1; ny = 0; } }
      if (dx < -1e-9) { const t = (lo - px) / dx; if (t < wallT) { wallT = t; nx = 1; ny = 0; } }
      if (dy > 1e-9) { const t = (hi - py) / dy; if (t < wallT) { wallT = t; nx = 0; ny = -1; } }
      if (dy < -1e-9) { const t = (lo - py) / dy; if (t < wallT) { wallT = t; nx = 0; ny = 1; } }

      if (bestBody && bestT <= wallT) {
        const hx = px + dx * bestT, hy = py + dy * bestT;
        pts.push({ x: hx, y: hy });
        const n = { x: (bestBody.x - hx), y: (bestBody.y - hy) };
        const nl = Math.hypot(n.x, n.y) || 1;
        n.x /= nl; n.y /= nl;
        return {
          points: pts,
          hit: bestBody,
          hitPoint: { x: hx, y: hy },
          hitNormal: n,
          ghost: { x: hx, y: hy }
        };
      }

      if (!isFinite(wallT)) break;
      px += dx * wallT; py += dy * wallT;
      pts.push({ x: px, y: py });

      // reflect
      const dot = dx * nx + dy * ny;
      dx -= 2 * dot * nx;
      dy -= 2 * dot * ny;
      // nudge off the wall to avoid re-hitting it at t=0
      px += dx * 0.01; py += dy * 0.01;
    }

    return { points: pts, hit: null, hitPoint: null, hitNormal: null, ghost: null };
  }

  /** Smallest positive t with |o + d*t - c| == R, or null. `d` must be unit. */
  _rayCircle(ox, oy, dx, dy, cx, cy, R) {
    const mx = ox - cx, my = oy - cy;
    const b = mx * dx + my * dy;
    const c = mx * mx + my * my - R * R;
    if (c > 0 && b > 0) return null;         // pointing away and outside
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    return t < 0 ? null : t;
  }

  /* ---------------- (de)serialisation for the network ---------------- */

  serialize() {
    return {
      coins: this.coins.map(c => c.serialize()),
      striker: this.striker ? this.striker.serialize() : null
    };
  }

  restore(snap) {
    if (!snap) return;
    for (const s of snap.coins) {
      const c = this.coins.find(k => k.id === s.id);
      if (c) c.restore(s);
    }
    if (snap.striker && this.striker) this.striker.restore(snap.striker);
    this._acc = 0;
    this.events.length = 0;
  }

  /** Nuke everything and rebuild the opening position, in place. */
  reset() {
    this.coins.length = 0;
    for (const c of Utils.initialLayout()) this.coins.push(new Coin(c.id, c.type, c.x, c.y));
    const home = Utils.strikerHome(0);
    this.striker = new Striker(home.x, home.y);
    this._rebuild();
    this.events.length = 0;
    this._acc = 0;
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
};

globalThis.Body = Body;
globalThis.World = World;
