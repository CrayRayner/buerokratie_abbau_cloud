#!/usr/bin/env node
/**
 * TEST 2 — Chunking-Gesundheitscheck auf echten Analyse-Ergebnissen.
 *
 * Fuer jedes grosse Gesetz, das gechunkt UND analysiert wurde, prueft es:
 *
 *   1. Grounding    — jede Belegstelle steht wortwoertlich im Volltext (0 halluziniert)
 *   2. Deduplizierung — keine Belegstelle taucht doppelt auf (Merge ueber Fenster sauber)
 *   3. Abdeckung    — die Treffer verteilen sich ueber MEHRERE Fenster
 *                     (beweist, dass das Chunking wirkt: spaetere Fenster liefern Treffer,
 *                      die ein reiner 70k-Schnitt verloren haette)
 *
 * Jeder Treffer wird per isGrounded() dem/den Fenster(n) zugeordnet, in dem seine
 * Belegstelle tatsaechlich vorkommt — also mit derselben Logik, die auch die Pipeline nutzt.
 *
 * Aufruf:
 *   node tests/test-chunking.js                    (nutzt data/buerokratie.db)
 *   node tests/test-chunking.js pfad/zur/andere.db
 */
const path = require('path');
const Database = require('better-sqlite3');
const { splitIntoWindows } = require('../analyzer/index');
const { parseHits, isGrounded } = require('../classify');
const config = require('../config.json');

const THR = config.chunkThreshold || 70000;
const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'buerokratie.db');

const db = new Database(dbPath, { readonly: true });
const cols = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
const lenExpr = cols.includes('char_count') ? 'COALESCE(d.char_count, LENGTH(d.text))' : 'LENGTH(d.text)';

const rows = db.prepare(
  'SELECT d.doc_id, d.title, d.text, ' + lenExpr + ' AS n, a.priority, a.description, a.confidence, a.model ' +
  'FROM documents d JOIN analyses a ON a.doc_id = d.doc_id ' +
  'WHERE ' + lenExpr + ' > ? AND a.analyzed_at >= d.downloaded_at ORDER BY n DESC'
).all(THR);

console.log('=== CHUNKING-CHECK: ' + path.basename(dbPath) + ' (Schwelle ' + THR + ' ch) ===\n');

let totHits = 0, totUngrounded = 0, totDupes = 0, docsWithHits = 0, multiWindowDocs = 0, problems = 0;

for (const r of rows) {
  const hits = parseHits(r.description);
  const windows = splitIntoWindows(r.text, THR);

  if (hits.length === 0) {
    console.log('· ' + (r.title || r.doc_id).slice(0, 55) + '  (' + r.n + ' ch, ' + windows.length + ' Fenster) — keine Treffer, conf ' + (r.confidence || '?'));
    continue;
  }
  docsWithHits++;

  // Grounding + Dedup
  let ung = 0, dupes = 0;
  const seen = new Set();
  const perWindow = new Array(windows.length).fill(0);
  for (const h of hits) {
    if (!isGrounded(h.paragraph, r.text)) ung++;
    const key = (h.paragraph || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (key) { if (seen.has(key)) dupes++; else seen.add(key); }
    // autoritative Fenster-Zuordnung: in welchem Fenster ist die Belegstelle grounded?
    for (let w = 0; w < windows.length; w++) {
      if (isGrounded(h.paragraph, windows[w])) { perWindow[w]++; break; }
    }
  }
  const windowsHit = perWindow.filter(c => c > 0).length;
  if (windowsHit > 1) multiWindowDocs++;

  totHits += hits.length; totUngrounded += ung; totDupes += dupes;
  const bad = ung > 0 || dupes > 0;
  if (bad) problems++;

  console.log((bad ? 'X ' : '■ ') + (r.title || r.doc_id).slice(0, 55));
  console.log('   ' + r.n + ' ch | ' + windows.length + ' Fenster | ' + r.priority + ' | conf ' + (r.confidence || '?') + ' | ' + (r.model || '?'));
  console.log('   Treffer ' + hits.length + '  |  ungrounded ' + ung + (ung ? ' <-- PROBLEM' : '') + '  |  Duplikate ' + dupes + (dupes ? ' <-- PROBLEM' : ''));
  console.log('   Treffer je Fenster: [' + perWindow.join(', ') + ']  -> ' + windowsHit + '/' + windows.length + ' Fenster liefern Treffer'
    + (windowsHit > 1 ? '  (Chunking wirkt)' : ''));
  console.log('');
}

db.close();

console.log('--- ZUSAMMENFASSUNG ---');
console.log('Gechunkte Docs analysiert:      ' + rows.length);
console.log('  davon mit Treffern:           ' + docsWithHits);
console.log('  davon Treffer in >1 Fenster:  ' + multiWindowDocs + '  (hier hat das Chunking echten Mehrwert geliefert)');
console.log('Treffer gesamt:                 ' + totHits);
console.log('Ungrounded (soll 0):            ' + totUngrounded);
console.log('Duplikate (soll 0):             ' + totDupes);
console.log('\n' + (problems === 0 ? '==> SAUBER: kein Grounding-/Dedup-Problem in gechunkten Docs' : '==> ' + problems + ' Doc(s) mit Problemen — siehe X oben'));
process.exit(problems === 0 ? 0 : 1);
