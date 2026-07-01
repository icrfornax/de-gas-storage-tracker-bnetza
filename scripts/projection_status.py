#!/usr/bin/env python3
"""Summarize the latest local gas-storage projection without appending data."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


SCENARIOS = [
    ("Optimistisch", "optimistic_20pct_lower_withdrawal"),
    ("Kleinste Entnahme", "smallest_withdrawal"),
    ("Durchschnittliche Entnahme", "average_withdrawal"),
    ("Groesste Entnahme", "largest_withdrawal"),
    ("Pessimistisch", "pessimistic_20pct_higher_withdrawal"),
]
UTC = timezone.utc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Print a read-only status snapshot for data/projections.csv.",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Repository root. Defaults to this script's parent repository.",
    )
    parser.add_argument(
        "--format",
        choices=("markdown", "json"),
        default="markdown",
        help="Output format.",
    )
    parser.add_argument(
        "--stale-after-days",
        type=int,
        default=3,
        help="Warn when the latest source data date is older than this many days.",
    )
    return parser.parse_args()


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def count_physical_rows(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open(newline="", encoding="utf-8") as handle:
        return max(sum(1 for _ in handle) - 1, 0)


def parse_iso_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def parse_float(value: str | None) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def file_status(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"path": str(path), "exists": False}
    stat = path.stat()
    return {
        "path": str(path),
        "exists": True,
        "bytes": stat.st_size,
        "modified_at_utc": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(),
    }


def build_status(root: Path, stale_after_days: int) -> dict[str, Any]:
    root = root.resolve()
    projections_path = root / "data" / "projections.csv"
    cache_path = root / "data" / "bnetza_cache.csv"
    rows = read_csv_rows(projections_path)
    latest = rows[-1] if rows else {}
    latest_data_date = parse_iso_date(latest.get("latest_data_date"))
    run_timestamp = parse_iso_datetime(latest.get("run_timestamp_utc"))

    today = datetime.now(UTC).date()
    source_age_days = (today - latest_data_date).days if latest_data_date else None
    is_stale = source_age_days is None or source_age_days > stale_after_days

    scenarios: list[dict[str, Any]] = []
    for label, prefix in SCENARIOS:
        target_date = latest.get(f"{prefix}_target_date") or ""
        scenarios.append(
            {
                "label": label,
                "rate_pct_per_day": parse_float(latest.get(f"{prefix}_rate_pct_per_day")),
                "target_date": target_date if target_date else None,
                "days_to_min": parse_float(latest.get(f"{prefix}_days_to_min")),
            }
        )

    checks = []
    checks.append(
        {
            "name": "projection_history_present",
            "status": "ok" if rows else "missing",
            "detail": f"{len(rows)} projection runs",
        }
    )
    checks.append(
        {
            "name": "source_data_freshness",
            "status": "warn" if is_stale else "ok",
            "detail": (
                "latest_data_date missing"
                if source_age_days is None
                else f"{source_age_days} days old"
            ),
        }
    )
    checks.append(
        {
            "name": "bnetza_cache_present",
            "status": "ok" if cache_path.exists() else "missing",
            "detail": f"{count_physical_rows(cache_path)} cached rows",
        }
    )

    return {
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "root": str(root),
        "latest_run": {
            "run_timestamp_utc": run_timestamp.isoformat() if run_timestamp else None,
            "run_date_berlin": latest.get("run_date_berlin"),
            "data_source_mode": latest.get("data_source_mode"),
            "latest_data_date": latest_data_date.isoformat() if latest_data_date else None,
            "source_age_days": source_age_days,
            "current_fill_level_pct": parse_float(latest.get("current_fill_level_pct")),
            "minimum_threshold_pct": parse_float(latest.get("minimum_threshold_pct")),
            "lookback_days": parse_float(latest.get("lookback_days")),
            "rate_min_pct_per_day": parse_float(latest.get("rate_min_pct_per_day")),
            "rate_avg_pct_per_day": parse_float(latest.get("rate_avg_pct_per_day")),
            "rate_max_pct_per_day": parse_float(latest.get("rate_max_pct_per_day")),
        },
        "scenarios": scenarios,
        "history": {
            "projection_rows": len(rows),
            "first_run_timestamp_utc": rows[0].get("run_timestamp_utc") if rows else None,
            "last_run_timestamp_utc": latest.get("run_timestamp_utc") if latest else None,
        },
        "files": {
            "projections_csv": file_status(projections_path),
            "bnetza_cache_csv": file_status(cache_path),
        },
        "checks": checks,
    }


def format_pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.2f}%"


def format_number(value: float | None) -> str:
    if value is None:
        return "n/a"
    if value.is_integer():
        return str(int(value))
    return f"{value:.3f}".rstrip("0").rstrip(".")


def render_markdown(status: dict[str, Any]) -> str:
    latest = status["latest_run"]
    lines = [
        "# Gasspeicher Projection Status",
        "",
        f"- Generated at: `{status['generated_at_utc']}`",
        f"- Projection runs: `{status['history']['projection_rows']}`",
        f"- Latest run: `{latest.get('run_timestamp_utc') or 'n/a'}`",
        f"- Source mode: `{latest.get('data_source_mode') or 'n/a'}`",
        f"- Latest source data date: `{latest.get('latest_data_date') or 'n/a'}`",
        f"- Source age: `{latest.get('source_age_days') if latest.get('source_age_days') is not None else 'n/a'}` days",
        f"- Fill level: `{format_pct(latest.get('current_fill_level_pct'))}`",
        f"- Minimum threshold: `{format_pct(latest.get('minimum_threshold_pct'))}`",
        "",
        "## Scenario Snapshot",
        "",
        "| Scenario | Rate pct/day | Target date | Days to minimum |",
        "| --- | ---: | --- | ---: |",
    ]
    for scenario in status["scenarios"]:
        lines.append(
            "| {label} | {rate} | {target} | {days} |".format(
                label=scenario["label"],
                rate=format_number(scenario["rate_pct_per_day"]),
                target=scenario["target_date"] or "not reached",
                days=format_number(scenario["days_to_min"]),
            )
        )
    lines.extend(["", "## Checks", ""])
    for check in status["checks"]:
        lines.append(f"- `{check['status']}` {check['name']}: {check['detail']}")
    return "\n".join(lines) + "\n"


def main() -> int:
    args = parse_args()
    status = build_status(args.root, args.stale_after_days)
    if args.format == "json":
        print(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(render_markdown(status), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
