/* ============================================================
 * main.js — bootstrap. Wires UI <-> Network <-> Game and owns the
 * lobby/room flow. Nothing else in the project reaches across layers.
 * ============================================================ */
'use strict';

(function boot() {
  const canvas = document.getElementById('board');
  const ui = new UIManager();
  const net = new NetworkManager();
  const game = new Game(canvas, ui, net);

  // Expose for the console / debugging.
  globalThis.CarromArena = { ui, net, game };

  const settings = Settings.load();
  audio.enabledSfx = settings.sound;
  audio.enabledMusic = settings.music;
  audio.volume = settings.volume / 100;
  ui.applySettings();

  /* ==========================================================
   * menu
   * ========================================================== */

  ui.on('nav', async (to) => {
    if (to === 'practice') return game.start('practice');
    if (to === 'local') return game.start('local');
    if (to === 'online') return openOnline();
  });

  ui.on('quit', () => {
    game.stop();
    if (net.inRoom) net.leaveRoom();
    net.disconnect();
    ui.closeAllOverlays();
    ui.enableChat(false);
    ui.clearChat();
    ui.show('home');
  });

  /* ==========================================================
   * online: connect + lobby
   * ========================================================== */

  let connecting = false;

  async function ensureConnected() {
    if (net.connected) return true;
    if (connecting) return false;
    connecting = true;
    ui.showConnecting('Connecting…', SocketClient.resolveUrl() || 'No server configured');
    try {
      await net.connect();
      ui.closeOverlay('connect');
      ui.setConnected(true);
      return true;
    } catch (err) {
      ui.closeOverlay('connect');
      ui.setConnected(false);
      ui.toast(err.message || 'Could not reach the server', 'bad');
      return false;
    } finally {
      connecting = false;
    }
  }

  async function openOnline() {
    ui.show('online');
    ui.setConnected(false);
    await ensureConnected();
  }

  ui.on('cancel-connect', () => { net.disconnect(); connecting = false; });

  ui.on('create-room', async () => {
    if (!(await ensureConnected())) return;
    try {
      const res = await net.createRoom();
      ui.setRoom(res.room, res.seat);
      ui.show('waiting');
      ui.toast('Room ' + res.room.code + ' created', 'ok');
    } catch (err) {
      ui.toast(err.message || 'Could not create the room', 'bad');
    }
  });

  ui.on('join-room', async ({ code, spectate }) => {
    if (!(await ensureConnected())) return;
    try {
      const res = await net.joinRoom(code, spectate);
      ui.setRoom(res.room, res.seat);
      ui.show('waiting');
      if (res.seat == null) ui.toast('Joined as spectator', 'ok');
    } catch (err) {
      ui.toast(err.message || 'Could not join', 'bad');
    }
  });

  ui.on('leave-room', () => {
    net.leaveRoom();
    ui.show('online');
  });

  let iAmReady = false;
  ui.on('ready', () => {
    iAmReady = !iAmReady;
    net.ready(iAmReady);
  });

  /* ==========================================================
   * online: room events
   * ========================================================== */

  net.on('room-update', (room) => {
    if (ui.current === 'waiting') ui.setRoom(room, net.seat);
    if (net.seat != null && room.players[net.seat]) iAmReady = !!room.players[net.seat].ready;
  });

  net.on('game-start', (p) => {
    iAmReady = false;
    ui.clearChat();
    game.start('online', {
      seat: net.seat,
      names: p.room.players.map((pl, i) => pl || { index: i, name: i === 0 ? 'White' : 'Black' }),
      state: p.state,
      world: p.world
    });
    ui.bigToast('Go!', 'good');
  });

  net.on('game-over', () => { /* game.js reconciles and shows the dialog */ });

  net.on('rematch-status', (p) => {
    if (!p) return;
    if (p.restarting) { ui.setRematchStatus(''); return; }
    ui.setRematchStatus(p.count + '/2 players want a rematch');
  });

  net.on('chat', (m) => {
    if (m.system) ui.addChat('', m.text, false, true);
    else ui.addChat(m.name, m.text, m.playerId === net.playerId, false);
  });

  ui.on('chat', (text) => net.chat(text));

  net.on('player-left', (p) => {
    if (ui.current === 'waiting') ui.toast((p && p.name || 'A player') + ' left', 'bad');
  });

  net.on('system', (msg) => ui.addChat('', msg, false, true));

  /* ==========================================================
   * connection resilience
   * ========================================================== */

  net.on('disconnected', (reason) => {
    ui.setConnected(false);
    if (game.mode === 'online' && game.running) {
      ui.setNetBadge({ text: '● reconnecting…', bad: true });
      ui.toast('Connection lost — reconnecting', 'bad');
    }
  });

  net.on('reconnecting', (n) => ui.setNetBadge({ text: '● retry ' + n, bad: true }));

  net.on('rejoined', (res) => {
    ui.setConnected(true);
    ui.setNetBadge({ text: '● live' });
    ui.toast('Back in the game', 'ok');
    if (res.state && res.world && res.started) {
      game.start('online', {
        seat: res.seat,
        names: res.room.players.map((pl, i) => pl || { index: i, name: i === 0 ? 'White' : 'Black' }),
        state: res.state,
        world: res.world
      });
    } else {
      ui.setRoom(res.room, res.seat);
      ui.show('waiting');
    }
  });

  net.on('rejoin-failed', () => {
    ui.toast('That room is gone', 'bad');
    if (ui.current === 'game') { game.stop(); ui.show('home'); }
  });

  net.on('reconnect-failed', () => {
    ui.toast('Could not reconnect', 'bad');
    game.stop();
    ui.show('home');
  });

  /* ==========================================================
   * deep link:  index.html?room=ABC12
   * ========================================================== */

  async function handleDeepLink() {
    const code = new URLSearchParams(location.search).get('room');
    if (!code) return false;
    history.replaceState({}, '', location.pathname);
    ui.show('online');
    if (!(await ensureConnected())) return true;
    try {
      const res = await net.joinRoom(code.toUpperCase(), false);
      ui.setRoom(res.room, res.seat);
      ui.show('waiting');
    } catch (err) {
      ui.toast(err.message || 'Invite link is no longer valid', 'bad');
    }
    return true;
  }

  /* ==========================================================
   * go
   * ========================================================== */

  ui.runLoader().then(async () => {
    const handled = await handleDeepLink();
    if (handled) return;

    // Offer to rejoin a game we were disconnected from.
    const sess = Store.get(CONFIG.NET.RECONNECT_KEY, null);
    if (sess && sess.code && Date.now() - sess.ts < 10 * 60 * 1000) {
      ui.toast('Rejoining room ' + sess.code + '…');
      if (await ensureConnected()) {
        try {
          const res = await net.joinRoom(sess.code, false);
          ui.setRoom(res.room, res.seat);
          ui.show('waiting');
        } catch (_) {
          Store.del(CONFIG.NET.RECONNECT_KEY);
          ui.show('home');
        }
      }
    }
  });

  // First interaction anywhere unlocks the audio context.
  const unlock = () => { audio.unlock(); window.removeEventListener('pointerdown', unlock); };
  window.addEventListener('pointerdown', unlock);

  // Pause the loop when the tab is hidden — keeps the physics honest.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.running && game.mode !== 'online') game.pause();
  });
})();
