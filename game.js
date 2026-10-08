"use strict";
// Bridge rules engine. No network code in here, so it can be tested on its own.
const crypto = require("crypto");

const SEATS = ["N", "E", "S", "W"]; // clockwise
const SUITS = ["C", "D", "H", "S"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const DENOMS = ["C", "D", "H", "S", "NT"]; // lowest to highest
const AVATARS = ["🦊", "🐻", "🐼", "🦉", "🐙", "🦁", "🐸", "🐧", "🦄", "🐯", "🐨", "🦋"];
const BOT_AVATAR = "🤖";
const REACTIONS = ["👍", "😂", "😮", "👏", "🤔", "😬"];
const SYMBOL = { C: "♣", D: "♦", H: "♥", S: "♠", NT: "NT" };
const NAMES = { N: "North", E: "East", S: "South", W: "West" };

const next = (s) => SEATS[(SEATS.indexOf(s) + 1) % 4];
const partner = (s) => SEATS[(SEATS.indexOf(s) + 2) % 4];
const side = (s) => (s === "N" || s === "S" ? "NS" : "EW");
const suitOf = (card) => card[1];
const rankVal = (card) => RANKS.indexOf(card[0]);
const isContractBid = (call) => /^[1-7]/.test(call);

// Secret used so that "deal sets" can't be worked out from the set code alone.
const DEAL_SECRET = crypto.randomBytes(32);
// Duplicate results shared between tables playing the same deal set: "SET|board" -> Map(room code -> {ns, t})
const dupRegistry = new Map();

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Same set code + board number always gives the same deal, on any table.
function seededShuffle(arr, set, board) {
  let counter = 0;
  const rnd = (n) =>
    crypto.createHmac("sha256", DEAL_SECRET).update(`${set}|${board}|${counter++}`).digest().readUInt32BE(0) % n;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Standard 16-board vulnerability cycle: [NS, EW]
const DUP_VUL = [
  [0, 0], [1, 0], [0, 1], [1, 1], [1, 0], [0, 1], [1, 1], [0, 0],
  [0, 1], [1, 1], [0, 0], [1, 0], [1, 1], [0, 0], [1, 0], [0, 1],
];
const dupVul = (board) => {
  const v = DUP_VUL[(board - 1) % 16];
  return { NS: !!v[0], EW: !!v[1] };
};

function createRoom(code, hostId) {
  return {
    code,
    host: hostId,
    phase: "lobby", // lobby | bidding | playing | finished
    seats: { N: null, E: null, S: null, W: null }, // {playerId, name, avatar} or {bot:true, name}
    members: new Map(), // playerId -> {mid, name, avatar, socketId}
    banned: new Set(),
    settings: { mode: "rubber", honors: false, bots: "smart", set: code },
    dealer: "N",
    hands: null,
    dealt: null,
    vul: { NS: false, EW: false },
    bids: [],
    turn: null,
    contract: null,
    trick: [],
    pendingWinner: null,
    lastTrick: null,
    tricks: { NS: 0, EW: 0 },
    trickCount: 0,
    trickLog: [],
    playedCards: [],
    dummyShown: false,
    proposal: null,
    claimed: null,
    result: null,
    message: "",
    handNo: 0,
    rubber: newRubber(1),
    dup: { board: 0, results: [] },
    history: [],
    chat: [],
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

// ---------- Settings ----------

function applySettings(room, patch) {
  if (room.phase !== "lobby") return { error: "Settings can only change before the deal" };
  const s = room.settings;
  const before = { mode: s.mode, set: s.set };
  if (patch.mode !== undefined) {
    if (!["rubber", "duplicate"].includes(patch.mode)) return { error: "Unknown scoring type" };
    s.mode = patch.mode;
  }
  if (patch.honors !== undefined) s.honors = !!patch.honors;
  if (patch.bots !== undefined) {
    if (!["smart", "easy"].includes(patch.bots)) return { error: "Unknown bot level" };
    s.bots = patch.bots;
  }
  if (patch.set !== undefined) {
    const v = String(patch.set).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!v) return { error: "Use letters or numbers for the deal set code" };
    s.set = v;
  }
  if (s.mode !== before.mode || s.set !== before.set) {
    room.rubber = newRubber(1);
    room.dup = { board: 0, results: [] };
    purgeRoomResults(room.code);
  }
  return { ok: true };
}

function resetToLobby(room) {
  room.phase = "lobby";
  room.turn = null;
  room.proposal = null;
  room.message = "";
  room.rubber = newRubber(1);
  room.dup = { board: 0, results: [] };
  purgeRoomResults(room.code);
}

// ---------- Dealing ----------

function startDeal(room) {
  room.handNo++;
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  if (room.settings.mode === "duplicate") {
    room.dup.board += 1;
    seededShuffle(deck, room.settings.set, room.dup.board);
    room.dealer = SEATS[(room.dup.board - 1) % 4];
    room.vul = dupVul(room.dup.board);
  } else {
    shuffle(deck);
    room.vul = { NS: room.rubber.games.NS > 0, EW: room.rubber.games.EW > 0 };
  }
  room.hands = { N: [], E: [], S: [], W: [] };
  let seat = next(room.dealer);
  for (const card of deck) {
    room.hands[seat].push(card);
    seat = next(seat);
  }
  SEATS.forEach((s) => sortHand(room.hands[s]));
  room.dealt = {};
  SEATS.forEach((s) => (room.dealt[s] = room.hands[s].slice()));
  room.phase = "bidding";
  room.bids = [];
  room.turn = room.dealer;
  room.contract = null;
  room.trick = [];
  room.pendingWinner = null;
  room.lastTrick = null;
  room.tricks = { NS: 0, EW: 0 };
  room.trickCount = 0;
  room.trickLog = [];
  room.playedCards = [];
  room.dummyShown = false;
  room.proposal = null;
  room.claimed = null;
  room.result = null;
}

function dealNext(room) {
  if (room.settings.mode === "rubber") {
    if (room.phase === "finished") room.dealer = next(room.dealer);
    if (room.rubber.over) room.rubber = newRubber(room.rubber.no + 1);
  }
  room.message = "";
  startDeal(room);
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

function makeBid(room, seat, call, alert) {
  const err = validateBid(room, seat, call);
  if (err) return { error: err };
  const note = typeof alert === "string" ? alert.trim().slice(0, 60) : "";
  room.bids.push({ seat, call, alert: note });
  const n = room.bids.length;
  const anyBid = room.bids.some((b) => isContractBid(b.call));

  if (!anyBid && n === 4) return { ok: true, passedOut: passOut(room) };
  if (anyBid && n >= 4 && room.bids.slice(-3).every((b) => b.call === "P")) {
    finishBidding(room);
    return { ok: true };
  }
  room.turn = next(seat);
  return { ok: true };
}

function passOut(room) {
  room.result = { text: "Passed out", passedOut: true, score: { items: [], ns: 0 } };
  room.turn = null;
  pushHistory(room);
  if (room.settings.mode === "duplicate") {
    recordDup(room, 0, "Passed out");
    room.phase = "finished";
    return "finished";
  }
  room.result = null;
  room.message = "Everyone passed, so the cards were redealt.";
  room.dealer = next(room.dealer);
  startDeal(room);
  return "redeal";
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
  if (room.proposal) return { error: "A claim is waiting for an answer" };
  if (room.pendingWinner) return { error: "Wait for the trick to finish" };
  const seat = room.turn;
  if (controller(room, seat) !== actorSeat) return { error: "It is not your turn" };
  if (!room.hands[seat].includes(card)) return { error: "That card is not in the hand" };
  if (!legalCards(room, seat).includes(card)) return { error: "You must follow suit" };

  room.message = "";
  room.hands[seat] = room.hands[seat].filter((c) => c !== card);
  room.trick.push({ seat, card });
  room.playedCards.push(card);
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
  room.trickLog.push({ leader: room.trick[0].seat, plays: room.trick, winner });
  room.trick = [];
  room.pendingWinner = null;
  room.trickCount++;
  if (room.trickCount === 13) finishHand(room);
  else room.turn = winner;
}

// ---------- Claims and concessions ----------

function proposalTargets(room) {
  return SEATS.filter((s) => side(s) !== side(room.contract.declarer));
}

function propose(room, actorSeat, type, tricks) {
  if (room.phase !== "playing" || room.proposal || room.pendingWinner || room.trick.length !== 0)
    return { error: "You can only claim or concede between tricks" };
  const c = room.contract;
  const remaining = 13 - room.trickCount;
  if (type === "claim") {
    if (actorSeat !== c.declarer) return { error: "Only the declarer can claim tricks" };
    const n = Number(tricks);
    if (!Number.isInteger(n) || n < 0 || n > remaining) return { error: `Claim between 0 and ${remaining} tricks` };
    if (n === 0) {
      settleClaim(room, 0);
      return { ok: true, settled: true };
    }
    room.proposal = { type, by: actorSeat, tricks: n, needs: proposalTargets(room), accepted: [] };
    return { ok: true };
  }
  if (type === "concede") {
    if (actorSeat === c.declarer) {
      settleClaim(room, 0);
      return { ok: true, settled: true };
    }
    if (side(actorSeat) === side(c.declarer)) return { error: "The dummy cannot concede" };
    room.proposal = { type, by: actorSeat, tricks: remaining, needs: [partner(actorSeat)], accepted: [] };
    return { ok: true };
  }
  return { error: "Unknown request" };
}

function respond(room, seat, accept) {
  const p = room.proposal;
  if (!p) return { error: "There is nothing to respond to" };
  if (!p.needs.includes(seat)) return { error: "This is not waiting on you" };
  if (!accept) {
    room.proposal = null;
    room.message = `${NAMES[seat]} did not accept the ${p.type === "claim" ? "claim" : "concession"}, so play continues.`;
    return { ok: true, rejected: true };
  }
  if (!p.accepted.includes(seat)) p.accepted.push(seat);
  if (p.needs.every((s) => p.accepted.includes(s))) {
    room.proposal = null;
    settleClaim(room, p.tricks);
    return { ok: true, settled: true };
  }
  return { ok: true };
}

function withdraw(room, seat) {
  if (!room.proposal || room.proposal.by !== seat) return { error: "Nothing to withdraw" };
  room.proposal = null;
  return { ok: true };
}

// declTricks = how many of the remaining tricks the declarer's side takes.
function settleClaim(room, declTricks) {
  const ds = side(room.contract.declarer);
  const os = ds === "NS" ? "EW" : "NS";
  const remaining = 13 - room.trickCount;
  room.tricks[ds] += declTricks;
  room.tricks[os] += remaining - declTricks;
  room.trickCount = 13;
  room.claimed = { declarerTricks: declTricks, remaining };
  finishHand(room);
}

// ---------- Finishing a hand ----------

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
  room.proposal = null;
  const text =
    `${contractText(c)} by ${c.declarer}: ` +
    (diff > 0 ? `made with ${diff} overtrick${diff > 1 ? "s" : ""}` : diff === 0 ? "made exactly" : `down ${-diff}`);
  room.result = { declarerTricks: got, needed, diff, made: diff >= 0, text, claimed: room.claimed };

  if (room.settings.mode === "duplicate") {
    room.result.score = scoreDuplicate(room);
    recordDup(room, room.result.score.ns, text);
  } else {
    room.result.score = scoreHand(room);
    const sum = (sd) => room.result.score.items.filter((i) => i.side === sd).reduce((a, i) => a + i.pts, 0);
    room.rubber.log.push({ text, NS: sum("NS"), EW: sum("EW") });
  }
  pushHistory(room);
}

function pushHistory(room) {
  room.history.push({
    n: room.handNo,
    board: room.settings.mode === "duplicate" ? room.dup.board : null,
    dealer: room.dealer,
    vul: room.vul,
    hands: room.dealt,
    bids: room.bids.map((b) => ({ seat: b.seat, call: b.call, alert: b.alert || "" })),
    contract: room.contract,
    tricks: room.trickLog,
    claimed: room.claimed,
    result: room.result.text,
    score: room.result.score,
  });
  if (room.history.length > 30) room.history.shift();
}

// ---------- Scoring (shared pieces) ----------

const trickValue = (denom) => (denom === "C" || denom === "D" ? 20 : 30);

// Points for making or failing the contract, as itemised lines.
function contractItems(room, vul, lineForTricks) {
  const c = room.contract;
  const dSide = side(c.declarer);
  const oSide = dSide === "NS" ? "EW" : "NS";
  const diff = room.tricks[dSide] - (6 + c.level);
  const items = [];
  const add = (sd, line, label, pts) => pts && items.push({ side: sd, line, label, pts });
  let trickPts = 0;

  if (diff >= 0) {
    const mult = c.doubled === "XX" ? 4 : c.doubled === "X" ? 2 : 1;
    const base = c.denom === "NT" ? 40 + 30 * (c.level - 1) : trickValue(c.denom) * c.level;
    trickPts = base * mult;
    add(dSide, lineForTricks, "Contract tricks", trickPts);
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
  return { items, trickPts, made: diff >= 0 };
}

// Optional honors bonus (rubber): four or five top trumps, or four aces at no-trump, in one hand.
function honorsItems(room) {
  const items = [];
  if (!room.settings.honors || !room.dealt) return items;
  const c = room.contract;
  for (const seat of SEATS) {
    const hand = room.dealt[seat];
    if (c.denom === "NT") {
      if (hand.filter((x) => x[0] === "A").length === 4)
        items.push({ side: side(seat), line: "above", label: "Four aces in one hand", pts: 150 });
    } else {
      const n = hand.filter((x) => x[1] === c.denom && "AKQJT".includes(x[0])).length;
      if (n === 5) items.push({ side: side(seat), line: "above", label: "All five top trumps in one hand", pts: 150 });
      else if (n === 4) items.push({ side: side(seat), line: "above", label: "Four top trumps in one hand", pts: 100 });
    }
  }
  return items;
}

// ---------- Rubber scoring ----------

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

// Scores the finished hand into room.rubber and returns the itemised breakdown.
function scoreHand(room) {
  const c = room.contract;
  const dSide = side(c.declarer);
  const oSide = dSide === "NS" ? "EW" : "NS";
  const r = room.rubber;
  const vul = r.games[dSide] > 0; // vulnerability at the start of this hand
  const { items } = contractItems(room, vul, "below");
  items.push(...honorsItems(room));

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

// ---------- Duplicate scoring ----------

function scoreDuplicate(room) {
  const c = room.contract;
  const dSide = side(c.declarer);
  const vul = room.vul[dSide];
  const { items, trickPts, made } = contractItems(room, vul, "score");
  if (made) {
    if (trickPts >= 100) items.push({ side: dSide, line: "score", label: "Game bonus", pts: vul ? 500 : 300 });
    else items.push({ side: dSide, line: "score", label: "Part-score bonus", pts: 50 });
  }
  const ns = items.reduce((a, i) => a + (i.side === "NS" ? i.pts : -i.pts), 0);
  return { items, ns };
}

function recordDup(room, ns, text) {
  const board = room.dup.board;
  room.dup.results.push({ board, ns, text });
  const key = `${room.settings.set}|${board}`;
  if (!dupRegistry.has(key)) dupRegistry.set(key, new Map());
  dupRegistry.get(key).set(room.code, { ns, t: Date.now() });
}

function purgeRoomResults(code) {
  for (const m of dupRegistry.values()) m.delete(code);
}

function purgeRegistry(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, m] of dupRegistry) {
    for (const [code, v] of m) if (v.t < cutoff) m.delete(code);
    if (!m.size) dupRegistry.delete(key);
  }
}

function otherResults(set, board, code) {
  const m = dupRegistry.get(`${set}|${board}`);
  return m ? [...m].filter(([c]) => c !== code).map(([, v]) => v.ns) : [];
}

function dupView(room) {
  const set = room.settings.set;
  let sum = 0;
  let compared = 0;
  const all = room.dup.results.map((r) => {
    const others = otherResults(set, r.board, room.code);
    let nsPct = null;
    if (others.length) {
      let mp = 0;
      for (const o of others) mp += r.ns > o ? 1 : r.ns === o ? 0.5 : 0;
      nsPct = Math.round((100 * mp) / others.length);
      sum += nsPct;
      compared++;
    }
    return { board: r.board, text: r.text, ns: r.ns, nsPct, others: others.length };
  });
  const nsAvg = compared ? Math.round(sum / compared) : null;
  return {
    set,
    board: room.dup.board,
    results: all.slice(-12),
    nsAvg,
    ewAvg: nsAvg === null ? null : 100 - nsAvg,
    compared,
  };
}

// ---------- What each player is allowed to see ----------

function viewFor(room, playerId) {
  const mySeat = seatOf(room, playerId);
  const hostMember = room.members.get(room.host);
  const view = {
    code: room.code,
    phase: room.phase,
    host: room.host === playerId,
    hostOffline: !hostMember || !hostMember.socketId,
    you: mySeat,
    message: room.message,
    settings: room.settings,
    rubber: rubberView(room),
    dup: dupView(room),
    chat: room.chat.slice(-30),
    people: [...room.members].map(([pid, m]) => ({
      mid: m.mid,
      name: m.name,
      avatar: m.avatar,
      seat: seatOf(room, pid),
      offline: !m.socketId,
      host: pid === room.host,
      you: pid === playerId,
    })),
    seats: {},
  };
  for (const s of SEATS) {
    const seat = room.seats[s];
    if (!seat) view.seats[s] = null;
    else {
      const m = seat.bot ? null : room.members.get(seat.playerId);
      view.seats[s] = {
        name: seat.name,
        avatar: seat.bot ? BOT_AVATAR : seat.avatar,
        bot: !!seat.bot,
        offline: !seat.bot && !(m && m.socketId),
      };
    }
  }
  if (room.phase === "lobby") return view;

  view.dealer = room.dealer;
  view.vul = room.vul;
  view.handNo = room.handNo;
  // Bid explanations are for the opponents; your partner must not see them until the hand is over.
  view.bids = room.bids.map((b) => {
    const out = { seat: b.seat, call: b.call };
    const hide = mySeat && side(mySeat) === side(b.seat) && b.seat !== mySeat && room.phase !== "finished";
    if (b.alert && !hide) out.alert = b.alert;
    return out;
  });
  view.contract = room.contract;
  view.turn = room.turn;
  view.trick = room.trick;
  view.trickWinner = room.pendingWinner;
  view.lastTrick = room.lastTrick;
  view.tricks = room.tricks;
  view.result = room.result;
  view.remaining = 13 - room.trickCount;
  view.counts = {};
  for (const s of SEATS) view.counts[s] = room.hands[s].length;

  // Only your own cards, plus the dummy once it has been revealed.
  view.hand = mySeat ? room.hands[mySeat] : [];
  view.dummy = room.dummyShown && room.contract ? { seat: room.contract.dummy, hand: room.hands[room.contract.dummy] } : null;
  if (room.phase === "finished") view.reveal = room.hands; // hand is over, nothing left to hide

  if (room.turn) {
    const actor = controller(room, room.turn);
    if (mySeat && actor === mySeat && !room.proposal) {
      view.yourTurn = true;
      view.actingSeat = room.turn;
      if (room.phase === "bidding") view.legalBids = legalBids(room, room.turn);
      else view.legal = legalCards(room, room.turn);
    }
  }

  if (room.proposal) {
    const p = room.proposal;
    view.proposal = {
      type: p.type, by: p.by, tricks: p.tricks, needs: p.needs, accepted: p.accepted,
      youNeed: !!mySeat && p.needs.includes(mySeat) && !p.accepted.includes(mySeat),
    };
  }
  view.canPropose =
    room.phase === "playing" && !room.proposal && !room.pendingWinner && room.trick.length === 0 &&
    !!mySeat && !!room.contract && mySeat !== room.contract.dummy;
  return view;
}

module.exports = {
  SEATS, AVATARS, BOT_AVATAR, REACTIONS, NAMES,
  next, partner, side, bidRank, isContractBid, rankVal, suitOf, trickWinner,
  createRoom, seatOf, applySettings, resetToLobby, startDeal, dealNext,
  makeBid, makePlay, resolveTrick, propose, respond, withdraw,
  viewFor, controller, legalCards, legalBids, validateBid,
  scoreHand, scoreDuplicate, newRubber, dupVul, purgeRegistry, purgeRoomResults,
};
