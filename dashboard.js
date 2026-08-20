const CSV_URL = "data/projections.csv";
const EU_CSV_URL = "data/eu_storage.csv";
const EU_TARGET_DATE = "2026-11-01";
const EU_TARGET_FILL = 80;
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
  euProjection: null,
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

function daysBetweenDates(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  return Math.round((end - start) / 86400000);
}

function euRateText(value) {
  const parsed = number(value);
  if (parsed === null) return "--";
  return `${parsed > 0 ? "+" : ""}${parsed.toFixed(2)}pp/Tag`;
}

function parseEuCsv(text) {
  return parseCsv(text)
    .map((row) => ({
      date: row.date,
      value: number(row.fill_pct),
      source: row.source,
    }))
    .filter((row) => row.date && row.value !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
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

function renderEuChart(points, latest, projection) {
  const svg = document.getElementById("eu-chart");
  const width = 960;
  const height = 360;
  const padding = { left: 54, right: 30, top: 24, bottom: 54 };
  const chartBottom = height - padding.bottom;
  const firstDate = points[0].date;
  const totalDays = Math.max(daysBetweenDates(firstDate, EU_TARGET_DATE), 1);
  const x = (date) =>
    padding.left +
    (daysBetweenDates(firstDate, date) / totalDays) *
      (width - padding.left - padding.right);
  const y = (value) =>
    chartBottom - (Math.max(0, Math.min(100, value)) / 100) *
      (chartBottom - padding.top);
  const line = points.map((point) => `${x(point.date)},${y(point.value)}`).join(" ");
  const area = `${x(firstDate)},${chartBottom} ${line} ${x(latest.date)},${chartBottom}`;
  const targetY = y(EU_TARGET_FILL);
  const normY = y(latest.value + 9.5);
  const projectionLine = `${x(latest.date)},${y(latest.value)} ${x(EU_TARGET_DATE)},${y(projection.projected)}`;

  svg.innerHTML = `
    <defs>
      <linearGradient id="eu-area-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#6e7bd9" stop-opacity="0.28"></stop>
        <stop offset="1" stop-color="#6e7bd9" stop-opacity="0.02"></stop>
      </linearGradient>
    </defs>
    <line class="eu-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(20)}" y2="${y(20)}"></line>
    <line class="eu-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(50)}" y2="${y(50)}"></line>
    <line class="eu-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(90)}" y2="${y(90)}"></line>
    <line class="eu-norm" x1="${padding.left}" x2="${width - padding.right}" y1="${normY}" y2="${normY}"></line>
    <line class="eu-target" x1="${padding.left}" x2="${width - padding.right}" y1="${targetY}" y2="${targetY}"></line>
    <polygon class="eu-area" points="${area}"></polygon>
    <polyline class="eu-line" points="${line}"></polyline>
    <polyline class="eu-projection" points="${projectionLine}"></polyline>
    <circle class="eu-current-dot" cx="${x(latest.date)}" cy="${y(latest.value)}" r="6"></circle>
    <circle class="eu-target-dot" cx="${x(EU_TARGET_DATE)}" cy="${y(projection.projected)}" r="6"></circle>
    <text class="eu-axis-label" x="${padding.left}" y="${y(90) - 8}">90%</text>
    <text class="eu-axis-label eu-axis-target" x="${padding.left + 84}" y="${targetY - 8}">80% · Ziel 1. Nov</text>
    <text class="eu-axis-label" x="${width - padding.right}" y="${normY - 8}" text-anchor="end">5-Jahres-Norm ≈${(latest.value + 9.5).toFixed(0)}%</text>
    <text class="eu-callout" x="${x(latest.date) - 12}" y="${y(latest.value) + 30}" text-anchor="end">${pct(latest.value)}</text>
    <text class="eu-callout-muted" x="${x(latest.date) - 12}" y="${y(latest.value) + 47}" text-anchor="end">${dateText(latest.date)} · GIE direct read</text>
    <text class="eu-projection-label" x="${x(EU_TARGET_DATE) - 8}" y="${y(projection.projected) - 18}" text-anchor="end">≈${projection.projected.toFixed(1)}% am 1. Nov</text>
    <text class="eu-axis-label" x="${padding.left}" y="${height - 16}">${dateText(firstDate)}</text>
    <text class="eu-axis-label" x="${x(latest.date)}" y="${height - 16}" text-anchor="middle">${dateText(latest.date)}</text>
    <text class="eu-axis-label" x="${width - padding.right}" y="${height - 16}" text-anchor="end">${dateText(EU_TARGET_DATE)}</text>
  `;
}

function renderEuTrajectory(rows) {
  if (rows.length < 2) throw new Error("EU trajectory needs at least two observations.");
  const latest = rows.at(-1);
  const cutoff = new Date(`${latest.date}T00:00:00`);
  cutoff.setDate(cutoff.getDate() - 30);
  const recentRows = rows.filter((row) => new Date(`${row.date}T00:00:00`) >= cutoff);
  const anchor = recentRows[0] || rows.at(-2);
  const elapsedDays = Math.max(daysBetweenDates(anchor.date, latest.date), 1);
  const rate = (latest.value - anchor.value) / elapsedDays;
  const remainingDays = Math.max(daysBetweenDates(latest.date, EU_TARGET_DATE), 1);
  const requiredRate = (EU_TARGET_FILL - latest.value) / remainingDays;
  const projected = latest.value + rate * remainingDays;
  const normEstimate = latest.value + 9.5;
  const projection = { latest, anchor, rate, requiredRate, projected, remainingDays };
  state.euProjection = projection;

  document.getElementById("eu-current-fill").textContent = pct(latest.value);
  document.getElementById("eu-current-date").textContent = `${dateText(latest.date)} · ${latest.source}`;
  document.getElementById("eu-norm-fill").textContent = `≈${normEstimate.toFixed(0)}%`;
  document.getElementById("eu-norm-gap").textContent = `${(latest.value - normEstimate).toFixed(1)}pp vs. Norm`;
  document.getElementById("eu-recent-rate").textContent = euRateText(rate);
  document.getElementById("eu-required-rate").textContent = euRateText(requiredRate);
  document.getElementById("eu-projected-fill").textContent = `${projected.toFixed(1)}%`;
  const status = document.getElementById("eu-projection-status");
  status.textContent = projected >= EU_TARGET_FILL
    ? `≈${projected.toFixed(1)}% bei aktuellem Tempo · im Zielkorridor`
    : `≈${projected.toFixed(1)}% bei aktuellem Tempo · ${Math.abs(projected - EU_TARGET_FILL).toFixed(1)}pp unter Ziel`;
  status.dataset.tone = projected >= EU_TARGET_FILL ? "ok" : "warn";
  renderEuChart(rows, latest, projection);
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
  const summary = [
    `Gasspeicher Deutschland ${dateText(latest.latest_data_date)}:`,
    `${pct(fill)} Füllstand, Status ${statusLabel},`,
    `${signedPercentagePoints(fill - minimum)} zur kritischen Schwelle ${pct(minimum)}.`,
    `30-Tage-Trend ${signedPct(averageRate)}.`,
    `Durchschnittsszenario: ${outcome.title}.`,
  ];
  if (state.euProjection) {
    summary.push(
      `EU ${dateText(state.euProjection.latest.date)}: ${pct(state.euProjection.latest.value)} Füllstand, Projektion ${state.euProjection.projected.toFixed(1)}% bis 1. November bei ${euRateText(state.euProjection.rate)}.`,
    );
  }
  summary.push("https://volzinnovation.github.io/de-gas-storage-tracker-bnetza/");
  return summary.join(" ");
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
  try {
    const euResponse = await fetch(EU_CSV_URL);
    if (!euResponse.ok) throw new Error(`EU CSV request failed: ${euResponse.status}`);
    const euRows = parseEuCsv(await euResponse.text());
    renderEuTrajectory(euRows);
    document.getElementById("load-status").textContent =
      `${rows.length} deutsche Projektionslaeufe und ${euRows.length} EU-Messpunkte geladen. Letzter Lauf: ${dateText(
        state.latest.run_date_berlin,
      )}.`;
  } catch (error) {
    console.error(error);
    document.getElementById("eu-projection-status").textContent =
      "EU-Daten konnten nicht geladen werden.";
    document.getElementById("load-status").textContent =
      `${rows.length} deutsche Projektionslaeufe geladen. EU-Snapshot nicht verfügbar.`;
  }
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
