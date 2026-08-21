#!/usr/bin/env python3
"""Tagesgenauen deutschen Gasverbrauch von Trading Hub Europe holen.

Quelle
------
Trading Hub Europe (THE) veroeffentlicht die aggregierten Allokationsmengen
aller Entnahmestellen im deutschen Marktgebiet je Gastag. Abruf ueber die
dokumentierte XML-Schnittstelle, ohne Zugangsschluessel:

    https://datenservice.tradinghub.eu/XmlInterface/getXML.ashx
        ?ReportId=AggregatedConsumptionData&Start=dd-mm-yyyy&End=dd-mm-yyyy

    Doku: https://www.tradinghub.eu/Portals/0/The_XML_Interface_V2.0_de.pdf
    Uebersicht: https://www.tradinghub.eu/de-de/Veroeffentlichungen/Transparenz/
                Aggregierte-Verbrauchsdaten

Die Schnittstelle verlangt einen aussagekraeftigen User-Agent.

Rechenweg
---------
Die Antwort liefert je Gastag acht Mengen in kWh, getrennt nach Gasqualitaet
(H/L) und Abrechnungsart:

    SLP  = HGasSLPsyn + HGasSLPana + LGasSLPsyn + LGasSLPana
           Standardlastprofil-Kunden: Haushalte und kleines Gewerbe.
    RLM  = HGasRLMmT + LGasRLMmT + HGasRLMoT + LGasRLMoT
           Registrierende Leistungsmessung: Industrie und Kraftwerke.

    Verbrauch [GWh] = (SLP + RLM) / 1e6

Kontrolle gegen eine unabhaengige Quelle: fuer das Kalenderjahr 2024 ergibt
die Reihe 838,3 TWh Verbrauch bei 39,1 % SLP-Anteil. Die Bundesnetzagentur
nennt fuer dasselbe Jahr 844 TWh und 39 % Haushalts- und Gewerbekunden
gegenueber 61 % Industrie. Zwei getrennte Messwege, 0,7 % Abstand.

Ergebnis
--------
data/de_consumption_daily.csv mit einer Zeile je Gastag:
    date, consumption_gwh, slp_gwh, rlm_gwh, status, source

`status` uebernimmt die THE-Angabe (preliminary / final / corrected).
Vorhandene Zeilen werden ueberschrieben, wenn THE korrigierte Werte liefert;
--refresh-days (Vorgabe 45) legt fest, wie weit rueckwirkend erneut geholt
wird. Das ist kein Selbstzweck: im Export 2021-08-01..2026-07-31 tragen 61 von
1826 Gastagen den Status "corrected".

Die Einheit steht in jedem Datensatz selbst (<Unit>kWh</Unit>) und wird bei
jedem Abruf geprueft; ein abweichender Wert bricht den Lauf ab, statt still
falsch zu rechnen.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ENDPOINT = "https://datenservice.tradinghub.eu/XmlInterface/getXML.ashx"
REPORT_ID = "AggregatedConsumptionData"
NS = "{urn:schemas-microsoft-com:sql:SqlRowSet1}"
USER_AGENT = (
    "de-gas-storage-tracker-bnetza/1.0 "
    "(+https://github.com/volzinnovation/de-gas-storage-tracker-bnetza)"
)

SLP_FIELDS = ("HGasSLPsyn", "HGasSLPana", "LGasSLPsyn", "LGasSLPana")
RLM_FIELDS = ("HGasRLMmT", "LGasRLMmT", "HGasRLMoT", "LGasRLMoT")

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "data" / "de_consumption_daily.csv"
COLUMNS = ["date", "consumption_gwh", "slp_gwh", "rlm_gwh", "status", "source"]
SOURCE_LABEL = "Trading Hub Europe AggregatedConsumptionData"

# THE veroeffentlicht ab dem 1. Januar 2018.
FIRST_GASDAY = dt.date(2018, 1, 1)
# In Scheiben abrufen, damit einzelne Anfragen klein bleiben.
CHUNK_DAYS = 366


def fetch(start: dt.date, end: dt.date, timeout: int = 60) -> bytes:
    """Einen Zeitraum abrufen. Datumsformat der Schnittstelle ist dd-mm-yyyy."""
    query = (
        f"{ENDPOINT}?ReportId={REPORT_ID}"
        f"&Start={start:%d-%m-%Y}&End={end:%d-%m-%Y}"
    )
    request = urllib.request.Request(query, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def parse(payload: bytes) -> list[dict]:
    """XML in Zeilen umwandeln. Fehlende Einzelmengen zaehlen als 0."""
    text = payload.decode("utf-8-sig", errors="replace")
    marker = text.find("<AggregatedConsumptionData>")
    if marker < 0:
        raise ValueError("Antwort enthaelt kein AggregatedConsumptionData-Element.")
    root = ET.fromstring(text[marker:])

    rows: list[dict] = []
    for record in root.findall(f"{NS}{REPORT_ID}"):
        gasday = record.find(f"{NS}Gasday")
        if gasday is None or not gasday.text:
            continue

        def amount(field: str) -> int:
            node = record.find(f"{NS}{field}")
            return int(node.text) if node is not None and node.text else 0

        unit = record.find(f"{NS}Unit")
        if unit is not None and unit.text and unit.text.strip().lower() != "kwh":
            raise ValueError(f"Unerwartete Einheit: {unit.text!r} (erwartet kWh)")

        slp = sum(amount(f) for f in SLP_FIELDS) / 1e6
        rlm = sum(amount(f) for f in RLM_FIELDS) / 1e6
        status = record.find(f"{NS}Status")
        rows.append(
            {
                "date": gasday.text.strip()[:10],
                "consumption_gwh": f"{slp + rlm:.3f}",
                "slp_gwh": f"{slp:.3f}",
                "rlm_gwh": f"{rlm:.3f}",
                "status": status.text.strip() if status is not None and status.text else "",
                "source": SOURCE_LABEL,
            }
        )
    return rows


def load_existing() -> dict[str, dict]:
    if not TARGET.exists():
        return {}
    with TARGET.open(newline="", encoding="utf-8") as handle:
        return {row["date"]: row for row in csv.DictReader(handle)}


def write(rows: dict[str, dict]) -> None:
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    with TARGET.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        for date in sorted(rows):
            writer.writerow({key: rows[date].get(key, "") for key in COLUMNS})


def spans(start: dt.date, end: dt.date):
    while start <= end:
        stop = min(start + dt.timedelta(days=CHUNK_DAYS - 1), end)
        yield start, stop
        start = stop + dt.timedelta(days=1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--full",
        action="store_true",
        help="komplette Historie ab 2018 neu laden statt nur der letzten Tage",
    )
    parser.add_argument(
        "--refresh-days",
        type=int,
        default=45,
        help="wie viele Tage rueckwirkend erneuert werden (Korrekturen nachziehen)",
    )
    args = parser.parse_args()

    existing = load_existing()
    heute = dt.date.today()

    if args.full or not existing:
        start = FIRST_GASDAY
    else:
        letzter = dt.date.fromisoformat(max(existing))
        start = min(letzter, heute) - dt.timedelta(days=args.refresh_days)
        start = max(start, FIRST_GASDAY)

    neu = 0
    for von, bis in spans(start, heute):
        try:
            rows = parse(fetch(von, bis))
        except (urllib.error.URLError, TimeoutError, ValueError) as fehler:
            print(f"Abruf {von}..{bis} fehlgeschlagen: {fehler}", file=sys.stderr)
            if not existing:
                return 1
            continue
        for row in rows:
            existing[row["date"]] = row
            neu += 1

    if not existing:
        print("Keine Daten erhalten.", file=sys.stderr)
        return 1

    write(existing)
    print(
        f"{len(existing)} Gastage in {TARGET.relative_to(ROOT)} "
        f"({min(existing)} bis {max(existing)}), {neu} Zeilen aktualisiert."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
