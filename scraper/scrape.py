#!/usr/bin/env python3
"""Borwigsches Orakel – Datensammler.

Liest Spielplan, Ergebnisse und Mannschafts-DWZ aus
  * ChessLeagueManager (schachverband-sh.de)  -> quelle "clm"
  * NSV-Ergebnisdienst (nsv-online.de, JSON-API) -> quelle "nsv"
und schreibt docs/data/ligen.json, die von der Webseite simuliert wird.

Aufruf:  python scraper/scrape.py [--offline VERZ ...] [--out PFAD]
--offline nimmt Verzeichnisse mit index.txt ("datei url" je Zeile) als
Cache statt echter Downloads (zum Testen).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
UA = "Mozilla/5.0 (BorwigschesOrakel; +https://github.com/MisterB024Hub/Borwigsche-Orakel)"
MONATE = {m: i + 1 for i, m in enumerate(
    ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
     "August", "September", "Oktober", "November", "Dezember"])}


# --------------------------------------------------------------------------
# Abruf
# --------------------------------------------------------------------------
class Fetcher:
    def __init__(self, offline_dirs: list[str] | None = None):
        self.offline: dict[str, Path] = {}
        for d in offline_dirs or []:
            idx = Path(d) / "index.txt"
            for line in idx.read_text().splitlines():
                f, u = line.split(" ", 1)
                self.offline[self._norm(u)] = Path(d) / f
        self.session = requests.Session()
        self.session.headers["User-Agent"] = UA

    @staticmethod
    def _norm(url: str) -> str:
        p = urlparse(url)
        q = sorted((k, v) for k, vs in parse_qs(p.query, keep_blank_values=True).items() for v in vs)
        return f"{p.netloc}{p.path.rstrip('/')}?{urlencode(q)}"

    def get(self, url: str, encoding: str | None = None) -> str:
        if self.offline:
            f = self.offline.get(self._norm(url))
            if not f:
                raise FileNotFoundError(f"offline nicht vorhanden: {url}")
            return f.read_bytes().decode(encoding or "utf-8", errors="replace")
        for versuch in range(3):
            try:
                r = self.session.get(url, timeout=60)
                r.raise_for_status()
                if encoding:
                    r.encoding = encoding
                time.sleep(0.5)  # Server schonen
                return r.text
            except requests.RequestException as e:
                if versuch == 2:
                    raise
                print(f"  Wiederhole {url}: {e}", file=sys.stderr)
                time.sleep(5)
        raise RuntimeError("unerreichbar")


def zahl(s: str) -> float | None:
    s = s.strip().replace("½", ".5").replace(",", ".")
    if s in ("+",):
        return None
    try:
        return float(s)
    except ValueError:
        return None


# --------------------------------------------------------------------------
# ChessLeagueManager (SVSH)
# --------------------------------------------------------------------------
def clm_url(cfg: dict, view: str, **extra) -> str:
    q = {"view": view, "saison": cfg["saison"], "liga": cfg["liga"], "Itemid": 1, **extra}
    return cfg["basis"] + "?" + urlencode(q)


def clm_tlnr(a) -> int | None:
    if not a or not a.get("href"):
        return None
    m = re.search(r"tlnr=(\d+)", a["href"])
    return int(m.group(1)) if m else None


def parse_clm_ergebnis(txt: str) -> tuple[float | None, float | None, bool]:
    """'4.5 : 3.5' -> (4.5, 3.5, False);  '+ : -' -> kampflos."""
    t = txt.strip()
    if not t or re.fullmatch(r":?", t.replace(" ", "")):
        return None, None, False
    teile = [x.strip() for x in t.split(":")]
    if len(teile) != 2:
        return None, None, False
    a, b = teile
    # kampflos-Markierungen
    if a.startswith("+") and b.startswith("-"):
        return None, None, True  # wird später mit Brettzahl gefüllt
    if a.startswith("-") and b.startswith("+"):
        return None, None, True
    za, zb = zahl(re.sub(r"[^\d.,½]", "", a)), zahl(re.sub(r"[^\d.,½]", "", b))
    if za is None or zb is None:
        return None, None, False
    return za, zb, False


def scrape_clm(cfg: dict, F: Fetcher) -> dict:
    # --- Rangliste: Namen, Mannschafts-DWZ, Auf-/Abstiegsmarken ---
    html = F.get(clm_url(cfg, "rangliste"))
    s = BeautifulSoup(html, "html.parser")
    titel = s.title.get_text(strip=True) if s.title else ""
    name = re.sub(r"^Rangliste\s+", "", titel) or f"Liga {cfg['liga']}"
    teams: dict[int, dict] = {}
    marken = {"auf": 0, "ab": 0, "ab_evtl": 0}
    for tr in s.select("table.rangliste tr"):
        tds = tr.find_all("td")
        if not tds:
            continue
        team_td = tr.find("td", class_="team")
        if not team_td:
            continue
        tl = clm_tlnr(team_td.find("a"))
        if tl is None:
            continue
        roh = team_td.get_text(" ", strip=True)
        m = re.search(r"\((\d{3,4})\)\s*$", roh)
        dwz = int(m.group(1)) if m else None
        tname = re.sub(r"\s*\(\d{3,4}\)\s*$", "", roh).strip()
        teams[tl] = {"id": str(tl), "name": tname, "dwz": dwz}
        klasse = (tds[0].get("class") or [""])[0]
        if klasse == "rang_auf":
            marken["auf"] += 1
        elif klasse == "rang_ab":
            marken["ab"] += 1
        elif klasse == "rang_ab_evtl":
            marken["ab_evtl"] += 1

    # --- Infokarte: Bretter ---
    bretter = cfg.get("bretter")
    if not bretter:
        info = BeautifulSoup(F.get(clm_url(cfg, "liga_info")), "html.parser")
        txt = info.get_text("|", strip=True)
        m = re.search(r"Anz\. Stammspieler:\|(\d+)", txt)
        bretter = int(m.group(1)) if m else 8

    # --- Paarungsliste: Spielplan + Ergebnisse ---
    s = BeautifulSoup(F.get(clm_url(cfg, "paarungsliste")), "html.parser")
    spiele = []
    for runde, tab in enumerate(s.select("table.paarungsliste"), start=1):
        kopf = tab.find("tr").get_text(" ", strip=True)
        datum = None
        md = re.search(r"(\d{1,2})\.\s*(\w+)\s+(\d{4})", kopf)
        if md and md.group(2) in MONATE:
            datum = dt.date(int(md.group(3)), MONATE[md.group(2)], int(md.group(1))).isoformat()
        for tr in tab.find_all("tr"):
            heim_td, gast_td, erg_td = tr.find("td", class_="heim"), tr.find("td", class_="gast"), tr.find("td", class_="erg")
            if not (heim_td and gast_td and erg_td):
                continue
            h, g = clm_tlnr(heim_td.find("a")), clm_tlnr(gast_td.find("a"))
            if h is None or g is None:
                continue  # spielfrei
            dwz_tds = tr.find_all("td", class_="dwz")
            for tl, td in ((h, dwz_tds[0] if dwz_tds else None), (g, dwz_tds[1] if len(dwz_tds) > 1 else None)):
                if tl not in teams:
                    teams[tl] = {"id": str(tl), "name": (heim_td if tl == h else gast_td).get_text(" ", strip=True), "dwz": None}
                if teams[tl]["dwz"] is None and td is not None:
                    d = td.get_text(strip=True)
                    teams[tl]["dwz"] = int(d) if d.isdigit() else None
            a, b, kl = parse_clm_ergebnis(erg_td.get_text(" ", strip=True))
            if kl:
                txt = erg_td.get_text(" ", strip=True)
                a, b = (bretter, 0.0) if txt.startswith("+") else (0.0, bretter)
            spiele.append({"runde": runde, "datum": datum, "heim": str(h), "gast": str(g), "bh": a, "bg": b})

    auf = cfg.get("auf") if cfg.get("auf") is not None else marken["auf"]
    ab = cfg.get("ab") if cfg.get("ab") is not None else marken["ab"]
    ab_evtl = cfg.get("ab_evtl") if cfg.get("ab_evtl") is not None else marken["ab_evtl"]
    return {
        "id": cfg["id"],
        "name": cfg.get("name") or name,
        "gruppe": cfg.get("gruppe", ""),
        "url": clm_url(cfg, "rangliste"),
        "bretter": bretter,
        "auf": auf, "ab": ab, "ab_evtl": ab_evtl,
        "relegation": cfg.get("relegation") or 0,
        "annahme": cfg.get("annahme") if (cfg.get("auf") is not None or cfg.get("ab") is not None) and not (marken["auf"] or marken["ab"]) else None,
        "wertung": ["MP", "BP"],
        "teams": sorted(teams.values(), key=lambda t: int(t["id"])),
        "spiele": spiele,
    }


# --------------------------------------------------------------------------
# NSV-Ergebnisdienst (JSON-API)
# --------------------------------------------------------------------------
def nsv_api(cfg: dict, pfad: str) -> str:
    return cfg["basis"] + "api/" + pfad


def scrape_nsv(cfg: dict, F: Fetcher) -> dict:
    erste = json.loads(F.get(nsv_api(cfg, f"divisions/{cfg['staffel']}/rounds/1/")))
    runden_nr = sorted(int(k) for k in erste.get("allRounds", {}) or {"1": 0})
    runden = {1: erste}
    for r in runden_nr:
        if r not in runden:
            runden[r] = json.loads(F.get(nsv_api(cfg, f"divisions/{cfg['staffel']}/rounds/{r}/")))

    teams: dict[str, dict] = {}
    spiele = []
    bretter = cfg.get("bretter") or 0
    for r in runden_nr:
        rd = runden[r]
        for p in rd.get("pairings", []):
            for key in ("team1", "team2"):
                t = p[key]
                teams.setdefault(str(t["id"]), {"id": str(t["id"]), "name": t["name"], "dwz": None})
            bh, bg = p.get("result1"), p.get("result2")
            if p.get("games"):
                bretter = max(bretter, len(p["games"]))
            spiele.append({"runde": r, "datum": rd.get("date"), "heim": str(p["team1"]["id"]),
                           "gast": str(p["team2"]["id"]),
                           "bh": float(bh) if bh is not None else None,
                           "bg": float(bg) if bg is not None else None})

    # Status-Marken aus der Tabelle der zuletzt gelesenen Runde
    marken = {"aufsteiger": 0, "absteiger": 0, "absteigerRelegation": 0, "aufsteigerRelegation": 0}
    ranking = runden[runden_nr[-1]].get("legacyRanking") or erste.get("legacyRanking") or []
    for zeile in ranking[1:]:
        st = zeile[-1] if zeile else ""
        if st in marken:
            marken[st] += 1

    # Mannschafts-DWZ: Schnitt der ersten <bretter> Spieler der Meldeliste
    for tid, t in teams.items():
        try:
            info = json.loads(F.get(nsv_api(cfg, f"teams/{tid}/")))
        except Exception as e:  # noqa: BLE001
            print(f"  Aufstellung {t['name']} nicht lesbar: {e}", file=sys.stderr)
            continue
        spieler = []
        for liste in (info.get("playersByTeamNumber") or {}).values():
            spieler.extend(liste)
        spieler.sort(key=lambda x: x.get("number") or 999)
        werte = [x.get("dwz") or x.get("elo") for x in spieler if (x.get("dwz") or x.get("elo"))]
        top = werte[: bretter or 6]
        if top:
            t["dwz"] = round(sum(top) / len(top))

    return {
        "id": cfg["id"],
        "name": cfg.get("name") or cfg["staffel"],
        "gruppe": cfg.get("gruppe", ""),
        "url": cfg["basis"] + cfg["staffel"] + "/",
        "bretter": bretter or 6,
        "auf": cfg.get("auf") if cfg.get("auf") is not None else marken["aufsteiger"],
        "ab": cfg.get("ab") if cfg.get("ab") is not None else marken["absteiger"],
        "ab_evtl": cfg.get("ab_evtl") or 0,
        "relegation": cfg.get("relegation") if cfg.get("relegation") is not None else marken["absteigerRelegation"],
        "annahme": cfg.get("annahme"),
        "wertung": ["MP", "BP"],
        "teams": sorted(teams.values(), key=lambda t: t["name"]),
        "spiele": spiele,
    }


# --------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", nargs="*", default=None)
    ap.add_argument("--out", default=str(ROOT / "docs" / "data" / "ligen.json"))
    ap.add_argument("--nur", nargs="*", help="nur diese Liga-IDs")
    args = ap.parse_args()

    cfg = json.loads((ROOT / "config" / "ligen.json").read_text(encoding="utf-8"))
    F = Fetcher(args.offline)
    out_path = Path(args.out)
    alt = {}
    if out_path.exists():
        try:
            alt = {l["id"]: l for l in json.loads(out_path.read_text(encoding="utf-8"))["ligen"]}
        except Exception:  # noqa: BLE001
            alt = {}

    ligen, fehler = [], 0
    for c in cfg["ligen"]:
        if args.nur and c["id"] not in args.nur:
            continue
        print(f"Lese {c['id']} …", file=sys.stderr)
        try:
            liga = scrape_clm(c, F) if c["quelle"] == "clm" else scrape_nsv(c, F)
            gespielt = sum(1 for s in liga["spiele"] if s["bh"] is not None)
            print(f"  {liga['name']}: {len(liga['teams'])} Teams, {len(liga['spiele'])} Spiele, {gespielt} gespielt", file=sys.stderr)
            ligen.append(liga)
        except Exception as e:  # noqa: BLE001
            fehler += 1
            print(f"  FEHLER {c['id']}: {e!r}", file=sys.stderr)
            if c["id"] in alt:
                ligen.append(alt[c["id"]])  # letzten Stand behalten

    if not ligen:
        print("Keine Daten – nichts geschrieben.", file=sys.stderr)
        return 1
    # nur neu schreiben, wenn sich inhaltlich etwas geändert hat
    neu_inhalt = json.dumps(ligen, ensure_ascii=False, sort_keys=True)
    alt_inhalt = json.dumps([alt.get(l["id"]) for l in ligen], ensure_ascii=False, sort_keys=True)
    if neu_inhalt == alt_inhalt:
        print("Keine Änderungen.", file=sys.stderr)
        return 0
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"stand": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                                    "ligen": ligen}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Geschrieben: {out_path} ({len(ligen)} Ligen, {fehler} Fehler)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
