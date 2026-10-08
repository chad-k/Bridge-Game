"use strict";
// Plays lots of random hands through the rules engine and checks that
// nothing breaks and that no player's view ever leaks a hidden card.
const assert = require("assert");
const g = require("../game");

const CARD = /^[2-9TJQKA][CDHS]$/;
let contracts = 0, passedOut = 0, doubled = 0;

function checkPrivacy(room) {
  const ids = {};
  for (const s of g.SEATS) ids[s] = "player-" + s + "-xxxxxxxx";
  for (const s of g.SEATS) {
    const v = g.viewFor(room, ids[s]);
    assert.deepStrictEqual(v.hand, room.hands[s], "own hand is shown");
    const allowed = new Set(room.hands[s]);
    if (v.dummy) room.hands[v.dummy.seat].forEach((c) => allowed.add(c));
    room.trick.forEach((t) => allowed.add(t.card));
    if (room.lastTrick) room.lastTrick.cards.forEach((t) => allowed.add(t.card));
    room.bids.forEach((b) => allowed.add(b.call)); // bids like "2C" look like cards
    if (room.phase === "finished") assert.ok(v.reveal, "hands revealed after the hand");
    else assert.strictEqual(v.reveal, undefined, "no hands revealed mid-hand");
    if (!room.dummyShown) assert.strictEqual(v.dummy, null, "dummy hidden before opening lead");
    const { legalBids: _lb, ...scan } = v; // legal bids like "5S" look like cards
    const found = JSON.stringify(scan).match(/"[2-9TJQKA][CDHS]"/g) || [];
    if (room.phase !== "finished") {
      for (const f of found) assert.ok(allowed.has(f.slice(1, -1)), `${s} was shown a hidden card ${f}`);
    }
  }
}

for (let n = 0; n < 300; n++) {
  const room = g.createRoom("TEST", "host");
  g.SEATS.forEach((s) => (room.seats[s] = { playerId: "player-" + s + "-xxxxxxxx", name: s }));
  room.dealer = g.SEATS[n % 4];
  g.dealNext(room);

  // Every hand has 13 unique cards.
  const all = g.SEATS.flatMap((s) => room.hands[s]);
  assert.strictEqual(new Set(all).size, 52);
  g.SEATS.forEach((s) => assert.strictEqual(room.hands[s].length, 13));

  // Random bidding, weighted toward passing so most auctions finish.
  let guard = 0;
  while (room.phase === "bidding" && guard++ < 200) {
    const legal = g.legalBids(room, room.turn);
    assert.ok(legal.includes("P"));
    const call = Math.random() < 0.6 ? "P" : legal[Math.floor(Math.random() * legal.length)];
    const res = g.makeBid(room, room.turn, call);
    assert.ok(res.ok, res.error);
    checkPrivacy(room);
  }
  if (room.phase === "bidding") continue; // a long auction that never settled; fine
  if (room.bids.length === 0) { passedOut++; continue; }
  contracts++;
  if (room.contract.doubled) doubled++;
  assert.strictEqual(room.contract.dummy, g.partner(room.contract.declarer));
  assert.strictEqual(room.turn, g.next(room.contract.declarer));

  // Random legal play to the end.
  while (room.phase === "playing") {
    const seat = room.turn;
    const actor = g.controller(room, seat);
    // Dummy's own player must not be able to play.
    if (seat === room.contract.dummy) assert.ok(g.makePlay(room, seat, room.hands[seat][0]).error);
    const legal = g.legalCards(room, seat);
    const card = legal[Math.floor(Math.random() * legal.length)];
    const res = g.makePlay(room, actor, card);
    assert.ok(res.ok, res.error);
    if (res.trickComplete) {
      assert.ok(g.makePlay(room, actor, "2C").error, "no plays while the trick is pending");
      checkPrivacy(room);
      g.resolveTrick(room);
    }
    checkPrivacy(room);
  }
  assert.strictEqual(room.phase, "finished");
  assert.strictEqual(room.tricks.NS + room.tricks.EW, 13);
  g.SEATS.forEach((s) => assert.strictEqual(room.hands[s].length, 0));
  checkPrivacy(room);
}

// Follow-suit rule
{
  const room = g.createRoom("T2", "h");
  room.phase = "playing";
  room.contract = { level: 1, denom: "NT", declarer: "S", dummy: "N", doubled: "" };
  room.hands = { N: ["2C"], E: ["AH", "3S"], S: ["2D"], W: ["2H"] };
  room.turn = "E";
  room.trick = [{ seat: "W", card: "KS" }];
  assert.ok(g.makePlay(room, "E", "AH").error, "must follow spades");
  assert.ok(g.makePlay(room, "E", "3S").ok);
}

// Trump beats led suit; highest trump wins
{
  const room = g.createRoom("T3", "h");
  room.phase = "playing";
  room.contract = { level: 1, denom: "H", declarer: "S", dummy: "N", doubled: "" };
  room.hands = { N: ["9H"], E: ["2H"], S: ["AS"], W: ["KS"] };
  room.turn = "W";
  room.trick = [];
  assert.ok(g.makePlay(room, "W", "KS").ok);
  assert.ok(g.makePlay(room, "N", "9H").error, "dummy's own player cannot play dummy's card");
  assert.ok(g.makePlay(room, "S", "9H").ok, "declarer plays from dummy");
  assert.ok(g.makePlay(room, "E", "2H").ok);
  assert.ok(g.makePlay(room, "S", "AS").ok);
  assert.strictEqual(room.pendingWinner, "N", "highest trump wins");
}

console.log(`OK: ${contracts} played hands (${doubled} doubled), ${passedOut} passed out, all checks passed.`);
