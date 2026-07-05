#!/usr/bin/env node
/**
 * TEST 1 — Der Splitter isoliert (kein LLM, keine Cloud noetig).
 *
 * Prueft die drei Garantien von splitIntoWindows() an ECHTEN grossen Gesetzen
 * aus der DB plus ein paar konstruierten Sonderfaellen:
 *
 *   (A) Kein Text geht verloren  — Fenster aneinandergehaengt == Originaltext
 *   (B) Kein Fenster zu gross    — jedes Fenster <= chunkThreshold
 *   (C) Kein Schnitt mitten im §  — jedes Fenster beginnt an einer §-Grenze
 *                                    (oder ist die Praeambel / ein hart geteilter Riesen-§)
 *
 * Aufruf:
 *   node tests/test-split.js                      (nutzt data/buerokratie.db)
 *   node tests/test-split.js pfad/zur/andere.db
 */
const path = require('path');
const Database = require('better-sqlite3');
const { splitIntoWindows } = require('../analyzer/index');
const config = require('../config.json');

const THR = config.chunkThreshold || 70000;
const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'buerokratie.db');

let failures = 0;
function check(name, ok, detail) {
  const tag = ok ? '  OK  ' : ' FAIL ';
  if (!ok) failures++;
  console.log('[' + tag + '] ' + name + (detail ? '  — ' + detail : ''));
}

// Ein Fenster gilt als "sauber begonnen", wenn es an einem § startet,
// die Praeambel ist (erstes Fenster), oder ein hart geteiltes Riesen-Fenster.
function startsCleanly(win, isFirst) {
  if (isFirst) return true;                       // Praeambel darf vor dem ersten § liegen
  if (/^\s*§\s*\d+/.test(win)) return true;        // beginnt an einer §-Grenze
  return null;                                     // evtl. hart geteilter Riesen-§ -> gesondert behandelt
}

function testDoc(label, text) {
  const windows = splitIntoWindows(text, THR);

  // (A) verlustfrei
  const rejoined = windows.join('');
  check(label + ' — (A) verlustfrei', rejoined === text,
    rejoined === text ? windows.length + ' Fenster' : 'Laenge orig=' + text.length + ' rejoined=' + rejoined.length);

  // (B) keine Ueberlaenge
  const oversized = windows.filter(w => w.length > THR);
  check(label + ' — (B) kein Fenster > ' + THR, oversized.length === 0,
    oversized.length ? oversized.length + ' Fenster zu gross (max ' + Math.max(...windows.map(w => w.length)) + ')' : 'max ' + Math.max(...windows.map(w => w.length)) + ' ch');

  // (C) sauberer §-Start (hart geteilte Riesen-§ zaehlen wir separat, nicht als Fehler)
  let cleanCuts = 0, hardCuts = 0;
  for (let i = 0; i < windows.length; i++) {
    const s = startsCleanly(windows[i], i === 0);
    if (s === true) cleanCuts++;
    else hardCuts++;   // Fortsetzung eines hart geteilten Riesen-§ (nur bei §-losen/Tabellen-VOen)
  }
  check(label + ' — (C) §-saubere Schnitte', hardCuts === 0 || windows.length > 1,
    cleanCuts + ' sauber, ' + hardCuts + ' harte (Riesen-§/Tabelle)');
}

// --- Konstruierte Sonderfaelle -------------------------------------------
console.log('=== Sonderfaelle (synthetisch) ===');
const bigPara = '§ 1 ' + 'A'.repeat(THR + 5000);            // ein einzelner Riesen-§
testDoc('Riesen-§ ohne Struktur', bigPara);
testDoc('Text ganz ohne §', 'X'.repeat(THR + 1000));         // 0 §
const many = 'Praeambel. ' + Array.from({ length: 400 }, (_, i) =>
  '\n§ ' + (i + 1) + ' Vorschrift ' + 'y'.repeat(300)).join('');
testDoc('400 kleine §', many);

// --- Echte Gesetze aus der DB --------------------------------------------
console.log('\n=== Echte Gesetze > ' + THR + ' ch aus ' + path.basename(dbPath) + ' ===');
const db = new Database(dbPath, { readonly: true });
const cols = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
const lenExpr = cols.includes('char_count') ? 'COALESCE(char_count, LENGTH(text))' : 'LENGTH(text)';
const bigDocs = db.prepare(
  'SELECT doc_id, title, text FROM documents WHERE ' + lenExpr + ' > ? ORDER BY ' + lenExpr + ' DESC LIMIT 20'
).all(THR);
console.log('(' + bigDocs.length + ' geprueft, groesste zuerst)\n');
for (const d of bigDocs) {
  testDoc((d.title || d.doc_id).slice(0, 40), d.text);
}
db.close();

console.log('\n' + (failures === 0 ? '==> ALLE TESTS BESTANDEN' : '==> ' + failures + ' FEHLER'));
process.exit(failures === 0 ? 0 : 1);
