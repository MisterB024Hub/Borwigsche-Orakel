# Borwigsches Orakel ♞

Prognosen für Schachligen in Schleswig-Holstein und die Jugendbundesliga Nord – nach dem Vorbild des [LigaOrakels des SK Bad Homburg](https://www.schachklub-bad-homburg.de/LigaOrakel/LigaOrakel.php).

**Webseite:** https://misterb024hub.github.io/Borwigsche-Orakel/

## Ligen

| Liga | Quelle |
| --- | --- |
| Verbandsliga B, Bezirksliga Kiel, Bezirksklasse C Kiel, Bezirksklasse D Kiel, Jugendlandesliga | [SVSH-Ergebnisdienst](https://schachverband-sh.de) (ChessLeagueManager) |
| Jugendbundesliga Nord – Staffel West, Mitte, Ost | [NSV-Ergebnisdienst](https://nsv-online.de/ligen/jbln-2627/) (JSON-API) |

## Wie es funktioniert

1. **Datensammler** (`scraper/scrape.py`) liest Spielplan, Ergebnisse, Mannschafts-DWZ und Auf-/Abstiegsplätze und schreibt `docs/data/ligen.json`.
2. **GitHub Actions** (`.github/workflows/update.yml`) führt ihn alle drei Stunden aus, sonntags nachmittags stündlich, und committet nur, wenn sich etwas geändert hat.
3. **Webseite** (`docs/`, über GitHub Pages) simuliert die Restsaison 20.000-mal direkt im Browser. Offene Kämpfe lassen sich im „Was-wäre-wenn“-Modus festlegen.

Das Modell: DWZ-Erwartungswert je Brett, Remisquote bis 30 % bei gleich starken Gegnern, zufällige Tagesform je Mannschaft (±40 DWZ). Tabellenreihenfolge nach MP, BP, dann Los.

## Liga hinzufügen oder ändern

In `config/ligen.json` einen Eintrag ergänzen:

```json
{ "id": "svsh-213", "quelle": "clm", "basis": "https://schachverband-sh.de/index.php/de/component/clm/", "saison": 9, "liga": 213, "gruppe": "Schleswig-Holstein" }
```

Die Liga-Nummer steht in der URL der Rangliste (`liga=…`). Auf-/Abstiegsplätze werden aus der Rangliste gelesen; mit `"auf"`, `"ab"`, `"ab_evtl"` bzw. `"relegation"` lassen sie sich überschreiben. Nach dem Commit läuft die Aktualisierung automatisch.

Für eine neue Saison `saison` (SVSH) bzw. `basis` (NSV, z. B. `jbln-2728`) anpassen.

## Lokal ausführen

```bash
pip install -r scraper/requirements.txt
python scraper/scrape.py
cd docs && python -m http.server 8000   # → http://localhost:8000
```
