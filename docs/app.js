/* Borwigsches Orakel – Monte-Carlo-Simulation im Browser */
(() => {
  "use strict";

  const N_SIM = 20000;
  const FORM_SD = 40;      // Tagesform je Mannschaft und Saison (DWZ-Punkte)
  const REMIS_MAX = 0.30;  // Remisquote bei gleich starken Gegnern

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const zahl = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1).replace(".", ",")).replace(/,5$/, "½").replace(/^0½$/, "½");
  const pct = (x) => {
    if (x <= 0) return "–";
    if (x >= 1) return "100";
    const p = x * 100;
    if (p < 0.1) return "<0,1";
    if (p > 99.9) return ">99,9";
    return p.toFixed(p < 10 ? 1 : 0).replace(".", ",");
  };
  const datumDe = (iso) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
  };

  let DATA = null;
  let liga = null;
  let auswahlTeam = null;
  let ergebnis = null;
  const annahmen = {}; // ligaId -> { spielIndex: "h" | "r" | "g" }

  /* ---------------- Daten ---------------- */
  async function laden() {
    try {
      const r = await fetch("data/ligen.json", { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status);
      DATA = await r.json();
    } catch (e) {
      $("stand").textContent = "Daten konnten nicht geladen werden.";
      $("inhalt").innerHTML = '<p class="leer">Die Ligadaten sind noch nicht verfügbar. Bitte später erneut versuchen.</p>';
      return;
    }
    const st = new Date(DATA.stand);
    $("stand").textContent = "Stand: " + st.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
    $("n-sim").textContent = N_SIM.toLocaleString("de-DE");
    navBauen();
    const id = decodeURIComponent(location.hash.slice(1));
    waehleLiga(DATA.ligen.find((l) => l.id === id) ? id : DATA.ligen[0].id);
  }

  function navBauen() {
    const gruppen = new Map();
    for (const l of DATA.ligen) {
      if (!gruppen.has(l.gruppe)) gruppen.set(l.gruppe, []);
      gruppen.get(l.gruppe).push(l);
    }
    const kurz = (l) => l.name.replace(/^Jugendbundesliga Nord – /, "");
    $("ligen-nav").innerHTML = [...gruppen].map(([g, ls]) =>
      `<div class="nav-gruppe"><span class="nav-gruppe-titel">${esc(g || "Ligen")}</span><div class="nav-reihe">` +
      ls.map((l) => `<button class="nav-knopf" data-liga="${esc(l.id)}">${esc(kurz(l))}</button>`).join("") +
      `</div></div>`).join("");
    $("ligen-nav").addEventListener("click", (e) => {
      const b = e.target.closest("[data-liga]");
      if (b) waehleLiga(b.dataset.liga);
    });
    window.addEventListener("hashchange", () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (liga && id !== liga.id && DATA.ligen.some((l) => l.id === id)) waehleLiga(id);
    });
  }

  function waehleLiga(id) {
    liga = DATA.ligen.find((l) => l.id === id);
    auswahlTeam = null;
    if (location.hash.slice(1) !== id) history.replaceState(null, "", "#" + id);
    document.querySelectorAll(".nav-knopf").forEach((b) => b.setAttribute("aria-current", String(b.dataset.liga === id)));
    annahmen[id] = annahmen[id] || {};
    kopfZeichnen();
    rechnen();
  }

  /* ---------------- Modell ---------------- */
  function brettWkeiten(diff) {
    const E = 1 / (1 + Math.pow(10, -diff / 400));
    const pR = REMIS_MAX * 4 * E * (1 - E);
    return [E - pR / 2, pR]; // [Sieg, Remis]
  }

  function zonen(l) {
    const n = l.teams.length;
    const z2 = (l.ab_evtl || 0) + (l.relegation || 0);
    return {
      auf: Math.min(l.auf || 0, n),
      ab: Math.min(l.ab || 0, n),
      z2,
      z2Name: l.relegation ? "Relegation" : "Abst. evtl.",
      zone(pos) { // pos 1-basiert
        if (pos <= this.auf) return "auf";
        if (pos > n - this.ab) return "ab";
        if (pos > n - this.ab - this.z2) return "evtl";
        return "";
      },
    };
  }

  function simulieren(l, ann) {
    const n = l.teams.length;
    const idx = new Map(l.teams.map((t, i) => [t.id, i]));
    const bekannte = l.teams.map((t) => t.dwz).filter((x) => x);
    const schnitt = bekannte.length ? bekannte.reduce((a, b) => a + b, 0) / bekannte.length : 1600;
    const dwz = l.teams.map((t) => t.dwz || schnitt);
    const B = l.bretter;

    const mp0 = new Float64Array(n), bp0 = new Float64Array(n), sp0 = new Int32Array(n);
    const offen = [];
    l.spiele.forEach((s, k) => {
      const h = idx.get(s.heim), g = idx.get(s.gast);
      if (h === undefined || g === undefined) return;
      if (s.bh !== null && s.bg !== null) {
        bp0[h] += s.bh; bp0[g] += s.bg; sp0[h]++; sp0[g]++;
        if (s.bh > s.bg) mp0[h] += 2; else if (s.bh < s.bg) mp0[g] += 2; else { mp0[h]++; mp0[g]++; }
      } else {
        offen.push({ k, h, g, ann: ann[k] || null });
      }
    });

    const platz = Array.from({ length: n }, () => new Float64Array(n));
    const mpSumme = new Float64Array(n);
    const ausgang = offen.map(() => [0, 0, 0]);
    const mp = new Float64Array(n), bp = new Float64Array(n), los = new Float64Array(n), form = new Float64Array(n);
    const ord = Array.from({ length: n }, (_, i) => i);

    const ausspielen = (pS, pR) => {
      let p = 0;
      for (let b = 0; b < B; b++) {
        const u = Math.random();
        if (u < pS) p += 1; else if (u < pS + pR) p += 0.5;
      }
      return p;
    };
    const passt = (a, ziel) => (ziel === "h" ? a > B / 2 : ziel === "g" ? a < B / 2 : a === B / 2);

    for (let s = 0; s < N_SIM; s++) {
      for (let i = 0; i < n; i++) {
        mp[i] = mp0[i]; bp[i] = bp0[i]; los[i] = Math.random();
        // Box-Muller für die Tagesform
        form[i] = FORM_SD * Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
      }
      for (let o = 0; o < offen.length; o++) {
        const m = offen[o];
        const [pS, pR] = brettWkeiten(dwz[m.h] + form[m.h] - dwz[m.g] - form[m.g]);
        let a = ausspielen(pS, pR);
        if (m.ann && !passt(a, m.ann)) {
          let ok = false;
          for (let v = 0; v < 40 && !ok; v++) { a = ausspielen(pS, pR); ok = passt(a, m.ann); }
          if (!ok) a = m.ann === "h" ? Math.floor(B / 2) + 1 : m.ann === "g" ? Math.ceil(B / 2) - 1 : B / 2;
        }
        const c = B - a;
        bp[m.h] += a; bp[m.g] += c;
        if (a > c) { mp[m.h] += 2; ausgang[o][0]++; }
        else if (a < c) { mp[m.g] += 2; ausgang[o][2]++; }
        else { mp[m.h]++; mp[m.g]++; ausgang[o][1]++; }
      }
      ord.sort((x, y) => mp[y] - mp[x] || bp[y] - bp[x] || los[y] - los[x]);
      for (let p = 0; p < n; p++) platz[ord[p]][p]++;
      for (let i = 0; i < n; i++) mpSumme[i] += mp[i];
    }

    const teams = l.teams.map((t, i) => {
      const verteilung = Array.from(platz[i], (c) => c / N_SIM);
      const erwPlatz = verteilung.reduce((a, p, j) => a + p * (j + 1), 0);
      return { ...t, i, dwzEff: dwz[i], verteilung, erwPlatz, erwMP: mpSumme[i] / N_SIM, mp: mp0[i], bp: bp0[i], sp: sp0[i] };
    });
    const spielW = new Map(offen.map((m, o) => [m.k, ausgang[o].map((c) => c / N_SIM)]));
    return { teams, spielW };
  }

  /* ---------------- Darstellung ---------------- */
  function kopfZeichnen() {
    $("liga-name").textContent = liga.name;
    const runden = new Set(liga.spiele.map((s) => s.runde)).size;
    const gespielt = new Set(liga.spiele.filter((s) => s.bh !== null).map((s) => s.runde)).size;
    const z = zonen(liga);
    const teile = [
      `${liga.teams.length} Mannschaften`,
      `${liga.bretter} Bretter`,
      `${gespielt} von ${runden} Runden gespielt`,
    ];
    const ab = [];
    if (z.auf) ab.push(`${z.auf} Aufsteiger`);
    if (z.z2) ab.push(`${z.z2} ${liga.relegation ? "Relegation" : "evtl. Absteiger"}`);
    if (z.ab) ab.push(`${z.ab} Absteiger`);
    if (ab.length) teile.push(ab.join(", "));
    $("liga-meta").innerHTML = esc(teile.join(" · ")) + ` · <a href="${esc(liga.url)}" rel="noopener" target="_blank">Ergebnisdienst ↗</a>`;
    $("annahme").hidden = !liga.annahme;
    $("annahme").textContent = liga.annahme || "";
  }

  function rechnen() {
    const ann = annahmen[liga.id];
    const anz = Object.keys(ann).length;
    $("reset").hidden = anz === 0;
    $("sim-status").textContent = "rechne …";
    setTimeout(() => {
      const t0 = performance.now();
      ergebnis = simulieren(liga, ann);
      const ms = Math.round(performance.now() - t0);
      $("sim-status").textContent = `${N_SIM.toLocaleString("de-DE")} Saisons simuliert` + (anz ? ` · ${anz} Annahme${anz > 1 ? "n" : ""}` : "");
      $("sim-status").title = `${ms} ms`;
      zeichnen();
    }, 15);
  }

  function zeichnen() {
    prognoseZeichnen();
    tabelleZeichnen();
    spielplanZeichnen();
  }

  function teamZelle(t) {
    return `<td class="team"><button class="team-link" data-team="${esc(t.id)}" title="Restspiele von ${esc(t.name)} anzeigen">${esc(t.name)}</button></td>`;
  }

  function prognoseZeichnen() {
    const z = zonen(liga);
    const n = liga.teams.length;
    const ts = [...ergebnis.teams].sort((a, b) => a.erwPlatz - b.erwPlatz);
    const summe = (t, von, bis) => t.verteilung.slice(von, bis).reduce((a, b) => a + b, 0);
    const spalten = [{ k: "Meister", f: (t) => t.verteilung[0], cls: "auf" }];
    if (z.auf > 1) spalten.push({ k: "Aufstieg", f: (t) => summe(t, 0, z.auf), cls: "auf" });
    if (z.z2) spalten.push({ k: z.z2Name, f: (t) => summe(t, n - z.ab - z.z2, n - z.ab), cls: "evtl" });
    if (z.ab) spalten.push({ k: "Abstieg", f: (t) => summe(t, n - z.ab, n), cls: "ab" });

    let h = `<thead><tr><th class="l">#</th><th class="l">Mannschaft</th><th>DWZ</th><th title="Erwartete Mannschaftspunkte am Saisonende">Ø MP</th>`;
    h += spalten.map((s) => `<th>${esc(s.k)}</th>`).join("");
    for (let p = 1; p <= n; p++) {
      const zo = z.zone(p);
      h += `<th class="p${p === 1 ? " trenner" : ""}${zo ? " zone-" + zo : ""}">${p}.</th>`;
    }
    h += `</tr></thead><tbody>`;
    ts.forEach((t, r) => {
      h += `<tr class="${t.id === auswahlTeam ? "aktiv" : ""}"><td class="rang l">${r + 1}</td>${teamZelle(t)}<td class="dwz">${t.dwz ?? "?"}</td><td class="dwz">${t.erwMP.toFixed(1).replace(".", ",")}</td>`;
      h += spalten.map((s) => { const v = s.f(t); return `<td class="k ${v > 0.0005 ? s.cls : "null"}">${pct(v)}</td>`; }).join("");
      t.verteilung.forEach((v, j) => {
        const a = v <= 0 ? 0 : 0.06 + 0.8 * Math.sqrt(v);
        const dunkel = a > 0.5;
        h += `<td class="p${j === 0 ? " trenner" : ""}" style="background:rgba(var(--gruen-h),${a.toFixed(3)})${dunkel ? ";color:#fff" : ""}">${pct(v)}</td>`;
      });
      h += `</tr>`;
    });
    $("prognose").innerHTML = h + "</tbody>";
  }

  function tabelleZeichnen() {
    const z = zonen(liga);
    const ts = [...ergebnis.teams].sort((a, b) => b.mp - a.mp || b.bp - a.bp || a.name.localeCompare(b.name, "de"));
    let h = `<thead><tr><th class="l">Pl.</th><th class="l">Mannschaft</th><th>Sp</th><th>MP</th><th>BP</th></tr></thead><tbody>`;
    let vorher = null, rang = 0;
    ts.forEach((t, i) => {
      if (!vorher || t.mp !== vorher.mp || t.bp !== vorher.bp) rang = i + 1;
      vorher = t;
      const zo = z.zone(i + 1);
      h += `<tr class="${t.id === auswahlTeam ? "aktiv" : ""}"><td class="rang l${zo ? " zone-" + zo : ""}">${rang}.</td>${teamZelle(t)}<td>${t.sp}</td><td><b>${t.mp}</b></td><td>${zahl(t.bp)}</td></tr>`;
    });
    $("tabelle").innerHTML = h + "</tbody>";
  }

  function spielplanZeichnen() {
    const name = new Map(liga.teams.map((t) => [t.id, t.name]));
    const dwz = new Map(liga.teams.map((t) => [t.id, t.dwz]));
    const ann = annahmen[liga.id];
    const B = liga.bretter;
    $("filter-info").innerHTML = auswahlTeam
      ? `Gefiltert: ${esc(name.get(auswahlTeam))} · <a href="#" id="filter-weg">alle zeigen</a>`
      : "";
    const runden = new Map();
    liga.spiele.forEach((s, k) => {
      if (auswahlTeam && s.heim !== auswahlTeam && s.gast !== auswahlTeam) return;
      if (!runden.has(s.runde)) runden.set(s.runde, []);
      runden.get(s.runde).push([s, k]);
    });
    if (!runden.size) { $("spielplan").innerHTML = '<p class="leer">Keine Begegnungen.</p>'; return; }
    let h = "";
    for (const [r, liste] of [...runden].sort((a, b) => a[0] - b[0])) {
      const fertig = liste.every(([s]) => s.bh !== null);
      h += `<details class="runde"${fertig ? "" : " open"}><summary class="runde-kopf"><span>Runde ${r}${fertig ? " · gespielt" : ""}</span><span>${esc(datumDe(liste[0][0].datum))}</span></summary>`;
      for (const [s, k] of liste) {
        const hn = esc(name.get(s.heim) || "?"), gn = esc(name.get(s.gast) || "?");
        const hd = dwz.get(s.heim) ? ` <span class="dwz">${dwz.get(s.heim)}</span>` : "";
        const gd = dwz.get(s.gast) ? `<span class="dwz">${dwz.get(s.gast)}</span> ` : "";
        h += `<div class="kampf"><div class="h">${hn}${hd}</div><div class="mitte">`;
        if (s.bh !== null) {
          h += `<span class="ergebnis fest">${zahl(s.bh)} : ${zahl(s.bg)}</span></div><div class="g">${gd}${gn}</div>`;
        } else {
          const a = ann[k] || "";
          h += `<span class="erg-gruppe" role="group" aria-label="Ergebnis annehmen">` +
            [["h", "1", "Heimsieg"], ["r", "X", "Unentschieden"], ["g", "2", "Gastsieg"]].map(([v, txt, lab]) =>
              `<button class="erg-knopf" data-spiel="${k}" data-wert="${v}" aria-pressed="${a === v}" title="${lab} annehmen">${txt}</button>`).join("") +
            `</span></div><div class="g">${gd}${gn}</div>`;
          const w = ergebnis.spielW.get(k);
          if (w && !a) {
            h += `<div class="wkeit" title="Heimsieg ${pct(w[0])} % · Remis ${pct(w[1])} % · Gastsieg ${pct(w[2])} %"><span class="w-h" style="width:${w[0] * 100}%"></span><span class="w-r" style="width:${w[1] * 100}%"></span><span class="w-g" style="width:${w[2] * 100}%"></span></div>`;
            h += `<div class="wkeit-zahlen"><span>${pct(w[0])} %</span><span>Remis ${pct(w[1])} %</span><span>${pct(w[2])} %</span></div>`;
          }
        }
        h += `</div>`;
      }
      h += `</details>`;
    }
    $("spielplan").innerHTML = h;
  }

  /* ---------------- Interaktion ---------------- */
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-team]");
    if (t) {
      auswahlTeam = auswahlTeam === t.dataset.team ? null : t.dataset.team;
      zeichnen();
      if (auswahlTeam && window.innerWidth < 900) $("spielplan").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (e.target.id === "filter-weg") { e.preventDefault(); auswahlTeam = null; zeichnen(); return; }
    const b = e.target.closest(".erg-knopf");
    if (b) {
      const ann = annahmen[liga.id], k = b.dataset.spiel, v = b.dataset.wert;
      if (ann[k] === v) delete ann[k]; else ann[k] = v;
      rechnen();
    }
  });
  $("reset").addEventListener("click", () => { annahmen[liga.id] = {}; rechnen(); });

  laden();
})();
