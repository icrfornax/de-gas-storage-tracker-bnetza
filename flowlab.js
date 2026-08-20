/**
 * flow-lab.js — Flussbilanz-Labor: Zufluss · Speicher · Entnahme
 *
 * Ergänzt das Winterreserve-Cockpit um eine interaktive Flussdarstellung.
 * Läuft eigenständig (IIFE, keine globalen Bindings) und liest dieselben
 * Datendateien wie dashboard.js. Die Ladereihenfolge ist damit egal.
 *
 * Startwerte sind gemessen, nicht geraten:
 *   - Füllstand, Norm, Tagesverbrauch, Arbeitsgasvolumen und Ein-/Ausspeicher-
 *     kapazität aus der letzten DE-Zeile von data/gie_storage.csv
 *   - Der Zufluss wird so gesetzt, dass die Netto-Bilanz am Datenstand dem
 *     gemessenen 30-Tage-Tempo entspricht. Die Regler starten also exakt auf
 *     der Lage, die das Cockpit-Chart zeigt.
 *
 * Modellannahmen (bewusst offen im Quelltext, nicht in den Daten):
 *   Sektoranteile, Monatsprofile, Temperatursensitivität, Bezugsquellen-Mix.
 *
 * Das Modul bringt sein eigenes Markup mit und haengt sich vor #scenario-lab
 * ein. In index.html braucht es deshalb nur zwei Zeilen: das Stylesheet und
 * dieses Script.
 */
(() => {
  "use strict";

  const GIE_CSV_URL = "data/gie_storage.csv";
  const CAPACITY_URL = "data/de_storage_capacity.json";
  const TARGET_FILL = 80;
  const SEASON_END_MONTH_DAY = "03-31";
  const TREND_WINDOW_DAYS = 30;
  const PLAYBACK_MS = 45;

  // Fallbacks, falls die Datendateien nicht erreichbar sind.
  const DEFAULTS = {
    date: "2026-08-18",
    fill: 50.14,
    norm: 77.278,
    workingGasTwh: 246.489,
    consumption: 903.9,
    injectionCapacity: 4292.58,
    withdrawalCapacity: 7067.36,
    rate: 0.16,
  };

  // Sektoranteile am Jahresmittel des deutschen Gasverbrauchs (AGEB-Größenordnung).
  const DEMAND_SHARES = { households: 0.44, industry: 0.36, power: 0.2 };

  // Bezugsquellen-Anteile am Zufluss (Modellannahme, über die Regler veränderbar).
  const SUPPLY_SHARES = { pipeline: 0.78, lng: 0.16, domestic: 0.06 };

  // Monatsprofile (Jan..Dez) relativ zum Sektormittel; werden auf Mittelwert 1 normiert.
  const SEASON = {
    households: [2.35, 2.2, 1.75, 1.15, 0.55, 0.2, 0.13, 0.13, 0.35, 0.95, 1.7, 2.2],
    industry: [1.12, 1.12, 1.1, 1.02, 0.98, 0.92, 0.8, 0.78, 0.98, 1.08, 1.12, 1.02],
    power: [1.45, 1.35, 1.15, 0.85, 0.65, 0.62, 0.72, 0.68, 0.75, 0.95, 1.3, 1.45],
  };

  // Heizperiode: Temperaturabweichung wirkt auf Haushalte und (schwächer) Kraftwerke.
  const TEMP_NORM_C = 3;
  const TEMP_SENSITIVITY = { households: 0.06, power: 0.02 };
  const HEATING_MONTHS = new Set([9, 10, 11, 0, 1, 2]);

  // Reglerbereiche in GWh/Tag; Temperatur in °C.
  const RANGES = {
    pipeline: { min: 0, max: 2600, step: 10 },
    lng: { min: 0, max: 1200, step: 10 },
    domestic: { min: 0, max: 400, step: 5 },
    households: { min: 0, max: 2000, step: 10 },
    industry: { min: 0, max: 1600, step: 10 },
    power: { min: 0, max: 1200, step: 10 },
    temperature: { min: -8, max: 12, step: 0.5 },
  };

  const state = {
    startDate: DEFAULTS.date,
    startFill: DEFAULTS.fill,
    norm: DEFAULTS.norm,
    ppGwh: (DEFAULTS.workingGasTwh * 1000) / 100,
    injectionCapacity: DEFAULTS.injectionCapacity,
    withdrawalCapacity: DEFAULTS.withdrawalCapacity,
    consumption: DEFAULTS.consumption,
    measuredRate: DEFAULTS.rate,
    seasonEnd: "2027-03-31",
    days: 0,
    targetIndex: 0,
    targetDate: "2026-11-01",
    linearTarget: 0,
    day: 0,
    fills: [],
    playing: null,
    supply: { pipeline: 0, lng: 0, domestic: 0 },
    demand: { households: 0, industry: 0, power: 0 },
    temperature: TEMP_NORM_C,
  };

  /* ------------------------------------------------------------ Hilfsfunktionen */

  const el = (id) => document.getElementById(id);

  const nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const nf2 = new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const dateFormat = new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const gwh = (value) => `${nf0.format(Math.round(value))} GWh/Tag`;
  const signed = (value, format) => `${value >= 0 ? "+" : "−"}${format(Math.abs(value))}`;

  /** Lokales ISO-Datum. Nicht toISOString() — das rechnet nach UTC und verschiebt den Tag. */
  function isoDate(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  const parseDate = (iso) => new Date(`${iso}T00:00:00`);
  const dateText = (iso) => dateFormat.format(parseDate(iso));

  function shiftDate(iso, days) {
    const date = parseDate(iso);
    date.setDate(date.getDate() + days);
    return date;
  }

  const dayDate = (index) => shiftDate(state.startDate, index);
  const dayIso = (index) => isoDate(dayDate(index));
  const daysBetweenDates = (from, to) =>
    Math.round((parseDate(to) - parseDate(from)) / 86400000);

  function normalizeSeasonProfiles() {
    Object.keys(SEASON).forEach((sector) => {
      const profile = SEASON[sector];
      const mean = profile.reduce((sum, value) => sum + value, 0) / profile.length;
      SEASON[sector] = profile.map((value) => value / mean);
    });
  }

  /* -------------------------------------------------------------------- Modell */

  function seasonFactor(sector, month) {
    let factor = SEASON[sector][month];
    const sensitivity = TEMP_SENSITIVITY[sector];
    if (sensitivity && HEATING_MONTHS.has(month)) {
      factor *= Math.max(0.25, 1 + sensitivity * (TEMP_NORM_C - state.temperature));
    }
    return factor;
  }

  function demandOn(index) {
    const month = dayDate(index).getMonth();
    const households = state.demand.households * seasonFactor("households", month);
    const industry = state.demand.industry * seasonFactor("industry", month);
    const power = state.demand.power * seasonFactor("power", month);
    return { households, industry, power, total: households + industry + power };
  }

  const supplyTotal = () =>
    state.supply.pipeline + state.supply.lng + state.supply.domestic;

  /** Netto-Bilanz eines Tages in GWh, begrenzt durch Ein-/Ausspeicherkapazität. */
  const netOn = (index) =>
    clamp(
      supplyTotal() - demandOn(index).total,
      -state.withdrawalCapacity,
      state.injectionCapacity,
    );

  function simulate() {
    const fills = [state.startFill];
    let current = state.startFill;
    for (let index = 0; index < state.days; index += 1) {
      current = clamp(current + netOn(index) / state.ppGwh, 0, 100);
      fills.push(current);
    }
    return fills;
  }

  /** Zufluss, der ab dem gewählten Tag nötig wäre, um am 1. November 80% zu erreichen. */
  function requiredSupply(fills) {
    if (state.day >= state.targetIndex) return null;
    const current = fills[state.day];
    const days = state.targetIndex - state.day;
    let demandSum = 0;
    for (let index = state.day; index < state.targetIndex; index += 1) {
      demandSum += demandOn(index).total;
    }
    const gapPp = Math.max(0, TARGET_FILL - current);
    const perDayPp = gapPp / days;
    return {
      met: current >= TARGET_FILL,
      pp: perDayPp,
      gwh: demandSum / days + perDayPp * state.ppGwh,
      feasible: perDayPp * state.ppGwh <= state.injectionCapacity,
    };
  }

  /* ---------------------------------------------------------------- Gasflasche */

  const BOTTLE = { bottom: 434, top: 80 };
  const bottleY = (value) =>
    BOTTLE.bottom - (clamp(value, 0, 100) / 100) * (BOTTLE.bottom - BOTTLE.top);

  function renderBottleScale() {
    let markup = "";
    for (let value = 0; value <= 100; value += 20) {
      const y = bottleY(value).toFixed(1);
      markup += `<line class="flow-tick" x1="52" y1="${y}" x2="64" y2="${y}"></line>`;
      markup += `<text class="flow-tick-label" x="46" y="${bottleY(value) + 4}" text-anchor="end">${value}</text>`;
    }
    el("flow-bottle-scale").innerHTML = markup;

    const normY = bottleY(state.norm);
    el("flow-bottle-norm").setAttribute("y1", normY);
    el("flow-bottle-norm").setAttribute("y2", normY);
    el("flow-bottle-norm-label").setAttribute("y", normY - 2);
    el("flow-bottle-norm-value").setAttribute("y", normY + 11);
    el("flow-bottle-norm-value").textContent = `≈${nf1.format(state.norm)}%`;

    const targetY = bottleY(TARGET_FILL);
    el("flow-bottle-target").setAttribute("y1", targetY);
    el("flow-bottle-target").setAttribute("y2", targetY);
    el("flow-bottle-target-label").setAttribute("y", targetY - 9);
  }

  function renderBottle(fill) {
    const y = bottleY(fill);
    const body = el("flow-bottle-fill");
    body.setAttribute("y", y);
    body.setAttribute("height", Math.max(0, BOTTLE.bottom - y + 8));
    el("flow-bottle-surface").setAttribute("y", y);
    el("flow-bottle-value").textContent = `${nf2.format(fill)}%`;
  }

  /* --------------------------------------------------------------- Flusslinien */

  const SUPPLY_KEYS = ["pipeline", "lng", "domestic"];
  const DEMAND_KEYS = ["households", "industry", "power"];
  const DOCK_Y = [180, 255, 330];
  const REFERENCE_FLOW = 1400; // GWh/Tag bei voller Linienstärke

  const strokeFor = (value) => 1.5 + 8 * Math.min(1, value / REFERENCE_FLOW);
  const speedFor = (value) => Math.max(0.35, 2.4 - 1.9 * Math.min(1, value / REFERENCE_FLOW));

  function dockPoint(stageRect, viewX, viewY) {
    const rect = el("flow-bottle").getBoundingClientRect();
    return [
      rect.left - stageRect.left + (viewX / 300) * rect.width,
      rect.top - stageRect.top + (viewY / 470) * rect.height,
    ];
  }

  function flowPath(x1, y1, x2, y2) {
    const mid = ((x1 + x2) / 2).toFixed(1);
    return `M${x1.toFixed(1)},${y1.toFixed(1)} C${mid},${y1.toFixed(1)} ${mid},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  }

  function flowMarkup(path, tone, value) {
    if (value <= 0) return `<path class="flow-path flow-path-${tone} is-idle" d="${path}"></path>`;
    const width = strokeFor(value);
    return (
      `<path class="flow-path flow-path-${tone}" d="${path}" stroke-width="${width.toFixed(1)}"></path>` +
      `<path class="flow-dash flow-dash-${tone}" d="${path}" stroke-width="${Math.max(2, width * 0.9).toFixed(1)}"` +
      ` style="animation-duration:${speedFor(value).toFixed(2)}s"></path>`
    );
  }

  function renderConnectors(demand) {
    const connectors = el("flow-connectors");
    if (!connectors || window.getComputedStyle(connectors).display === "none") return;
    const stageRect = el("flow-stage").getBoundingClientRect();
    if (!stageRect.width) return;
    connectors.setAttribute("viewBox", `0 0 ${stageRect.width} ${stageRect.height}`);

    let markup = "";
    SUPPLY_KEYS.forEach((key, index) => {
      const card = document.querySelector(`[data-flow="${key}"]`);
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const [x, y] = dockPoint(stageRect, 80, DOCK_Y[index]);
      markup += flowMarkup(
        flowPath(
          rect.right - stageRect.left + 2,
          rect.top - stageRect.top + rect.height / 2,
          x - 2,
          y,
        ),
        "in",
        state.supply[key],
      );
    });
    DEMAND_KEYS.forEach((key, index) => {
      const card = document.querySelector(`[data-flow="${key}"]`);
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const [x, y] = dockPoint(stageRect, 210, DOCK_Y[index]);
      markup += flowMarkup(
        flowPath(
          x + 2,
          y,
          rect.left - stageRect.left - 2,
          rect.top - stageRect.top + rect.height / 2,
        ),
        "out",
        demand[key],
      );
    });
    connectors.innerHTML = markup;
  }

  /* ----------------------------------------------------------------- Zeitachse */

  // Plotband bewusst hoch: bei einer flachen Sparkline liegen 46% und 62% nur
  // wenige Pixel auseinander — genau der Unterschied, den die Grafik zeigen soll.
  const AXIS = { x0: 16, x1: 944, top: 16, bottom: 150 };
  const AXIS_TICK = { top: 158, week: 164, month: 172, label: 190 };
  const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

  const axisX = (index) => AXIS.x0 + (index / state.days) * (AXIS.x1 - AXIS.x0);
  const axisY = (value) =>
    AXIS.bottom - (clamp(value, 0, 100) / 100) * (AXIS.bottom - AXIS.top);

  function renderAxisScale() {
    const targetY = axisY(TARGET_FILL);
    el("flow-axis-target").setAttribute("y1", targetY);
    el("flow-axis-target").setAttribute("y2", targetY);
    el("flow-axis-target-label").setAttribute("y", targetY - 5);

    let markup = "";
    for (let index = 0; index <= state.days; index += 1) {
      const date = dayDate(index);
      const x = axisX(index).toFixed(1);
      if (date.getDay() === 1) {
        markup += `<line class="flow-axis-week" x1="${x}" y1="${AXIS_TICK.top}" x2="${x}" y2="${AXIS_TICK.week}"></line>`;
      }
      if (date.getDate() !== 1) continue;
      const isTarget = index === state.targetIndex;
      markup += `<line class="flow-axis-month${isTarget ? " is-target" : ""}" x1="${x}" y1="${AXIS_TICK.top}" x2="${x}" y2="${AXIS_TICK.month}"></line>`;
      if (isTarget) {
        markup += `<text class="flow-axis-target-text" x="${x}" y="10" text-anchor="middle">1. Nov · Ziel</text>`;
      }
      const next = new Date(date.getFullYear(), date.getMonth() + 1, 1);
      const endIndex = Math.min(state.days, daysBetweenDates(state.startDate, isoDate(next)));
      const midX = ((axisX(index) + axisX(endIndex)) / 2).toFixed(1);
      markup += `<text class="flow-axis-label" x="${midX}" y="${AXIS_TICK.label}" text-anchor="middle">${MONTHS[date.getMonth()]}</text>`;
    }
    el("flow-axis-scale").innerHTML = markup;
  }

  /**
   * Geisterlinie: dieselbe lineare Fortschreibung des gemessenen 30-Tage-Tempos,
   * die das Cockpit-Chart darueber zeichnet. Sie haengt bewusst nicht an den
   * Reglern — sie ist der Bezugspunkt, gegen den die Simulation gelesen wird.
   */
  function renderLinearReference() {
    const linear = (index) => state.startFill + state.measuredRate * index;
    state.linearTarget = clamp(linear(state.targetIndex), 0, 100);

    let path = "";
    for (let index = 0; index <= state.targetIndex; index += 1) {
      path += `${index === 0 ? "M" : "L"}${axisX(index).toFixed(1)},${axisY(linear(index)).toFixed(1)}`;
    }
    el("flow-axis-linear").setAttribute("d", path);

    // Rechts neben dem Endpunkt, mittig zur Linie: haelt Abstand zur 80%-Marke
    // oberhalb und zur Simulationskurve unterhalb.
    const label = el("flow-axis-linear-label");
    label.setAttribute("x", (axisX(state.targetIndex) + 8).toFixed(1));
    label.setAttribute("y", axisY(state.linearTarget).toFixed(1));
    label.textContent = `linear ≈${nf1.format(state.linearTarget)}%`;
  }

  function renderAxisCurve(fills) {
    let path = "";
    for (let index = 0; index <= state.days; index += 1) {
      path += `${index === 0 ? "M" : "L"}${axisX(index).toFixed(1)},${axisY(fills[index]).toFixed(1)}`;
    }
    el("flow-axis-curve").setAttribute("d", path);

    const x = axisX(state.day).toFixed(1);
    el("flow-axis-cursor").setAttribute("x1", x);
    el("flow-axis-cursor").setAttribute("x2", x);
    el("flow-axis-dot").setAttribute("cx", x);
    el("flow-axis-dot").setAttribute("cy", axisY(fills[state.day]).toFixed(1));
  }

  /* -------------------------------------------------------------------- Ausgabe */

  function renderControls() {
    el("flow-value-pipeline").textContent = gwh(state.supply.pipeline);
    el("flow-value-lng").textContent = gwh(state.supply.lng);
    el("flow-value-domestic").textContent = gwh(state.supply.domestic);
    el("flow-value-households").textContent = gwh(state.demand.households);
    el("flow-value-industry").textContent = gwh(state.demand.industry);
    el("flow-value-power").textContent = gwh(state.demand.power);
    el("flow-value-temperature").textContent =
      `${nf1.format(state.temperature).replace("-", "−")} °C`;
    el("flow-day-date").textContent = dateText(dayIso(state.day));
  }

  function renderMetrics(fills, demand) {
    el("flow-current-fill").textContent = `${nf2.format(fills[state.day])}%`;
    el("flow-current-date").textContent = `${dateText(dayIso(state.day))} · Simulation`;

    const net = netOn(state.day);
    el("flow-net").textContent = signed(net, gwh);
    const netDetail = el("flow-net-detail");
    netDetail.dataset.tone = net >= 0 ? "ok" : "warn";
    netDetail.textContent =
      `Zufluss ${nf0.format(Math.round(supplyTotal()))} − Entnahme ${nf0.format(Math.round(demand.total))} · ` +
      `${signed(net / state.ppGwh, (value) => nf2.format(value))} pp/Tag`;

    const projected = fills[state.targetIndex];
    const gap = TARGET_FILL - projected;
    el("flow-projection").textContent = `≈${nf1.format(projected)}%`;
    const detail = el("flow-projection-detail");
    if (gap > 0.05) {
      detail.dataset.tone = "warn";
      detail.textContent =
        `${nf1.format(gap)} pp unter dem 80%-Ziel · linear ≈${nf1.format(state.linearTarget)}%`;
    } else if (gap >= -0.05) {
      detail.dataset.tone = "ok";
      detail.textContent = "80%-Ziel punktgenau erreicht";
    } else {
      detail.dataset.tone = "ok";
      detail.textContent = `Ziel erreicht · ${signed(-gap, (value) => nf1.format(value))} pp Puffer`;
    }
  }

  function renderRequirement(fills) {
    const value = el("flow-required-value");
    const detail = el("flow-required-detail");
    const required = requiredSupply(fills);

    if (!required) {
      value.dataset.tone = "";
      value.textContent = "—";
      detail.textContent =
        "Das Einspeicherfenster ist geschlossen; ab hier zählt die Winterentnahme.";
      return;
    }
    if (required.met) {
      value.dataset.tone = "ok";
      value.textContent = "Ziel erreicht";
      detail.textContent = `Der simulierte Füllstand liegt am ${dateText(dayIso(state.day))} bereits bei mindestens 80%.`;
      return;
    }

    const current = supplyTotal();
    const gap = required.gwh - current;
    value.dataset.tone = gap > 0 ? "warn" : "ok";
    value.textContent = `≈${gwh(required.gwh)}`;
    detail.textContent =
      `entspricht +${nf2.format(required.pp)} pp/Tag · eingestellt: ${nf0.format(Math.round(current))} GWh/Tag · ` +
      (gap > 0 ? `Lücke ${nf0.format(Math.round(gap))} GWh/Tag` : "reicht aus") +
      (required.feasible ? "" : " · über der technischen Einspeicherkapazität");
  }

  function update() {
    state.fills = simulate();
    const demand = demandOn(state.day);
    renderControls();
    renderMetrics(state.fills, demand);
    renderBottle(state.fills[state.day]);
    renderAxisCurve(state.fills);
    renderRequirement(state.fills);
    renderConnectors(demand);
  }

  /* ---------------------------------------------------------------- Interaktion */

  const SLIDERS = [
    ["flow-slider-pipeline", "supply", "pipeline"],
    ["flow-slider-lng", "supply", "lng"],
    ["flow-slider-domestic", "supply", "domestic"],
    ["flow-slider-households", "demand", "households"],
    ["flow-slider-industry", "demand", "industry"],
    ["flow-slider-power", "demand", "power"],
  ];

  function applySliderPositions() {
    SLIDERS.forEach(([id, group, key]) => {
      const slider = el(id);
      if (!slider) return;
      const range = RANGES[key];
      state[group][key] = clamp(state[group][key], range.min, range.max);
      slider.value = String(Math.round(state[group][key]));
    });
    const temperature = el("flow-slider-temperature");
    if (temperature) temperature.value = String(state.temperature);
    const scrub = el("flow-scrub");
    if (scrub) scrub.value = String(state.day);
  }

  function stopPlayback() {
    if (!state.playing) return;
    window.clearInterval(state.playing);
    state.playing = null;
    const button = el("flow-play");
    if (!button) return;
    button.textContent = "▶";
    button.setAttribute("aria-label", "Simulation abspielen");
  }

  function togglePlayback() {
    if (state.playing) {
      stopPlayback();
      return;
    }
    if (state.day >= state.days) state.day = 0;
    const button = el("flow-play");
    button.textContent = "❚❚";
    button.setAttribute("aria-label", "Simulation anhalten");
    state.playing = window.setInterval(() => {
      state.day = Math.min(state.days, state.day + 1);
      el("flow-scrub").value = String(state.day);
      if (state.day >= state.days) stopPlayback();
      update();
    }, PLAYBACK_MS);
  }

  function bindControls() {
    SLIDERS.forEach(([id, group, key]) => {
      const slider = el(id);
      if (!slider) return;
      const range = RANGES[key];
      slider.min = String(range.min);
      slider.max = String(range.max);
      slider.step = String(range.step);
      slider.addEventListener("input", (event) => {
        stopPlayback();
        state[group][key] = number(event.target.value) ?? 0;
        update();
      });
    });

    const temperature = el("flow-slider-temperature");
    temperature.min = String(RANGES.temperature.min);
    temperature.max = String(RANGES.temperature.max);
    temperature.step = String(RANGES.temperature.step);
    temperature.addEventListener("input", (event) => {
      state.temperature = number(event.target.value) ?? TEMP_NORM_C;
      update();
    });

    const scrub = el("flow-scrub");
    scrub.min = "0";
    scrub.max = String(state.days);
    scrub.step = "1";
    scrub.addEventListener("input", (event) => {
      stopPlayback();
      state.day = clamp(number(event.target.value) ?? 0, 0, state.days);
      update();
    });

    el("flow-play")?.addEventListener("click", togglePlayback);
    el("flow-reset")?.addEventListener("click", () => {
      stopPlayback();
      seedFromData();
      applySliderPositions();
      update();
    });
    el("flow-target")?.addEventListener("click", () => {
      stopPlayback();
      applyRequiredSupply();
      applySliderPositions();
      update();
    });

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => update()).observe(el("flow-stage"));
    } else {
      window.addEventListener("resize", update);
    }
  }

  /* ----------------------------------------------------------------- Datenstand */

  function parseDeRows(text) {
    const [headerLine, ...lines] = text.trim().split(/\r?\n/);
    const header = headerLine.split(",");
    return lines
      .map((line) => {
        const values = line.split(",");
        return Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""]));
      })
      .filter((row) => row.scope === "DE" && row.date && row.fill_pct)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  function measuredRate(rows) {
    const latest = rows.at(-1);
    const cutoff = isoDate(shiftDate(latest.date, -TREND_WINDOW_DAYS));
    const anchor = rows.find((row) => row.date >= cutoff) ?? rows.at(-2);
    if (!anchor) return DEFAULTS.rate;
    const days = daysBetweenDates(anchor.date, latest.date);
    if (!days) return DEFAULTS.rate;
    return (number(latest.fill_pct) - number(anchor.fill_pct)) / days;
  }

  function applyDataset(rows) {
    const latest = rows.at(-1);
    state.startDate = latest.date;
    state.startFill = number(latest.fill_pct) ?? DEFAULTS.fill;
    state.norm = number(latest.norm_5y_fill_pct) ?? DEFAULTS.norm;
    state.ppGwh =
      ((number(latest.working_gas_volume_twh) ?? DEFAULTS.workingGasTwh) * 1000) / 100;
    state.injectionCapacity =
      number(latest.injection_capacity_gwh_per_day) ?? DEFAULTS.injectionCapacity;
    state.withdrawalCapacity =
      number(latest.withdrawal_capacity_gwh_per_day) ?? DEFAULTS.withdrawalCapacity;
    state.consumption = number(latest.consumption_gwh_per_day) ?? DEFAULTS.consumption;
    state.measuredRate = measuredRate(rows);
  }

  /**
   * Regler auf den gemessenen Zustand setzen:
   *   Entnahme = gemessener Tagesverbrauch, über das Monatsprofil aufs Jahresmittel
   *              zurückgerechnet und nach Sektoranteilen aufgeteilt.
   *   Zufluss  = Verbrauch + gemessenes 30-Tage-Einspeichertempo.
   */
  function seedFromData() {
    const month = parseDate(state.startDate).getMonth();
    const weighted = Object.entries(DEMAND_SHARES).reduce(
      (sum, [sector, share]) => sum + share * SEASON[sector][month],
      0,
    );
    const annualMean = state.consumption / weighted;
    state.demand = {
      households: annualMean * DEMAND_SHARES.households,
      industry: annualMean * DEMAND_SHARES.industry,
      power: annualMean * DEMAND_SHARES.power,
    };

    const supply = state.consumption + state.measuredRate * state.ppGwh;
    state.supply = {
      pipeline: supply * SUPPLY_SHARES.pipeline,
      lng: supply * SUPPLY_SHARES.lng,
      domestic: supply * SUPPLY_SHARES.domestic,
    };
    state.temperature = TEMP_NORM_C;
    state.day = 0;
  }

  /** Zufluss auf das Niveau heben, das bis zum 1. November für 80% nötig ist. */
  function applyRequiredSupply() {
    const required = requiredSupply(simulate());
    if (!required || required.met) return;
    const current = supplyTotal();
    const shares = current > 0
      ? {
          pipeline: state.supply.pipeline / current,
          lng: state.supply.lng / current,
          domestic: state.supply.domestic / current,
        }
      : SUPPLY_SHARES;
    state.supply = {
      pipeline: required.gwh * shares.pipeline,
      lng: required.gwh * shares.lng,
      domestic: required.gwh * shares.domestic,
    };
  }

  /** Horizont: bis zum nächsten 1. November und weiter bis zum Ende der Heizperiode. */
  function setHorizon() {
    const start = parseDate(state.startDate);
    const year = start <= parseDate(`${start.getFullYear()}-11-01`)
      ? start.getFullYear()
      : start.getFullYear() + 1;
    state.targetDate = `${year}-11-01`;
    state.seasonEnd = `${year + 1}-${SEASON_END_MONTH_DAY}`;
    state.targetIndex = Math.max(1, daysBetweenDates(state.startDate, state.targetDate));
    state.days = Math.max(
      state.targetIndex + 1,
      daysBetweenDates(state.startDate, state.seasonEnd),
    );
    el("flow-range").textContent = `${dateText(state.startDate)} – ${dateText(state.seasonEnd)}`;
  }

  function renderSourceNote(loaded) {
    el("flow-source-note").innerHTML = loaded
      ? `Startwerte aus <a href="https://agsi.gie.eu/" target="_blank" rel="noreferrer">GIE AGSI+</a> ` +
        `vom ${dateText(state.startDate)}: ${nf2.format(state.startFill)}% Füllstand, ` +
        `${nf0.format(Math.round(state.consumption))} GWh/Tag Verbrauch, Arbeitsgasvolumen ` +
        `${nf1.format((state.ppGwh * 100) / 1000)} TWh (1 Prozentpunkt ≈ ${nf0.format(Math.round(state.ppGwh))} GWh). ` +
        `Die Regler starten auf dem gemessenen 30-Tage-Tempo von ` +
        `${signed(state.measuredRate, (value) => nf2.format(value))} pp/Tag. ` +
        `Die Projektion hält den eingestellten Zufluss konstant, während die Entnahme dem ` +
        `Monats- und Temperaturprofil folgt — deshalb liegt sie unter der linearen Fortschreibung ` +
        `im Chart darüber. <strong>Sektoranteile, Monats- und Temperaturprofile sind ` +
        `Modellannahmen</strong>: eine Simulation zum Durchspielen, keine Prognose.`
      : "Datendateien nicht erreichbar; die Simulation läuft mit hinterlegten Startwerten.";
  }

  /* ------------------------------------------------------------------ Markup */

  const SECTION_MARKUP = `
<section class="eu-trajectory-section flow-section" aria-labelledby="flow-title">
  <div class="section-heading">
    <div>
      <p class="section-eyebrow">Deutschland · Flussbilanz-Labor</p>
      <h2 id="flow-title">Zufluss · Speicher · Entnahme</h2>
    </div>
    <p>
      Die Regler starten auf dem gemessenen Datenstand. Zufluss links,
      Verbrauch rechts, Speicher in der Mitte — die Zeitachse zeigt, wo
      der Füllstand damit landet.
    </p>
  </div>

  <div class="eu-trajectory-panel flow-panel">
    <div class="flow-metrics" aria-label="Simulationskennzahlen">
      <div class="flow-metric">
        <span><i class="flow-key flow-key-fill"></i>Simulierter Füllstand</span>
        <strong id="flow-current-fill">--</strong>
        <small id="flow-current-date">--</small>
      </div>
      <div class="flow-metric flow-metric-compact">
        <span><i class="flow-key flow-key-in"></i>Netto-Bilanz am Tag</span>
        <strong id="flow-net">--</strong>
        <small id="flow-net-detail">Zufluss minus Entnahme</small>
      </div>
      <div class="flow-metric flow-metric-target">
        <span><i class="flow-key flow-key-target"></i>1. Nov · bei konstantem Zufluss</span>
        <strong id="flow-projection">--</strong>
        <small id="flow-projection-detail">Ziel: 80%</small>
      </div>
    </div>

    <div class="flow-stage" id="flow-stage">
      <svg id="flow-connectors" aria-hidden="true" focusable="false"></svg>

      <div class="flow-column flow-column-in" aria-label="Zufluss: Quellen">
        <p class="flow-column-head"><i class="flow-key flow-key-in"></i>Zufluss · Quellen</p>

        <div class="flow-card" data-flow="pipeline">
          <div class="flow-card-row">
            <label for="flow-slider-pipeline">Pipeline-Importe</label>
            <span class="flow-card-value" id="flow-value-pipeline">--</span>
          </div>
          <input id="flow-slider-pipeline" type="range" value="0" />
          <small>Norwegen · Niederlande/Belgien · Frankreich</small>
        </div>

        <div class="flow-card" data-flow="lng">
          <div class="flow-card-row">
            <label for="flow-slider-lng">LNG-Terminals</label>
            <span class="flow-card-value" id="flow-value-lng">--</span>
          </div>
          <input id="flow-slider-lng" type="range" value="0" />
          <small>Wilhelmshaven · Brunsbüttel · Stade</small>
        </div>

        <div class="flow-card" data-flow="domestic">
          <div class="flow-card-row">
            <label for="flow-slider-domestic">Inland &amp; Biomethan</label>
            <span class="flow-card-value" id="flow-value-domestic">--</span>
          </div>
          <input id="flow-slider-domestic" type="range" value="0" />
          <small>Heimische Förderung · Einspeisung</small>
        </div>
      </div>

      <div class="flow-bottle-wrap">
        <svg id="flow-bottle" viewBox="0 0 300 470" role="img"
             aria-labelledby="flow-bottle-title flow-bottle-desc">
          <title id="flow-bottle-title">Speicherfüllstand als Gasflasche</title>
          <desc id="flow-bottle-desc">
            Skala von 0 bis 100 Prozent mit 80-Prozent-Ziellinie und
            5-Jahres-Norm; der Zahlenwert steht in der Flasche.
          </desc>
          <defs>
            <linearGradient id="flow-fill-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#8b96e8"></stop>
              <stop offset="1" stop-color="#6e7bd9"></stop>
            </linearGradient>
            <clipPath id="flow-bottle-clip">
              <path d="M86,412 L86,132 C86,98 110,78 131,73 L159,73 C180,78 204,98 204,132 L204,412 Q204,434 182,434 L108,434 Q86,434 86,412 Z"></path>
            </clipPath>
          </defs>

          <g id="flow-bottle-scale"></g>

          <rect class="flow-bottle-metal" x="131" y="18" width="28" height="9" rx="3"></rect>
          <rect class="flow-bottle-metal" x="139" y="26" width="12" height="20"></rect>
          <rect class="flow-bottle-metal" x="129" y="44" width="32" height="25" rx="6"></rect>

          <path class="flow-bottle-outline"
                d="M80,414 L80,130 C80,94 106,72 130,67 L160,67 C184,72 210,94 210,130 L210,414 Q210,440 184,440 L106,440 Q80,440 80,414 Z"></path>

          <g clip-path="url(#flow-bottle-clip)">
            <rect id="flow-bottle-fill" x="86" y="434" width="118" height="0"
                  fill="url(#flow-fill-gradient)" opacity="0.92"></rect>
            <rect id="flow-bottle-surface" class="flow-bottle-surface"
                  x="86" y="434" width="118" height="3"></rect>
          </g>

          <line id="flow-bottle-norm" class="flow-bottle-norm" x1="210" y1="160" x2="230" y2="160"></line>
          <text id="flow-bottle-norm-label" class="flow-bottle-norm-label" x="234" y="158">5-J.-Norm</text>
          <text id="flow-bottle-norm-value" class="flow-bottle-norm-label" x="234" y="171">≈--%</text>

          <line id="flow-bottle-target" class="flow-bottle-target" x1="62" y1="151" x2="228" y2="151"></line>
          <text id="flow-bottle-target-label" class="flow-bottle-target-label" x="64" y="142">80% · Ziel 1. Nov</text>

          <text id="flow-bottle-value" class="flow-bottle-value" x="145" y="268" text-anchor="middle">--%</text>
          <text class="flow-bottle-caption" x="145" y="290" text-anchor="middle">Füllstand</text>
        </svg>
      </div>

      <div class="flow-column flow-column-out" aria-label="Entnahme: Verbrauch">
        <p class="flow-column-head"><i class="flow-key flow-key-out"></i>Entnahme · Verbrauch</p>

        <div class="flow-card" data-flow="households">
          <div class="flow-card-row">
            <label for="flow-slider-households">Private Haushalte</label>
            <span class="flow-card-value" id="flow-value-households">--</span>
          </div>
          <input id="flow-slider-households" type="range" value="0" />
          <small>Jahresmittel · stark temperaturabhängig</small>
        </div>

        <div class="flow-card" data-flow="industry">
          <div class="flow-card-row">
            <label for="flow-slider-industry">Industrie</label>
            <span class="flow-card-value" id="flow-value-industry">--</span>
          </div>
          <input id="flow-slider-industry" type="range" value="0" />
          <small>Prozesswärme · Grundstoffe</small>
        </div>

        <div class="flow-card" data-flow="power">
          <div class="flow-card-row">
            <label for="flow-slider-power">Stromerzeugung</label>
            <span class="flow-card-value" id="flow-value-power">--</span>
          </div>
          <input id="flow-slider-power" type="range" value="0" />
          <small>Gaskraftwerke · Residuallast</small>
        </div>
      </div>
    </div>

    <div class="flow-timeline">
      <div class="flow-timeline-controls">
        <button id="flow-play" class="flow-button" type="button" aria-label="Simulation abspielen">▶</button>
        <button id="flow-reset" class="flow-button flow-button-ghost" type="button">Messwerte</button>
        <button id="flow-target" class="flow-button flow-button-ghost" type="button">Zufluss für 80%</button>
        <p class="flow-day"><small>Simulationstag</small><span id="flow-day-date">--</span></p>
        <p class="flow-timeline-legend">
          <i class="flow-key flow-key-fill"></i>Simulation ·
          <i class="flow-key flow-key-linear"></i>lineare Fortschreibung des gemessenen Tempos ·
          <span id="flow-range">--</span>
        </p>
      </div>

      <div class="flow-axis-wrap">
        <svg id="flow-axis" viewBox="0 0 960 200" role="img"
             aria-label="Zeitachse mit Wochen und Monaten sowie dem projizierten Füllstand">
          <line id="flow-axis-target" class="flow-axis-target" x1="16" y1="43" x2="944" y2="43"></line>
          <text id="flow-axis-target-label" class="flow-axis-target-text" x="20" y="38">80%</text>
          <g id="flow-axis-scale"></g>
          <path id="flow-axis-linear" class="flow-axis-linear" d=""></path>
          <text id="flow-axis-linear-label" class="flow-axis-linear-label" x="0" y="0" dominant-baseline="central">linear</text>
          <path id="flow-axis-curve" class="flow-axis-curve" d=""></path>
          <line id="flow-axis-cursor" class="flow-axis-cursor" x1="16" y1="8" x2="16" y2="158"></line>
          <circle id="flow-axis-dot" class="flow-axis-dot" cx="16" cy="83" r="5"></circle>
        </svg>
        <input id="flow-scrub" type="range" value="0" aria-label="Simulationstag wählen" />
      </div>
    </div>

    <div class="flow-foot">
      <div class="flow-required">
        <span><i class="flow-key flow-key-in"></i>Benötigter täglicher Zufluss bis 80% am 1. November</span>
        <strong id="flow-required-value">--</strong>
        <p id="flow-required-detail">--</p>
      </div>

      <div class="flow-temperature">
        <span><i class="flow-key flow-key-out"></i>Winter-Durchschnittstemperatur</span>
        <div class="flow-temperature-row">
          <input id="flow-slider-temperature" type="range" value="3"
                 aria-label="Winter-Durchschnittstemperatur in Grad Celsius" />
          <strong id="flow-value-temperature">--</strong>
        </div>
        <p class="flow-temperature-scale"><span>−8 °C</span><span>Norm ≈ +3 °C</span><span>+12 °C</span></p>
        <p>Kälter heißt mehr Entnahme in der Heizperiode (Okt–Mär).</p>
      </div>
    </div>

    <p class="flow-source-note" id="flow-source-note">Startwerte werden geladen …</p>
  </div>
</section>
`;

  /** Section vor dem Szenario-Labor einhaengen; ohne Anker ans Ende der Seite. */
  function mountSection() {
    if (el("flow-stage")) return true;
    const anchor = document.getElementById("scenario-lab");
    const host = anchor?.parentElement || document.querySelector("main") || document.body;
    if (!host) return false;
    const holder = document.createElement("div");
    holder.innerHTML = SECTION_MARKUP;
    const section = holder.firstElementChild;
    if (!section) return false;
    if (anchor) host.insertBefore(section, anchor);
    else host.append(section);
    return true;
  }

  async function init() {
    if (!mountSection()) return;
    normalizeSeasonProfiles();

    let loaded = false;
    try {
      const response = await fetch(GIE_CSV_URL);
      if (!response.ok) throw new Error(`GIE CSV request failed: ${response.status}`);
      const rows = parseDeRows(await response.text());
      if (!rows.length) throw new Error("No DE rows found.");
      applyDataset(rows);
      loaded = true;
    } catch (error) {
      console.warn("Flow-Lab: GIE-Daten nicht verfügbar, nutze Startwerte.", error);
    }

    try {
      const response = await fetch(CAPACITY_URL);
      if (response.ok) {
        const max = number((await response.json()).technical_max_injection_gwh_per_day);
        if (max) state.injectionCapacity = Math.min(state.injectionCapacity, max);
      }
    } catch (error) {
      console.warn("Flow-Lab: Kapazitäts-Snapshot nicht verfügbar.", error);
    }

    setHorizon();
    seedFromData();
    renderBottleScale();
    renderAxisScale();
    renderLinearReference();
    bindControls();
    applySliderPositions();
    renderSourceNote(loaded);
    update();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
