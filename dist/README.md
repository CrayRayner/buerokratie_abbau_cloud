# dist/ — Auslieferbares Produkt (ohne Volltext, ohne Flow-Code)

Hier entsteht das, was einem Kunden gegeben wird: ein schlanker Read-only-Viewer
plus eine **text- und IP-freie `dist.db`**. Crawler, Analyzer, Prompts, `classify.js`
und `raw_analyses` bleiben in unserem Repo — ausgeliefert wird nur das Endergebnis.

## Workflow

```bash
# 1. Backen: volle Analyse-DB -> dist/dist.db (vorberechnete Anzeigefelder, kein Text)
#    Cloud-Repo: Quelle ist data/buerokratie.db — publish.js findet sie automatisch.
node dist/publish.js data/buerokratie.db "Datenstand Juli 2026"

# 2. (folgt) Viewer bauen/packen -> dist/  (electron-builder + NSIS -> eine .exe)
```

## Warum das die IP schützt

Das Dashboard rechnet heute **live** aus `documents.text` + `classify.js`
(Normstelle, Grounding, Adressat, Priorität, Endstatus). `publish.js` rechnet das
**einmal bei uns** vor und schreibt nur die Ergebnisse in `dist.db`. Der Viewer macht
dann nur noch `SELECT` — er braucht weder den Gesetzestext noch `classify.js`. Damit ist
unser Flow schlicht **nicht im Paket** (Electron-JS ist Klartext — Schutz = Ausschluss,
nicht Verschleierung).

## dist.db — Schema (alles vorberechnet)

| Tabelle | Inhalt |
|---|---|
| `published_hits` | eine Zeile pro Belegstelle: Normstelle, Priorität, Adressat, Endstatus, Beleg, Vorschlag, Risiko, Zweitcheck, grounded … (für Tabelle **und** CSV) |
| `published_docs` | eine Zeile pro Dokument mit dem Doc-Level-Rollup (`doc_priority`) — für die KPIs/Charts, die pro Dokument zählen |
| `published_meta` | `data_date`, `source_model`, `kpi_json`, `charts_json`, Zähler — der Viewer serviert KPIs/Charts direkt daraus, ohne Neuberechnung |

**Nicht enthalten:** `documents.text` (25 MB Gesetzestext), `raw_analyses` (LLM-Rohausgaben),
`crawl_jobs`, `pipeline_status`.

## Verifikation

`publish.js` nutzt exakt dieselbe Berechnungs-Loop wie `dashboard/server/routes/api.js`.
Die gebackenen Zahlen müssen mit dem Live-Dashboard übereinstimmen
(Referenz Juli-2026-Lauf, Cloud/DeepSeek: Docs 108, Treffer 331, A/B/C 16/10/11, nicht bewertet 71, ungrounded 0).
