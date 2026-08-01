# Projektion Gasspeicherstand Deutschland

Automatisierte Projektion des deutschen Gasspeicherstands auf Basis von Daten der Bundesnetzagentur (BNetzA).

Human in the loop: [Prof. Dr. Raphael Volz (Hochschule Pforzheim)](https://www.raphaelvolz.de/) (raphael.volz@hs-pforzheim.de)

Umsetzung: Google Gemini / OpenAI Codex und Github Actions

## Interaktives Cockpit

Die Repository-Wurzel enthaelt jetzt ein statisches Lagebild:

- `index.html`: Winterreserve-Cockpit fuer Browser und GitHub Pages
- `dashboard.js`: liest `data/projections.csv` direkt im Browser
- `styles.css`: responsive Kontrollraum-Oberflaeche
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
Projektion #Gasspeicher DE vom 2026-08-01
Fuellstand 45.7% am 2026-07-23
Kritisches Minimum 20% (Entnahmerate bricht stark ein)

Szenarien - Minimum wird erreicht am:

nicht erreicht (nicht-negative Rate)
Optimistisch (20% weniger Entnahme)
(0.384%/Tag)

nicht erreicht (nicht-negative Rate)
Kleinste Entnahme
(0.32%/Tag)

nicht erreicht (nicht-negative Rate)
Durchschnittliche Entnahme
(0.173478%/Tag)

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

## Was der Python-Job macht

Datei: `scripts/2026_gasspeicher_deutschland.py`

- laedt `url_b` herunter
- cached die Quelle nach `data/bnetza_cache.csv` (git-versionierbar)
- nutzt bei Netzwerkfehlern den Cache als Fallback
- berechnet auf Basis der letzten 30 Tage (konfigurierbar) Szenario-Raten
- berechnet fuer jedes Szenario das Datum, an dem das Minimum erreicht wird
- schreibt pro Ausfuehrung **eine neue Zeile** nach `data/projections.csv`
- gibt eine lesbare Kurzfassung in der Konsole aus

## Output-Dateien

- `data/bnetza_cache.csv`: letzter heruntergeladener Stand von `url_b`
- `data/projections.csv`: historisierte Projektionen, eine Zeile pro Lauf

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
- committed geaenderte `data/bnetza_cache.csv` und `data/projections.csv` automatisch ins Repository

## Hinweise

- Der Cron-Trigger ist auf feste GMT+1-Logik ausgelegt (`11:00 UTC`).
- Wenn stattdessen strikt lokale Zeit `Europe/Berlin` mit Sommerzeit gewuenscht ist, muss der Zeitplan angepasst werden.
