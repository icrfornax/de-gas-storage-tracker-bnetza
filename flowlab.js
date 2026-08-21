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
   * Jahresgang des Zuflusses. Abgeleitet aus zwei Messreihen:
   *   Zufluss(Tag) = Verbrauch(THE) + Einspeicherung(GIE) − Ausspeicherung(GIE)
   * Der Rest — Transit und Exporte — faellt heraus; uebrig bleibt das, was dem
   * deutschen Markt tatsaechlich zur Verfuegung stand.
   *
   * Nur Gasjahre ab 2023/24: davor lief Nord Stream (2021/22) beziehungsweise
   * das Notfall-Befuellen des Sommers 2022. Nachgerechnet ist der Unterschied
   * kleiner als erwartet — gepoolt liegt der September bei 0,78 (2021-2023)
   * gegenueber 0,76 (2023-2026), der Fensterfaktor bei 0,889 gegenueber 0,868.
   * Deutlich verschieden ist das Niveau (2.477 gegenueber 2.231 GWh/Tag), und
   * das faellt beim Normieren heraus. Die Einschraenkung bleibt trotzdem, weil
   * das Notfalljahr 2022/23 kein wiederholbares Verhalten abbildet.
   *
   * Geglaettet ueber ein zyklisches 15-Tage-Fenster, damit keine Monatsstufen
   * entstehen, und auf Jahresmittel 1 normiert.
   */
  const INFLOW_REGIME_FROM = 2023;
  const INFLOW_SMOOTH_DAYS = 7;

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

  /**
   * Belege pro Karte. Jeder Eintrag sagt, woher der Wert kommt und was das
   * Reglermaximum bedeutet. Wo keine amtliche Zahl existiert, steht das
   * ausdruecklich dabei — geraten wird nichts.
   *
   * Seit der Umstellung auf den Jahresgang gilt fuer alle drei Zufluss-Regler:
   * der Regler stellt das JAHRESMITTEL, der Tageswert ist Jahresmittel x
   * Jahresgang-Faktor des Kalendertags.
   */
  const SOURCES = {
    pipeline: {
      titel: "Pipeline-Importe",
      aktuell:
        "Der Regler stellt das <strong>Jahresmittel</strong>. Der Tageswert daneben ist " +
        "Jahresmittel × Jahresgang-Faktor des Kalendertags (siehe unten). " +
        "Startwert: 88 % des gemessenen Ist-Zuflusses. Der Anteil stammt aus den " +
        "Importmengen 2024 — 865 TWh insgesamt, davon 69 TWh über deutsche " +
        "LNG-Terminals. Der Rest kam per Pipeline. Größte Lieferländer waren " +
        "Norwegen (48 %), die Niederlande (25 %) und Belgien (18 %); " +
        "<strong>diese Anteile beziehen sich auf alle Importe, nicht nur auf die " +
        "Pipeline-Mengen</strong> — über die Niederlande und Belgien fließt auch " +
        "reexportiertes LNG.",
      maximum:
        "3.000 GWh/Tag im Jahresmittel. 2024 lagen die Pipeline-Importe bei rund " +
        "2.180 GWh/Tag. Höher käme man nur bei durchgehender Vollauslastung der " +
        "Grenzübergangspunkte. <strong>Eine amtliche Gesamtkapazität aller deutschen " +
        "Einspeisepunkte ist nicht veröffentlicht</strong> — diese Obergrenze ist " +
        "deshalb eine Modellgrenze, kein Messwert.",
      quellen: [["Bundesnetzagentur, Gasversorgung 2024", "https://www.bundesnetzagentur.de/DE/Gasversorgung/a_Gasversorgung_2024/start.html"]],
    },
    lng: {
      titel: "LNG-Terminals",
      aktuell:
        "Der Regler stellt das <strong>Jahresmittel</strong>; der Tageswert folgt dem " +
        "Jahresgang. Startwert: 7,5 % des Ist-Zuflusses. 2024 kamen 69 TWh über die " +
        "deutschen LNG-Terminals (Wilhelmshaven, Brunsbüttel, Lubmin, Mukran) — " +
        "8 % aller Importe, im Jahresmittel rund 189 GWh/Tag.",
      maximum:
        "400 GWh/Tag im Jahresmittel. Die drei Terminals der bundeseigenen DET — " +
        "Wilhelmshaven 1 (4,8), Wilhelmshaven 2 (4,3) und Brunsbüttel " +
        "(4,0 Mrd. m³/Jahr) — ergeben zusammen 13,1 Mrd. m³/Jahr, also etwa " +
        "380 GWh/Tag bei lückenloser Anlandung. DET nennt diese Werte als " +
        "<strong>„bis zu“-Nennkapazität</strong>, nicht als Durchsatz; 2024 wurde " +
        "davon knapp die Hälfte genutzt. Stade und Mukran sind hier nicht " +
        "eingerechnet.",
      quellen: [
        ["Bundesnetzagentur, Gasversorgung 2024", "https://www.bundesnetzagentur.de/DE/Gasversorgung/a_Gasversorgung_2024/start.html"],
        ["Deutsche Energy Terminal, Terminals", "https://energy-terminal.de/en/terminals"],
      ],
    },
    domestic: {
      titel: "Inland & Biomethan",
      aktuell:
        "Der Regler stellt das <strong>Jahresmittel</strong>; der Tageswert folgt dem " +
        "Jahresgang. Startwert: 4,5 % des Ist-Zuflusses. Die heimische Erdgasförderung " +
        "lag 2024 bei 4,2 Mrd. m³ beziehungsweise 40,9 TWh und deckte 5,4 % des " +
        "deutschen Bedarfs.",
      maximum:
        "200 GWh/Tag im Jahresmittel. Die Förderung allein entspricht rund " +
        "112 GWh/Tag und ist rückläufig. Der Abstand bis zum Maximum wäre zusätzliche " +
        "Biomethan-Einspeisung — deren Ausbaupfad ist eine Modellannahme.",
      quellen: [["BVEG, Jahresbericht 2024 — Erdgasförderung", "https://jahresbericht.bveg.de/erdgasfoerderung/"]],
    },
    jahresgang: {
      titel: "Jahresgang des Zuflusses",
      aktuell:
        "Der Zufluss ist nicht über das Jahr konstant. Der Tagesfaktor kommt aus zwei " +
        "gemessenen Reihen, nicht aus einer Annahme:<br>" +
        "<strong>Zufluss(Tag) = Verbrauch(THE) + Einspeicherung(GIE) − Ausspeicherung(GIE)</strong><br>" +
        "Transit und Exporte fallen dabei heraus; übrig bleibt, was dem deutschen Markt " +
        "an diesem Tag tatsächlich zur Verfügung stand. Die Tageswerte werden über die " +
        "Referenzjahre gemittelt, zyklisch über ±7 Tage geglättet und auf Jahresmittel 1 " +
        "normiert. Gerechnet aus den Gasjahren 2023/24 bis 2025/26; das Rohmittel dieser " +
        "drei Jahre liegt bei 2.231 GWh/Tag.",
      maximum:
        "Ergebnis: Minimum <strong>0,72 am 14. September</strong>, Maximum " +
        "<strong>1,23 am 21. Dezember</strong>. Monatsmittel: Aug 0,83 · Sep 0,76 · " +
        "Okt 0,99 · Nov 1,18 · Dez 1,21 · Jan 1,04 · Feb 1,08 · Mär 1,13. " +
        "Für das Einspeicherfenster bis zum 1. November ergibt das den Faktor " +
        "<strong>0,87</strong> — das Fenster liegt im Zufluss-Tal, deshalb liegt das " +
        "nötige Jahresniveau über dem nötigen Tagesschnitt.<br>" +
        "<strong>Warum nur Jahre ab 2023/24:</strong> davor lief Nord Stream " +
        "(2021/22) beziehungsweise das Notfall-Befüllen des Sommers 2022. Ehrlich " +
        "gesagt ändert die Einschränkung an der <em>Form</em> wenig — gepoolt liegt der " +
        "September in beiden Regimen bei 0,78 gegenüber 0,76, der Fensterfaktor bei " +
        "0,889 gegenüber 0,868. Deutlich ist der Unterschied im <em>Niveau</em> " +
        "(2.477 gegenüber 2.231 GWh/Tag), und das fällt beim Normieren ohnehin heraus. " +
        "<strong>Die Aufteilung dieses einen Gesamtfaktors auf Pipeline, LNG und " +
        "Inland ist eine Modellannahme</strong> — THE und GIE veröffentlichen nur die " +
        "Summe, nicht den Jahresgang je Quelle.",
      quellen: [
        ["Trading Hub Europe, Aggregierte Verbrauchsdaten", "https://www.tradinghub.eu/de-de/Ver%C3%B6ffentlichungen/Transparenz/Aggregierte-Verbrauchsdaten"],
        ["GIE AGSI+ API v013", "https://www.gie.eu/transparency-platform/GIE_API_documentation_v013.pdf"],
      ],
    },
    households: {
      titel: "Private Haushalte & Gewerbe",
      aktuell:
        "<strong>Kein Regler — gemessener Tageswert.</strong> Angezeigt ist der " +
        "SLP-Wert des gleichen Kalendertags im gewählten Referenz-Gasjahr, unverändert " +
        "aus den Allokationsdaten von Trading Hub Europe übernommen. SLP steht für " +
        "Standardlastprofil-Kunden — Haushalte und kleines Gewerbe. Im Kalenderjahr 2024 " +
        "sind das gemessen 39,1 % des Verbrauchs — die Bundesnetzagentur weist für " +
        "dasselbe Jahr 39 % aus. Über alle fünf Gasjahre liegt der Anteil bei 41,2 %, " +
        "weil er 2021/22 und 2022/23 noch bei 43,3 % lag (Industrie-Einbruch der " +
        "Gaskrise, nicht mehr Heizen).",
      maximum:
        "Gemessen schwankt SLP zwischen Monatsindex 0,22 im Juli und August und 2,06 im " +
        "Januar — Faktor neun zwischen Sommer und Winter; als Tageswerte 0,13 bis 2,81. Ein härterer Winter lässt sich nur " +
        "über die Wahl eines kälteren Referenz-Gasjahres nachstellen, nicht über einen " +
        "Regler; die Messreihe bleibt damit unangetastet.",
      quellen: [
        ["Trading Hub Europe, Aggregierte Verbrauchsdaten", "https://www.tradinghub.eu/de-de/Ver%C3%B6ffentlichungen/Transparenz/Aggregierte-Verbrauchsdaten"],
        ["Bundesnetzagentur, Gasversorgung 2024", "https://www.bundesnetzagentur.de/DE/Gasversorgung/a_Gasversorgung_2024/start.html"],
      ],
    },
    industry: {
      titel: "Industrie",
      aktuell:
        "<strong>Kein Regler — gemessener Tageswert</strong>, hier 70 % des RLM-Werts " +
        "des Kalendertags. RLM steht für registrierende Leistungsmessung — Industrie " +
        "und Kraftwerke, von THE als <em>ein</em> Block gemessen. <strong>Die Trennung " +
        "70/30 zwischen Industrie und Stromerzeugung ist eine Modellannahme</strong>, " +
        "keine gemessene Größe; sie ist auf rund 150 TWh Gas für Strom- und " +
        "Wärmeerzeugung kalibriert.",
      maximum:
        "Die Summe Industrie + Stromerzeugung ist gemessen und damit fest. Verschiebt " +
        "man die 70/30-Annahme, wandert nur Menge zwischen den beiden Karten — der " +
        "Gesamtbedarf und damit der Füllstandspfad ändern sich nicht.",
      quellen: [["Bundesnetzagentur, Gasversorgung 2024", "https://www.bundesnetzagentur.de/DE/Gasversorgung/a_Gasversorgung_2024/start.html"]],
    },
    power: {
      titel: "Stromerzeugung",
      aktuell:
        "<strong>Kein Regler — gemessener Tageswert</strong>, hier 30 % des RLM-Werts " +
        "des Kalendertags, kalibriert auf rund 150 TWh Gas für Strom- und " +
        "Wärmeerzeugung. <strong>Modellannahme</strong> — THE misst Industrie und " +
        "Kraftwerke gemeinsam als RLM.",
      maximum:
        "Wie bei der Industrie: die gemessene RLM-Summe steht fest, nur ihre Aufteilung " +
        "ist Annahme. Auf den Füllstandspfad wirkt sie sich nicht aus.",
      quellen: [["Bundesnetzagentur, Gasversorgung 2024", "https://www.bundesnetzagentur.de/DE/Gasversorgung/a_Gasversorgung_2024/start.html"]],
    },
    ziel: {
      titel: "Das 80-Prozent-Ziel",
      aktuell:
        "Die Projektion rechnet den eingestellten Zufluss bis zum 1. November fort. " +
        "Voreingestellt ist der <strong>Ist-Zufluss</strong>: der gemessene Bedarf am " +
        "Datenstand plus das gemessene 30-Tage-Einspeichertempo. Die grüne Linie " +
        "daneben zeigt, wo der Speicher bei dem Zufluss läge, der das Ziel trägt. " +
        "Hinter dem 1. November läuft sie mit demselben Zufluss weiter — das ist " +
        "keine Prognose, sondern zeigt nur, was aus einem vollen Speicher über den " +
        "Winter würde.",
      maximum:
        "<strong>Vorsicht mit den 80 % als Rechtsvorgabe.</strong> Die deutsche " +
        "Gasspeicherfüllstandsverordnung vom 05.05.2025 schreibt zum 1. November 80 % für " +
        "Kavernenspeicher und für vier süddeutsche Porenspeicher (Bierwang, Breitbrunn, " +
        "Inzenham-West, Wolfersberg) vor, aber nur 45 % für alle übrigen Porenspeicher. " +
        "Der VKU rechnet daraus einen deutschen Gesamtdurchschnitt von rund 70 %. " +
        "Die EU-Verordnung 2025/1733 vom 18.07.2025 nennt 90 %, aber nicht zu einem festen " +
        "Stichtag, sondern <strong>zu einem beliebigen Zeitpunkt zwischen dem 1. Oktober " +
        "und dem 1. Dezember</strong>, und lässt Abweichungen von <strong>zusammen bis zu " +
        "20 Prozentpunkten</strong> zu (10 bei erschwerten Befüllbedingungen, je 5 weitere " +
        "unter zusätzlichen Voraussetzungen). Die 80 %-Linie in dieser Grafik ist deshalb " +
        "eine <strong>Bezugsmarke, kein auf den Gesamtfüllstand anwendbarer Grenzwert</strong>.",
      quellen: [
        ["VKU zu den Füllstandszielen nach EU-Trilog", "https://www.vku.de/themen/energiewende/artikel/nach-eu-trilog-die-fuellstandsziele-der-deutschen-gasspeicherfuellstandsverordnung-bleiben/"],
        ["BMWK: Füllstandsvorgaben für Gasspeicheranlagen (30.04.2025)", "https://www.bundeswirtschaftsministerium.de/Redaktion/DE/Pressemitteilungen/2025/20250430-Fuellstandsvorgaben-fuer-Gasspeicheranlagen.html"],
        ["Verordnung (EU) 2025/1733", "https://eur-lex.europa.eu/eli/reg/2025/1733/oj"],
      ],
    },
    refyear: {
      titel: "Referenz-Gasjahr",
      aktuell:
        "Der Tagesverbrauch stammt aus den aggregierten Allokationsdaten von " +
        "Trading Hub Europe für das deutsche Marktgebiet — je Gastag, getrennt nach " +
        "SLP (Haushalte und Gewerbe) und RLM (Industrie und Kraftwerke). Für das " +
        "Kalenderjahr 2024 ergibt die Reihe 838,3 TWh Verbrauch bei 39,1 % SLP-Anteil; " +
        "die Bundesnetzagentur nennt für dasselbe Jahr 844 TWh und 39 % — zwei " +
        "unabhängige Wege, 0,7 % Abstand. Die Auswahl tauscht die komplette Tagesreihe " +
        "der Entnahme aus — nichts wird skaliert.",
      maximum:
        "Zur Auswahl stehen die Gasjahre, für die Messwerte vorliegen. " +
        "<strong>Ein Winter unterhalb der DWD-Norm von +1,4 °C ist nicht darunter</strong> — " +
        "seit Beginn der THE-Veröffentlichung 2018 war jeder deutsche Winter mild bis " +
        "normal. Der kälteste verfügbare ist 2025/26 mit +1,72 °C, der mildeste " +
        "2023/24 mit +4,04 °C. Ein echter Kältewinter lässt sich aus diesen Messwerten " +
        "nicht nachstellen; die Spanne der Jahre ist die ehrliche Untergrenze dessen, " +
        "was passieren kann.",
      quellen: [
        ["Trading Hub Europe, Aggregierte Verbrauchsdaten", "https://www.tradinghub.eu/de-de/Ver%C3%B6ffentlichungen/Transparenz/Aggregierte-Verbrauchsdaten"],
        ["DWD, Gebietsmittel Winter Deutschland (CDC)", "https://opendata.dwd.de/climate_environment/CDC/regional_averages_DE/seasonal/air_temperature_mean/regional_averages_tm_winter.txt"],
      ],
    },
  };

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
    inflowIndex: new Map(),   // "MM-TT" -> Faktor, Jahresmittel 1
    inflowYears: [],          // Gasjahre, aus denen der Jahresgang stammt
    storageFlows: new Map(),  // "JJJJ-MM-TT" -> Netto-Speicherbewegung in GWh
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

  /**
   * Baut den Jahresgang des Zuflusses aus den beiden Messreihen.
   * Ohne ausreichende Daten bleibt der Index leer und alles rechnet flach.
   */
  function buildInflowIndex() {
    state.inflowIndex = new Map();
    state.inflowYears = [];
    if (!state.consumption.size || !state.storageFlows.size) return;

    const jahre = [...state.consumption.keys()].filter((j) => j >= INFLOW_REGIME_FROM);
    if (!jahre.length) return;

    const proTag = new Map();   // "MM-TT" -> Liste abgeleiteter Zufluesse
    jahre.forEach((jahr) => {
      state.consumption.get(jahr).forEach((tag, schluessel) => {
        const datum = `${schluessel <= "07-31" ? jahr + 1 : jahr}-${schluessel}`;
        const netto = state.storageFlows.get(datum);
        if (netto === undefined) return;
        if (!proTag.has(schluessel)) proTag.set(schluessel, []);
        proTag.get(schluessel).push(tag.slp + tag.rlm + netto);
      });
    });
    if (proTag.size < 300) return;

    const schluessel = [...proTag.keys()].sort();
    const mittel = schluessel.map(
      (k) => proTag.get(k).reduce((s, v) => s + v, 0) / proTag.get(k).length,
    );

    // Zyklisch glaetten, damit der 31. Dezember an den 1. Januar anschliesst.
    const n = mittel.length;
    const glatt = mittel.map((_, i) => {
      let summe = 0;
      for (let k = -INFLOW_SMOOTH_DAYS; k <= INFLOW_SMOOTH_DAYS; k += 1) {
        summe += mittel[(i + k + n) % n];
      }
      return summe / (2 * INFLOW_SMOOTH_DAYS + 1);
    });
    const norm = glatt.reduce((s, v) => s + v, 0) / n;
    if (!(norm > 0)) return;

    schluessel.forEach((k, i) => state.inflowIndex.set(k, glatt[i] / norm));
    state.inflowYears = jahre.sort((a, b) => a - b);
  }

  /** Faktor fuer den Kalendertag; 1, solange kein Jahresgang vorliegt. */
  function inflowFactor(index) {
    if (!state.inflowIndex.size) return 1;
    const schluessel = monthDay(dayDate(index));
    return state.inflowIndex.get(schluessel)
      ?? (schluessel === "02-29" ? state.inflowIndex.get("02-28") : null)
      ?? 1;
  }

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

  /** Vom Nutzer gestelltes Jahresmittel des Zuflusses. */
  const supplyTotal = () =>
    state.supply.pipeline + state.supply.lng + state.supply.domestic;

  /** Tatsaechlicher Zufluss eines Tages: Niveau mal Jahresgang. */
  const supplyOn = (index) => supplyTotal() * inflowFactor(index);

  /** Netto-Bilanz eines Tages in GWh, begrenzt durch Ein-/Ausspeicherkapazität. */
  const netOn = (index) =>
    clamp(
      supplyOn(index) - demandOn(index).total,
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
    let faktorSumme = 0;
    for (let index = state.day; index < state.targetIndex; index += 1) {
      faktorSumme += inflowFactor(index);
    }
    const schnitt = demandSum / days + perDayPp * state.ppGwh;
    const faktor = days > 0 ? faktorSumme / days : 1;
    return {
      met: current >= TARGET_FILL,
      pp: perDayPp,
      gwh: schnitt,                       // noetiger Tagesschnitt im Fenster
      niveau: faktor > 0 ? schnitt / faktor : schnitt,   // noetiges Jahresniveau
      faktor,
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
    const targetLabel = el("flow-bottle-target-label");
    targetLabel.setAttribute("y", targetY - 9);

    // Der Knopf wandert mit der Ziellinie und haengt sich an das gemessene
    // Textende — feste Koordinaten wuerden bei anderer Schrift verrutschen.
    const info = el("flow-bottle-target-info");
    if (info) {
      let breite = 108;
      try { breite = targetLabel.getComputedTextLength() || breite; } catch (error) { /* jsdom */ }
      info.setAttribute("transform", `translate(${(64 + breite + 13).toFixed(1)},${(targetY - 13).toFixed(1)})`);
    }
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
        state.supply[key] * inflowFactor(state.day),
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

  /**
   * Zweite Kurve: derselbe Bedarf, aber Zufluss auf Zielniveau.
   * Endet am 1. November. Danach ist der Zielpfad nicht definiert — er wuerde
   * nur zeigen, was ein Weiterpumpen auf Zielniveau im Winter anrichtet, und
   * das hat mit dem Ziel nichts mehr zu tun.
   */
  function renderTargetPath() {
    const pfad = el("flow-axis-goal");
    if (!pfad) return;
    const niveau = zielZufluss();
    let fill = state.startFill;
    let d = `M${axisX(0).toFixed(1)},${axisY(fill).toFixed(1)}`;
    for (let index = 0; index < state.targetIndex; index += 1) {
      const net = clamp(
        niveau * inflowFactor(index) - demandOn(index).total,
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
    label.textContent = `Zielpfad · Ø ${nf0.format(Math.round(zielSchnitt()))} GWh/Tag bis 1. Nov`;
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
    // Der Zufluss folgt demselben Prinzip wie die Entnahme: Tageswert gross,
    // eingestelltes Jahresmittel klein darunter.
    const faktor = inflowFactor(state.day);
    SUPPLY_KEYS.forEach((quelle) => {
      el(`flow-value-${quelle}`).textContent = gwh(state.supply[quelle] * faktor);
      const mittel = el(`flow-mean-${quelle}`);
      if (mittel) mittel.textContent = `Jahresmittel ${gwh(state.supply[quelle])}`;
    });
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
      `Zufluss ${nf0.format(Math.round(supplyOn(state.day)))} − Entnahme ${nf0.format(Math.round(demand.total))} · ` +
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
    const kopf = el("flow-required-head");
    const marke = '<i class="flow-key flow-key-in"></i>';

    const luecke0 = el("flow-required-gap");
    if (!required) {
      value.dataset.tone = "";
      // Hinter dem Zieltag gibt es keinen "benoetigten Zufluss" mehr. Statt
      // eines Gedankenstrichs unter einer stehengebliebenen Ueberschrift sagt
      // die Kachel dann, was tatsaechlich gilt.
      if (kopf) kopf.innerHTML = `${marke}Nach dem 1. November`;
      value.textContent = "Winterentnahme";
      if (luecke0) { luecke0.textContent = ""; luecke0.dataset.tone = ""; }
      detail.textContent =
        "Das Einspeicherfenster ist geschlossen; ab hier zählt, wie weit die " +
        "gemessene Entnahme des Referenzjahres den Speicher leert.";
      return;
    }
    if (kopf) kopf.innerHTML = `${marke}Benötigter täglicher Zufluss bis 80% am 1. November`;
    if (required.met) {
      value.dataset.tone = "ok";
      value.textContent = "Ziel erreicht";
      if (luecke0) { luecke0.textContent = ""; luecke0.dataset.tone = ""; }
      detail.textContent = `Der simulierte Füllstand liegt am ${dateText(dayIso(state.day))} bereits bei mindestens 80%.`;
      return;
    }

    // Vergleich auf Ebene des Fensterschnitts: das ist die Zahl, die man
    // als "so viel muss taeglich kommen" lesen kann.
    const current = supplyTotal() * required.faktor;
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
    // Die Tageszahl ist die Restlaufzeit ab dem eingestellten Tag, nicht die
    // Fensterlaenge — sonst steht am 27. Oktober immer noch "75 Tage".
    const restTage = Math.max(1, state.targetIndex - state.day);
    detail.textContent =
      `Ø über ${restTage === 1 ? "den letzten Tag" : `die ${nf0.format(restTage)} Tage`} bis zum Ziel, ` +
      `entspricht +${nf2.format(required.pp)} pp/Tag · ` +
      `eingestellt: ${nf0.format(Math.round(current))} GWh/Tag im selben Zeitraum · ` +
      `nötiges Jahresniveau ${nf0.format(Math.round(required.niveau))} GWh/Tag, ` +
      // Ab Ende Oktober steigt der Jahresgang ueber 1 — dann ist "Tal" falsch.
      `weil das Restfenster ${required.faktor < 1 ? "im Zufluss-Tal" : "über dem Jahresmittel"} ` +
      `liegt (Faktor ${nf2.format(required.faktor)})` +
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
  // Zeitpunkt des letzten Scrollens. Beim Scrollen wandert die Seite unter dem
  // ruhenden Zeiger weg und loest pointerover auf einem beliebigen Element aus.
  // Ohne diese Schonfrist schloss sich das Popover schon nach 80 Pixeln,
  // obwohl der Knopf noch vollstaendig im Bild stand.
  let letzterScroll = 0;
  const SCROLL_SCHONFRIST_MS = 500;

  /** Steht der Ausloeser noch sichtbar im Fenster? */
  function ausloeserImBild() {
    if (!popoverAusloeser) return false;
    const r = popoverAusloeser.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }

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
      // Kam das Ereignis vom Scrollen und nicht von einer echten Mausbewegung,
      // bleibt das Popover stehen, solange sein Knopf sichtbar ist.
      if (performance.now() - letzterScroll < SCROLL_SCHONFRIST_MS && ausloeserImBild()) return;
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
    window.addEventListener("scroll", () => {
      letzterScroll = performance.now();
      positioniereBeleg();
    }, { passive: true });
    window.addEventListener("resize", positioniereBeleg);
  }

  /* ------------------------------------------------------------- CSV-Export */

  /**
   * Erzeugt die Tagestabelle der laufenden Simulation zum Nachrechnen.
   * Der Kommentarkopf haelt alle Annahmen und Quellen fest, damit die Datei
   * ohne diese Seite pruefbar bleibt.
   */
  /** Kopfzeilen, die fuer jede Ausgabe gelten. */
  function csvKopf(titel, extra) {
    const zufluss = supplyTotal();
    return [
      `# ${titel}`,
      `# erzeugt am: ${dateText(isoDate(new Date()))}`,
      `# Datenstand GIE AGSI+: ${state.startDate}, Fuellstand ${state.startFill} %`,
      `# Arbeitsgasvolumen: ${(state.ppGwh * 100) / 1000} TWh, 1 Prozentpunkt = ${state.ppGwh.toFixed(2)} GWh`,
      `# Einspeicherkapazitaet: ${state.injectionCapacity} GWh/Tag ` +
        `(kleinerer Wert aus GIE-Tagesmeldung und dem technischen Snapshot ` +
        `de_storage_capacity.json — bewusst konservativ)`,
      `# Ausspeicherkapazitaet: ${state.withdrawalCapacity} GWh/Tag`,
      `# gemessenes 30-Tage-Tempo: ${state.measuredRate.toFixed(4)} pp/Tag`,
      `# Jahresgang des Zuflusses aus Gasjahren: ` +
        `${state.inflowYears.map((j) => `${j}/${String(j + 1).slice(2)}`).join(", ") || "keiner"}` +
        ` (geglaettet ueber ${2 * INFLOW_SMOOTH_DAYS + 1} Tage, Jahresmittel 1)`,
      `# eingestelltes Zufluss-Jahresmittel: ${zufluss.toFixed(1)} GWh/Tag ` +
        `(Pipeline ${state.supply.pipeline.toFixed(1)}, LNG ${state.supply.lng.toFixed(1)}, ` +
        `Inland ${state.supply.domestic.toFixed(1)})`,
      ...extra,
      "#",
      "# Rechenweg je Tag:",
      "#   bedarf_haushalte = SLP(Kalendertag im Referenzjahr)          [unveraendert gemessen]",
      "#   bedarf_industrie = RLM(Kalendertag im Referenzjahr) x 0,70    [Aufteilung ist Annahme]",
      "#   bedarf_strom     = RLM(Kalendertag im Referenzjahr) x 0,30    [Aufteilung ist Annahme]",
      "#   zufluss = zufluss_jahresmittel x jahresgang(Kalendertag)",
      "#   netto  = min(Einspeicherkap., max(-Ausspeicherkap., zufluss - bedarf))",
      "#   fuellstand(t+1) = fuellstand(t) + netto / GWh-je-Prozentpunkt, gedeckelt 0..100",
      "#   zielpfad_fuellstand_pct steht nur bis zum Zieltag; danach ist der",
      "#   Zielpfad nicht definiert und die Spalte bleibt leer.",
      "#",
      "# Quellen:",
      "#   Verbrauch: Trading Hub Europe, AggregatedConsumptionData (SLP + RLM)",
      "#   Speicher:  GIE AGSI+ API v013",
      "#   Jahresgang Zufluss: abgeleitet als Verbrauch + Einspeicherung - Ausspeicherung",
      "#     aus denselben zwei Reihen. Nur Gasjahre ab 2023/24, weil Nord Stream und",
      "#     das Notfall-Befuellen 2022 einen anderen Sommergang hatten.",
      "#   Bezugsmix: Bundesnetzagentur, Gasversorgung 2024; BVEG Jahresbericht 2024",
      "#   LNG:       Deutsche Energy Terminal",
      "#   Winter:    DWD Gebietsmittel Dez-Feb (CDC)",
      "#",
      "# Annahme, die keine Messung ist: die Trennung 70/30 zwischen Industrie und",
      "# Stromerzeugung. THE misst beide gemeinsam als RLM.",
      "# Vollstaendige Herleitung und Pruefung der Datenbasis: METHODIK.pdf im Repository.",
    ].join("\n");
  }

  const CSV_SPALTEN = [
    "referenzjahr", "datum", "tag", "referenztag",
    "bedarf_haushalte_gwh", "bedarf_industrie_gwh", "bedarf_strom_gwh", "bedarf_gesamt_gwh",
    "zufluss_jahresgang", "zufluss_gwh", "netto_gwh", "fuellstand_pct", "zielpfad_fuellstand_pct",
  ].join(",");

  /**
   * Tageszeilen fuer ein Referenzjahr. Rechnet unabhaengig von state.fills,
   * damit dieselbe Funktion auch fuer die anderen Jahre laufen kann.
   * Der Zufluss bleibt dabei, wie er eingestellt ist — so ist der Unterschied
   * zwischen den Jahren allein der gemessene Verbrauch.
   */
  function csvZeilen(refJahr) {
    const merk = state.refYear;
    state.refYear = refJahr;
    const label = `${refJahr}/${String(refJahr + 1).slice(2)}`;
    const ziel = zielZufluss();
    const zeilen = [];
    let fill = state.startFill;
    let zielFill = state.startFill;
    for (let index = 0; index <= state.days; index += 1) {
      const bedarf = demandOn(index);
      const netto = index < state.days ? netOn(index) : 0;
      if (index > 0) {
        if (index <= state.targetIndex) {
          const zielNetto = clamp(
            ziel * inflowFactor(index - 1) - demandOn(index - 1).total,
            -state.withdrawalCapacity,
            state.injectionCapacity,
          );
          zielFill = clamp(zielFill + zielNetto / state.ppGwh, 0, 100);
        }
        const vorher = clamp(netOn(index - 1), -state.withdrawalCapacity, state.injectionCapacity);
        fill = clamp(fill + vorher / state.ppGwh, 0, 100);
      }
      zeilen.push([
        label,
        dayIso(index),
        index,
        monthDay(dayDate(index)),
        bedarf.households.toFixed(1),
        bedarf.industry.toFixed(1),
        bedarf.power.toFixed(1),
        bedarf.total.toFixed(1),
        inflowFactor(index).toFixed(4),
        supplyOn(index).toFixed(1),
        netto.toFixed(1),
        fill.toFixed(3),
        index <= state.targetIndex ? zielFill.toFixed(3) : "",
      ].join(","));
    }
    state.refYear = merk;
    return zeilen;
  }

  /** Der laufende Durchgang: nur das gewaehlte Referenzjahr. */
  function buildCsv() {
    const kopf = csvKopf("Flussbilanz-Labor — Tagestabelle der Simulation", [
      `# Referenz-Gasjahr fuer den Verbrauch: ${state.refYear}/${String(state.refYear + 1).slice(2)}`,
      `# Zielpfad: ${zielSchnitt().toFixed(1)} GWh/Tag im Schnitt bis ${state.targetDate}` +
        `, entspricht einem Jahresmittel von ${zielZufluss().toFixed(1)} GWh/Tag`,
      `# gemessene Jahresmittel des Referenzjahres (Entnahme, nicht einstellbar): ` +
        `Haushalte ${state.base.households.toFixed(1)}, Industrie ${state.base.industry.toFixed(1)}, ` +
        `Strom ${state.base.power.toFixed(1)} GWh/Tag`,
    ]);
    return `${kopf}\n${CSV_SPALTEN}\n${csvZeilen(state.refYear).join("\n")}\n`;
  }

  /**
   * Gesamtlauf: alle Referenzjahre untereinander, gleicher Zufluss.
   * Damit laesst sich ausserhalb dieser Seite pruefen, wie stark das Ergebnis
   * am gewaehlten Verbrauchsjahr haengt — der einzige Unterschied zwischen den
   * Bloecken ist die gemessene Tagesreihe der Entnahme.
   */
  function buildCsvGesamt() {
    const jahre = state.refYears.length ? state.refYears : [state.refYear];
    const merk = state.refYear;
    const bilanz = jahre.map((jahr) => {
      state.refYear = jahr;
      const tag0 = demandOn(0).total + state.measuredRate * state.ppGwh;
      const zeile =
        `#   ${jahr}/${String(jahr + 1).slice(2)}: Winter ${DWD_WINTER[jahr + 1] !== undefined ? `${DWD_WINTER[jahr + 1]} °C` : "unbekannt"}` +
        `, Ist-Zufluss am Datenstand ${tag0.toFixed(0)} GWh/Tag` +
        `, noetiger Tagesschnitt bis zum Ziel ${zielSchnitt().toFixed(0)} GWh/Tag`;
      return zeile;
    });
    state.refYear = merk;

    const kopf = csvKopf("Flussbilanz-Labor — Gesamtlauf ueber alle Referenzjahre", [
      `# Referenz-Gasjahre in dieser Datei: ` +
        `${jahre.map((j) => `${j}/${String(j + 1).slice(2)}`).join(", ")}`,
      "# Spalte zufluss_gwh ist in allen Bloecken dieselbe (siehe oben). Der einzige",
      "# Unterschied zwischen den Jahren ist die gemessene Tagesreihe der Entnahme.",
      "# Die Spalte zielpfad_fuellstand_pct rechnet dagegen je Jahr mit dem Zufluss,",
      "# den GERADE DIESES Jahr fuer 80 % braeuchte — sie endet deshalb in jedem",
      "# Block bei 80,000 %. Die Spanne dieser noetigen Zufluesse steht unten.",
      "#",
      "# Je Referenzjahr:",
      ...bilanz,
    ]);
    const zeilen = jahre.flatMap((jahr) => csvZeilen(jahr));
    return `${kopf}\n${CSV_SPALTEN}\n${zeilen.join("\n")}\n`;
  }

  function speichereCsv(text, name) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function ladeCsvHerunter() {
    speichereCsv(buildCsv(), `flussbilanz_${state.startDate}_gasjahr${state.refYear}.csv`);
  }

  function ladeGesamtCsvHerunter() {
    speichereCsv(buildCsvGesamt(), `flussbilanz_${state.startDate}_gesamtlauf.csv`);
  }

  /* ---------------------------------------------------------------- Interaktion */

  const SLIDERS = [
    ["flow-slider-pipeline", "supply", "pipeline"],
    ["flow-slider-lng", "supply", "lng"],
    ["flow-slider-domestic", "supply", "domestic"],
  ];

  /** Gerundete Reglerstellungen in den State zuruecklesen. */
  function uebernehmeReglerwerte() {
    SLIDERS.forEach(([id, group, key]) => {
      const slider = el(id);
      if (slider) state[group][key] = number(slider.value) ?? state[group][key];
    });
  }

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
        // Der Horizont haengt am Datenstand, nicht am Referenzjahr — der Tag
        // sollte also passen. Geklemmt wird trotzdem.
        state.day = clamp(state.day, 0, state.days);
        applySliderPositions();
        uebernehmeReglerwerte();
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
    el("flow-csv-all")?.addEventListener("click", ladeGesamtCsvHerunter);
    el("flow-reset")?.addEventListener("click", () => {
      stopPlayback();
      state.day = 0;
      seedFromData();
      applySliderPositions();
      // Die Regler rasten auf ihre Schrittweite. Ohne diesen Rueckweg stuende im
      // State ein anderer Wert als unter dem Regler — beim naechsten Ziehen
      // spraenge die Anzeige.
      uebernehmeReglerwerte();
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

    // Netto-Speicherbewegung je Tag — zweite Haelfte der Zufluss-Ableitung.
    state.storageFlows = new Map();
    rows.forEach((row) => {
      const ein = number(row.injection_gwh_per_day);
      const aus = number(row.withdrawal_gwh_per_day);
      if (ein === null && aus === null) return;
      state.storageFlows.set(row.date, (ein ?? 0) - (aus ?? 0));
    });
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
    // Der Simulationstag bleibt, wo er ist — wer beim 1. Dezember steht und das
    // Referenzjahr wechselt, will genau diesen Tag vergleichen. Wer von vorn
    // anfangen will, nimmt "Zuruecksetzen".
    // Gemessener Ist-Zufluss am Datenstand: Bedarf plus 30-Tage-Einspeichertempo.
    // Geteilt durch den Jahresgang-Faktor dieses Tages ergibt das Jahresniveau,
    // das die Regler stellen.
    const istTag0 = demandOn(0).total + state.measuredRate * state.ppGwh;
    verteileZufluss(istTag0 / (inflowFactor(0) || 1), SUPPLY_SHARES);
  }

  /**
   * Summe auf die drei Quellen verteilen.
   * Ohne `mischung` bleibt die eingestellte Aufteilung erhalten (Skalieren);
   * mit `mischung` wird sie ersetzt — das braucht "Zuruecksetzen", sonst
   * kaeme die Summe zwar zurueck, aber in der zuletzt gezogenen Aufteilung.
   */
  function verteileZufluss(summe, mischung) {
    const aktuell = supplyTotal();
    const anteil = mischung
      ? mischung
      : aktuell > 0
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
  /** Im Einspeicherfenster noetiger Zufluss — als Tagesschnitt, ab Tag 0. */
  function zielSchnitt() {
    let bedarf = 0;
    for (let index = 0; index < state.targetIndex; index += 1) {
      bedarf += demandOn(index).total;
    }
    const luecke = Math.max(0, TARGET_FILL - state.startFill);
    return (bedarf + luecke * state.ppGwh) / state.targetIndex;
  }

  /** Mittlerer Jahresgang-Faktor ueber das Einspeicherfenster. */
  function fensterFaktor() {
    let summe = 0;
    for (let index = 0; index < state.targetIndex; index += 1) summe += inflowFactor(index);
    return state.targetIndex > 0 ? summe / state.targetIndex : 1;
  }

  /**
   * Jahresniveau, das den noetigen Fensterschnitt traegt.
   * Das Fenster liegt im Zufluss-Tal (Faktor rund 0,87), das noetige
   * Jahresniveau liegt deshalb ueber dem Fensterschnitt.
   */
  function zielZufluss() {
    const faktor = fensterFaktor();
    return faktor > 0 ? zielSchnitt() / faktor : zielSchnitt();
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
    const jahresgang = state.inflowIndex.size
      ? `Der Jahresgang ist gemessen, nicht gesetzt: Zufluss(Tag) = Verbrauch (THE) ` +
        `+ Einspeicherung − Ausspeicherung (GIE), gemittelt über die Gasjahre ` +
        `${state.inflowYears.map((j) => `${j}/${String(j + 1).slice(2)}`).join(", ")}, ` +
        `zyklisch über ±${INFLOW_SMOOTH_DAYS} Tage geglättet und auf Jahresmittel 1 normiert ` +
        `(Minimum 0,72 Mitte September, Maximum 1,23 kurz vor Weihnachten). `
      : `<strong>Ohne Jahresgang</strong>, weil die abgeleitete Reihe zu kurz ist; der Zufluss läuft flach. `;
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
        `Zufluss je Tag = eingestelltes Jahresmittel × Jahresgang-Faktor des Kalendertags. ` +
        `${jahresgang}` +
        `Netto = Zufluss − Bedarf, begrenzt auf Ein- und Ausspeicherkapazität. ` +
        `Füllstand<sub>t+1</sub> = Füllstand<sub>t</sub> + Netto / ` +
        `${nf0.format(Math.round(state.ppGwh))} GWh, gedeckelt auf 0–100 %. ` +
        `Einstellbar ist nur der Zufluss; er startet auf dem gemessenen Ist-Niveau ` +
        `(Bedarf am Datenstand plus das 30-Tage-Einspeichertempo). Die grüne Linie zeigt ` +
        `daneben den Zufluss, der das 80-%-Ziel trüge. ` +
        `<strong>Als Annahme bleiben der Bezugsmix, die Aufteilung des Jahresgangs auf die ` +
        `drei Quellen und die Trennung 70/30 zwischen Industrie und Stromerzeugung</strong> ` +
        `— das <i>i</i> an jeder Karte nennt Herkunft und Grenzen.`
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
        <p class="flow-column-head"><i class="flow-key flow-key-in"></i>Zufluss · Quellen<button class="flow-info" type="button" data-info="jahresgang" aria-label="Quelle und Rechenweg: Jahresgang des Zuflusses">i</button></p>

        <div class="flow-card" data-flow="pipeline">
          <div class="flow-card-row">
            <span class="flow-card-name"><label for="flow-slider-pipeline">Pipeline-Importe</label><button class="flow-info" type="button" data-info="pipeline" aria-label="Quelle und Maximum: Pipeline-Importe">i</button></span>
            <span class="flow-card-value" id="flow-value-pipeline">--</span>
          </div>
          <input id="flow-slider-pipeline" type="range" value="0" />
          <small><span id="flow-mean-pipeline">–</span> · Norwegen · NL · Belgien</small>
        </div>

        <div class="flow-card" data-flow="lng">
          <div class="flow-card-row">
            <span class="flow-card-name"><label for="flow-slider-lng">LNG-Terminals</label><button class="flow-info" type="button" data-info="lng" aria-label="Quelle und Maximum: LNG-Terminals">i</button></span>
            <span class="flow-card-value" id="flow-value-lng">--</span>
          </div>
          <input id="flow-slider-lng" type="range" value="0" />
          <small><span id="flow-mean-lng">–</span> · Wilhelmshaven · Brunsbüttel</small>
        </div>

        <div class="flow-card" data-flow="domestic">
          <div class="flow-card-row">
            <span class="flow-card-name"><label for="flow-slider-domestic">Inland &amp; Biomethan</label><button class="flow-info" type="button" data-info="domestic" aria-label="Quelle und Maximum: Inland &amp; Biomethan">i</button></span>
            <span class="flow-card-value" id="flow-value-domestic">--</span>
          </div>
          <input id="flow-slider-domestic" type="range" value="0" />
          <small><span id="flow-mean-domestic">–</span> · Förderung · Biomethan</small>
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
          <g id="flow-bottle-target-info" class="flow-info flow-info-svg" data-info="ziel"
             role="button" tabindex="0" transform="translate(180,138)"
             aria-label="Quelle und Einordnung: die gesetzlichen Füllstandsvorgaben">
            <circle class="flow-info-ring" cx="0" cy="0" r="7.5"></circle>
            <text class="flow-info-glyph" x="0" y="0" text-anchor="middle"
                  dominant-baseline="central">i</text>
          </g>

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
        <i class="flow-key flow-key-goal"></i>Zielpfad für 80 % am 1. Nov ·
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
        <span class="flow-download-buttons">
          <button id="flow-csv" class="flow-button flow-button-ghost" type="button">↓ Tagestabelle als CSV</button>
          <button id="flow-csv-all" class="flow-button flow-button-ghost" type="button">↓ Gesamtlauf (alle Jahre)</button>
          <a id="flow-methodik" class="flow-button flow-button-ghost" href="METHODIK.pdf"
             target="_blank" rel="noreferrer">↓ Methodik &amp; Quellen (PDF)</a>
        </span>
        <span>Die <strong>Tagestabelle</strong> enthält jeden Simulationstag des gewählten
          Referenzjahres mit Bedarf je Sektor, Zufluss, Netto-Bilanz, Füllstand und Zielpfad.
          Der <strong>Gesamtlauf</strong> stellt alle Referenzjahre bei identischem Zufluss
          untereinander — so sieht man, wie stark das Ergebnis am Verbrauchsjahr hängt.
          Im Dateikopf stehen alle Parameter, der Rechenweg und die Quellen. Das
          <strong>Methodik-PDF</strong> belegt Herkunft, Prüfung und Grenzen jeder Zahl.</span>
      </p>
    </div>

    <div class="flow-foot flow-foot-single">
      <div class="flow-required">
        <span id="flow-required-head"><i class="flow-key flow-key-in"></i>Benötigter täglicher Zufluss bis 80% am 1. November</span>
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
      buildInflowIndex();
      setHorizon();
      renderRefYearChips();
      seedFromData();
      renderBottleScale();
      renderAxisScale();
      renderLinearReference();
      bindControls();
      bindeBelege();
      applySliderPositions();
      // Gleich beim Aufbau auf die Reglerraster einrasten, damit "Zuruecksetzen"
      // exakt denselben Zustand herstellt wie der erste Seitenaufruf.
      uebernehmeReglerwerte();
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
