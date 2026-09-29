const test = require("node:test");
const assert = require("node:assert/strict");
const { io: connect } = require("socket.io-client");
const { createGameServer, isValidBid, sanitizeName } = require("../server");

function emit(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Délai dépassé : ${event}`)), 2000);
    socket.emit(event, payload, result => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

function nextState(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("État non reçu")), 2000);
    const onState = state => {
      if (!predicate(state)) return;
      clearTimeout(timeout);
      socket.off("state", onState);
      resolve(state);
    };
    socket.on("state", onState);
  });
}

test("les annonces suivent les règles normales et Perudo", () => {
  assert.equal(isValidBid(null, { quantity: 1, value: 6 }), false);
  assert.equal(isValidBid(null, { quantity: 1, value: 4 }), true);
  assert.equal(isValidBid({ quantity: 6, value: 4 }, { quantity: 3, value: 6 }), false);
  assert.equal(isValidBid({ quantity: 6, value: 4 }, { quantity: 4, value: 6 }), true);
  assert.equal(isValidBid({ quantity: 4, value: 6 }, { quantity: 8, value: 3 }), false);
  assert.equal(isValidBid({ quantity: 4, value: 6 }, { quantity: 9, value: 3 }), true);
  assert.equal(isValidBid({ quantity: 3, value: 4 }, { quantity: 3, value: 5 }), true);
  assert.equal(isValidBid({ quantity: 3, value: 5 }, { quantity: 3, value: 4 }), false);
});

test("les noms sont bornés et nettoyés", () => {
  assert.equal(sanitizeName("  Cyril\u0000  "), "Cyril");
  assert.equal(sanitizeName(""), "Joueur");
  assert.equal(sanitizeName("x".repeat(30)).length, 24);
});

test("deux joueurs jouent, gardent leurs dés privés et se reconnectent", async t => {
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const host = connect(url, { transports: ["websocket"] });
  const guest = connect(url, { transports: ["websocket"] });
  t.after(async () => {
    host.disconnect();
    guest.disconnect();
    await new Promise(resolve => game.io.close(resolve));
  });

  await Promise.all([
    new Promise(resolve => host.once("connect", resolve)),
    new Promise(resolve => guest.once("connect", resolve))
  ]);
  const created = await emit(host, "createRoom", { name: "Hôte" });
  assert.equal(created.ok, true);
  const joined = await emit(guest, "joinRoom", { code: created.code.toLowerCase(), name: "Invité" });
  assert.equal(joined.ok, true);

  const hostStarted = nextState(host, state => state.started);
  const guestStarted = nextState(guest, state => state.started);
  assert.equal((await emit(host, "startGame")).ok, true);
  const [hostState, guestState] = await Promise.all([hostStarted, guestStarted]);
  assert.equal(hostState.players.length, 2);
  assert.equal(hostState.myDice.length, 5);
  assert.equal(guestState.myDice.length, 5);
  assert.equal(hostState.players.some(player => "dice" in player), false);

  const current = hostState.currentPlayerId === created.playerId ? host : guest;
  assert.equal((await emit(current, "bid", { quantity: 1, value: 2 })).ok, true);

  guest.disconnect();
  const resumed = connect(url, { transports: ["websocket"] });
  t.after(() => resumed.disconnect());
  await new Promise(resolve => resumed.once("connect", resolve));
  const resumeState = nextState(resumed);
  const resumeResult = await emit(resumed, "resumeRoom", joined);
  assert.equal(resumeResult.ok, true);
  const state = await resumeState;
  assert.equal(state.myId, joined.playerId);
  assert.equal(state.myDice.length, 5);
});
