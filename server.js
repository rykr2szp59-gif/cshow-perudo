
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

const rooms = new Map();
const TURN_SECONDS = 20;
const MAX_DICE = 5;
const PERUDO_VALUE = 6; // Le 6 est remplacé visuellement par le Toucan / Perudo.

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name) {
  return String(name || "").trim().slice(0, 24) || "Joueur";
}

function rollDice(count) {
  return Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 6));
}

function activePlayers(room) {
  return room.players.filter(p => p.diceCount > 0);
}

function findPlayer(room, id) {
  return room.players.find(p => p.id === id);
}

function nextAliveId(room, fromId) {
  const active = activePlayers(room);
  if (!active.length) return null;
  const i = active.findIndex(p => p.id === fromId);
  if (i === -1) return active[0].id;
  return active[(i + 1) % active.length].id;
}

function clearTurnTimer(room) {
  if (room.turnTimer) clearInterval(room.turnTimer);
  room.turnTimer = null;
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  room.turnSecondsLeft = TURN_SECONDS;

  room.turnTimer = setInterval(() => {
    room.turnSecondsLeft -= 1;

    if (room.turnSecondsLeft <= 0) {
      clearTurnTimer(room);

      const timedOut = findPlayer(room, room.currentPlayerId);
      if (timedOut && timedOut.diceCount > 0) {
        timedOut.diceCount -= 1;
      }

      room.lastResolution = {
        type: "timeout",
        loserId: timedOut?.id || null,
        allDice: room.players.map(p => ({
          id: p.id,
          name: p.name,
          dice: p.dice
        }))
      };

      const alive = activePlayers(room);
      if (alive.length <= 1) {
        room.gameOver = true;
        room.winnerId = alive[0]?.id || null;
        room.currentPlayerId = null;
        emitState(room);
        return;
      }

      const starter = timedOut?.diceCount > 0
        ? timedOut.id
        : nextAliveId(room, timedOut?.id);

      emitState(room);

      setTimeout(() => {
        const current = rooms.get(room.code);
        if (!current || current.gameOver) return;
        beginRound(current, starter);
        emitState(current);
      }, 3500);

      return;
    }

    emitState(room);
  }, 1000);
}

function publicState(room) {
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
    turnSecondsLeft: room.turnSecondsLeft,
    maxDice: MAX_DICE,
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
      ...publicState(room),
      myDice: p.dice || []
    });
  }
}

function beginRound(room, starterId) {
  clearTurnTimer(room);
  room.round += 1;
  room.currentBid = null;
  room.lastResolution = null;

  for (const p of room.players) {
    p.dice = p.diceCount > 0 ? rollDice(p.diceCount) : [];
  }

  const alive = activePlayers(room);

  if (alive.length <= 1) {
    room.gameOver = true;
    room.winnerId = alive[0]?.id || null;
    room.currentPlayerId = null;
    return;
  }

  room.currentPlayerId = alive.some(p => p.id === starterId)
    ? starterId
    : alive[0].id;

  startTurnTimer(room);
}

function normalBidIsHigher(prev, next) {
  return next.quantity > prev.quantity ||
    (next.quantity === prev.quantity && next.value > prev.value);
}

function isValidBid(previous, next) {
  const quantity = Number(next.quantity);
  const value = Number(next.value);

  if (!Number.isInteger(quantity) || quantity < 1) return false;
  if (!Number.isInteger(value) || value < 1 || value > 6) return false;

  // Première annonce : forcément une valeur normale, pas directement Perudo.
  if (!previous) {
    return value !== PERUDO_VALUE;
  }

  const prevIsPerudo = previous.value === PERUDO_VALUE;
  const nextIsPerudo = value === PERUDO_VALUE;

  // Normal -> normal : quantité plus haute, ou même quantité avec valeur plus haute.
  if (!prevIsPerudo && !nextIsPerudo) {
    return normalBidIsHigher(previous, next);
  }

  // Normal -> Perudo :
  // règle de Cyril : moitié + 1 (division entière).
  // Ex : 6 dés de 4 -> 4 Perudo.
  if (!prevIsPerudo && nextIsPerudo) {
    const minPerudo = Math.floor(previous.quantity / 2) + 1;
    return quantity >= minPerudo;
  }

  // Perudo -> Perudo : on augmente uniquement la quantité.
  if (prevIsPerudo && nextIsPerudo) {
    return quantity > previous.quantity;
  }

  // Perudo -> normal :
  // règle standard retenue pour compléter la mécanique :
  // il faut au moins doubler le nombre de Perudo + 1.
  // Ex : 4 Perudo -> au moins 9 dés d'une valeur normale.
  if (prevIsPerudo && !nextIsPerudo) {
    const minNormal = previous.quantity * 2 + 1;
    return quantity >= minNormal;
  }

  return false;
}

function countForBid(room, bid) {
  let count = 0;

  for (const p of activePlayers(room)) {
    for (const die of p.dice) {
      if (bid.value === PERUDO_VALUE) {
        // Une annonce Perudo ne compte que les Perudo.
        if (die === PERUDO_VALUE) count += 1;
      } else {
        // Un Perudo est joker pour n'importe quel chiffre normal.
        if (die === bid.value || die === PERUDO_VALUE) count += 1;
      }
    }
  }

  return count;
}

function resolveChallenge(room, mode, actorId) {
  if (!room.currentBid) return { ok: false, error: "Aucune annonce à vérifier." };

  const actor = findPlayer(room, actorId);
  const bidder = findPlayer(room, room.currentBid.playerId);
  const actual = countForBid(room, room.currentBid);

  let loser = null;
  let winner = null;

  if (mode === "lie") {
    const bidWasTrue = actual >= room.currentBid.quantity;
    loser = bidWasTrue ? actor : bidder;

    if (loser && loser.diceCount > 0) loser.diceCount -= 1;

    room.lastResolution = {
      type: "lie",
      bid: room.currentBid,
      actual,
      bidWasTrue,
      actorId: actor?.id || null,
      bidderId: bidder?.id || null,
      loserId: loser?.id || null,
      allDice: room.players.map(p => ({ id:p.id, name:p.name, dice:p.dice }))
    };
  }

  if (mode === "exact") {
    const exact = actual === room.currentBid.quantity;

    if (exact) {
      winner = actor;
      if (winner && winner.diceCount > 0 && winner.diceCount < MAX_DICE) {
        winner.diceCount += 1;
      }
    } else {
      loser = actor;
      if (loser && loser.diceCount > 0) loser.diceCount -= 1;
    }

    room.lastResolution = {
      type: "exact",
      bid: room.currentBid,
      actual,
      exact,
      actorId: actor?.id || null,
      bidderId: bidder?.id || null,
      loserId: loser?.id || null,
      winnerId: winner?.id || null,
      allDice: room.players.map(p => ({ id:p.id, name:p.name, dice:p.dice }))
    };
  }

  clearTurnTimer(room);

  const alive = activePlayers(room);
  if (alive.length <= 1) {
    room.gameOver = true;
    room.winnerId = alive[0]?.id || null;
    room.currentPlayerId = null;
    return { ok: true };
  }

  let starter;
  if (mode === "exact" && winner && winner.diceCount > 0) {
    starter = winner.id;
  } else if (loser && loser.diceCount > 0) {
    starter = loser.id;
  } else {
    starter = nextAliveId(room, loser?.id || actorId);
  }

  setTimeout(() => {
    const current = rooms.get(room.code);
    if (!current || current.gameOver) return;
    beginRound(current, starter);
    emitState(current);
  }, 5000);

  return { ok: true };
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name }, cb) => {
    const code = makeCode();
    const player = {
      id: socket.id,
      name: sanitizeName(name),
      diceCount: MAX_DICE,
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
      lastResolution: null,
      turnSecondsLeft: TURN_SECONDS,
      turnTimer: null
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb?.({ ok: true, code });
    emitState(room);
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return cb?.({ ok:false, error:"Partie introuvable." });
    if (room.started) return cb?.({ ok:false, error:"La partie a déjà commencé." });
    if (room.players.length >= 12) {
      return cb?.({ ok:false, error:"Partie complète : 12 joueurs maximum." });
    }

    const player = {
      id: socket.id,
      name: sanitizeName(name),
      diceCount: MAX_DICE,
      dice: []
    };

    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;

    cb?.({ ok:true, code });
    emitState(room);
  });

  socket.on("startGame", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok:false, error:"Partie introuvable." });
    if (room.hostId !== socket.id) {
      return cb?.({ ok:false, error:"Seul l'hôte peut démarrer." });
    }
    if (room.players.length < 2) {
      return cb?.({ ok:false, error:"Il faut au moins 2 joueurs." });
    }

    room.started = true;
    room.gameOver = false;
    room.winnerId = null;
    room.round = 0;

    room.players.forEach(p => {
      p.diceCount = MAX_DICE;
      p.dice = [];
    });

    beginRound(room, room.players[0].id);
    emitState(room);
    cb?.({ ok:true });
  });

  socket.on("bid", ({ quantity, value }, cb) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started || room.gameOver) {
      return cb?.({ ok:false, error:"Partie inactive." });
    }
    if (room.currentPlayerId !== socket.id) {
      return cb?.({ ok:false, error:"Ce n'est pas ton tour." });
    }

    const next = {
      quantity: Number(quantity),
      value: Number(value),
      playerId: socket.id
    };

    if (!isValidBid(room.currentBid, next)) {
      return cb?.({
        ok:false,
        error:"Annonce invalide selon les règles de la partie."
      });
    }

    room.currentBid = next;
    room.currentPlayerId = nextAliveId(room, socket.id);
    room.lastResolution = null;
    startTurnTimer(room);
    emitState(room);
    cb?.({ ok:true });
  });

  socket.on("lie", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.gameOver) {
      return cb?.({ ok:false, error:"Partie inactive." });
    }
    if (room.currentPlayerId !== socket.id) {
      return cb?.({ ok:false, error:"Ce n'est pas ton tour." });
    }
    if (!room.currentBid) {
      return cb?.({ ok:false, error:"Aucune annonce à contester." });
    }

    const result = resolveChallenge(room, "lie", socket.id);
    emitState(room);
    cb?.(result);
  });

  socket.on("exact", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.gameOver) {
      return cb?.({ ok:false, error:"Partie inactive." });
    }
    if (room.currentPlayerId !== socket.id) {
      return cb?.({ ok:false, error:"Ce n'est pas ton tour." });
    }
    if (!room.currentBid) {
      return cb?.({ ok:false, error:"Aucune annonce à vérifier." });
    }

    const result = resolveChallenge(room, "exact", socket.id);
    emitState(room);
    cb?.(result);
  });

  socket.on("restartGame", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok:false, error:"Partie introuvable." });
    if (room.hostId !== socket.id) {
      return cb?.({ ok:false, error:"Seul l'hôte peut relancer." });
    }

    room.started = true;
    room.gameOver = false;
    room.winnerId = null;
    room.round = 0;

    room.players.forEach(p => {
      p.diceCount = MAX_DICE;
      p.dice = [];
    });

    beginRound(room, room.players[0]?.id);
    emitState(room);
    cb?.({ ok:true });
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (!room.players.length) {
      clearTurnTimer(room);
      rooms.delete(code);
      return;
    }

    if (room.hostId === socket.id) room.hostId = room.players[0].id;

    if (room.currentPlayerId === socket.id) {
      room.currentPlayerId = activePlayers(room)[0]?.id || null;
      if (room.currentPlayerId) startTurnTimer(room);
    }

    if (room.currentBid?.playerId === socket.id) {
      room.currentBid = null;
    }

    emitState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`C-Show Perudo V2 lancé sur http://localhost:${PORT}`);
});
