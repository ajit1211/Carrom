/* ============================================================
 * server/server.js — Express + Socket.io, authoritative carrom.
 *
 * The server does NOT reimplement the physics. It loads the *exact*
 * files the browser loads (js/utils.js, physics.js, coin.js,
 * striker.js, rules.js) into a `vm` sandbox and runs them. Same code,
 * same deterministic result — so "server-authoritative" costs one
 * simulate() call per shot instead of a 60 Hz state stream.
 *
 *   node server/server.js          → http://localhost:3000
 * ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

/* ==========================================================
 * 1. Load the shared game code into a sandbox
 * ========================================================== */

const JS_DIR = path.join(__dirname, '..', 'js');
const SHARED = ['utils.js', 'physics.js', 'coin.js', 'striker.js', 'rules.js'];

function createEngine() {
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 }
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  for (const file of SHARED) {
    const code = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    vm.runInContext(code, ctx, { filename: 'shared/' + file });
  }

  if (!ctx.World || !ctx.RulesEngine) throw new Error('Failed to load the shared game engine.');
  return ctx;
}

const engine = createEngine();
const { World, RulesEngine, CONFIG, Utils } = engine;
console.log('[engine] loaded — board %d, %d coins', CONFIG.BOARD_SIZE, Utils.initialLayout().length);

/* ==========================================================
 * 2. HTTP
 * ========================================================== */

const app = express();
const ROOT = path.join(__dirname, '..');

app.use(express.static(ROOT, { extensions: ['html'], maxAge: '1h' }));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 20000
});

/* ==========================================================
 * 3. Rooms
 * ========================================================== */

/** @type {Map<string, Room>} */
const rooms = new Map();

const TURN_LIMIT_MS = (CONFIG.DEFAULT_TURN_TIME + 8) * 1000;   // server grace on top of the client clock
const GRACE_MS = 45_000;                                       // how long a disconnected seat is held
const EMPTY_ROOM_MS = 10 * 60 * 1000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';       // no 0/O/1/I

function makeCode() {
  let code;
  do {
    const bytes = crypto.randomBytes(5);
    code = Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(code) {
    this.code = code;
    /** @type {Array<null|{playerId,name,socketId,ready,connected,index}>} */
    this.players = [null, null];
    this.spectators = new Set();       // socket ids
    this.world = World.fromLayout();
    this.state = RulesEngine.newState('online');
    this.started = false;
    this.rematch = new Set();          // playerIds
    this.turnTimer = null;
    this.graceTimers = new Map();      // playerId -> timeout
    this.emptyTimer = null;
    this.createdAt = Date.now();
  }

  seatOf(playerId) {
    return this.players.findIndex(p => p && p.playerId === playerId);
  }

  seatOfSocket(socketId) {
    return this.players.findIndex(p => p && p.socketId === socketId);
  }

  freeSeat() {
    return this.players.findIndex(p => !p);
  }

  get occupied() {
    return this.players.filter(Boolean).length;
  }

  get liveConnections() {
    return this.players.filter(p => p && p.connected).length + this.spectators.size;
  }

  publicView() {
    return {
      code: this.code,
      players: this.players.map(p => p ? {
        index: p.index, name: p.name, ready: p.ready, connected: p.connected, id: p.playerId
      } : null),
      spectators: this.spectators.size,
      started: this.started
    };
  }

  snapshot() {
    return { world: this.world.serialize(), state: this.state };
  }

  reset() {
    this.world.reset();
    this.state = RulesEngine.newState('online');
    this.world.resetStriker(this.state.turn);
    this.started = false;
    this.rematch.clear();
    for (const p of this.players) if (p) p.ready = false;
    this.clearTurnTimer();
  }

  clearTurnTimer() {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
  }

  armTurnTimer() {
    this.clearTurnTimer();
    if (!this.started || this.state.over) return;
    this.turnTimer = setTimeout(() => forceTimeout(this), TURN_LIMIT_MS);
  }
}

function getRoom(code) { return rooms.get(String(code || '').toUpperCase()); }

function broadcastRoom(room) {
  io.to(room.code).emit('room-update', room.publicView());
}

function systemMessage(room, text) {
  io.to(room.code).emit('chat', { system: true, text });
}

function destroyRoom(room) {
  room.clearTurnTimer();
  for (const t of room.graceTimers.values()) clearTimeout(t);
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  rooms.delete(room.code);
  console.log('[room] %s destroyed (%d live)', room.code, rooms.size);
}

function scheduleEmptyCheck(room) {
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    if (room.liveConnections === 0) destroyRoom(room);
  }, EMPTY_ROOM_MS);
}

/* ==========================================================
 * 4. Gameplay
 * ========================================================== */

function startGame(room) {
  room.started = true;
  room.world.reset();
  room.state = RulesEngine.newState('online');
  room.world.resetStriker(room.state.turn);
  room.rematch.clear();

  io.to(room.code).emit('game-start', {
    room: room.publicView(),
    state: room.state,
    world: room.world.serialize()
  });
  io.to(room.code).emit('turn-change', room.state.turn);
  room.armTurnTimer();
  console.log('[room] %s started', room.code);
}

/**
 * Run one shot. This is the only place the authoritative world mutates
 * during play, and it is identical to what the clients run locally.
 */
function applyShot(room, seat, x, angle, power) {
  const world = room.world;

  world.resetStriker(seat, x);
  world.shoot(angle, power);
  world.simulate();

  const events = world.drainEvents();
  const pockets = events.filter(e => e.kind === 'pocket');
  const touched = events.some(e => e.kind === 'hit' && (e.aType === 'striker' || e.bType === 'striker'));

  const report = RulesEngine.resolveShot(world, room.state, pockets, touched);

  for (const p of pockets) {
    io.to(room.code).emit('coin-pocket', { type: p.type, pocket: p.pocket, seat });
  }

  io.to(room.code).emit('state-sync', {
    world: world.serialize(),
    state: room.state,
    report
  });
  io.to(room.code).emit('turn-change', room.state.turn);

  if (room.state.over) {
    room.started = false;
    room.clearTurnTimer();
    io.to(room.code).emit('game-over', { state: room.state, world: world.serialize() });
    systemMessage(room, room.state.winner === 'draw'
      ? 'Draw — ' + room.state.reason
      : (room.players[room.state.winner] ? room.players[room.state.winner].name : 'Player') + ' wins!');
  } else {
    room.armTurnTimer();
  }
  return report;
}

/** The shooter never played. Advance the turn on their behalf. */
function forceTimeout(room) {
  if (!room.started || room.state.over) return;
  const loser = room.state.turn;
  const report = RulesEngine.abandonTurn(room.world, room.state);

  io.to(room.code).emit('opponent-timeout', { seat: loser });
  io.to(room.code).emit('state-sync', { world: room.world.serialize(), state: room.state, report });
  io.to(room.code).emit('turn-change', room.state.turn);
  systemMessage(room, (room.players[loser] ? room.players[loser].name : 'Player') + ' ran out of time.');

  if (room.state.over) {
    room.started = false;
    room.clearTurnTimer();
    io.to(room.code).emit('game-over', { state: room.state, world: room.world.serialize() });
  } else {
    room.armTurnTimer();
  }
}

/* ==========================================================
 * 5. Socket wiring
 * ========================================================== */

io.on('connection', (socket) => {
  /** @type {{code:string, playerId:string, spectator:boolean}|null} */
  socket.data.session = null;

  const ack = (cb, payload) => { if (typeof cb === 'function') cb(payload); };
  const fail = (cb, msg) => { if (typeof cb === 'function') cb({ error: msg }); };

  socket.on('ping-rtt', (_p, cb) => ack(cb, { t: Date.now() }));

  /* ---------- create ---------- */
  socket.on('create-room', (p = {}, cb) => {
    const name = sanitizeName(p.name);
    const playerId = String(p.playerId || '').slice(0, 40);
    if (!playerId) return fail(cb, 'Missing player id');

    const room = new Room(makeCode());
    rooms.set(room.code, room);

    room.players[0] = { playerId, name, socketId: socket.id, ready: false, connected: true, index: 0 };
    socket.join(room.code);
    socket.data.session = { code: room.code, playerId, spectator: false };

    console.log('[room] %s created by %s', room.code, name);
    ack(cb, { room: room.publicView(), seat: 0, state: room.state, world: room.world.serialize(), started: false });
    scheduleEmptyCheck(room);
  });

  /* ---------- join ---------- */
  socket.on('join-room', (p = {}, cb) => {
    const room = getRoom(p.code);
    if (!room) return fail(cb, 'Room not found');

    const name = sanitizeName(p.name);
    const playerId = String(p.playerId || '').slice(0, 40);
    if (!playerId) return fail(cb, 'Missing player id');

    // Already seated here? Treat as a rejoin.
    const existing = room.seatOf(playerId);
    if (existing >= 0) return doRejoin(room, existing, playerId, socket, cb);

    let seat = null;
    if (!p.spectate) {
      const free = room.freeSeat();
      if (free >= 0 && !room.started) {
        seat = free;
        room.players[seat] = { playerId, name, socketId: socket.id, ready: false, connected: true, index: seat };
      }
    }

    socket.join(room.code);
    if (seat == null) room.spectators.add(socket.id);
    socket.data.session = { code: room.code, playerId, spectator: seat == null };

    ack(cb, {
      room: room.publicView(),
      seat,
      state: room.state,
      world: room.world.serialize(),
      started: room.started
    });

    broadcastRoom(room);
    systemMessage(room, name + (seat == null ? ' is spectating' : ' joined'));
    socket.to(room.code).emit('player-joined', { name, seat });
  });

  /* ---------- rejoin after a drop ---------- */
  socket.on('rejoin', (p = {}, cb) => {
    const room = getRoom(p.code);
    if (!room) return fail(cb, 'Room not found');
    const playerId = String(p.playerId || '');
    const seat = room.seatOf(playerId);
    if (seat < 0) return fail(cb, 'You are not in this room');
    doRejoin(room, seat, playerId, socket, cb);
  });

  function doRejoin(room, seat, playerId, sock, cb) {
    const pl = room.players[seat];
    pl.socketId = sock.id;
    pl.connected = true;

    const t = room.graceTimers.get(playerId);
    if (t) { clearTimeout(t); room.graceTimers.delete(playerId); }

    sock.join(room.code);
    sock.data.session = { code: room.code, playerId, spectator: false };

    ack(cb, {
      room: room.publicView(),
      seat,
      state: room.state,
      world: room.world.serialize(),
      started: room.started
    });
    broadcastRoom(room);
    sock.to(room.code).emit('player-joined', { name: pl.name, seat });
    systemMessage(room, pl.name + ' reconnected');
    if (room.started) room.armTurnTimer();
  }

  /* ---------- ready ---------- */
  socket.on('player-ready', (p = {}) => {
    const s = socket.data.session;
    if (!s) return;
    const room = getRoom(s.code);
    if (!room) return;
    const seat = room.seatOf(s.playerId);
    if (seat < 0) return;

    room.players[seat].ready = !!p.ready;
    broadcastRoom(room);

    if (room.occupied === 2 && room.players.every(pl => pl && pl.ready && pl.connected)) {
      startGame(room);
    }
  });

  /* ---------- shoot ---------- */
  socket.on('shoot', (p = {}) => {
    const s = socket.data.session;
    if (!s) return;
    const room = getRoom(s.code);
    if (!room || !room.started || room.state.over) return;

    const seat = room.seatOf(s.playerId);
    if (seat < 0 || seat !== room.state.turn) return;              // not your turn

    const angle = Number(p.angle);
    const power = Number(p.power);
    let x = Number(p.x);
    if (!isFinite(angle) || !isFinite(power) || !isFinite(x)) return;
    x = Utils.clampStrikerX(x);
    const pw = Math.max(0, Math.min(1, power));

    // Everyone else needs to play the same shot locally for the animation.
    socket.to(room.code).emit('shot', { seat, x, angle, power: pw });
    applyShot(room, seat, x, angle, pw);
  });

  /* ---------- the shooter admits they ran out of time ---------- */
  socket.on('turn-timeout', () => {
    const s = socket.data.session;
    if (!s) return;
    const room = getRoom(s.code);
    if (!room || !room.started || room.state.over) return;
    if (room.seatOf(s.playerId) !== room.state.turn) return;
    forceTimeout(room);
  });

  /* ---------- chat ---------- */
  socket.on('chat', (p = {}) => {
    const s = socket.data.session;
    if (!s) return;
    const room = getRoom(s.code);
    if (!room) return;
    const text = String(p.text || '').slice(0, 160).trim();
    if (!text) return;

    const seat = room.seatOf(s.playerId);
    const name = seat >= 0 ? room.players[seat].name : 'Spectator';
    io.to(room.code).emit('chat', { name, text, playerId: s.playerId });
  });

  /* ---------- rematch ---------- */
  socket.on('rematch', () => {
    const s = socket.data.session;
    if (!s) return;
    const room = getRoom(s.code);
    if (!room) return;
    const seat = room.seatOf(s.playerId);
    if (seat < 0) return;

    room.rematch.add(s.playerId);
    io.to(room.code).emit('rematch-status', { count: room.rematch.size });

    if (room.rematch.size >= 2 && room.occupied === 2) {
      io.to(room.code).emit('rematch-status', { count: 2, restarting: true });
      room.reset();
      // Loser of the previous game shoots first — classic house rule.
      setTimeout(() => startGame(room), 350);
    }
  });

  /* ---------- leave ---------- */
  socket.on('leave-room', () => leave(socket, true));
  socket.on('disconnect', () => leave(socket, false));

  function leave(sock, explicit) {
    const s = sock.data.session;
    if (!s) return;
    const room = getRoom(s.code);
    sock.data.session = null;
    if (!room) return;

    room.spectators.delete(sock.id);
    const seat = room.seatOf(s.playerId);

    if (seat < 0) {
      sock.leave(room.code);
      broadcastRoom(room);
      scheduleEmptyCheck(room);
      return;
    }

    const pl = room.players[seat];

    if (explicit) {
      room.players[seat] = null;
      room.rematch.delete(s.playerId);
      sock.leave(room.code);
      systemMessage(room, pl.name + ' left the room');
      io.to(room.code).emit('player-left', { seat, name: pl.name, permanent: true });
      if (room.started) { room.started = false; room.clearTurnTimer(); }
      broadcastRoom(room);
      if (room.liveConnections === 0) destroyRoom(room); else scheduleEmptyCheck(room);
      return;
    }

    /* Unexpected drop: hold the seat for GRACE_MS so they can rejoin. */
    pl.connected = false;
    pl.ready = false;
    room.clearTurnTimer();
    io.to(room.code).emit('player-left', { seat, name: pl.name, permanent: false });
    systemMessage(room, pl.name + ' disconnected — holding their seat for 45s');
    broadcastRoom(room);

    const t = setTimeout(() => {
      room.graceTimers.delete(s.playerId);
      const cur = room.players[seat];
      if (!cur || cur.connected) return;
      room.players[seat] = null;
      room.started = false;
      systemMessage(room, cur.name + ' did not come back.');
      io.to(room.code).emit('player-left', { seat, name: cur.name, permanent: true });
      broadcastRoom(room);
      if (room.liveConnections === 0) destroyRoom(room);
    }, GRACE_MS);

    room.graceTimers.set(s.playerId, t);
  }
});

function sanitizeName(n) {
  const s = String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 14);
  return s || 'Player';
}

/* ==========================================================
 * 6. Listen
 * ========================================================== */

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('┌──────────────────────────────────────────┐');
  console.log('│  Carrom Arena                            │');
  console.log('│  http://localhost:' + String(PORT).padEnd(23) + '│');
  console.log('└──────────────────────────────────────────┘');
});

process.on('SIGINT', () => { console.log('\nbye'); process.exit(0); });
