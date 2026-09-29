
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

const rooms = new Map();

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function rollDice(count) {
  return Array.from({length: count}, () => 1 + Math.floor(Math.random() * 6));
}

function sanitizeName(name) {
  return String(name || "").trim().slice(0, 24) || "Joueur";
}

function roomPublicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    gameOver: room.gameOver,
    winnerId: room.winnerId,
    currentPlayerId: room.currentPlayerId,
    currentBid: room.currentBid,
    round: room.round,
    lastResolution: room.lastResolution,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      diceCount: p.diceCount,
      alive: p.diceCount > 0
    }))
  };
}

function emitState(room) {
  for (const p of room.players) {
    io.to(p.id).emit("state", {
      ...roomPublicState(room),
      myDice: p.dice || []
    });
  }
}

function activePlayers(room) {
  return room.players.filter(p => p.diceCount > 0);
}

function nextAliveId(room, fromId) {
  const active = activePlayers(room);
  if (!active.length) return null;
  const idx = active.findIndex(p => p.id === fromId);
  if (idx === -1) return active[0].id;
  return active[(idx + 1) % active.length].id;
}

function beginRound(room, startingPlayerId) {
  room.round += 1;
  room.currentBid = null;
  room.lastResolution = null;
  for (const p of room.players) {
    p.dice = p.diceCount > 0 ? rollDice(p.diceCount) : [];
  }
  const active = activePlayers(room);
  if (active.length <= 1) {
    room.gameOver = true;
    room.winnerId = active[0]?.id || null;
    room.currentPlayerId = null;
    return;
  }
  room.currentPlayerId = active.some(p => p.id === startingPlayerId)
    ? startingPlayerId
    : active[0].id;
}

function isValidBid(previous, next) {
  if (!next) return false;
  const quantity = Number(next.quantity);
  const value = Number(next.value);
  if (!Number.isInteger(quantity) || quantity < 1) return false;
  if (!Number.isInteger(value) || value < 1 || value > 6) return false;
  if (!previous) return true;

  // V1 simple et lisible :
  // quantité supérieure OU même quantité avec une valeur supérieure.
  if (quantity > previous.quantity) return true;
  if (quantity === previous.quantity && value > previous.value) return true;
  return false;
}

function countBid(room, bid) {
  let count = 0;
  for (const p of activePlayers(room)) {
    for (const die of p.dice) {
      if (bid.value === 1) {
        if (die === 1) count++;
      } else {
        if (die === bid.value || die === 1) count++;
      }
    }
  }
  return count;
}

function findPlayer(room, id) {
  return room.players.find(p => p.id === id);
}

io.on("connection", socket => {
  socket.on("createRoom", ({name}, cb) => {
    const code = makeCode();
    const player = {
      id: socket.id,
      name: sanitizeName(name),
      diceCount: 5,
      dice: []
    };
    const room = {
      code,
      hostId: socket.id,
      players: [player],
      started: false,
      gameOver: false,
      winnerId: null,
      currentPlayerId: null,
      currentBid: null,
      round: 0,
      lastResolution: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb?.({ok: true, code});
    emitState(room);
  });

  socket.on("joinRoom", ({code, name}, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ok:false, error:"Partie introuvable."});
    if (room.started) return cb?.({ok:false, error:"La partie a déjà commencé."});
    if (room.players.length >= 12) return cb?.({ok:false, error:"Partie complète (12 joueurs max)."});
    const player = {
      id: socket.id,
      name: sanitizeName(name),
      diceCount: 5,
      dice: []
    };
    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;
    cb?.({ok:true, code});
    emitState(room);
  });

  socket.on("startGame", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ok:false, error:"Partie introuvable."});
    if (room.hostId !== socket.id) return cb?.({ok:false, error:"Seul l'hôte peut démarrer."});
    if (room.players.length < 2) return cb?.({ok:false, error:"Il faut au moins 2 joueurs."});
    room.started = true;
    room.gameOver = false;
    room.winnerId = null;
    room.round = 0;
    room.players.forEach(p => { p.diceCount = 5; });
    beginRound(room, room.players[0].id);
    emitState(room);
    cb?.({ok:true});
  });

  socket.on("bid", ({quantity, value}, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.gameOver) return cb?.({ok:false, error:"Partie inactive."});
    if (room.currentPlayerId !== socket.id) return cb?.({ok:false, error:"Ce n'est pas ton tour."});

    const next = { quantity: Number(quantity), value: Number(value), playerId: socket.id };
    if (!isValidBid(room.currentBid, next)) {
      return cb?.({ok:false, error:"Enchère invalide : augmente la quantité, ou garde la quantité et augmente la valeur."});
    }

    room.currentBid = next;
    room.currentPlayerId = nextAliveId(room, socket.id);
    room.lastResolution = null;
    emitState(room);
    cb?.({ok:true});
  });

  socket.on("dudo", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.gameOver) return cb?.({ok:false, error:"Partie inactive."});
    if (room.currentPlayerId !== socket.id) return cb?.({ok:false, error:"Ce n'est pas ton tour."});
    if (!room.currentBid) return cb?.({ok:false, error:"Aucune enchère à contester."});

    const challenger = findPlayer(room, socket.id);
    const bidder = findPlayer(room, room.currentBid.playerId);
    const actual = countBid(room, room.currentBid);
    const bidWasTrue = actual >= room.currentBid.quantity;

    const loser = bidWasTrue ? challenger : bidder;
    if (loser && loser.diceCount > 0) loser.diceCount -= 1;

    room.lastResolution = {
      type: "dudo",
      bid: room.currentBid,
      actual,
      bidWasTrue,
      challengerId: challenger?.id || null,
      bidderId: bidder?.id || null,
      loserId: loser?.id || null,
      allDice: room.players.map(p => ({
        id: p.id,
        name: p.name,
        dice: p.dice
      }))
    };

    const stillAlive = activePlayers(room);
    if (stillAlive.length <= 1) {
      room.gameOver = true;
      room.winnerId = stillAlive[0]?.id || null;
      room.currentPlayerId = null;
      emitState(room);
      return cb?.({ok:true});
    }

    // Le perdant commence la manche suivante s'il est encore en jeu.
    const starter = loser?.diceCount > 0 ? loser.id : nextAliveId(room, loser?.id);
    setTimeout(() => {
      const current = rooms.get(room.code);
      if (!current || current.gameOver) return;
      beginRound(current, starter);
      emitState(current);
    }, 4500);

    emitState(room);
    cb?.({ok:true});
  });

  socket.on("restartGame", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return cb?.({ok:false, error:"Seul l'hôte peut relancer."});
    room.started = true;
    room.gameOver = false;
    room.winnerId = null;
    room.round = 0;
    room.players.forEach(p => {
      p.diceCount = 5;
      p.dice = [];
    });
    beginRound(room, room.players[0]?.id);
    emitState(room);
    cb?.({ok:true});
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) room.players.splice(idx, 1);

    if (room.players.length === 0) {
      rooms.delete(code);
      return;
    }

    if (room.hostId === socket.id) room.hostId = room.players[0].id;

    if (room.currentPlayerId === socket.id) {
      room.currentPlayerId = activePlayers(room)[0]?.id || null;
    }

    if (room.currentBid?.playerId === socket.id) {
      room.currentBid = null;
    }

    emitState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`C-Show Perudo lancé sur http://localhost:${PORT}`);
});
