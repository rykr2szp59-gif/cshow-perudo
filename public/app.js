
const socket = io();
const $ = id => document.getElementById(id);

let state = null;
let myId = null;
let pendingBid = null;

function saveSession(session) {
  localStorage.setItem("cshow-perudo-session", JSON.stringify(session));
}

function readSession() {
  try { return JSON.parse(localStorage.getItem("cshow-perudo-session")); }
  catch { return null; }
}

function acceptSession(res) {
  if (!res?.ok) return false;
  myId = res.playerId;
  saveSession({ code: res.code, playerId: res.playerId, resumeToken: res.resumeToken });
  return true;
}

socket.on("connect", () => {
  const session = readSession();
  if (!session?.code || !session?.playerId || !session?.resumeToken) return;
  socket.emit("resumeRoom", session, res => {
    if (acceptSession(res)) return;
    localStorage.removeItem("cshow-perudo-session");
    state = null;
    myId = null;
    $("welcome").classList.remove("hidden");
  });
});

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function dieDisplay(n) {
  if (n === 6) return "🦜";
  return ["","⚀","⚁","⚂","⚃","⚄","⚅"][n] || "?";
}

function bidLabel(bid) {
  if (!bid) return "Aucune";
  const unit = bid.value === 6 ? "PERUDO" : `dé(s) de ${bid.value}`;
  return `${bid.quantity} ${unit}`;
}

function playerName(id) {
  return state?.players?.find(p => p.id === id)?.name || "Joueur";
}

$("create").onclick = () => {
  $("welcomeError").textContent = "";
  socket.emit("createRoom", { name:$("name").value }, res => {
    if (!acceptSession(res)) $("welcomeError").textContent = res?.error || "Erreur.";
  });
};

$("join").onclick = () => {
  $("welcomeError").textContent = "";
  socket.emit("joinRoom", { name:$("name").value, code:$("code").value }, res => {
    if (!acceptSession(res)) $("welcomeError").textContent = res?.error || "Erreur.";
  });
};

$("start").onclick = () => {
  $("lobbyError").textContent = "";
  socket.emit("startGame", {}, res => {
    if (!res?.ok) $("lobbyError").textContent = res?.error || "Erreur.";
  });
};

$("prepareBid").onclick = () => {
  pendingBid = {
    quantity: Number($("quantity").value),
    value: Number($("value").value)
  };

  $("confirmText").textContent =
    `Tu annonces : ${pendingBid.quantity} ${
      pendingBid.value === 6 ? "PERUDO" : "dé(s) de valeur " + pendingBid.value
    }.`;

  $("confirmModal").classList.remove("hidden");
};

$("cancelBid").onclick = () => {
  pendingBid = null;
  $("confirmModal").classList.add("hidden");
};

$("confirmBid").onclick = () => {
  if (!pendingBid) return;

  $("gameError").textContent = "";
  socket.emit("bid", pendingBid, res => {
    if (!res?.ok) {
      $("gameError").textContent = res?.error || "Annonce invalide.";
    }
    pendingBid = null;
    $("confirmModal").classList.add("hidden");
  });
};

$("lie").onclick = () => {
  $("gameError").textContent = "";
  socket.emit("lie", {}, res => {
    if (!res?.ok) $("gameError").textContent = res?.error || "Erreur.";
  });
};

$("exact").onclick = () => {
  $("gameError").textContent = "";
  socket.emit("exact", {}, res => {
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
  myId = s.myId;
  render();
});

function renderRulesHint() {
  if (!state?.currentBid) {
    $("ruleHint").textContent = "Première annonce : choisis un chiffre de 1 à 5.";
    return;
  }

  const b = state.currentBid;
  if (b.value === 6) {
    $("ruleHint").textContent =
      `Depuis ${b.quantity} Perudo : augmente les Perudo, ou reviens à un chiffre avec au moins ${b.quantity * 2 + 1} dés.`;
  } else {
    $("ruleHint").textContent =
      `Pour passer aux Perudo : minimum ${Math.floor(b.quantity / 2) + 1} Perudo.`;
  }
}

function renderResolution() {
  const box = $("resolution");
  const r = state.lastResolution;

  if (!r) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  let title = "";
  let text = "";

  if (r.type === "lie") {
    title = "TU MENS !";
    text = r.bidWasTrue
      ? `${playerName(r.actorId)} s'est trompé : l'annonce était vraie. Il perd 1 dé.`
      : `${playerName(r.bidderId)} avait menti : il perd 1 dé.`;
  }

  if (r.type === "exact") {
    title = "EXACT !";
    text = r.exact
      ? `${playerName(r.actorId)} a trouvé exactement le bon nombre et gagne 1 dé (maximum 5).`
      : `${playerName(r.actorId)} n'était pas exact et perd 1 dé.`;
  }

  if (r.type === "timeout") {
    title = "TEMPS ÉCOULÉ";
    text = `${playerName(r.loserId)} n'a pas joué à temps et perd 1 dé.`;
  }

  const actualText = r.actual !== undefined
    ? `<p>Nombre réel correspondant : <strong>${r.actual}</strong>.</p>`
    : "";

  const reveals = (r.allDice || []).map(row => `
    <div class="reveal">
      <strong>${esc(row.name)}</strong>
      <span>${row.dice.map(dieDisplay).join(" ")}</span>
    </div>
  `).join("");

  box.innerHTML = `
    <div class="resolveTitle">${title}</div>
    <p>${esc(text)}</p>
    ${actualText}
    <div>${reveals}</div>
    <p class="muted small">Nouvelle manche dans quelques secondes…</p>
  `;
  box.classList.remove("hidden");
}

function render() {
  if (!state) return;

  $("welcome").classList.add("hidden");

  if (!state.started) {
    $("lobby").classList.remove("hidden");
    $("game").classList.add("hidden");

    $("roomCode").textContent = state.code;
    $("hostBadge").classList.toggle("hidden", state.hostId !== myId);
    $("start").classList.toggle("hidden", state.hostId !== myId);

    $("lobbyPlayers").innerHTML = state.players.map(p => `
      <div class="player">
        <strong>${esc(p.name)}</strong>
        <span>${p.id === state.hostId ? "Hôte" : ""}${p.connected ? "" : " · hors ligne"}</span>
      </div>
    `).join("");

    return;
  }

  $("lobby").classList.add("hidden");
  $("game").classList.remove("hidden");

  $("gameCode").textContent = state.code;
  $("round").textContent = state.round;
  $("timer").textContent = state.turnSecondsLeft ?? 20;

  const mine = state.currentPlayerId === myId;
  const current = state.players.find(p => p.id === state.currentPlayerId);

  $("turnBanner").textContent = state.gameOver
    ? `🏆 ${playerName(state.winnerId)} gagne la partie !`
    : mine
      ? "À TOI DE JOUER"
      : `Tour de ${current?.name || "…"}`;

  $("turnBanner").classList.toggle("mine", mine && !state.gameOver);

  $("myDice").innerHTML = (state.myDice || []).map(d =>
    `<div class="die ${d === 6 ? "perudo" : ""}">${dieDisplay(d)}</div>`
  ).join("") || `<span class="muted">Plus de dés.</span>`;

  $("currentBid").textContent = state.currentBid
    ? `${bidLabel(state.currentBid)} — ${playerName(state.currentBid.playerId)}`
    : "Aucune";

  $("prepareBid").disabled = !mine || state.gameOver || !!state.lastResolution;
  $("lie").disabled = !mine || !state.currentBid || state.gameOver || !!state.lastResolution;
  $("exact").disabled = !mine || !state.currentBid || state.gameOver || !!state.lastResolution;
  $("quantity").disabled = !mine || state.gameOver || !!state.lastResolution;
  $("value").disabled = !mine || state.gameOver || !!state.lastResolution;

  $("gamePlayers").innerHTML = state.players.map(p => {
    const cls = [
      "player",
      p.id === state.currentPlayerId ? "active" : "",
      !p.alive ? "dead" : ""
    ].join(" ");

    return `
      <div class="${cls}">
        <strong>${esc(p.name)}</strong>
        <span>${p.alive ? `${p.diceCount} dé${p.diceCount > 1 ? "s" : ""}` : "Éliminé"}${p.connected ? "" : " · hors ligne"}</span>
      </div>
    `;
  }).join("");

  $("restart").classList.toggle(
    "hidden",
    !(state.gameOver && state.hostId === myId)
  );

  renderRulesHint();
  renderResolution();
}
