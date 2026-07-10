/* ============================================================
 * network.js — carrom-specific multiplayer layer.
 *
 * Protocol (client -> server, all acknowledged):
 *   create-room, join-room, rejoin, player-ready, shoot, chat,
 *   rematch, leave-room
 *
 * Protocol (server -> client):
 *   room-update, game-start, shot, state-sync, turn-change,
 *   coin-pocket, game-over, chat, player-left, player-joined,
 *   rematch-status, opponent-timeout
 *
 * The server is authoritative: it re-runs the identical deterministic
 * simulation, then ships back the settled snapshot. Clients play the
 * shot immediately for zero perceived latency and reconcile at the end.
 * ============================================================ */
'use strict';

class NetworkManager extends EventBus {
  constructor() {
    super();
    this.sock = new SocketClient();
    this.room = null;         // {code, players[], spectators, started}
    this.seat = null;         // 0 | 1 | null (spectator)
    this.playerId = Profile.load().playerId;
    this.spectator = false;
    this.latency = 0;

    this._wire();
  }

  get connected() { return this.sock.connected; }
  get inRoom() { return !!this.room; }
  get isMyTurn() { return this.seat != null && this._turn === this.seat; }

  _wire() {
    const relay = [
      'room-update', 'game-start', 'shot', 'state-sync', 'turn-change',
      'coin-pocket', 'game-over', 'chat', 'player-left', 'player-joined',
      'rematch-status', 'opponent-timeout', 'system'
    ];
    for (const e of relay) this.sock.on(e, (...a) => this.emit(e, ...a));

    this.sock.on('room-update', (room) => { this.room = room; });
    this.sock.on('turn-change', (t) => { this._turn = t; });
    this.sock.on('state-sync', (p) => { if (p && p.state) this._turn = p.state.turn; });
    this.sock.on('game-start', (p) => { if (p && p.state) this._turn = p.state.turn; });

    this.sock.on('connected', () => this.emit('connected'));
    this.sock.on('disconnected', (r) => this.emit('disconnected', r));
    this.sock.on('reconnecting', (n) => this.emit('reconnecting', n));
    this.sock.on('reconnected', () => this._autoRejoin());
    this.sock.on('reconnect-failed', () => this.emit('reconnect-failed'));
    this.sock.on('latency', (ms) => { this.latency = ms; this.emit('latency', ms); });
  }

  /* ---------------- connection ---------------- */

  async connect() {
    await this.sock.connect();
    return true;
  }

  disconnect() {
    this.sock.disconnect();
    this.room = null;
    this.seat = null;
  }

  /* ---------------- rooms ---------------- */

  /** @param {2|4} playerCount singles or doubles */
  async createRoom(playerCount = 2) {
    const me = Profile.load();
    const res = await this.sock.request('create-room', {
      name: me.name,
      playerId: this.playerId,
      strikerColor: me.strikerColor,
      playerCount: playerCount === 4 ? 4 : 2
    });
    this._enter(res);
    return res;
  }

  async joinRoom(code, spectate = false) {
    const me = Profile.load();
    const res = await this.sock.request('join-room', {
      code: String(code).toUpperCase(),
      name: me.name,
      playerId: this.playerId,
      strikerColor: me.strikerColor,
      spectate: !!spectate
    });
    this._enter(res);
    return res;
  }

  /** Silent re-entry after a dropped socket. */
  async _autoRejoin() {
    const sess = Store.get(CONFIG.NET.RECONNECT_KEY, null);
    if (!sess || !sess.code) { this.emit('reconnected'); return; }
    try {
      const res = await this.sock.request('rejoin', { code: sess.code, playerId: this.playerId });
      this._enter(res);
      this.emit('rejoined', res);
    } catch (err) {
      Store.del(CONFIG.NET.RECONNECT_KEY);
      this.emit('rejoin-failed', err);
    }
  }

  _enter(res) {
    this.room = res.room;
    this.seat = (typeof res.seat === 'number') ? res.seat : null;
    this.spectator = this.seat == null;
    if (res.state) this._turn = res.state.turn;
    Store.set(CONFIG.NET.RECONNECT_KEY, { code: res.room.code, ts: Date.now() });
  }

  leaveRoom() {
    if (this.room) this.sock.send('leave-room', { code: this.room.code });
    Store.del(CONFIG.NET.RECONNECT_KEY);
    this.room = null;
    this.seat = null;
    this.spectator = false;
  }

  /* ---------------- gameplay ---------------- */

  ready(flag) { this.sock.send('player-ready', { ready: flag }); }

  /**
   * Ask the server to run our shot. `u` is the striker's chosen position
   * along the base rail, so the server can validate it against the rules.
   */
  shoot(u, angle, power) {
    this.sock.send('shoot', { u, angle, power });
  }

  chat(text) { this.sock.send('chat', { text: String(text).slice(0, 160) }); }

  rematch() { this.sock.send('rematch', {}); }

  /** The local clock ran out — tell the server so it can advance the turn. */
  timeout() { this.sock.send('turn-timeout', {}); }
}

globalThis.NetworkManager = NetworkManager;
