const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getDb } = require('../../../db');
const {
  classifyAddressee, legalShort, legalDisplay, reformPriority,
  isGrounded, buildNormMap, resolveNorm, endstatus, parseHits
} = require('../../../classify');
const router = express.Router();

// Läufe = einzelne .db-Dateien in data/ und data/runs/.
// Jeder Analyse-Lauf überschreibt die analyses-Tabelle SEINER DB — zum Vergleichen
// (Qwen vs. Gemma) legt man die DBs nebeneinander und wählt sie hier aus.
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
try { fs.mkdirSync(RUNS_DIR, { recursive: true }); } catch { /* ignore */ }

function listRuns() {
  const out = [];
  for (const [dir, tag] of [[DATA_DIR, 'data'], [RUNS_DIR, 'runs']]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.db')) continue;
        const st = fs.statSync(path.join(dir, f));
        out.push({ name: f, dir: tag, size: st.size, mtime: st.mtimeMs });
      }
    } catch { /* ignore */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Öffnet die gewählte Run-DB read-only; ohne run -> Haupt-DB (getDb).
// basename() verhindert Path-Traversal; nur .db-Dateien aus den erlaubten Ordnern.
function resolveRunDb(run) {
  if (!run) return { db: getDb(), close() {} };
  const base = path.basename(String(run));
  if (!base.endsWith('.db')) throw new Error('ungültiger Run-Name');
  for (const dir of [RUNS_DIR, DATA_DIR]) {
    const p = path.join(dir, base);
    if (fs.existsSync(p)) {
      const db = new Database(p, { readonly: true, fileMustExist: true });
      return { db, close() { db.close(); } };
    }
  }
  throw new Error('Run nicht gefunden: ' + base);
}

router.get('/runs', (req, res) => {
  res.json({ runs: listRuns() });
});

// Grounding, legalShort, reformPriority, endstatus, parseHits: siehe classify.js
// (gemeinsames Modul — hier bewusst KEINE lokalen Kopien mehr).

function isUnanimous(conf) {
  const m = String(conf || '').match(/^(\d+)\s*\/\s*(\d+)$/);
  return m ? m[1] === m[2] : false;
}

// second_check gibt es nur in DBs, die durch second-check.js liefen (read-only Run-DBs
// evtl. nicht) → Spalte defensiv prüfen.
function hasCol(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col); }
  catch { return false; }
}
function parseSecondCheck(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// Ein Endpoint, alles drin: KPIs + Chart-Aggregate + flache Trefferliste.
// Nur AKTUELLE Analysen (analyzed_at >= downloaded_at) — konsistent zum Export,
// keine stale-Text-Leichen.
router.get('/data', (req, res) => {
  let handle;
  try { handle = resolveRunDb(req.query.run); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const db = handle.db;

  const totalDocs = db.prepare('SELECT COUNT(*) c FROM documents').get().c;
  const scCol = hasCol(db, 'analyses', 'second_check') ? 'a.second_check' : 'NULL AS second_check';

  const rows = db.prepare(`
    SELECT a.doc_id, a.priority, a.description, a.confidence, a.needs_review,
           a.legal_restrictions, a.business_relevance, a.relief_potential,
           a.baymog_suitability, a.summary, a.model, a.analyzed_at, ${scCol},
           d.title, d.norm_type, d.url, d.text, d.char_count
    FROM analyses a
    JOIN documents d ON d.doc_id = a.doc_id
    WHERE a.analyzed_at >= d.downloaded_at
    ORDER BY a.analyzed_at DESC
  `).all();

  const kpi = {
    totalDocs, analyzed: rows.length,
    prioA: 0, prioB: 0, prioC: 0, notRated: 0,
    needsReview: 0, landesrechtFrei: 0, hitsTotal: 0, ungrounded: 0,
    lastRun: rows.length ? rows[0].analyzed_at : null,
    model: rows.length ? rows[0].model : null
  };

  const charts = {
    priority: { A: 0, B: 0, C: 0, 'nicht bewertet': 0 },
    legal: { 'Landesrecht': 0, 'Bund': 0, 'EU': 0 },
    categories: {},
    relevance: { hoch: 0, mittel: 0, niedrig: 0 },
    adressat: {}
  };

  const hits = [];

  const PRIO_RANK = { A: 0, B: 1, C: 2 };

  for (const r of rows) {
    const lShort = legalShort(r.legal_restrictions);
    const docHits = parseHits(r.description);
    const nm = buildNormMap(r.text || '');
    // Fallback (Weg 1, deterministisch aus Titel+Text) — greift für alle Docs,
    // auch aus Läufen ohne das LLM-Feld "adressat" (Weg 2).
    const docAddresseeFallback = classifyAddressee(r.title, r.text);

    const rated = r.priority === 'A' || r.priority === 'B' || r.priority === 'C';
    const scParsed = parseSecondCheck(r.second_check);
    const scArr = Array.isArray(scParsed) ? scParsed : null;      // pro Vorschlag (neu)
    const scDoc = (scParsed && !Array.isArray(scParsed)) ? scParsed : null; // alt: doc-weit

    let bestHitPrio = null; // Doc-Level-Rollup für KPI/Chart: bestes Einzelurteil im Dokument

    for (let hi = 0; hi < docHits.length; hi++) {
      const h = docHits[hi];
      const grounded = isGrounded(h.paragraph, r.text);
      const normstelle = resolveNorm(h.paragraph, r.text || '', nm);
      if (!grounded) kpi.ungrounded++;
      kpi.hitsTotal++;

      // Pro-Vorschlag-Relevanz: Qwen berechnet business_relevance schon je Belegstelle
      // (Ensemble-Median pro Treffer) — die nutzen, statt auf den Doc-Schnitt zu glätten.
      const hitRelevance = h.business_relevance || r.business_relevance || '';
      const hitPrio = rated ? reformPriority(lShort, hitRelevance) : 'nicht bewertet';
      if (rated && (bestHitPrio === null || PRIO_RANK[hitPrio] < PRIO_RANK[bestHitPrio])) bestHitPrio = hitPrio;

      const cat = h.category || 'sonstige';
      charts.categories[cat] = (charts.categories[cat] || 0) + 1;
      if (charts.legal[lShort] != null) charts.legal[lShort]++;
      const rel = hitRelevance.toLowerCase();
      if (charts.relevance[rel] != null) charts.relevance[rel]++;
      // adressat: LLM-Feld (Weg 2, neue Läufe) bevorzugt, sonst Titel/Text-Heuristik (Weg 1)
      const adressat = h.adressat || docAddresseeFallback;
      charts.adressat[adressat] = (charts.adressat[adressat] || 0) + 1;

      hits.push({
        docId: r.doc_id,
        title: r.title || r.doc_id,
        normType: r.norm_type || '',
        url: r.url || '',
        priority: hitPrio,
        confidence: r.confidence || '',
        unanimous: isUnanimous(r.confidence),
        needsReview: !!r.needs_review,
        legal: lShort,
        legalFull: r.legal_restrictions || 'Landesrecht (frei kürzbar)',
        category: cat,
        adressat,
        normstelle,
        beleg: h.paragraph || '',
        burden: h.burden || h.burden_type || '',
        proposed: h.proposed_change || '',
        risks: h.risks || '',
        relevance: hitRelevance,
        relief: h.relief_potential || r.relief_potential || '',
        grounded,
        secondCheck: scArr ? (scArr[hi] || null) : scDoc,
        endstatus: endstatus(hitPrio, scArr ? (scArr[hi] || null) : scDoc)
      });
    }

    // Doc-Level-Rollup für Top-KPIs/Chart: "hat dieses Dokument mindestens einen
    // A-würdigen Vorschlag?" — grobe Kennzahl zum Scannen, die Tabelle bleibt pro Vorschlag genau.
    const docPrio = rated && bestHitPrio ? bestHitPrio : 'nicht bewertet';
    if (docPrio === 'A') kpi.prioA++;
    else if (docPrio === 'B') kpi.prioB++;
    else if (docPrio === 'C') kpi.prioC++;
    else kpi.notRated++;
    if (charts.priority[docPrio] != null) charts.priority[docPrio]++;
    if (r.needs_review) kpi.needsReview++;
    if (lShort === 'Landesrecht' && (docPrio === 'A' || docPrio === 'B')) kpi.landesrechtFrei++;
  }

  // Kategorien als sortiertes Array
  const categories = Object.entries(charts.categories)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  handle.close();
  res.json({ kpi, charts: { ...charts, categories }, hits, run: req.query.run || null });
});

// CSV-Export (eine Zeile pro Belegstelle) — gleiche Quelle wie das Dashboard
router.get('/export/csv', (req, res) => {
  let handle;
  try { handle = resolveRunDb(req.query.run); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const db = handle.db;
  const scCol = hasCol(db, 'analyses', 'second_check') ? 'a.second_check' : 'NULL AS second_check';
  const rows = db.prepare(`
    SELECT a.doc_id, a.priority, a.description, a.confidence, a.needs_review,
           a.legal_restrictions, a.business_relevance, a.model, ${scCol}, d.title, d.norm_type, d.url, d.text
    FROM analyses a JOIN documents d ON d.doc_id = a.doc_id
    WHERE a.analyzed_at >= d.downloaded_at AND a.priority IN ('A','B','C')
    ORDER BY a.priority, a.doc_id
  `).all();

  const esc = v => {
    const s = String(v == null ? '' : v);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['Gesetz', 'Normtyp', 'Normstelle', 'Belegstelle', 'Pflichttyp', 'Adressat', 'Belegtext',
    'Aenderungsvorschlag', 'Risiko', 'Prioritaet', 'ensemble_votes',
    'beleg_sicherheit', 'rechtlich_gebunden', 'human_review',
    'Zweitcheck', 'Zweitcheck_Begruendung', 'Endstatus', 'URL', 'Modell'];
  const lines = [header.join(';')];

  for (const r of rows) {
    const lShort = legalShort(r.legal_restrictions);
    const nm = buildNormMap(r.text || '');
    const docAddresseeFallback = classifyAddressee(r.title, r.text);
    const scParsed = parseSecondCheck(r.second_check);
    const scArr = Array.isArray(scParsed) ? scParsed : null;
    const scDoc = (scParsed && !Array.isArray(scParsed)) ? scParsed : null;
    const dHits = parseHits(r.description);
    for (let hi = 0; hi < dHits.length; hi++) {
      const h = dHits[hi];
      const v = scArr ? scArr[hi] : scDoc;
      const prio = reformPriority(lShort, h.business_relevance || r.business_relevance || '');
      lines.push([
        r.title, r.norm_type, resolveNorm(h.paragraph, r.text || '', nm), h.paragraph, h.category,
        h.adressat || docAddresseeFallback,
        h.burden || h.burden_type || '', h.proposed_change || '', h.risks || '',
        prio, r.confidence || '',
        isGrounded(h.paragraph, r.text) ? 'hoch' : 'niedrig',
        legalDisplay(r.legal_restrictions), r.needs_review ? 'JA' : 'nein',
        v ? v.empfehlung || '' : '', v ? v.begruendung || '' : '',
        endstatus(prio, v),
        r.url || '', r.model || ''
      ].map(esc).join(';'));
    }
  }

  handle.close();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=buerokratie-belegstellen.csv');
  res.send('﻿' + lines.join('\n'));
});

module.exports = router;
