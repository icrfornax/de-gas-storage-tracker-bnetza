# Projektion Gasspeicherstand Deutschland

Automatisierte Projektion des deutschen Gasspeicherstands auf Basis von Daten der Bundesnetzagentur (BNetzA).

Human in the loop: [Prof. Dr. Raphael Volz (Hochschule Pforzheim)](https://www.raphaelvolz.de/) (raphael.volz@hs-pforzheim.de)

Umsetzung: Google Gemini / OpenAI Codex und Github Actions

## Interaktives Cockpit

Die Repository-Wurzel enthaelt jetzt ein statisches Lagebild:

- `index.html`: Winterreserve-Cockpit fuer Browser und GitHub Pages
- `dashboard.js`: liest die EU- und Deutschland-Trajektorie direkt aus dem GIE-Export
- `styles.css`: responsive Kontrollraum-Oberflaeche
- `data/eu_storage.csv`: EU-Serie aus dem direkten GIE-AGSI+-API-Abruf
- `data/gie_storage.csv`: normalisierte EU- und Deutschland-Rohdaten aus der GIE-API inklusive 5-Jahres-Norm
- `scripts/update_gie_storage.py`: ruft GIE AGSI+ nach API-Dokumentation v013 ab
- `data/de_storage_capacity.json`: technischer Einspeicherleistungs-Benchmark fuer Deutschland
- `.github/workflows/pages.yml`: validiert und veroeffentlicht das Cockpit per GitHub Pages
- `.github/workflows/daily-gasspeicher-projection.yml`: aktualisiert Daten und deployt anschliessend denselben statischen Stand

Lokaler Smoke-Test:

```bash
python scripts/validate_dashboard.py
python -m http.server 8765
```

## Letzte Projektionen

Stand aus `data/projections.csv`, letzter Lauf:

```text
Projektion #Gasspeicher DE vom 2026-08-30
Fuellstand 52.25% am 2026-08-28
Kritisches Minimum 20% (Entnahmerate bricht stark ein)

Szenarien - Minimum wird erreicht am:

nicht erreicht (nicht-negative Rate)
Optimistisch (20% weniger Entnahme)
(0.36%/Tag)

nicht erreicht (nicht-negative Rate)
Kleinste Entnahme
(0.3%/Tag)

nicht erreicht (nicht-negative Rate)
Durchschnittliche Entnahme
(0.190333%/Tag)

nicht erreicht (nicht-negative Rate)
Groesste Entnahme
(0%/Tag)

nicht erreicht (nicht-negative Rate)
Pessimistisch (20% mehr Entnahme)
(0%/Tag)
```

## Datenquellen

- `url_a`: `https://www.bundesnetzagentur.de/_tools/SVG/js2/_functions/csv_export.html?view=renderCSV&id=870304`
- `url_b`: `https://www.bundesnetzagentur.de/_tools/SVG/js2/_functions/csv_export.html?view=renderCSV&id=870306`

Der Workflow nutzt `url_b` fuer die taegliche Projektion.

Die EU- und Deutschland-Serien werden direkt aus der
[GIE AGSI+ API](https://agsi.gie.eu/) erzeugt. Authentifizierung und
Felddefinitionen folgen der [offiziellen GIE-API-Dokumentation v013](https://www.gie.eu/transparency-platform/GIE_API_documentation_v013.pdf).
Die [Global-Energy-Flow-Trajektorie](https://global-energy-flow.com/storage/trajectory/)
wird im Cockpit als Kontextquelle verlinkt; die angezeigten Messpunkte stammen
aus dem direkten GIE-Abruf.

## Was der Python-Job macht

Datei: `scripts/2026_gasspeicher_deutschland.py`

- laedt `url_b` herunter
- cached die Quelle nach `data/bnetza_cache.csv` (git-versionierbar)
- nutzt bei Netzwerkfehlern den Cache als Fallback
- berechnet auf Basis der letzten 30 Tage (konfigurierbar) Szenario-Raten
- berechnet fuer jedes Szenario das Datum, an dem das Minimum erreicht wird
- schreibt pro Ausfuehrung **eine neue Zeile** nach `data/projections.csv`
- gibt eine lesbare Kurzfassung in der Konsole aus

## EU-Trajektorie

Das Cockpit zeigt die EU- und Deutschland-Gasspeicherstände aus dem direkten
[GIE AGSI+ API](https://agsi.gie.eu/)-Abruf. Die
[Global-Energy-Flow-Trajektorie](https://global-energy-flow.com/storage/trajectory/)
wird als Kontext- und Vergleichsquelle ausgewiesen.
Die Projektion zum 1. November 2026 wird im Browser aus dem jüngsten verfügbaren
Fenster berechnet: aktueller Füllstand plus durchschnittliche tägliche Änderung
zwischen den Messpunkten innerhalb der letzten 30 Tage. Das Ziel ist der für 2026
relaxte Wert von 80%. Der jüngste verfügbare GIE-Gastag kann gegenüber dem
Kalendertag der Ausführung zeitverzögert sein; das Dashboard zeigt deshalb immer
das tatsächliche Datenstand-Datum.

Der deutsche Bereich verwendet dieselbe Darstellung: aktueller Füllstand,
GIE-5-Jahres-Norm (Mittelwert desselben Kalendertags in den fünf Vorjahren),
Abweichung zur Norm, 80%-Ziel und 30-Tage-Projektion. Die bisherigen BNetzA-
Projektionsläufe werden nur noch als separates Archiv angezeigt.

Die automatischen Entnahme-Szenarien prüfen saisonal gegen 80% zum 1. November
im Einspeicherfenster (1. März bis 1. November) und gegen 20% zum 1. März im
Winterfenster (1. November bis 1. März).

Im `Winterreserve-Labor` wird die erforderliche deutsche Tagesänderung bis zum
80%-Ziel berechnet und auf dem Slider markiert. Zusätzlich zeigt ein zweiter Marker
den technischen Einspeicherleistungs-Benchmark von 3.936,52 GWh/Tag aus einem
AGSI+-Kapazitätssnapshot. Das ist eine technische Nennkapazität, keine Zusage für
aktuell verfügbare Leistung; Wartungen, Netzengpässe und Gasverfügbarkeit können
die tatsächlich erreichbare Rate begrenzen.

## Output-Dateien

- `data/bnetza_cache.csv`: letzter heruntergeladener Stand von `url_b`
- `data/projections.csv`: historisierte Projektionen, eine Zeile pro Lauf
- `data/gie_storage.csv`: normalisierte GIE-AGSI+-API-Daten für EU und Deutschland mit 5-Jahres-Norm
- `data/eu_storage.csv`: vom Dashboard gelesene EU-Füllstandsserie aus GIE

Typische Spalten in `projections.csv`:

- Lauf-Metadaten (`run_timestamp_utc`, `run_date_berlin`, `data_source_mode`)
- Eingangsdaten (`latest_data_date`, `current_fill_level_pct`)
- Basis-Raten (`rate_min_pct_per_day`, `rate_avg_pct_per_day`, `rate_max_pct_per_day`)
- je Szenario:
  - `..._rate_pct_per_day`
  - `..._target_date`
  - `..._days_to_min`

## Lokale Ausfuehrung

```bash
python -m pip install -r requirements.txt
python scripts/2026_gasspeicher_deutschland.py
```

Optionen:

```bash
python scripts/2026_gasspeicher_deutschland.py --minimum 20 --lookback-days 30
```

## Read-only Statusbericht

Ohne einen neuen Projektionslauf an `data/projections.csv` anzuhangen, kann der
aktuelle lokale Stand so zusammengefasst werden:

```bash
python scripts/projection_status.py
python scripts/projection_status.py --format json
```

Der Statusbericht zeigt den letzten Lauf, das Alter des BNetzA-Datenstands, die
Szenario-Zieldaten und einfache Checks fuer Cache und Projektionshistorie.

## GitHub Actions Automatisierung

Workflow: `.github/workflows/daily-gasspeicher-projection.yml`

- Zeitplan: taeglich `9:00 UTC` (= `10:00 GMT+1`)
- Fuehrt das Python-Skript aus
- ruft GIE AGSI+ mit dem Repository-Secret `GIE_API_KEY` ab
- committed geaenderte `data/bnetza_cache.csv`, `data/projections.csv`, `data/gie_storage.csv` und `data/eu_storage.csv` automatisch ins Repository

Der API-Schluessel wird lokal nur in `.secrets/gie_api_key` gelesen; der Ordner
ist durch `.gitignore` vom Repository ausgeschlossen. In GitHub Actions wird
derselbe Wert ausschließlich als Secret `GIE_API_KEY` injiziert.

## Hinweise

- Der Cron-Trigger ist auf feste GMT+1-Logik ausgelegt (`11:00 UTC`).
- Wenn stattdessen strikt lokale Zeit `Europe/Berlin` mit Sommerzeit gewuenscht ist, muss der Zeitplan angepasst werden.
