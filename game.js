"use strict";
// Bridge rules engine. No network code in here, so it can be tested on its own.
const crypto = require("crypto");

const SEATS = ["N", "E", "S", "W"]; // clockwise
const SUITS = ["C", "D", "H", "S"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const DENOMS = ["C", "D", "H", "S", "NT"]; // lowest to highest
const AVATARS = ["🦊", "🐻", "🐼", "🦉", "🐙", "🦁", "🐸", "🐧", "🦄", "🐯", "🐨", "🦋"];
const BOT_AVATAR = "🤖";
const SYMBOL = { C: "♣", D: "♦", H: "♥", S: "♠", NT: "NT" };

const next = (s) => SEATS[(SEATS.indexOf(s) + 1) % 4];
const partner = (s) => SEATS[(SEATS.indexOf(s) + 2) % 4];
const side = (s) => (s === "N" || s === "S" ? "NS" : "EW");
const suitOf = (card) => card[1];
const rankVal = (card) => RANKS.indexOf(card[0]);
const isContractBid = (call) => /^[1-7]/.test(call);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createRoom(code, hostId) {
  return {
    code,
    host: hostId,
    phase: "lobby", // lobby | bidding | playing | finished
    seats: { N: null, E: null, S: null, W: null }, // {playerId, name} or {bot:true, name}
    members: new Map(), // playerId -> {name, socketId}
    dealer: "N",
    hands: null,
    bids: [],
    turn: null,
    contract: null,
    trick: [],
    pendingWinner: null,
    lastTrick: null,
    tricks: { NS: 0, EW: 0 },
    trickCount: 0,
    dummyShown: false,
    result: null,
    message: "",
    rubber: newRubber(1),
    updated: Date.now(),
  };
}

function seatOf(room, playerId) {
  return SEATS.find((s) => room.seats[s] && room.seats[s].playerId === playerId) || null;
}

function sortHand(hand) {
  const order = ["S", "H", "C", "D"];
  hand.sort((a, b) => {
    const d = order.indexOf(suitOf(a)) - order.indexOf(suitOf(b));
    return d || rankVal(b) - rankVal(a);
  });
}

function startDeal(room) {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  shuffle(deck);
  room.hands = { N: [], E: [], S: [], W: [] };
  let seat = next(room.dealer);
  for (const card of deck) {
    room.hands[seat].push(card);
    seat = next(seat);
  }
  SEATS.forEach((s) => sortHand(room.hands[s]));
  room.phase = "bidding";
  room.bids = [];
  room.turn = room.dealer;
  room.contract = null;
  room.trick = [];
  room.pendingWinner = null;
  room.lastTrick = null;
  room.tricks = { NS: 0, EW: 0 };
  room.trickCount = 0;
  room.dummyShown = false;
  room.result = null;
}

// ---------- Bidding ----------

function bidRank(call) {
  return (parseInt(call[0], 10) - 1) * 5 + DENOMS.indexOf(call.slice(1));
}

function lastWhere(list, fn) {
  for (let i = list.length - 1; i >= 0; i--) if (fn(list[i])) return list[i];
  return null;
}

// Returns null if the call is legal, otherwise an error message.
function validateBid(room, seat, call) {
  if (room.phase !== "bidding") return "Bidding is not in progress";
  if (room.turn !== seat) return "It is not your turn to bid";
  if (call === "P") return null;
  const lastReal = lastWhere(room.bids, (b) => b.call !== "P");
  if (call === "X") {
    if (!lastReal || !isContractBid(lastReal.call) || side(lastReal.seat) === side(seat))
      return "You can only double an opponent's bid";
    return null;
  }
  if (call === "XX") {
    if (!lastReal || lastReal.call !== "X" || side(lastReal.seat) === side(seat))
      return "You can only redouble after an opponent doubles";
    return null;
  }
  if (!/^[1-7](C|D|H|S|NT)$/.test(call)) return "Not a valid call";
  const lastBid = lastWhere(room.bids, (b) => isContractBid(b.call));
  if (lastBid && bidRank(call) <= bidRank(lastBid.call)) return "Your bid must be higher than the last bid";
  return null;
}

function legalBids(room, seat) {
  const calls = ["P", "X", "XX"];
  for (let l = 1; l <= 7; l++) for (const d of DENOMS) calls.push(l + d);
  return calls.filter((c) => validateBid(room, seat, c) === null);
}

function makeBid(room, seat, call) {
  const err = validateBid(room, seat, call);
  if (err) return { error: err };
  room.bids.push({ seat, call });
  const n = room.bids.length;
  const anyBid = room.bids.some((b) => isContractBid(b.call));

  if (!anyBid && n === 4) {
    room.message = "Everyone passed, so the cards were redealt.";
    room.dealer = next(room.dealer);
    startDeal(room);
    return { ok: true, redeal: true };
  }
  if (anyBid && n >= 4 && room.bids.slice(-3).every((b) => b.call === "P")) {
    finishBidding(room);
    return { ok: true };
  }
  room.turn = next(seat);
  return { ok: true };
}

function finishBidding(room) {
  const lastBid = lastWhere(room.bids, (b) => isContractBid(b.call));
  const level = parseInt(lastBid.call[0], 10);
  const denom = lastBid.call.slice(1);
  const lastReal = lastWhere(room.bids, (b) => b.call !== "P");
  const doubled = lastReal.call === "X" ? "X" : lastReal.call === "XX" ? "XX" : "";
  // Declarer: the first player on the winning side to have named this denomination.
  const declarer = room.bids.find(
    (b) => isContractBid(b.call) && b.call.slice(1) === denom && side(b.seat) === side(lastBid.seat)
  ).seat;
  room.contract = { level, denom, declarer, dummy: partner(declarer), doubled };
  room.phase = "playing";
  room.turn = next(declarer); // opening lead
  room.message = "";
}

// ---------- Play ----------

function controller(room, seat) {
  // Declarer plays the dummy's cards.
  return room.contract && seat === room.contract.dummy ? room.contract.declarer : seat;
}

function legalCards(room, seat) {
  const hand = room.hands[seat];
  if (room.trick.length === 0) return hand.slice();
  const led = suitOf(room.trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === led);
  return follow.length ? follow : hand.slice();
}

function trickWinner(trick, trump) {
  let best = trick[0];
  for (const t of trick.slice(1)) {
    const bs = suitOf(best.card);
    const ts = suitOf(t.card);
    if (ts === bs) {
      if (rankVal(t.card) > rankVal(best.card)) best = t;
    } else if (trump && ts === trump) {
      best = t;
    }
  }
  return best.seat;
}

// actorSeat is the seat of the player who clicked. Returns {ok, trickComplete} or {error}.
function makePlay(room, actorSeat, card) {
  if (room.phase !== "playing") return { error: "Cards are not being played right now" };
  if (room.pendingWinner) return { error: "Wait for the trick to finish" };
  const seat = room.turn;
  if (controller(room, seat) !== actorSeat) return { error: "It is not your turn" };
  if (!room.hands[seat].includes(card)) return { error: "That card is not in the hand" };
  if (!legalCards(room, seat).includes(card)) return { error: "You must follow suit" };

  room.hands[seat] = room.hands[seat].filter((c) => c !== card);
  room.trick.push({ seat, card });
  if (!room.dummyShown) room.dummyShown = true; // dummy goes down after the opening lead

  if (room.trick.length === 4) {
    const trump = room.contract.denom === "NT" ? null : room.contract.denom;
    room.pendingWinner = trickWinner(room.trick, trump);
    room.turn = null;
    return { ok: true, trickComplete: true };
  }
  room.turn = next(seat);
  return { ok: true, trickComplete: false };
}

// Called after a short pause so everyone can see the completed trick.
function resolveTrick(room) {
  const winner = room.pendingWinner;
  if (!winner) return;
  room.tricks[side(winner)]++;
  room.lastTrick = { cards: room.trick, winner };
  room.trick = [];
  room.pendingWinner = null;
  room.trickCount++;
  if (room.trickCount === 13) finishHand(room);
  else room.turn = winner;
}

function contractText(c) {
  return `${c.level}${SYMBOL[c.denom]}${c.doubled}`;
}

function finishHand(room) {
  const c = room.contract;
  const got = room.tricks[side(c.declarer)];
  const needed = 6 + c.level;
  const diff = got - needed;
  room.phase = "finished";
  room.turn = null;
  room.result = {
    declarerTricks: got,
    needed,
    diff,
    made: diff >= 0,
    text:
      `${contractText(c)} by ${c.declarer}: ` +
      (diff > 0 ? `made with ${diff} overtrick${diff > 1 ? "s" : ""}` : diff === 0 ? "made exactly" : `down ${-diff}`),
  };
  room.result.score = scoreHand(room);
  const sum = (sd) => room.result.score.items.filter((i) => i.side === sd).reduce((a, i) => a + i.pts, 0);
  room.rubber.log.push({ text: room.result.text, NS: sum("NS"), EW: sum("EW") });
}

function dealNext(room) {
  if (room.phase === "finished") room.dealer = next(room.dealer);
  if (room.rubber.over) room.rubber = newRubber(room.rubber.no + 1);
  room.message = "";
  startDeal(room);
}

// ---------- Scoring (rubber bridge) ----------

function newRubber(no) {
  return {
    no,
    games: { NS: 0, EW: 0 }, // games won; a side with a game is vulnerable
    below: { NS: 0, EW: 0 }, // contract points in the current game
    belowAll: { NS: 0, EW: 0 }, // all contract points in the rubber
    above: { NS: 0, EW: 0 }, // bonuses and penalties
    over: false,
    winner: null,
    log: [],
  };
}

const trickValue = (denom) => (denom === "C" || denom === "D" ? 20 : 30);

// Scores the finished hand into room.rubber and returns the itemised breakdown.
function scoreHand(room) {
  const c = room.contract;
  const dSide = side(c.declarer);
  const oSide = dSide === "NS" ? "EW" : "NS";
  const r = room.rubber;
  const vul = r.games[dSide] > 0; // vulnerability at the start of this hand
  const diff = room.tricks[dSide] - (6 + c.level);
  const items = [];
  const add = (sd, line, label, pts) => pts && items.push({ side: sd, line, label, pts });

  if (diff >= 0) {
    const mult = c.doubled === "XX" ? 4 : c.doubled === "X" ? 2 : 1;
    const base = c.denom === "NT" ? 40 + 30 * (c.level - 1) : trickValue(c.denom) * c.level;
    add(dSide, "below", "Contract tricks", base * mult);
    if (diff > 0) {
      const per = c.doubled === "XX" ? (vul ? 400 : 200) : c.doubled === "X" ? (vul ? 200 : 100) : trickValue(c.denom);
      add(dSide, "above", `${diff} overtrick${diff > 1 ? "s" : ""}`, per * diff);
    }
    if (c.doubled === "X") add(dSide, "above", "Bonus for making a doubled contract", 50);
    if (c.doubled === "XX") add(dSide, "above", "Bonus for making a redoubled contract", 100);
    if (c.level === 6) add(dSide, "above", "Small slam bonus", vul ? 750 : 500);
    if (c.level === 7) add(dSide, "above", "Grand slam bonus", vul ? 1500 : 1000);
  } else {
    const n = -diff;
    let pts = 0;
    if (!c.doubled) pts = n * (vul ? 100 : 50);
    else {
      for (let i = 1; i <= n; i++) {
        if (vul) pts += i === 1 ? 200 : 300;
        else pts += i === 1 ? 100 : i <= 3 ? 200 : 300;
      }
      if (c.doubled === "XX") pts *= 2;
    }
    add(oSide, "above", `${n} undertrick${n > 1 ? "s" : ""}`, pts);
  }

  for (const it of items) {
    if (it.line === "above") r.above[it.side] += it.pts;
    else {
      r.below[it.side] += it.pts;
      r.belowAll[it.side] += it.pts;
    }
  }

  let gameWon = null;
  let rubberBonus = null;
  if (r.below[dSide] >= 100) {
    r.games[dSide]++;
    r.below = { NS: 0, EW: 0 }; // a new game starts from zero for both sides
    gameWon = dSide;
    if (r.games[dSide] === 2) {
      const bonus = r.games[oSide] === 0 ? 700 : 500;
      r.above[dSide] += bonus;
      r.over = true;
      r.winner = dSide;
      rubberBonus = { side: dSide, pts: bonus };
      items.push({ side: dSide, line: "above", label: "Rubber bonus", pts: bonus });
    }
  }
  return { items, gameWon, rubberBonus };
}

function rubberView(room) {
  const r = room.rubber;
  const total = (sd) => r.above[sd] + r.belowAll[sd];
  return {
    no: r.no,
    games: r.games,
    below: r.below,
    above: r.above,
    total: { NS: total("NS"), EW: total("EW") },
    vul: { NS: r.games.NS > 0, EW: r.games.EW > 0 },
    over: r.over,
    winner: r.winner,
    log: r.log.slice(-8),
  };
}

// ---------- What each player is allowed to see ----------

function viewFor(room, playerId) {
  const mySeat = seatOf(room, playerId);
  const view = {
    code: room.code,
    phase: room.phase,
    host: room.host === playerId,
    you: mySeat,
    message: room.message,
    rubber: rubberView(room),
    seats: {},
  };
  for (const s of SEATS) {
    const seat = room.seats[s];
    if (!seat) view.seats[s] = null;
    else {
      const m = seat.bot ? null : room.members.get(seat.playerId);
      view.seats[s] = { name: seat.name, avatar: seat.bot ? BOT_AVATAR : seat.avatar, bot: !!seat.bot, offline: !seat.bot && !(m && m.socketId) };
    }
  }
  if (room.phase === "lobby") return view;

  view.dealer = room.dealer;
  view.bids = room.bids;
  view.contract = room.contract;
  view.turn = room.turn;
  view.trick = room.trick;
  view.trickWinner = room.pendingWinner;
  view.lastTrick = room.lastTrick;
  view.tricks = room.tricks;
  view.result = room.result;
  view.counts = {};
  for (const s of SEATS) view.counts[s] = room.hands[s].length;

  // Only your own cards, plus the dummy once it has been revealed.
  view.hand = mySeat ? room.hands[mySeat] : [];
  view.dummy = room.dummyShown && room.contract ? { seat: room.contract.dummy, hand: room.hands[room.contract.dummy] } : null;
  if (room.phase === "finished") view.reveal = room.hands; // hand is over, nothing left to hide

  if (room.turn) {
    const actor = controller(room, room.turn);
    if (mySeat && actor === mySeat) {
      view.yourTurn = true;
      view.actingSeat = room.turn;
      if (room.phase === "bidding") view.legalBids = legalBids(room, room.turn);
      else view.legal = legalCards(room, room.turn);
    }
  }
  return view;
}

module.exports = {
  SEATS, AVATARS, next, partner, side, createRoom, seatOf, startDeal, makeBid, makePlay, resolveTrick,
  dealNext, viewFor, scoreHand, newRubber, controller, legalCards, legalBids, validateBid,
};
