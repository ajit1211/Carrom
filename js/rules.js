/* ============================================================
 * rules.js — official carrom rules, as a pure state machine.
 *
 * Supports both formats:
 *   Singles (2 players) — seats 0 and 2, facing, one team each.
 *   Doubles (4 players) — seats 0..3 clockwise, partners facing.
 *                         team 0 = {0,2} plays White, team 1 = {1,3} Black.
 *
 * Everything is keyed on the SEAT that is shooting, but coins, fouls,
 * debts and victory belong to the TEAM. In singles the two collapse.
 *
 * Shared verbatim by the client and the authoritative server, so a client
 * can never talk the server into an illegal turn transition. Nothing in
 * here draws, plays sound, or touches the DOM.
 * ============================================================ */
'use strict';

var RulesEngine = class RulesEngine {
  /**
   * @param {'practice'|'local'|'online'} mode
   * @param {2|4} playerCount
   * @param {boolean} [colorSwap] room owner's pick: true hands team 0 the black coins
   */
  static newState(mode, playerCount, colorSwap) {
    const count = playerCount === 4 ? 4 : 2;
    return {
      mode: mode || 'local',
      playerCount: count,
      seats: Utils.seatsFor(count),   // which seats actually play
      colorSwap: !!colorSwap,         // which team plays which colour
      turn: 0,                        // seat whose shot it is
      queenPending: null,             // TEAM that owes a "cover"
      queenOwner: null,               // TEAM that has secured the queen
      debt: [0, 0],                   // per team
      turnCount: 0,
      over: false,
      winner: null,                   // team index | 'draw'
      reason: '',
      score: [0, 0]                   // per team
    };
  }

  /* ---------------- seat / team helpers ---------------- */

  static teamOf(state, seat) { return Utils.teamOf(seat, state.playerCount); }
  static colorOf(state, seat) { return Utils.colorOfSeat(seat, state.playerCount, state.colorSwap); }
  static colorOfTeam(state, team) { return Utils.colorOfTeam(team, state.colorSwap); }
  static otherTeam(team) { return team === 0 ? 1 : 0; }
  static nextSeat(state, seat) { return Utils.nextSeat(seat, state.playerCount); }

  /** Coins of this team still sitting on the bed. */
  static coinsLeft(world, state, team) {
    return world.coinsLeft(RulesEngine.colorOfTeam(state, team));
  }

  /** Coins this team has banked. */
  static pocketedCount(world, state, team) {
    return CONFIG.COINS_PER_SIDE - RulesEngine.coinsLeft(world, state, team);
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
    const seat = state.turn;
    const myTeam = RulesEngine.teamOf(state, seat);
    const oppTeam = RulesEngine.otherTeam(myTeam);
    const myColor = RulesEngine.colorOfTeam(state, myTeam);
    const oppColor = RulesEngine.colorOfTeam(state, oppTeam);

    const report = {
      seat,
      team: myTeam,
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
    if (!report.foul && RulesEngine.coinsLeft(world, state, myTeam) === 0 && world.queenOnBoard()) {
      report.foul = true;
      report.foulReason = 'Last coin before the Queen';
    }

    /* ---------- 2. queen cover owed from a previous shot ---------- */
    if (state.queenPending === myTeam) {
      if (!report.foul && myPotted > 0) {
        state.queenOwner = myTeam;
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
        state.queenOwner = myTeam;
        state.queenPending = null;
        report.queenCovered = true;
        report.messages.push('Queen pocketed & covered!');
      } else {
        state.queenPending = myTeam;
        report.messages.push('Queen pocketed — cover her next shot');
      }
    }

    /* ---------- 4. extra turn ---------- */
    if (!report.foul && (myPotted > 0 || queenPotted)) report.extraTurn = true;

    if (oppPotted > 0) {
      report.messages.push('Gifted ' + oppPotted + ' coin(s) to the other team');
    }

    /* ---------- 5. foul penalty ---------- */
    if (report.foul) {
      report.extraTurn = false;
      // A pending cover is cancelled by a foul.
      if (state.queenPending === myTeam) RulesEngine._returnQueen(world, state, report);

      const coin = RulesEngine._takeBackOneCoin(world, myColor);
      if (coin) {
        report.penaltyCoin = coin.id;
        report.messages.push('Foul — one coin returned to the centre');
      } else {
        state.debt[myTeam]++;
        report.messages.push('Foul — your team owes a coin');
      }
    }

    /* ---------- 6. pay outstanding debt ---------- */
    while (state.debt[myTeam] > 0) {
      const coin = RulesEngine._takeBackOneCoin(world, myColor);
      if (!coin) break;
      state.debt[myTeam]--;
      report.messages.push('Debt paid — a coin went back');
    }

    /* ---------- 7. win / draw ---------- */
    RulesEngine._checkEnd(world, state, report);

    /* ---------- 8. hand over the striker ----------
     * An extra turn keeps the SAME seat shooting — in doubles that means the
     * same player, not their partner, exactly as at a real board. */
    if (!state.over) {
      state.turnCount++;
      if (!report.extraTurn) state.turn = RulesEngine.nextSeat(state, seat);
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
    const seat = state.turn;
    const team = RulesEngine.teamOf(state, seat);
    const report = { seat, team, timeout: true, messages: ['Time up'], queenReturned: false, over: false, winner: null };

    if (state.queenPending === team) RulesEngine._returnQueen(world, state, report);

    state.turnCount++;
    state.turn = RulesEngine.nextSeat(state, seat);
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

  /** Return the lowest-id pocketed coin of `color` to the board (deterministic). */
  static _takeBackOneCoin(world, color) {
    let pick = null;
    for (const c of world.coins) {
      if (c.type === color && c.potted && c.active) { pick = c; break; }
    }
    if (!pick) return null;
    world.restoreCoin(pick);
    return pick;
  }

  static _checkEnd(world, state, report) {
    for (const team of [0, 1]) {
      if (RulesEngine.coinsLeft(world, state, team) !== 0) continue;
      if (state.debt[team] > 0) continue;                    // still owes a coin
      if (state.queenPending === team) continue;             // owes a cover
      if (world.queenOnBoard()) continue;                    // queen must be settled first

      state.over = true;
      state.winner = team;
      state.reason = 'All coins pocketed';
      report.over = true;
      report.winner = team;
      RulesEngine._score(world, state);
      return;
    }
  }

  /** Winner takes the loser's remaining coins, plus 3 if they hold the queen. */
  static _score(world, state) {
    if (typeof state.winner !== 'number') { state.score = [0, 0]; return; }
    const w = state.winner, l = RulesEngine.otherTeam(w);
    let pts = RulesEngine.coinsLeft(world, state, l);
    if (state.queenOwner === w) pts += CONFIG.QUEEN_POINTS;
    state.score = [0, 0];
    state.score[w] = Math.max(1, pts);
  }

  /** Snapshot of everything the HUD needs. Indexed by TEAM, not seat. */
  static hud(world, state) {
    return {
      turn: state.turn,
      turnTeam: RulesEngine.teamOf(state, state.turn),
      playerCount: state.playerCount,
      colorSwap: !!state.colorSwap,
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
