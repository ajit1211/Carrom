/* ============================================================
 * ui.js — every DOM concern lives here.
 *
 * The canvas layer never touches the DOM and the DOM layer never
 * touches the physics; they talk through this class's event bus.
 * ============================================================ */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $id = (id) => document.getElementById(id);

class UIManager extends EventBus {
  constructor() {
    super();
    this.current = 'loading';
    this.settings = Settings.load();
    this.profile = Profile.load();
    this._toastTimer = null;

    this.createCount = 2;       // format chosen on the Create Room card
    this._players = [];         // seat -> Player, for HUD labels
    this._playerCount = 2;

    this._cacheNodes();
    this._bindNav();
    this._bindSettings();
    this._bindStrikerColor();
    this._bindBoardTheme();
    this._bindGameHud();
    this._bindLobby();
    this._bindFormat();
    this._bindChat();
    this._bindOverlays();
    this._bindKeys();

    this.applyTheme(this.settings.theme);
    this.renderProfile();
    this.renderLeaderboard();
  }

  /* ---------------- match format ---------------- */

  _bindFormat() {
    // Segmented control on the Create Room card.
    this.el.formatSeg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        this.el.formatSeg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        this.createCount = Number(b.dataset.count);
        if (this.settings.sound) audio.click();
      });
    });

    // "Play Offline" asks how many people are round the table.
    this.overlays.format.querySelectorAll('[data-local]').forEach(b => {
      b.addEventListener('click', () => {
        this.closeOverlay('format');
        this.emit('local-format', Number(b.dataset.local));
      });
    });
    $id('btnFormatCancel').addEventListener('click', () => this.closeOverlay('format'));
  }

  askLocalFormat() { this.openOverlay('format'); }

  /* ---------------- striker colour ---------------- */

  _bindStrikerColor() {
    const grid = this.el.strikerSwatches;
    grid.innerHTML = CONFIG.STRIKER_COLORS.map(c =>
      `<button type="button" class="swatch" data-color="${c.face}" title="${c.name}"
               style="--face:${c.face};--rim:${c.rim}"><span></span></button>`
    ).join('');

    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.swatch');
      if (!b) return;
      this._pickStrikerColor(b.dataset.color);
      if (this.settings.sound) audio.click();
    });

    this.el.setStrikerCustom.addEventListener('input', (e) => this._pickStrikerColor(e.target.value));

    this._pickStrikerColor(this.profile.strikerColor, true);
  }

  /* ---------------- board theme ---------------- */

  _bindBoardTheme() {
    const grid = this.el.boardSwatches;
    grid.innerHTML = CONFIG.BOARD_THEMES.map(t =>
      `<button type="button" class="board-swatch" data-board="${t.id}" title="${t.name}"
               style="--bframe:${t.frame[1]};--bbed:${t.bed[1]};--bring:${t.pocketRing[1]}">
         <span class="bs-board"><i></i><i></i><i></i><i></i></span>
         <small>${t.name}</small>
       </button>`
    ).join('');

    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.board-swatch');
      if (!b) return;
      this._pickBoardTheme(b.dataset.board);
      if (this.settings.sound) audio.click();
    });

    this._pickBoardTheme(this.settings.boardTheme, true);
  }

  _pickBoardTheme(id, silent) {
    if (!CONFIG.BOARD_THEMES.some(t => t.id === id)) id = CONFIG.DEFAULT_BOARD_THEME;
    this.settings = Settings.patch({ boardTheme: id });
    this.el.boardSwatches.querySelectorAll('.board-swatch').forEach(s =>
      s.classList.toggle('on', s.dataset.board === id));
    if (!silent) this.emit('board-theme', id);
  }

  _pickStrikerColor(hex, silent) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return;
    this.profile.strikerColor = hex;
    Profile.save(this.profile);

    const skin = Player.skinFor(hex);
    this.el.strikerPreview.style.setProperty('--face', skin.face);
    this.el.strikerPreview.style.setProperty('--rim', skin.rim);
    this.el.setStrikerCustom.value = hex;

    this.el.strikerSwatches.querySelectorAll('.swatch').forEach(s =>
      s.classList.toggle('on', s.dataset.color.toLowerCase() === hex.toLowerCase()));

    if (!silent) this.emit('striker-color', hex);
  }

  /* ---------------- nodes ---------------- */

  _cacheNodes() {
    this.screens = {
      loading: $id('screen-loading'),
      home: $id('screen-home'),
      settings: $id('screen-settings'),
      instructions: $id('screen-instructions'),
      leaderboard: $id('screen-leaderboard'),
      online: $id('screen-online'),
      waiting: $id('screen-waiting'),
      game: $id('screen-game')
    };
    this.overlays = {
      pause: $id('overlay-pause'),
      gameover: $id('overlay-gameover'),
      connect: $id('overlay-connect'),
      format: $id('overlay-format')
    };
    this.el = {
      loadBar: $id('loadBar'), loadMsg: $id('loadMsg'),
      profileName: $id('profileName'), profileAvatar: $id('profileAvatar'),
      profileWins: $id('profileWins'), profileLosses: $id('profileLosses'),
      btnSound: $id('btnSound'), btnMusic: $id('btnMusic'),

      pcard: [$id('pcard0'), $id('pcard1')],
      pavatar: [$id('pavatar0'), $id('pavatar1')],
      pscore: [$id('pscore0'), $id('pscore1')],
      pqueen: [$id('pqueen0'), $id('pqueen1')],
      pbar: [$id('pbar0'), $id('pbar1')],
      ppip: [$id('ppip0'), $id('ppip1')],
      ppop: [$id('ppop0'), $id('ppop1')],

      timerRing: $id('timerRing'), timerText: $id('timerText'),
      turnIndicator: $id('turnIndicator'),
      powerMeter: $id('powerMeter'), powerFill: $id('powerFill'),
      fps: $id('fps'), toasts: $id('toasts'), netBadge: $id('netBadge'),
      gameHint: $id('gameHint'),
      strikerRail: $id('strikerRail'), strikerSlider: $id('strikerSlider'),

      roomCode: $id('roomCode'), connDot: $id('connDot'), onlineHint: $id('onlineHint'),
      seatGrid: $id('seatGrid'), formatBadge: $id('formatBadge'),
      ownerColors: $id('ownerColors'), teamColorSeg: $id('teamColorSeg'),
      spectatorCount: $id('spectatorCount'),
      btnReady: $id('btnReady'), joinCode: $id('joinCode'), formatSeg: $id('formatSeg'),

      strikerSwatches: $id('strikerSwatches'), setStrikerCustom: $id('setStrikerCustom'),
      strikerPreview: $id('strikerPreview'),
      boardSwatches: $id('boardSwatches'),

      chatPanel: $id('chatPanel'), chatLog: $id('chatLog'), chatDot: $id('chatDot'),
      btnChat: $id('btnChat'), chatBubbles: $id('chatBubbles'),

      resultTitle: $id('resultTitle'), resultSub: $id('resultSub'), resultEmblem: $id('resultEmblem'),
      rsName: [$id('rsName0'), $id('rsName1')], rsScore: [$id('rsScore0'), $id('rsScore1')],
      rematchStatus: $id('rematchStatus'),
      connTitle: $id('connTitle'), connSub: $id('connSub'),

      globalToasts: $id('globalToasts'),
      leaderList: $id('leaderList')
    };
    this.RING_LEN = 2 * Math.PI * 19;
  }

  /* ---------------- screens ---------------- */

  show(name) {
    if (!this.screens[name]) return;
    for (const k in this.screens) {
      this.screens[k].classList.remove('active', 'shown');
    }
    const s = this.screens[name];
    s.classList.add('active');
    requestAnimationFrame(() => s.classList.add('shown'));
    this.current = name;
    this.emit('screen', name);
  }

  openOverlay(name) { this.overlays[name] && this.overlays[name].classList.add('open'); }
  closeOverlay(name) { this.overlays[name] && this.overlays[name].classList.remove('open'); }
  closeAllOverlays() { for (const k in this.overlays) this.closeOverlay(k); }

  /* ---------------- loading ---------------- */

  async runLoader() {
    const steps = [
      [18, 'Cutting the plywood…'],
      [38, 'French-polishing the bed…'],
      [58, 'Turning 19 coins…'],
      [78, 'Waxing the striker…'],
      [92, 'Tuning the physics…'],
      [100, 'Ready!']
    ];
    for (const [pct, msg] of steps) {
      this.el.loadBar.style.width = pct + '%';
      this.el.loadMsg.textContent = msg;
      await new Promise(r => setTimeout(r, 190));
    }
    await new Promise(r => setTimeout(r, 160));
    this.show('home');
  }

  /* ---------------- navigation ---------------- */

  _bindNav() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-nav]');
      if (!btn) return;
      const to = btn.dataset.nav;
      audio.unlock();
      if (this.settings.sound) audio.click();

      if (to === 'exit') return this._exit();
      if (to === 'practice' || to === 'local' || to === 'online') return this.emit('nav', to);
      this.show(to);
    });

    $id('profileChip').addEventListener('click', () => this.show('settings'));

    this.el.btnSound.addEventListener('click', () => {
      this.settings.sound = !this.settings.sound;
      Settings.patch({ sound: this.settings.sound });
      audio.unlock(); audio.setSfx(this.settings.sound);
      this._syncQuickToggles();
    });
    this.el.btnMusic.addEventListener('click', () => {
      this.settings.music = !this.settings.music;
      Settings.patch({ music: this.settings.music });
      audio.unlock(); audio.setMusic(this.settings.music);
      this._syncQuickToggles();
    });
    this._syncQuickToggles();
  }

  _syncQuickToggles() {
    this.el.btnSound.classList.toggle('off', !this.settings.sound);
    this.el.btnMusic.classList.toggle('off', !this.settings.music);
  }

  _exit() {
    this.toast('Thanks for playing!', 'ok');
    setTimeout(() => {
      window.open('', '_self');
      window.close();
      // Most browsers refuse to close a tab they did not open; fall back home.
      setTimeout(() => this.show('home'), 400);
    }, 500);
  }

  /* ---------------- settings ---------------- */

  _bindSettings() {
    const s = this.settings;
    $id('setName').value = this.profile.name;
    $id('setMusic').checked = s.music;
    $id('setSound').checked = s.sound;
    $id('setVolume').value = s.volume;
    $id('setQuality').value = s.quality;
    $id('setTheme').value = s.theme;
    $id('setTimer').value = s.turnTime;
    $id('setGuide').checked = s.aimGuide;
    $id('setFps').checked = s.showFps;
    $id('setDebug').checked = s.debug;
    $id('setServer').value = s.serverUrl || '';

    $id('setTheme').addEventListener('change', (e) => this.applyTheme(e.target.value));
    $id('setVolume').addEventListener('input', (e) => { audio.unlock(); audio.setVolume(e.target.value / 100); });

    $id('btnSaveSettings').addEventListener('click', () => {
      const next = {
        music: $id('setMusic').checked,
        sound: $id('setSound').checked,
        volume: +$id('setVolume').value,
        quality: $id('setQuality').value,
        theme: $id('setTheme').value,
        turnTime: Utils.clamp(+$id('setTimer').value || 30, 10, 120),
        aimGuide: $id('setGuide').checked,
        showFps: $id('setFps').checked,
        debug: $id('setDebug').checked,
        serverUrl: $id('setServer').value.trim().replace(/\/+$/, '')
      };
      this.settings = Settings.patch(next);

      const name = ($id('setName').value || 'Player').trim().slice(0, 14) || 'Player';
      this.profile.name = name;
      Profile.save(this.profile);

      audio.unlock();
      audio.setSfx(next.sound);
      audio.setMusic(next.music);
      audio.setVolume(next.volume / 100);

      this.renderProfile();
      this._syncQuickToggles();
      this.applySettings();
      this.toast('Settings saved', 'ok');
      this.show('home');
    });

    $id('btnResetStats').addEventListener('click', () => {
      this.profile = Profile.reset();
      this.renderProfile();
      this.toast('Stats cleared');
    });
  }

  applySettings() {
    this.el.fps.hidden = !this.settings.showFps;
    this.emit('settings', this.settings);
  }

  applyTheme(theme) {
    document.body.dataset.theme = theme;
  }

  /* ---------------- profile / leaderboard ---------------- */

  renderProfile() {
    this.profile = Profile.load();
    this.el.profileName.textContent = this.profile.name;
    this.el.profileAvatar.textContent = (this.profile.name[0] || 'P').toUpperCase();
    this.el.profileWins.textContent = this.profile.wins;
    this.el.profileLosses.textContent = this.profile.losses;
  }

  renderLeaderboard() {
    const me = Profile.load();
    const rows = [
      { n: 'StrikerKing', w: 412, p: 9820 },
      { n: 'QueenCover', w: 388, p: 9140 },
      { n: 'ThumbShot', w: 351, p: 8730 },
      { n: 'BoardMaster', w: 297, p: 7610 },
      { n: 'PocketRocket', w: 254, p: 6980 },
      { n: me.name + ' (you)', w: me.wins, p: me.wins * 25 + me.coinsPocketed * 3 },
      { n: 'CarromCasual', w: 43, p: 1180 }
    ].sort((a, b) => b.p - a.p);

    this.el.leaderList.innerHTML = rows.map((r, i) =>
      `<li><b>#${i + 1}</b><span>${this._esc(r.n)}</span><small>${r.w}W · ${r.p} pts</small></li>`
    ).join('');
  }

  /* ---------------- game HUD ---------------- */

  _bindGameHud() {
    /* Striker position slider. `input` fires on drag, arrow keys and taps. */
    const sl = this.el.strikerSlider;
    sl.addEventListener('input', () => {
      this._sliderHeld = true;
      this.emit('striker-slide', sl.value / 1000);
    });
    // Once the player lets go, the game is free to re-sync the knob.
    ['pointerup', 'pointercancel', 'blur', 'change'].forEach(ev =>
      sl.addEventListener(ev, () => { this._sliderHeld = false; }));
    // Don't let the arrow keys reach the game while the knob has focus.
    sl.addEventListener('keydown', (e) => e.stopPropagation());

    /* Tap a team block to read who is actually on that team. */
    this.el.pcard.forEach((card, team) => {
      card.addEventListener('click', (e) => { e.stopPropagation(); this._toggleTeamPop(team); });
      card.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault(); e.stopPropagation();
        this._toggleTeamPop(team);
      });
    });
    // Anywhere else — board, HUD, backdrop — dismisses it.
    document.addEventListener('click', () => this._toggleTeamPop(-1));

    $id('btnPause').addEventListener('click', () => this.emit('pause'));
    $id('btnUndoStriker').addEventListener('click', () => this.emit('reset-striker'));
    $id('btnFullscreen').addEventListener('click', () => this._fullscreen());
    $id('btnResume').addEventListener('click', () => this.emit('resume'));
    $id('btnRestart').addEventListener('click', () => this.emit('restart'));
    $id('btnQuit').addEventListener('click', () => this.emit('quit'));
    $id('btnReplay').addEventListener('click', () => this.emit('replay'));
    $id('btnBackHome').addEventListener('click', () => this.emit('quit'));
  }

  _fullscreen() {
    const d = document;
    if (!d.fullscreenElement) (d.documentElement.requestFullscreen || (() => {})).call(d.documentElement);
    else d.exitFullscreen && d.exitFullscreen();
  }

  /** Everyone on a team, e.g. "Ajit & Ravi" for doubles. */
  teamNames(team) {
    return this.teamSeats(team)
      .map(s => this._players[s] ? this._players[s].name : '—')
      .join(' & ');
  }

  teamSeats(team) {
    return Utils.seatsFor(this._playerCount).filter(s => Utils.teamOf(s, this._playerCount) === team);
  }

  /**
   * The HUD blocks are deliberately tiny — an avatar and the coin tally — so
   * nothing gets clipped on a phone. The names live in a popover instead,
   * opened by tapping the block.
   *
   * @param {Player[]} players sparse, indexed by seat
   * @param {2|4} playerCount
   * @param {boolean} [colorSwap] which team plays which colour
   */
  setPlayers(players, playerCount, localSeat, colorSwap) {
    this._players = players;
    this._playerCount = playerCount;
    this._localSeat = localSeat;
    this._colorSwap = !!colorSwap;

    for (let team = 0; team < 2; team++) {
      const seats = this.teamSeats(team);
      const p = players[seats[0]];
      this.el.pavatar[team].textContent = p ? p.initial : '?';
      this._paintPip(team, Utils.colorOfTeam(team, this._colorSwap));

      const names = this.teamNames(team);
      this.el.pcard[team].title = names;
      this.el.pcard[team].setAttribute('aria-label', names);

      this.el.ppop[team].innerHTML =
        `<h5>${Utils.colorOfTeam(team, this._colorSwap) === 'white' ? 'White' : 'Black'} team</h5>` +
        seats.map(s => {
          const q = players[s];
          return `<span><b>${q ? this._esc(q.initial) : '?'}</b>${q ? this._esc(q.name) : '—'}` +
                 `${s === localSeat ? '<i>you</i>' : ''}</span>`;
        }).join('');
    }
    this._toggleTeamPop(-1);
    document.getElementById('screen-game').classList.toggle('doubles', playerCount === 4);
  }

  /** The coin colour dot on a team's HUD block. */
  _paintPip(team, color) {
    const pip = this.el.ppip[team];
    if (pip.dataset.color === color) return;
    pip.dataset.color = color;
    pip.className = 'pip ' + color;
  }

  /** Only one name popover open at a time; -1 closes both. */
  _toggleTeamPop(team) {
    const reopen = team >= 0 && this.el.ppop[team].hidden;
    for (let t = 0; t < 2; t++) {
      this.el.ppop[t].hidden = true;
      this.el.pcard[t].classList.remove('popped');
      this.el.pcard[t].setAttribute('aria-expanded', 'false');
    }
    if (!reopen) return;
    this.el.ppop[team].hidden = false;
    this.el.pcard[team].classList.add('popped');
    this.el.pcard[team].setAttribute('aria-expanded', 'true');
  }

  /** @param {object} hud from RulesEngine.hud() */
  setHud(hud, ctx) {
    const localTeam = (ctx && ctx.localSeat != null)
      ? Utils.teamOf(ctx.localSeat, hud.playerCount) : null;

    for (let team = 0; team < 2; team++) {
      // The server's sync carries the room owner's colour pick with it.
      this._paintPip(team, Utils.colorOfTeam(team, hud.colorSwap));
      const prev = this.el.pscore[team].textContent;
      const val = String(hud.pocketed[team]);
      if (prev !== val) {
        this.el.pscore[team].textContent = val;
        this.el.pscore[team].classList.remove('score-bump');
        void this.el.pscore[team].offsetWidth;
        this.el.pscore[team].classList.add('score-bump');
      }
      this.el.pbar[team].style.width = (hud.pocketed[team] / CONFIG.COINS_PER_SIDE * 100) + '%';
      this.el.pcard[team].classList.toggle('active', hud.turnTeam === team && !hud.over);
      this.el.pqueen[team].hidden = hud.queenOwner !== team;
    }

    const shooter = this._players[hud.turn];
    if (hud.over) {
      this.el.turnIndicator.textContent = 'Game over';
    } else if (localTeam == null) {
      // local hotseat / spectator: name whoever is actually shooting
      this.el.turnIndicator.textContent = (shooter ? shooter.name : 'Player') + '’s turn';
    } else if (hud.turn === ctx.localSeat) {
      this.el.turnIndicator.textContent = 'Your turn';
    } else if (hud.playerCount === 4 && hud.turnTeam === localTeam) {
      this.el.turnIndicator.textContent = 'Partner’s turn';
    } else {
      this.el.turnIndicator.textContent = (shooter ? shooter.name : 'Opponent') + '’s turn';
    }
  }

  setTimer(remaining, total) {
    const t = Utils.clamp(remaining / total, 0, 1);
    this.el.timerRing.style.strokeDashoffset = String(this.RING_LEN * (1 - t));
    this.el.timerRing.classList.toggle('low', remaining <= 5);
    this.el.timerText.textContent = String(Math.ceil(Math.max(0, remaining)));
  }

  /**
   * Reflect the striker's real position on the knob.
   * Skipped while the player is holding it, otherwise we would fight them.
   * @param {number} t 0..1 along the rail, already screen-oriented
   */
  setStrikerSlider(t) {
    if (this._sliderHeld) return;
    this.el.strikerSlider.value = String(Math.round(Utils.clamp(t, 0, 1) * 1000));
  }

  enableStrikerSlider(on) {
    this.el.strikerRail.toggleAttribute('disabled', !on);
    this.el.strikerSlider.disabled = !on;
  }

  /** Brief red shake: a coin is sitting where you tried to put the striker. */
  flashStrikerBlocked() {
    const r = this.el.strikerRail;
    if (r.classList.contains('blocked')) return;
    r.classList.add('blocked');
    setTimeout(() => r.classList.remove('blocked'), 220);
  }

  setPower(p, visible) {
    this.el.powerMeter.classList.toggle('on', !!visible);
    this.el.powerFill.style.height = (p * 100).toFixed(1) + '%';
  }

  setFps(v) {
    if (this.settings.showFps) this.el.fps.textContent = v + ' FPS';
  }

  setHint(text) { this.el.gameHint.textContent = text; }

  setNetBadge(state) {
    const b = this.el.netBadge;
    if (!state) { b.hidden = true; return; }
    b.hidden = false;
    b.textContent = state.text;
    b.classList.toggle('bad', !!state.bad);
  }

  /** Big centred announcement over the board. */
  bigToast(text, kind) {
    const n = document.createElement('div');
    n.className = 'big-toast ' + (kind || '');
    n.textContent = text;
    this.el.toasts.appendChild(n);
    setTimeout(() => n.remove(), 1300);
  }

  /** Small pill toast at the top of the page. */
  toast(text, kind) {
    const n = document.createElement('div');
    n.className = 'g-toast ' + (kind || '');
    n.textContent = text;
    this.el.globalToasts.appendChild(n);
    setTimeout(() => { n.style.opacity = '0'; n.style.transition = 'opacity .3s'; }, 1900);
    setTimeout(() => n.remove(), 2300);
  }

  /* ---------------- lobby / waiting ---------------- */

  _bindLobby() {
    $id('btnCreateRoom').addEventListener('click', () => this.emit('create-room', { playerCount: this.createCount }));
    $id('btnJoinRoom').addEventListener('click', () => {
      const code = this.el.joinCode.value.trim().toUpperCase();
      if (code.length < 4) return this.toast('Enter a valid room code', 'bad');
      this.emit('join-room', { code, spectate: $id('setSpectate').checked });
    });
    this.el.joinCode.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
    this.el.joinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') $id('btnJoinRoom').click(); });

    $id('btnLeaveRoom').addEventListener('click', () => this.emit('leave-room'));
    $id('btnReady').addEventListener('click', () => this.emit('ready'));

    /* Pick your side: seats are buttons while the room is still filling. */
    this.el.seatGrid.addEventListener('click', (e) => {
      const b = e.target.closest('[data-seat]');
      if (!b) return;
      if (this.settings.sound) audio.click();
      this.emit('choose-seat', Number(b.dataset.seat));
    });

    /* Room owner only: which coins their team plays. */
    this.el.teamColorSeg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        if (this.settings.sound) audio.click();
        this.emit('team-color', b.dataset.color);
      });
    });

    $id('btnCopyCode').addEventListener('click', () => this._copy(this.el.roomCode.textContent, 'Room code copied'));
    $id('btnCopyLink').addEventListener('click', () => {
      const url = location.origin + location.pathname + '?room=' + this.el.roomCode.textContent;
      this._copy(url, 'Invite link copied');
    });

    $id('btnConnCancel').addEventListener('click', () => { this.closeOverlay('connect'); this.emit('cancel-connect'); });
  }

  async _copy(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(msg, 'ok');
    } catch (_) {
      // Fallback for insecure contexts.
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); this.toast(msg, 'ok'); }
      catch (e) { this.toast('Copy failed — ' + text, 'bad'); }
      ta.remove();
    }
  }

  setConnected(on, reason) {
    this.el.connDot.classList.toggle('on', on);
    this.el.onlineHint.textContent = on
      ? 'Connected to the match server.'
      : (reason || SocketClient.explainNoServer());
  }

  /**
   * Render the lobby seats. Singles shows the two facing seats; doubles shows
   * all four grouped into their teams, so partners are visibly paired.
   *
   * An empty seat is a button: taking it is how a player chooses their side —
   * and in doubles, therefore, their team.
   */
  setRoom(room, mySeat) {
    const count = room.playerCount === 4 ? 4 : 2;
    this._playerCount = count;
    this._colorSwap = !!room.colorSwap;

    this.el.roomCode.textContent = room.code;
    this.el.formatBadge.textContent = count === 4 ? '2 v 2 · Doubles' : '1 v 1';

    const side = ['Bottom', 'Left', 'Top', 'Right'];
    const seats = Utils.seatsFor(count);
    const cell = (seat) => {
      const p = room.players[seat];
      const team = Utils.teamOf(seat, count);
      const color = Utils.colorOfTeam(team, room.colorSwap);
      const mine = seat === mySeat;
      const owner = p && room.ownerId && p.id === room.ownerId;
      const cls = ['seat', p && p.ready ? 'ready' : '', mine ? 'me' : '', p ? '' : 'empty']
        .filter(Boolean).join(' ');
      const name = p ? this._esc(p.name) + (mine ? ' (you)' : '') + (owner ? ' 👑' : '') : 'Waiting…';
      const status = p ? (p.ready ? 'Ready' : (p.connected ? 'Not ready' : 'Disconnected')) : 'Empty';
      const initial = p ? this._esc((p.name[0] || '?').toUpperCase()) : '+';
      const sit = (!p && !room.started)
        ? `<button type="button" class="btn sm sit" data-seat="${seat}">Sit here</button>` : '';
      return `<div class="${cls}">
        <small class="seat-side">${side[seat]}</small>
        <div class="avatar lg">${initial}</div>
        <strong>${name}</strong>
        <em class="tag ${color}">${color === 'white' ? 'White' : 'Black'}</em>
        <span class="ready-pill">${status}</span>
        ${sit}
      </div>`;
    };

    if (count === 2) {
      this.el.seatGrid.className = 'seats';
      this.el.seatGrid.innerHTML = cell(0) + '<div class="vs">VS</div>' + cell(2);
    } else {
      // team 0 = seats {0,2}, team 1 = seats {1,3}
      const team = (t) => {
        const c = Utils.colorOfTeam(t, room.colorSwap);
        return `<div class="team-col">
          <h4 class="team-head ${c}">${c === 'white' ? 'White' : 'Black'} Team</h4>
          ${seats.filter(s => Utils.teamOf(s, count) === t).map(cell).join('')}
        </div>`;
      };
      this.el.seatGrid.className = 'seats doubles';
      this.el.seatGrid.innerHTML = team(0) + '<div class="vs">VS</div>' + team(1);
    }

    /* The owner, and only the owner, chooses the coins their team plays. */
    const amOwner = !!room.ownerId && room.ownerId === Profile.load().playerId;
    this.el.ownerColors.hidden = !amOwner || room.started;
    this.el.teamColorSeg.querySelectorAll('button').forEach(b =>
      b.classList.toggle('on', b.dataset.color === (room.ownerColor || 'white')));

    this.el.spectatorCount.textContent = room.spectators ? room.spectators + ' spectator(s) watching' : '';
    const me = mySeat != null ? room.players[mySeat] : null;
    this.el.btnReady.textContent = me && me.ready ? 'Cancel Ready' : "I'm Ready";
    this.el.btnReady.disabled = mySeat == null;
  }

  /* ---------------- chat ---------------- */

  _bindChat() {
    this.el.btnChat.addEventListener('click', () =>
      this.el.chatPanel.hidden ? this.openChat() : this.closeChat());

    $id('btnChatClose').addEventListener('click', () => this.closeChat());

    $id('chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $id('chatInput');
      const text = input.value.trim();
      if (!text) return;
      this.emit('chat', text);
      input.value = '';
      input.focus();
    });

    // Esc closes the chat before anything else reacts to it.
    $id('chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.closeChat(); }
    });

    document.querySelectorAll('.quick-chat button').forEach(b =>
      b.addEventListener('click', () => this.emit('chat', b.dataset.qc)));
  }

  openChat() {
    this.el.chatPanel.hidden = false;
    this.el.chatDot.hidden = true;
    this.el.chatLog.scrollTop = this.el.chatLog.scrollHeight;
    $id('chatInput').focus();
  }

  closeChat() {
    this.el.chatPanel.hidden = true;
    $id('chatInput').blur();
  }

  get chatOpen() { return !this.el.chatPanel.hidden; }

  addChat(name, text, mine, system) {
    const n = document.createElement('div');
    n.className = 'chat-msg' + (system ? ' sys' : (mine ? ' me' : ''));
    n.innerHTML = system ? this._esc(text) : `<b>${this._esc(name)}</b>${this._esc(text)}`;
    this.el.chatLog.appendChild(n);
    this.el.chatLog.scrollTop = this.el.chatLog.scrollHeight;

    // Panel closed (small screens): float the message beside the board so
    // nobody ever misses a text or an emoji from another player.
    if (this.el.chatPanel.hidden && !mine) {
      this.el.chatDot.hidden = false;
      this._chatBubble(system ? '' : name, text);
    }
  }

  /** Transient message bubble at the right edge of the board. */
  _chatBubble(name, text) {
    const holder = this.el.chatBubbles;
    if (!holder) return;
    const n = document.createElement('div');
    n.className = 'chat-bubble';
    n.innerHTML = (name ? `<b>${this._esc(name)}</b>` : '') + this._esc(text);
    holder.appendChild(n);
    while (holder.children.length > 4) holder.firstChild.remove();
    setTimeout(() => {
      n.classList.add('out');
      setTimeout(() => n.remove(), 350);
    }, 4200);
  }

  enableChat(on) {
    this.el.btnChat.hidden = !on;
    this.screens.game.classList.toggle('online', on);
    if (!on) {
      this.el.chatPanel.hidden = true;
      if (this.el.chatBubbles) this.el.chatBubbles.innerHTML = '';
      return;
    }
    // Wide screens: dock the chat open beside the board so every player
    // sees messages live. Small screens keep the toggle button + bubbles.
    if (window.matchMedia('(min-width: 1180px)').matches) {
      this.el.chatPanel.hidden = false;
      this.el.chatDot.hidden = true;
    }
  }

  clearChat() { this.el.chatLog.innerHTML = ''; }

  /* ---------------- overlays ---------------- */

  _bindOverlays() {
    for (const k in this.overlays) {
      this.overlays[k].addEventListener('click', (e) => {
        if (e.target === this.overlays[k] && k === 'pause') this.emit('resume');
      });
    }
  }

  showConnecting(title, sub) {
    this.el.connTitle.textContent = title;
    this.el.connSub.textContent = sub || '';
    this.openOverlay('connect');
  }

  showGameOver({ title, sub, emblem, names, scores, showRematch }) {
    this.el.resultTitle.textContent = title;
    this.el.resultSub.textContent = sub;
    this.el.resultEmblem.textContent = emblem;
    this.el.rsName[0].textContent = names[0];
    this.el.rsName[1].textContent = names[1];
    this.el.rsScore[0].textContent = scores[0];
    this.el.rsScore[1].textContent = scores[1];
    this.el.rematchStatus.hidden = !showRematch;
    this.el.rematchStatus.textContent = '';
    $id('btnReplay').textContent = showRematch ? 'Request Rematch' : 'Play Again';
    this.openOverlay('gameover');
  }

  setRematchStatus(text) {
    this.el.rematchStatus.hidden = !text;
    this.el.rematchStatus.textContent = text || '';
  }

  /* ---------------- keys ---------------- */

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (this.current !== 'game') return;

      if (e.key === 'Escape' && this.chatOpen) { this.closeChat(); return; }
      if (e.key === 'p' || e.key === 'P') this.emit('pause-toggle');
      if (e.key === 'Escape') this.emit('escape');
      if (e.key === 'F3') { e.preventDefault(); this.emit('toggle-debug'); }
      this.emit('key', e);
    });
  }

  _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
}

globalThis.UIManager = UIManager;
