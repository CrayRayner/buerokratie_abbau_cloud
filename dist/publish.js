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
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const {
  classifyAddressee, legalShort, legalDisplay, reformPriority,
  isGrounded, buildNormMap, resolveNorm, endstatus, parseHits
} = require('../classify');

// Default-Quelle: nimm die vorhandene DB (lokales Repo: buerokratie.final.db,
// Cloud-Repo: buerokratie.db) — so laeuft dieselbe publish.js in beiden Repos ohne Argument.
function defaultSrc() {
  for (const name of ['buerokratie.final.db', 'buerokratie.db']) {
    const p = path.join(__dirname, '..', 'data', name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, '..', 'data', 'buerokratie.final.db');
}
const srcPath = process.argv[2] || defaultSrc();
const dataDate = process.argv[3] || new Date().toISOString().slice(0, 10);
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
try { fs.unlinkSync(outPath); } catch { /* nicht vorhanden */ }
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
