#!/usr/bin/env node
/**
 * PUBLISH / BAKE — erzeugt eine auslieferbare dist.db OHNE Volltext und OHNE IP-Code.
 *
 * Laeuft NUR bei uns. Liest die volle Analyse-DB (inkl. documents.text + classify.js) und
 * berechnet fuer jeden Treffer EINMAL alle Anzeigefelder vor, die das Dashboard heute LIVE
 * rechnet (Normstelle, Grounding, Adressat, Prioritaet, Endstatus). Ergebnis: eine flache,
 * read-only dist.db, die der Viewer ohne classify.js und ohne Gesetzestext rendern kann.
 *
 * Damit bleibt der Flow (crawler/analyzer/prompts/classify/raw_analyses) auf unserer Seite —
 * ausgeliefert wird nur das Endergebnis.
 *
 * Aufruf:
 *   node dist/publish.js                                   (Quelle: data/buerokratie.final.db)
 *   node dist/publish.js pfad/zur/quelle.db                (andere Quelle)
 *   node dist/publish.js quelle.db "Datenstand Juli 2026"  (+ Anzeige-Datenstand)
 *   node dist/publish.js ... --web                          (zusaetzlich statisches dist/web/)
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const {
  classifyAddressee, legalShort, legalDisplay, reformPriority,
  isGrounded, buildNormMap, resolveNorm, endstatus, parseHits
} = require('../classify');

// Flags (--web) von den Positions-Argumenten trennen.
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const WEB = process.argv.includes('--web');

// Default-Quelle: nimm die vorhandene DB (lokales Repo: buerokratie.final.db,
// Cloud-Repo: buerokratie.db) — so laeuft dieselbe publish.js in beiden Repos ohne Argument.
function defaultSrc() {
  for (const name of ['buerokratie.final.db', 'buerokratie.db']) {
    const p = path.join(__dirname, '..', 'data', name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, '..', 'data', 'buerokratie.final.db');
}
const srcPath = positional[0] || defaultSrc();
const dataDate = positional[1] || new Date().toISOString().slice(0, 10);
const outPath = path.join(__dirname, 'dist.db');

if (!fs.existsSync(srcPath)) { console.error('Quelle nicht gefunden: ' + srcPath); process.exit(1); }

const src = new Database(srcPath, { readonly: true, fileMustExist: true });

// --- Hilfen, 1:1 aus dashboard/server/routes/api.js (damit die Zahlen IDENTISCH sind) ---
function isUnanimous(conf) {
  const m = String(conf || '').match(/^(\d+)\s*\/\s*(\d+)$/);
  return m ? m[1] === m[2] : false;
}
function hasCol(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col); }
  catch { return false; }
}
function parseSecondCheck(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }

const scCol = hasCol(src, 'analyses', 'second_check') ? 'a.second_check' : 'NULL AS second_check';
const rows = src.prepare(`
  SELECT a.doc_id, a.priority, a.description, a.confidence, a.needs_review,
         a.legal_restrictions, a.business_relevance, a.relief_potential,
         a.baymog_suitability, a.summary, a.model, a.analyzed_at, ${scCol},
         d.title, d.norm_type, d.url, d.text, d.char_count
  FROM analyses a
  JOIN documents d ON d.doc_id = a.doc_id
  WHERE a.analyzed_at >= d.downloaded_at
  ORDER BY a.analyzed_at DESC
`).all();

const totalDocs = src.prepare('SELECT COUNT(*) c FROM documents').get().c;
const PRIO_RANK = { A: 0, B: 1, C: 2 };

const kpi = {
  totalDocs, analyzed: rows.length, prioA: 0, prioB: 0, prioC: 0, notRated: 0,
  needsReview: 0, landesrechtFrei: 0, hitsTotal: 0, ungrounded: 0,
  lastRun: rows.length ? rows[0].analyzed_at : null, model: rows.length ? rows[0].model : null
};
const charts = {
  priority: { A: 0, B: 0, C: 0, 'nicht bewertet': 0 },
  legal: { 'Landesrecht': 0, 'Bund': 0, 'EU': 0 },
  categories: {}, relevance: { hoch: 0, mittel: 0, niedrig: 0 }, adressat: {}
};

const hitRows = [];   // -> published_hits
const docRows = [];   // -> published_docs

for (const r of rows) {
  const lShort = legalShort(r.legal_restrictions);
  const lDisplay = legalDisplay(r.legal_restrictions);
  const docHits = parseHits(r.description);
  const nm = buildNormMap(r.text || '');
  const docAddresseeFallback = classifyAddressee(r.title, r.text);

  const rated = r.priority === 'A' || r.priority === 'B' || r.priority === 'C';
  const scParsed = parseSecondCheck(r.second_check);
  const scArr = Array.isArray(scParsed) ? scParsed : null;
  const scDoc = (scParsed && !Array.isArray(scParsed)) ? scParsed : null;

  let bestHitPrio = null;

  for (let hi = 0; hi < docHits.length; hi++) {
    const h = docHits[hi];
    const grounded = isGrounded(h.paragraph, r.text);
    const normstelle = resolveNorm(h.paragraph, r.text || '', nm);
    if (!grounded) kpi.ungrounded++;
    kpi.hitsTotal++;

    const hitRelevance = h.business_relevance || r.business_relevance || '';
    const hitPrio = rated ? reformPriority(lShort, hitRelevance) : 'nicht bewertet';
    if (rated && (bestHitPrio === null || PRIO_RANK[hitPrio] < PRIO_RANK[bestHitPrio])) bestHitPrio = hitPrio;

    const cat = h.category || 'sonstige';
    charts.categories[cat] = (charts.categories[cat] || 0) + 1;
    if (charts.legal[lShort] != null) charts.legal[lShort]++;
    const rel = hitRelevance.toLowerCase();
    if (charts.relevance[rel] != null) charts.relevance[rel]++;
    const adressat = h.adressat || docAddresseeFallback;
    charts.adressat[adressat] = (charts.adressat[adressat] || 0) + 1;

    const sc = scArr ? (scArr[hi] || null) : scDoc;
    hitRows.push({
      doc_id: r.doc_id, hit_index: hi,
      title: r.title || r.doc_id, norm_type: r.norm_type || '', url: r.url || '',
      priority: hitPrio, confidence: r.confidence || '', unanimous: isUnanimous(r.confidence) ? 1 : 0,
      needs_review: r.needs_review ? 1 : 0,
      legal: lShort, legal_full: r.legal_restrictions || 'Landesrecht (frei kürzbar)', legal_display: lDisplay,
      category: cat, adressat, normstelle, beleg: h.paragraph || '',
      burden: h.burden || h.burden_type || '', proposed: h.proposed_change || '', risks: h.risks || '',
      relevance: hitRelevance, relief: h.relief_potential || r.relief_potential || '',
      grounded: grounded ? 1 : 0,
      second_check: sc ? JSON.stringify(sc) : null,
      endstatus: endstatus(hitPrio, sc),
      model: r.model || ''
    });
  }

  const docPrio = rated && bestHitPrio ? bestHitPrio : 'nicht bewertet';
  if (docPrio === 'A') kpi.prioA++;
  else if (docPrio === 'B') kpi.prioB++;
  else if (docPrio === 'C') kpi.prioC++;
  else kpi.notRated++;
  if (charts.priority[docPrio] != null) charts.priority[docPrio]++;
  if (r.needs_review) kpi.needsReview++;
  if (lShort === 'Landesrecht' && (docPrio === 'A' || docPrio === 'B')) kpi.landesrechtFrei++;

  docRows.push({
    doc_id: r.doc_id, title: r.title || r.doc_id, url: r.url || '', norm_type: r.norm_type || '',
    doc_priority: docPrio, legal: lShort, needs_review: r.needs_review ? 1 : 0,
    model: r.model || '', analyzed_at: r.analyzed_at || ''
  });
}
const categories = Object.entries(charts.categories).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
const chartsOut = { ...charts, categories };

// --- dist.db schreiben (frisch) ---
try { fs.unlinkSync(outPath); }
catch (e) {
  if (e.code !== 'ENOENT') {
    console.error('dist.db kann nicht ueberschrieben werden — laeuft noch ein Viewer, der sie offen haelt?\n  ' + e.message);
    process.exit(1);
  }
}
const dist = new Database(outPath);
// Rollback-Journal statt WAL: dist.db bleibt EINE Datei (keine -wal/-shm Nebendateien),
// wichtig fuers Ausliefern. Der Viewer oeffnet sie ohnehin nur read-only.
dist.pragma('journal_mode = DELETE');
dist.exec(`
  CREATE TABLE published_hits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT, hit_index INTEGER, title TEXT, norm_type TEXT, url TEXT,
    priority TEXT, confidence TEXT, unanimous INTEGER, needs_review INTEGER,
    legal TEXT, legal_full TEXT, legal_display TEXT, category TEXT, adressat TEXT,
    normstelle TEXT, beleg TEXT, burden TEXT, proposed TEXT, risks TEXT,
    relevance TEXT, relief TEXT, grounded INTEGER, second_check TEXT, endstatus TEXT, model TEXT
  );
  CREATE TABLE published_docs (
    doc_id TEXT PRIMARY KEY, title TEXT, url TEXT, norm_type TEXT,
    doc_priority TEXT, legal TEXT, needs_review INTEGER, model TEXT, analyzed_at TEXT
  );
  CREATE TABLE published_meta ( key TEXT PRIMARY KEY, value TEXT );
  CREATE INDEX idx_hits_priority ON published_hits(priority);
  CREATE INDEX idx_hits_doc ON published_hits(doc_id);
`);

const insHit = dist.prepare(`INSERT INTO published_hits
  (doc_id,hit_index,title,norm_type,url,priority,confidence,unanimous,needs_review,legal,legal_full,legal_display,category,adressat,normstelle,beleg,burden,proposed,risks,relevance,relief,grounded,second_check,endstatus,model)
  VALUES (@doc_id,@hit_index,@title,@norm_type,@url,@priority,@confidence,@unanimous,@needs_review,@legal,@legal_full,@legal_display,@category,@adressat,@normstelle,@beleg,@burden,@proposed,@risks,@relevance,@relief,@grounded,@second_check,@endstatus,@model)`);
const insDoc = dist.prepare(`INSERT INTO published_docs
  (doc_id,title,url,norm_type,doc_priority,legal,needs_review,model,analyzed_at)
  VALUES (@doc_id,@title,@url,@norm_type,@doc_priority,@legal,@needs_review,@model,@analyzed_at)`);
const insMeta = dist.prepare('INSERT INTO published_meta (key,value) VALUES (?,?)');

dist.transaction(() => {
  for (const h of hitRows) insHit.run(h);
  for (const d of docRows) insDoc.run(d);
  insMeta.run('generated_at', new Date().toISOString());
  insMeta.run('data_date', dataDate);
  insMeta.run('source_db', path.basename(srcPath));
  insMeta.run('source_model', kpi.model || '');
  insMeta.run('doc_count', String(rows.length));
  insMeta.run('hit_count', String(hitRows.length));
  insMeta.run('kpi_json', JSON.stringify(kpi));
  insMeta.run('charts_json', JSON.stringify(chartsOut));
})();

dist.close();
src.close();

const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log('dist.db geschrieben -> ' + outPath + ' (' + sizeKb + ' KB)');
console.log('  Dokumente: ' + rows.length + ' | Treffer: ' + hitRows.length +
  ' | A/B/C(doc): ' + kpi.prioA + '/' + kpi.prioB + '/' + kpi.prioC +
  ' | nicht bewertet: ' + kpi.notRated + ' | ungrounded: ' + kpi.ungrounded);
console.log('  Volltext & raw_analyses NICHT enthalten. Datenstand: ' + dataDate);

// --- Optional: statisches Web-Bundle (dist/web/) fuer PHP-Hosting ohne Node ---
if (WEB) writeWebBundle();

function writeWebBundle() {
  const webDir = path.join(__dirname, 'web');
  const viewerPub = path.join(__dirname, 'viewer', 'public');
  fs.mkdirSync(path.join(webDir, 'vendor'), { recursive: true });

  // hitRows (DB-Form) -> API-Form, identisch zu dist/viewer/server/routes/api.js /data.
  const apiHits = hitRows.map(h => ({
    docId: h.doc_id, title: h.title, normType: h.norm_type, url: h.url,
    priority: h.priority, confidence: h.confidence, unanimous: !!h.unanimous,
    needsReview: !!h.needs_review, legal: h.legal, legalFull: h.legal_full,
    category: h.category, adressat: h.adressat, normstelle: h.normstelle,
    beleg: h.beleg, burden: h.burden, proposed: h.proposed, risks: h.risks,
    relevance: h.relevance, relief: h.relief, grounded: !!h.grounded,
    secondCheck: h.second_check ? JSON.parse(h.second_check) : null, endstatus: h.endstatus
  }));
  fs.writeFileSync(path.join(webDir, 'data.json'),
    JSON.stringify({ kpi, charts: chartsOut, hits: apiHits, dataDate }), 'utf8');

  // export.csv (gleiche 19 Spalten wie der Viewer-CSV-Export)
  const esc = v => { const s = String(v == null ? '' : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const header = ['Gesetz', 'Normtyp', 'Normstelle', 'Belegstelle', 'Pflichttyp', 'Adressat', 'Belegtext',
    'Aenderungsvorschlag', 'Risiko', 'Prioritaet', 'ensemble_votes', 'beleg_sicherheit',
    'rechtlich_gebunden', 'human_review', 'Zweitcheck', 'Zweitcheck_Begruendung', 'Endstatus', 'URL', 'Modell'];
  const csv = [header.join(';')];
  for (const h of hitRows.filter(x => ['A', 'B', 'C'].includes(x.priority))) {
    let sc = null; try { sc = h.second_check ? JSON.parse(h.second_check) : null; } catch { /* leer */ }
    csv.push([h.title, h.norm_type, h.normstelle, h.beleg, h.category, h.adressat, h.burden,
      h.proposed, h.risks, h.priority, h.confidence, h.grounded ? 'hoch' : 'niedrig', h.legal_display,
      h.needs_review ? 'JA' : 'nein', sc ? sc.empfehlung || '' : '', sc ? sc.begruendung || '' : '',
      h.endstatus, h.url, h.model].map(esc).join(';'));
  }
  fs.writeFileSync(path.join(webDir, 'export.csv'), '﻿' + csv.join('\n'), 'utf8');

  // Frontend uebernehmen (app.js/style.css/chart.js unveraendert; index.html angepasst)
  fs.copyFileSync(path.join(viewerPub, 'app.js'), path.join(webDir, 'app.js'));
  fs.copyFileSync(path.join(viewerPub, 'style.css'), path.join(webDir, 'style.css'));
  fs.copyFileSync(path.join(viewerPub, 'vendor', 'chart.umd.min.js'), path.join(webDir, 'vendor', 'chart.umd.min.js'));

  // Konfig als EIGENE Datei statt inline: die CSP der .htaccess (script-src 'self')
  // blockt Inline-Scripts — eine inline gesetzte VIEWER_CFG wuerde am Server still
  // verworfen und das Dashboard bliebe leer ("Fehler beim Laden").
  // Build-Id fuer Cache-Busting — auch data.json wird darueber versioniert,
  // sonst zeigt der Browser nach einem Daten-Update alte Zahlen aus dem Cache.
  const v = Date.now().toString(36);
  fs.writeFileSync(path.join(webDir, 'cfg.js'), `window.VIEWER_CFG = { data: "data.json?v=${v}" };\n`, 'utf8');
  let html = fs.readFileSync(path.join(viewerPub, 'index.html'), 'utf8');
  html = html.replace('<script src="vendor/chart.umd.min.js"></script>',
    '<script src="cfg.js"></script>\n  <script src="vendor/chart.umd.min.js"></script>');
  html = html.replace('id="csv-link" href="/api/export/csv"', 'id="csv-link" href="export.csv"');
  // Cache-Busting: ?v=<Build-Id> an alle Assets. Browser cachen JS/CSS aggressiv —
  // ohne das rendert nach einem Update die ALTE app.js gegen die NEUE index.html
  // (verschobene Spalten, fehlende Features), bis jemand Strg+F5 drueckt.
  html = html
    .replace('href="style.css"', `href="style.css?v=${v}"`)
    .replace('src="cfg.js"', `src="cfg.js?v=${v}"`)
    .replace('src="app.js"', `src="app.js?v=${v}"`)
    .replace('src="vendor/chart.umd.min.js"', `src="vendor/chart.umd.min.js?v=${v}"`)
    .replace('href="export.csv"', `href="export.csv?v=${v}"`);
  fs.writeFileSync(path.join(webDir, 'index.html'), html, 'utf8');

  // Schutz-Template + Anleitung. .htaccess NUR anlegen, wenn nicht vorhanden —
  // der Nutzer traegt dort seinen AuthUserFile-Serverpfad ein, den ein Re-Bake
  // sonst stillschweigend auf den Platzhalter zuruecksetzen wuerde.
  const tpl = path.join(__dirname, 'web-template');
  const htaccess = path.join(webDir, '.htaccess');
  if (!fs.existsSync(htaccess)) fs.copyFileSync(path.join(tpl, '.htaccess'), htaccess);
  else console.log('  .htaccess vorhanden -> NICHT ueberschrieben (AuthUserFile-Pfad bleibt erhalten)');
  fs.copyFileSync(path.join(tpl, 'SETUP.md'), path.join(webDir, 'SETUP.md'));

  const hasPw = fs.existsSync(path.join(webDir, '.htpasswd'));
  console.log('\nWeb-Bundle geschrieben -> ' + webDir);
  console.log('  index.html, app.js, style.css, vendor/chart.umd.min.js, data.json, export.csv, .htaccess, SETUP.md');
  console.log('  .htpasswd: ' + (hasPw ? 'vorhanden (behalten)' : 'FEHLT -> node dist/gen-htpasswd.js <benutzer>'));
  console.log('  Naechste Schritte: SETUP.md lesen (Login + Pfad + Upload).');
}
