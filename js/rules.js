/* ============================================================
 * rules.js — official carrom rules, as a pure state machine.
 *
 * Shared verbatim by the client and the authoritative server, so a
 * client can never talk the server into an illegal turn transition.
 * Nothing in here draws, plays sound, or touches the DOM.
 * ============================================================ */
'use strict';

var RulesEngine = class RulesEngine {
  /**
   * Fresh match state.
   * @param {'practice'|'local'|'online'} mode
   */
  static newState(mode) {
    return {
      mode: mode || 'local',
      colors: ['white', 'black'],   // colors[playerIndex]
      turn: 0,                      // whose shot it is
      queenPending: null,           // player index that owes a "cover"
      queenOwner: null,             // player index that has secured the queen
      debt: [0, 0],                 // coins owed back to the board after a foul
      turnCount: 0,
      over: false,
      winner: null,                 // 0 | 1 | 'draw'
      reason: '',
      score: [0, 0]
    };
  }

  static colorOf(state, playerIndex) { return state.colors[playerIndex]; }
  static opponent(playerIndex) { return playerIndex === 0 ? 1 : 0; }

  /** Coins of this player still sitting on the bed. */
  static coinsLeft(world, state, playerIndex) {
    return world.coinsLeft(RulesEngine.colorOf(state, playerIndex));
  }

  /** Coins this player has banked. */
  static pocketedCount(world, state, playerIndex) {
    return CONFIG.COINS_PER_SIDE - RulesEngine.coinsLeft(world, state, playerIndex);
  }

  /**
   * Resolve one completed shot.
   *
   * @param {World} world
   * @param {object} state  mutated in place
   * @param {Array}  pocketEvents  the `kind:'pocket'` events from this shot
   * @param {boolean} touchedSomething  did the striker contact any coin?
   * @returns {object} a report the UI/network layers can render
   */
  static resolveShot(world, state, pocketEvents, touchedSomething) {
    const me = state.turn;
    const opp = RulesEngine.opponent(me);
    const myColor = RulesEngine.colorOf(state, me);
    const oppColor = RulesEngine.colorOf(state, opp);

    const report = {
      player: me,
      extraTurn: false,
      foul: false,
      foulReason: '',
      queenPocketed: false,
      queenCovered: false,
      queenReturned: false,
      penaltyCoin: null,
      pocketed: pocketEvents.map(e => e.type),
      messages: [],
      over: false,
      winner: null,
      touchedSomething: !!touchedSomething
    };

    const strikerPotted = pocketEvents.some(e => e.type === 'striker');
    const myPotted = pocketEvents.filter(e => e.type === myColor).length;
    const oppPotted = pocketEvents.filter(e => e.type === oppColor).length;
    const queenPotted = pocketEvents.some(e => e.type === 'queen');

    /* ---------- practice mode: no rules, just reset the striker ---------- */
    if (state.mode === 'practice') {
      if (queenPotted) report.messages.push('Queen pocketed');
      if (myPotted + oppPotted) report.messages.push((myPotted + oppPotted) + ' coin(s) pocketed');
      if (strikerPotted) report.messages.push('Striker pocketed');
      report.extraTurn = true;
      world.resetStriker(0);
      return report;
    }

    /* ---------- 1. fouls ---------- */
    if (strikerPotted) {
      report.foul = true;
      report.foulReason = 'Striker pocketed';
    }

    // Pocketing your last coin while the queen is still on the board is a foul.
    const myLeftAfter = RulesEngine.coinsLeft(world, state, me);
    if (!report.foul && myLeftAfter === 0 && world.queenOnBoard()) {
      report.foul = true;
      report.foulReason = 'Last coin before the Queen';
    }

    /* ---------- 2. queen cover owed from a previous shot ---------- */
    if (state.queenPending === me) {
      if (!report.foul && myPotted > 0) {
        state.queenOwner = me;
        state.queenPending = null;
        report.queenCovered = true;
        report.messages.push('Queen covered!');
      } else {
        RulesEngine._returnQueen(world, state, report);
      }
    }

    /* ---------- 3. queen pocketed on THIS shot ---------- */
    if (queenPotted) {
      report.queenPocketed = true;
      if (report.foul) {
        RulesEngine._returnQueen(world, state, report);
      } else if (myPotted > 0) {
        state.queenOwner = me;
        state.queenPending = null;
        report.queenCovered = true;
        report.messages.push('Queen pocketed & covered!');
      } else {
        state.queenPending = me;
        report.messages.push('Queen pocketed — cover her next shot');
      }
    }

    /* ---------- 4. extra turn ---------- */
    if (!report.foul && (myPotted > 0 || queenPotted)) report.extraTurn = true;

    if (oppPotted > 0) {
      report.messages.push('Gifted ' + oppPotted + ' coin(s) to your opponent');
    }

    /* ---------- 5. foul penalty ---------- */
    if (report.foul) {
      report.extraTurn = false;
      // A pending cover is cancelled by a foul.
      if (state.queenPending === me) RulesEngine._returnQueen(world, state, report);

      const coin = RulesEngine._takeBackOneCoin(world, myColor);
      if (coin) {
        report.penaltyCoin = coin.id;
        report.messages.push('Foul — one coin returned to the centre');
      } else {
        state.debt[me]++;
        report.messages.push('Foul — you owe a coin');
      }
    }

    /* ---------- 6. pay outstanding debt ---------- */
    while (state.debt[me] > 0) {
      const coin = RulesEngine._takeBackOneCoin(world, myColor);
      if (!coin) break;
      state.debt[me]--;
      report.messages.push('Debt paid — a coin went back');
    }

    /* ---------- 7. win / draw ---------- */
    RulesEngine._checkEnd(world, state, report, me, opp);

    /* ---------- 8. hand over the striker ---------- */
    if (!state.over) {
      state.turnCount++;
      if (!report.extraTurn) state.turn = opp;
      world.resetStriker(state.turn);

      if (state.turnCount >= CONFIG.MAX_TURNS) {
        state.over = true;
        state.winner = 'draw';
        state.reason = 'Turn limit reached';
        report.over = true;
        report.winner = 'draw';
      }
    }

    return report;
  }

  /**
   * The shooter ran out of time (or disconnected mid-turn).
   * Turn passes; a pending queen cover is forfeited.
   */
  static abandonTurn(world, state) {
    const me = state.turn;
    const report = { player: me, timeout: true, messages: ['Time up'], queenReturned: false, over: false, winner: null };

    if (state.queenPending === me) RulesEngine._returnQueen(world, state, report);

    state.turnCount++;
    state.turn = RulesEngine.opponent(me);
    world.resetStriker(state.turn);

    if (state.turnCount >= CONFIG.MAX_TURNS) {
      state.over = true; state.winner = 'draw'; state.reason = 'Turn limit reached';
      report.over = true; report.winner = 'draw';
    }
    return report;
  }

  /* ---------------- internals ---------------- */

  static _returnQueen(world, state, report) {
    const queen = world.coins.find(c => c.type === 'queen');
    if (queen && queen.potted) {
      world.restoreCoin(queen);
      report.queenReturned = true;
      report.messages.push('Queen uncovered — back to the centre');
    }
    state.queenPending = null;
    state.queenOwner = null;
  }

  /** Return the highest-id pocketed coin of `color` to the board (deterministic). */
  static _takeBackOneCoin(world, color) {
    let pick = null;
    for (const c of world.coins) {
      if (c.type === color && c.potted && c.active) { pick = c; break; }
    }
    if (!pick) return null;
    world.restoreCoin(pick);
    return pick;
  }

  static _checkEnd(world, state, report, me, opp) {
    const finish = (winner, reason) => {
      state.over = true;
      state.winner = winner;
      state.reason = reason;
      report.over = true;
      report.winner = winner;
      RulesEngine._score(world, state);
    };

    for (const p of [me, opp]) {
      if (RulesEngine.coinsLeft(world, state, p) !== 0) continue;
      if (state.debt[p] > 0) continue;                       // still owes a coin
      if (state.queenPending === p) continue;                // owes a cover
      if (world.queenOnBoard()) continue;                    // queen must be settled first
      finish(p, 'All coins pocketed');
      return;
    }
  }

  /** Winner takes the loser's remaining coins, plus 3 if they hold the queen. */
  static _score(world, state) {
    if (typeof state.winner !== 'number') { state.score = [0, 0]; return; }
    const w = state.winner, l = RulesEngine.opponent(w);
    let pts = RulesEngine.coinsLeft(world, state, l);
    if (state.queenOwner === w) pts += CONFIG.QUEEN_POINTS;
    state.score = [0, 0];
    state.score[w] = Math.max(1, pts);
  }

  /** Snapshot of everything the HUD needs. */
  static hud(world, state) {
    return {
      turn: state.turn,
      colors: state.colors.slice(),
      pocketed: [RulesEngine.pocketedCount(world, state, 0), RulesEngine.pocketedCount(world, state, 1)],
      queenOwner: state.queenOwner,
      queenPending: state.queenPending,
      debt: state.debt.slice(),
      over: state.over,
      winner: state.winner,
      reason: state.reason,
      score: state.score.slice()
    };
  }
};

globalThis.RulesEngine = RulesEngine;
