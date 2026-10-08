"use strict";
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const game = require("./game");
const bots = require("./bots");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.send("ok")); // Render uses this to check the app is alive

const rooms = new Map(); // room code -> room (kept in memory, lost on restart)
const TRICK_PAUSE_MS = 1600;
const BOT_DELAY_MS = 800;

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
    if (!rooms.has(code)) return code;
  }
}

const cleanName = (n) => String(n || "").trim().slice(0, 20) || "Player";

// Simple per-person rate limit: at most `limit` actions of this kind per `ms` milliseconds.
function allow(member, key, limit, ms) {
  const now = Date.now();
  member.rl = member.rl || {};
  const list = (member.rl[key] || []).filter((t) => now - t < ms);
  if (list.length >= limit) {
    member.rl[key] = list;
    return false;
  }
  list.push(now);
  member.rl[key] = list;
  return true;
}

// ---------- Sending state ----------

function broadcast(room) {
  room.updated = Date.now();
  for (const [playerId, m] of room.members) {
    if (m.socketId) io.to(m.socketId).emit("state", game.viewFor(room, playerId));
  }
}

function afterChange(room) {
  broadcast(room);
  scheduleBot(room);
}

function isBot(room, seat) {
  return !!(room.seats[seat] && room.seats[seat].bot);
}

function scheduleBot(room) {
  clearTimeout(room.botTimer);
  if (room.proposal || !room.turn || (room.phase !== "bidding" && room.phase !== "playing")) return;
  const seat = room.turn;
  const actor = game.controller(room, seat);
  if (!isBot(room, actor)) return;

  room.botTimer = setTimeout(() => {
    if (room.turn !== seat || room.proposal || !isBot(room, actor)) return;
    if (room.phase === "bidding") {
      game.makeBid(room, seat, bots.chooseBid(room, seat));
    } else {
      const res = game.makePlay(room, actor, bots.chooseCard(room, seat));
      if (res.trickComplete) return completeTrick(room);
    }
    afterChange(room);
  }, BOT_DELAY_MS);
}

function completeTrick(room) {
  broadcast(room); // everyone sees the fourth card
  setTimeout(() => {
    game.resolveTrick(room);
    afterChange(room);
  }, TRICK_PAUSE_MS);
}

// Bots agree to any claim or concession put to them.
function botRespond(room) {
  const p = room.proposal;
  if (!p) return;
  for (const s of p.needs) {
    if (isBot(room, s) && room.proposal) game.respond(room, s, true);
  }
}

// ---------- Socket handling ----------

io.use((socket, next) => {
  const id = socket.handshake.auth && socket.handshake.auth.playerId;
  if (typeof id !== "string" || id.length < 8 || id.length > 64) return next(new Error("Missing player id"));
  socket.data.playerId = id;
  next();
});

io.on("connection", (socket) => {
  const playerId = socket.data.playerId;

  const ctx = () => {
    const room = rooms.get(socket.data.code);
    if (!room || !room.members.has(playerId)) return {};
    return { room, seat: game.seatOf(room, playerId), member: room.members.get(playerId) };
  };
  const hostOnly = (ack) => {
    const c = ctx();
    if (!c.room || c.room.host !== playerId) {
      ack({ error: "Only the host can do that" });
      return null;
    }
    return c.room;
  };

  const enter = (room, name, avatar, ack) => {
    if (room.banned.has(playerId)) return ack({ error: "The host removed you from this table." });
    const existing = room.members.get(playerId);
    const pick = game.AVATARS.includes(avatar) ? avatar : existing ? existing.avatar : game.AVATARS[0];
    room.members.set(playerId, {
      mid: existing ? existing.mid : crypto.randomBytes(4).toString("hex"),
      name: existing ? existing.name : name,
      avatar: pick,
      socketId: socket.id,
      rl: existing ? existing.rl : {},
    });
    // If they are already seated, keep the seat's display details in sync.
    const seat = game.seatOf(room, playerId);
    if (seat) Object.assign(room.seats[seat], { name: room.members.get(playerId).name, avatar: pick });
    socket.data.code = room.code;
    socket.join(room.code);
    ack({ ok: true, code: room.code });
    afterChange(room);
  };

  socket.on("createRoom", ({ name, avatar } = {}, ack = () => {}) => {
    const room = game.createRoom(makeCode(), playerId);
    rooms.set(room.code, room);
    enter(room, cleanName(name), avatar, ack);
  });

  socket.on("joinRoom", ({ code, name, avatar } = {}, ack = () => {}) => {
    const room = rooms.get(String(code || "").trim().toUpperCase());
    if (!room) return ack({ error: "No table with that code. It may have expired." });
    enter(room, cleanName(name), avatar, ack);
  });

  // ----- seats -----

  socket.on("sit", ({ seat } = {}, ack = () => {}) => {
    const { room, seat: mine, member } = ctx();
    if (!room) return ack({ error: "Join a table first" });
    if (!game.SEATS.includes(seat)) return ack({ error: "That seat does not exist" });
    const target = room.seats[seat];
    const takingBot = target && target.bot;
    if (target && !takingBot) return ack({ error: "That seat is taken" });
    if (room.phase !== "lobby" && (!takingBot || mine)) return ack({ error: "The game has already started" });
    if (mine) room.seats[mine] = null;
    room.seats[seat] = { playerId, name: member.name, avatar: member.avatar };
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("stand", (_d, ack = () => {}) => {
    const { room, seat } = ctx();
    if (!room || room.phase !== "lobby" || !seat) return ack({ error: "You can only leave a seat before the deal" });
    room.seats[seat] = null;
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("addBot", ({ seat } = {}, ack = () => {}) => {
    const room = hostOnly(ack);
    if (!room) return;
    if (room.phase !== "lobby") return ack({ error: "Bots can only be added before the deal" });
    if (!game.SEATS.includes(seat) || room.seats[seat]) return ack({ error: "That seat is taken" });
    room.seats[seat] = { bot: true, name: "Bot" };
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("removeBot", ({ seat } = {}, ack = () => {}) => {
    const room = hostOnly(ack);
    if (!room) return;
    if (room.phase !== "lobby" || !isBot(room, seat)) return ack({ error: "Nothing to remove" });
    room.seats[seat] = null;
    ack({ ok: true });
    afterChange(room);
  });

  // If a friend's connection is gone for good, the host can let a bot finish their seat.
  socket.on("replaceWithBot", ({ seat } = {}, ack = () => {}) => {
    const room = hostOnly(ack);
    if (!room) return;
    const s = room.seats[seat];
    const m = s && !s.bot && room.members.get(s.playerId);
    if (!s || s.bot || (m && m.socketId)) return ack({ error: "That player is still connected" });
    room.seats[seat] = { bot: true, name: "Bot" };
    ack({ ok: true });
    afterChange(room);
  });

  // ----- table settings and dealing -----

  socket.on("setSettings", (patch = {}, ack = () => {}) => {
    const room = hostOnly(ack);
    if (!room) return;
    const res = game.applySettings(room, patch);
    ack(res);
    if (res.ok) afterChange(room);
  });

  socket.on("toLobby", (_d, ack = () => {}) => {
    const room = hostOnly(ack);
    if (!room) return;
    if (room.phase !== "finished") return ack({ error: "Finish the current hand first" });
    game.resetToLobby(room);
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("deal", (_d, ack = () => {}) => {
    const room = hostOnly(ack);
    if (!room) return;
    if (room.phase !== "lobby" && room.phase !== "finished") return ack({ error: "A hand is in progress" });
    if (!game.SEATS.every((s) => room.seats[s])) return ack({ error: "All four seats need a player or a bot" });
    game.dealNext(room);
    ack({ ok: true });
    afterChange(room);
  });

  // ----- playing -----

  socket.on("bid", ({ call, alert } = {}, ack = () => {}) => {
    const { room, seat } = ctx();
    if (!room || !seat) return ack({ error: "You are not seated" });
    const res = game.makeBid(room, seat, String(call), alert);
    if (res.error) return ack(res);
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("play", ({ card } = {}, ack = () => {}) => {
    const { room, seat } = ctx();
    if (!room || !seat) return ack({ error: "You are not seated" });
    const res = game.makePlay(room, seat, String(card));
    if (res.error) return ack(res);
    ack({ ok: true });
    if (res.trickComplete) completeTrick(room);
    else afterChange(room);
  });

  const propose = (type) => ({ tricks } = {}, ack = () => {}) => {
    const { room, seat } = ctx();
    if (!room || !seat) return ack({ error: "You are not seated" });
    const res = game.propose(room, seat, type, tricks);
    if (res.error) return ack(res);
    if (!res.settled) botRespond(room);
    ack({ ok: true });
    afterChange(room);
  };
  socket.on("claim", propose("claim"));
  socket.on("concede", propose("concede"));

  socket.on("respond", ({ accept } = {}, ack = () => {}) => {
    const { room, seat } = ctx();
    if (!room || !seat) return ack({ error: "You are not seated" });
    const res = game.respond(room, seat, !!accept);
    if (res.error) return ack(res);
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("withdraw", (_d, ack = () => {}) => {
    const { room, seat } = ctx();
    if (!room || !seat) return ack({ error: "You are not seated" });
    const res = game.withdraw(room, seat);
    if (res.error) return ack(res);
    ack({ ok: true });
    afterChange(room);
  });

  // ----- talking -----

  socket.on("chat", ({ text } = {}, ack = () => {}) => {
    const { room, member } = ctx();
    if (!room) return ack({ error: "Join a table first" });
    const msg = String(text || "").trim().slice(0, 200);
    if (!msg) return ack({ ok: true });
    if (!allow(member, "chat", 5, 8000)) return ack({ error: "Slow down a little" });
    room.chat.push({ name: member.name, avatar: member.avatar, text: msg, t: Date.now() });
    if (room.chat.length > 50) room.chat.shift();
    ack({ ok: true });
    broadcast(room);
  });

  socket.on("react", ({ emoji } = {}, ack = () => {}) => {
    const { room, seat, member } = ctx();
    if (!room || !game.REACTIONS.includes(emoji)) return ack({ error: "Pick one of the reactions shown" });
    if (!allow(member, "react", 3, 3000)) return ack({ error: "Slow down a little" });
    ack({ ok: true });
    for (const m of room.members.values()) {
      if (m.socketId) io.to(m.socketId).emit("reaction", { seat, name: member.name, emoji });
    }
  });

  socket.on("setAvatar", ({ avatar } = {}, ack = () => {}) => {
    const { room, seat, member } = ctx();
    if (!room || !game.AVATARS.includes(avatar)) return ack({ error: "Pick one of the avatars shown" });
    member.avatar = avatar;
    if (seat) room.seats[seat].avatar = avatar;
    ack({ ok: true });
    broadcast(room);
  });

  socket.on("getHistory", (_d, ack = () => {}) => {
    const { room } = ctx();
    if (!room) return ack({ error: "Join a table first" });
    ack({ ok: true, history: room.history }); // only finished hands are ever stored here
  });

  // ----- hosting -----

  const memberByMid = (room, mid) => {
    for (const [pid, m] of room.members) if (m.mid === mid) return { pid, m };
    return null;
  };

  socket.on("setHost", ({ mid } = {}, ack = () => {}) => {
    const room = hostOnly(ack);
    if (!room) return;
    const t = memberByMid(room, mid);
    if (!t) return ack({ error: "That person is not at the table" });
    room.host = t.pid;
    ack({ ok: true });
    afterChange(room);
  });

  // Anyone can take over as host if the current host has dropped off.
  socket.on("takeHost", (_d, ack = () => {}) => {
    const { room } = ctx();
    if (!room) return ack({ error: "Join a table first" });
    const h = room.members.get(room.host);
    if (h && h.socketId) return ack({ error: "The host is still here" });
    room.host = playerId;
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("kick", ({ mid } = {}, ack = () => {}) => {
    const room = hostOnly(ack);
    if (!room) return;
    const t = memberByMid(room, mid);
    if (!t || t.pid === playerId) return ack({ error: "You cannot remove that person" });
    const seat = game.seatOf(room, t.pid);
    if (seat) room.seats[seat] = room.phase === "lobby" ? null : { bot: true, name: "Bot" };
    if (t.m.socketId) io.to(t.m.socketId).emit("kicked");
    room.members.delete(t.pid);
    room.banned.add(t.pid);
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("leave", (_d, ack = () => {}) => {
    const { room, seat, member } = ctx();
    if (!room) return ack({ ok: true });
    if (room.phase === "lobby" && seat) room.seats[seat] = null;
    member.socketId = null;
    if (room.host === playerId) {
      // Hand the table to someone who is still here, seated players first.
      const online = [...room.members].filter(([, m]) => m.socketId);
      online.sort(([a], [b]) => (game.seatOf(room, b) ? 1 : 0) - (game.seatOf(room, a) ? 1 : 0));
      if (online.length) room.host = online[0][0];
    }
    socket.leave(room.code);
    socket.data.code = null;
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const m = room.members.get(playerId);
    if (m && m.socketId === socket.id) {
      m.socketId = null; // keep the seat so they can come back
      afterChange(room);
    }
  });
});

// Tidy up tables nobody has touched for 12 hours.
setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.updated < cutoff) {
      clearTimeout(room.botTimer);
      game.purgeRoomResults(code);
      rooms.delete(code);
    }
  }
  game.purgeRegistry(12 * 60 * 60 * 1000);
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bridge server running on port ${PORT}`));
