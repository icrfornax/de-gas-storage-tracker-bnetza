#!/usr/bin/env python3
"""Static validation for the published gas-storage dashboard."""

from __future__ import annotations

import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REQUIRED_FILES = [
    ROOT / "index.html",
    ROOT / "styles.css",
    ROOT / "dashboard.js",
    ROOT / "data" / "projections.csv",
    ROOT / "data" / "eu_storage.csv",
    ROOT / "data" / "de_storage_capacity.json",
]
REQUIRED_COLUMNS = {
    "run_timestamp_utc",
    "run_date_berlin",
    "latest_data_date",
    "current_fill_level_pct",
    "minimum_threshold_pct",
    "rate_avg_pct_per_day",
    "optimistic_20pct_lower_withdrawal_rate_pct_per_day",
    "pessimistic_20pct_higher_withdrawal_rate_pct_per_day",
}


def main() -> int:
    for path in REQUIRED_FILES:
        if not path.exists():
            raise SystemExit(f"Missing required dashboard file: {path.relative_to(ROOT)}")

    index_html = (ROOT / "index.html").read_text(encoding="utf-8")
    for expected in (
        "dashboard.js",
        "data/projections.csv",
        "Gasspeicher Deutschland",
        "EU-Gasspeicher bis 1. November",
        "Winterreserve-Labor",
        "80% Füllstand zum 1.11.2026",
        'id="eu-chart"',
        'id="copy-summary"',
        'id="copy-status"',
    ):
        if expected not in index_html:
            raise SystemExit(f"index.html does not reference {expected!r}")

    dashboard_js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
    for expected in (
        "buildLageSummary",
        "copyLageSummary",
        "navigator.clipboard",
        "renderEuTrajectory",
        "EU_TARGET_FILL",
        "targetProjection",
        "technical_max_injection_gwh_per_day",
    ):
        if expected not in dashboard_js:
            raise SystemExit(f"dashboard.js is missing {expected!r}")

    with (ROOT / "data" / "projections.csv").open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        missing = REQUIRED_COLUMNS.difference(reader.fieldnames or [])
        if missing:
            raise SystemExit(f"data/projections.csv missing columns: {sorted(missing)}")
        rows = list(reader)

    if not rows:
        raise SystemExit("data/projections.csv has no projection rows")

    with (ROOT / "data" / "eu_storage.csv").open(newline="", encoding="utf-8") as handle:
        eu_reader = csv.DictReader(handle)
        eu_required = {"date", "fill_pct", "source"}
        eu_missing = eu_required.difference(eu_reader.fieldnames or [])
        if eu_missing:
            raise SystemExit(f"data/eu_storage.csv missing columns: {sorted(eu_missing)}")
        eu_rows = list(eu_reader)

    if len(eu_rows) < 2:
        raise SystemExit("data/eu_storage.csv needs at least two observations")

    for row in eu_rows:
        fill = float(row["fill_pct"])
        if not 0 <= fill <= 100:
            raise SystemExit(f"EU fill level out of range: {fill}")

    with (ROOT / "data" / "de_storage_capacity.json").open(encoding="utf-8") as handle:
        capacity = json.load(handle)
    technical_max = float(capacity["technical_max_injection_gwh_per_day"])
    if technical_max <= 0:
        raise SystemExit(f"Technical injection capacity must be positive: {technical_max}")

    latest = rows[-1]
    fill_level = float(latest["current_fill_level_pct"])
    threshold = float(latest["minimum_threshold_pct"])
    if not 0 <= fill_level <= 100:
        raise SystemExit(f"Current fill level out of range: {fill_level}")
    if not 0 < threshold < 100:
        raise SystemExit(f"Minimum threshold out of range: {threshold}")

    print(
        "Dashboard validation passed: "
        f"{len(rows)} DE projection rows, {len(eu_rows)} EU points, latest DE fill {fill_level:.2f}%."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
