"use strict";
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const game = require("./game");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.send("ok")); // Render uses this to check the app is alive

const rooms = new Map(); // room code -> room (kept in memory, lost on restart)
const TRICK_PAUSE_MS = 1600;
const BOT_DELAY_MS = 900;

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
    if (!rooms.has(code)) return code;
  }
}

const cleanName = (n) => String(n || "").trim().slice(0, 20) || "Player";

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

function scheduleBot(room) {
  clearTimeout(room.botTimer);
  if (!room.turn || (room.phase !== "bidding" && room.phase !== "playing")) return;
  const seat = room.turn;
  const actor = game.controller(room, seat);
  if (!room.seats[actor] || !room.seats[actor].bot) return;

  room.botTimer = setTimeout(() => {
    if (room.turn !== seat) return;
    if (room.phase === "bidding") {
      game.makeBid(room, seat, "P"); // bots always pass for now
    } else {
      const legal = game.legalCards(room, seat);
      const result = game.makePlay(room, actor, legal[Math.floor(Math.random() * legal.length)]);
      if (result.trickComplete) return completeTrick(room);
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
    return room ? { room, seat: game.seatOf(room, playerId) } : {};
  };

  const enter = (room, name, avatar, ack) => {
    const existing = room.members.get(playerId);
    const pick = game.AVATARS.includes(avatar) ? avatar : existing ? existing.avatar : game.AVATARS[0];
    room.members.set(playerId, { name: existing ? existing.name : name, avatar: pick, socketId: socket.id });
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

  socket.on("sit", ({ seat } = {}, ack = () => {}) => {
    const { room, seat: mine } = ctx();
    if (!room) return ack({ error: "Join a table first" });
    if (room.phase !== "lobby") return ack({ error: "The game has already started" });
    if (!game.SEATS.includes(seat) || room.seats[seat]) return ack({ error: "That seat is taken" });
    if (mine) room.seats[mine] = null;
    const me = room.members.get(playerId);
    room.seats[seat] = { playerId, name: me.name, avatar: me.avatar };
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("setAvatar", ({ avatar } = {}, ack = () => {}) => {
    const { room, seat } = ctx();
    if (!room || !game.AVATARS.includes(avatar)) return ack({ error: "Pick one of the avatars shown" });
    room.members.get(playerId).avatar = avatar;
    if (seat) room.seats[seat].avatar = avatar;
    ack({ ok: true });
    broadcast(room);
  });

  socket.on("stand", (_d, ack = () => {}) => {
    const { room, seat } = ctx();
    if (!room || room.phase !== "lobby" || !seat) return ack({ error: "You can only leave a seat before the deal" });
    room.seats[seat] = null;
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("addBot", ({ seat } = {}, ack = () => {}) => {
    const { room } = ctx();
    if (!room || room.host !== playerId) return ack({ error: "Only the host can add bots" });
    if (room.phase !== "lobby") return ack({ error: "Bots can only be added before the deal" });
    if (!game.SEATS.includes(seat) || room.seats[seat]) return ack({ error: "That seat is taken" });
    room.seats[seat] = { bot: true, name: "Bot" };
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("removeBot", ({ seat } = {}, ack = () => {}) => {
    const { room } = ctx();
    if (!room || room.host !== playerId) return ack({ error: "Only the host can remove bots" });
    if (room.phase !== "lobby" || !room.seats[seat] || !room.seats[seat].bot) return ack({ error: "Nothing to remove" });
    room.seats[seat] = null;
    ack({ ok: true });
    afterChange(room);
  });

  // If a friend's connection is gone for good, the host can let a bot finish their seat.
  socket.on("replaceWithBot", ({ seat } = {}, ack = () => {}) => {
    const { room } = ctx();
    if (!room || room.host !== playerId) return ack({ error: "Only the host can do that" });
    const s = room.seats[seat];
    const m = s && !s.bot && room.members.get(s.playerId);
    if (!s || s.bot || (m && m.socketId)) return ack({ error: "That player is still connected" });
    room.seats[seat] = { bot: true, name: "Bot" };
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("deal", (_d, ack = () => {}) => {
    const { room } = ctx();
    if (!room || room.host !== playerId) return ack({ error: "Only the host can deal" });
    if (room.phase !== "lobby" && room.phase !== "finished") return ack({ error: "A hand is in progress" });
    if (!game.SEATS.every((s) => room.seats[s])) return ack({ error: "All four seats need a player or a bot" });
    game.dealNext(room);
    ack({ ok: true });
    afterChange(room);
  });

  socket.on("bid", ({ call } = {}, ack = () => {}) => {
    const { room, seat } = ctx();
    if (!room || !seat) return ack({ error: "You are not seated" });
    const res = game.makeBid(room, seat, String(call));
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

  socket.on("leave", (_d, ack = () => {}) => {
    const { room, seat } = ctx();
    if (!room) return ack({ ok: true });
    if (room.phase === "lobby" && seat) room.seats[seat] = null;
    const m = room.members.get(playerId);
    if (m) m.socketId = null;
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
  for (const [code, room] of rooms) if (room.updated < cutoff) rooms.delete(code);
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bridge server running on port ${PORT}`));
