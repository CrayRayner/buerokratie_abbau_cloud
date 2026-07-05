# dist/ — Auslieferbares Produkt (ohne Volltext, ohne Flow-Code)

Hier entsteht das, was einem Kunden gegeben wird: ein schlanker Read-only-Viewer
plus eine **text- und IP-freie `dist.db`**. Crawler, Analyzer, Prompts, `classify.js`
und `raw_analyses` bleiben in unserem Repo — ausgeliefert wird nur das Endergebnis.

## Workflow

```bash
# 1. Backen: volle Analyse-DB -> dist/dist.db (vorberechnete Anzeigefelder, kein Text)
#    Cloud-Repo: Quelle ist data/buerokratie.db — publish.js findet sie automatisch.
node dist/publish.js data/buerokratie.db "Datenstand Juli 2026"

# 2. Viewer starten (Dev, liest dist/dist.db):
node dist/viewer/server/index.js            # -> http://localhost:3456

# 3. Packen -> Installer .exe (electron-builder + NSIS):
#    Voraussetzung: Schritt 1 gelaufen (dist/dist.db existiert) + optional build/icon.ico
cd dist/viewer
npm install        # zieht Electron + rebuildet better-sqlite3 (postinstall) fuer Electron
npm run dist       # -> dist/viewer/dist/Buerokratieabbau Bayern Setup 1.0.0.exe
```

**Wichtig:** `dist.db` wird beim Build ueber `extraResources` (`../dist.db`) neben die App
gelegt (`resources/dist.db`) und vom Server per `process.resourcesPath` gefunden. Erst
backen (Schritt 1), dann packen — sonst fehlt die Datei im Installer.

Der Installer ist ein normaler NSIS-Assistent (Zielordner waehlbar, Startmenue-Eintrag).
Beim Start oeffnet die App ein Electron-Fenster, startet den Express-Server **inline**
(kein fork) auf einem freien Port und laedt das Dashboard — komplett offline, ohne
unseren Flow-Code.

## Viewer (dist/viewer/)

Read-only-Fork des Dashboards: der Server macht ausschliesslich `SELECT` auf `dist.db`
(kein `require('classify')`, kein Gesetzestext). Chart.js ist lokal gevendort (offline),
Run-Picker/Refresh sind raus (ein fester Datensatz), ein `?`-Hilfe-Overlay erklaert die
Spalten fuer Nicht-Techniker. Angezeigt wird nur der Datenstand, nicht der Modellname.

> Das `public/`-Frontend ist ein **Fork** von `dashboard/public/`. Aendert sich das
> Dashboard-UI grundlegend, hier nachziehen.

## Web-Variante — Dashboard hinter Login auf PHP-Hosting (dist/web/)

Fuer Hosting OHNE Node.js (klassisches PHP/Webspace, z. B. toryn-gent.net). Dasselbe
Frontend, aber statt des Express-Servers eine statische `data.json` — das gleiche `app.js`
laedt sie ueber `window.VIEWER_CFG` (in Electron weiterhin `/api/data`, kein zweiter Fork).

```bash
# 1. Web-Bundle erzeugen (zusaetzlich zur dist.db). Cloud-Repo: Quelle = data/buerokratie.db
node dist/publish.js data/buerokratie.db "Datenstand Juli 2026" --web
#    -> dist/web/  (index.html, app.js, style.css, vendor/, data.json, export.csv, .htaccess, SETUP.md)

# 2. Login-Passwoerter erzeugen (starke Zufallspasswoerter, nur Hashes gespeichert):
node dist/gen-htpasswd.js kunde1 kunde2        # zeigt Klartext EINMALIG -> Passwortmanager

# 3. dist/web/ per SFTP hochladen (inkl. versteckter .htaccess/.htpasswd) -> SETUP.md folgen.
```

**Login:** Du waehlst den Benutzernamen, `gen-htpasswd.js` erzeugt das Passwort und zeigt es
EINMALIG an — das ist der Login. `--add <name>` haengt weitere Benutzer an.

**Sicherheit (eingebaut):** `.htaccess` erzwingt HTTPS, schuetzt per Basic-Auth, verbietet
Ausliefern von `.ht*`/`*.md`, setzt CSP + Security-Header. Passwoerter nur als **APR1-Hash**
(salted, gegen `openssl passwd -apr1` verifiziert), Klartext nur einmalig in der Konsole.
`dist/web/` ist komplett **gitignored** — `.htpasswd` und `data.json` landen nie im Repo.
IP-Schutz identisch zur dist.db (kein Volltext, kein `classify.js`).

Der fummeligste Schritt ist der absolute Serverpfad zur `.htpasswd` in der `.htaccess`
(Apache-Vorgabe) — die genaue Anleitung inkl. `pfad.php`-Trick steht in `dist/web-template/SETUP.md`
(wird beim `--web`-Bauen nach `dist/web/SETUP.md` kopiert).

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
