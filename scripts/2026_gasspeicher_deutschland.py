#!/usr/bin/env python3
"""Project German gas storage depletion scenarios from BNetzA data.

Features:
- Download `url_b` from BNetzA and cache it in `data/bnetza_cache.csv`.
- Fall back to cache if the download fails.
- Compute scenario projections from the latest rolling window (default 30 days).
- Append one machine-readable row per execution to `data/projections.csv`.
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import sys
import unicodedata
from collections import OrderedDict
from pathlib import Path
from typing import Dict, Tuple

import pandas as pd
import requests
from zoneinfo import ZoneInfo

URL_A = (
    "https://www.bundesnetzagentur.de/SiteGlobals/Functions/SVG/_functions/"
    "csv_export.html?view=renderCSV&id=870304"
)
URL_B = (
    "https://www.bundesnetzagentur.de/SiteGlobals/Functions/SVG/_functions/" #https://www.bundesnetzagentur.de/SiteGlobals/Functions/SVG/_functions/
    "csv_export.html?view=renderCSV&id=870306"
)

SCENARIOS = OrderedDict(
    [
        ("optimistic_20pct_lower_withdrawal", "Optimistisch (20% weniger Entnahme)"),
        ("smallest_withdrawal", "Kleinste Entnahme"),
        ("average_withdrawal", "Durchschnittliche Entnahme"),
        ("largest_withdrawal", "Groesste Entnahme"),
        ("pessimistic_20pct_higher_withdrawal", "Pessimistisch (20% mehr Entnahme)"),
    ]
)

PROJECTION_SECTION_HEADING = "## Letzte Projektionen"
DEFAULT_README_PATH = Path(__file__).resolve().parents[1] / "README.md"


def normalize_column(name: str) -> str:
    normalized = unicodedata.normalize("NFKD", str(name))
    ascii_name = normalized.encode("ascii", "ignore").decode("ascii")
    ascii_name = ascii_name.lower().replace("%", "pct")
    return "_".join(ascii_name.split())


def parse_bnetza_csv(csv_text: str) -> pd.DataFrame:
    frame = pd.read_csv(io.StringIO(csv_text), sep=";", decimal=",")
    if frame.empty:
        raise ValueError("CSV is empty.")

    frame = frame.copy()
    frame.rename(columns={frame.columns[0]: "day"}, inplace=True)
    frame["day"] = pd.to_datetime(frame["day"], dayfirst=True, errors="coerce")
    frame.dropna(subset=["day"], inplace=True)

    col_map = {normalize_column(col): col for col in frame.columns}

    fill_col = None
    for key, original in col_map.items():
        if key.startswith("fullstand") or "fill" in key:
            fill_col = original
            break

    delta_col = None
    for key, original in col_map.items():
        if "vortag" in key and ("veranderung" in key or "anderung" in key):
            delta_col = original
            break
        if "previous" in key and "change" in key:
            delta_col = original
            break

    if fill_col is None or delta_col is None:
        raise ValueError(
            "Required columns not found in CSV. Needed fill level and daily change columns."
        )

    prepared = frame[["day", fill_col, delta_col]].copy()
    prepared.rename(
        columns={fill_col: "fill_level_pct", delta_col: "delta_pct_per_day"},
        inplace=True,
    )
    prepared["fill_level_pct"] = pd.to_numeric(prepared["fill_level_pct"], errors="coerce")
    prepared["delta_pct_per_day"] = pd.to_numeric(
        prepared["delta_pct_per_day"], errors="coerce"
    )
    prepared.dropna(subset=["fill_level_pct"], inplace=True)
    prepared.sort_values("day", inplace=True)
    prepared.reset_index(drop=True, inplace=True)
    return prepared


def fetch_url_b_with_cache(url: str, cache_path: Path, timeout_seconds: int = 20) -> Tuple[str, str]:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        response = requests.get(url, timeout=timeout_seconds)
        response.raise_for_status()
        csv_text = response.text
        cache_path.write_text(csv_text, encoding="utf-8")
        return csv_text, "network"
    except Exception as exc:
        if cache_path.exists():
            csv_text = cache_path.read_text(encoding="utf-8")
            print(f"[WARN] Network fetch failed, using cache: {exc}", file=sys.stderr)
            return csv_text, "cache"
        raise RuntimeError(
            f"Could not fetch url_b and no cache exists at {cache_path}: {exc}"
        ) from exc


def build_projection_row(
    delta_frame: pd.DataFrame,
    minimum_pct: float,
    lookback_days: int,
    source_mode: str,
) -> Dict[str, object]:
    if delta_frame.empty:
        raise ValueError("No usable rows found after parsing.")

    windowed = delta_frame.tail(lookback_days).copy()
    if windowed.empty:
        raise ValueError("No rows available in requested lookback window.")

    last = windowed.iloc[-1]
    last_date = pd.Timestamp(last["day"])
    current_level = float(last["fill_level_pct"])

    rates = windowed["delta_pct_per_day"].dropna()
    if rates.empty:
        raise ValueError("No daily change values available to compute projections.")

    rate_min = float(rates.min())
    rate_max = float(rates.max())
    rate_avg = float(rates.mean())
    rate_min_20 = rate_min - abs(rate_min) * 0.2
    rate_max_20 = rate_max + abs(rate_max) * 0.2

    scenario_rates = OrderedDict(
        [
            ("optimistic_20pct_lower_withdrawal", rate_max_20),
            ("smallest_withdrawal", rate_max),
            ("average_withdrawal", rate_avg),
            ("largest_withdrawal", rate_min),
            ("pessimistic_20pct_higher_withdrawal", rate_min_20),
        ]
    )

    now_utc = dt.datetime.now(dt.timezone.utc)
    now_berlin = now_utc.astimezone(ZoneInfo("Europe/Berlin"))

    row: Dict[str, object] = {
        "run_timestamp_utc": now_utc.isoformat(),
        "run_date_berlin": now_berlin.date().isoformat(),
        "data_source_mode": source_mode,
        "source_url_a": URL_A,
        "source_url_b": URL_B,
        "lookback_days": lookback_days,
        "minimum_threshold_pct": minimum_pct,
        "latest_data_date": last_date.date().isoformat(),
        "current_fill_level_pct": round(current_level, 4),
        "rate_min_pct_per_day": round(rate_min, 6),
        "rate_avg_pct_per_day": round(rate_avg, 6),
        "rate_max_pct_per_day": round(rate_max, 6),
    }

    for scenario_key, rate in scenario_rates.items():
        rate_col = f"{scenario_key}_rate_pct_per_day"
        target_col = f"{scenario_key}_target_date"
        days_col = f"{scenario_key}_days_to_min"

        row[rate_col] = round(float(rate), 6)
        if rate >= 0:
            row[target_col] = ""
            row[days_col] = ""
            continue

        days_to_min = max((current_level - minimum_pct) / abs(rate), 0.0)
        target_date = (last_date + pd.to_timedelta(days_to_min, unit="D")).date()
        row[target_col] = target_date.isoformat()
        row[days_col] = round(days_to_min, 3)

    return row


def append_projection_row(projections_path: Path, row: Dict[str, object]) -> None:
    projections_path.parent.mkdir(parents=True, exist_ok=True)
    row_frame = pd.DataFrame([row])

    if projections_path.exists() and projections_path.stat().st_size > 0:
        existing = pd.read_csv(projections_path)
        for column in existing.columns:
            if column not in row_frame.columns:
                row_frame[column] = ""
        for column in row_frame.columns:
            if column not in existing.columns:
                existing[column] = ""
        merged = pd.concat([existing, row_frame[existing.columns]], ignore_index=True)
    else:
        merged = row_frame

    merged.to_csv(projections_path, index=False)


def print_console_summary(row: Dict[str, object]) -> None:
    print(f"Projektion #Gasspeicher DE vom {row['run_date_berlin']}")
    print(
        f"Fuellstand {row['current_fill_level_pct']}% am {row['latest_data_date']} "
        f"(Minimum {row['minimum_threshold_pct']}%)"
    )
    print(f"Datenquelle url_b wurde geladen aus: {row['data_source_mode']}")
    print()
    print("Szenarien - Minimum wird erreicht am:")

    for scenario_key, scenario_label in SCENARIOS.items():
        target_col = f"{scenario_key}_target_date"
        rate_col = f"{scenario_key}_rate_pct_per_day"
        days_col = f"{scenario_key}_days_to_min"
        target = row[target_col] if row[target_col] else "nicht erreicht (nicht-negative Rate)"
        print(
            f"- {scenario_label}: {target} | "
            f"Rate {row[rate_col]}%/Tag | Tage bis Minimum {row[days_col]}"
        )

    print()
    print("Datenquelle: @bnetza")
    print("Analyse: @ProfVolz")


def format_number(value: object, decimals: int = 6) -> str:
    number = float(value)
    text = f"{number:.{decimals}f}".rstrip("0").rstrip(".")
    return text if text else "0"


def build_projection_block_lines(row: Dict[str, object]) -> list[str]:
    lines = [
        "```text",
        f"Projektion #Gasspeicher DE vom {row['run_date_berlin']}",
        (
            f"Fuellstand {format_number(row['current_fill_level_pct'], 4)}% am "
            f"{row['latest_data_date']}"
        ),
        (
            "Kritisches Minimum "
            f"{format_number(row['minimum_threshold_pct'], 2)}% "
            "(Entnahmerate bricht stark ein)"
        ),
        "",
        "Szenarien - Minimum wird erreicht am:",
        "",
    ]

    for scenario_key, scenario_label in SCENARIOS.items():
        target_col = f"{scenario_key}_target_date"
        rate_col = f"{scenario_key}_rate_pct_per_day"
        target_date = row[target_col] if row[target_col] else "nicht erreicht (nicht-negative Rate)"
        rate_text = format_number(row[rate_col], 6)
        lines.extend(
            [
                str(target_date),
                scenario_label,
                f"({rate_text}%/Tag)",
                "",
            ]
        )

    if lines[-1] == "":
        lines.pop()
    lines.append("```")
    return lines


def update_readme_projection(readme_path: Path, row: Dict[str, object]) -> None:
    if not readme_path.exists():
        print(f"[WARN] README not found at {readme_path}; skipping README update.", file=sys.stderr)
        return

    readme_lines = readme_path.read_text(encoding="utf-8").splitlines()

    heading_idx = None
    for idx, line in enumerate(readme_lines):
        if line.strip() == PROJECTION_SECTION_HEADING:
            heading_idx = idx
            break

    if heading_idx is None:
        print(
            f"[WARN] Heading '{PROJECTION_SECTION_HEADING}' not found; skipping README update.",
            file=sys.stderr,
        )
        return

    start_idx = None
    end_idx = None
    for idx in range(heading_idx + 1, len(readme_lines)):
        if readme_lines[idx].strip() == "```text":
            start_idx = idx
            break

    if start_idx is None:
        print("[WARN] Projection code block start not found; skipping README update.", file=sys.stderr)
        return

    for idx in range(start_idx + 1, len(readme_lines)):
        if readme_lines[idx].strip() == "```":
            end_idx = idx
            break

    if end_idx is None:
        print("[WARN] Projection code block end not found; skipping README update.", file=sys.stderr)
        return

    new_block = build_projection_block_lines(row)
    updated = readme_lines[:start_idx] + new_block + readme_lines[end_idx + 1 :]
    readme_path.write_text("\n".join(updated) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compute German gas storage projections and persist outputs."
    )
    parser.add_argument(
        "--minimum",
        type=float,
        default=20.0,
        help="Critical storage threshold in percent (default: 20).",
    )
    parser.add_argument(
        "--lookback-days",
        type=int,
        default=30,
        help="Rolling window for rate calculation (default: 30).",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data",
        help="Directory for cached source data and outputs.",
    )
    parser.add_argument(
        "--cache-file",
        type=str,
        default="bnetza_cache.csv",
        help="Filename for cached url_b content inside --data-dir.",
    )
    parser.add_argument(
        "--projections-file",
        type=str,
        default="projections.csv",
        help="Filename for appended projection history inside --data-dir.",
    )
    parser.add_argument(
        "--readme-file",
        type=Path,
        default=DEFAULT_README_PATH,
        help="README that contains the 'Letzte Projektionen' code block to update in-place.",
    )
    parser.add_argument(
        "--skip-readme-update",
        action="store_true",
        help="Skip updating README projection block.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    data_dir: Path = args.data_dir
    cache_path = data_dir / args.cache_file
    projections_path = data_dir / args.projections_file

    csv_text, source_mode = fetch_url_b_with_cache(URL_B, cache_path=cache_path)
    delta_frame = parse_bnetza_csv(csv_text)
    row = build_projection_row(
        delta_frame=delta_frame,
        minimum_pct=float(args.minimum),
        lookback_days=int(args.lookback_days),
        source_mode=source_mode,
    )
    append_projection_row(projections_path, row)
    if not args.skip_readme_update:
        update_readme_projection(args.readme_file, row)
    print_console_summary(row)
    print(f"\nErgebnis geschrieben nach: {projections_path}")
    print(f"Cache-Datei: {cache_path}")
    if not args.skip_readme_update:
        print(f"README aktualisiert: {args.readme_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
