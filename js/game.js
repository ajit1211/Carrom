/* ============================================================
 * game.js — the controller: input, loop, rendering, rules, netcode.
 *
 * Formats
 *   singles (2) : seats 0 (bottom) and 2 (top), one team each
 *   doubles (4) : seats 0..3 clockwise, partners facing;
 *                 team 0 = {0,2} White, team 1 = {1,3} Black
 *
 * Modes
 *   practice : one seat, no rules, unlimited shots
 *   local    : every seat on this device, full rules
 *   online   : one seat per socket, full rules, server-authoritative
 *
 * The board is rotated so the local player's rail is always at the bottom
 * of their screen. All physics stays in un-rotated board space; only the
 * canvas transform and the pointer mapping know about the rotation.
 *
 * Online model: we simulate our own shot the instant the pointer is
 * released (zero perceived latency) and send it to the server. The server
 * replays the same deterministic code and returns the settled snapshot; we
 * reconcile once our local animation finishes.
 * ============================================================ */
'use strict';

class Game extends EventBus {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {UIManager} ui
   * @param {NetworkManager} net
   */
  constructor(canvas, ui, net) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.ui = ui;
    this.net = net;

    this.settings = Settings.load();
    this.board = new Board(this.settings.quality);
    this.particles = new ParticleSystem();
    this.aim = new Aim();

    this.world = null;
    this.state = null;

    this.mode = 'local';
    this.playerCount = 2;
    this.localSeat = 0;         // seat this device controls (null = all / spectator)
    this.spectator = false;
    this.viewRot = 0;           // canvas rotation so my rail is at the bottom

    this.running = false;
    this.paused = false;
    this.simulating = false;

    this.players = [];

    /* input */
    this.drag = null;           // 'aim' | null
    this.pointer = { x: 0, y: 0 };
    this.keyCharge = 0;
    this.keyChargeDir = 0;
    this._sliderOn = null;

    /* shot bookkeeping */
    this.shotPockets = [];
    this.shotTouched = false;
    this.pendingSync = null;
    this.awaitingSync = false;
    this.simClock = 0;
    this._endShown = false;

    /* timer */
    this.turnTime = this.settings.turnTime;
    this.timeLeft = this.turnTime;
    this._lastTickSecond = -1;

    /* loop */
    this._last = 0;
    this._fpsAcc = 0; this._fpsFrames = 0; this._fps = 60;
    this._raf = null;
    this._t = 0;

    this.debug = this.settings.debug;

    this._bindCanvas();
    this._bindUI();
    this._bindNet();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this._resize(), 120));
  }

  /* ==========================================================
   * lifecycle
   * ========================================================== */

  /**
   * @param {'practice'|'local'|'online'} mode
   * @param {object} opts {seat, playerCount, names, state, world}
   */
  start(mode, opts = {}) {
    this.mode = mode;
    this.settings = Settings.load();
    this.turnTime = this.settings.turnTime;
    this.board.setQuality(this.settings.quality);
    this.debug = this.settings.debug;

    this.playerCount = opts.playerCount === 4 ? 4 : 2;
    if (mode === 'practice') this.playerCount = 2;

    this.world = World.fromLayout();
    this.state = RulesEngine.newState(mode, this.playerCount);

    const profile = Profile.load();

    if (mode === 'online') {
      this.localSeat = (typeof opts.seat === 'number') ? opts.seat : null;
      this.spectator = this.localSeat == null;
      this.players = this._seatArray(seat =>
        Player.from(opts.names[seat] || { index: seat, name: this._defaultName(seat) }, this.playerCount));
      if (opts.state) Object.assign(this.state, opts.state);
      if (opts.world) this.world.restore(opts.world);
    } else if (mode === 'local') {
      this.localSeat = null;    // every seat is local
      this.spectator = false;
      this.players = this._seatArray(seat => new Player(seat, {
        name: seat === 0 ? profile.name : this._defaultName(seat),
        playerCount: this.playerCount,
        strikerColor: seat === 0 ? profile.strikerColor : CONFIG.STRIKER_COLORS[(seat + 2) % CONFIG.STRIKER_COLORS.length].face
      }));
    } else {
      this.localSeat = 0;
      this.spectator = false;
      this.players = this._seatArray(seat => new Player(seat, {
        name: seat === 0 ? profile.name : 'Board',
        playerCount: 2,
        strikerColor: profile.strikerColor
      }));
    }

    // Rotate the view so my own rail sits at the bottom of my screen.
    this.viewRot = (this.localSeat == null) ? 0 : Utils.railFor(this.localSeat).rot;

    this.world.resetStriker(this.state.turn);
    this._applyStrikerSkin();
    this.particles.clear();
    this.paused = false;
    this.simulating = false;
    this.pendingSync = null;
    this.awaitingSync = false;
    this.shotPockets = [];
    this._endShown = false;
    this._sliderOn = null;
    this.aim.cancel();
    this.drag = null;
    this._resetTimer();

    this.ui.setPlayers(this.players, this.playerCount, this.localSeat);
    this.ui.enableChat(mode === 'online');
    this.ui.setNetBadge(mode === 'online' ? { text: '● live' } : null);
    this.ui.setHint(this._hintText());
    this.ui.closeAllOverlays();
    this.ui.show('game');
    this._refreshHud();
    this._resize();

    this.running = true;
    this._last = performance.now();
    if (!this._raf) this._raf = requestAnimationFrame((t) => this._loop(t));
  }

  /** Sparse array indexed by seat; unused seats stay undefined. */
  _seatArray(make) {
    const out = [];
    for (const seat of Utils.seatsFor(this.playerCount)) out[seat] = make(seat);
    return out;
  }

  _defaultName(seat) {
    if (this.mode === 'online') return Utils.colorOfSeat(seat, this.playerCount) === 'white' ? 'White' : 'Black';
    return 'Player ' + (Utils.seatsFor(this.playerCount).indexOf(seat) + 1);
  }

  stop() {
    this.running = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  restart() {
    if (this.mode === 'online') { this.net.rematch(); return; }
    this.start(this.mode, { seat: this.localSeat, playerCount: this.playerCount });
  }

  pause() { if (this.mode !== 'online') { this.paused = true; this.ui.openOverlay('pause'); } }
  resume() { this.paused = false; this.ui.closeOverlay('pause'); }

  /** The shooting seat, honouring practice mode's single seat. */
  get shooter() { return this.mode === 'practice' ? 0 : this.state.turn; }

  /** Paint the striker in the current shooter's chosen colour. */
  _applyStrikerSkin() {
    const p = this.players[this.shooter];
    this.world.striker.setSkin(p ? p.skin : null);
  }

  /* ==========================================================
   * canvas / view
   * ========================================================== */

  _resize() {
    const cssW = this.canvas.clientWidth || 600;
    const cap = this.settings.quality === 'low' ? 1 : (this.settings.quality === 'medium' ? 1.5 : 2);
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    const px = Math.round(cssW * dpr);
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    this._scale = px / CONFIG.BOARD_SIZE;
  }

  /** Screen pixels -> logical board units, undoing the seat rotation. */
  _toBoard(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const C = CONFIG.CENTER;
    let x = (clientX - r.left) / r.width * CONFIG.BOARD_SIZE - C;
    let y = (clientY - r.top) / r.height * CONFIG.BOARD_SIZE - C;

    // inverse of ctx.rotate(viewRot)
    const c = Math.cos(-this.viewRot), s = Math.sin(-this.viewRot);
    return { x: x * c - y * s + C, y: x * s + y * c + C };
  }

  /* ==========================================================
   * input
   * ========================================================== */

  get canShoot() {
    if (!this.running || this.paused || this.simulating || this.state.over) return false;
    if (this.spectator) return false;
    if (this.mode === 'online') return this.state.turn === this.localSeat && !this.awaitingSync;
    return true;
  }

  _bindCanvas() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onDown(e));
    window.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerup', (e) => this._onUp(e));
    window.addEventListener('pointercancel', () => this._cancelDrag());
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /**
   * Press ANYWHERE — on the striker, beside it, above it — and drag. The
   * striker fires along (striker - pointer), so you can pull from any angle
   * through a full 360 degrees. Positioning is the slider's job, so a drag
   * is never ambiguous.
   */
  _onDown(e) {
    audio.unlock();
    if (!this.canShoot) return;
    e.preventDefault();
    this.canvas.setPointerCapture && this.canvas.setPointerCapture(e.pointerId);

    const p = this._toBoard(e.clientX, e.clientY);
    this.pointer = p;
    const s = this.world.striker;
    this.drag = 'aim';
    this.aim.begin(s.x, s.y, p.x, p.y);
  }

  _onMove(e) {
    if (this.drag !== 'aim') return;
    const p = this._toBoard(e.clientX, e.clientY);
    this.pointer = p;
    this.aim.move(p.x, p.y);
    this.ui.setPower(this.aim.power, true);
    if (this.settings.sound) audio.charge(this.aim.power);
  }

  _onUp() {
    if (this.drag !== 'aim') return;
    if (this.aim.valid) this._fire(this.aim.angle, this.aim.power);
    this._cancelDrag();
  }

  _cancelDrag() {
    this.drag = null;
    this.aim.cancel();
    this.ui.setPower(0, false);
  }

  /* ---------- striker positioning ---------- */

  /** @returns {boolean} false when a coin occupies that spot */
  _placeStriker(u) {
    const seat = this.shooter;
    const nu = Utils.clampStrikerU(u);
    if (this.world.strikerBlockedAt(nu, seat)) return false;
    const p = Utils.strikerPos(seat, nu);
    this.world.striker.place(p.x, p.y);
    return true;
  }

  /** Current rail coordinate of the striker. */
  get strikerU() { return Utils.strikerU(this.shooter, this.world.striker); }

  /* ==========================================================
   * shooting
   * ========================================================== */

  _fire(angle, power) {
    if (this.mode === 'online') {
      this.net.shoot(this.strikerU, angle, power);
      this.awaitingSync = true;
    }
    this._applyShot(angle, power);
  }

  _applyShot(angle, power) {
    this.world.shoot(angle, power);
    this.simulating = true;
    this.simClock = 0;
    this.shotPockets = [];
    this.shotTouched = false;
    this.aim.cancel();
    this.ui.setPower(0, false);
    if (this.settings.sound) audio.click();   // the flick of a fingernail
  }

  /* ==========================================================
   * ui wiring
   * ========================================================== */

  _bindUI() {
    this.ui.on('key', (e) => {
      if (!this.canShoot) return;
      // Arrow keys nudge along the rail, in the direction the player SEES.
      const t = Utils.railTFromU(this.shooter, this.strikerU);
      const step = 6 / (CONFIG.LAYOUT.STRIKER_MAX - CONFIG.LAYOUT.STRIKER_MIN);
      if (e.key === 'ArrowLeft') this._placeStriker(Utils.uFromRailT(this.shooter, t - step));
      if (e.key === 'ArrowRight') this._placeStriker(Utils.uFromRailT(this.shooter, t + step));
      if (e.code === 'Space' && !e.repeat) { this.keyCharge = 0; this.keyChargeDir = 1; e.preventDefault(); }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && this.keyChargeDir) {
        this.keyChargeDir = 0;
        if (this.canShoot && this.keyCharge > 0.05) {
          const inward = Utils.railFor(this.shooter).inward;
          this._fire(Math.atan2(inward.y, inward.x), this.keyCharge);   // straight up the board
        }
        this.keyCharge = 0;
        this.ui.setPower(0, false);
      }
    });

    this.ui.on('striker-slide', (t) => {
      if (!this.canShoot || this.drag === 'aim') return;
      if (!this._placeStriker(Utils.uFromRailT(this.shooter, t))) this.ui.flashStrikerBlocked();
    });

    this.ui.on('pause-toggle', () => this.paused ? this.resume() : this.pause());
    this.ui.on('pause', () => this.pause());
    this.ui.on('resume', () => this.resume());
    this.ui.on('restart', () => this.restart());
    this.ui.on('replay', () => this.restart());
    this.ui.on('escape', () => this._cancelDrag());
    this.ui.on('toggle-debug', () => { this.debug = !this.debug; this.ui.toast('Debug ' + (this.debug ? 'on' : 'off')); });
    this.ui.on('reset-striker', () => {
      if (!this.canShoot) return;
      this.world.resetStriker(this.shooter);
    });
    this.ui.on('settings', (s) => {
      this.settings = s;
      this.board.setQuality(s.quality);
      this.debug = s.debug;
      this.turnTime = s.turnTime;
      if (this.world) this._applyStrikerSkin();
      this._resize();
    });
    this.ui.on('striker-color', (hex) => {
      if (!this.running) return;
      const seat = this.localSeat == null ? 0 : this.localSeat;
      if (this.players[seat]) this.players[seat].strikerColor = hex;
      this._applyStrikerSkin();
    });
  }

  /* ==========================================================
   * networking
   * ========================================================== */

  _bindNet() {
    /* an opponent (or spectated player) shot */
    this.net.on('shot', (p) => {
      if (this.mode !== 'online') return;
      if (p.seat === this.localSeat) return;            // we already played it
      this.state.turn = p.seat;
      this.world.resetStriker(p.seat, p.u);
      this._applyStrikerSkin();
      this._applyShot(p.angle, p.power);
    });

    /* authoritative settled snapshot */
    this.net.on('state-sync', (p) => {
      if (this.mode !== 'online') return;
      this.pendingSync = p;
      if (!this.simulating) this._applySync();
    });

    this.net.on('game-over', (p) => {
      if (this.mode !== 'online') return;
      this.pendingSync = this.pendingSync || p;
      if (!this.simulating) this._applySync();
    });

    this.net.on('opponent-timeout', () => this.ui.bigToast('Time up', 'bad'));

    this.net.on('player-left', (p) => {
      if (this.mode !== 'online') return;
      this.ui.toast((p && p.name ? p.name : 'A player') + ' disconnected — waiting 45s', 'bad');
      this.ui.setNetBadge({ text: '● player offline', bad: true });
    });

    this.net.on('player-joined', (p) => {
      if (this.mode !== 'online') return;
      this.ui.toast((p && p.name ? p.name : 'A player') + ' reconnected', 'ok');
      this.ui.setNetBadge({ text: '● live' });
    });

    this.net.on('latency', (ms) => {
      if (this.mode === 'online') this.ui.setNetBadge({ text: '● ' + ms + ' ms', bad: ms > 220 });
    });
  }

  /** Overwrite local state with the server's. Invisible when they agree. */
  _applySync() {
    const p = this.pendingSync;
    this.pendingSync = null;
    this.awaitingSync = false;
    if (!p) return;

    if (p.world) this.world.restore(p.world);
    if (p.state) Object.assign(this.state, p.state);
    if (p.report) this._announce(p.report);

    this.world.drainEvents();
    this._applyStrikerSkin();
    this._resetTimer();
    this._refreshHud();
    if (this.state.over) this._gameOver();
  }

  /* ==========================================================
   * main loop
   * ========================================================== */

  _loop(ts) {
    this._raf = requestAnimationFrame((t) => this._loop(t));
    if (!this.running) return;

    let dt = (ts - this._last) / 1000;
    this._last = ts;
    if (dt > 1 / 20) dt = 1 / 20;      // never let a stall become a teleport
    this._t += dt;

    this._fpsAcc += dt; this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      this._fps = Math.round(this._fpsFrames / this._fpsAcc);
      this._fpsAcc = 0; this._fpsFrames = 0;
      this.ui.setFps(this._fps);
    }

    if (!this.paused) this._update(dt);
    this._render();
  }

  _update(dt) {
    if (this.keyChargeDir && this.canShoot) {
      this.keyCharge = Utils.clamp(this.keyCharge + dt * 1.15, 0, 1);
      this.ui.setPower(this.keyCharge, true);
      if (this.settings.sound) audio.charge(this.keyCharge);
    }

    if (this.simulating) {
      this.simClock += dt;
      this.world.step(dt);
      this._consumeEvents();

      if (this.world.isSettled() || this.simClock > CONFIG.MAX_SETTLE_TIME) {
        this.simulating = false;
        this._onSettled();
      }
    } else if (!this.state.over) {
      this._tickTimer(dt);
    }

    for (const c of this.world.coins) c.updateVisual(dt);
    this.world.striker.updateVisual(dt);
    this.particles.update(dt);
    this._syncStrikerSlider();
  }

  /** Keep the knob glued to the striker (slider, keys, turn change, reset). */
  _syncStrikerSlider() {
    const usable = this.canShoot && this.drag !== 'aim';
    if (usable !== this._sliderOn) {
      this._sliderOn = usable;
      this.ui.enableStrikerSlider(usable);
    }
    if (usable) this.ui.setStrikerSlider(Utils.railTFromU(this.shooter, this.strikerU));
  }

  /** Turn physics events into sound, sparks and rule bookkeeping. */
  _consumeEvents() {
    const events = this.world.drainEvents();
    const q = this.settings.quality;

    for (const e of events) {
      if (e.kind === 'hit') {
        const striker = e.aType === 'striker' || e.bType === 'striker';
        if (striker) this.shotTouched = true;
        if (this.settings.sound) audio.coinHit(e.speed, striker);
        if (q !== 'low') this.particles.burst(e.x, e.y, Math.min(8, 2 + (e.speed / 220) | 0), '#ffe6a8', 120);
        const a = this._bodyById(e.a), b = this._bodyById(e.b);
        if (a) a.glow = 1; if (b) b.glow = 1;
      } else if (e.kind === 'wall') {
        if (this.settings.sound) audio.wallHit(e.speed);
        if (q === 'high') this.particles.burst(e.x, e.y, 3, '#d8b071', 90, 0.25);
      } else if (e.kind === 'pocket') {
        this.shotPockets.push(e);
        const col = e.type === 'queen' ? '#ff5f6d' : (e.type === 'black' ? '#8b8b8b' : '#f2e7cd');
        this.particles.pocketSwirl(e.x, e.y, col);
        if (this.settings.sound) {
          e.type === 'striker' ? audio.foul() : audio.pocket(e.type === 'queen');
        }
        if (e.type !== 'striker') this.ui.bigToast(Utils.typeLabel(e.type) + ' pocketed', e.type === 'queen' ? 'queen' : 'good');
        else this.ui.bigToast('Striker pocketed', 'bad');
      }
    }
  }

  _bodyById(id) { return this.world.bodies.find(b => b.id === id); }

  /** Everything has stopped: apply the rules (or wait for the server). */
  _onSettled() {
    if (this.mode === 'online') {
      if (this.pendingSync) this._applySync();
      return;
    }

    const shooterSeat = this.state.turn;
    const report = RulesEngine.resolveShot(this.world, this.state, this.shotPockets, this.shotTouched);
    this._announce(report);
    this._applyStrikerSkin();
    this._resetTimer();
    this._refreshHud();

    if (this.mode !== 'practice' && shooterSeat === 0) {
      const myColor = Utils.colorOfSeat(0, this.playerCount);
      const banked = this.shotPockets.filter(e => e.type === myColor).length;
      if (banked) Profile.addCoins(banked, this.shotPockets.some(e => e.type === 'queen'));
    }

    if (this.state.over) this._gameOver();
  }

  _announce(report) {
    if (!report) return;
    if (report.foul && this.settings.sound) audio.foul();
    if (report.messages) {
      report.messages.slice(0, 2).forEach((m, i) =>
        setTimeout(() => this.ui.bigToast(m, report.foul ? 'bad' : 'good'), 260 + i * 720));
    }
    if (!report.extraTurn && !report.over && this.mode !== 'practice') {
      if (this.settings.sound) audio.turn();
    }
    if (report.extraTurn && this.mode !== 'practice') {
      setTimeout(() => this.ui.bigToast('Shoot again!', 'good'), 200);
    }
  }

  /* ==========================================================
   * timer
   * ========================================================== */

  _resetTimer() {
    this.timeLeft = this.turnTime;
    this._lastTickSecond = -1;
  }

  _tickTimer(dt) {
    if (this.mode === 'practice') { this.ui.setTimer(this.turnTime, this.turnTime); return; }
    if (this.mode === 'online' && (this.spectator || this.awaitingSync)) { this.ui.setTimer(this.timeLeft, this.turnTime); return; }

    this.timeLeft -= dt;
    const s = Math.ceil(this.timeLeft);
    if (s !== this._lastTickSecond) {
      this._lastTickSecond = s;
      if (s <= 5 && s > 0 && this.settings.sound) audio.tick();
    }
    this.ui.setTimer(this.timeLeft, this.turnTime);

    if (this.timeLeft <= 0) {
      this.timeLeft = this.turnTime;
      if (this.mode === 'online') {
        if (this.state.turn === this.localSeat) this.net.timeout();
      } else {
        const r = RulesEngine.abandonTurn(this.world, this.state);
        this.ui.bigToast('Time up!', 'bad');
        if (this.settings.sound) audio.foul();
        this._announce(r);
        this._applyStrikerSkin();
        this._refreshHud();
        if (this.state.over) this._gameOver();
      }
    }
  }

  /* ==========================================================
   * hud / end
   * ========================================================== */

  _hintText() {
    if (this.mode === 'online' && this.spectator) return 'Spectating';
    const base = 'Slider positions the striker · pull back from any angle to shoot';
    return this.mode === 'practice' ? 'Practice — ' + base : base;
  }

  _refreshHud() {
    this.ui.setHud(RulesEngine.hud(this.world, this.state), {
      localSeat: this.localSeat,
      players: this.players,
      playerCount: this.playerCount,
      mode: this.mode
    });
  }

  /** Names of everyone on a team, e.g. "Ajit & Ravi". */
  _teamNames(team) {
    return Utils.seatsFor(this.playerCount)
      .filter(s => Utils.teamOf(s, this.playerCount) === team)
      .map(s => this.players[s] ? this.players[s].name : '—')
      .join(' & ');
  }

  _gameOver() {
    // The server emits both `state-sync` (over:true) and `game-over`;
    // without this guard the result dialog — and the stats — would double up.
    if (this._endShown) return;
    this._endShown = true;

    this.simulating = false;
    const st = this.state;
    const names = [this._teamNames(0), this._teamNames(1)];
    const draw = st.winner === 'draw';
    const myTeam = this.localSeat == null ? null : Utils.teamOf(this.localSeat, this.playerCount);

    let title, sub, emblem, result;
    if (draw) {
      title = 'Draw'; sub = st.reason || 'Nobody could finish.'; emblem = '🤝'; result = 'draw';
    } else if (myTeam == null || this.spectator) {
      title = names[st.winner] + ' win!';
      sub = st.reason || '';
      emblem = '🏆';
      result = st.winner === 0 ? 'win' : 'loss';
    } else {
      const won = st.winner === myTeam;
      title = won ? 'You Win!' : 'You Lose';
      sub = st.reason || '';
      emblem = won ? '🏆' : '💔';
      result = won ? 'win' : 'loss';
    }

    if (!this.spectator && this.mode !== 'practice') {
      Profile.record(draw ? 'draw' : result);
      this.ui.renderProfile();
      this.ui.renderLeaderboard();
      if (this.settings.sound) draw ? audio.turn() : (result === 'win' ? audio.win() : audio.lose());
    }

    this.ui.showGameOver({
      title, sub, emblem, names,
      scores: st.score,
      showRematch: this.mode === 'online' && !this.spectator
    });
  }

  /* ==========================================================
   * render
   * ========================================================== */

  _render() {
    const ctx = this.ctx;
    const C = CONFIG.CENTER;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.scale(this._scale, this._scale);

    if (this.viewRot) { ctx.translate(C, C); ctx.rotate(this.viewRot); ctx.translate(-C, -C); }

    this.board.draw(ctx);

    // rail the current shooter may use
    if (!this.state.over && !this.simulating) {
      const seat = this.shooter;
      const mine = this.mode !== 'online' || seat === this.localSeat;
      this.board.drawActiveRail(ctx, seat, mine ? '#f0b429' : 'rgba(255,255,255,.35)', this._t);
    }

    const opts = { quality: this.settings.quality };
    for (const c of this.world.coins) c.draw(ctx, opts);

    const s = this.world.striker;
    if (this.canShoot && !this.drag) s.drawIdleHalo(ctx, this._t, '#f0b429');
    s.draw(ctx, opts);

    if (this.drag === 'aim' && this.aim.active) this._drawAim(ctx);

    this.particles.draw(ctx);

    if (this.debug) {
      this.board.drawDebug(ctx, this.world);
      this._drawDebugText(ctx);
    }
  }

  /** Undo the board rotation so text/labels never read upside-down. */
  _upright(ctx, x, y) {
    ctx.translate(x, y);
    if (this.viewRot) ctx.rotate(-this.viewRot);
  }

  /**
   * Aiming visuals, slingshot style. Pull from ANY angle — the striker fires
   * along (striker - pointer), a full 360 degrees of aim.
   */
  _drawAim(ctx) {
    const s = this.world.striker;
    const d = this.aim.dir;
    const power = this.aim.power;
    const col = this._powerColor(power);

    /* ---------- 1. the pull-back: rubber band + ghost striker ---------- */
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.lineWidth = 2 + power * 3;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(this.aim.pointerX, this.aim.pointerY);
    ctx.stroke();

    ctx.globalAlpha = 0.30 + power * 0.28;
    ctx.fillStyle = s.face;
    ctx.beginPath();
    ctx.arc(this.aim.pointerX, this.aim.pointerY, s.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.aim.pointerX, this.aim.pointerY, s.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    if (!this.settings.aimGuide) { this._drawPowerLabel(ctx, s, d, power, col); return; }

    /* ---------- 2. where does this shot actually land? ---------- */
    const pr = this.world.predict(s.x, s.y, d.x, d.y, s.r, 2);

    const reach = 70 + power * 300;
    const toHit = pr.hitPoint ? Utils.dist(s.x, s.y, pr.hitPoint.x, pr.hitPoint.y) : Infinity;
    const len = Math.min(reach, toHit);
    const tipX = s.x + d.x * len;
    const tipY = s.y + d.y * len;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.30)';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([9, 9]);
    ctx.beginPath();
    ctx.moveTo(pr.points[0].x, pr.points[0].y);
    for (let i = 1; i < pr.points.length; i++) ctx.lineTo(pr.points[i].x, pr.points[i].y);
    ctx.stroke();
    ctx.setLineDash([]);

    this._arrow(ctx, s.x + d.x * (s.r + 2), s.y + d.y * (s.r + 2), tipX, tipY, 3 + power * 7, col);

    /* ---------- 3. the coin we are aiming at ---------- */
    if (pr.hit && pr.ghost) {
      const hot = pr.hit.type === 'queen' ? '#ff5f6d' : '#7ee0b8';

      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(pr.ghost.x, pr.ghost.y, s.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      const pulse = 0.5 + 0.5 * Math.sin(this._t * 7);
      ctx.strokeStyle = hot;
      ctx.globalAlpha = 0.45 + pulse * 0.45;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pr.hit.x, pr.hit.y, pr.hit.r + 3 + pulse * 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      this._arrow(ctx,
        pr.hit.x + pr.hitNormal.x * (pr.hit.r + 1),
        pr.hit.y + pr.hitNormal.y * (pr.hit.r + 1),
        pr.hit.x + pr.hitNormal.x * (pr.hit.r + 52),
        pr.hit.y + pr.hitNormal.y * (pr.hit.r + 52),
        3.4, hot);
    }
    ctx.restore();

    this._drawPowerLabel(ctx, s, d, power, col);
  }

  _powerColor(p) {
    return p < 0.4 ? '#35d39a' : (p < 0.75 ? '#f0b429' : '#ff5d6c');
  }

  /** A tapered arrow shaft with a solid head, from (x1,y1) to (x2,y2). */
  _arrow(ctx, x1, y1, x2, y2, width, color) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 6) return;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux;

    const head = Math.min(20 + width * 1.6, len * 0.55);
    const hw = width * 1.9 + 5;
    const bx = x2 - ux * head, by = y2 - uy * head;

    ctx.save();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = this.settings.quality === 'high' ? 10 : 0;

    ctx.beginPath();
    ctx.moveTo(x1 + px * width * 0.35, y1 + py * width * 0.35);
    ctx.lineTo(bx + px * width * 0.5, by + py * width * 0.5);
    ctx.lineTo(bx - px * width * 0.5, by - py * width * 0.5);
    ctx.lineTo(x1 - px * width * 0.35, y1 - py * width * 0.35);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(bx + px * hw, by + py * hw);
    ctx.lineTo(bx - px * hw, by - py * hw);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Power ring + "72%", kept upright whatever the seat rotation is. */
  _drawPowerLabel(ctx, s, d, power, col) {
    const base = Math.atan2(-d.y, -d.x);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r + 10, base - 1.05, base + 1.05);
    ctx.stroke();

    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r + 10, base - 1.05 * power, base + 1.05 * power);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    this._upright(ctx, s.x - d.x * (s.r + 34), s.y - d.y * (s.r + 34));
    ctx.font = '700 20px Outfit, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.strokeText(Math.round(power * 100) + '%', 0, 0);
    ctx.fillStyle = col;
    ctx.fillText(Math.round(power * 100) + '%', 0, 0);
    ctx.restore();
  }

  _drawDebugText(ctx) {
    const lines = [
      'mode ' + this.mode + ' ' + this.playerCount + 'p' + (this.spectator ? ' (spectator)' : ''),
      'seat ' + this.state.turn + ' team ' + Utils.teamOf(this.state.turn, this.playerCount) +
        ' (' + Utils.colorOfSeat(this.state.turn, this.playerCount) + ')',
      'localSeat ' + this.localSeat + '  rot ' + (this.viewRot * 180 / Math.PI).toFixed(0) + '°',
      'sim ' + this.simulating + '  awaitSync ' + this.awaitingSync,
      'coins W' + this.world.coinsLeft('white') + ' B' + this.world.coinsLeft('black') + ' Q' + (this.world.queenOnBoard() ? 1 : 0),
      'queen owner ' + this.state.queenOwner + ' pending ' + this.state.queenPending,
      'debt ' + this.state.debt.join('/') + '  turns ' + this.state.turnCount,
      'fps ' + this._fps + '  particles ' + this.particles.items.length
    ];
    ctx.save();
    this._upright(ctx, CONFIG.CENTER, CONFIG.CENTER);
    ctx.translate(-CONFIG.CENTER + 84, -CONFIG.CENTER + 84);
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, 0, 290, lines.length * 16 + 10);
    ctx.fillStyle = '#7ee0b8';
    lines.forEach((l, i) => ctx.fillText(l, 8, 18 + i * 16));
    ctx.restore();
  }
}

globalThis.Game = Game;
