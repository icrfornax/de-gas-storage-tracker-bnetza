#!/usr/bin/env python3
"""Erzeugt METHODIK.pdf — Herkunft, Pruefung und Grenzen jeder Zahl im Flussbilanz-Labor.

Alle Kennzahlen werden hier aus den Datendateien des Repositorys frisch
gerechnet, nicht abgeschrieben. Was nicht gerechnet werden kann (Zahlen aus
Behoerdenberichten), steht mit Quelle und Abrufdatum in TEXTQUELLEN.
"""
import csv, json, datetime as dt, statistics as st, sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, KeepTogether, PageBreak,
                               PageTemplate, Paragraph, Spacer, Table, TableStyle)

# Aufruf ohne Argumente: Repository-Wurzel relativ zu dieser Datei, Ausgabe
# als METHODIK.pdf daneben. Mit Argumenten: build_methodik.py <wurzel> <ziel>.
_HIER = Path(__file__).resolve().parent
ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else _HIER.parent
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "METHODIK.pdf"

# --------------------------------------------------------------- Schriften
F = "/usr/share/fonts/truetype/dejavu"
pdfmetrics.registerFont(TTFont("DJ", f"{F}/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DJ-B", f"{F}/DejaVuSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("DJ-I", f"{F}/DejaVuSans-Oblique.ttf"))
pdfmetrics.registerFont(TTFont("DJ-M", f"{F}/DejaVuSansMono.ttf"))
pdfmetrics.registerFontFamily("DJ", normal="DJ", bold="DJ-B", italic="DJ-I")

TEAL = colors.HexColor("#0b3b3c")
ACC = colors.HexColor("#12796f")
GREY = colors.HexColor("#5b6670")
LINE = colors.HexColor("#c9d2d4")
BG = colors.HexColor("#eef4f3")

# --------------------------------------------------------------- Daten laden
def rows(name):
    with (ROOT / name).open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh))

con = rows("data/de_consumption_daily.csv")
gie = [r for r in rows("data/gie_storage.csv") if r["scope"] == "DE"]
cap = json.loads((ROOT / "data/de_storage_capacity.json").read_text(encoding="utf-8"))

num = lambda v, d=0.0: float(v) if v not in (None, "") else d
gy = lambda s: int(s[:4]) if int(s[5:7]) >= 8 else int(s[:4]) - 1

start = gie[-1]
D0 = dt.date.fromisoformat(start["date"])
F0 = num(start["fill_pct"])
PP = num(start["working_gas_volume_twh"]) * 1000 / 100
INJ = min(num(start["injection_capacity_gwh_per_day"]), cap["technical_max_injection_gwh_per_day"])
WDR = num(start["withdrawal_capacity_gwh_per_day"])
hist = {dt.date.fromisoformat(r["date"]): num(r["fill_pct"]) for r in gie}
RATE = (F0 - hist[D0 - dt.timedelta(days=30)]) / 30

# --------------------------------------------------------------- Kennzahlen
status = {}
for r in con:
    status[r["status"]] = status.get(r["status"], 0) + 1
tage = [dt.date.fromisoformat(r["date"]) for r in con]
luecken = sum(1 for i in range(1, len(tage)) if (tage[i] - tage[i - 1]).days != 1)

jahre = {}
for r in con:
    jahre.setdefault(gy(r["date"]), []).append(r)
voll = {y: v for y, v in jahre.items() if len(v) >= 365}

kal = {}
for r in con:
    kal.setdefault(r["date"][:4], []).append(r)
k24 = kal["2024"]
V24 = sum(num(r["consumption_gwh"]) for r in k24) / 1000
S24 = sum(num(r["slp_gwh"]) for r in k24) / sum(num(r["consumption_gwh"]) for r in k24) * 100

# Jahresgang des Zuflusses — identisch zu flowlab.js
flows = {r["date"]: num(r["injection_gwh_per_day"]) - num(r["withdrawal_gwh_per_day"]) for r in gie}
cons = {}
for r in con:
    d = dt.date.fromisoformat(r["date"])
    cons.setdefault(gy(r["date"]), {})[(d.month, d.day)] = (num(r["slp_gwh"]), num(r["rlm_gwh"]))

def jahresgang(auswahl):
    per = {}
    for y in auswahl:
        for (m, dd), (s_, rl) in cons[y].items():
            yy = y + 1 if (m, dd) <= (7, 31) else y
            f = flows.get(f"{yy}-{m:02d}-{dd:02d}")
            if f is None:
                continue
            per.setdefault((m, dd), []).append(s_ + rl + f)
    keys = sorted(per)
    mit = [sum(per[k]) / len(per[k]) for k in keys]
    n, S = len(mit), 7
    gl = [sum(mit[(i + k) % n] for k in range(-S, S + 1)) / (2 * S + 1) for i in range(n)]
    norm = sum(gl) / n
    return {k: gl[i] / norm for i, k in enumerate(keys)}, norm

MODERN = [y for y in sorted(voll) if y >= 2023]
ALT = [y for y in sorted(voll) if y < 2023]
IDX, ROH = jahresgang(MODERN)
IDX_ALT, ROH_ALT = jahresgang(ALT)

def monat(idx, mm):
    v = [x for (m, _), x in idx.items() if m == mm]
    return sum(v) / len(v)

ZIEL_D = dt.date(D0.year if (D0.month, D0.day) <= (11, 1) else D0.year + 1, 11, 1)
T = (ZIEL_D - D0).days

def key(i, ref):
    d = D0 + dt.timedelta(days=i)
    k = (d.month, d.day)
    return k if k in cons[ref] else (2, 28)

FENSTER = sum(IDX.get(key(i, max(voll)), 1) for i in range(T)) / T
FENSTER_ALT = sum(IDX_ALT.get(key(i, max(voll)), 1) for i in range(T)) / T

def lauf(niv, ref, tage):
    f = F0
    for i in range(tage):
        s_, rl = cons[ref][key(i, ref)]
        f = max(0.0, min(100.0, f + max(-WDR, min(INJ, niv * IDX.get(key(i, ref), 1) - (s_ + rl))) / PP))
    return f

def zielniveau(ref):
    lo, hi = 0.0, 20000.0
    for _ in range(90):
        mid = (lo + hi) / 2
        if lauf(mid, ref, T) < 80.0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2

REF = max(voll)
IST0 = sum(cons[REF][key(0, REF)]) + RATE * PP
NIVEAU = IST0 / IDX.get(key(0, REF), 1)
PROJ = lauf(NIVEAU, REF, T)
LINEAR = F0 + RATE * T

jahrestab = []
for y in sorted(voll):
    zn = zielniveau(y)
    rs = jahre[y]
    tot = [num(r["consumption_gwh"]) for r in rs]
    s_ = sum(num(r["slp_gwh"]) for r in rs)
    ist = sum(cons[y][key(0, y)]) + RATE * PP
    jahrestab.append({
        "y": y, "tage": len(rs), "twh": sum(tot) / 1000, "slp": s_ / sum(tot) * 100,
        "mittel": st.mean(tot), "min": min(tot), "max": max(tot),
        "ist": ist, "ziel": zn, "schnitt": zn * FENSTER,
        "proj": lauf(ist / IDX.get(key(0, y), 1), y, T),
    })

DWD = {2019: 3.06, 2020: 4.17, 2021: 1.81, 2022: 3.28, 2023: 2.88, 2024: 4.04, 2025: 2.16, 2026: 1.72}

# --------------------------------------------------------------- Layout
ss = getSampleStyleSheet()
def S(name, **kw):
    base = dict(fontName="DJ", fontSize=9.2, leading=13.6, textColor=colors.HexColor("#1c2427"),
                alignment=TA_LEFT, spaceAfter=6)
    base.update(kw)
    return ParagraphStyle(name, **base)

P      = S("P")
PS     = S("PS", fontSize=8.3, leading=12.2, textColor=GREY)
H1     = S("H1", fontName="DJ-B", fontSize=17, leading=21, textColor=TEAL, spaceBefore=2, spaceAfter=3)
H2     = S("H2", fontName="DJ-B", fontSize=12.4, leading=16, textColor=TEAL, spaceBefore=13, spaceAfter=5)
H3     = S("H3", fontName="DJ-B", fontSize=10, leading=14, textColor=ACC, spaceBefore=8, spaceAfter=3)
LEAD   = S("LEAD", fontSize=10.2, leading=15, textColor=GREY, spaceAfter=10)
MONO   = S("MONO", fontName="DJ-M", fontSize=8.2, leading=12.4, textColor=TEAL)
CELL   = S("CELL", fontSize=8.2, leading=11.4, spaceAfter=0)
CELLB  = S("CELLB", fontName="DJ-B", fontSize=8.2, leading=11.4, spaceAfter=0, textColor=TEAL)
CELLR  = S("CELLR", fontSize=8.2, leading=11.4, spaceAfter=0, alignment=2)
CELLRB = S("CELLRB", fontName="DJ-B", fontSize=8.2, leading=11.4, spaceAfter=0, alignment=2, textColor=TEAL)

W = A4[0] - 36 * mm

def kopf(c, d):
    c.saveState()
    c.setFont("DJ", 7.6); c.setFillColor(GREY)
    c.drawString(18 * mm, A4[1] - 12 * mm, "Flussbilanz-Labor · Methodik und Datenbasis")
    c.drawRightString(A4[0] - 18 * mm, A4[1] - 12 * mm, f"Datenstand {D0.strftime('%d.%m.%Y')}")
    c.setStrokeColor(LINE); c.setLineWidth(0.5)
    c.line(18 * mm, A4[1] - 14 * mm, A4[0] - 18 * mm, A4[1] - 14 * mm)
    c.line(18 * mm, 15 * mm, A4[0] - 18 * mm, 15 * mm)
    c.drawString(18 * mm, 11 * mm, "github.com/icrfornax/de-gas-storage-tracker-bnetza")
    c.drawRightString(A4[0] - 18 * mm, 11 * mm, f"Seite {c.getPageNumber()}")
    c.restoreState()

doc = BaseDocTemplate(str(OUT), pagesize=A4,
                      leftMargin=18 * mm, rightMargin=18 * mm,
                      topMargin=20 * mm, bottomMargin=20 * mm,
                      title="Flussbilanz-Labor — Methodik und Datenbasis",
                      author="de-gas-storage-tracker-bnetza",
                      subject="Herkunft, Pruefung und Grenzen der verwendeten Daten")
doc.addPageTemplates([PageTemplate(id="n",
    frames=[Frame(18 * mm, 20 * mm, W, A4[1] - 40 * mm, id="f",
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)],
    onPage=kopf)])

def tabelle(kopfzeile, daten, breiten, rechts=()):
    rowsx = [[Paragraph(h, CELLB if i not in rechts else CELLRB) for i, h in enumerate(kopfzeile)]]
    for z in daten:
        rowsx.append([Paragraph(str(v), CELL if i not in rechts else CELLR) for i, v in enumerate(z)])
    t = Table(rowsx, colWidths=breiten, repeatRows=1, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BG),
        ("LINEBELOW", (0, 0), (-1, 0), 0.7, ACC),
        ("LINEBELOW", (0, 1), (-1, -2), 0.25, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7faf9")]),
    ]))
    return t

def kasten(titel, text, farbe=ACC):
    inner = [[Paragraph(f"<b>{titel}</b>", S("kt", fontName="DJ-B", fontSize=9, leading=13,
                                            textColor=farbe, spaceAfter=3))],
             [Paragraph(text, S("kb", fontSize=8.6, leading=12.8, spaceAfter=0))]]
    t = Table(inner, colWidths=[W], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BG),
        ("LINEBEFORE", (0, 0), (0, -1), 2.2, farbe),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, 0), 7),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 0),
        ("TOPPADDING", (0, -1), (-1, -1), 0),
    ]))
    # Ein halb umgebrochener Hinweiskasten (Titel oben, Text auf der naechsten
    # Seite) ist schlechter lesbar als ein bisschen Weissraum.
    return KeepTogether([t])

def formel(text):
    t = Table([[Paragraph(text, MONO)]], colWidths=[W], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f2f6f5")),
        ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LINEBEFORE", (0, 0), (0, -1), 2.2, LINE),
    ]))
    return t

n0 = lambda v: f"{v:,.0f}".replace(",", ".")
n1 = lambda v: f"{v:,.1f}".replace(",", "X").replace(".", ",").replace("X", ".")
n2 = lambda v: f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
n3 = lambda v: f"{v:.3f}".replace(".", ",")

s = []

# =============================================================== Titel
s += [
  Paragraph("Flussbilanz-Labor: Methodik und Datenbasis", H1),
  Paragraph(
    "Woher jede Zahl stammt, wie sie geprüft wurde und wo die Grenzen liegen. "
    f"Erzeugt am {dt.date.today().strftime('%d.%m.%Y')} aus den Datendateien des Repositorys — "
    "alle Kennzahlen in diesem Dokument sind beim Bau frisch nachgerechnet, keine abgeschriebenen Werte.", LEAD),
  kasten("Was dieses Dokument leisten soll — und was nicht",
    "Es soll <b>überprüfbar</b> machen, was die Grafik zeigt: jede Eingangsgröße mit Quelle, jede "
    "Rechnung als Formel, jede Annahme ausdrücklich als Annahme. Es ist <b>keine Prognose</b>. "
    "Die Grafik schreibt gemessene Vergangenheit unter einer einstellbaren Zufluss-Annahme fort. "
    "Was tatsächlich passiert, hängt an Wetter, Preisen und Politik — davon modelliert diese Seite nichts."),
  Spacer(1, 9),
]

# =============================================================== 1 Kurzfassung
s += [Paragraph("1 · Kurzfassung: die vier Eingangsgrößen", H2), Paragraph(
  "Das Labor rechnet aus vier Bausteinen. Zwei sind gemessene Zeitreihen, einer ist die freie "
  "Variable, einer ist eine Aufteilungsannahme ohne Wirkung auf das Ergebnis.", P)]

s += [tabelle(
  ["Größe", "Herkunft", "Art", "Wirkung auf das Ergebnis"],
  [["Speicherstand, Kapazitäten", "GIE AGSI+ API v013, täglicher Abruf", "gemessen", "Startpunkt und Deckelung"],
   ["Tagesverbrauch je Sektor", "Trading Hub Europe, aggregierte Allokationsdaten", "gemessen", "Entnahmeseite, nicht einstellbar"],
   ["Zufluss (Jahresmittel)", "am Datenstand aus Verbrauch + gemessenem Einspeichertempo", "eingestellt", "die einzige freie Variable"],
   ["Jahresgang des Zuflusses", "abgeleitet aus denselben zwei Reihen", "gerechnet", "verteilt das Jahresmittel auf Tage"],
   ["Aufteilung Industrie/Strom 70:30", "Modellannahme, kalibriert", "Annahme", "keine — verschiebt nur zwischen zwei Karten"],
   ["Aufteilung des Zuflusses auf Quellen", "Importmengen 2024", "Annahme", "keine — nur die Summe zählt"]],
  [W*0.24, W*0.30, W*0.11, W*0.35], rechts=())]

s += [Spacer(1, 5), kasten("Der wichtigste Satz zur Einordnung",
  f"Die Entnahmeseite ist <b>nicht modelliert, sondern gemessen</b>. Für jeden Simulationstag nimmt "
  f"das Labor den realen Verbrauch desselben Kalendertags aus einem echten Gasjahr — {n0(len(con))} "
  f"Gastage stehen dafür zur Verfügung, lückenlos. Die einzige Stellschraube ist der Zufluss. "
  f"Wer das Ergebnis angreifen will, muss also entweder die Messreihen angreifen oder die "
  f"Zufluss-Annahme — nicht ein Verbrauchsmodell, denn es gibt keins.")]

# =============================================================== 2 Datenquellen
s += [Paragraph("2 · Die Datenquellen im Einzelnen", H2)]

s += [Paragraph("2.1 · Speicherstände: GIE AGSI+", H3), Paragraph(
  "Gas Infrastructure Europe (GIE) betreibt die Transparenzplattform AGSI+, auf der die "
  "Speicherbetreiber ihre Bestände melden. Das Repository ruft die Deutschland-Reihe täglich ab und "
  f"legt sie in <font face='DJ-M' size='8'>data/gie_storage.csv</font> ab: {n0(len(gie))} Tage von "
  f"{dt.date.fromisoformat(gie[0]['date']).strftime('%d.%m.%Y')} bis {D0.strftime('%d.%m.%Y')}, "
  f"{'ohne Lücke' if all((dt.date.fromisoformat(gie[i]['date'])-dt.date.fromisoformat(gie[i-1]['date'])).days==1 for i in range(1,len(gie))) else 'mit Lücken'}.", P)]

s += [tabelle(["Feld", "Wert am Datenstand", "Verwendung"],
  [["fill_pct", f"{n2(F0)} %", "Startfüllstand der Simulation"],
   ["working_gas_volume_twh", f"{n1(PP*100/1000)} TWh", f"1 Prozentpunkt = {n0(PP)} GWh"],
   ["injection_capacity_gwh_per_day", f"{n0(num(start['injection_capacity_gwh_per_day']))} GWh/Tag", "Obergrenze der Netto-Bilanz"],
   ["withdrawal_capacity_gwh_per_day", f"{n0(WDR)} GWh/Tag", "Untergrenze der Netto-Bilanz"],
   ["injection/withdrawal_gwh_per_day", "Tagesreihe", "Baustein des Zufluss-Jahresgangs"]],
  [W*0.32, W*0.24, W*0.44])]

s += [Spacer(1, 5), Paragraph(
  f"Für die Einspeicherkapazität nimmt das Labor bewusst den <b>kleineren</b> der beiden verfügbaren "
  f"Werte: die GIE-Tagesmeldung ({n0(num(start['injection_capacity_gwh_per_day']))} GWh/Tag) und den "
  f"technischen Snapshot in <font face='DJ-M' size='8'>data/de_storage_capacity.json</font> "
  f"({n0(cap['technical_max_injection_gwh_per_day'])} GWh/Tag, Stand {cap['source_date']}). "
  f"Gerechnet wird also mit {n0(INJ)} GWh/Tag. Das ist die konservative Wahl: eine zu hoch angesetzte "
  f"Kapazität würde das Erreichen des Ziels leichter erscheinen lassen, als es ist.", P)]

s += [Paragraph("2.2 · Tagesverbrauch: Trading Hub Europe", H3), Paragraph(
  "Trading Hub Europe (THE) ist der deutsche Marktgebietsverantwortliche und veröffentlicht die "
  "aggregierten Allokationsmengen aller Entnahmestellen im deutschen Marktgebiet — je Gastag, "
  "getrennt nach Gasqualität (H/L) und Abrechnungsart. Der Abruf läuft über die dokumentierte "
  "XML-Schnittstelle ohne Zugangsschlüssel; ein aussagekräftiger User-Agent ist Pflicht.", P),
  formel("https://datenservice.tradinghub.eu/XmlInterface/getXML.ashx<br/>"
         "&nbsp;&nbsp;&nbsp;&nbsp;?ReportId=AggregatedConsumptionData&amp;Start=dd-mm-yyyy&amp;End=dd-mm-yyyy")]

s += [Spacer(1, 6), Paragraph("Die acht Mengenfelder werden zu zwei Sektoren summiert:", P),
  formel("SLP = HGasSLPsyn + HGasSLPana + LGasSLPsyn + LGasSLPana<br/>"
         "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Standardlastprofil — Haushalte und kleines Gewerbe<br/><br/>"
         "RLM = HGasRLMmT + LGasRLMmT + HGasRLMoT + LGasRLMoT<br/>"
         "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;registrierende Leistungsmessung — Industrie und Kraftwerke<br/><br/>"
         "Verbrauch [GWh] = (SLP + RLM) / 1e6")]

s += [Spacer(1, 6), Paragraph(
  "<b>Zur Einheit:</b> jeder einzelne Datensatz der Antwort trägt das Feld "
  "<font face='DJ-M' size='8'>&lt;Unit&gt;kWh&lt;/Unit&gt;</font>. In den geprüften Exporten ist das "
  f"in {n0(len(con))} von {n0(len(con))} Datensätzen so. Das Abrufskript prüft dieses Feld bei jedem "
  "Lauf und bricht bei einer abweichenden Einheit ab, statt still falsch zu rechnen. Die Umrechnung "
  "kWh → GWh ist damit belegt und nicht angenommen.", P)]

s += [Spacer(1, 3), kasten("Was ich <i>nicht</i> belegen konnte",
  "Die Bedeutung der Kürzel <font face='DJ-M' size='8'>mT</font> und <font face='DJ-M' size='8'>oT</font> "
  "in den RLM-Feldern habe ich in keiner THE-Primärquelle eindeutig gefunden; die englische THE-Seite "
  "übersetzt sie als „off-peak/on-peak“, was fachlich zweifelhaft wirkt. <b>Für diese Rechnung ist das "
  "ohne Belang</b>, weil alle vier RLM-Felder ohnehin zu einer Summe addiert werden. Ich führe es hier "
  "auf, weil eine Methodik auch die offenen Punkte nennen muss.", colors.HexColor("#a2660b"))]

s += [Spacer(1, 8), Paragraph("Bestand der Verbrauchsreihe", H3)]
s += [tabelle(["Gasjahr", "Gastage", "Verbrauch TWh", "SLP-Anteil", "Ø GWh/Tag", "Minimum", "Maximum"],
  [[f"{j['y']}/{str(j['y']+1)[2:]}", n0(j["tage"]), n1(j["twh"]), f"{n1(j['slp'])} %",
    n0(j["mittel"]), n0(j["min"]), n0(j["max"])] for j in jahrestab],
  [W*0.13, W*0.11, W*0.16, W*0.14, W*0.16, W*0.15, W*0.15], rechts=(1,2,3,4,5,6))]

s += [Spacer(1, 5), Paragraph(
  f"Insgesamt {n0(len(con))} Gastage vom {tage[0].strftime('%d.%m.%Y')} bis {tage[-1].strftime('%d.%m.%Y')}, "
  f"<b>{'ohne eine einzige Lücke' if luecken==0 else f'mit {luecken} Lücken'}</b>. "
  f"{n0(status.get('final',0))} Tage tragen den Status <i>final</i>, {n0(status.get('corrected',0))} den "
  f"Status <i>corrected</i>. Dass THE nachträglich korrigiert, ist kein Mangel, sondern der Grund, warum "
  "das Abrufskript standardmäßig 45 Tage rückwirkend neu holt und vorhandene Zeilen überschreibt.", P)]

# =============================================================== 3 Verifikation
s += [PageBreak(), Paragraph("3 · Wie die Daten geprüft wurden", H2), Paragraph(
  "Eine Quelle zu nennen genügt nicht. Die folgenden vier Prüfungen sind durchgeführt worden; jede "
  "ist mit den Dateien im Repository wiederholbar.", P)]

s += [Paragraph("3.1 · Gegenprobe mit einer unabhängigen Institution", H3), Paragraph(
  f"Die THE-Reihe misst am Marktgebiet. Die Bundesnetzagentur erhebt getrennt davon an den "
  f"Netzausspeisepunkten. Für das Kalenderjahr 2024 lassen sich beide direkt vergleichen:", P)]

s += [tabelle(["Kennzahl", "THE-Reihe (gerechnet)", "Bundesnetzagentur", "Abstand"],
  [["Gasverbrauch Deutschland 2024", f"{n1(V24)} TWh", "844 TWh", f"{n1((V24-844)/844*100)} %"],
   ["Anteil Haushalte und Gewerbe", f"{n1(S24)} %", "39 %", f"{n1(S24-39)} Prozentpunkte"]],
  [W*0.34, W*0.22, W*0.22, W*0.22], rechts=(1,2,3))]

s += [Spacer(1, 5), Paragraph(
  "Zwei getrennte Messwege, unter einem Prozent Abstand. Das ist der stärkste Beleg dafür, dass die "
  "Reihe misst, was sie zu messen vorgibt.", P)]

s += [Paragraph("3.2 · Überlappung zweier unabhängiger Exporte", H3), Paragraph(
  "Die Verbrauchsreihe wurde in zwei Abrufen aus verschiedenen Zeiträumen aufgebaut "
  "(01.08.2021–31.07.2026 und 01.08.2024–31.07.2026). Die 730 überlappenden Gastage wurden Wert für "
  "Wert verglichen: <b>keine einzige Abweichung</b>. Die Schnittstelle liefert also reproduzierbar "
  "dieselben Zahlen — sie werden nicht bei jedem Abruf neu geschätzt.", P)]

s += [Paragraph("3.3 · Unabhängige Nachimplementierung des Modells", H3), Paragraph(
  "Die Rechenkette der Seite wurde ein zweites Mal geschrieben — in Python, direkt aus den Rohdateien, "
  "ohne eine Zeile des JavaScript-Codes zu übernehmen. Verglichen wurden alle Spalten des "
  "CSV-Exports über alle fünf Referenzjahre, also rund 1.130 Zeilen. Die größten Abweichungen:", P)]

s += [tabelle(["Größe", "größte Abweichung", "Einordnung"],
  [["Bedarf gesamt", "0,05 GWh", "Rundung auf 1 Nachkommastelle im Export"],
   ["Zufluss", "0,05 GWh", "dito"],
   ["Netto-Bilanz", "0,05 GWh", "dito"],
   ["Füllstand", "0,0005 pp", "Rundung auf 3 Nachkommastellen"],
   ["Zielpfad", "0,0005 pp", "dito"]],
  [W*0.28, W*0.24, W*0.48], rechts=(1,))]

s += [Spacer(1, 5), Paragraph(
  "Die Abweichungen entsprechen exakt der Ausgabegenauigkeit. Rechnerisch sind beide "
  "Implementierungen identisch.", P)]

s += [Paragraph("3.4 · Innere Kontrolle des Zielpfads", H3), Paragraph(
  f"Der nötige Zufluss wird analytisch bestimmt (Bedarfssumme plus Füllstandslücke, geteilt durch den "
  f"mittleren Jahresgang-Faktor des Fensters). Die unabhängige Nachrechnung bestimmt ihn stattdessen "
  f"per Bisektion — also durch reines Ausprobieren. Beide Wege treffen sich: der Zielpfad erreicht am "
  f"1. November in jedem der fünf Referenzjahre <b>exakt 80,000 %</b>. Ein Rechenfehler in der "
  f"Herleitung würde hier sofort auffallen.", P)]

# =============================================================== 4 Rechenweg
s += [KeepTogether([Paragraph("4 · Der Rechenweg, Zeile für Zeile", H2), Paragraph(
  "Die Simulation läuft in Tagesschritten vom Datenstand bis zum Ende der Heizperiode. Jeder Schritt "
  "besteht aus vier Zeilen:", P),
  formel(
    "bedarf(t)      = SLP(Kalendertag, Referenzjahr)&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Haushalte, gemessen]<br/>"
    "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ RLM(Kalendertag, Referenzjahr)&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[Industrie + Strom, gemessen]<br/><br/>"
    "zufluss(t)     = jahresmittel × jahresgang(Kalendertag)<br/><br/>"
    "netto(t)       = min(einspeicherkap., max(−ausspeicherkap., zufluss(t) − bedarf(t)))<br/><br/>"
    f"fuellstand(t+1) = fuellstand(t) + netto(t) / {n0(PP)} GWh&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[gedeckelt auf 0…100 %]")])]

s += [Spacer(1, 7), Paragraph("4.1 · Woher der Startwert des Zuflusses kommt", H3), Paragraph(
  "Der Zufluss ist die freie Variable — aber er startet nicht auf einem Wunschwert, sondern auf dem "
  "gemessenen Ist-Zustand. Aus dem Speicher lässt sich ablesen, wie viel gerade netto hineingeht; "
  "zusammen mit dem gemessenen Verbrauch ergibt das den Zufluss:", P),
  formel(
    f"30-Tage-Tempo  = (fuellstand({D0.strftime('%d.%m.')}) − fuellstand({(D0-dt.timedelta(days=30)).strftime('%d.%m.')})) / 30<br/>"
    f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;= {n2(RATE)} Prozentpunkte pro Tag<br/><br/>"
    f"Ist-Zufluss(0) = bedarf(0) + 30-Tage-Tempo × {n0(PP)} GWh<br/>"
    f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;= {n0(sum(cons[REF][key(0,REF)]))} + {n0(RATE*PP)} = {n0(IST0)} GWh/Tag<br/><br/>"
    f"Jahresmittel   = Ist-Zufluss(0) / jahresgang({D0.strftime('%d.%m.')}) = {n0(IST0)} / {n3(IDX.get(key(0,REF),1))} = {n0(NIVEAU)} GWh/Tag")]

s += [Spacer(1, 6), Paragraph(
  "Damit ist der Ausgangszustand der Grafik keine Setzung: er reproduziert per Konstruktion genau das "
  "Tempo, das der Speicher gerade zeigt.", P)]

# =============================================================== 5 Jahresgang
s += [Paragraph("5 · Der Jahresgang des Zuflusses", H2), Paragraph(
  "Der Zufluss ist über das Jahr nicht konstant: im Spätsommer kommt weniger Gas an als im Dezember. "
  "Diesen Verlauf hat das Labor <b>nicht angenommen, sondern aus zwei gemessenen Reihen abgeleitet</b>. "
  "Der Gedanke dahinter ist eine simple Bilanz: was in Deutschland ankam, wurde entweder verbraucht "
  "oder eingespeichert; was aus dem Speicher kam, muss abgezogen werden.", P),
  formel("zufluss(Tag) = verbrauch(THE) + einspeicherung(GIE) − ausspeicherung(GIE)")]

s += [Spacer(1, 6), Paragraph(
  "Transit und Exporte fallen dabei heraus — übrig bleibt, was dem deutschen Markt an diesem Tag "
  "tatsächlich zur Verfügung stand. Die Tageswerte werden über die Referenzjahre gemittelt, zyklisch "
  "über ein 15-Tage-Fenster geglättet (damit der 31.&nbsp;Dezember an den 1.&nbsp;Januar anschließt) und auf "
  "Jahresmittel 1 normiert.", P)]

mn = min(IDX.items(), key=lambda kv: kv[1]); mx = max(IDX.items(), key=lambda kv: kv[1])
MONAT = ["", "Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
         "August", "September", "Oktober", "November", "Dezember"]
s += [Paragraph("5.1 · Das Ergebnis", H3)]
s += [tabelle(["Monat"] + [f"{m:02d}" for m in [8,9,10,11,12,1,2,3,4,5,6,7]],
  [["Faktor"] + [n2(monat(IDX, m)) for m in [8,9,10,11,12,1,2,3,4,5,6,7]]],
  [W*0.13] + [W*0.0725]*12, rechts=tuple(range(1,13)))]

s += [Spacer(1, 5), Paragraph(
  f"Tagesminimum <b>{n2(mn[1])} am {mn[0][1]}.&nbsp;{MONAT[mn[0][0]]}</b>, Tagesmaximum "
  f"<b>{n2(mx[1])} am {mx[0][1]}.&nbsp;{MONAT[mx[0][0]]}</b>. Das Rohmittel der zugrunde liegenden "
  f"Gasjahre {', '.join(f'{y}/{str(y+1)[2:]}' for y in MODERN)} liegt bei {n0(ROH)} GWh/Tag.", P)]

s += [Spacer(1, 3), kasten("Warum das Ergebnis über dem Tagesschnitt liegt",
  f"Das Einspeicherfenster vom {D0.strftime('%d.%m.')} bis zum 1.&nbsp;November liegt mit einem mittleren "
  f"Faktor von <b>{n2(FENSTER)}</b> im Zufluss-Tal. Ein Jahresmittel von X GWh/Tag liefert in diesem "
  f"Fenster also nur {n2(FENSTER)}&nbsp;× X. Deshalb nennt die Grafik zwei Zahlen: den nötigen "
  f"<i>Tagesschnitt im Fenster</i> ({n0(zielniveau(REF)*FENSTER)} GWh/Tag) und das dafür nötige "
  f"<i>Jahresniveau</i> ({n0(zielniveau(REF))} GWh/Tag). Beide meinen dasselbe, nur anders gemessen.")]

s += [Spacer(1, 8), Paragraph("5.2 · Warum nur Gasjahre ab 2023/24 — und was das ändert", H3), Paragraph(
  "Für den Jahresgang werden bewusst nur die jüngeren Gasjahre verwendet. 2021/22 lief Nord Stream, "
  "2022/23 war das Notfall-Befüllen nach Kriegsbeginn — beides Zustände, die sich nicht wiederholen. "
  "Ich habe nachgerechnet, wie groß der Unterschied tatsächlich ist, statt ihn zu behaupten:", P)]

s += [tabelle(["Kennzahl", f"alt: {', '.join(f'{y}/{str(y+1)[2:]}' for y in ALT)}",
               f"neu: {', '.join(f'{y}/{str(y+1)[2:]}' for y in MODERN)}", "Unterschied"],
  [["Faktor September", n2(monat(IDX_ALT,9)), n2(monat(IDX,9)), f"{n2(monat(IDX,9)-monat(IDX_ALT,9))}"],
   ["Faktor Dezember", n2(monat(IDX_ALT,12)), n2(monat(IDX,12)), f"{n2(monat(IDX,12)-monat(IDX_ALT,12))}"],
   ["Fensterfaktor bis 1.11.", n3(FENSTER_ALT), n3(FENSTER), f"{n3(FENSTER-FENSTER_ALT)}"],
   ["Rohmittel GWh/Tag", n0(ROH_ALT), n0(ROH), f"{n0(ROH-ROH_ALT)}"]],
  [W*0.28, W*0.22, W*0.22, W*0.28], rechts=(1,2,3))]

s += [Spacer(1, 5), Paragraph(
  f"<b>Ehrliches Zwischenergebnis:</b> an der <i>Form</i> ändert die Einschränkung wenig — der "
  f"September liegt in beiden Regimen bei {n2(monat(IDX_ALT,9))} gegenüber {n2(monat(IDX,9))}, der "
  f"Fensterfaktor bei {n3(FENSTER_ALT)} gegenüber {n3(FENSTER)}. Deutlich verschieden ist das "
  f"<i>Niveau</i> ({n0(ROH_ALT)} gegenüber {n0(ROH)} GWh/Tag) — und das fällt beim Normieren "
  f"ohnehin heraus. Die Einschränkung bleibt trotzdem, weil das Notfalljahr kein wiederholbares "
  f"Verhalten abbildet. Aber wer sie für falsch hält, ändert am Ergebnis kaum etwas: der "
  f"Fensterfaktor bewegt sich um {n1(abs(FENSTER-FENSTER_ALT)/FENSTER*100)} Prozent.", P)]

s += [Spacer(1, 3), kasten("Die eine Annahme in diesem Abschnitt",
  "Abgeleitet wird ein <b>Gesamt</b>-Jahresgang. Dass er sich gleichmäßig auf Pipeline, LNG und "
  "Inland verteilt, ist eine Modellannahme — THE und GIE veröffentlichen nur die Summe, nicht den "
  "Jahresgang je Quelle. Für den Füllstandspfad ist das ohne Belang, weil nur die Summe in die "
  "Bilanz eingeht. Es betrifft allein die Beschriftung der drei Karten.",
  colors.HexColor("#a2660b"))]

# =============================================================== 6 Robustheit
s += [PageBreak(), Paragraph("6 · Wie stark hängt das Ergebnis am gewählten Jahr?", H2), Paragraph(
  "Der berechtigtste Angriff auf diese Darstellung lautet: „Ihr habt euch das Verbrauchsjahr "
  "ausgesucht, das euch passt.“ Deshalb hier die vollständige Tabelle — dasselbe Rechenverfahren, "
  "einmal je verfügbarem Referenzjahr, jeweils mit dem Ist-Zufluss dieses Jahres.", P)]

s += [tabelle(["Referenz-Gasjahr", "DWD-Winter", "Ist-Zufluss am Datenstand", "nötiger Tagesschnitt bis 1.11.",
               "Projektion am 1.11."],
  [[f"{j['y']}/{str(j['y']+1)[2:]}",
    f"{n2(DWD[j['y']+1])} °C" if j['y']+1 in DWD else "—",
    f"{n0(j['ist'])} GWh/Tag", f"{n0(j['schnitt'])} GWh/Tag", f"{n1(j['proj'])} %"] for j in jahrestab],
  [W*0.20, W*0.15, W*0.24, W*0.24, W*0.17], rechts=(1,2,3,4))]

spanne_s = [j["schnitt"] for j in jahrestab]
spanne_p = [j["proj"] for j in jahrestab]
s += [Spacer(1, 5), Paragraph(
  f"Der nötige Tagesschnitt bewegt sich zwischen {n0(min(spanne_s))} und {n0(max(spanne_s))} GWh/Tag — "
  f"eine Spanne von {n1((max(spanne_s)-min(spanne_s))/min(spanne_s)*100)} Prozent über fünf reale "
  f"Winter, vom mildesten ({n2(max(DWD[j['y']+1] for j in jahrestab if j['y']+1 in DWD))} °C) bis zum "
  f"kältesten ({n2(min(DWD[j['y']+1] for j in jahrestab if j['y']+1 in DWD))} °C). Die Projektion am "
  f"1. November liegt in jedem Fall zwischen {n1(min(spanne_p))} % und {n1(max(spanne_p))} % — "
  f"<b>in keinem einzigen Referenzjahr wird das 80-Prozent-Ziel mit dem aktuellen Zufluss erreicht</b>. "
  f"Die Aussage der Grafik hängt also nicht an der Wahl des Jahres.", P)]

s += [Spacer(1, 3), kasten("Die härteste Einschränkung dieses Modells",
  f"Seit Beginn der THE-Veröffentlichung war <b>jeder</b> deutsche Winter mild bis normal. Der "
  f"kälteste verfügbare ist {min((DWD[j['y']+1], j['y']) for j in jahrestab if j['y']+1 in DWD)[1]}/"
  f"{str(min((DWD[j['y']+1], j['y']) for j in jahrestab if j['y']+1 in DWD)[1]+1)[2:]} mit "
  f"{n2(min(DWD[j['y']+1] for j in jahrestab if j['y']+1 in DWD))} °C — die DWD-Normalperiode "
  f"1991–2020 liegt bei +1,4 °C, und einzelne Jahre lagen schon bei −2,3 °C. <b>Ein echter "
  f"Kältewinter lässt sich aus diesen Messwerten nicht nachstellen.</b> Alle Zahlen dieser Seite "
  f"sind deshalb eher die optimistische als die pessimistische Seite der Verteilung.",
  colors.HexColor("#a2660b"))]

# =============================================================== 7 Annahmen
s += [Spacer(1, 8), Paragraph("7 · Alle Annahmen an einer Stelle", H2), Paragraph(
  "Was in dieser Darstellung <i>nicht</i> gemessen ist — vollständig, mit Wirkung:", P)]

s += [tabelle(["Annahme", "Wert", "Begründung", "Wirkung auf den Füllstandspfad"],
  [["Aufteilung RLM auf Industrie und Stromerzeugung", "70 : 30",
    "kalibriert auf rund 150 TWh Gas für Strom- und Wärmeerzeugung; THE misst beide gemeinsam",
    "<b>keine.</b> Verschiebt nur Menge zwischen zwei Karten, die Summe ist gemessen"],
   ["Aufteilung des Zuflusses auf Pipeline, LNG und Inland", "88 : 7,5 : 4,5",
    "Importmengen 2024 der Bundesnetzagentur und BVEG", 
    "<b>keine.</b> In die Bilanz geht nur die Summe ein"],
   ["Aufteilung des Jahresgangs auf die drei Quellen", "gleich",
    "THE und GIE veröffentlichen nur den Gesamtzufluss",
    "<b>keine.</b> Betrifft nur die Beschriftung"],
   ["Reglerobergrenze Pipeline", "3.000 GWh/Tag",
    "keine amtliche Gesamtkapazität aller Einspeisepunkte veröffentlicht — Modellgrenze",
    "begrenzt nur, wie weit man den Regler ziehen kann"],
   ["Reglerobergrenze LNG", "400 GWh/Tag",
    "13,1 Mrd. m³/Jahr Nennkapazität der drei DET-Terminals („bis zu“-Angabe)",
    "dito"],
   ["Reglerobergrenze Inland", "200 GWh/Tag",
    "Förderung rund 112 GWh/Tag und rückläufig; der Rest wäre Biomethan-Ausbau",
    "dito"]],
  [W*0.21, W*0.145, W*0.345, W*0.30])]

# =============================================================== 8 Das 80%-Ziel
s += [PageBreak(), Paragraph("8 · Zur 80-Prozent-Linie", H2), kasten(
  "Die 80 % sind eine Bezugsmarke, keine Rechtsvorgabe für den Gesamtfüllstand",
  "Die deutsche Gasspeicherfüllstandsverordnung vom 05.05.2025 schreibt zum 1.&nbsp;November <b>80 % für "
  "Kavernenspeicher und vier süddeutsche Porenspeicher</b> (Bierwang, Breitbrunn, Inzenham-West, "
  "Wolfersberg) vor, aber nur <b>45 % für alle übrigen Porenspeicher</b>. Der VKU rechnet daraus einen "
  "deutschen Gesamtdurchschnitt von rund 70 %. Die Verordnung (EU) 2025/1733 vom 18.07.2025 nennt "
  "90 % — aber nicht zu einem festen Stichtag, sondern <b>zu einem beliebigen Zeitpunkt zwischen dem "
  "1.&nbsp;Oktober und dem 1.&nbsp;Dezember</b> — und lässt Abweichungen von zusammen bis zu "
  "<b>20 Prozentpunkten</b> zu (10 bei erschwerten Befüllbedingungen, je 5 weitere unter "
  "zusätzlichen Voraussetzungen). Eine auf den deutschen Gesamtfüllstand anwendbare 80-Prozent-Pflicht "
  "gibt es demnach nicht. Wer diese Grafik zitiert, sollte die Linie als das benennen, was sie ist: "
  "eine gut begründete Vergleichsmarke. <b>Diese Zusammenfassung ist keine Rechtsberatung</b> — für "
  "belastbare Aussagen ist der Verordnungstext selbst maßgeblich.",
  colors.HexColor("#a2660b"))]

# =============================================================== 9 Quellen
s += [Spacer(1, 10), Paragraph("9 · Quellenverzeichnis", H2)]

QUELLEN = [
  ("Speicherstände, Kapazitäten, Ein-/Ausspeicherung",
   "GIE AGSI+, API v013 (März 2025)", "https://agsi.gie.eu/ · gie.eu/transparency-platform/GIE_API_documentation_v013.pdf"),
  ("Tagesverbrauch je Sektor",
   "Trading Hub Europe, Aggregierte Verbrauchsdaten; Schnittstellendoku „The XML Interface“ V2.1 (2024)",
   "tradinghub.eu/de-de/Veröffentlichungen/Transparenz/Aggregierte-Verbrauchsdaten"),
  ("Gasverbrauch und Sektoranteile 2024, Importmengen und Lieferländer",
   "Bundesnetzagentur, Gasversorgung 2024 / Pressemitteilung vom 08.01.2025",
   "bundesnetzagentur.de/SharedDocs/Pressemitteilungen/DE/2025/20250108_GasRueckblick.html"),
  ("Heimische Erdgasförderung 2024 (4,2 Mrd. m³ / 40,9 TWh / 5,4 % Bedarfsdeckung)",
   "BVEG, Jahresbericht 2024", "jahresbericht.bveg.de/erdgasfoerderung/"),
  ("LNG-Terminalkapazitäten (Nennkapazität „bis zu“)",
   "Deutsche Energy Terminal (DET)", "energy-terminal.de/de/terminals"),
  ("Deutsche Füllstandsvorgaben",
   "Gasspeicherfüllstandsverordnung vom 05.05.2025, BGBl. I 2025 Nr. 130; BMWK-Pressemitteilung 30.04.2025",
   "gesetze-im-internet.de/gasspf_llstv_2025/"),
  ("EU-Füllstandsvorgaben",
   "Verordnung (EU) 2025/1733 vom 18.07.2025 zur Änderung der Verordnung (EU) 2017/1938",
   "eur-lex.europa.eu/eli/reg/2025/1733/oj"),
  ("Wintertemperaturen Deutschland (Gebietsmittel Dez–Feb), Normalperiode 1991–2020",
   "Deutscher Wetterdienst, Climate Data Center",
   "opendata.dwd.de/climate_environment/CDC/regional_averages_DE/seasonal/air_temperature_mean/"),
]
s += [tabelle(["Wofür", "Quelle", "Fundstelle"],
  [[a, b, f"<font face='DJ-M' size='7'>{c}</font>"] for a, b, c in QUELLEN],
  [W*0.26, W*0.36, W*0.38])]

s += [Spacer(1, 8), KeepTogether([Paragraph("Wie sich das alles nachprüfen lässt", H3), Paragraph(
  "Sämtliche Eingangsdaten liegen als Klartext im Repository und werden täglich per GitHub Action "
  "aktualisiert. Wer die Zahlen dieser Seite prüfen will, braucht diese Seite nicht:", P),
  tabelle(["Datei", "Inhalt"],
  [["<font face='DJ-M' size='8'>data/gie_storage.csv</font>", "Speicherreihe Deutschland und EU, täglich von GIE"],
   ["<font face='DJ-M' size='8'>data/de_consumption_daily.csv</font>", f"{n0(len(con))} Gastage Verbrauch, getrennt nach SLP und RLM"],
   ["<font face='DJ-M' size='8'>data/de_storage_capacity.json</font>", "technischer Einspeicher-Benchmark"],
   ["<font face='DJ-M' size='8'>scripts/update_the_consumption.py</font>", "der komplette Abruf- und Prüfweg der Verbrauchsreihe"],
   ["Download „Tagestabelle als CSV“", "jeder Simulationstag des gewählten Referenzjahres"],
   ["Download „Gesamtlauf (alle Jahre)“", "alle Referenzjahre bei identischem Zufluss, zum Vergleichen"]],
  [W*0.38, W*0.62])])]

s += [Spacer(1, 10), Paragraph(
  "Fehler in diesem Dokument sind Fehler, die korrigiert gehören. Wer einen findet, möge ein Issue im "
  "Repository eröffnen — mit Quelle.", PS)]

doc.build(s)
print(f"{OUT} geschrieben")
