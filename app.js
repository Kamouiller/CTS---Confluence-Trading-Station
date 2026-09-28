/* ==========================================================
   GTS Cobblemon — logique appli
   Stockage : Firebase Firestore (voir firebase-config.js)
   ========================================================== */

const LS_KEY = "gts_account_id";
const PRESENCE_TTL_MS = 45_000;
const MAX_LISTINGS_PER_ACCOUNT = 5;
const MAX_AUCTION_HOURS = 168; // 1 semaine

let currentAccountId = null;
let currentAccount = null;
let isAdminUnlocked = false;
let selectedType = "vente";     // vente | enchere | echange
let selectedPoke = null;
let selectedWanted = null;
let currentFilter = "all";      // all | vente | enchere | echange
let allListings = [];
let allAccounts = [];
const finalizing = new Set();

const POKE_LIST = Object.keys(POKEDEX).map(id => ({ id, name: POKEDEX[id][0] }));

/* ---------------------------------------------------------- utilitaires */

function slugify(str) {
  return str
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function spriteUrl(pokeId) {
  const entry = POKEDEX[pokeId];
  return entry ? "data:image/png;base64," + entry[1] : "";
}
function pokeName(pokeId) {
  const entry = POKEDEX[pokeId];
  return entry ? entry[0] : "?";
}
function statusOf(l) { return l.status || "actif"; }
function fmtMoney(n) { return Number(n || 0).toLocaleString("fr-FR") + " ₽"; }
function fmtDate(ms) {
  return new Date(ms).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function formatRemaining(ms) {
  if (ms <= 0) return "Terminée";
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${Math.max(m, 1)} min`;
}
function clampInt(v, min, max) {
  let n = parseInt(v, 10);
  if (isNaN(n)) n = 0;
  return Math.max(min, Math.min(max, n));
}
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

/* ---------------------------------------------------------- connexion */

$("#login-btn").addEventListener("click", handleLogin);

async function handleLogin() {
  const prenom = $("#login-prenom").value.trim();
  const nom = $("#login-nom").value.trim();
  const errBox = $("#login-error");
  errBox.textContent = "";

  if (!prenom || !nom) {
    errBox.textContent = "Merci de renseigner ton prénom et ton nom.";
    return;
  }

  const accountId = slugify(prenom + "-" + nom);

  try {
    const ref = db.collection("accounts").doc(accountId);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        prenom, nom,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    localStorage.setItem(LS_KEY, accountId);
    await loginAs(accountId);
  } catch (e) {
    console.error(e);
    errBox.textContent = "Connexion impossible. Vérifie la configuration Firebase.";
  }
}

async function loginAs(accountId) {
  const snap = await db.collection("accounts").doc(accountId).get();
  if (!snap.exists) {
    localStorage.removeItem(LS_KEY);
    return;
  }
  currentAccountId = accountId;
  currentAccount = snap.data();

  $("#login-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#account-name").textContent = `${currentAccount.prenom} ${currentAccount.nom}`;

  touchPresence();
  setInterval(touchPresence, 20_000);
  setInterval(() => { updateCountdowns(); finalizeExpiredAuctions(); }, 30_000);
  window.addEventListener("beforeunload", () => {
    db.collection("presence").doc(currentAccountId).delete().catch(() => {});
  });

  listenPresence();
  listenListings();
}

$("#logout-btn").addEventListener("click", async () => {
  if (currentAccountId) {
    await db.collection("presence").doc(currentAccountId).delete().catch(() => {});
  }
  localStorage.removeItem(LS_KEY);
  location.reload();
});

(async function autoLogin() {
  const saved = localStorage.getItem(LS_KEY);
  if (saved) await loginAs(saved);
})();

/* ---------------------------------------------------------- présence */

function touchPresence() {
  if (!currentAccountId) return;
  db.collection("presence").doc(currentAccountId).set({
    prenom: currentAccount.prenom,
    nom: currentAccount.nom,
    lastSeen: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(() => {});
}

function listenPresence() {
  db.collection("presence").onSnapshot(snap => {
    const now = Date.now();
    const online = [];
    snap.forEach(doc => {
      const d = doc.data();
      const ts = d.lastSeen && d.lastSeen.toMillis ? d.lastSeen.toMillis() : 0;
      if (now - ts < PRESENCE_TTL_MS) online.push(d);
    });
    $("#online-count").textContent = `${online.length} connecté(s)`;
    $("#online-list").innerHTML = online.map(o => `<span class="online-chip">${esc(o.prenom)}</span>`).join("");
  });
}

/* ---------------------------------------------------------- onglets */

$all(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;

    if (tab === "admin" && !isAdminUnlocked) {
      const pwd = prompt("Mot de passe administrateur :");
      if (pwd === null) return;
      if (pwd !== ADMIN_PASSWORD) {
        alert("Mot de passe incorrect.");
        return;
      }
      isAdminUnlocked = true;
    }

    $all(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    $("#tab-browse").classList.toggle("hidden", tab !== "browse");
    $("#tab-add").classList.toggle("hidden", tab !== "add");
    $("#tab-admin").classList.toggle("hidden", tab !== "admin");
    if (tab === "admin") renderAdmin();
    if (tab === "add") updateLimitNote();
    renderListings();
  });
});

/* ---------------------------------------------------------- filtres */

$all(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    currentFilter = btn.dataset.filter;
    $all(".filter-btn").forEach(b => b.classList.toggle("active", b === btn));
    renderListings();
  });
});

/* ---------------------------------------------------------- annonces : lecture */

function listenListings() {
  db.collection("listings").onSnapshot(snap => {
    allListings = [];
    snap.forEach(doc => allListings.push({ id: doc.id, ...doc.data() }));
    renderListings();
    updateLimitNote();
    finalizeExpiredAuctions();
    if (!$("#tab-admin").classList.contains("hidden")) renderAdmin();
  });
}

function createdMs(l) {
  return l.createdAt && l.createdAt.toMillis ? l.createdAt.toMillis() : Date.now();
}

function statsRow(label, ivs, evs) {
  if (!ivs || !evs) return "";
  return `
    <div class="stats-row">
      <table>
        <tr><td class="k">IV${label}</td><td>PV ${ivs.hp}</td><td>Atk ${ivs.atk}</td><td>Def ${ivs.def}</td><td>ASp ${ivs.spa}</td><td>DSp ${ivs.spd}</td><td>Vit ${ivs.spe}</td></tr>
        <tr><td class="k">EV${label}</td><td>PV ${evs.hp}</td><td>Atk ${evs.atk}</td><td>Def ${evs.def}</td><td>ASp ${evs.spa}</td><td>DSp ${evs.spd}</td><td>Vit ${evs.spe}</td></tr>
      </table>
    </div>`;
}

function renderListings() {
  const grid = $("#listings-grid");
  const empty = $("#listings-empty");
  const list = allListings
    .filter(l => currentFilter === "all" || l.type === currentFilter)
    .sort((a, b) => createdMs(b) - createdMs(a));

  if (list.length === 0) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  grid.innerHTML = list.map(l => {
    const status = statusOf(l);
    const isOwner = l.sellerAccountId === currentAccountId;
    const typeLabel = { vente: "VENTE", echange: "ÉCHANGE", enchere: "ENCHÈRE" }[l.type] || "";

    // ---- bloc central selon le type
    let middle = "";
    if (l.type === "vente") {
      middle = `<div class="price-tag">${fmtMoney(l.price)}</div>`;
    } else if (l.type === "echange") {
      middle = `
        <div class="trade-arrow">
          <img src="${spriteUrl(l.pokemonId)}" alt="">
          <span>contre</span>
          <img src="${spriteUrl(l.wantedPokemonId)}" alt="">
          <span>${esc(pokeName(l.wantedPokemonId))}</span>
        </div>`;
    } else if (l.type === "enchere") {
      const hasBid = (l.bidCount || 0) > 0;
      middle = `
        <div class="price-tag">${hasBid ? fmtMoney(l.currentBid) : fmtMoney(l.startPrice)}</div>
        <div class="bid-line">${hasBid
          ? `Meilleure enchère de <b>${esc(l.currentBidderName)}</b> (${l.bidCount} enchère${l.bidCount > 1 ? "s" : ""})`
          : "Mise de départ, aucune enchère"}</div>
        <div class="countdown" data-end="${l.endsAt}" data-status="${status}">${status === "actif" ? "Fin dans " + formatRemaining(l.endsAt - Date.now()) : ""}</div>`;
    }

    // ---- bandeau de statut
    let banner = "";
    if (status === "achete") {
      banner = `<div class="status-banner">${l.type === "echange" ? "Échange accepté par" : "Acheté par"} <b>${esc(l.buyerName)}</b></div>`;
    } else if (status === "termine") {
      banner = l.currentBidderName
        ? `<div class="status-banner">Enchère terminée — remportée par <b>${esc(l.currentBidderName)}</b> pour ${fmtMoney(l.currentBid)}</div>`
        : `<div class="status-banner muted">Enchère terminée sans enchère</div>`;
    }

    // ---- boutons
    let actions = "";
    if (status === "actif" && !isOwner) {
      if (l.type === "vente") actions += `<button class="primary buy-btn" data-id="${l.id}">Acheter</button>`;
      if (l.type === "echange") actions += `<button class="primary buy-btn" data-id="${l.id}">Accepter l'échange</button>`;
      if (l.type === "enchere") actions += `<button class="primary bid-btn" data-id="${l.id}">Enchérir</button>`;
    }
    const lockedAuction = l.type === "enchere" && status === "actif" && (l.bidCount || 0) > 0;
    const canRemove = isAdminUnlocked || (isOwner && !lockedAuction);
    if (canRemove) actions += `<button class="danger remove-btn" data-id="${l.id}">Retirer</button>`;

    return `
      <div class="card ${l.type}" data-id="${l.id}">
        <div class="card-top">
          <img src="${spriteUrl(l.pokemonId)}" alt="">
          <div>
            <div class="card-title">${esc(pokeName(l.pokemonId))}</div>
            <div class="card-type">${typeLabel}</div>
          </div>
        </div>
        ${middle}
        ${banner}
        ${statsRow("", l.ivs, l.evs)}
        ${l.type === "echange" ? statsRow(" voulus", l.ivsWanted, l.evsWanted) : ""}
        <div class="card-footer">
          <div class="seller">Dresseur : <b>${esc(l.sellerName)}</b></div>
          <div class="card-actions">${actions}</div>
        </div>
      </div>`;
  }).join("");

  $all(".buy-btn", grid).forEach(b => b.addEventListener("click", () => buyListing(b.dataset.id)));
  $all(".bid-btn", grid).forEach(b => b.addEventListener("click", () => placeBid(b.dataset.id)));
  $all(".remove-btn", grid).forEach(b => b.addEventListener("click", () => removeListing(b.dataset.id)));
}

function updateCountdowns() {
  $all(".countdown").forEach(el => {
    if (el.dataset.status !== "actif") return;
    el.textContent = "Fin dans " + formatRemaining(Number(el.dataset.end) - Date.now());
  });
}

async function removeListing(id) {
  await db.collection("listings").doc(id).delete();
}

/* ---------------------------------------------------------- achat / échange */

async function buyListing(id) {
  const l = allListings.find(x => x.id === id);
  if (!l) return;
  const question = l.type === "vente"
    ? `Acheter ${pokeName(l.pokemonId)} pour ${fmtMoney(l.price)} ?`
    : `Accepter l'échange de ${pokeName(l.pokemonId)} contre ${pokeName(l.wantedPokemonId)} ?`;
  if (!confirm(question)) return;

  const ref = db.collection("listings").doc(id);
  const buyerName = `${currentAccount.prenom} ${currentAccount.nom}`;
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("Cette annonce n'existe plus.");
      const d = snap.data();
      if (statusOf(d) !== "actif") throw new Error("Cette annonce n'est plus disponible.");
      if (d.sellerAccountId === currentAccountId) throw new Error("Tu ne peux pas acheter ta propre annonce.");

      tx.update(ref, {
        status: "achete",
        buyerAccountId: currentAccountId,
        buyerName,
        boughtAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      if (d.type === "vente") {
        tx.set(db.collection("sales").doc(id), {
          kind: "vente",
          pokemonId: d.pokemonId,
          sellerName: d.sellerName,
          sellerAccountId: d.sellerAccountId,
          buyerName,
          buyerAccountId: currentAccountId,
          price: d.price,
          date: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
    });
  } catch (e) {
    alert(e.message || "Achat impossible.");
  }
}

/* ---------------------------------------------------------- enchères */

async function placeBid(id) {
  const l = allListings.find(x => x.id === id);
  if (!l) return;
  const hasBid = (l.bidCount || 0) > 0;
  const min = hasBid ? l.currentBid + 1 : l.startPrice;
  const input = prompt(`Ton enchère pour ${pokeName(l.pokemonId)} en Pokédollar (minimum ${min}) :`);
  if (input === null) return;
  const amount = parseInt(input, 10);
  if (isNaN(amount) || amount < min) {
    alert(`Enchère invalide : minimum ${min} ₽.`);
    return;
  }

  const ref = db.collection("listings").doc(id);
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("Cette annonce n'existe plus.");
      const d = snap.data();
      if (statusOf(d) !== "actif" || d.endsAt <= Date.now()) throw new Error("Cette enchère est terminée.");
      if (d.sellerAccountId === currentAccountId) throw new Error("Tu ne peux pas enchérir sur ta propre annonce.");
      const dHasBid = (d.bidCount || 0) > 0;
      const dMin = dHasBid ? d.currentBid + 1 : d.startPrice;
      if (amount < dMin) throw new Error(`Quelqu'un a surenchéri entre-temps : minimum ${dMin} ₽.`);
      tx.update(ref, {
        currentBid: amount,
        currentBidderId: currentAccountId,
        currentBidderName: `${currentAccount.prenom} ${currentAccount.nom}`,
        bidCount: (d.bidCount || 0) + 1
      });
    });
  } catch (e) {
    alert(e.message || "Enchère impossible.");
  }
}

// Clôture les enchères dont le délai est dépassé (exécuté par n'importe quel client connecté)
async function finalizeExpiredAuctions() {
  const now = Date.now();
  const expired = allListings.filter(l => l.type === "enchere" && statusOf(l) === "actif" && l.endsAt <= now);
  for (const l of expired) {
    if (finalizing.has(l.id)) continue;
    finalizing.add(l.id);
    const ref = db.collection("listings").doc(l.id);
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const d = snap.data();
        if (statusOf(d) !== "actif" || d.endsAt > Date.now()) return;
        tx.update(ref, { status: "termine" });
        if (d.currentBidderId) {
          tx.set(db.collection("sales").doc(l.id), {
            kind: "enchere",
            pokemonId: d.pokemonId,
            sellerName: d.sellerName,
            sellerAccountId: d.sellerAccountId,
            buyerName: d.currentBidderName,
            buyerAccountId: d.currentBidderId,
            price: d.currentBid,
            date: firebase.firestore.FieldValue.serverTimestamp()
          });
        }
      });
    } catch (e) {
      console.error(e);
    } finally {
      finalizing.delete(l.id);
    }
  }
}

/* ---------------------------------------------------------- limite */

function myActiveListingsCount() {
  return allListings.filter(l => l.sellerAccountId === currentAccountId).length;
}
function updateLimitNote() {
  const count = myActiveListingsCount();
  $("#limit-note").textContent = `${count}/${MAX_LISTINGS_PER_ACCOUNT} annonces sur ton compte (retire les annonces terminées pour libérer de la place).`;
  $("#submit-listing").disabled = count >= MAX_LISTINGS_PER_ACCOUNT;
}

/* ---------------------------------------------------------- formulaire : type */

$all(".type-switch button").forEach(btn => {
  btn.addEventListener("click", () => {
    selectedType = btn.dataset.type;
    $all(".type-switch button").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    $("#vente-block").classList.toggle("hidden", selectedType !== "vente");
    $("#enchere-block").classList.toggle("hidden", selectedType !== "enchere");
    $("#echange-block").classList.toggle("hidden", selectedType !== "echange");
  });
});

/* ---------------------------------------------------------- autocomplétion */

function setupAutocomplete(inputSel, listSel, onPick) {
  const input = $(inputSel);
  const list = $(listSel);

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 1) { list.classList.add("hidden"); list.innerHTML = ""; return; }
    const matches = POKE_LIST.filter(p => p.name.toLowerCase().includes(q)).slice(0, 8);
    if (matches.length === 0) { list.classList.add("hidden"); list.innerHTML = ""; return; }
    list.innerHTML = matches.map(m => `<div class="autocomplete-item" data-id="${m.id}"><img src="${spriteUrl(m.id)}"><span>${esc(m.name)}</span></div>`).join("");
    list.classList.remove("hidden");
    $all(".autocomplete-item", list).forEach(item => {
      item.addEventListener("click", () => {
        const id = item.dataset.id;
        const p = { id, name: pokeName(id) };
        onPick(p);
        input.value = p.name;
        list.classList.add("hidden");
        list.innerHTML = "";
      });
    });
  });

  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !list.contains(e.target)) list.classList.add("hidden");
  });
}

setupAutocomplete("#poke-search", "#poke-suggestions", (p) => {
  selectedPoke = p;
  const box = $("#poke-preview");
  box.innerHTML = `<img src="${spriteUrl(p.id)}"><span>${esc(p.name)}</span>`;
});
setupAutocomplete("#wanted-search", "#wanted-suggestions", (p) => {
  selectedWanted = p;
  const box = $("#wanted-preview");
  box.innerHTML = `<img src="${spriteUrl(p.id)}"><span>${esc(p.name)}</span>`;
});

/* ---------------------------------------------------------- publier */

function readGrid(idPrefix, max) {
  const out = {};
  ["hp", "atk", "def", "spa", "spd", "spe"].forEach(k => {
    out[k] = clampInt($(`#${idPrefix}-${k}`).value, 0, max);
  });
  return out;
}

$("#submit-listing").addEventListener("click", async () => {
  const errBox = $("#form-error");
  errBox.textContent = "";

  if (myActiveListingsCount() >= MAX_LISTINGS_PER_ACCOUNT) {
    errBox.textContent = `Limite de ${MAX_LISTINGS_PER_ACCOUNT} annonces atteinte.`;
    return;
  }
  if (!selectedPoke) {
    errBox.textContent = "Sélectionne un Pokémon via l'autocomplétion.";
    return;
  }
  if (selectedType === "echange" && !selectedWanted) {
    errBox.textContent = "Sélectionne le Pokémon demandé en échange.";
    return;
  }

  const listing = {
    type: selectedType,
    status: "actif",
    pokemonId: selectedPoke.id,
    ivs: readGrid("iv", 31),
    evs: readGrid("ev", 252),
    sellerAccountId: currentAccountId,
    sellerName: `${currentAccount.prenom} ${currentAccount.nom}`,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  if (selectedType === "vente") {
    const price = parseInt($("#price-input").value, 10);
    if (isNaN(price) || price < 0) {
      errBox.textContent = "Indique un prix valide en Pokédollar.";
      return;
    }
    listing.price = price;
  } else if (selectedType === "enchere") {
    const start = parseInt($("#start-price-input").value, 10);
    if (isNaN(start) || start < 0) {
      errBox.textContent = "Indique une mise de départ valide en Pokédollar.";
      return;
    }
    const hours = Math.min(parseInt($("#duration-select").value, 10) || 24, MAX_AUCTION_HOURS);
    listing.startPrice = start;
    listing.currentBid = 0;
    listing.currentBidderId = null;
    listing.currentBidderName = null;
    listing.bidCount = 0;
    listing.endsAt = Date.now() + hours * 3600 * 1000;
  } else {
    listing.wantedPokemonId = selectedWanted.id;
    listing.ivsWanted = readGrid("iv-wanted", 31);
    listing.evsWanted = readGrid("ev-wanted", 252);
  }

  try {
    await db.collection("listings").add(listing);
    resetForm();
    $all('.tab[data-tab="browse"]')[0].click();
  } catch (e) {
    console.error(e);
    errBox.textContent = "Impossible de publier l'annonce (config Firebase ?).";
  }
});

function resetForm() {
  selectedPoke = null;
  selectedWanted = null;
  $("#poke-search").value = "";
  $("#wanted-search").value = "";
  const empty = '<span style="color:var(--text-dim); font-size:.8rem">Aucun Pokémon sélectionné</span>';
  $("#poke-preview").innerHTML = empty;
  $("#wanted-preview").innerHTML = empty;
  $("#price-input").value = "";
  $("#start-price-input").value = "";
  $all('.stat-grid input[type=number]').forEach(i => i.value = 0);
}

/* ---------------------------------------------------------- administration */

async function renderAdmin() {
  const accSnap = await db.collection("accounts").get();
  allAccounts = [];
  accSnap.forEach(doc => allAccounts.push({ id: doc.id, ...doc.data() }));

  // ---- historique des ventes (ventes directes + enchères conclues, jamais les échanges)
  try {
    const salesSnap = await db.collection("sales").get();
    const sales = [];
    salesSnap.forEach(doc => sales.push({ id: doc.id, ...doc.data() }));
    sales.sort((a, b) => (b.date?.toMillis?.() ?? 0) - (a.date?.toMillis?.() ?? 0));
    const total = sales.reduce((s, x) => s + (x.price || 0), 0);
    $("#admin-sales-total").textContent = `${sales.length} vente(s) — total ${fmtMoney(total)}`;
    $("#admin-sales-body").innerHTML = sales.length
      ? sales.map(s => `
        <tr>
          <td>${s.date?.toMillis ? fmtDate(s.date.toMillis()) : "—"}</td>
          <td>${s.kind === "enchere" ? "Enchère" : "Vente"}</td>
          <td>${esc(pokeName(s.pokemonId))}</td>
          <td>${esc(s.sellerName)}</td>
          <td>${esc(s.buyerName)}</td>
          <td>${fmtMoney(s.price)}</td>
        </tr>`).join("")
      : `<tr><td colspan="6" style="color:var(--text-dim)">Aucune vente enregistrée pour le moment.</td></tr>`;
  } catch (e) {
    console.error(e);
    $("#admin-sales-body").innerHTML = `<tr><td colspan="6" style="color:var(--danger)">Impossible de lire l'historique (règle Firestore "sales" manquante ?).</td></tr>`;
  }

  // ---- comptes
  const accBody = $("#admin-accounts-body");
  accBody.innerHTML = allAccounts.map(a => `
    <tr>
      <td>${esc(a.nom)}</td>
      <td>${esc(a.prenom)}</td>
      <td>${allListings.filter(l => l.sellerAccountId === a.id).length}</td>
      <td><button class="danger delete-account-btn" data-id="${a.id}">Supprimer</button></td>
    </tr>`).join("");
  $all(".delete-account-btn", accBody).forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Supprimer ce compte ? Ses annonces resteront visibles mais ne pourront plus être retirées que par un admin.")) return;
      await db.collection("accounts").doc(btn.dataset.id).delete();
      await db.collection("presence").doc(btn.dataset.id).delete().catch(() => {});
      renderAdmin();
    });
  });

  // ---- annonces
  const typeLabel = { vente: "Vente", echange: "Échange", enchere: "Enchère" };
  const statusLabel = { actif: "Actif", achete: "Acheté", termine: "Terminée" };
  const listBody = $("#admin-listings-body");
  listBody.innerHTML = allListings.map(l => `
    <tr>
      <td>${esc(l.sellerName)}</td>
      <td>${typeLabel[l.type] || ""}</td>
      <td>${esc(pokeName(l.pokemonId))}</td>
      <td>${statusLabel[statusOf(l)] || ""}</td>
      <td><button class="danger admin-remove-btn" data-id="${l.id}">Retirer</button></td>
    </tr>`).join("");
  $all(".admin-remove-btn", listBody).forEach(btn => {
    btn.addEventListener("click", () => removeListing(btn.dataset.id));
  });
}
