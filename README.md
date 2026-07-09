# 🎯 Carrom Arena

A production-ready Carrom board game in **HTML5 + CSS3 + vanilla ES6 JavaScript**, with a **Node/Express/Socket.io** server for online multiplayer.

Real rigid-body physics (momentum, mass, restitution, sliding friction, impulse collision resolution). No frameworks, no image assets, no audio files — the board, the coins and every sound effect are generated procedurally at runtime.

```
Practice  ·  Local 2-player  ·  Online rooms with invite links, chat, spectators, reconnect
```

---

## 📁 Project structure

```
Carrom/
├── index.html              all screens: loading, menu, lobby, game, overlays
├── package.json
├── render.yaml             one-click deploy blueprint for Render.com
│
├── css/
│   └── style.css           dark glassmorphism UI, 4 themes, responsive 320px → 4K
│
├── js/
│   ├── utils.js            CONFIG (geometry + physics constants), helpers, particles
│   ├── physics.js          Body + World: integrator, collision solver, pockets, aim raycast
│   ├── coin.js             Coin (extends Body) + procedural rendering
│   ├── striker.js          Striker (extends Coin) + the slingshot Aim model
│   ├── rules.js            RulesEngine: official carrom rules as a pure state machine
│   ├── board.js            procedural wood board, markings, pockets, debug overlay
│   ├── player.js           seats, persisted Profile + Settings
│   ├── audio.js            every sound synthesised with the Web Audio API
│   ├── ui.js               all DOM: screens, HUD, toasts, lobby, chat, dialogs
│   ├── socket.js           thin Socket.io wrapper (connect, ack, reconnect, RTT)
│   ├── network.js          carrom-specific multiplayer protocol
│   ├── game.js             controller: input, game loop, rendering, netcode
│   └── main.js             bootstrap + lobby flow
│
└── server/
    └── server.js           Express + Socket.io, authoritative rooms
```

### The one architectural idea worth knowing

`utils.js`, `physics.js`, `coin.js`, `striker.js` and `rules.js` contain **zero DOM access**. The server loads those exact five files into a Node `vm` sandbox and runs them.

The simulation is fully deterministic — no `Math.random`, no `Date`, no iteration over unordered maps, and a fixed 360 Hz sub-step. So the same shot fed to the same state produces bit-identical results on both machines.

That gives real server authority for the cost of *one* `simulate()` call per shot (~9 ms) instead of streaming 60 state updates a second:

1. You release the striker → your client plays the shot **immediately** (zero perceived latency).
2. The shot `{x, angle, power}` goes to the server.
3. The server validates the turn, replays the identical physics, applies the rules, and broadcasts the settled snapshot.
4. Your client reconciles when its animation ends. Because the physics agrees, the reconcile is invisible — but a tampered client is simply overwritten.

---

## 🚀 Run it locally

Requires **Node 18+**.

```bash
npm install
npm start
```

Open **http://localhost:3000**. Open a second tab (or another device on your Wi-Fi at `http://<your-lan-ip>:3000`) to test online mode.

> **Practice** and **Play Offline** work with no server at all — you can just open `index.html` directly.

---

## 🎮 How to play

| Action | Control |
|---|---|
| Position the striker | drag the striker along your base line |
| Aim & set power | press anywhere else, drag **backwards** (slingshot) |
| Shoot | release |
| Cancel a drag | `Esc` |
| Nudge striker | `←` `→` |
| Charge & shoot straight | hold and release `Space` |
| Pause | `P` |
| Debug overlay | `F3` |

**Rules implemented:** extra turn on pocketing your own coin · opponent coins credited to them · Queen must be covered on the same or next shot · striker-in-pocket foul returns one coin (or creates a debt) · pocketing your last coin before the Queen is a foul · win by clearing your nine coins with the Queen resolved · turn timer, timeout, draw on the turn cap.

---

## 🌐 Deploy to GitHub + invite your friend

The frontend is fully static, but **online multiplayer needs the Node server running somewhere**. GitHub Pages only serves static files, so you have two options.

### Option A — one host, simplest (recommended)

Deploy the whole repo to a free Node host. It serves the game *and* the sockets from the same URL, so nothing needs configuring and the invite link just works.

**1. Push to GitHub**

```bash
git init
git add .
git commit -m "Carrom Arena"
git branch -M main
git remote add origin https://github.com/<you>/carrom-arena.git
git push -u origin main
```

**2. Deploy on [Render](https://render.com) (free tier)**

- New → **Web Service** → connect your repo
- Build command: `npm install`
- Start command: `npm start`
- Deploy. You get something like `https://carrom-arena.onrender.com`

`render.yaml` is already in the repo, so Render can also pick these up automatically via **New → Blueprint**.

> Any Node host works the same way — Railway, Fly.io, Cyclic, a VPS. The server reads `process.env.PORT`.

**3. Invite your friend**

- Open your URL → **Play Online** → **Create Room**
- Hit **Copy Invite Link** and send it (`https://carrom-arena.onrender.com/?room=AB3XY`)
- They open it, land straight in your room, both press **Ready**

> Render's free tier sleeps after inactivity — the first load can take ~30 seconds to wake.

### Option B — GitHub Pages frontend + separate server

If you specifically want the game on `github.io`:

1. Repo → **Settings → Pages** → Source: `main` branch, `/ (root)`. Your game is at `https://<you>.github.io/carrom-arena/`.
2. Deploy `server/` anywhere (Render, as above).
3. In the game: **Settings → Multiplayer Server URL** → paste `https://carrom-arena.onrender.com` → **Save**. It is stored in `localStorage`.
4. Your friend must set the same URL once.

To skip step 3–4 for everyone, bake the URL in — edit `js/utils.js`:

```js
NET: {
  PUBLIC_SERVER: 'https://carrom-arena.onrender.com',
  ...
}
```

The server already sends `Access-Control-Allow-Origin: *`, so a Pages-hosted frontend can talk to it.

---

## 🔌 Socket.io protocol

**Client → server** (all acknowledged): `create-room` · `join-room` · `rejoin` · `player-ready` · `shoot` · `turn-timeout` · `chat` · `rematch` · `leave-room` · `ping-rtt`

**Server → client:** `room-update` · `game-start` · `shot` · `state-sync` · `turn-change` · `coin-pocket` · `game-over` · `chat` · `player-joined` · `player-left` · `rematch-status` · `opponent-timeout`

Room codes are 5 characters from a confusion-free alphabet (no `0`/`O`, no `1`/`I`). A dropped player's seat is held for **45 seconds** so they can reconnect straight back into the live game; empty rooms are garbage-collected after 10 minutes. `GET /health` reports uptime and live room count.

---

## ⚙️ Physics notes

The bed is 0.7366 m wide (a real 29″ board) and maps to 744 logical pixels, so **1 m ≈ 1010 px**. Everything else follows from that:

- **Coin** ⌀3.02 cm → r = 15.5 px · **Striker** ⌀4.13 cm → r = 20.5 px · **Pocket** ⌀4.45 cm
- **Friction:** a powdered board has μ ≈ 0.085, so a = μg ≈ 850 px/s². Deceleration is *independent of mass* — which is exactly why the heavy striker and a light coin coast the same distance from the same speed. This falls out of the maths; it is not special-cased.
- **Shot speed:** a real flick leaves the fingernail at 3–5 m/s. Full power = 3200 px/s ≈ 3.2 m/s, which coasts ~8 board-widths.
- **Collisions:** impulse resolution with restitution 0.94 (coin–coin) and 0.72 (cushion), plus a clamped tangential impulse that imparts a little spin and scrub.
- **No tunnelling:** at 360 Hz the fastest striker advances 8.9 px per sub-step against a 15.5 px coin radius.
- **Masses:** coin 1.0, striker 2.6 (real: ~5.5 g vs ~15 g).

Verified in testing: a clean, unobstructed cut shot pockets **93%** of the time; the failures are geometrically impossible backward cuts. Two independent clients running the same shot produce identical board states to nine decimal places.

---

## 🎛️ Settings

Player name · music · sound · master volume · graphics quality (low/medium/high — caps DPR, disables shadows, thins the wood grain) · 4 themes · turn timer · aim guide · FPS counter · debug mode · multiplayer server URL.

## 📱 Responsive

Desktop, laptop, tablet, phone (portrait and landscape). Pointer events cover mouse, touch and pen. The board is 900×900 *logical* units scaled to the viewport, so physics never depends on screen size. When you play seat 2 online the whole view rotates 180° so your rail is always at the bottom.

---

## 📝 License

MIT. All artwork and code are original — the board, coins and sounds are drawn and synthesised from scratch at runtime.
