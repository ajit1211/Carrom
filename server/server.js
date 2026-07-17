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

const SEAT_NAME = ['bottom', 'left', 'top', 'right'];

function makeCode() {
  let code;
  do {
    const bytes = crypto.randomBytes(5);
    code = Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (rooms.has(code));
  return code;
}

class Room {
  /** @param {2|4} playerCount singles uses seats 0 & 2; doubles uses all four. */
  constructor(code, playerCount) {
    this.code = code;
    this.playerCount = playerCount === 4 ? 4 : 2;
    this.seats = Utils.seatsFor(this.playerCount);

    /** Sparse, indexed by SEAT (0 bottom, 1 left, 2 top, 3 right). */
    this.players = [null, null, null, null];
    this.spectators = new Set();       // socket ids
    this.ownerId = null;               // playerId who created the room
    this.ownerColor = 'white';         // which coins the OWNER'S team plays
    this.world = World.fromLayout();
    this.state = RulesEngine.newState('online', this.playerCount, this.colorSwap);
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

  /** First unoccupied playing seat, or -1. Seats fill in turn order. */
  freeSeat() {
    for (const s of this.seats) if (!this.players[s]) return s;
    return -1;
  }

  get occupied() {
    return this.seats.filter(s => this.players[s]).length;
  }

  get full() { return this.occupied === this.playerCount; }

  get liveConnections() {
    return this.seats.filter(s => this.players[s] && this.players[s].connected).length + this.spectators.size;
  }

  /**
   * The owner picks a colour for THEIR team; the engine wants the equivalent
   * boolean (false == team 0 plays white). Derived rather than stored so that
   * an owner who changes seats keeps the colour they asked for instead of
   * silently handing it to the other side.
   */
  get colorSwap() {
    const seat = this.ownerId ? this.seatOf(this.ownerId) : -1;
    const team = Utils.teamOf(seat < 0 ? 0 : seat, this.playerCount);
    return this.ownerColor === 'white' ? team === 1 : team === 0;
  }

  /** The owner's seat left for good: hand the room to whoever is still here. */
  reassignOwner() {
    if (this.ownerId && this.seatOf(this.ownerId) >= 0) return;
    const heir = this.seats.map(s => this.players[s]).find(Boolean);
    this.ownerId = heir ? heir.playerId : null;
  }

  publicView() {
    return {
      code: this.code,
      playerCount: this.playerCount,
      players: this.players.map(p => p ? {
        index: p.index, name: p.name, ready: p.ready, connected: p.connected,
        id: p.playerId, strikerColor: p.strikerColor
      } : null),
      spectators: this.spectators.size,
      started: this.started,
      ownerId: this.ownerId,
      ownerColor: this.ownerColor,
      colorSwap: this.colorSwap
    };
  }

  reset() {
    this.world.reset();
    this.state = RulesEngine.newState('online', this.playerCount, this.colorSwap);
    this.world.resetStriker(this.state.turn);
    this.started = false;
    this.rematch.clear();
    for (const s of this.seats) if (this.players[s]) this.players[s].ready = false;
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
  room.state = RulesEngine.newState('online', room.playerCount, room.colorSwap);
  room.world.resetStriker(room.state.turn);
  room.rematch.clear();

  io.to(room.code).emit('game-start', {
    room: room.publicView(),
    state: room.state,
    world: room.world.serialize()
  });
  io.to(room.code).emit('turn-change', room.state.turn);
  room.armTurnTimer();
  console.log('[room] %s started (%dp)', room.code, room.playerCount);
}

/**
 * Run one shot. This is the only place the authoritative world mutates
 * during play, and it is identical to what the clients run locally.
 * @param {number} u rail coordinate the shooter placed the striker at
 */
function applyShot(room, seat, u, angle, power) {
  const world = room.world;

  world.resetStriker(seat, u);
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
      : teamNames(room, room.state.winner) + (room.playerCount === 4 ? ' win!' : ' wins!'));
  } else {
    room.armTurnTimer();
  }
  return report;
}

/** "Ajit & Ravi" for a doubles team, "Ajit" for singles. */
function teamNames(room, team) {
  return room.seats
    .filter(s => Utils.teamOf(s, room.playerCount) === team)
    .map(s => room.players[s] ? room.players[s].name : 'Player')
    .join(' & ');
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

    const room = new Room(makeCode(), Number(p.playerCount) === 4 ? 4 : 2);
    rooms.set(room.code, room);

    room.ownerId = playerId;
    room.players[0] = {
      playerId, name, socketId: socket.id, ready: false, connected: true,
      index: 0, strikerColor: sanitizeColor(p.strikerColor)
    };
    socket.join(room.code);
    socket.data.session = { code: room.code, playerId, spectator: false };

    console.log('[room] %s created by %s (%dp)', room.code, name, room.playerCount);
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
        room.players[seat] = {
          playerId, name, socketId: socket.id, ready: false, connected: true,
          index: seat, strikerColor: sanitizeColor(p.strikerColor)
        };
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

  /* ---------- pick a side (and, in doubles, a team) ---------- */
  socket.on('choose-seat', (p = {}, cb) => {
    const s = socket.data.session;
    if (!s) return fail(cb, 'Not in a room');
    const room = getRoom(s.code);
    if (!room) return fail(cb, 'Room not found');
    if (room.started) return fail(cb, 'The game has already started');

    const seat = Number(p.seat);
    if (!room.seats.includes(seat)) return fail(cb, 'That seat is not in play');

    const cur = room.seatOf(s.playerId);
    if (cur === seat) return ack(cb, { seat, room: room.publicView() });
    if (room.players[seat]) return fail(cb, 'That seat is taken');

    let pl;
    if (cur >= 0) {
      pl = room.players[cur];
      room.players[cur] = null;
    } else {
      // a spectator sitting down
      room.spectators.delete(socket.id);
      s.spectator = false;
      pl = {
        playerId: s.playerId, name: sanitizeName(p.name), socketId: socket.id,
        connected: true, strikerColor: sanitizeColor(p.strikerColor)
      };
    }
    pl.index = seat;
    pl.ready = false;                  // changing sides always un-readies you
    room.players[seat] = pl;

    ack(cb, { seat, room: room.publicView() });
    broadcastRoom(room);
    systemMessage(room, pl.name + ' took the ' + SEAT_NAME[seat] + ' side');
  });

  /* ---------- owner picks their team's coins ---------- */
  socket.on('set-team-color', (p = {}) => {
    const s = socket.data.session;
    if (!s) return;
    const room = getRoom(s.code);
    if (!room || room.started) return;
    if (s.playerId !== room.ownerId) return;             // owner only

    const color = p.color === 'black' ? 'black' : 'white';
    if (color === room.ownerColor) return;
    room.ownerColor = color;
    // A colour change invalidates everyone's "ready": you agreed to a different game.
    for (const seat of room.seats) if (room.players[seat]) room.players[seat].ready = false;
    broadcastRoom(room);
    systemMessage(room, teamNames(room, Utils.teamOf(room.seatOf(room.ownerId), room.playerCount)) +
      ' will play the ' + color + ' coins');
  });

  /* ---------- live aim, so the room watches the shot being lined up ---------- */
  socket.on('aim', (p = {}) => {
    const s = socket.data.session;
    if (!s) return;
    const room = getRoom(s.code);
    if (!room || !room.started || room.state.over) return;

    const seat = room.seatOf(s.playerId);
    if (seat < 0 || seat !== room.state.turn) return;    // only the shooter aims

    // Cosmetic relay only: it never touches room.world, so a lost or forged
    // aim packet cannot change the outcome of the shot.
    if (p.off) return socket.to(room.code).emit('aim', { seat, off: true });

    const u = Number(p.u), angle = Number(p.angle), power = Number(p.power);
    if (!isFinite(u) || !isFinite(angle) || !isFinite(power)) return;

    socket.to(room.code).emit('aim', {
      seat,
      u: Utils.clampStrikerU(u),
      aiming: !!p.aiming,
      placing: !!p.placing,
      angle,
      power: Math.max(0, Math.min(1, power))
    });
  });

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

    const allReady = room.seats.every(s => room.players[s] && room.players[s].ready && room.players[s].connected);
    if (room.full && allReady) startGame(room);
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
    let u = Number(p.u);
    if (!isFinite(angle) || !isFinite(power) || !isFinite(u)) return;
    u = Utils.clampStrikerU(u);
    const pw = Math.max(0, Math.min(1, power));

    // Everyone else needs to play the same shot locally for the animation.
    socket.to(room.code).emit('shot', { seat, u, angle, power: pw });
    applyShot(room, seat, u, angle, pw);
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
    io.to(room.code).emit('rematch-status', { count: room.rematch.size, of: room.playerCount });

    if (room.rematch.size >= room.playerCount && room.full) {
      io.to(room.code).emit('rematch-status', { count: room.playerCount, of: room.playerCount, restarting: true });
      room.reset();
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
      room.reassignOwner();
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
      room.reassignOwner();
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

/** Only ever echo back a literal #rrggbb — it goes straight into the DOM. */
function sanitizeColor(c) {
  return /^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : CONFIG.DEFAULT_STRIKER_COLOR;
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
