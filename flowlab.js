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

  // Monatsprofile (Jan..Dez) relativ zum Sektormittel; werden auf Mittelwert 1 normiert.
  const SEASON = {
    households: [2.35, 2.2, 1.75, 1.15, 0.55, 0.2, 0.13, 0.13, 0.35, 0.95, 1.7, 2.2],
    industry: [1.12, 1.12, 1.1, 1.02, 0.98, 0.92, 0.8, 0.78, 0.98, 1.08, 1.12, 1.02],
    power: [1.45, 1.35, 1.15, 0.85, 0.65, 0.62, 0.72, 0.68, 0.75, 0.95, 1.3, 1.45],
  };

  /**
   * Heizperiode: Temperaturabweichung wirkt auf Haushalte und (schwaecher)
   * Kraftwerke. Referenz ist das DWD-Gebietsmittel Deutschland fuer den Winter
   * (Dez-Feb) der Normalperiode 1991-2020: +1,4 °C.
   * Die Reglergrenzen sind die Extreme der letzten 50 Winter (1977-2026):
   * kaeltester Winter 1984/85 mit -2,5 °C, mildester 2006/07 mit +4,4 °C.
   */
  const TEMP_NORM_C = 1.4;
  const TEMP_COLDEST_C = -2.5;
  const TEMP_MILDEST_C = 4.4;
  const TEMP_SENSITIVITY = { households: 0.06, power: 0.02 };
  const HEATING_MONTHS = new Set([9, 10, 11, 0, 1, 2]);

  /**
   * Szenarien. Der Verbrauchsfaktor folgt bewusst der Konvention, die das
   * Dashboard schon benutzt: ±20 % auf die Entnahme, wie in den Spalten
   * optimistic_20pct_lower_withdrawal_* / pessimistic_20pct_higher_withdrawal_*
   * von data/projections.csv. Der Zufluss bleibt dabei unberuehrt — er ist der
   * Regler, mit dem der Nutzer antwortet.
   */
  const SCENARIOS = {
    measured: { demand: 1, temperature: TEMP_NORM_C },
    optimistic: { demand: 0.8, temperature: TEMP_MILDEST_C },
    pessimistic: { demand: 1.2, temperature: TEMP_COLDEST_C },
  };

  /**
   * Belege pro Regler. Jeder Eintrag sagt, woher der Startwert kommt und was
   * das Reglermaximum bedeutet. Wo keine amtliche Zahl existiert, steht das
   * ausdruecklich dabei — geraten wird nichts.
   */
  const SOURCES = {
    pipeline: {
      titel: "Pipeline-Importe",
      aktuell:
        "Startwert: 88 % des Zuflusses am Datenstand. Der Anteil stammt aus den " +
        "Importmengen 2024 — 865 TWh insgesamt, davon 68 TWh über deutsche " +
        "LNG-Terminals. Der Rest kam per Pipeline, überwiegend aus Norwegen (48 %), " +
        "den Niederlanden (25 %) und Belgien (18 %).",
      maximum:
        "3.000 GWh/Tag. Im Jahresmittel 2024 lagen die Pipeline-Importe bei rund " +
        "2.180 GWh/Tag. Höher käme man nur bei durchgehender Vollauslastung der " +
        "Grenzübergangspunkte. <strong>Eine amtliche Gesamtkapazität aller deutschen " +
        "Einspeisepunkte ist nicht veröffentlicht</strong> — diese Obergrenze ist " +
        "deshalb eine Modellgrenze, kein Messwert.",
      quellen: [["Bundesnetzagentur, Gasversorgung 2024", "https://www.bundesnetzagentur.de/DE/Gasversorgung/a_Gasversorgung_2024/start.html"]],
    },
    lng: {
      titel: "LNG-Terminals",
      aktuell:
        "Startwert: 7,5 % des Zuflusses. 2024 kamen 68 TWh über die deutschen " +
        "LNG-Terminals — 8 % aller Importe, im Jahresmittel rund 186 GWh/Tag.",
      maximum:
        "400 GWh/Tag. Die drei betriebsbereiten Terminals der bundeseigenen DET — " +
        "Wilhelmshaven 1 (4,8), Wilhelmshaven 2 (4,3) und Brunsbüttel " +
        "(4,0 Mrd. m³/Jahr) — ergeben zusammen 13,1 Mrd. m³/Jahr, also etwa " +
        "380 GWh/Tag bei lückenloser Anlandung. 2024 wurde davon knapp die Hälfte " +
        "genutzt. Stade und Mukran sind hier nicht eingerechnet.",
      quellen: [
        ["Bundesnetzagentur, Gasversorgung 2024", "https://www.bundesnetzagentur.de/DE/Gasversorgung/a_Gasversorgung_2024/start.html"],
        ["Deutsche Energy Terminal, Terminals", "https://energy-terminal.de/en/terminals"],
      ],
    },
    domestic: {
      titel: "Inland & Biomethan",
      aktuell:
        "Startwert: 4,5 % des Zuflusses. Die heimische Erdgasförderung lag 2024 bei " +
        "4,2 Mrd. m³ beziehungsweise 40,9 TWh und deckte 5,4 % des deutschen Bedarfs.",
      maximum:
        "200 GWh/Tag. Die Förderung allein entspricht rund 112 GWh/Tag und ist " +
        "rückläufig. Der Abstand bis zum Maximum wäre zusätzliche " +
        "Biomethan-Einspeisung — deren Ausbaupfad ist eine Modellannahme.",
      quellen: [["BVEG, Jahresbericht 2024 — Erdgasförderung", "https://jahresbericht.bveg.de/erdgasfoerderung/"]],
    },
    households: {
      titel: "Private Haushalte & Gewerbe",
      aktuell:
        "Startwert: 39 % des Jahresmittels. Die Bundesnetzagentur weist für 2024 " +
        "aus, dass 39 % des deutschen Gasverbrauchs auf Haushalts- und " +
        "Gewerbekunden entfielen.",
      maximum:
        "2.000 GWh/Tag — gut das Doppelte des Startwerts. Wichtig: der Regler " +
        "stellt das <strong>Jahresmittel</strong>. Im Januar liegt der tatsächliche " +
        "Bedarf beim rund Doppelten dieses Werts, bei Kälte noch darüber.",
      quellen: [["Bundesnetzagentur, Gasversorgung 2024", "https://www.bundesnetzagentur.de/DE/Gasversorgung/a_Gasversorgung_2024/start.html"]],
    },
    industry: {
      titel: "Industrie",
      aktuell:
        "Startwert: 43 % des Jahresmittels. Die Bundesnetzagentur führt für 2024 " +
        "61 % des Verbrauchs unter Industrie — gemessen an den Netzausspeisepunkten. " +
        "<strong>Die Aufteilung dieser 61 % auf Industrie und Stromerzeugung ist eine " +
        "Modellannahme</strong>, keine amtliche Zahl.",
      maximum:
        "2.200 GWh/Tag im Jahresmittel. Das entspräche einer Industrieproduktion " +
        "deutlich über dem heutigen Niveau; der Industriebedarf ist seit 2021 " +
        "gefallen, nicht gestiegen.",
      quellen: [["Bundesnetzagentur, Gasversorgung 2024", "https://www.bundesnetzagentur.de/DE/Gasversorgung/a_Gasversorgung_2024/start.html"]],
    },
    power: {
      titel: "Stromerzeugung",
      aktuell:
        "Startwert: 18 % des Jahresmittels, kalibriert auf rund 150 TWh Gas für " +
        "Strom- und Wärmeerzeugung. <strong>Modellannahme</strong> innerhalb der " +
        "61 %, die die Bundesnetzagentur als Industrie führt.",
      maximum:
        "900 GWh/Tag im Jahresmittel. Erreichbar nur, wenn Gaskraftwerke dauerhaft " +
        "einen deutlich größeren Teil der Residuallast decken als heute.",
      quellen: [["Bundesnetzagentur, Gasversorgung 2024", "https://www.bundesnetzagentur.de/DE/Gasversorgung/a_Gasversorgung_2024/start.html"]],
    },
    temperature: {
      titel: "Winter-Durchschnittstemperatur",
      aktuell:
        "+1,4 °C ist das Gebietsmittel des Deutschen Wetterdienstes für den " +
        "deutschen Winter (Dezember bis Februar) in der Normalperiode 1991–2020.",
      maximum:
        "Die Reglerenden sind die Extreme der letzten 50 Winter: <strong>−2,5 °C</strong> " +
        "im Winter 1984/85 und <strong>+4,4 °C</strong> im Winter 2006/07. Kälter oder " +
        "milder war es in Deutschland seit 1977 in keinem Winter. Die Abweichung von " +
        "der Norm wirkt im Modell auf die gesamte Heizperiode (Okt–Mär).",
      quellen: [["DWD, Gebietsmittel Winter Deutschland (CDC)", "https://opendata.dwd.de/climate_environment/CDC/regional_averages_DE/seasonal/air_temperature_mean/regional_averages_tm_winter.txt"]],
    },
  };

  // Reglerbereiche in GWh/Tag; Temperatur in °C.
  const RANGES = {
    pipeline: { min: 0, max: 3000, step: 10 },
    lng: { min: 0, max: 400, step: 5 },
    domestic: { min: 0, max: 200, step: 5 },
    households: { min: 0, max: 2000, step: 10 },
    industry: { min: 0, max: 2200, step: 10 },
    power: { min: 0, max: 900, step: 10 },
    temperature: { min: TEMP_COLDEST_C, max: TEMP_MILDEST_C, step: 0.1 },
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
    temperature: TEMP_NORM_C,
    scenario: "measured",
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
    renderScenario();
    renderMetrics(state.fills, demand);
    renderBottle(state.fills[state.day]);
    renderAxisCurve(state.fills);
    renderRequirement(state.fills);
    renderConnectors(demand);
  }

  /* ------------------------------------------------------------------ Belege */

  let popoverTimer = null;
  let popoverFest = null;

  function versteckeBeleg(sofort) {
    window.clearTimeout(popoverTimer);
    const zeigen = () => {
      const pop = el("flow-source-popover");
      if (pop) pop.hidden = true;
      document.querySelectorAll(".flow-info[aria-expanded=true]")
        .forEach((b) => b.setAttribute("aria-expanded", "false"));
    };
    if (sofort) zeigen();
    else popoverTimer = window.setTimeout(zeigen, 220);
  }

  function zeigeBeleg(key, ausloeser) {
    const beleg = SOURCES[key];
    const pop = el("flow-source-popover");
    if (!beleg || !pop) return;
    window.clearTimeout(popoverTimer);

    pop.innerHTML =
      `<h4>${beleg.titel}</h4>` +
      `<p><span class="flow-pop-label">Aktueller Wert</span>${beleg.aktuell}</p>` +
      `<p><span class="flow-pop-label">Maximum</span>${beleg.maximum}</p>` +
      `<p class="flow-pop-quelle">${beleg.quellen
        .map(([titel, url]) => `<a href="${url}" target="_blank" rel="noreferrer">${titel}</a>`)
        .join(" · ")}</p>`;
    pop.hidden = false;
    ausloeser.setAttribute("aria-expanded", "true");

    const rand = 12;
    const breite = Math.min(380, window.innerWidth - 2 * rand);
    pop.style.width = `${breite}px`;
    const r = ausloeser.getBoundingClientRect();
    pop.style.left = `${clamp(r.left + r.width / 2 - breite / 2, rand, window.innerWidth - breite - rand)}px`;
    pop.style.top = `${r.bottom + 10}px`;
    const hoehe = pop.getBoundingClientRect().height;
    if (r.bottom + 10 + hoehe > window.innerHeight - rand) {
      pop.style.top = `${Math.max(rand, r.top - hoehe - 10)}px`;
    }
  }

  function bindeBelege() {
    const pop = el("flow-source-popover");
    pop?.addEventListener("mouseenter", () => window.clearTimeout(popoverTimer));
    pop?.addEventListener("mouseleave", () => versteckeBeleg());

    document.querySelectorAll(".flow-info").forEach((knopf) => {
      const key = knopf.dataset.info;
      knopf.setAttribute("aria-expanded", "false");
      knopf.addEventListener("mouseenter", () => { if (!popoverFest) zeigeBeleg(key, knopf); });
      knopf.addEventListener("mouseleave", () => { if (!popoverFest) versteckeBeleg(); });
      knopf.addEventListener("focus", () => zeigeBeleg(key, knopf));
      knopf.addEventListener("blur", () => { if (!popoverFest) versteckeBeleg(); });
      // Klick haelt das Popover offen — noetig auf Touch, praktisch am Desktop.
      knopf.addEventListener("click", (event) => {
        event.preventDefault();
        if (popoverFest === key) { popoverFest = null; versteckeBeleg(true); }
        else { popoverFest = key; zeigeBeleg(key, knopf); }
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { popoverFest = null; versteckeBeleg(true); }
    });
    document.addEventListener("click", (event) => {
      if (!popoverFest) return;
      if (event.target.closest(".flow-info") || event.target.closest(".flow-popover")) return;
      popoverFest = null;
      versteckeBeleg(true);
    });
    window.addEventListener("scroll", () => { if (!popoverFest) versteckeBeleg(true); }, { passive: true });
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
        // Der Zufluss ist die Antwort auf ein Szenario, nicht Teil davon —
        // nur Entnahme und Temperatur machen daraus eine eigene Einstellung.
        if (group === "demand") state.scenario = "custom";
        update();
      });
    });

    const temperature = el("flow-slider-temperature");
    temperature.min = String(RANGES.temperature.min);
    temperature.max = String(RANGES.temperature.max);
    temperature.step = String(RANGES.temperature.step);
    temperature.addEventListener("input", (event) => {
      state.temperature = number(event.target.value) ?? TEMP_NORM_C;
      state.scenario = "custom";
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
    document.querySelectorAll("[data-scenario]").forEach((chip) => {
      chip.addEventListener("click", () => {
        stopPlayback();
        applyScenario(chip.dataset.scenario);
        applySliderPositions();
        update();
      });
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
   * Regler auf den gemessenen Zustand setzen:
   *   Entnahme = gemessener Tagesverbrauch, über das Monatsprofil aufs Jahresmittel
   *              zurückgerechnet und nach Sektoranteilen aufgeteilt.
   *   Zufluss  = Verbrauch + gemessenes 30-Tage-Einspeichertempo.
   */
  /** Jahresmittel des Tagesverbrauchs in GWh, aus dem AGSI-Jahreswert. */
  const annualMeanDemand = () => (state.consumptionTwh * 1000) / 365;

  /** Verbrauch am Datenstand, wie ihn das Monatsprofil ergibt. */
  function demandAtStart() {
    const month = parseDate(state.startDate).getMonth();
    return annualMeanDemand() * Object.entries(DEMAND_SHARES).reduce(
      (sum, [sector, share]) => sum + share * SEASON[sector][month],
      0,
    );
  }

  function seedFromData() {
    const annualMean = annualMeanDemand();
    state.demand = {
      households: annualMean * DEMAND_SHARES.households,
      industry: annualMean * DEMAND_SHARES.industry,
      power: annualMean * DEMAND_SHARES.power,
    };

    const supply = demandAtStart() + state.measuredRate * state.ppGwh;
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

  /** Szenario setzen: von den Messwerten aus, dann Verbrauch und Winter anpassen. */
  function applyScenario(key) {
    const scenario = SCENARIOS[key];
    if (!scenario) return;
    seedFromData();
    DEMAND_KEYS.forEach((sector) => {
      state.demand[sector] *= scenario.demand;
    });
    state.temperature = scenario.temperature;
    state.scenario = key;
  }

  function scenarioText() {
    const winter = `${nf1.format(state.temperature).replace("-", "−")} °C`;
    if (state.scenario === "measured") {
      return `<strong>Messwerte</strong> — Jahresverbrauch ${nf1.format(state.consumptionTwh)} TWh ` +
        `(${nf0.format(Math.round(annualMeanDemand()))} GWh/Tag im Mittel), Winter auf der DWD-Norm ${winter}.`;
    }
    if (state.scenario === "optimistic") {
      return `<strong>Optimistisch</strong> — Verbrauch 20 % unter dem Mittel und der ` +
        `mildeste Winter der letzten 50 Jahre (2006/07, ${winter}). Beide Annahmen wirken zusammen.`;
    }
    if (state.scenario === "pessimistic") {
      return `<strong>Pessimistisch</strong> — Verbrauch 20 % über dem Mittel und der ` +
        `kälteste Winter der letzten 50 Jahre (1984/85, ${winter}). Beide Annahmen wirken zusammen.`;
    }
    return `<strong>Eigene Einstellung</strong> — Entnahme oder Temperatur von Hand verändert. ` +
      `Winter ${winter}.`;
  }

  function renderScenario() {
    Object.keys(SCENARIOS).forEach((key) => {
      const chip = document.querySelector(`[data-scenario="${key}"]`);
      if (chip) chip.setAttribute("aria-pressed", String(state.scenario === key));
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
    el("flow-source-note").innerHTML = loaded
      ? `<strong>Datenstand ${dateText(state.startDate)}.</strong> Füllstand ${nf2.format(state.startFill)} %, ` +
        `5-Jahres-Norm, Arbeitsgasvolumen ${nf1.format((state.ppGwh * 100) / 1000)} TWh ` +
        `(1 Prozentpunkt ≈ ${nf0.format(Math.round(state.ppGwh))} GWh) und Jahresverbrauch ` +
        `${nf1.format(state.consumptionTwh)} TWh stammen aus ${q("https://agsi.gie.eu/", "GIE AGSI+")} ` +
        `(API v013). Der Zufluss startet so, dass die Netto-Bilanz dem gemessenen 30-Tage-Tempo von ` +
        `${signed(state.measuredRate, (v) => nf2.format(v))} pp/Tag entspricht. ` +
        `Sektoranteile und Bezugsmix: ${q("https://www.bundesnetzagentur.de/DE/Gasversorgung/a_Gasversorgung_2024/start.html", "Bundesnetzagentur")} ` +
        `und ${q("https://jahresbericht.bveg.de/erdgasfoerderung/", "BVEG")}; LNG-Kapazität: ` +
        `${q("https://energy-terminal.de/en/terminals", "Deutsche Energy Terminal")}; Wintertemperaturen: ` +
        `${q("https://opendata.dwd.de/climate_environment/CDC/regional_averages_DE/seasonal/air_temperature_mean/regional_averages_tm_winter.txt", "DWD-Gebietsmittel")}. ` +
        `Das <i>i</i> an jedem Regler nennt Herkunft und Bedeutung des Maximums. ` +
        `<strong>Monatsprofile, Temperatursensitivität und die Aufteilung zwischen Industrie und ` +
        `Stromerzeugung sind Modellannahmen</strong> — eine Simulation zum Durchspielen, keine Prognose.`
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
          <input id="flow-slider-households" type="range" value="0" />
          <small>Jahresmittel · stark temperaturabhängig</small>
        </div>

        <div class="flow-card" data-flow="industry">
          <div class="flow-card-row">
            <span class="flow-card-name"><label for="flow-slider-industry">Industrie</label><button class="flow-info" type="button" data-info="industry" aria-label="Quelle und Maximum: Industrie">i</button></span>
            <span class="flow-card-value" id="flow-value-industry">--</span>
          </div>
          <input id="flow-slider-industry" type="range" value="0" />
          <small>Prozesswärme · Grundstoffe</small>
        </div>

        <div class="flow-card" data-flow="power">
          <div class="flow-card-row">
            <span class="flow-card-name"><label for="flow-slider-power">Stromerzeugung</label><button class="flow-info" type="button" data-info="power" aria-label="Quelle und Maximum: Stromerzeugung">i</button></span>
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
        <div class="flow-scenarios" role="group" aria-label="Szenario wählen">
          <button class="flow-chip" type="button" data-scenario="measured" aria-pressed="true">↺ Messwerte</button>
          <button class="flow-chip" type="button" data-scenario="optimistic" aria-pressed="false">Optimistisch</button>
          <button class="flow-chip" type="button" data-scenario="pessimistic" aria-pressed="false">Pessimistisch</button>
        </div>
        <button id="flow-target" class="flow-button flow-button-ghost" type="button">Zufluss für 80%</button>
        <p class="flow-day"><small>Simulationstag</small><span id="flow-day-date">--</span></p>
      </div>

      <p class="flow-scenario-note" id="flow-scenario-note">Startwerte werden geladen …</p>

      <p class="flow-timeline-legend">
        <i class="flow-key flow-key-fill"></i>Simulation ·
        <i class="flow-key flow-key-linear"></i>lineare Fortschreibung des gemessenen Tempos ·
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
        <span><i class="flow-key flow-key-out"></i>Winter-Durchschnittstemperatur
          <button class="flow-info" type="button" data-info="temperature"
                  aria-label="Quelle und Grenzen: Winter-Durchschnittstemperatur">i</button>
        </span>
        <div class="flow-temperature-row">
          <input id="flow-slider-temperature" type="range" value="3"
                 aria-label="Winter-Durchschnittstemperatur in Grad Celsius" />
          <strong id="flow-value-temperature">--</strong>
        </div>
        <p class="flow-temperature-scale">
          <span>−2,5 °C · 1984/85</span><span>Norm +1,4 °C</span><span>+4,4 °C · 2006/07</span>
        </p>
        <p>Kältester und mildester deutscher Winter der letzten 50 Jahre (DWD-Gebietsmittel
          Dez–Feb). Kälter heißt mehr Entnahme in der Heizperiode (Okt–Mär).</p>
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
    applyScenario("measured");
    renderBottleScale();
    renderAxisScale();
    renderLinearReference();
    bindControls();
    bindeBelege();
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
