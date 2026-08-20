#!/usr/bin/env python3
"""Fetch official GIE AGSI+ storage data for the dashboard.

Authentication follows the GIE API documentation v013: the personal API key
is sent in the ``x-key`` request header.  Locally the key is read from the
ignored ``.secrets/gie_api_key`` file; GitHub Actions supplies it through the
``GIE_API_KEY`` secret.

The script writes:

* ``data/gie_storage.csv`` - normalized EU and German GIE observations;
* ``data/eu_storage.csv`` - the EU series consumed by the static dashboard.
"""

from __future__ import annotations

import csv
import datetime as dt
import os
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parents[1]
API_URL = "https://agsi.gie.eu/api"
API_DOCUMENTATION_URL = "https://www.gie.eu/transparency-platform/GIE_API_documentation_v013.pdf"
LOCAL_SECRET_PATH = ROOT / ".secrets" / "gie_api_key"
GIE_OUTPUT_PATH = ROOT / "data" / "gie_storage.csv"
EU_OUTPUT_PATH = ROOT / "data" / "eu_storage.csv"
DEFAULT_FROM = "2025-11-01"

GIE_COLUMNS = [
    "scope",
    "date",
    "name",
    "code",
    "gas_in_storage_twh",
    "working_gas_volume_twh",
    "fill_pct",
    "consumption_gwh_per_day",
    "injection_gwh_per_day",
    "withdrawal_gwh_per_day",
    "net_withdrawal_gwh_per_day",
    "injection_capacity_gwh_per_day",
    "withdrawal_capacity_gwh_per_day",
    "trend_pct",
    "status",
    "full_pct",
    "source",
]

EU_COLUMNS = ["date", "fill_pct", "source", "source_note"]


def load_api_key() -> str:
    value = os.environ.get("GIE_API_KEY", "").strip()
    if not value and LOCAL_SECRET_PATH.exists():
        value = LOCAL_SECRET_PATH.read_text(encoding="utf-8").strip()
    if not value:
        raise RuntimeError(
            "GIE_API_KEY is missing. Set the environment variable or create "
            f"{LOCAL_SECRET_PATH.relative_to(ROOT)}."
        )
    return value


def fetch_dataset(
    selector: dict[str, str],
    api_key: str,
    from_date: str = DEFAULT_FROM,
    to_date: str | None = None,
) -> list[dict[str, Any]]:
    end_date = to_date or dt.date.today().isoformat()
    rows: list[dict[str, Any]] = []
    page = 1

    while True:
        params = {
            **selector,
            "from": from_date,
            "to": end_date,
            "page": str(page),
            "size": "300",
        }
        try:
            response = requests.get(
                API_URL,
                params=params,
                headers={"x-key": api_key},
                timeout=30,
            )
        except requests.RequestException as exc:
            raise RuntimeError("GIE API request failed before receiving a response.") from exc

        if response.status_code >= 400:
            raise RuntimeError(f"GIE API request failed with HTTP {response.status_code}.")

        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError("GIE API returned invalid JSON.") from exc

        if payload.get("error"):
            raise RuntimeError("GIE API rejected the request or returned no dataset.")

        page_rows = payload.get("data") or []
        if not isinstance(page_rows, list):
            raise RuntimeError("GIE API returned an unexpected data shape.")
        rows.extend(row for row in page_rows if isinstance(row, dict))

        try:
            last_page = int(payload.get("last_page", page))
        except (TypeError, ValueError):
            last_page = page
        if page >= last_page or not page_rows:
            break
        page += 1

    if not rows:
        selector_text = ", ".join(f"{key}={value}" for key, value in selector.items())
        raise RuntimeError(f"GIE API returned no rows for {selector_text}.")
    return rows


def as_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def format_number(value: float | None, digits: int = 6) -> str:
    return "" if value is None else f"{value:.{digits}f}".rstrip("0").rstrip(".")


def normalize_row(scope: str, row: dict[str, Any]) -> dict[str, str]:
    gas_in_storage = as_float(row.get("gasInStorage"))
    working_gas_volume = as_float(row.get("workingGasVolume"))
    full_pct = as_float(row.get("full"))
    fill_pct = full_pct
    if fill_pct is None and gas_in_storage is not None and working_gas_volume:
        fill_pct = gas_in_storage / working_gas_volume * 100

    return {
        "scope": scope,
        "date": str(row.get("gasDayStart", "")),
        "name": str(row.get("name", "")),
        "code": str(row.get("code", "")),
        "gas_in_storage_twh": format_number(gas_in_storage),
        "working_gas_volume_twh": format_number(working_gas_volume),
        "fill_pct": format_number(fill_pct, 4),
        "consumption_gwh_per_day": format_number(as_float(row.get("consumption"))),
        "injection_gwh_per_day": format_number(as_float(row.get("injection"))),
        "withdrawal_gwh_per_day": format_number(as_float(row.get("withdrawal"))),
        "net_withdrawal_gwh_per_day": format_number(as_float(row.get("netWithdrawal"))),
        "injection_capacity_gwh_per_day": format_number(as_float(row.get("injectionCapacity"))),
        "withdrawal_capacity_gwh_per_day": format_number(as_float(row.get("withdrawalCapacity"))),
        "trend_pct": format_number(as_float(row.get("trend"))),
        "status": str(row.get("status", "")),
        "full_pct": format_number(full_pct, 4),
        "source": "GIE AGSI+ API v013",
    }


def write_csv(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    api_key = load_api_key()
    eu_rows = fetch_dataset({"type": "eu"}, api_key)
    de_rows = fetch_dataset({"country": "de"}, api_key)

    normalized = [normalize_row("EU", row) for row in eu_rows]
    normalized.extend(normalize_row("DE", row) for row in de_rows)
    normalized = [row for row in normalized if row["date"] and row["fill_pct"]]
    normalized.sort(key=lambda row: (row["scope"], row["date"]))
    write_csv(GIE_OUTPUT_PATH, GIE_COLUMNS, normalized)

    eu_snapshot = [
        {
            "date": row["date"],
            "fill_pct": row["fill_pct"],
            "source": row["source"],
            "source_note": API_DOCUMENTATION_URL,
        }
        for row in normalized
        if row["scope"] == "EU"
    ]
    write_csv(EU_OUTPUT_PATH, EU_COLUMNS, eu_snapshot)

    latest = max(normalized, key=lambda row: row["date"])
    print(
        f"GIE AGSI+ data updated: {len(eu_snapshot)} EU points, "
        f"{sum(row['scope'] == 'DE' for row in normalized)} DE points; "
        f"latest {latest['date']} ({latest['scope']} {latest['fill_pct']}%)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
