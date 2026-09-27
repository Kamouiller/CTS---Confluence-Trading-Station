/* ==========================================================
   GTS Cobblemon — logique appli
   Stockage : Firebase Firestore (voir firebase-config.js)
   ========================================================== */

const LS_KEY = "gts_account_id";
const PRESENCE_TTL_MS = 45_000; // une présence est considérée "en ligne" si vue il y a < 45s
const MAX_LISTINGS_PER_ACCOUNT = 5;

let currentAccountId = null;
let currentAccount = null;
let selectedType = "vente";
let selectedPoke = null;   // {id, name}
let selectedWanted = null; // {id, name}
let allListings = [];      // cache local des annonces actives
let allAccounts = [];      // cache local (vue admin)

const POKE_LIST = Object.keys(POKEDEX).map(id => ({ id, name: POKEDEX[id][0] }));

/* ---------------------------------------------------------- utilitaires */

function slugify(str) {
  return str
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function spriteUrl(pokeId) {
  const entry = POKEDEX[pokeId];
  return entry ? "data:image/png;base64," + entry[1] : "";
}

function pokeName(pokeId) {
  const entry = POKEDEX[pokeId];
  return entry ? entry[0] : "?";
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
      // premier compte jamais créé => admin par défaut
      const anyAccount = await db.collection("accounts").limit(1).get();
      const isFirstEver = anyAccount.empty;
      await ref.set({
        prenom, nom,
        admin: isFirstEver,
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
  $("#account-admin-badge").classList.toggle("hidden", !currentAccount.admin);
  $("#admin-tab-btn").classList.toggle("hidden", !currentAccount.admin);

  touchPresence();
  setInterval(touchPresence, 20_000);
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

// auto-login si une session est déjà mémorisée dans ce navigateur
(async function autoLogin() {
  const saved = localStorage.getItem(LS_KEY);
  if (saved) await loginAs(saved);
})();

/* ---------------------------------------------------------- présence ("qui est connecté") */

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
    $("#online-list").innerHTML = online
      .map(o => `<span class="online-chip"></span>`)
      .join("");
    // texte inséré séparément pour éviter toute injection HTML
    $all("#online-list .online-chip").forEach((el, i) => {
      el.textContent = `${online[i].prenom}`;
    });
  });
}

/* ---------------------------------------------------------- onglets */

$all(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    $all(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    $("#tab-browse").classList.toggle("hidden", tab !== "browse");
    $("#tab-add").classList.toggle("hidden", tab !== "add");
    $("#tab-admin").classList.toggle("hidden", tab !== "admin");
    if (tab === "admin") renderAdmin();
    if (tab === "add") updateLimitNote();
  });
});

/* ---------------------------------------------------------- annonces : lecture */

function listenListings() {
  db.collection("listings").onSnapshot(snap => {
    allListings = [];
    snap.forEach(doc => allListings.push({ id: doc.id, ...doc.data() }));
    renderListings();
    updateLimitNote();
    if (!$("#tab-admin").classList.contains("hidden")) renderAdmin();
  });
}

function renderListings() {
  const grid = $("#listings-grid");
  const empty = $("#listings-empty");
  if (allListings.length === 0) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  grid.innerHTML = allListings.map(l => {
    const isEchange = l.type === "echange";
    const canRemove = currentAccount.admin || l.sellerAccountId === currentAccountId;
    return `
      <div class="card ${isEchange ? "echange" : ""}" data-id="${l.id}">
        <div class="card-top">
          <img src="${spriteUrl(l.pokemonId)}" alt="">
          <div>
            <div class="card-title"></div>
            <div class="card-type">${isEchange ? "ÉCHANGE" : "VENTE"}</div>
          </div>
        </div>
        ${isEchange ? `
          <div class="trade-arrow">
            <img src="${spriteUrl(l.pokemonId)}" alt="">
            <span>contre</span>
            <img src="${spriteUrl(l.wantedPokemonId)}" alt="">
            <span class="wanted-name"></span>
          </div>` : `
          <div class="price-tag">${l.price ?? 0} ₽ (Pokédollar)</div>
        `}
        <div class="stats-row">
          <table>
            <tr><td class="k">IV</td><td>PV ${l.ivs.hp}</td><td>Atk ${l.ivs.atk}</td><td>Def ${l.ivs.def}</td><td>ASp ${l.ivs.spa}</td><td>DSp ${l.ivs.spd}</td><td>Vit ${l.ivs.spe}</td></tr>
            <tr><td class="k">EV</td><td>PV ${l.evs.hp}</td><td>Atk ${l.evs.atk}</td><td>Def ${l.evs.def}</td><td>ASp ${l.evs.spa}</td><td>DSp ${l.evs.spd}</td><td>Vit ${l.evs.spe}</td></tr>
          </table>
        </div>
        <div class="card-footer">
          <div class="seller">Dresseur : <b></b></div>
          ${canRemove ? `<button class="danger remove-btn" data-id="${l.id}">Retirer</button>` : ""}
        </div>
      </div>
    `;
  }).join("");

  // texte inséré via textContent (évite l'injection HTML depuis des noms de dresseurs)
  allListings.forEach(l => {
    const card = grid.querySelector(`.card[data-id="${l.id}"]`);
    if (!card) return;
    card.querySelector(".card-title").textContent = pokeName(l.pokemonId);
    card.querySelector(".seller b").textContent = l.sellerName;
    if (l.type === "echange") {
      card.querySelector(".wanted-name").textContent = pokeName(l.wantedPokemonId);
    }
  });

  $all(".remove-btn", grid).forEach(btn => {
    btn.addEventListener("click", () => removeListing(btn.dataset.id));
  });
}

async function removeListing(id) {
  await db.collection("listings").doc(id).delete();
}

function myActiveListingsCount() {
  return allListings.filter(l => l.sellerAccountId === currentAccountId).length;
}

function updateLimitNote() {
  const count = myActiveListingsCount();
  const note = $("#limit-note");
  note.textContent = `${count}/${MAX_LISTINGS_PER_ACCOUNT} annonces actives sur ton compte.`;
  $("#submit-listing").disabled = count >= MAX_LISTINGS_PER_ACCOUNT;
}

/* ---------------------------------------------------------- formulaire : type vente/échange */

$all(".type-switch button").forEach(btn => {
  btn.addEventListener("click", () => {
    selectedType = btn.dataset.type;
    $all(".type-switch button").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    $("#vente-block").classList.toggle("hidden", selectedType !== "vente");
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
    list.innerHTML = matches.map(m => `<div class="autocomplete-item" data-id="${m.id}"><img src="${spriteUrl(m.id)}"><span></span></div>`).join("");
    matches.forEach((m, i) => {
      list.children[i].querySelector("span").textContent = m.name;
    });
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
    if (!input.contains(e.target) && !list.contains(e.target)) {
      list.classList.add("hidden");
    }
  });
}

setupAutocomplete("#poke-search", "#poke-suggestions", (p) => {
  selectedPoke = p;
  const box = $("#poke-preview");
  box.innerHTML = `<img src="${spriteUrl(p.id)}"><span></span>`;
  box.querySelector("span").textContent = p.name;
});

setupAutocomplete("#wanted-search", "#wanted-suggestions", (p) => {
  selectedWanted = p;
  const box = $("#wanted-preview");
  box.innerHTML = `<img src="${spriteUrl(p.id)}"><span></span>`;
  box.querySelector("span").textContent = p.name;
});

/* ---------------------------------------------------------- publier une annonce */

$("#submit-listing").addEventListener("click", async () => {
  const errBox = $("#form-error");
  errBox.textContent = "";

  if (myActiveListingsCount() >= MAX_LISTINGS_PER_ACCOUNT) {
    errBox.textContent = `Limite de ${MAX_LISTINGS_PER_ACCOUNT} annonces actives atteinte.`;
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

  const ivs = {
    hp: clampInt($("#iv-hp").value, 0, 31), atk: clampInt($("#iv-atk").value, 0, 31),
    def: clampInt($("#iv-def").value, 0, 31), spa: clampInt($("#iv-spa").value, 0, 31),
    spd: clampInt($("#iv-spd").value, 0, 31), spe: clampInt($("#iv-spe").value, 0, 31),
  };
  const evs = {
    hp: clampInt($("#ev-hp").value, 0, 252), atk: clampInt($("#ev-atk").value, 0, 252),
    def: clampInt($("#ev-def").value, 0, 252), spa: clampInt($("#ev-spa").value, 0, 252),
    spd: clampInt($("#ev-spd").value, 0, 252), spe: clampInt($("#ev-spe").value, 0, 252),
  };

  const listing = {
    type: selectedType,
    pokemonId: selectedPoke.id,
    ivs, evs,
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
  } else {
    listing.wantedPokemonId = selectedWanted.id;
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

function clampInt(v, min, max) {
  let n = parseInt(v, 10);
  if (isNaN(n)) n = 0;
  return Math.max(min, Math.min(max, n));
}

function resetForm() {
  selectedPoke = null;
  selectedWanted = null;
  $("#poke-search").value = "";
  $("#wanted-search").value = "";
  $("#poke-preview").innerHTML = '<span style="color:var(--text-dim); font-size:.8rem">Aucun Pokémon sélectionné</span>';
  $("#wanted-preview").innerHTML = '<span style="color:var(--text-dim); font-size:.8rem">Aucun Pokémon sélectionné</span>';
  $("#price-input").value = "";
  $all('.stat-grid input[type=number]').forEach(i => i.value = 0);
}

/* ---------------------------------------------------------- administration */

async function renderAdmin() {
  const accSnap = await db.collection("accounts").get();
  allAccounts = [];
  accSnap.forEach(doc => allAccounts.push({ id: doc.id, ...doc.data() }));

  const accBody = $("#admin-accounts-body");
  accBody.innerHTML = allAccounts.map(a => `
    <tr data-id="${a.id}">
      <td class="cell-nom"></td>
      <td class="cell-prenom"></td>
      <td>${a.admin ? '<span class="badge-admin">ADMIN</span>' : "—"}</td>
      <td>${allListings.filter(l => l.sellerAccountId === a.id).length}</td>
      <td>
        <button class="ghost toggle-admin-btn" data-id="${a.id}">${a.admin ? "Retirer admin" : "Rendre admin"}</button>
        <button class="danger delete-account-btn" data-id="${a.id}">Supprimer</button>
      </td>
    </tr>
  `).join("");
  allAccounts.forEach(a => {
    const row = accBody.querySelector(`tr[data-id="${a.id}"]`);
    row.querySelector(".cell-nom").textContent = a.nom;
    row.querySelector(".cell-prenom").textContent = a.prenom;
  });

  $all(".toggle-admin-btn", accBody).forEach(btn => {
    btn.addEventListener("click", async () => {
      const a = allAccounts.find(x => x.id === btn.dataset.id);
      await db.collection("accounts").doc(a.id).update({ admin: !a.admin });
      renderAdmin();
    });
  });
  $all(".delete-account-btn", accBody).forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Supprimer ce compte ? Ses annonces resteront visibles mais ne pourront plus être retirées que par un admin.")) return;
      await db.collection("accounts").doc(btn.dataset.id).delete();
      await db.collection("presence").doc(btn.dataset.id).delete().catch(() => {});
      renderAdmin();
    });
  });

  const listBody = $("#admin-listings-body");
  listBody.innerHTML = allListings.map(l => `
    <tr data-id="${l.id}">
      <td class="cell-seller"></td>
      <td>${l.type === "echange" ? "Échange" : "Vente"}</td>
      <td class="cell-poke"></td>
      <td><button class="danger admin-remove-btn" data-id="${l.id}">Retirer</button></td>
    </tr>
  `).join("");
  allListings.forEach(l => {
    const row = listBody.querySelector(`tr[data-id="${l.id}"]`);
    row.querySelector(".cell-seller").textContent = l.sellerName;
    row.querySelector(".cell-poke").textContent = pokeName(l.pokemonId);
  });
  $all(".admin-remove-btn", listBody).forEach(btn => {
    btn.addEventListener("click", () => removeListing(btn.dataset.id));
  });
}
