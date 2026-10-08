"use strict";
// Simple bot players. They only look at their own hand, the dummy once it is down,
// and what has been bid and played, the same things a person could see.
const g = require("./game");
const { partner, side, rankVal, suitOf, bidRank, isContractBid } = g;

const RANKS = "23456789TJQKA";
const HCP = { A: 4, K: 3, Q: 2, J: 1 };
const SUIT_ORDER = ["C", "D", "H", "S"]; // low to high, used for tie-breaks
const MAJORS = ["H", "S"];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------- Hand evaluation ----------

function evalHand(hand) {
  const len = { S: 0, H: 0, D: 0, C: 0 };
  let hcp = 0;
  for (const c of hand) {
    len[c[1]]++;
    hcp += HCP[c[0]] || 0;
  }
  let lengthPts = 0;
  for (const s in len) if (len[s] > 4) lengthPts += len[s] - 4;
  const shape = Object.values(len).sort((a, b) => b - a).join("");
  return { len, hcp, pts: hcp + lengthPts, balanced: ["4333", "4432", "5332"].includes(shape) };
}

// High-card points plus credit for short suits when we have a trump fit.
function supportPts(e, trump) {
  let p = e.hcp;
  for (const s of ["S", "H", "D", "C"]) {
    if (s === trump) continue;
    const n = e.len[s];
    p += n === 0 ? 5 : n === 1 ? 3 : n === 2 ? 1 : 0;
  }
  return p;
}

function longest(e, filter) {
  let best = null;
  for (const s of SUIT_ORDER) {
    if (filter && !filter(s)) continue;
    if (!best || e.len[s] >= e.len[best]) best = s; // ties go to the higher suit
  }
  return best;
}

// ---------- Bidding ----------

function lastContractBid(room) {
  for (let i = room.bids.length - 1; i >= 0; i--) if (isContractBid(room.bids[i].call)) return room.bids[i];
  return null;
}

// Lowest level at which this denomination is still a legal bid.
function cheapest(room, denom) {
  const last = lastContractBid(room);
  for (let l = 1; l <= 7; l++) if (!last || bidRank(l + denom) > bidRank(last.call)) return l;
  return 8;
}

function sane(call) {
  if (!call) return null;
  const level = parseInt(call[0], 10);
  const d = call.slice(1);
  if (level >= 5) return call === "6NT" ? call : null;
  if (level === 4 && (d === "C" || d === "D")) return null;
  return call;
}

function openingBid(e) {
  if (e.pts < 13) return null;
  if (e.balanced && e.hcp >= 15 && e.hcp <= 17) return "1NT";
  if (e.balanced && e.hcp >= 25) return "3NT";
  if (e.balanced && e.hcp >= 20) return "2NT";
  const five = longest(e, (s) => e.len[s] >= 5);
  if (five) return "1" + five;
  return e.len.D > e.len.C ? "1D" : "1C";
}

function respondToOpening(room, e, po) {
  const ps = po.call.slice(1);
  const pl = parseInt(po.call[0], 10);
  if (ps === "NT") {
    if (pl >= 3) return null;
    const est = pl === 1 ? 16 : 21;
    const total = e.hcp + est;
    if (total >= 33) return "6NT";
    if (total >= 25) return "3NT";
    if (total >= 23 && pl === 1 && e.balanced) return "2NT";
    const m = longest(e, (s) => MAJORS.includes(s) && e.len[s] >= 6);
    return m && e.hcp >= 7 ? "4" + m : null;
  }
  if (pl >= 2) return null;
  if (MAJORS.includes(ps) && e.len[ps] >= 3) {
    const sp = supportPts(e, ps);
    if (sp >= 13) return "4" + ps;
    if (sp >= 10) return "3" + ps;
    if (sp >= 6) return "2" + ps;
    return null;
  }
  if (e.hcp < 6) return null;
  const cands = ["S", "H", "D", "C"].filter((s) => s !== ps && e.len[s] >= 4);
  cands.sort((a, b) => e.len[b] - e.len[a] || SUIT_ORDER.indexOf(b) - SUIT_ORDER.indexOf(a));
  for (const s of cands) {
    const l = cheapest(room, s);
    if (l === 1) return "1" + s;
    if (l === 2 && e.hcp >= 10) return "2" + s;
  }
  if (e.hcp >= 13) return "3NT";
  if (e.hcp >= 10) return "2NT";
  return "1NT";
}

function rebidAfterPartner(room, seat, e, mine, part) {
  const last = lastContractBid(room);
  if (!part.length || last.seat === seat) return null;
  const pl = part[part.length - 1];
  const ps = pl.call.slice(1);
  const lvl = parseInt(pl.call[0], 10);
  const myFirst = mine[0].call.slice(1);

  if (ps === "NT") {
    const est = myFirst === "NT" ? 9 : lvl === 1 ? 8 : 11;
    const total = e.hcp + est;
    if (total >= 33) return "6NT";
    if (total >= 25) return "3NT";
    return null;
  }
  if (ps === myFirst) {
    // partner raised our suit
    if (!MAJORS.includes(ps)) return null;
    if (e.pts >= 16 || (lvl >= 3 && e.pts >= 13)) return "4" + ps;
    return null;
  }
  if (MAJORS.includes(ps) && e.len[ps] >= 4) {
    const pts = supportPts(e, ps);
    const level = pts >= 19 ? 4 : pts >= 16 ? 3 : 2;
    return Math.max(level, cheapest(room, ps)) + ps;
  }
  if (myFirst !== "NT" && e.len[myFirst] >= 6 && e.pts >= 13) {
    const l = cheapest(room, myFirst);
    if (l <= 2) return l + myFirst;
  }
  if (e.balanced && myFirst !== "NT") {
    if (e.hcp >= 18) return "2NT";
    if (e.hcp <= 15) return "1NT";
  }
  return null;
}

function decideBid(room, seat) {
  const e = evalHand(room.hands[seat]);
  const cb = room.bids.filter((b) => isContractBid(b.call));
  if (!cb.length) return openingBid(e);
  const mine = cb.filter((b) => b.seat === seat);
  const part = cb.filter((b) => b.seat === partner(seat));
  const opps = cb.filter((b) => side(b.seat) !== side(seat));

  if (!opps.length) {
    if (!mine.length) return respondToOpening(room, e, part[0]);
    return rebidAfterPartner(room, seat, e, mine, part);
  }
  if (mine.length) return null; // we do not fight on
  if (part.length) {
    const s = part[part.length - 1].call.slice(1);
    if (MAJORS.includes(s) && e.len[s] >= 3) {
      const sp = supportPts(e, s);
      const l = cheapest(room, s);
      if (sp >= 8 && l <= (sp >= 11 ? 3 : 2)) return l + s;
    }
    return null;
  }
  if (e.hcp >= 10 && e.hcp <= 16) {
    const s = longest(e);
    if (e.len[s] >= 5) {
      const l = cheapest(room, s);
      if (l <= 2) return l + s;
    }
  }
  return null;
}

function chooseBid(room, seat) {
  if (room.settings.bots === "easy") return "P";
  let call = null;
  try {
    call = sane(decideBid(room, seat));
  } catch (err) {
    call = null;
  }
  return call && g.validateBid(room, seat, call) === null ? call : "P";
}

// ---------- Card play ----------

function groupBySuit(hand) {
  const by = {};
  for (const c of hand) (by[c[1]] = by[c[1]] || []).push(c);
  for (const s in by) by[s].sort((a, b) => rankVal(b) - rankVal(a)); // high to low
  return by;
}

function openingLead(hand, trump) {
  const by = groupBySuit(hand);
  let suits = Object.keys(by).filter((s) => s !== trump);
  if (!suits.length) suits = Object.keys(by);
  const strength = (s) => by[s].reduce((a, c) => a + (HCP[c[0]] || 0), 0);
  suits.sort((a, b) => by[b].length - by[a].length || strength(b) - strength(a));
  const cards = by[suits[0]];
  if (cards.length >= 2 && rankVal(cards[0]) >= 9 && rankVal(cards[0]) - rankVal(cards[1]) === 1) return cards[0];
  if (cards.length >= 4) return cards[3]; // fourth best
  if (cards.length === 3) return rankVal(cards[0]) >= 10 ? cards[2] : cards[0];
  return cards[0];
}

function smartCard(room, seat, legal) {
  const c = room.contract;
  const trump = c.denom === "NT" ? null : c.denom;
  const hand = room.hands[seat];
  const mySide = side(seat);
  const declSide = side(c.declarer);
  const played = new Set(room.playedCards);
  const visible = new Set(hand);
  if (room.dummyShown) {
    const other = mySide === declSide ? partner(seat) : c.dummy;
    room.hands[other].forEach((x) => visible.add(x));
  }
  // How many higher cards in this suit might still be held by someone else?
  const outstanding = (card) => {
    let n = 0;
    for (let r = rankVal(card) + 1; r < 13; r++) {
      const x = RANKS[r] + suitOf(card);
      if (!played.has(x) && !visible.has(x)) n++;
    }
    return n;
  };
  const by = groupBySuit(hand);
  const asc = (a, b) => rankVal(a) - rankVal(b);

  // ----- leading -----
  if (room.trick.length === 0) {
    if (room.playedCards.length === 0) return openingLead(hand, trump);
    const sides = Object.keys(by).filter((s) => s !== trump);
    if (mySide === declSide) {
      if (trump && by[trump]) {
        let out = 13;
        for (const x of played) if (suitOf(x) === trump) out--;
        for (const x of visible) if (suitOf(x) === trump) out--;
        if (out > 0) return by[trump][0]; // draw trumps
      }
      let best = null;
      for (const s of sides) if (outstanding(by[s][0]) === 0 && (!best || by[s].length > by[best].length)) best = s;
      if (best) return by[best][0]; // cash a sure winner
      let ls = null;
      for (const s of sides) if (!ls || by[s].length > by[ls].length) ls = s;
      if (ls) return by[ls][by[ls].length - 1];
      return by[trump][by[trump].length - 1];
    }
    let best = null;
    for (const s of sides) if (outstanding(by[s][0]) === 0 && (!best || by[s].length > by[best].length)) best = s;
    if (best) return by[best][0];
    return openingLead(hand, trump);
  }

  // ----- following -----
  const led = suitOf(room.trick[0].card);
  const winSeat = g.trickWinner(room.trick, trump);
  const curCard = room.trick.find((t) => t.seat === winSeat).card;
  const partnerWinning = side(winSeat) === mySide;
  const left = 3 - room.trick.length; // players still to act after me
  const can = hand.filter((x) => suitOf(x) === led).sort(asc);

  if (can.length) {
    if (partnerWinning || suitOf(curCard) !== led) return can[0];
    const beaters = can.filter((x) => rankVal(x) > rankVal(curCard));
    if (!beaters.length) return can[0];
    if (left === 0) return beaters[0]; // win as cheaply as possible
    const sure = beaters.filter((x) => outstanding(x) === 0);
    if (sure.length) return sure[0];
    if (left === 1) return beaters[beaters.length - 1]; // third hand high
    return can[0]; // second hand low
  }

  const myTrumps = trump ? hand.filter((x) => suitOf(x) === trump).sort(asc) : [];
  if (myTrumps.length && !partnerWinning) {
    const curTrump = suitOf(curCard) === trump ? curCard : null;
    const ruff = curTrump ? myTrumps.filter((x) => rankVal(x) > rankVal(curTrump)) : myTrumps;
    if (ruff.length) return ruff[0];
  }
  const pool = hand.filter((x) => suitOf(x) !== trump);
  const src = pool.length ? pool : hand;
  const bySrc = groupBySuit(src);
  let ds = null;
  for (const s in bySrc) if (!ds || bySrc[s].length > bySrc[ds].length) ds = s;
  return bySrc[ds][bySrc[ds].length - 1]; // lowest card from the longest suit
}

function chooseCard(room, seat) {
  const legal = g.legalCards(room, seat);
  if (room.settings.bots === "easy") return pick(legal);
  let card = null;
  try {
    card = smartCard(room, seat, legal);
  } catch (err) {
    card = null;
  }
  return card && legal.includes(card) ? card : legal[0];
}

module.exports = { chooseBid, chooseCard, evalHand, smartCard, decideBid };
