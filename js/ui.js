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

    this._cacheNodes();
    this._bindNav();
    this._bindSettings();
    this._bindGameHud();
    this._bindLobby();
    this._bindChat();
    this._bindOverlays();
    this._bindKeys();

    this.applyTheme(this.settings.theme);
    this.renderProfile();
    this.renderLeaderboard();
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
      connect: $id('overlay-connect')
    };
    this.el = {
      loadBar: $id('loadBar'), loadMsg: $id('loadMsg'),
      profileName: $id('profileName'), profileAvatar: $id('profileAvatar'),
      profileWins: $id('profileWins'), profileLosses: $id('profileLosses'),
      btnSound: $id('btnSound'), btnMusic: $id('btnMusic'),

      pcard: [$id('pcard0'), $id('pcard1')],
      pname: [$id('pname0'), $id('pname1')],
      pavatar: [$id('pavatar0'), $id('pavatar1')],
      pscore: [$id('pscore0'), $id('pscore1')],
      pqueen: [$id('pqueen0'), $id('pqueen1')],

      timerRing: $id('timerRing'), timerText: $id('timerText'),
      turnIndicator: $id('turnIndicator'),
      powerMeter: $id('powerMeter'), powerFill: $id('powerFill'),
      fps: $id('fps'), toasts: $id('toasts'), netBadge: $id('netBadge'),
      gameHint: $id('gameHint'),

      roomCode: $id('roomCode'), connDot: $id('connDot'), onlineHint: $id('onlineHint'),
      seats: [$id('seat0'), $id('seat1')], spectatorCount: $id('spectatorCount'),
      btnReady: $id('btnReady'), joinCode: $id('joinCode'),

      chatPanel: $id('chatPanel'), chatLog: $id('chatLog'), chatDot: $id('chatDot'),
      btnChat: $id('btnChat'),

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

  setPlayers(p0, p1) {
    [p0, p1].forEach((p, i) => {
      this.el.pname[i].textContent = p.name;
      this.el.pavatar[i].textContent = p.initial;
    });
  }

  /** @param {object} hud from RulesEngine.hud() */
  setHud(hud, localSeat) {
    for (let i = 0; i < 2; i++) {
      const prev = this.el.pscore[i].textContent;
      const val = String(hud.pocketed[i]);
      if (prev !== val) {
        this.el.pscore[i].textContent = val;
        this.el.pscore[i].classList.remove('score-bump');
        void this.el.pscore[i].offsetWidth;
        this.el.pscore[i].classList.add('score-bump');
      }
      this.el.pcard[i].classList.toggle('active', hud.turn === i && !hud.over);
      this.el.pqueen[i].hidden = hud.queenOwner !== i;
    }

    if (hud.over) {
      this.el.turnIndicator.textContent = 'Game over';
    } else if (localSeat == null) {
      this.el.turnIndicator.textContent = (hud.turn === 0 ? 'White' : 'Black') + '’s turn';
    } else {
      this.el.turnIndicator.textContent = hud.turn === localSeat ? 'Your turn' : 'Opponent’s turn';
    }
  }

  setTimer(remaining, total) {
    const t = Utils.clamp(remaining / total, 0, 1);
    this.el.timerRing.style.strokeDashoffset = String(this.RING_LEN * (1 - t));
    this.el.timerRing.classList.toggle('low', remaining <= 5);
    this.el.timerText.textContent = String(Math.ceil(Math.max(0, remaining)));
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
    $id('btnCreateRoom').addEventListener('click', () => this.emit('create-room', { spectate: false }));
    $id('btnJoinRoom').addEventListener('click', () => {
      const code = this.el.joinCode.value.trim().toUpperCase();
      if (code.length < 4) return this.toast('Enter a valid room code', 'bad');
      this.emit('join-room', { code, spectate: $id('setSpectate').checked });
    });
    this.el.joinCode.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
    this.el.joinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') $id('btnJoinRoom').click(); });

    $id('btnLeaveRoom').addEventListener('click', () => this.emit('leave-room'));
    $id('btnReady').addEventListener('click', () => this.emit('ready'));

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

  setConnected(on) {
    this.el.connDot.classList.toggle('on', on);
    this.el.onlineHint.textContent = on ? 'Connected to the match server.' : 'Not connected — check the Server URL in Settings.';
  }

  setRoom(room, mySeat) {
    this.el.roomCode.textContent = room.code;
    for (let i = 0; i < 2; i++) {
      const seat = this.el.seats[i];
      const p = room.players[i];
      const av = seat.querySelector('.avatar');
      const nm = seat.querySelector('strong');
      const rd = seat.querySelector('.ready-pill');
      if (p) {
        av.textContent = (p.name[0] || '?').toUpperCase();
        nm.textContent = p.name + (i === mySeat ? ' (you)' : '');
        rd.textContent = p.ready ? 'Ready' : (p.connected ? 'Not ready' : 'Disconnected');
        seat.classList.toggle('ready', !!p.ready);
      } else {
        av.textContent = '?';
        nm.textContent = 'Waiting…';
        rd.textContent = 'Empty';
        seat.classList.remove('ready');
      }
      seat.classList.toggle('me', i === mySeat);
    }

    this.el.spectatorCount.textContent = room.spectators ? room.spectators + ' spectator(s) watching' : '';
    const me = mySeat != null ? room.players[mySeat] : null;
    this.el.btnReady.textContent = me && me.ready ? 'Cancel Ready' : "I'm Ready";
    this.el.btnReady.disabled = mySeat == null;
  }

  /* ---------------- chat ---------------- */

  _bindChat() {
    this.el.btnChat.addEventListener('click', () => {
      this.el.chatPanel.hidden = !this.el.chatPanel.hidden;
      this.el.chatDot.hidden = true;
    });
    $id('btnChatClose').addEventListener('click', () => { this.el.chatPanel.hidden = true; });

    $id('chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $id('chatInput');
      const text = input.value.trim();
      if (!text) return;
      this.emit('chat', text);
      input.value = '';
    });

    document.querySelectorAll('.quick-chat button').forEach(b =>
      b.addEventListener('click', () => this.emit('chat', b.dataset.qc)));
  }

  addChat(name, text, mine, system) {
    const n = document.createElement('div');
    n.className = 'chat-msg' + (system ? ' sys' : (mine ? ' me' : ''));
    n.innerHTML = system ? this._esc(text) : `<b>${this._esc(name)}</b>${this._esc(text)}`;
    this.el.chatLog.appendChild(n);
    this.el.chatLog.scrollTop = this.el.chatLog.scrollHeight;
    if (this.el.chatPanel.hidden && !mine) this.el.chatDot.hidden = false;
  }

  enableChat(on) {
    this.el.btnChat.hidden = !on;
    if (!on) this.el.chatPanel.hidden = true;
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
