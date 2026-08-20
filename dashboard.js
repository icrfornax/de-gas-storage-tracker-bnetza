const CSV_URL = "data/projections.csv";
const GIE_CSV_URL = "data/gie_storage.csv";
const CAPACITY_URL = "data/de_storage_capacity.json";
const EU_TARGET_DATE = "2026-11-01";
const EU_TARGET_FILL = 80;
const TRAJECTORY_START_DATE = "2025-11-01";
const DEFAULT_CAPACITY = {
  technical_max_injection_gwh_per_day: 3936.52,
  technical_max_injection_pct_per_day: 1.642,
};
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
  deProjection: null,
  capacity: DEFAULT_CAPACITY,
  targetRate: null,
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

function parseGieCsv(text, scope) {
  return parseCsv(text)
    .filter((row) => row.scope === scope)
    .map((row) => ({
      date: row.date,
      value: number(row.fill_pct),
      norm: number(row.norm_5y_fill_pct),
      source: row.source,
    }))
    .filter((row) => row.date && row.value !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function targetProjection(fill, rate, dataDate) {
  const days = Math.max(daysBetweenDates(dataDate, EU_TARGET_DATE), 0);
  const projected = fill + rate * days;
  return {
    days,
    projected,
    shortfall: EU_TARGET_FILL - projected,
    met: projected >= EU_TARGET_FILL,
  };
}

function sliderRatePosition(rate) {
  const slider = document.getElementById("rate-slider");
  const min = number(slider.min) ?? -1.5;
  const max = number(slider.max) ?? 1.642;
  return Math.max(0, Math.min(100, ((rate - min) / (max - min)) * 100));
}

function positionSliderMarker(id, rate, label) {
  const marker = document.getElementById(id);
  if (!marker || rate === null) return;
  marker.style.left = `${sliderRatePosition(rate)}%`;
  marker.querySelector("span").textContent = label;
  marker.setAttribute("aria-label", label);
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

function renderTrajectoryChart(chartId, points, latest, projection) {
  const svg = document.getElementById(chartId);
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
  const normY = y(projection.normEstimate);
  const projectionLine = `${x(latest.date)},${y(latest.value)} ${x(EU_TARGET_DATE)},${y(projection.projected)}`;

  svg.innerHTML = `
    <defs>
      <linearGradient id="${chartId}-area-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#6e7bd9" stop-opacity="0.28"></stop>
        <stop offset="1" stop-color="#6e7bd9" stop-opacity="0.02"></stop>
      </linearGradient>
    </defs>
    <line class="eu-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(20)}" y2="${y(20)}"></line>
    <line class="eu-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(50)}" y2="${y(50)}"></line>
    <line class="eu-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(90)}" y2="${y(90)}"></line>
    <line class="eu-norm" x1="${padding.left}" x2="${width - padding.right}" y1="${normY}" y2="${normY}"></line>
    <line class="eu-target" x1="${padding.left}" x2="${width - padding.right}" y1="${targetY}" y2="${targetY}"></line>
    <polygon class="eu-area" style="fill: url(#${chartId}-area-fill)" points="${area}"></polygon>
    <polyline class="eu-line" points="${line}"></polyline>
    <polyline class="eu-projection" points="${projectionLine}"></polyline>
    <circle class="eu-current-dot" cx="${x(latest.date)}" cy="${y(latest.value)}" r="6"></circle>
    <circle class="eu-target-dot" cx="${x(EU_TARGET_DATE)}" cy="${y(projection.projected)}" r="6"></circle>
    <text class="eu-axis-label" x="${padding.left}" y="${y(90) - 8}">90%</text>
    <text class="eu-axis-label eu-axis-target" x="${padding.left + 84}" y="${targetY - 8}">80% · Ziel 1. Nov</text>
    <text class="eu-axis-label" x="${width - padding.right}" y="${normY - 8}" text-anchor="end">5-Jahres-Norm ≈${projection.normEstimate.toFixed(1)}%</text>
    <text class="eu-callout" x="${x(latest.date) - 12}" y="${y(latest.value) + 30}" text-anchor="end">${pct(latest.value)}</text>
    <text class="eu-callout-muted" x="${x(latest.date) - 12}" y="${y(latest.value) + 47}" text-anchor="end">${dateText(latest.date)} · GIE direct read</text>
    <text class="eu-projection-label" x="${x(EU_TARGET_DATE) - 8}" y="${y(projection.projected) - 18}" text-anchor="end">≈${projection.projected.toFixed(1)}% am 1. Nov</text>
    <text class="eu-axis-label" x="${padding.left}" y="${height - 16}">${dateText(firstDate)}</text>
    <text class="eu-axis-label" x="${x(latest.date)}" y="${height - 16}" text-anchor="middle">${dateText(latest.date)}</text>
    <text class="eu-axis-label" x="${width - padding.right}" y="${height - 16}" text-anchor="end">${dateText(EU_TARGET_DATE)}</text>
  `;
}

function renderWinterReserveLab(latest) {
  const fill = number(latest.current_fill_level_pct) || 0;
  const currentRate = number(latest.rate_avg_pct_per_day) || 0;
  const target = targetProjection(fill, 0, latest.latest_data_date);
  const requiredRate = target.days > 0
    ? (EU_TARGET_FILL - fill) / target.days
    : 0;
  state.targetRate = requiredRate;

  const slider = document.getElementById("rate-slider");
  const technicalRate = number(state.capacity.technical_max_injection_pct_per_day)
    || DEFAULT_CAPACITY.technical_max_injection_pct_per_day;
  const sliderMax = technicalRate;
  slider.max = sliderMax.toFixed(3);
  document.getElementById("slider-max-label").textContent = `+${sliderMax.toFixed(3).replace(".", ",")}%/Tag`;
  document.getElementById("target-rate-detail").textContent =
    `Erforderlich: ${signedPct(requiredRate)} bis ${dateText(EU_TARGET_DATE)} · ` +
    `aktuelle 30-Tage-Rate: ${signedPct(currentRate)} · ` +
    `zusätzlich nötig: ${signedPercentagePoints(requiredRate - currentRate)}/Tag.`;
  positionSliderMarker(
    "required-rate-marker",
    requiredRate,
    `Erforderlich ${signedPct(requiredRate)}`,
  );
  positionSliderMarker(
    "technical-rate-marker",
    technicalRate,
    `Technisches Maximum ${signedPct(technicalRate)}`,
  );
}

function renderCustomScenario() {
  if (!state.latest) return;
  const slider = document.getElementById("rate-slider");
  const rate = number(slider.value) || 0;
  const fill = number(state.latest.current_fill_level_pct) || 0;
  const target = targetProjection(fill, rate, state.latest.latest_data_date);
  const outcome = document.getElementById("custom-outcome");
  const detail = document.getElementById("custom-detail");
  const labResult = document.getElementById("lab-result");

  document.getElementById("custom-rate").textContent = signedPct(rate);
  document.getElementById("custom-label").textContent = "80%-Zielprüfung";
  outcome.dataset.tone = target.met ? "ok" : "danger";
  labResult.dataset.tone = target.met ? "ok" : "danger";
  outcome.textContent = target.met
    ? `Ausreichend bis ${dateText(EU_TARGET_DATE)}`
    : `Nicht ausreichend bis ${dateText(EU_TARGET_DATE)}`;
  detail.textContent = target.met
    ? `Bei ${signedPct(rate)}: ${pct(target.projected)} am Zieltermin, ${target.projected - EU_TARGET_FILL > 0 ? "+" : ""}${(target.projected - EU_TARGET_FILL).toFixed(1)}pp über dem 80%-Ziel.`
    : `Bei ${signedPct(rate)}: ${pct(target.projected)} am Zieltermin, es fehlen ${target.shortfall.toFixed(1)}pp zum 80%-Ziel.`;
}

function renderTrajectory(rows, config) {
  if (rows.length < 2) throw new Error(`${config.label} needs at least two observations.`);
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
  const normEstimate = latest.norm ?? latest.value + 9.5;
  const projection = { latest, anchor, rate, requiredRate, projected, remainingDays, normEstimate };
  state[config.stateKey] = projection;

  document.getElementById(config.currentFillId).textContent = pct(latest.value);
  document.getElementById(config.currentDateId).textContent = `${dateText(latest.date)} · ${latest.source}`;
  document.getElementById(config.normFillId).textContent = `≈${normEstimate.toFixed(1)}%`;
  document.getElementById(config.normGapId).textContent = `${(latest.value - normEstimate).toFixed(1)}pp vs. Norm`;
  document.getElementById(config.recentRateId).textContent = euRateText(rate);
  document.getElementById(config.requiredRateId).textContent = euRateText(requiredRate);
  document.getElementById(config.projectedFillId).textContent = `${projected.toFixed(1)}%`;
  const status = document.getElementById(config.statusId);
  status.textContent = projected >= EU_TARGET_FILL
    ? `≈${projected.toFixed(1)}% bei aktuellem Tempo · im Zielkorridor`
    : `≈${projected.toFixed(1)}% bei aktuellem Tempo · ${Math.abs(projected - EU_TARGET_FILL).toFixed(1)}pp unter Ziel`;
  status.dataset.tone = projected >= EU_TARGET_FILL ? "ok" : "warn";
  renderTrajectoryChart(config.chartId, rows, latest, projection);
}

function renderEuTrajectory(rows) {
  renderTrajectory(rows, {
    label: "EU trajectory",
    stateKey: "euProjection",
    currentFillId: "eu-current-fill",
    currentDateId: "eu-current-date",
    normFillId: "eu-norm-fill",
    normGapId: "eu-norm-gap",
    recentRateId: "eu-recent-rate",
    requiredRateId: "eu-required-rate",
    projectedFillId: "eu-projected-fill",
    statusId: "eu-projection-status",
    chartId: "eu-chart",
  });
}

function renderDeTrajectory(rows) {
  renderTrajectory(rows, {
    label: "DE trajectory",
    stateKey: "deProjection",
    currentFillId: "de-current-fill",
    currentDateId: "de-current-date",
    normFillId: "de-norm-fill",
    normGapId: "de-norm-gap",
    recentRateId: "de-recent-rate",
    requiredRateId: "de-required-rate",
    projectedFillId: "de-projected-fill",
    statusId: "de-projection-status",
    chartId: "de-chart",
  });
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
  const target = targetProjection(fill, averageRate || 0, latest.latest_data_date);
  const summary = [
    `Gasspeicher Deutschland ${dateText(latest.latest_data_date)}:`,
    `${pct(fill)} Füllstand, Status ${statusLabel},`,
    `${signedPercentagePoints(fill - minimum)} zur kritischen Schwelle ${pct(minimum)}.`,
    `30-Tage-Trend ${signedPct(averageRate)}.`,
    `30-Tage-Projektion: ${outcome.title}.`,
    `80%-Ziel am ${dateText(EU_TARGET_DATE)}: ${pct(target.projected)} Projektion, ${target.met ? "ausreichend" : `nicht ausreichend, ${target.shortfall.toFixed(1)}pp fehlen`}.`,
  ];
  if (state.euProjection) {
    summary.push(
      `EU ${dateText(state.euProjection.latest.date)}: ${pct(state.euProjection.latest.value)} Füllstand, Projektion ${state.euProjection.projected.toFixed(1)}% bis 1. November bei ${euRateText(state.euProjection.rate)}.`,
    );
  }
  if (state.deProjection) {
    summary.push(
      `DE-GIE-Norm ${dateText(state.deProjection.latest.date)}: ${pct(state.deProjection.normEstimate)}; Projektion ${state.deProjection.projected.toFixed(1)}% bis 1. November bei ${euRateText(state.deProjection.rate)}.`,
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
  const archiveLatest = rows.at(-1);
  if (!archiveLatest) throw new Error("No projection rows found.");
  renderScenarios(archiveLatest);
  try {
    const capacityResponse = await fetch(CAPACITY_URL);
    if (!capacityResponse.ok) throw new Error(`Capacity JSON request failed: ${capacityResponse.status}`);
    state.capacity = { ...DEFAULT_CAPACITY, ...(await capacityResponse.json()) };
  } catch (error) {
    console.warn("Capacity snapshot unavailable; using fallback.", error);
  }
  try {
    const gieResponse = await fetch(GIE_CSV_URL);
    if (!gieResponse.ok) throw new Error(`GIE CSV request failed: ${gieResponse.status}`);
    const gieText = await gieResponse.text();
    const euGieRows = parseGieCsv(gieText, "EU").filter(
      (row) => row.date >= TRAJECTORY_START_DATE,
    );
    const deGieRows = parseGieCsv(gieText, "DE").filter(
      (row) => row.date >= TRAJECTORY_START_DATE,
    );
    renderEuTrajectory(euGieRows);
    renderDeTrajectory(deGieRows);
    const deLatest = state.deProjection.latest;
    state.latest = {
      current_fill_level_pct: deLatest.value,
      latest_data_date: deLatest.date,
      rate_avg_pct_per_day: state.deProjection.rate,
      minimum_threshold_pct: 20,
    };
    renderHero(state.latest);
    renderWinterReserveLab(state.latest);
    document.getElementById("rate-slider").value = String(state.deProjection.rate);
    renderCustomScenario();
    document.getElementById("load-status").textContent =
      `${deGieRows.length} DE- und ${euGieRows.length} EU-Messpunkte aus GIE AGSI+ geladen. ` +
      `${rows.length} BNetzA-Projektionslaeufe bleiben als Archiv erhalten.`;
  } catch (error) {
    console.error(error);
    document.getElementById("eu-projection-status").textContent =
      "EU-Daten konnten nicht geladen werden.";
    document.getElementById("load-status").textContent =
      `${rows.length} BNetzA-Projektionslaeufe geladen. GIE-Daten konnten nicht geladen werden.`;
  }
}

document
  .getElementById("rate-slider")
  .addEventListener("input", renderCustomScenario);
document
  .getElementById("rate-slider")
  .addEventListener("change", renderCustomScenario);
document
  .getElementById("copy-summary")
  ?.addEventListener("click", copyLageSummary);

init().catch((error) => {
  console.error(error);
  document.getElementById("load-status").textContent =
    "Projektionen konnten nicht geladen werden.";
});
