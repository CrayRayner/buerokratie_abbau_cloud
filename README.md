# Bürokratieabbau Bayern

Batch-Analyse bayerischer Rechtsnormen auf **unternehmensrelevante Bürokratiehemmnisse** — mit dem Ziel, Normen mit konkretem, rechtlich belastbarem Entlastungspotenzial zu finden.

Die Pipeline crawlt die Gesetzestexte von [gesetze-bayern.de](https://www.gesetze-bayern.de), lässt sie von einem **lokalen LLM** (über LM Studio) analysieren und erzeugt eine priorisierte, geprüfte Trefferliste samt Reform­vorschlägen und nachprüfbaren Belegstellen.

> **Selbstverständnis:** Das ist ein **Discovery-/Triage-Werkzeug**. Es erzeugt aus hunderten Verordnungen eine geprüfte, priorisierte Shortlist mit nachprüfbaren Belegstellen — als **Vorarbeit für die juristische Bewertung, nicht als deren Ersatz**. Bei rechtlich gebundenen Normen wird bewusst „Prüfung nötig" gesetzt.

---

## Inhaltsverzeichnis
- [Wie es funktioniert](#wie-es-funktioniert)
- [Architektur](#architektur)
- [Voraussetzungen](#voraussetzungen)
- [Installation](#installation)
- [Konfiguration](#konfiguration)
- [Schritt-für-Schritt-Anleitung](#schritt-für-schritt-anleitung)
- [Crawling im Detail](#crawling-im-detail)
- [Die Analyse im Detail](#die-analyse-im-detail)
- [Große Gesetze: Chunking](#große-gesetze-chunking)
- [Kritischer Zweitcheck](#kritischer-zweitcheck)
- [Ergebnisse verstehen](#ergebnisse-verstehen)
- [Design-Entscheidungen](#design-entscheidungen)
- [Roadmap / Vorgehen](#roadmap--vorgehen)
- [Datenbank](#datenbank)
- [Entwicklung & Git](#entwicklung--git)
- [Troubleshooting](#troubleshooting)

---

## Wie es funktioniert

Fünf Phasen (Details + Befehle: [Schritt-für-Schritt-Anleitung](#schritt-für-schritt-anleitung)):

1. **Crawl** — Discovery aller Normen via Playwright, Download der **vollständigen** Volltexte (inkl. §-Marker, Ermächtigungsgrundlagen, Tabellen) → SQLite.
2. **Analyze** — jedes Dokument wird **mehrfach** vom LLM bewertet (Ensemble, lokal via LM Studio). Ein deterministischer Aggregator stabilisiert das Ergebnis durch Mehrheits-Voting und verankert jede Belegstelle wörtlich im Quelltext (Anti-Halluzination). Große Gesetze werden automatisch an §-Grenzen gechunkt.
3. **Review** — nach jedem Lauf wird automatisch ein Markdown-Report mit Trefferliste, Warnungen und Vergleich zum Vorlauf erzeugt.
4. **Kritischer Zweitcheck** *(optional, aber empfohlen)* — ein zweites, unabhängiges Modell (Standard: Cloud via OpenRouter) prüft jeden Reformvorschlag der Shortlist kritisch nach und markiert Bedenken.
5. **Export & Dashboard** — Ergebnisse als CSV (eine Zeile pro Belegstelle) oder im Web-Dashboard, inkl. Vergleich mehrerer Läufe/Modelle.

Der Clou: Statt einem teuren Großmodell zu vertrauen, wird ein **kleines lokales Modell** durch Ensemble + Voting + Grounding zu einem präzisen, kalibrierten Klassifikator gemacht — die Kernanalyse kostet **0 €**. Nur der optionale Zweitcheck kann Cent-Beträge über eine Cloud-API kosten.

---

## Architektur

```
buerokratie-abbau/
├── crawler/              # Phase 1: Crawling
│   ├── discover.js       #   Playwright-Discovery der Dokument-IDs (Filter NORMTYP/rv + /ges)
│   ├── download.js       #   Volltext-Download über /true-Gesamtansicht (cheerio)
│   └── index.js          #   Orchestrierung
├── analyzer/             # Phase 2: LLM-Analyse
│   ├── prompt.js         #   System-Prompt + Kategorien + Regeln (+ Truncation-Cap)
│   ├── client.js         #   LM-Studio-Client (OpenAI-kompatibel, Sampler gepinnt)
│   └── index.js          #   Ensemble-Läufe + Aggregator (Voting, Grounding, Resumability, Chunking)
├── review-report.js      # Phase 3: Auto-Review-Report (läuft nach jeder Analyse)
├── second-check.js       # Phase 4: Kritischer Zweitcheck (OpenRouter Standard, LM Studio Fallback)
├── classify.js           # GEMEINSAMES Modul: Adressat-Heuristik, Reform-Priorität, Grounding,
│                         #   Normstellen-Auflösung, Endstatus — einzige Quelle, keine Kopien mehr
├── export-hits.js        # Phase 5: CSV-Export, eine Zeile pro Belegstelle
├── dashboard/             # Web-Dashboard (Express, Port 3456)
│   ├── server/            #   Express-API (routes/api.js: /data, /export/csv, /runs)
│   └── public/            #   Frontend (Chart.js, Vanilla JS)
├── db.js                 # SQLite-Schema + Migrationen
├── pipeline.js           # Orchestrierung: crawl + analyze + status
├── config.json            # zentrale Konfiguration (kein Secret enthalten)
├── .env.example           # Vorlage für OPENROUTER_API_KEY → nach .env kopieren
└── data/                  # SQLite-DB + Artefakte (gitignored)
    └── runs/               #   weitere .db-Läufe zum Vergleich im Dashboard (z.B. anderes Modell)
```

**Datenfluss:** `crawl_jobs → documents → (Ensemble) raw_analyses → (Aggregation) analyses → REVIEW_*.md`
`analyses.second_check → export-hits.js / Dashboard` (Zweitcheck reichert an, überschreibt nichts)

---

## Voraussetzungen

- **Node.js** ≥ 18 (empfohlen 20+; für den `.env`-Loader in `second-check.js` reicht jede aktuelle Version)
- **[LM Studio](https://lmstudio.ai/)** mit einem geladenen Modell (Standard: `qwen/qwen3.5-9b`), lokaler Server auf Port `1234` — nötig für **Crawl/Analyze**
- **Internet** (für den Crawl von gesetze-bayern.de, und für den OpenRouter-Zweitcheck)
- *Optional:* **[OpenRouter](https://openrouter.ai/)-Account + API-Key** für den [Kritischen Zweitcheck](#kritischer-zweitcheck) (Standard-Provider). Ohne Key läuft die Kernanalyse trotzdem vollständig — der Zweitcheck ist ein optionaler zusätzlicher Schritt.
- Windows / macOS / Linux

---

## Installation

```bash
# 1. Abhängigkeiten installieren (kompiliert auch better-sqlite3)
npm install

# 2. Playwright-Browser für den Crawler installieren (einmalig)
npx playwright install chromium

# 3. Nur nötig für den Kritischen Zweitcheck via OpenRouter (sonst überspringen):
cp .env.example .env
# .env öffnen, OPENROUTER_API_KEY=... eintragen — .env ist gitignored, landet nie im Repo
```

---

## Konfiguration

Alle Einstellungen in **`config.json`**:

| Feld | Bedeutung | Standard |
|---|---|---|
| `lmStudioEndpoint` | LM-Studio-API (lokal) | `http://127.0.0.1:1234/v1/chat/completions` |
| `model` | Modell-ID (wie in LM Studio geladen) | `qwen/qwen3.5-9b` |
| `modelContextWindow` | Kontextfenster des Modells (Tokens) | `160000` |
| `ensembleRuns` | Läufe pro Dokument (Mehrheits-Voting) | `3` |
| `ensembleTemperature` | Temperatur der Läufe (**>0**, sonst keine Varianz fürs Voting) | `0.4` |
| `maxTokens` | max. Ausgabe-Tokens pro Lauf (Reasoning braucht real 10–15k) | `32000` |
| `maxAnalyzeDocs` | max. Anzahl analysierter Docs pro Lauf (0 = alle) | `50` |
| `maxDocChars` | nur Docs bis zu dieser Zeichenzahl (0 = alle; Demo: `80000`) | `80000` |
| `chunkThreshold` | Docs über dieser Zeichenzahl werden gechunkt (an §-Grenzen) | `70000` |
| `concurrency` | parallele Anfragen an LM Studio | `1` |
| `reasoningEffort` | an LM Studio gesendeter Reasoning-Hinweis; leer = Feld weglassen (viele lokale Modelle ignorieren „low" ohnehin und reasonen voll) | `""` |
| `useJsonSchema` | erzwingt striktes JSON-Schema — **AUS lassen** bei Reasoning-Modellen (killt das Reasoning, siehe [Design-Entscheidungen](#design-entscheidungen)) | `false` |
| `testDocIds` | Mini-Test-Gate: nur diese Doc-IDs analysieren (ignoriert Resumability, für schnelle Checks vor großen Läufen) | `[]` |
| `relevantLawKeywords` | Schlagworte zur Vorfilterung relevanter Normen | (Liste) |

> **Wichtig:** `ensembleTemperature` darf **nicht 0** sein. Das Ensemble funktioniert nur, wenn sich die Läufe unterscheiden — die Stabilität kommt aus dem Voting, nicht aus deterministischem Sampling.

> Zusätzliche Felder speziell für den Zweitcheck (`secondCheckProvider`, `secondCheckOpenRouterModel`,
> `secondCheckReasoningEffort`, `secondCheckModel`, `secondCheckMaxTokens`) stehen im Abschnitt
> [Kritischer Zweitcheck](#kritischer-zweitcheck).

### Sampler (fix im Code, `analyzer/client.js`)

Bewusst im Code gepinnt (nicht über LM-Studio-UI-Knöpfe, die landen nicht in Git):

| Parameter | Wert | Warum |
|---|---|---|
| `temperature` | 0.4 | Varianz fürs Voting, nicht chaotisch |
| `top_p` / `top_k` | 0.95 / 20 | solide Standardbegrenzung |
| `repeat_penalty` | 1.1 | **milde Anti-Loop-Bremse**, grounding-sicher |
| `presence_penalty` / `frequency_penalty` | 0 | höhere Werte **zerstören das wörtliche Zitieren** |

Hintergrund zu allen Inferenz-Settings (höher/niedriger): siehe Obsidian-Cheat-Sheet „LM Studio / Sampling-Einstellungen".

---

## Schritt-für-Schritt-Anleitung

> Alle Befehle im Projektordner ausführen. Terminal öffnen: im Explorer in den Projektordner gehen, oben in die **Adressleiste** klicken, `powershell` tippen, Enter.

Kompletter Ablauf von null bis zur geprüften Ergebnisliste, in dieser Reihenfolge:

### Schritt 0 — LM Studio vorbereiten (einmalig pro Sitzung)
1. LM Studio öffnen, gewünschtes Modell laden (z. B. `qwen/qwen3.5-9b`), **Kontext ~150k**.
2. Reiter **„Developer" / „Local Server"** → **Server starten** (Port `1234`).
3. Modell-ID in `config.json` (`model`) mit der geladenen abgleichen.
4. **Vor großen Läufen LM Studio neu starten** (verhindert Prompt-Cache-Thrashing über lange Läufe).
5. **Nur ein Modell gleichzeitig laden.** Läuft im Hintergrund noch ein zweites (z. B. für den Zweitcheck), lädt LM Studio bei falscher Modell-Referenz per JIT ein weiteres dazu → beide im VRAM, alles wird langsam (siehe [Kritischer Zweitcheck](#kritischer-zweitcheck)).

### Schritt 1 — Gesetze crawlen (einmalig, bzw. bei Aktualisierung)
```bash
npm run crawl
```
Lädt die Volltexte in die Datenbank. Erfasst §-Marker, Ermächtigungsgrundlagen und Tabellen vollständig (siehe [Crawling im Detail](#crawling-im-detail)). Resumebar — ein erneuter Lauf lädt nur Docs ohne Text nach.

### Schritt 2 — Mini-Test (Gate, vor jedem größeren Analyse-Lauf)
`testDocIds` in `config.json` auf 3–5 Doc-IDs setzen (idealerweise inkl. eines bekannten
Grenzfalls), kurz laufen lassen (Schritt 3), Log prüfen: keine Endlosschleifen, keine leeren
Antworten, JSON parst sauber. **Erst danach `testDocIds` wieder auf `[]` setzen und skalieren.**
Überspringen ist riskant — ein durchlaufender Loop kann einen Mehrstunden-Lauf lahmlegen.

### Schritt 3 — Analysieren
```bash
npm run analyze
```
Bewertet jedes Dokument mehrfach (`ensembleRuns`) und aggregiert. **Resumebar:** bereits
analysierte Docs werden übersprungen — wiederholte Läufe wandern in `maxAnalyzeDocs`-Etappen
durch den Korpus und überleben Neustarts/Abbrüche. Große Gesetze werden automatisch an
§-Grenzen gechunkt (siehe [Große Gesetze: Chunking](#große-gesetze-chunking) — dafür muss
`maxDocChars: 0` stehen, sonst werden sie komplett ausgeschlossen statt gechunkt).

### Schritt 4 — Report lesen
Nach der Analyse liegt automatisch eine **`REVIEW_<datum>.md`** im Projektordner — Trefferliste,
Auffälligkeiten, Vergleich zum Vorlauf. Manuell neu erzeugen (ohne neuen Analyse-Lauf):
```bash
node review-report.js
```

### Schritt 5 — Kritischer Zweitcheck (optional, aber empfohlen vor der Weitergabe)
```bash
node second-check.js
```
Läuft immer auf Reform-Priorität A+B, überspringt bereits geprüfte Docs (Resumability).
Braucht `OPENROUTER_API_KEY` in `.env` (Standard-Provider, siehe Installation) — ohne Key
bricht das Skript mit einer klaren Fehlermeldung ab, der Rest der Pipeline bleibt unberührt.
Details, Kosten, Provider-Wahl: [Kritischer Zweitcheck](#kritischer-zweitcheck).

### Schritt 6 — Export (CSV)
```bash
npm run export-hits
```
Eine Zeile **pro Belegstelle** (Beleg → Pflicht → Vorschlag → Risiko → Zweitcheck), inkl.
Reform-Priorität, Adressat, Rechtsbindung. Das ist die Datei zum Weitergeben. *(Nach Schritt 6
ausführen, nicht davor — sonst fehlen die Zweitcheck-Spalten.)*

> `export-csv.js` ist ein **anderes** Skript — ein roher Volltext-Dump aller gecrawlten
> Dokumente (kein Analyseergebnis, keine Priorität). Nur für Debugging/Backup relevant,
> nicht Teil der Ergebnis-Pipeline.

### Schritt 7 — Dashboard (optional, visuelle Prüfung + Lauf-Vergleich)
```bash
npm run dashboard
```
Dann **http://localhost:3456** öffnen. Zeigt dieselben Daten wie der Export, filterbar und
gruppierbar. Um zwei Läufe/Modelle zu vergleichen (z. B. Qwen vs. Gemma): die zweite `.db`
nach `data/runs/` kopieren — sie erscheint automatisch im Lauf-Dropdown oben.

### Status jederzeit prüfen
```bash
npm run status
```

---

## Crawling im Detail

**Quelle:** Jedes Dokument wird über die **`/true`-Gesamtansicht** geladen
(`/Content/Document/{id}/true`). Diese liefert das **komplette** Dokument serverseitig
auf einer Seite — die dynamische Navigation der Website (Artikel/Paragraphen
nachladen) wird damit umgangen. Es braucht also **kein** JS-Rendering pro Dokument.

**Vollständige Text-Extraktion:** Der Parser (`crawler/download.js → parseTextFromHtml`)
erfasst pro `.cont`-Block **alle** Kind-Elemente in Dokumentreihenfolge:

- `paraheading` → die **§-Nummern** („§ 1", „§ 2") — Voraussetzung für saubere Normstellen-Zitate
- `einleitungsformel` → die **Ermächtigungsgrundlage** („Auf Grund von § … der …") — Basis der Rechtsbindungs-Einstufung
- `paratext` / `absatz` → der eigentliche Normtext
- `table` → Tabellen werden zeilen-/zellenweise (`zelle | zelle`) erfasst — wichtig für **Schwellenwerte, Gebühren, Anlagen**
- Fußnoten / amtliche Anmerkungen

> Frühere Versionen nahmen nur `paratext` und verloren so 5–60 % des Textes — speziell
> Ermächtigungsgrundlagen, §-Marker und Tabellen. Das ist behoben; die Abdeckung liegt
> jetzt bei ~100 %.

---

## Die Analyse im Detail

Pro Dokument laufen mehrere LLM-Bewertungen (`ensembleRuns`, Standard 3). Der Aggregator (`analyzer/index.js`) macht daraus ein stabiles Ergebnis:

1. **Dokument-Entscheid (Mehrheits-Voting):** Ein Dokument gilt nur als relevant, wenn die **Mehrheit** der Läufe Treffer meldet (Mehrheit = ⌊N/2⌋ + 1, bei 3 Läufen also 2). Das filtert Zufallstreffer und False Positives.

2. **Verbatim-Grounding (Anti-Halluzination):** Jede Belegstelle wird nur übernommen, wenn ein **wörtlicher Textausschnitt** (normalisiert, gleitendes 25-Zeichen-Fenster) im Quelltext vorkommt. Erfundene Paragrafen fallen automatisch raus.

3. **Rechtsbindung (`legal_restrictions`):** Der Quelltext wird deterministisch nach Zitaten von EU- und Bundesrecht durchsucht. Daraus folgt, ob Bayern überhaupt Spielraum hat:
   - *EU-Verordnung* → Substanz **und** Verfahren gebunden
   - *EU-Richtlinie* → Substanz gebunden, Verfahren ggf. kürzbar
   - *Bundesrecht* → Abweichungsspielraum im Einzelfall
   - *leer* → reines Landesrecht = **voll kürzbar** (bester Abbau-Kandidat)

4. **Confidence & Review-Flag (mehrdimensional, deterministisch):** Die einzelnen
   Vertrauensmaße werden **abgeleitet**, nicht vom Modell geschätzt:
   - `ensemble_votes` — wie einig war sich das Ensemble (z. B. `3/3`)
   - `beleg_sicherheit` — ist die Fundstelle wörtlich verankert (Grounding ja/nein)
   - `rechtlich_gebunden` — aus `legal_restrictions` (EU / Bund / Landesrecht)
   - `human_review` — **JA**, sobald nicht einstimmig **oder** rechtlich gebunden.
     Auf gebundenen Normen wird **nie** „keine Prüfung nötig" gesetzt — das wäre
     widersprüchlich zur Rechtsbindung.

### Resumability

Die Analyse überspringt Docs, die bereits eine **aktuelle** Analyse haben
(Analyse jünger als der letzte Download des Docs). Folgen:
- Ein Crash / LM-Studio-Neustart mitten im Lauf kostet nicht den ganzen Fortschritt.
- Nach einem **Re-Crawl** werden veraltete Analysen automatisch neu berechnet
  (der neue Text ist jünger als die alte Analyse).
- `maxAnalyzeDocs: 50` analysiert bei jedem Lauf die **nächsten** 50 offenen Docs,
  nicht immer dieselben.

---

## Große Gesetze: Chunking

Jeder einzelne LLM-Call soll im bewährten, loop-stabilen Regime bleiben (~≤ 70k Zeichen).
Die meisten Normen liegen darunter und werden **in einem Call** analysiert.

**Große Gesetze** (Docs > `chunkThreshold`, Standard 70.000 Zeichen; einzelne > 600k)
werden automatisch **gechunkt** statt abgeschnitten — genau die enthalten oft die meisten
Belastungen. Ablauf (`analyzer/index.js`):

1. **An §-Grenzen splitten** (möglich, weil die §-Marker seit dem Crawl-Fix im Text stehen):
   Der Text wird in Fenster ≤ `chunkThreshold` zerlegt, nie mitten im Paragraphen. Die
   Präambel (Ermächtigungsgrundlage) kommt ins erste Fenster.
2. **Größen-Fallback:** §-arme Riesen (z. B. Tabellen-Verordnungen) werden zusätzlich hart
   nach Größe geteilt → **volle Abdeckung, kein Textverlust**.
3. **Jedes Fenster einzeln im Ensemble** bewerten (`ensembleRuns` Läufe pro Fenster).
4. **Grounding gegen den Volltext** — jede Belegstelle wird gegen das ganze Dokument
   verankert, nicht nur gegen ihr Fenster.
5. **Treffer mergen + deduplizieren** (gleiche Belegstelle über Fenstergrenzen → der
   Treffer mit den meisten Votes gewinnt); Doc-Priorität/-Felder daraus abgeleitet.

> **Wichtig:** Damit die großen Gesetze überhaupt in die Auswahl kommen, muss
> `maxDocChars` auf `0` stehen (sonst schließt es Docs über der Grenze aus, *bevor*
> das Chunking greift). Faustregel: **Demo** → `maxDocChars: 80000` (nur kleine Docs,
> schnell). **Voller Korpus** → `maxDocChars: 0` (alle Docs, große werden gechunkt).

Warum **nicht** stattdessen das Kontextfenster hochziehen: siehe [Design-Entscheidungen](#design-entscheidungen).

---

## Kritischer Zweitcheck

**Trichter-Prinzip:** Jeder Fund wird ohnehin von Sachverständigen geprüft — der Zweitcheck
ersetzt das nicht, er **fokussiert** die Prüfung, indem er Bedenken vorab sichtbar macht.
Ein **unabhängiges, idealerweise stärkeres** Modell bewertet **jeden Reformvorschlag
einzeln** kritisch:

1. **Unternehmensbindung** — belastet das wirklich Unternehmen, oder ist es reines Berufs-/
   Behördenrecht?
2. **Rechtsbindung respektiert** — passt der Vorschlag zur EU-/Bundes-Bindung?
3. **Hebel-Richtung korrekt** — reduziert der Vorschlag wirklich Bürokratie?
4. **Beleg plausibel** — passt die Fundstelle zum behaupteten Belastungstyp?

Ergebnis pro Vorschlag: `behalten` / `herabstufen` / `verwerfen` + kurze Begründung — sichtbar
direkt unter dem jeweiligen Vorschlag in Dashboard, Report und beiden CSV-Exporten.
**Keine Auto-Herabstufung**, nur `needs_review` wird bei Beanstandung gesetzt.

### Zwei Provider

**OpenRouter (Standard, `config.secondCheckProvider: "openrouter"`)** — Cloud, z. B.
`z-ai/glm-5.2` (`config.secondCheckOpenRouterModel`). Schnell, reasoning ist bei diesem
Modell fest eingebaut, keine lokalen Eigenheiten. Kosten bei ~10–25 Docs: Cent-Beträge.
Setup:
```bash
cp .env.example .env
# .env öffnen, OPENROUTER_API_KEY=... eintragen (nie in config.json oder ins Repo!)
```
`.env` ist gitignored — der Key landet nie im Repo oder in einem Commit.

**LM Studio (lokal, `config.secondCheckProvider: "lmstudio"`)** — 0 €, aber langsamer und
je nach Modell/Quant mit Eigenheiten. Wichtig: Das Skript spricht **das in LM Studio geladene
Modell** an (`config.secondCheckModel` explizit setzen, sonst Auto-Erkennung über
`state: loaded`) — **nie** `config.model` (das wäre Qwen und würde LM Studio dazu bringen,
zusätzlich Qwen zu laden → beide Modelle gleichzeitig im VRAM, alles wird langsam).
**Bekannte Eigenheit:** Manche Reasoning-Modelle (z. B. Ministral 3 14B Reasoning) denken
nur, wenn die Anfrage **keine `system`-Rolle** enthält — jede `system`-Message unterdrückt
bei diesem Modell/Quant das Reasoning komplett, unabhängig vom Inhalt (verifiziert: mit
`system`-Feld 0 Reasoning-Tokens, ganz ohne 2145). Vor dem produktiven Einsatz eines neuen
lokalen Modells: kurz mit einem trivialen Call gegenchecken (`usage.completion_tokens_details.
reasoning_tokens`), bevor man sich auf „es reasoned schon" verlässt.

Nutzung (Provider-unabhängig, läuft immer auf Reform-Priorität A+B):
```bash
node second-check.js            # überspringt bereits geprüfte Docs (Resumability)
node second-check.js --force    # erzwingt Re-Check aller A+B-Docs
```
Zwei unabhängige Modelle machen unabhängige Fehler — Konsens beider ist ein starkes Signal,
Uneinigkeit ist genau der Hinweis, wo Sachverstand gebraucht wird.

---

## Ergebnisse verstehen

Der Per-Hit-Export (`export-hits.js`) liefert **eine Zeile pro Belegstelle** mit klarer
Zuordnung *Beleg → Pflicht → Vorschlag → Risiko* (statt großer Sammellisten pro Dokument):

| Spalte | Bedeutung |
|---|---|
| `Belegstelle` | Fundstelle / Paragraf (wörtlich verankert) |
| `Pflichttyp` | Kategorie der Belastung (Berichtspflicht, Genehmigung, Schwellenwert …) |
| `Adressat` | Wer trägt die Pflicht: Gewerbe/Unternehmen · Freie Berufe/Selbstständige · Agrarbetrieb · Verbraucher/Private · Behörde · unklar — siehe [Adressat](#adressat-wer-trägt-die-pflicht) |
| `Aenderungsvorschlag` | Reformvorschlag **zu genau dieser Belegstelle** |
| `Risiko` | Risiko **zu genau diesem Vorschlag** |
| `Prioritaet` | **A** = klares Entlastungspotenzial · **B/C** = nachrangig — **pro Vorschlag**, nicht pro Dokument (siehe unten) |
| `ensemble_votes` | wie einig das Ensemble war (z. B. `3/3`) |
| `beleg_sicherheit` | Fundstelle wörtlich verankert? |
| `rechtlich_gebunden` | EU / Bund / Landesrecht (frei) |
| `human_review` | **JA** = vor Übernahme juristisch prüfen |
| `Zweitcheck` / `Zweitcheck_Begruendung` | Gegenmeinung eines unabhängigen Modells zu genau diesem Vorschlag (siehe [Zweitcheck](#kritischer-zweitcheck)) |
| `Endstatus` | Prioritaet + Zweitcheck-Urteil kombiniert (z. B. `A · bestätigt`, `B · infrage gestellt`) — reine Anzeigehilfe, **überschreibt die Prioritaet nie** |

### Reform-Priorität: pro Vorschlag, nicht pro Dokument

Qwen berechnet `business_relevance` schon **je Belegstelle** (Ensemble-Median pro Treffer)
— diese Granularität wird genutzt, statt sie auf einen Dokument-Durchschnitt zu glätten.
Grund: Ein einzelnes Gesetz kann echte Unternehmenslasten mit individuellen Pflichten
mischen. Konkreter Fund (Zweitcheck-Vergleich an `BayAPOFspl`, einer Fachsportlehrer-
Ausbildungsordnung): 3 Vorschläge betreffen den Ausbilder/Betrieb (**echte** Unternehmenslast),
7 betreffen den **Prüfungsbewerber persönlich** (Führungszeugnis, ärztliches Zeugnis, beglaubigte
Kopien — **keine** Unternehmenslast). Vorher bekamen alle 10 Zeilen dieselbe Doc-Priorität;
jetzt zeigt jede Zeile ihre eigene.

Die **Top-KPIs und der Prioritäts-Chart** zeigen trotzdem weiterhin einen **Doc-Level-Rollup**
(das beste Einzelurteil im Dokument) — als grobe „lohnt sich ein Blick"-Kennzahl zum Scannen.
Die eigentliche **Tabelle/der Export sind präzise pro Vorschlag**. Beide Sichten sind bewusst
unterschiedlich granular: KPI = schneller Scan, Tabelle = Arbeitsgrundlage.

### Kombinierte Endwertung (`Endstatus`)

Zeigt Prioritaet + Zweitcheck-Urteil zusammen (z. B. `A · bestätigt`, `B · infrage gestellt`,
`C · Bedenken`) — im Dashboard als Suffix am Prioritäts-Badge (✓ bestätigt · ‼ Bedenken ·
✗ infrage gestellt). **Rein additive Anzeige, kein automatisches Downgrade** — die Prioritaet
selbst ändert sich nie durch den Zweitcheck (Trichter-Prinzip, siehe
[Design-Entscheidungen](#design-entscheidungen)).

### Adressat: wer trägt die Pflicht?

Modelle vermischen leicht **Berufspflichten** (Hebammen-, Sportlehrer-, Bergführer-Berufsordnung)
mit **Unternehmenspflichten** — bei Selbstständigen/freien Berufen ist die Person zugleich der
Betrieb, eine harte Trennlinie gibt es fachlich nicht. Statt das im Code zu erzwingen, wird der
**Adressat als eigene, filterbare Dimension** erfasst; die Scope-Entscheidung („zählen freie
Berufe als unternehmensrelevant?") trifft der Mensch per Filter, nicht der Code.

- **`classifyAddressee()` in `classify.js`** — deterministische Heuristik aus Titel + Volltext, wirkt sofort auf alle
  bestehenden Läufe (kein Re-Run nötig). Der Behörde-Ausschluss prüft bewusst **nur den Titel**
  (im Volltext steckt fast immer eine harmlose Zuständigkeits-Boilerplate-Klausel, die sonst
  massenhaft falsch als „Behörde" klassifiziert — verifiziert: 7 Fehlalarme auf 1 reduziert).
- Künftige Analyse-Läufe liefern zusätzlich ein **`adressat`-Feld pro Vorschlag** vom Modell
  selbst (feiner als die Doc-Heuristik); das hat Vorrang, sonst greift der Fallback.
- Im Dashboard als **eigener Chip** sichtbar (Tabelle, Detail, gruppierte Ansicht) — bewusst
  einfarbig/neutral gehalten, damit er nicht mit den bereits vergebenen Farben von Priorität/
  Rechtsbindung/Zweitcheck in derselben Zeile kollidiert. Plus eigener Filter (`#f-adressat`)
  und Chart.

Der Review-Report enthält zusätzlich **automatische Warnungen**:
- **Ungrounded Hits** — sollten 0 sein; > 0 heißt, das Modell formatiert Belegstellen anders.
- **Verdächtige Vorschläge** — falsche Hebel-Richtung (z. B. „Frist verkürzen" = mehr statt weniger Bürokratie).
- **EU/Bund-gebunden mit Kürzungsvorschlag** — Substanz nicht kürzbar, kritisch prüfen.

---

## Design-Entscheidungen

Festgehaltene Überlegungen, damit der Kontext nicht verloren geht:

- **Kein _blindes_ RAG-Chunking.** Normale Docs werden NICHT vorab in feste
  Token-Blöcke geschnitten — das Modell findet im Volltext verwaltungspraktische
  Belastungsmechaniken gut, und stumpfes Schneiden würde Querbezüge und die
  Gesamtschau zerstören. **Ausnahme:** übergroße Gesetze (> 80k Zeichen), die nicht
  in einen Call passen, werden **an §-Grenzen** (semantisch, nicht stumpf) gechunkt
  und die Treffer wieder gemergt — siehe nächster Punkt. Kurz: nicht stumpf das
  Gesetz chunken, sondern nur wo nötig und entlang der Paragraphen, und die
  Ergebnisse strukturieren.
- **Kontextfenster NICHT hochziehen (große Docs lieber an §-Grenzen chunken).** Ein 9B-Reasoning-Modell
  über 100k+ Token (1) verliert Treffer „in der Mitte", (2) wird **loop-anfälliger**
  (mehr Reasoning-Fläche vor dem Output-Cap → abgeschnittene/leere Läufe), (3) wird
  langsam, (4) fasst die größten Gesetze (> 160k Token) trotzdem nicht. Chunking hält
  jeden Call im validierten Sweet Spot.
- **Confidence deterministisch ableiten, nicht vom Modell schätzen lassen.** Ein lokales
  9B ist bei juristischer Selbsteinschätzung unzuverlässig; Grounding und
  Rechtsbindung sind hart berechenbar.
- **Zweitcheck überschreibt nie automatisch (Trichter-Prinzip).** Der Zweitcheck setzt
  `needs_review` und zeigt eine kombinierte Endwertung an, ändert aber nie selbst die
  Prioritaet — auch zwei unabhängige Modelle machen unabhängige Fehler (siehe die
  Ministral-vs-GLM-Befunde in [Kritischer Zweitcheck](#kritischer-zweitcheck)); die
  Entscheidung bleibt beim Menschen, das Tool sortiert nur vor.
- **Gemeinsame Logik nur in `classify.js`, nie kopieren.** Reform-Priorität, Grounding &
  Co. existierten zeitweise als 4 Kopien in 4 Dateien (teils unter 3 Namen) — die Kopien
  drifteten und erzeugten zwei echte Bugs: der Zweitcheck übersprang still ein Dokument,
  das das Dashboard als B-Kandidat zeigte (BayGutAV), und die beiden CSV-Exporte schrieben
  unterschiedliche Werte in dieselbe Spalte. Seitdem gilt: Braucht eine zweite Datei
  dieselbe Funktion, wandert sie nach `classify.js` — kopieren ist verboten.
- **Sampler im Code, nicht im UI.** UI-Knöpfe stehen nicht in Git und überschreiben
  still, was die API nicht setzt.
- **Ein Fix ≠ ein Run.** Code-Änderung und Analyse-Lauf sind getrennte Schritte;
  Läufe startet der Mensch.

---

## Roadmap / Vorgehen

Reihenfolge bis zur belastbaren Auswertung:

1. ✅ **Crawl-Vollständigkeit** — §-Marker, Ermächtigungsgrundlagen, Tabellen erfasst.
2. ✅ **Sampler-Stabilität** — repeat_penalty 1.1, maxTokens 32000 (gegen Reasoning-Loops).
3. ✅ **Resumability + Per-Hit-Export + ehrliches needs_review/Confidence.**
4. ✅ **Reform-Priorität** (Umsetzbarkeit × Relevanz) — einheitlich in Report, Dashboard, Export.
5. ✅ **Dashboard: helles Theme, Normstellen-Auflösung, Lauf-Auswahl (Qwen ↔ Gemma).**
6. ✅ **§-Grenzen-Chunking** für große Gesetze (mit Größen-Fallback) — `maxDocChars: 0` aktiviert es für den vollen Korpus.
7. 🔶 **Validierter Demo-Lauf** — läuft, mehrere echte Analyse- + Zweitcheck-Durchgänge
   gemacht (Qwen, Gemma-Vergleich, GLM-5.2-Zweitcheck auf A+B). Voller Korpus (729 Docs,
   inkl. gechunkter Großgesetze) noch nicht komplett durchgelaufen — resumebar, kann
   jederzeit in Etappen weiterlaufen (`npm run analyze` wiederholt aufrufen).
8. ✅ **Kritischer Zweitcheck-Pass** (`second-check.js`) — ein UNABHÄNGIGES, stärkeres
   Modell (Standard: z-ai/glm-5.2 via OpenRouter) prüft die A+B-Liste kritisch
   (Unternehmensbindung / Rechtsbindung / Hebel-Richtung / Beleg), schreibt
   `analyses.second_check` + setzt `human_review`. **Kein Auto-Herabstufen** —
   nur Anzeige (Dashboard/Report/CSV), damit die Sachverständigen fokussiert prüfen.
   Nutzung: `node second-check.js` (läuft immer auf A+B, überspringt bereits
   Geprüfte). `.env` mit `OPENROUTER_API_KEY`, alternativ lokal via LM Studio.
   Details: [Kritischer Zweitcheck](#kritischer-zweitcheck).

**Selbstverständnis:** Das Tool ist ein **Trichter** — es sortiert die ~700 irrelevanten
Normen aus und fokussiert die Arbeit der Sachverständigen auf die Kandidaten. Jeder Fund
wird ohnehin menschlich geprüft; Reform-Priorität und Zweitcheck helfen beim Priorisieren,
sie entscheiden nicht.

Spätere Politur: §/Absatz-Normstellen aus den jetzt erfassten Markern auflösen,
Dubletten-Clustering ähnlicher Vorschläge.

---

## Datenbank

- **Pfad:** `data/buerokratie.db` (SQLite, WAL-Modus) — **gitignored** (Datenstand, kein Code).
- **Kerntabellen:**
  - `documents` — gecrawlte Volltexte (`text`, `char_count`, `downloaded_at`)
  - `raw_analyses` — alle Einzelläufe (append-only, pro `run_session`)
  - `analyses` — aggregiertes Endergebnis (eine Zeile pro Dokument, `analyzed_at`,
    `second_check` = Zweitcheck-Urteile als JSON-Array, `NULL` solange ungeprüft)
  - `pipeline_status` — Fortschritt der Phasen
- **`data/runs/`** — weitere `.db`-Dateien zum Vergleich im Dashboard (z. B. ein Lauf mit
  anderem Modell). Einfach eine Kopie der DB dort ablegen, erscheint automatisch im
  Lauf-Dropdown.

Direkt abfragen (Python, wegen Umlauten mit UTF-8):
```bash
python -X utf8 -c "import sqlite3; c=sqlite3.connect('data/buerokratie.db'); print(c.execute('SELECT priority,COUNT(*) FROM analyses GROUP BY priority').fetchall())"
```

---

## Entwicklung & Git

Reports und Daten-Artefakte sind bewusst aus dem Repo ausgeschlossen (`.gitignore`): `.env`, `*.db`, `data/runs/`, `*.csv`, `REVIEW_*.md`, `node_modules/`.

**Faustregel: vor jeder neuen Änderungsrunde committen, wenn der Stand funktioniert.**
Ein Commit = ein bekannter, wiederherstellbarer Zustand.

```bash
git add -A
git commit -m "kurze Beschreibung der Änderung"
git push
```

Alle lokalen Änderungen seit dem letzten Commit verwerfen (Notbremse):
```bash
git checkout -- .
```

> **Sicherheits-Regeln für KI-Agenten** stehen in [`CLAUDE.md`](CLAUDE.md) — u. a.: keine
> destruktiven Aktionen ohne Freigabe, niemals `analyses`/`raw_analyses` löschen, ein Fix
> pro Schritt, Läufe startet der Mensch.

---

## Troubleshooting

| Problem | Lösung |
|---|---|
| `ECONNREFUSED` / Analyse hängt | LM-Studio-Server läuft nicht oder falscher Port → Server starten, `lmStudioEndpoint` prüfen |
| `[LM Studio: empty content]` / Token-Limit | Modell hat leer/abgeschnitten geliefert → Ensemble fängt Einzelausfälle ab; tritt es gehäuft auf, war der Reasoning-Loop zu lang (Sampler/`maxTokens` prüfen) |
| Endlos-Reasoning / sehr langsame Docs | Loop-Verdacht → `repeat_penalty` (1.1) und `maxTokens` prüfen; betroffenes Doc als `testDocIds`-Mini-Test isolieren |
| Crawler startet nicht / Browser-Fehler | `npx playwright install chromium` ausführen |
| `better-sqlite3`-Fehler nach `npm install` | Node-Version prüfen; ggf. `npm rebuild better-sqlite3` |
| Report zeigt **Ungrounded Hits > 0** | Modell formatiert das `paragraph`-Feld anders → Grounding-Logik in `analyzer/index.js` prüfen |
| A-Liste schwankt zwischen Läufen | Normale Ensemble-Varianz am Mehrheits-Rand; der einstimmige Kern ist stabil; ggf. `ensembleRuns` erhöhen |
| Großes Gesetz nur teilweise analysiert | `maxDocChars > 0` schließt es VOR dem Chunking aus (kein Teilergebnis, wird komplett übersprungen) → `maxDocChars: 0` setzen, dann greift das §-Chunking |
| `pipeline_status` zeigt „läuft" nach einem Absturz | `node reset-analyze.js` — setzt nur den Status zurück, **löscht keine Daten** |
| Zweitcheck: `OPENROUTER_API_KEY fehlt` | `.env` aus `.env.example` anlegen und Key eintragen (siehe [Installation](#installation)) |
| Zweitcheck: einzelnes Doc mit JSON-Parse-Fehler | Meist ein einmaliger Formatierungsausrutscher des Modells (z. B. Anführungszeichen im Text) → Skript einfach erneut starten, Resumability holt nur das fehlgeschlagene Doc nach |
| Zweitcheck lokal (LM Studio) extrem langsam trotz laufendem Server | Wahrscheinlich wurde per JIT ein zweites Modell zusätzlich geladen (falsche Modell-Referenz) → `config.secondCheckModel` exakt auf die geladene ID setzen, nur ein Modell gleichzeitig laden |

---

*Kernanalyse lokal und kostenfrei — der optionale Zweitcheck kann eine Cloud-API nutzen (siehe [Kritischer Zweitcheck](#kritischer-zweitcheck)).*
