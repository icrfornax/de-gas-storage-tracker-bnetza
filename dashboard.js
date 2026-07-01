const CSV_URL = "data/projections.csv";
const RING_CIRCUMFERENCE = 704;
const SCENARIOS = [
  ["Optimistisch", "optimistic_20pct_lower_withdrawal"],
  ["Kleinste Entnahme", "smallest_withdrawal"],
  ["Durchschnittliche Entnahme", "average_withdrawal"],
  ["Groesste Entnahme", "largest_withdrawal"],
  ["Pessimistisch", "pessimistic_20pct_higher_withdrawal"],
];

const state = {
  latest: null,
  rows: [],
};

function parseCsv(text) {
  const rows = [];
  let cell = "";
  let row = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const [header, ...body] = rows;
  return body.map((values) =>
    Object.fromEntries(header.map((key, index) => [key, values[index] || ""])),
  );
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pct(value, digits = 2) {
  const parsed = number(value);
  return parsed === null ? "--" : `${parsed.toFixed(digits)}%`;
}

function signedPct(value) {
  const parsed = number(value);
  if (parsed === null) return "--";
  return `${parsed > 0 ? "+" : ""}${parsed.toFixed(3)}%/Tag`;
}

function signedPercentagePoints(value) {
  const parsed = number(value);
  if (parsed === null) return "--";
  return `${parsed > 0 ? "+" : ""}${parsed.toFixed(2)} Prozentpunkte`;
}

function dateText(value) {
  if (!value) return "--";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(date);
}

function daysBetween(startDate, days) {
  const date = new Date(`${startDate}T00:00:00`);
  date.setDate(date.getDate() + Math.ceil(days));
  return date.toISOString().slice(0, 10);
}

function setRing(element, value) {
  const clamped = Math.max(0, Math.min(100, number(value) || 0));
  element.style.strokeDashoffset = String(
    RING_CIRCUMFERENCE * (1 - clamped / 100),
  );
}

function reserveStatus(fill, minimum) {
  if (fill <= minimum) return ["kritisch", "danger"];
  if (fill <= minimum + 10) return ["eng", "warn"];
  if (fill >= 80) return ["komfortabel", "ok"];
  return ["beobachten", "ok"];
}

function scenarioOutcome(fill, minimum, rate, dataDate) {
  if (rate === null) return { title: "Keine Rate", detail: "Szenario ohne Wert." };
  if (rate < 0) {
    const days = (fill - minimum) / Math.abs(rate);
    return {
      title: `${Math.ceil(days)} Tage bis ${pct(minimum, 0)}`,
      detail: `Bei ${signedPct(rate)} wird die Schwelle um ${dateText(
        daysBetween(dataDate, days),
      )} erreicht.`,
    };
  }
  if (rate === 0) {
    return {
      title: "Stabil",
      detail: "Bei 0,000%/Tag bleibt der Speicherstand rechnerisch konstant.",
    };
  }
  const daysToFull = (95 - fill) / rate;
  return {
    title: `${Math.ceil(daysToFull)} Tage bis 95%`,
    detail: `Bei ${signedPct(rate)} steigt die Reserve rechnerisch bis ${dateText(
      daysBetween(dataDate, daysToFull),
    )} auf 95%.`,
  };
}

function renderHero(latest) {
  const fill = number(latest.current_fill_level_pct) || 0;
  const minimum = number(latest.minimum_threshold_pct) || 20;
  const [label, tone] = reserveStatus(fill, minimum);
  document.getElementById("fill-level").textContent = pct(fill);
  document.getElementById("data-date").textContent = dateText(latest.latest_data_date);
  document.getElementById("minimum-threshold").textContent = pct(minimum);
  document.getElementById("average-rate").textContent = signedPct(
    latest.rate_avg_pct_per_day,
  );
  const status = document.getElementById("reserve-status");
  status.textContent = label;
  status.dataset.tone = tone;
  setRing(document.getElementById("fill-ring"), fill);
  setRing(document.getElementById("threshold-ring"), minimum);
}

function renderTrend(rows, latest) {
  const svg = document.getElementById("trend-chart");
  const points = rows
    .map((row) => ({
      date: row.latest_data_date,
      value: number(row.current_fill_level_pct),
    }))
    .filter((row) => row.date && row.value !== null);
  if (!points.length) return;

  const width = 960;
  const height = 300;
  const padding = { left: 54, right: 28, top: 26, bottom: 38 };
  const minValue = Math.min(0, number(latest.minimum_threshold_pct) || 20);
  const maxValue = Math.max(100, ...points.map((point) => point.value));
  const x = (index) =>
    padding.left +
    (index / Math.max(points.length - 1, 1)) *
      (width - padding.left - padding.right);
  const y = (value) =>
    height -
    padding.bottom -
    ((value - minValue) / (maxValue - minValue)) *
      (height - padding.top - padding.bottom);
  const line = points.map((point, index) => `${x(index)},${y(point.value)}`).join(" ");
  const area = `${padding.left},${height - padding.bottom} ${line} ${
    width - padding.right
  },${height - padding.bottom}`;
  const thresholdY = y(number(latest.minimum_threshold_pct) || 20);
  svg.innerHTML = `
    <line class="trend-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(100)}" y2="${y(100)}"></line>
    <line class="trend-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(50)}" y2="${y(50)}"></line>
    <line class="trend-threshold" x1="${padding.left}" x2="${width - padding.right}" y1="${thresholdY}" y2="${thresholdY}"></line>
    <polygon class="trend-area" points="${area}"></polygon>
    <polyline class="trend-line" points="${line}"></polyline>
    <text class="trend-label" x="${padding.left}" y="${y(100) - 8}">100%</text>
    <text class="trend-label" x="${padding.left}" y="${thresholdY - 8}">Minimum</text>
    <text class="trend-label" x="${padding.left}" y="${height - 10}">${dateText(points[0].date)}</text>
    <text class="trend-label" text-anchor="end" x="${width - padding.right}" y="${height - 10}">${dateText(points.at(-1).date)}</text>
  `;
}

function renderScenarios(latest) {
  const fill = number(latest.current_fill_level_pct) || 0;
  const minimum = number(latest.minimum_threshold_pct) || 20;
  const list = document.getElementById("scenario-list");
  list.innerHTML = SCENARIOS.map(([label, prefix]) => {
    const rate = number(latest[`${prefix}_rate_pct_per_day`]);
    const target = latest[`${prefix}_target_date`];
    const outcome = target
      ? `Minimum am ${dateText(target)}`
      : scenarioOutcome(fill, minimum, rate, latest.latest_data_date).title;
    return `<div class="scenario-row">
      <strong>${label}</strong>
      <span>${signedPct(rate)}</span>
      <em>${outcome}</em>
    </div>`;
  }).join("");
}

function renderCustomScenario() {
  if (!state.latest) return;
  const slider = document.getElementById("rate-slider");
  const rate = number(slider.value);
  const fill = number(state.latest.current_fill_level_pct) || 0;
  const minimum = number(state.latest.minimum_threshold_pct) || 20;
  const outcome = scenarioOutcome(
    fill,
    minimum,
    rate,
    state.latest.latest_data_date,
  );
  document.getElementById("custom-rate").textContent = signedPct(rate);
  document.getElementById("custom-outcome").textContent = outcome.title;
  document.getElementById("custom-detail").textContent = outcome.detail;
  document.getElementById("custom-label").textContent =
    rate < 0 ? "Entnahme" : rate > 0 ? "Einspeicherung" : "Konstant";
}

function buildLageSummary() {
  if (!state.latest) return "Gasspeicher-Lage wird noch geladen.";
  const latest = state.latest;
  const fill = number(latest.current_fill_level_pct) || 0;
  const minimum = number(latest.minimum_threshold_pct) || 20;
  const averageRate = number(latest.rate_avg_pct_per_day);
  const [statusLabel] = reserveStatus(fill, minimum);
  const outcome = scenarioOutcome(
    fill,
    minimum,
    averageRate,
    latest.latest_data_date,
  );
  return [
    `Gasspeicher Deutschland ${dateText(latest.latest_data_date)}:`,
    `${pct(fill)} Füllstand, Status ${statusLabel},`,
    `${signedPercentagePoints(fill - minimum)} zur kritischen Schwelle ${pct(minimum)}.`,
    `30-Tage-Trend ${signedPct(averageRate)}.`,
    `Durchschnittsszenario: ${outcome.title}.`,
    "https://volzinnovation.github.io/de-gas-storage-tracker-bnetza/",
  ].join(" ");
}

async function copyWithFallback(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_error) {
      // Fall through to the selection-based fallback for restricted contexts.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-999px";
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy command was rejected.");
    }
  } catch (error) {
    throw error;
  } finally {
    textarea.remove();
  }
}

async function copyLageSummary() {
  const button = document.getElementById("copy-summary");
  const status = document.getElementById("copy-status");
  if (!button || !status) return;
  try {
    await copyWithFallback(buildLageSummary());
    button.classList.add("is-copied");
    button.textContent = "Kopiert";
    status.textContent = "Lagebild wurde in die Zwischenablage kopiert.";
    window.setTimeout(() => {
      button.classList.remove("is-copied");
      button.textContent = "Lage kopieren";
      status.textContent = "";
    }, 1800);
  } catch (error) {
    console.error(error);
    status.textContent = "Kopieren ist in diesem Browser nicht verfügbar.";
  }
}

async function init() {
  const response = await fetch(CSV_URL);
  if (!response.ok) throw new Error(`CSV request failed: ${response.status}`);
  const rows = parseCsv(await response.text());
  state.rows = rows;
  state.latest = rows.at(-1);
  if (!state.latest) throw new Error("No projection rows found.");

  renderHero(state.latest);
  renderTrend(rows, state.latest);
  renderScenarios(state.latest);
  const averageRate = number(state.latest.rate_avg_pct_per_day);
  if (averageRate !== null) {
    document.getElementById("rate-slider").value = String(averageRate);
  }
  renderCustomScenario();
  document.getElementById("load-status").textContent =
    `${rows.length} Projektionslaeufe geladen. Letzter Lauf: ${dateText(
      state.latest.run_date_berlin,
    )}.`;
}

document
  .getElementById("rate-slider")
  .addEventListener("input", renderCustomScenario);
document
  .getElementById("copy-summary")
  ?.addEventListener("click", copyLageSummary);

init().catch((error) => {
  console.error(error);
  document.getElementById("load-status").textContent =
    "Projektionen konnten nicht geladen werden.";
});
