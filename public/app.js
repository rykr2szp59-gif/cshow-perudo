
const socket = io();

const $ = id => document.getElementById(id);
let state = null;
let myId = null;

socket.on("connect", () => { myId = socket.id; });

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function diceSymbol(n) {
  return ["","⚀","⚁","⚂","⚃","⚄","⚅"][n] || "?";
}

function playerName(id) {
  return state?.players?.find(p => p.id === id)?.name || "Joueur";
}

$("create").onclick = () => {
  $("welcomeError").textContent = "";
  socket.emit("createRoom", {name: $("name").value}, res => {
    if (!res?.ok) $("welcomeError").textContent = res?.error || "Erreur.";
  });
};

$("join").onclick = () => {
  $("welcomeError").textContent = "";
  socket.emit("joinRoom", {name: $("name").value, code: $("code").value}, res => {
    if (!res?.ok) $("welcomeError").textContent = res?.error || "Erreur.";
  });
};

$("start").onclick = () => {
  $("lobbyError").textContent = "";
  socket.emit("startGame", {}, res => {
    if (!res?.ok) $("lobbyError").textContent = res?.error || "Erreur.";
  });
};

$("bid").onclick = () => {
  $("gameError").textContent = "";
  socket.emit("bid", {
    quantity: Number($("quantity").value),
    value: Number($("value").value)
  }, res => {
    if (!res?.ok) $("gameError").textContent = res?.error || "Erreur.";
  });
};

$("dudo").onclick = () => {
  $("gameError").textContent = "";
  socket.emit("dudo", {}, res => {
    if (!res?.ok) $("gameError").textContent = res?.error || "Erreur.";
  });
};

$("restart").onclick = () => {
  socket.emit("restartGame", {}, res => {
    if (!res?.ok) $("gameError").textContent = res?.error || "Erreur.";
  });
};

socket.on("state", s => {
  state = s;
  render();
});

function render() {
  if (!state) return;

  $("welcome").classList.add("hidden");

  if (!state.started) {
    $("lobby").classList.remove("hidden");
    $("game").classList.add("hidden");
    $("roomCode").textContent = state.code;
    $("hostBadge").classList.toggle("hidden", state.hostId !== myId);
    $("start").classList.toggle("hidden", state.hostId !== myId);
    $("lobbyPlayers").innerHTML = state.players.map(p =>
      `<div class="player"><strong>${esc(p.name)}</strong><span>${p.id === state.hostId ? "Hôte" : ""}</span></div>`
    ).join("");
    return;
  }

  $("lobby").classList.add("hidden");
  $("game").classList.remove("hidden");

  $("gameCode").textContent = state.code;
  $("round").textContent = state.round;

  const mine = state.currentPlayerId === myId;
  const current = state.players.find(p => p.id === state.currentPlayerId);
  $("turnBanner").textContent = state.gameOver
    ? `🏆 ${playerName(state.winnerId)} gagne la partie !`
    : mine ? "À TOI DE JOUER" : `Tour de ${current?.name || "…"}`;
  $("turnBanner").classList.toggle("mine", mine && !state.gameOver);

  $("myDice").innerHTML = (state.myDice || []).map(d => `<div class="die">${diceSymbol(d)}</div>`).join("")
    || `<span class="muted">Plus de dés.</span>`;

  if (state.currentBid) {
    $("currentBid").textContent = `${state.currentBid.quantity} × ${diceSymbol(state.currentBid.value)} (${state.currentBid.value})`;
    $("quantity").value = Math.max(Number($("quantity").value || 1), state.currentBid.quantity);
  } else {
    $("currentBid").textContent = "Aucune";
  }

  $("bid").disabled = !mine || state.gameOver || !!state.lastResolution;
  $("dudo").disabled = !mine || !state.currentBid || state.gameOver || !!state.lastResolution;
  $("quantity").disabled = !mine || state.gameOver || !!state.lastResolution;
  $("value").disabled = !mine || state.gameOver || !!state.lastResolution;

  $("gamePlayers").innerHTML = state.players.map(p => {
    const cls = ["player", p.id === state.currentPlayerId ? "active" : "", !p.alive ? "dead" : ""].join(" ");
    return `<div class="${cls}">
      <strong>${esc(p.name)}</strong>
      <span>${p.alive ? `${p.diceCount} dé${p.diceCount > 1 ? "s" : ""}` : "Éliminé"}</span>
    </div>`;
  }).join("");

  const resolution = $("resolution");
  if (state.lastResolution) {
    const r = state.lastResolution;
    const verdict = r.bidWasTrue
      ? `L'enchère était vraie : ${playerName(r.challengerId)} perd un dé.`
      : `L'enchère était fausse : ${playerName(r.bidderId)} perd un dé.`;
    resolution.innerHTML = `
      <div class="resolveTitle">DUDO !</div>
      <p>${esc(verdict)}</p>
      <p><strong>${r.actual}</strong> dé(s) correspondaient à l'enchère de <strong>${r.bid.quantity}</strong>.</p>
      <div>
        ${r.allDice.map(row => `
          <div class="reveal">
            <strong>${esc(row.name)}</strong>
            <span>${row.dice.map(diceSymbol).join(" ")}</span>
          </div>`).join("")}
      </div>
      <p class="muted small">Nouvelle manche dans quelques secondes…</p>
    `;
    resolution.classList.remove("hidden");
  } else {
    resolution.classList.add("hidden");
    resolution.innerHTML = "";
  }

  $("restart").classList.toggle("hidden", !(state.gameOver && state.hostId === myId));
}
