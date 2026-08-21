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
  const CONSUMPTION_URL = "data/de_consumption_daily.csv";
  const TARGET_FILL = 80;
  const SEASON_END_MONTH_DAY = "03-31";
  const TREND_WINDOW_DAYS = 30;
  const PLAYBACK_MS = 220;   // ~50 s fuer die ganze Heizperiode, vorher war es unlesbar schnell

  // Fallbacks, falls die Datendateien nicht erreichbar sind.
  const DEFAULTS = {
    date: "2026-08-18",
    fill: 50.14,
    norm: 77.278,
    workingGasTwh: 246.489,
    consumptionTwh: 903.9,
    injectionCapacity: 4292.58,
    withdrawalCapacity: 7067.36,
    rate: 0.16,
  };

  /**
   * Sektoranteile am deutschen Gasverbrauch.
   * Haushalte & Gewerbe: 39 % — Bundesnetzagentur, Gasversorgung 2024.
   * Die restlichen 61 % fasst die BNetzA als "Industrie" zusammen (Messung an
   * den Netzausspeisepunkten). Die Aufteilung dieser 61 % auf Industrie und
   * Stromerzeugung ist eine Modellannahme, kalibriert auf rund 150 TWh Gas
   * fuer Strom- und Waermeerzeugung.
   */
  const DEMAND_SHARES = { households: 0.39, industry: 0.43, power: 0.18 };

  /**
   * Bezugsquellen-Anteile, aus den Mengen von 2024 gerechnet:
   * Importe 865 TWh, davon 68 TWh ueber deutsche LNG-Terminals (BNetzA),
   * heimische Foerderung 40,9 TWh (BVEG). Macht 797 / 68 / 41 von 906 TWh.
   */
  const SUPPLY_SHARES = { pipeline: 0.88, lng: 0.075, domestic: 0.045 };

  /**
   * Aufteilung der RLM-Menge auf Industrie und Stromerzeugung.
   * THE misst RLM als einen Block; die Trennung ist eine Modellannahme,
   * kalibriert auf rund 150 TWh Gas fuer Strom- und Waermeerzeugung.
   */
  const RLM_SPLIT = { industry: 0.7, power: 0.3 };

  /**
   * DWD-Gebietsmittel Deutschland, Winter (Dez-Feb), in °C.
   * Dient nur der Beschriftung der Referenzjahre. Normalperiode 1991-2020: +1,4 °C.
   * Quelle: opendata.dwd.de, regional_averages_tm_winter.txt
   */
  const DWD_WINTER = {
    2019: 3.06, 2020: 4.17, 2021: 1.81, 2022: 3.28,
    2023: 2.88, 2024: 4.04, 2025: 2.16, 2026: 1.72,
  };
  const DWD_NORM_C = 1.4;

  // Reglerbereiche in GWh/Tag; Temperatur in °C.
  // Nur der Zufluss ist noch einstellbar. Die Entnahme kommt vollstaendig aus
  // den gemessenen Tageswerten des gewaehlten Gasjahres.
  const RANGES = {
    pipeline: { min: 0, max: 3000, step: 10 },
    lng: { min: 0, max: 400, step: 5 },
    domestic: { min: 0, max: 200, step: 5 },
  };

  const state = {
    startDate: DEFAULTS.date,
    startFill: DEFAULTS.fill,
    norm: DEFAULTS.norm,
    ppGwh: (DEFAULTS.workingGasTwh * 1000) / 100,
    injectionCapacity: DEFAULTS.injectionCapacity,
    withdrawalCapacity: DEFAULTS.withdrawalCapacity,
    consumptionTwh: DEFAULTS.consumptionTwh,
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
    // Gemessene Jahresmittel des Referenzjahres — Bezugspunkt der Regler.
    base: { households: 0, industry: 0, power: 0 },
    consumption: new Map(),   // Gasjahr -> Map("MM-TT" -> { slp, rlm })
    refYears: [],
    refYear: null,
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


  /* -------------------------------------------------------------------- Modell */

  /** Gasjahr laeuft von August bis Juli und wird nach dem Startjahr benannt. */
  const gasYearOf = (date) =>
    date.getMonth() >= 7 ? date.getFullYear() : date.getFullYear() - 1;

  const monthDay = (date) =>
    `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  /**
   * Gemessener Verbrauch fuer den Kalendertag des Simulationstages, entnommen
   * dem gewaehlten Referenz-Gasjahr. Der 29. Februar faellt auf den 28.
   */
  function measuredOn(index) {
    const jahr = state.consumption.get(state.refYear);
    if (!jahr) return null;
    const schluessel = monthDay(dayDate(index));
    // Der 29. Februar kommt nur in Schaltjahren vor; sonst gilt der 28.
    return jahr.get(schluessel) || (schluessel === "02-29" ? jahr.get("02-28") : null);
  }

  /**
   * Tagesbedarf in GWh.
   *   Haushalte & Gewerbe = SLP(Tag)   x  Regler / gemessenes SLP-Jahresmittel
   *   Industrie           = RLM(Tag) x 0,70 x Regler / gemessenes Jahresmittel
   *   Stromerzeugung      = RLM(Tag) x 0,30 x Regler / gemessenes Jahresmittel
   * Die Form kommt also vollstaendig aus der Messung, der Regler setzt nur das Niveau.
   */
  function demandOn(index) {
    const tag = measuredOn(index);
    const skala = (sektor, wert) =>
      state.base[sektor] > 0 ? wert * (state.demand[sektor] / state.base[sektor]) : 0;
    if (!tag) {
      const total = state.demand.households + state.demand.industry + state.demand.power;
      return { ...state.demand, total };
    }
    const households = skala("households", tag.slp);
    const industry = skala("industry", tag.rlm * RLM_SPLIT.industry);
    const power = skala("power", tag.rlm * RLM_SPLIT.power);
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

  /** Zweite Kurve: derselbe Bedarf, aber Zufluss auf Zielniveau. */
  function renderTargetPath() {
    const pfad = el("flow-axis-goal");
    if (!pfad) return;
    const zufluss = zielZufluss();
    let fill = state.startFill;
    let d = `M${axisX(0).toFixed(1)},${axisY(fill).toFixed(1)}`;
    for (let index = 0; index < state.days; index += 1) {
      const net = clamp(
        zufluss - demandOn(index).total,
        -state.withdrawalCapacity,
        state.injectionCapacity,
      );
      fill = clamp(fill + net / state.ppGwh, 0, 100);
      d += `L${axisX(index + 1).toFixed(1)},${axisY(fill).toFixed(1)}`;
    }
    pfad.setAttribute("d", d);

    const label = el("flow-axis-goal-label");
    if (!label) return;
    label.setAttribute("x", (axisX(state.targetIndex) + 8).toFixed(1));
    // Ueber die 80-%-Linie, sonst liegt die Schrift auf der gestrichelten Marke.
    label.setAttribute("y", (axisY(TARGET_FILL) - 9).toFixed(1));
    label.textContent = `Zielpfad · ${nf0.format(Math.round(zufluss))} GWh/Tag`;
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

  /** "2025/26 · Winter 1,7 °C" */
  function refYearLabel(jahr) {
    if (jahr === null || jahr === undefined) return "—";
    const kurz = `${jahr}/${String(jahr + 1).slice(2)}`;
    const temp = DWD_WINTER[jahr + 1];
    return temp === undefined
      ? kurz
      : `${kurz} · Winter ${nf1.format(temp).replace("-", "−")} °C`;
  }

  /* -------------------------------------------------------------------- Ausgabe */

  function renderControls() {
    el("flow-value-pipeline").textContent = gwh(state.supply.pipeline);
    el("flow-value-lng").textContent = gwh(state.supply.lng);
    el("flow-value-domestic").textContent = gwh(state.supply.domestic);
    // Die Entnahme aendert sich taeglich — die Karte zeigt den Wert des
    // Simulationstages, das Jahresmittel darunter ist, was der Regler stellt.
    const heute = demandOn(state.day);
    DEMAND_KEYS.forEach((sektor) => {
      el(`flow-value-${sektor}`).textContent = gwh(heute[sektor]);
      const mittel = el(`flow-mean-${sektor}`);
      if (mittel) mittel.textContent = `Jahresmittel ${gwh(state.demand[sektor])}`;
    });
    const refLabel = el("flow-value-refyear");
    if (refLabel) refLabel.textContent = refYearLabel(state.refYear);
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

    const luecke0 = el("flow-required-gap");
    if (!required) {
      value.dataset.tone = "";
      value.textContent = "—";
      if (luecke0) { luecke0.textContent = ""; luecke0.dataset.tone = ""; }
      detail.textContent =
        "Das Einspeicherfenster ist geschlossen; ab hier zählt die Winterentnahme.";
      return;
    }
    if (required.met) {
      value.dataset.tone = "ok";
      value.textContent = "Ziel erreicht";
      if (luecke0) { luecke0.textContent = ""; luecke0.dataset.tone = ""; }
      detail.textContent = `Der simulierte Füllstand liegt am ${dateText(dayIso(state.day))} bereits bei mindestens 80%.`;
      return;
    }

    const current = supplyTotal();
    const gap = required.gwh - current;
    value.dataset.tone = gap > 0 ? "warn" : "ok";
    value.textContent = `≈${gwh(required.gwh)}`;

    const luecke = el("flow-required-gap");
    if (luecke) {
      luecke.dataset.tone = gap > 0 ? "warn" : "ok";
      luecke.textContent = gap > 0
        ? `Lücke ${gwh(gap)}`
        : `Überschuss ${gwh(-gap)}`;
    }
    detail.textContent =
      `entspricht +${nf2.format(required.pp)} pp/Tag · eingestellt: ${nf0.format(Math.round(current))} GWh/Tag` +
      (required.feasible ? "" : " · über der technischen Einspeicherkapazität");
  }

  function update() {
    state.fills = simulate();
    const demand = demandOn(state.day);
    renderControls();
    renderScenario();
    renderMetrics(state.fills, demand);
    renderBottle(state.fills[state.day]);
    renderAxisCurve(state.fills);
    renderTargetPath();
    renderRequirement(state.fills);
    renderConnectors(demand);
  }

  /* ------------------------------------------------------------------ Belege */

  let popoverFest = null;
  let popoverAusloeser = null;

  function versteckeBeleg() {
    const pop = el("flow-source-popover");
    if (pop) pop.hidden = true;
    popoverAusloeser = null;
    document.querySelectorAll(".flow-info[aria-expanded=true]")
      .forEach((knopf) => knopf.setAttribute("aria-expanded", "false"));
  }

  function zeigeBeleg(key, ausloeser) {
    const beleg = SOURCES[key];
    const pop = el("flow-source-popover");
    if (!beleg || !pop) return;

    pop.innerHTML =
      `<h4>${beleg.titel}</h4>` +
      `<p><span class="flow-pop-label">Aktueller Wert</span>${beleg.aktuell}</p>` +
      `<p><span class="flow-pop-label">Maximum</span>${beleg.maximum}</p>` +
      `<p class="flow-pop-quelle">${beleg.quellen
        .map(([titel, url]) => `<a href="${url}" target="_blank" rel="noreferrer">${titel}</a>`)
        .join(" · ")}</p>`;
    pop.hidden = false;
    document.querySelectorAll(".flow-info[aria-expanded=true]")
      .forEach((knopf) => knopf.setAttribute("aria-expanded", "false"));
    ausloeser.setAttribute("aria-expanded", "true");

    popoverAusloeser = ausloeser;
    positioniereBeleg();
  }

  function positioniereBeleg() {
    const pop = el("flow-source-popover");
    if (!pop || pop.hidden || !popoverAusloeser) return;
    const rand = 12;
    const breite = Math.min(380, window.innerWidth - 2 * rand);
    pop.style.width = `${breite}px`;
    const r = popoverAusloeser.getBoundingClientRect();
    // Ausloeser aus dem Sichtfeld gescrollt: schliessen statt frei schweben.
    if (r.bottom < 0 || r.top > window.innerHeight) {
      popoverFest = null;
      versteckeBeleg();
      return;
    }
    pop.style.left = `${clamp(r.left + r.width / 2 - breite / 2, rand, window.innerWidth - breite - rand)}px`;
    pop.style.top = `${r.bottom + 10}px`;
    const hoehe = pop.getBoundingClientRect().height;
    if (r.bottom + 10 + hoehe > window.innerHeight - rand) {
      pop.style.top = `${Math.max(rand, r.top - hoehe - 10)}px`;
    }
  }

  /**
   * Ein- und Ausblenden ueber eine einzige Regel am Dokument statt ueber
   * mouseleave am Knopf: sobald der Zeiger weder auf einem Info-Knopf noch im
   * Popover steht, wird geschlossen. Die frueheren Verschwinde-Effekte kamen
   * daher, dass mouseleave feuerte, bevor der Zeiger das Popover erreichte.
   */
  function bindeBelege() {
    document.addEventListener("pointerover", (event) => {
      const knopf = event.target.closest?.(".flow-info");
      if (knopf) {
        if (!popoverFest) zeigeBeleg(knopf.dataset.info, knopf);
        return;
      }
      if (popoverFest) return;
      if (event.target.closest?.(".flow-popover")) return;
      versteckeBeleg();
    });

    document.querySelectorAll(".flow-info").forEach((knopf) => {
      knopf.setAttribute("aria-expanded", "false");
      knopf.addEventListener("focus", () => zeigeBeleg(knopf.dataset.info, knopf));
      knopf.addEventListener("blur", () => { if (!popoverFest) versteckeBeleg(); });
      // Klick heftet das Popover an — noetig auf Touch, praktisch am Desktop.
      knopf.addEventListener("click", (event) => {
        event.preventDefault();
        if (popoverFest === knopf.dataset.info) {
          popoverFest = null;
          versteckeBeleg();
        } else {
          popoverFest = knopf.dataset.info;
          zeigeBeleg(knopf.dataset.info, knopf);
        }
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      popoverFest = null;
      versteckeBeleg();
    });
    document.addEventListener("click", (event) => {
      if (!popoverFest) return;
      if (event.target.closest(".flow-info") || event.target.closest(".flow-popover")) return;
      popoverFest = null;
      versteckeBeleg();
    });
    window.addEventListener("scroll", positioniereBeleg, { passive: true });
    window.addEventListener("resize", positioniereBeleg);
  }

  /* ------------------------------------------------------------- CSV-Export */

  /**
   * Erzeugt die Tagestabelle der laufenden Simulation zum Nachrechnen.
   * Der Kommentarkopf haelt alle Annahmen und Quellen fest, damit die Datei
   * ohne diese Seite pruefbar bleibt.
   */
  function buildCsv() {
    const zufluss = supplyTotal();
    const ziel = zielZufluss();
    const kopf = [
      "# Flussbilanz-Labor — Tagestabelle der Simulation",
      `# erzeugt am: ${dateText(isoDate(new Date()))}`,
      `# Datenstand GIE AGSI+: ${state.startDate}, Fuellstand ${state.startFill} %`,
      `# Arbeitsgasvolumen: ${(state.ppGwh * 100) / 1000} TWh, 1 Prozentpunkt = ${state.ppGwh.toFixed(2)} GWh`,
      `# Einspeicherkapazitaet: ${state.injectionCapacity} GWh/Tag`,
      `# Ausspeicherkapazitaet: ${state.withdrawalCapacity} GWh/Tag`,
      `# gemessenes 30-Tage-Tempo: ${state.measuredRate.toFixed(4)} pp/Tag`,
      `# Referenz-Gasjahr fuer den Verbrauch: ${state.refYear}/${String(state.refYear + 1).slice(2)}`,
      `# eingestellter Zufluss: ${zufluss.toFixed(1)} GWh/Tag ` +
        `(Pipeline ${state.supply.pipeline.toFixed(1)}, LNG ${state.supply.lng.toFixed(1)}, ` +
        `Inland ${state.supply.domestic.toFixed(1)})`,
      `# Zielpfad-Zufluss fuer 80 % am ${state.targetDate}: ${ziel.toFixed(1)} GWh/Tag`,
      `# Reglerniveau Jahresmittel: Haushalte ${state.demand.households.toFixed(1)}, ` +
        `Industrie ${state.demand.industry.toFixed(1)}, Strom ${state.demand.power.toFixed(1)} GWh/Tag`,
      "#",
      "# Rechenweg je Tag:",
      "#   bedarf = SLP(Kalendertag im Referenzjahr) x Regler_HH / SLP-Jahresmittel",
      "#          + RLM(...) x 0,70 x Regler_IND / (RLM-Jahresmittel x 0,70)",
      "#          + RLM(...) x 0,30 x Regler_STROM / (RLM-Jahresmittel x 0,30)",
      "#   netto  = min(Einspeicherkap., max(-Ausspeicherkap., zufluss - bedarf))",
      "#   fuellstand(t+1) = fuellstand(t) + netto / GWh-je-Prozentpunkt, gedeckelt 0..100",
      "#",
      "# Quellen:",
      "#   Verbrauch: Trading Hub Europe, AggregatedConsumptionData (SLP + RLM)",
      "#   Speicher:  GIE AGSI+ API v013",
      "#   Bezugsmix: Bundesnetzagentur, Gasversorgung 2024; BVEG Jahresbericht 2024",
      "#   LNG:       Deutsche Energy Terminal",
      "#   Winter:    DWD Gebietsmittel Dez-Feb (CDC)",
      "#",
      "# Annahme, die keine Messung ist: die Trennung 70/30 zwischen Industrie und",
      "# Stromerzeugung. THE misst beide gemeinsam als RLM.",
    ].join("\n");

    const spalten = [
      "datum", "tag", "referenztag",
      "bedarf_haushalte_gwh", "bedarf_industrie_gwh", "bedarf_strom_gwh", "bedarf_gesamt_gwh",
      "zufluss_gwh", "netto_gwh", "fuellstand_pct", "zielpfad_fuellstand_pct",
    ].join(",");

    const zeilen = [];
    let zielFill = state.startFill;
    for (let index = 0; index <= state.days; index += 1) {
      const bedarf = demandOn(index);
      const netto = index < state.days ? netOn(index) : 0;
      if (index > 0) {
        const zielNetto = clamp(
          ziel - demandOn(index - 1).total,
          -state.withdrawalCapacity,
          state.injectionCapacity,
        );
        zielFill = clamp(zielFill + zielNetto / state.ppGwh, 0, 100);
      }
      zeilen.push([
        dayIso(index),
        index,
        monthDay(dayDate(index)),
        bedarf.households.toFixed(1),
        bedarf.industry.toFixed(1),
        bedarf.power.toFixed(1),
        bedarf.total.toFixed(1),
        zufluss.toFixed(1),
        netto.toFixed(1),
        state.fills[index].toFixed(3),
        zielFill.toFixed(3),
      ].join(","));
    }
    return `${kopf}\n${spalten}\n${zeilen.join("\n")}\n`;
  }

  function ladeCsvHerunter() {
    const blob = new Blob([buildCsv()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `flussbilanz_${state.startDate}_gasjahr${state.refYear}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------------------------------------------------------------- Interaktion */

  const SLIDERS = [
    ["flow-slider-pipeline", "supply", "pipeline"],
    ["flow-slider-lng", "supply", "lng"],
    ["flow-slider-domestic", "supply", "domestic"],
  ];

  function applySliderPositions() {
    SLIDERS.forEach(([id, group, key]) => {
      const slider = el(id);
      if (!slider) return;
      const range = RANGES[key];
      state[group][key] = clamp(state[group][key], range.min, range.max);
      slider.value = String(Math.round(state[group][key]));
    });
    document.querySelectorAll("[data-refyear]").forEach((chip) => {
      chip.setAttribute("aria-pressed", String(Number(chip.dataset.refyear) === state.refYear));
    });
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

    el("flow-refyears")?.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-refyear]");
      if (chip) {
        stopPlayback();
        state.refYear = Number(chip.dataset.refyear);
        seedFromData();
        applySliderPositions();
        update();
      }
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
    el("flow-csv")?.addEventListener("click", ladeCsvHerunter);
    el("flow-reset")?.addEventListener("click", () => {
      stopPlayback();
      seedFromData();
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

  /**
   * de_consumption_daily.csv -> Map(Gasjahr -> Map("MM-TT" -> { slp, rlm })).
   * Nur vollstaendige Gasjahre (>= 360 Gastage) werden als Referenz angeboten.
   */
  function parseConsumption(text) {
    const [kopf, ...zeilen] = text.trim().split(/\r?\n/);
    const spalten = kopf.split(",");
    const iDate = spalten.indexOf("date");
    const iSlp = spalten.indexOf("slp_gwh");
    const iRlm = spalten.indexOf("rlm_gwh");
    if (iDate < 0 || iSlp < 0 || iRlm < 0) throw new Error("Unerwartete Spalten.");

    const jahre = new Map();
    zeilen.forEach((zeile) => {
      const teile = zeile.split(",");
      const datum = teile[iDate];
      const slp = number(teile[iSlp]);
      const rlm = number(teile[iRlm]);
      if (!datum || slp === null || rlm === null) return;
      const jahr = gasYearOf(parseDate(datum));
      if (!jahre.has(jahr)) jahre.set(jahr, new Map());
      jahre.get(jahr).set(datum.slice(5), { slp, rlm });
    });
    [...jahre.keys()].forEach((jahr) => {
      if (jahre.get(jahr).size < 360) jahre.delete(jahr);
    });
    return jahre;
  }

  function renderRefYearChips() {
    const box = el("flow-refyears");
    if (!box) return;
    box.innerHTML = state.refYears
      .map((jahr) => {
        const gedrueckt = jahr === state.refYear;
        return `<button class="flow-chip" type="button" data-refyear="${jahr}" ` +
          `aria-pressed="${gedrueckt}">${jahr}/${String(jahr + 1).slice(2)}</button>`;
      })
      .join("");
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
    // Achtung: Die Spalte heisst im Repo _gwh_per_day, traegt aber den
    // AGSI-Wert "consumption" — und der ist der Jahresverbrauch in TWh.
    // Beleg: der Wert aendert sich ueber 2422 Tage nur fuenfmal, und die
    // EU-Zeile traegt 3519 — als GWh/Tag waere das ein Sechstel des realen
    // EU-Verbrauchs, als TWh/Jahr passt es.
    state.consumptionTwh =
      number(latest.consumption_gwh_per_day) ?? DEFAULTS.consumptionTwh;
    state.measuredRate = measuredRate(rows);
  }

  /**
   * Jahresmittel des Tagesverbrauchs aus dem AGSI-Jahreswert in TWh.
   * Nur noch Rueckfallebene, falls die THE-Tagesreihe fehlt.
   */
  const annualMeanDemand = () => (state.consumptionTwh * 1000) / 365;

  /**
   * Regler auf den gemessenen Zustand setzen.
   *   Entnahme: Jahresmittel des Referenz-Gasjahres, SLP und RLM getrennt
   *             gemessen, RLM nach RLM_SPLIT auf Industrie und Strom verteilt.
   *   Zufluss:  das Niveau, das am 1. November 80 % traegt (siehe requiredSupply).
   *             Eingefroren auf den Augustwert waere die Voreinstellung ein
   *             Szenario, das niemand faehrt — der Speicher kippte im September.
   */
  function seedFromData() {
    const jahr = state.consumption.get(state.refYear);
    if (jahr && jahr.size) {
      let slp = 0;
      let rlm = 0;
      jahr.forEach((tag) => { slp += tag.slp; rlm += tag.rlm; });
      slp /= jahr.size;
      rlm /= jahr.size;
      state.base = {
        households: slp,
        industry: rlm * RLM_SPLIT.industry,
        power: rlm * RLM_SPLIT.power,
      };
    } else {
      // Ohne Messreihe: flacher Bedarf aus dem AGSI-Jahreswert.
      const mittel = annualMeanDemand();
      state.base = {
        households: mittel * 0.4,
        industry: mittel * 0.6 * RLM_SPLIT.industry,
        power: mittel * 0.6 * RLM_SPLIT.power,
      };
    }
    state.demand = { ...state.base };
    state.day = 0;
    // Gemessener Ist-Zufluss: Bedarf am Datenstand plus das gemessene
    // 30-Tage-Einspeichertempo. Das ist der Pfad, auf dem wir tatsaechlich sind.
    verteileZufluss(demandOn(0).total + state.measuredRate * state.ppGwh);
  }

  /** Summe auf die drei Quellen verteilen, Mischung beibehalten. */
  function verteileZufluss(summe) {
    const aktuell = supplyTotal();
    const anteil = aktuell > 0
      ? {
          pipeline: state.supply.pipeline / aktuell,
          lng: state.supply.lng / aktuell,
          domestic: state.supply.domestic / aktuell,
        }
      : SUPPLY_SHARES;
    state.supply = {
      pipeline: summe * anteil.pipeline,
      lng: summe * anteil.lng,
      domestic: summe * anteil.domestic,
    };
  }

  /** Zufluss auf das Niveau heben, das bis zum 1. November für 80% nötig ist. */
  /** Konstanter Zufluss, der am 1. November 80 % traegt — ab Tag 0 gerechnet. */
  function zielZufluss() {
    let bedarf = 0;
    for (let index = 0; index < state.targetIndex; index += 1) {
      bedarf += demandOn(index).total;
    }
    const luecke = Math.max(0, TARGET_FILL - state.startFill);
    return bedarf / state.targetIndex + (luecke * state.ppGwh) / state.targetIndex;
  }

  function applyRequiredSupply() {
    const merk = state.day;
    state.day = 0;
    const required = requiredSupply(simulate());
    state.day = merk;
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

  /** Beschreibt das gewaehlte Referenzjahr unter der Knopfleiste. */
  function scenarioText() {
    if (!state.refYears.length) {
      return "<strong>Die Tagesreihe des Verbrauchs fehlt.</strong> Erwartet wird " +
        "<code>data/de_consumption_daily.csv</code>. Ohne sie rechnet das Labor mit " +
        "flachem Jahresmittel — der Jahresgang des Verbrauchs fehlt dann völlig, " +
        "die Projektion ist entsprechend wertlos.";
    }
    const jahr = `${state.refYear}/${String(state.refYear + 1).slice(2)}`;
    const temp = DWD_WINTER[state.refYear + 1];
    const winter = temp === undefined
      ? ""
      : ` Der Winter lag im DWD-Mittel bei ${nf1.format(temp).replace("-", "−")} °C ` +
        `(Norm 1991–2020: ${nf1.format(DWD_NORM_C)} °C).`;
    return `<strong>Gasjahr ${jahr}</strong> — jeder Simulationstag nimmt den gemessenen ` +
      `Verbrauch des gleichen Kalendertags aus diesem Jahr. Das Wetter steckt damit in ` +
      `den Daten, es wird nicht modelliert.${winter}`;
  }

  function renderScenario() {
    document.querySelectorAll("[data-refyear]").forEach((chip) => {
      chip.setAttribute("aria-pressed", String(Number(chip.dataset.refyear) === state.refYear));
    });
    const note = el("flow-scenario-note");
    if (note) note.innerHTML = scenarioText();
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
    const q = (url, text) => `<a href="${url}" target="_blank" rel="noreferrer">${text}</a>`;
    const verbrauch = state.refYears.length
      ? `Der Tagesverbrauch stammt aus den aggregierten Allokationsdaten von ` +
        `${q("https://www.tradinghub.eu/de-de/Ver%C3%B6ffentlichungen/Transparenz/Aggregierte-Verbrauchsdaten", "Trading Hub Europe")} ` +
        `(${state.refYears.length} vollständige Gasjahre, SLP und RLM getrennt gemessen). `
      : `<strong>Die Verbrauchsreihe fehlt</strong>, das Labor rechnet ersatzweise mit flachem Bedarf. `;
    el("flow-source-note").innerHTML = loaded
      ? `<strong>Datenstand ${dateText(state.startDate)}.</strong> Füllstand ${nf2.format(state.startFill)} %, ` +
        `Arbeitsgasvolumen ${nf1.format((state.ppGwh * 100) / 1000)} TWh ` +
        `(1 Prozentpunkt ≈ ${nf0.format(Math.round(state.ppGwh))} GWh) und die Ein-/Ausspeicherkapazität ` +
        `kommen aus ${q("https://agsi.gie.eu/", "GIE AGSI+")} (API v013). ${verbrauch}` +
        `Bezugsmix und Sektoranteile: ` +
        `${q("https://www.bundesnetzagentur.de/DE/Gasversorgung/a_Gasversorgung_2024/start.html", "Bundesnetzagentur")} ` +
        `und ${q("https://jahresbericht.bveg.de/erdgasfoerderung/", "BVEG")}; LNG-Kapazität: ` +
        `${q("https://energy-terminal.de/en/terminals", "Deutsche Energy Terminal")}; Wintertemperaturen: ` +
        `${q("https://opendata.dwd.de/climate_environment/CDC/regional_averages_DE/seasonal/air_temperature_mean/regional_averages_tm_winter.txt", "DWD")}. ` +
        `<br><strong>Rechenweg:</strong> Bedarf je Tag = gemessener Wert des gleichen ` +
        `Kalendertags im Referenz-Gasjahr, unverändert übernommen. ` +
        `Netto = Zufluss − Bedarf, begrenzt auf Ein- und Ausspeicherkapazität. ` +
        `Füllstand<sub>t+1</sub> = Füllstand<sub>t</sub> + Netto / ` +
        `${nf0.format(Math.round(state.ppGwh))} GWh, gedeckelt auf 0–100 %. ` +
        `Einstellbar ist nur der Zufluss; er startet auf dem gemessenen Ist-Niveau ` +
        `(Bedarf am Datenstand plus das 30-Tage-Einspeichertempo). Die grüne Linie zeigt ` +
        `daneben den Zufluss, der das 80-%-Ziel trüge. ` +
        `<strong>Als Annahme bleiben nur der Bezugsmix und die Trennung 70/30 zwischen ` +
        `Industrie und Stromerzeugung</strong> — das <i>i</i> an jedem Regler nennt Herkunft ` +
        `und Grenzen.`
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
        <span><i class="flow-key flow-key-target"></i>1. Nov · bei konstantem Zufluss
          <button class="flow-info" type="button" data-info="ziel"
                  aria-label="Quelle und Bedeutung: 80-Prozent-Ziel">i</button>
        </span>
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
            <span class="flow-card-name"><label for="flow-slider-pipeline">Pipeline-Importe</label><button class="flow-info" type="button" data-info="pipeline" aria-label="Quelle und Maximum: Pipeline-Importe">i</button></span>
            <span class="flow-card-value" id="flow-value-pipeline">--</span>
          </div>
          <input id="flow-slider-pipeline" type="range" value="0" />
          <small>Norwegen 48 % · Niederlande 25 % · Belgien 18 %</small>
        </div>

        <div class="flow-card" data-flow="lng">
          <div class="flow-card-row">
            <span class="flow-card-name"><label for="flow-slider-lng">LNG-Terminals</label><button class="flow-info" type="button" data-info="lng" aria-label="Quelle und Maximum: LNG-Terminals">i</button></span>
            <span class="flow-card-value" id="flow-value-lng">--</span>
          </div>
          <input id="flow-slider-lng" type="range" value="0" />
          <small>Wilhelmshaven 1 &amp; 2 · Brunsbüttel</small>
        </div>

        <div class="flow-card" data-flow="domestic">
          <div class="flow-card-row">
            <span class="flow-card-name"><label for="flow-slider-domestic">Inland &amp; Biomethan</label><button class="flow-info" type="button" data-info="domestic" aria-label="Quelle und Maximum: Inland &amp; Biomethan">i</button></span>
            <span class="flow-card-value" id="flow-value-domestic">--</span>
          </div>
          <input id="flow-slider-domestic" type="range" value="0" />
          <small>Heimische Förderung · Biomethan</small>
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
            <span class="flow-card-name"><label for="flow-slider-households">Haushalte &amp; Gewerbe</label><button class="flow-info" type="button" data-info="households" aria-label="Quelle und Maximum: Haushalte und Gewerbe">i</button></span>
            <span class="flow-card-value" id="flow-value-households">--</span>
          </div>
          <small><span id="flow-mean-households">–</span> · gemessen als SLP</small>
        </div>

        <div class="flow-card" data-flow="industry">
          <div class="flow-card-row">
            <span class="flow-card-name"><label for="flow-slider-industry">Industrie</label><button class="flow-info" type="button" data-info="industry" aria-label="Quelle und Maximum: Industrie">i</button></span>
            <span class="flow-card-value" id="flow-value-industry">--</span>
          </div>
          <small><span id="flow-mean-industry">–</span> · 70 % des RLM</small>
        </div>

        <div class="flow-card" data-flow="power">
          <div class="flow-card-row">
            <span class="flow-card-name"><label for="flow-slider-power">Stromerzeugung</label><button class="flow-info" type="button" data-info="power" aria-label="Quelle und Maximum: Stromerzeugung">i</button></span>
            <span class="flow-card-value" id="flow-value-power">--</span>
          </div>
          <small><span id="flow-mean-power">–</span> · 30 % des RLM</small>
        </div>
      </div>
    </div>

    <div class="flow-timeline">
      <div class="flow-timeline-controls">
        <button id="flow-play" class="flow-button" type="button" aria-label="Simulation abspielen">▶</button>
        <button id="flow-reset" class="flow-button flow-button-ghost" type="button"
                title="Zufluss auf den gemessenen Ist-Wert zurücksetzen">↺ Zurücksetzen</button>
        <p class="flow-refyear-label">
          <i class="flow-key flow-key-out"></i>Referenz-Gasjahr
          <button class="flow-info" type="button" data-info="refyear"
                  aria-label="Quelle und Bedeutung: Referenz-Gasjahr">i</button>
        </p>
        <div class="flow-scenarios" id="flow-refyears" role="group" aria-label="Referenz-Gasjahr wählen"></div>
        <p class="flow-day"><small>Simulationstag</small><span id="flow-day-date">--</span></p>
      </div>

      <p class="flow-scenario-note" id="flow-scenario-note">Startwerte werden geladen …</p>

      <p class="flow-timeline-legend">
        <i class="flow-key flow-key-fill"></i>Ist-Pfad, vom Zufluss gesteuert ·
        <i class="flow-key flow-key-goal"></i>Zielpfad für 80 % ·
        <i class="flow-key flow-key-linear"></i>lineare Fortschreibung ·
        <span id="flow-range">--</span>
      </p>

      <div class="flow-axis-wrap">
        <svg id="flow-axis" viewBox="0 0 960 200" role="img"
             aria-label="Zeitachse mit Wochen und Monaten sowie dem projizierten Füllstand">
          <line id="flow-axis-target" class="flow-axis-target" x1="16" y1="43" x2="944" y2="43"></line>
          <text id="flow-axis-target-label" class="flow-axis-target-text" x="20" y="38">80%</text>
          <g id="flow-axis-scale"></g>
          <path id="flow-axis-linear" class="flow-axis-linear" d=""></path>
          <text id="flow-axis-linear-label" class="flow-axis-linear-label" x="0" y="0" dominant-baseline="central">linear</text>
          <path id="flow-axis-goal" class="flow-axis-goal" d=""></path>
          <text id="flow-axis-goal-label" class="flow-axis-goal-label" x="0" y="0"
                dominant-baseline="central">Zielpfad</text>
          <path id="flow-axis-curve" class="flow-axis-curve" d=""></path>
          <line id="flow-axis-cursor" class="flow-axis-cursor" x1="16" y1="8" x2="16" y2="158"></line>
          <circle id="flow-axis-dot" class="flow-axis-dot" cx="16" cy="83" r="5"></circle>
        </svg>
        <input id="flow-scrub" type="range" value="0" aria-label="Simulationstag wählen" />
      </div>

      <p class="flow-download">
        <button id="flow-csv" class="flow-button flow-button-ghost" type="button">↓ Tagestabelle als CSV</button>
        <span>Jeder Simulationstag mit Bedarf je Sektor, Zufluss, Netto-Bilanz, Füllstand und
          Zielpfad. Im Dateikopf stehen alle Parameter, der Rechenweg und die Quellen —
          damit Dritte die Annahmen ohne diese Seite nachprüfen können.</span>
      </p>
    </div>

    <div class="flow-foot flow-foot-single">
      <div class="flow-required">
        <span><i class="flow-key flow-key-in"></i>Benötigter täglicher Zufluss bis 80% am 1. November</span>
        <p class="flow-required-row">
          <strong id="flow-required-value">--</strong>
          <strong id="flow-required-gap" class="flow-required-gap">--</strong>
        </p>
        <p id="flow-required-detail">--</p>
      </div>
    </div>

    <p class="flow-source-note" id="flow-source-note">Startwerte werden geladen …</p>

    <div class="flow-popover" id="flow-source-popover" role="dialog"
         aria-label="Quelle und Maximum" hidden></div>
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
      const response = await fetch(CONSUMPTION_URL);
      if (!response.ok) throw new Error(`Verbrauchsreihe: HTTP ${response.status}`);
      state.consumption = parseConsumption(await response.text());
      state.refYears = [...state.consumption.keys()].sort((a, b) => a - b);
      state.refYear = state.refYears.at(-1) ?? null;
      if (!state.refYears.length) throw new Error("Keine vollständigen Gasjahre.");
    } catch (error) {
      console.warn("Flow-Lab: Tagesverbrauch nicht verfügbar.", error);
      state.consumption = new Map();
      state.refYears = [];
      state.refYear = null;
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

    try {
      setHorizon();
      renderRefYearChips();
      seedFromData();
      renderBottleScale();
      renderAxisScale();
      renderLinearReference();
      bindControls();
      bindeBelege();
      applySliderPositions();
      renderSourceNote(loaded);
      update();
    } catch (error) {
      // Lieber eine ehrliche Fehlermeldung als eine Grafik voller Striche.
      console.error("Flow-Lab: Aufbau fehlgeschlagen.", error);
      const notiz = el("flow-source-note");
      if (notiz) {
        notiz.innerHTML =
          "<strong>Das Flussbilanz-Labor konnte nicht aufgebaut werden.</strong> " +
          `Grund: ${String(error && error.message ? error.message : error)}. ` +
          "Details stehen in der Browser-Konsole.";
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
