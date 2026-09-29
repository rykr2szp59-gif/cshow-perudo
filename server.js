const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const TURN_SECONDS = Number(process.env.TURN_SECONDS) || 20;
const MAX_DICE = 5;
const MAX_PLAYERS = 12;
const PERUDO_VALUE = 6;
const ROOM_TTL_MS = 15 * 60 * 1000;

function createGameServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: process.env.ALLOWED_ORIGIN || true }, maxHttpBufferSize: 20_000 });
  const rooms = new Map();

  app.disable("x-powered-by");
  app.use((_, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  app.get("/health", (_, res) => res.json({ ok: true }));
  app.use(express.static("public"));

  const activePlayers = room => room.players.filter(player => player.diceCount > 0);
  const findPlayer = (room, id) => room.players.find(player => player.id === id);
  const reveal = room => room.players.map(({ id, name, dice }) => ({ id, name, dice }));

  function makeCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;
    do code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join("");
    while (rooms.has(code));
    return code;
  }

  function nextAliveId(room, fromId) {
    const alive = activePlayers(room);
    if (!alive.length) return null;
    const index = alive.findIndex(player => player.id === fromId);
    return index === -1 ? alive[0].id : alive[(index + 1) % alive.length].id;
  }

  function clearTurnTimer(room) {
    if (room.turnTimer) clearInterval(room.turnTimer);
    room.turnTimer = null;
  }

  function publicState(room) {
    return {
      code: room.code, hostId: room.hostId, started: room.started,
      gameOver: room.gameOver, winnerId: room.winnerId,
      currentPlayerId: room.currentPlayerId, currentBid: room.currentBid,
      round: room.round, lastResolution: room.lastResolution,
      turnSecondsLeft: room.turnSecondsLeft, maxDice: MAX_DICE,
      players: room.players.map(({ id, name, diceCount, connected }) => ({
        id, name, diceCount, connected, alive: diceCount > 0
      }))
    };
  }

  function emitState(room) {
    room.updatedAt = Date.now();
    for (const player of room.players) {
      if (!player.socketId) continue;
      io.to(player.socketId).emit("state", { ...publicState(room), myId: player.id, myDice: player.dice || [] });
    }
  }

  function finishIfNeeded(room) {
    const alive = activePlayers(room);
    if (alive.length > 1) return false;
    clearTurnTimer(room);
    room.gameOver = true;
    room.winnerId = alive[0]?.id || null;
    room.currentPlayerId = null;
    room.resolving = false;
    return true;
  }

  function scheduleRound(room, starterId, delay) {
    setTimeout(() => {
      const current = rooms.get(room.code);
      if (!current || current.gameOver || !current.resolving) return;
      beginRound(current, starterId);
      emitState(current);
    }, delay).unref?.();
  }

  function handleTimeout(room) {
    const timedOut = findPlayer(room, room.currentPlayerId);
    if (timedOut?.diceCount > 0) timedOut.diceCount -= 1;
    room.resolving = true;
    room.lastResolution = { type: "timeout", loserId: timedOut?.id || null, allDice: reveal(room) };
    if (finishIfNeeded(room)) return emitState(room);
    const starter = timedOut?.diceCount > 0 ? timedOut.id : nextAliveId(room, timedOut?.id);
    emitState(room);
    scheduleRound(room, starter, 3500);
  }

  function startTurnTimer(room) {
    clearTurnTimer(room);
    room.turnSecondsLeft = TURN_SECONDS;
    room.turnTimer = setInterval(() => {
      room.turnSecondsLeft -= 1;
      if (room.turnSecondsLeft <= 0) {
        clearTurnTimer(room);
        return handleTimeout(room);
      }
      emitState(room);
    }, 1000);
    room.turnTimer.unref?.();
  }

  function beginRound(room, starterId) {
    clearTurnTimer(room);
    room.round += 1;
    room.currentBid = null;
    room.lastResolution = null;
    room.resolving = false;
    for (const player of room.players) {
      player.dice = player.diceCount > 0
        ? Array.from({ length: player.diceCount }, () => crypto.randomInt(1, 7))
        : [];
    }
    if (finishIfNeeded(room)) return;
    const alive = activePlayers(room);
    room.currentPlayerId = alive.some(player => player.id === starterId) ? starterId : alive[0].id;
    startTurnTimer(room);
  }

  function countForBid(room, bid) {
    return activePlayers(room).reduce((total, player) => total + player.dice.reduce(
      (count, die) => count + Number(bid.value === PERUDO_VALUE ? die === PERUDO_VALUE : die === bid.value || die === PERUDO_VALUE), 0
    ), 0);
  }

  function resolveChallenge(room, mode, actorId) {
    if (!room.currentBid) return { ok: false, error: "Aucune annonce à vérifier." };
    if (room.resolving) return { ok: false, error: "La manche est déjà terminée." };
    room.resolving = true;
    clearTurnTimer(room);
    const actor = findPlayer(room, actorId);
    const bidder = findPlayer(room, room.currentBid.playerId);
    const actual = countForBid(room, room.currentBid);
    let loser = null;
    let winner = null;

    if (mode === "lie") {
      const bidWasTrue = actual >= room.currentBid.quantity;
      loser = bidWasTrue ? actor : bidder;
      if (loser?.diceCount > 0) loser.diceCount -= 1;
      room.lastResolution = {
        type: "lie", bid: room.currentBid, actual, bidWasTrue,
        actorId: actor?.id || null, bidderId: bidder?.id || null,
        loserId: loser?.id || null, allDice: reveal(room)
      };
    } else {
      const exact = actual === room.currentBid.quantity;
      if (exact) {
        winner = actor;
        if (winner?.diceCount > 0 && winner.diceCount < MAX_DICE) winner.diceCount += 1;
      } else {
        loser = actor;
        if (loser?.diceCount > 0) loser.diceCount -= 1;
      }
      room.lastResolution = {
        type: "exact", bid: room.currentBid, actual, exact,
        actorId: actor?.id || null, bidderId: bidder?.id || null,
        loserId: loser?.id || null, winnerId: winner?.id || null,
        allDice: reveal(room)
      };
    }

    if (finishIfNeeded(room)) return { ok: true };
    const starter = winner?.diceCount > 0 ? winner.id
      : loser?.diceCount > 0 ? loser.id : nextAliveId(room, loser?.id || actorId);
    scheduleRound(room, starter, 5000);
    return { ok: true };
  }

  const roomFor = socket => rooms.get(socket.data.roomCode);
  const playerFor = (socket, room = roomFor(socket)) => room && findPlayer(room, socket.data.playerId);

  function attachPlayer(socket, room, player) {
    player.socketId = socket.id;
    player.connected = true;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
  }

  function allowed(socket) {
    const now = Date.now();
    const bucket = socket.data.rate || { startedAt: now, count: 0 };
    if (now - bucket.startedAt >= 1000) Object.assign(bucket, { startedAt: now, count: 0 });
    bucket.count += 1;
    socket.data.rate = bucket;
    return bucket.count <= 12;
  }

  io.on("connection", socket => {
    const guarded = handler => (payload = {}, cb) => {
      if (!allowed(socket)) return cb?.({ ok: false, error: "Trop d'actions. Réessaie dans un instant." });
      try { handler(payload || {}, cb); }
      catch (error) {
        console.error("Action refusée", error);
        cb?.({ ok: false, error: "Action impossible." });
      }
    };

    socket.on("createRoom", guarded(({ name }, cb) => {
      if (socket.data.roomCode) return cb?.({ ok: false, error: "Tu es déjà dans une partie." });
      const code = makeCode();
      const player = createPlayer(name);
      const room = {
        code, hostId: player.id, players: [player], started: false,
        gameOver: false, winnerId: null, currentPlayerId: null,
        currentBid: null, round: 0, lastResolution: null,
        turnSecondsLeft: TURN_SECONDS, turnTimer: null,
        resolving: false, updatedAt: Date.now()
      };
      rooms.set(code, room);
      attachPlayer(socket, room, player);
      cb?.({ ok: true, code, playerId: player.id, resumeToken: player.resumeToken });
      emitState(room);
    }));

    socket.on("joinRoom", guarded(({ code, name }, cb) => {
      code = normalizeCode(code);
      const room = rooms.get(code);
      if (!room) return cb?.({ ok: false, error: "Partie introuvable." });
      if (room.started) return cb?.({ ok: false, error: "La partie a déjà commencé." });
      if (room.players.length >= MAX_PLAYERS) return cb?.({ ok: false, error: "Partie complète : 12 joueurs maximum." });
      const player = createPlayer(name);
      room.players.push(player);
      attachPlayer(socket, room, player);
      cb?.({ ok: true, code, playerId: player.id, resumeToken: player.resumeToken });
      emitState(room);
    }));

    socket.on("resumeRoom", guarded(({ code, playerId, resumeToken }, cb) => {
      const room = rooms.get(normalizeCode(code));
      const player = room && findPlayer(room, String(playerId || ""));
      if (!player || !safeTokenEqual(player.resumeToken, resumeToken)) {
        return cb?.({ ok: false, error: "Cette ancienne partie n’est plus disponible." });
      }
      if (player.socketId && player.socketId !== socket.id) io.sockets.sockets.get(player.socketId)?.disconnect(true);
      attachPlayer(socket, room, player);
      cb?.({ ok: true, code: room.code, playerId: player.id, resumeToken: player.resumeToken });
      emitState(room);
    }));

    socket.on("startGame", guarded((_, cb) => {
      const room = roomFor(socket);
      if (!room) return cb?.({ ok: false, error: "Partie introuvable." });
      if (room.hostId !== socket.data.playerId) return cb?.({ ok: false, error: "Seul l'hôte peut démarrer." });
      if (room.players.length < 2) return cb?.({ ok: false, error: "Il faut au moins 2 joueurs." });
      room.started = true;
      room.gameOver = false;
      room.winnerId = null;
      room.round = 0;
      room.players.forEach(player => { player.diceCount = MAX_DICE; player.dice = []; });
      beginRound(room, room.players[0].id);
      emitState(room);
      cb?.({ ok: true });
    }));

    socket.on("bid", guarded(({ quantity, value }, cb) => {
      const room = roomFor(socket);
      if (!room || !room.started || room.gameOver || room.resolving) return cb?.({ ok: false, error: "Partie inactive." });
      if (room.currentPlayerId !== socket.data.playerId) return cb?.({ ok: false, error: "Ce n'est pas ton tour." });
      const next = { quantity: Number(quantity), value: Number(value), playerId: socket.data.playerId };
      const totalDice = activePlayers(room).reduce((sum, player) => sum + player.diceCount, 0);
      if (next.quantity > totalDice || !isValidBid(room.currentBid, next)) {
        return cb?.({ ok: false, error: "Annonce invalide selon les règles de la partie." });
      }
      room.currentBid = next;
      room.currentPlayerId = nextAliveId(room, socket.data.playerId);
      room.lastResolution = null;
      startTurnTimer(room);
      emitState(room);
      cb?.({ ok: true });
    }));

    for (const mode of ["lie", "exact"]) {
      socket.on(mode, guarded((_, cb) => {
        const room = roomFor(socket);
        if (!room || !room.started || room.gameOver) return cb?.({ ok: false, error: "Partie inactive." });
        if (room.currentPlayerId !== socket.data.playerId) return cb?.({ ok: false, error: "Ce n'est pas ton tour." });
        const result = resolveChallenge(room, mode, socket.data.playerId);
        emitState(room);
        cb?.(result);
      }));
    }

    socket.on("restartGame", guarded((_, cb) => {
      const room = roomFor(socket);
      if (!room) return cb?.({ ok: false, error: "Partie introuvable." });
      if (room.hostId !== socket.data.playerId) return cb?.({ ok: false, error: "Seul l'hôte peut relancer." });
      room.started = true;
      room.gameOver = false;
      room.winnerId = null;
      room.round = 0;
      room.players.forEach(player => { player.diceCount = MAX_DICE; player.dice = []; });
      beginRound(room, room.players[0]?.id);
      emitState(room);
      cb?.({ ok: true });
    }));

    socket.on("disconnect", () => {
      const room = roomFor(socket);
      const player = playerFor(socket, room);
      if (!room || !player || player.socketId !== socket.id) return;
      player.socketId = null;
      player.connected = false;
      emitState(room);
    });
  });

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.players.some(player => player.connected) || now - room.updatedAt < ROOM_TTL_MS) continue;
      clearTurnTimer(room);
      rooms.delete(code);
    }
  }, 60_000);
  cleanupTimer.unref?.();

  return { app, server, io, rooms };
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase().slice(0, 4);
}

function sanitizeName(name) {
  return String(name || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 24) || "Joueur";
}

function createPlayer(name) {
  return {
    id: crypto.randomUUID(), resumeToken: crypto.randomBytes(24).toString("base64url"),
    socketId: null, connected: false, name: sanitizeName(name), diceCount: MAX_DICE, dice: []
  };
}

function safeTokenEqual(expected, received) {
  const a = Buffer.from(String(expected || ""));
  const b = Buffer.from(String(received || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isValidBid(previous, next) {
  const quantity = Number(next.quantity);
  const value = Number(next.value);
  if (!Number.isInteger(quantity) || quantity < 1) return false;
  if (!Number.isInteger(value) || value < 1 || value > PERUDO_VALUE) return false;
  if (!previous) return value !== PERUDO_VALUE;
  const previousPerudo = previous.value === PERUDO_VALUE;
  const nextPerudo = value === PERUDO_VALUE;
  if (!previousPerudo && !nextPerudo) {
    return quantity > previous.quantity || (quantity === previous.quantity && value > previous.value);
  }
  if (!previousPerudo && nextPerudo) return quantity >= Math.floor(previous.quantity / 2) + 1;
  if (previousPerudo && nextPerudo) return quantity > previous.quantity;
  return quantity >= previous.quantity * 2 + 1;
}

if (require.main === module) {
  const { server } = createGameServer();
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`C-Show Perudo lancé sur http://localhost:${port}`));
}

module.exports = { createGameServer, isValidBid, sanitizeName, MAX_DICE, PERUDO_VALUE };
