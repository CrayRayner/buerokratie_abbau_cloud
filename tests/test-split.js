#!/usr/bin/env node
/**
 * TEST 1 — Der Splitter isoliert (kein LLM, keine Cloud noetig).
 *
 * Prueft die drei Garantien von splitIntoWindows() an konstruierten Sonderfaellen
 * und an ALLEN grossen Normen aus der DB (Verordnungen UND Gesetze):
 *
 *   (A) Kein Text geht verloren  — Fenster aneinandergehaengt == Originaltext
 *   (B) Kein Fenster zu gross    — jedes Fenster <= chunkThreshold
 *   (C) Schnitte nur an Gliederungsgrenzen — an echten Ueberschriften (§ bei
 *       Verordnungen, Art. bei Gesetzen, Anlagen; findHeadings in classify.js).
 *       Einzige Ausnahme: eine Einheit, die ALLEIN schon groesser als die Schwelle
 *       ist (Riesen-Anlage, Tabellen-Verordnung). Die darf zusaetzlich geteilt
 *       werden — aber nur an Absatz-, Zeilen- oder Wortgrenze, nie mitten im Wort.
 *
 * Frueher zaehlte (C) jeden nicht-§-Schnitt als "Riesen-§/Tabelle" und winkte ihn durch.
 * Dadurch blieb unbemerkt, dass alle Art.-gegliederten Gesetze stumpf zerschnitten wurden.
 *
 * Aufruf:
 *   node tests/test-split.js                      (nutzt data/buerokratie.db)
 *   node tests/test-split.js pfad/zur/andere.db
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { splitIntoWindows } = require('../analyzer/index');
const { findHeadings } = require('../classify');
const config = require('../config.json');

const THR = config.chunkThreshold || 70000;
const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'buerokratie.db');

let failures = 0;
function check(name, ok, detail, quiet) {
  if (!ok) failures++;
  if (!ok || !quiet) console.log('[' + (ok ? '  OK  ' : ' FAIL ') + '] ' + name + (detail ? '  — ' + detail : ''));
  return ok;
}

// Schnitte eines Dokuments klassifizieren.
function analyzeCuts(text, windows) {
  const heads = findHeadings(text).map(h => h.index).filter(i => i > 0);
  const headSet = new Set(heads);
  const bounds = [0, ...heads, text.length];
  const r = { atHeading: 0, inOversized: 0, midWord: 0, unjustified: 0 };
  let off = 0;
  for (let i = 0; i < windows.length - 1; i++) {
    off += windows[i].length; // Position des Schnitts im Originaltext
    if (headSet.has(off)) { r.atHeading++; continue; }
    // Schnitt INNERHALB einer Einheit: nur zulaessig, wenn die Einheit allein > THR ist.
    let k = 0;
    while (k + 1 < bounds.length && bounds[k + 1] <= off) k++;
    if (bounds[k + 1] - bounds[k] <= THR) { r.unjustified++; continue; }
    r.inOversized++;
    if (!/\s/.test(text[off - 1])) r.midWord++;
  }
  return r;
}

function testDoc(label, text, opts) {
  const o = opts || {};
  const windows = splitIntoWindows(text, THR);
  const rejoined = windows.join('');
  const a = check(label + ' — (A) verlustfrei', rejoined === text,
    rejoined === text ? windows.length + ' Fenster' : 'Laenge orig=' + text.length + ' rejoined=' + rejoined.length, o.quiet);
  const maxLen = Math.max(...windows.map(w => w.length));
  const b = check(label + ' — (B) kein Fenster > ' + THR, maxLen <= THR, 'max ' + maxLen + ' ch', o.quiet);
  const c = analyzeCuts(text, windows);
  const okC = c.unjustified === 0 && (o.allowMidWord || c.midWord === 0);
  const cOk = check(label + ' — (C) Schnitte an Gliederungsgrenzen', okC,
    c.atHeading + ' an Ueberschrift, ' + c.inOversized + ' in Riesen-Einheit (davon ' + c.midWord + ' mitten im Wort), '
    + c.unjustified + ' ohne Grund', o.quiet);
  if (o.expectHeadingCuts) check(label + ' — schneidet tatsaechlich an Ueberschriften', c.atHeading > 0, c.atHeading + ' Schnitte', o.quiet);
  return { windows, cuts: c, ok: a && b && cOk };
}

// --- Konstruierte Sonderfaelle -------------------------------------------
console.log('=== Sonderfaelle (synthetisch) ===');
testDoc('Riesen-§ ohne jede Grenze', '§ 1 ' + 'A'.repeat(THR + 5000), { allowMidWord: true });
testDoc('Text ganz ohne Struktur', 'X'.repeat(THR + 1000), { allowMidWord: true });

const body = (kind, i) => '\n' + kind + ' ' + i + '\n               Vorschrift ' + i + '\n\n(1) 1' + 'y '.repeat(160) + '\n\n(2) 1' + 'z '.repeat(160) + '\n';
const vo = 'Verordnung XY\n\nAuf Grund von § 1 des Gesetzes\n' + Array.from({ length: 400 }, (_, i) => body('§', i + 1)).join('');
testDoc('Verordnung, 400 kleine §', vo, { expectHeadingCuts: true });

// Gesetz mit Inhaltsuebersicht ("Art. 1 Titel" in EINER Zeile = keine Grenze) und Verweisen
// am Zeilenanfang ("§ 35 BauGB gilt entsprechend") — beides darf keinen Schnitt ausloesen.
const toc = Array.from({ length: 400 }, (_, i) => 'Art. ' + (i + 1) + ' Vorschrift ' + (i + 1)).join('\n\n');
const law = 'Mustergesetz (MuG)\n\nErster Teil\n\n' + toc + '\n'
  + Array.from({ length: 400 }, (_, i) => body('Art.', i + 1) + '\n§ 35 BauGB gilt entsprechend.\n').join('');
const lawRes = testDoc('Gesetz mit Art.-Gliederung + Inhaltsuebersicht', law, { expectHeadingCuts: true });
check('Gesetz — jedes Folgefenster beginnt mit einer echten Art.-Ueberschrift',
  lawRes.windows.slice(1).every(w => /^Art\. \d+\n/.test(w)));

// Riesen-Anlage (Tabelle): groesser als die Schwelle -> Teilung an Zeilengrenze, nie im Wort.
const annex = '§ 1\n               Zweck\n\n(1) Text.\n\nAnlage 1\n\n'
  + Array.from({ length: 6000 }, (_, i) => 'Gebiet ' + i + ' | Kennziffer DE' + (100000 + i) + ' | Landkreis').join('\n');
const annexRes = testDoc('Riesen-Anlage mit Tabellenzeilen', annex);
check('Riesen-Anlage — wurde innerhalb der Anlage an Zeilengrenzen geteilt', annexRes.cuts.inOversized > 0 && annexRes.cuts.midWord === 0);

// --- Echte Normen aus der DB ----------------------------------------------
if (!fs.existsSync(dbPath)) {
  console.log('\n(DB nicht gefunden: ' + dbPath + ' — Korpus-Teil uebersprungen)');
} else {
  const db = new Database(dbPath, { readonly: true });
  const big = db.prepare('SELECT doc_id, norm_type, text FROM documents WHERE text IS NOT NULL AND LENGTH(text) > ? ORDER BY LENGTH(text) DESC').all(THR);
  db.close();
  console.log('\n=== Alle Normen > ' + THR + ' ch aus ' + path.basename(dbPath) + ' (' + big.length + ' Stueck, nur Fehler werden einzeln gelistet) ===');
  const sum = { docs: 0, ok: 0, windows: 0, atHeading: 0, inOversized: 0, midWord: 0, gesetze: 0 };
  const oversizedDocs = [];
  for (const d of big) {
    const r = testDoc(d.doc_id, d.text, { quiet: true });
    sum.docs++; if (r.ok) sum.ok++;
    if (d.norm_type === 'gesetz') sum.gesetze++;
    sum.windows += r.windows.length; sum.atHeading += r.cuts.atHeading; sum.inOversized += r.cuts.inOversized; sum.midWord += r.cuts.midWord;
    if (r.cuts.inOversized) oversizedDocs.push(d.doc_id + ' (' + r.cuts.inOversized + ')');
  }
  console.log(sum.ok + ' von ' + sum.docs + ' Normen bestehen A+B+C (davon ' + sum.gesetze + ' Gesetze) | ' + sum.windows + ' Fenster');
  console.log('Schnitte: ' + sum.atHeading + ' an Ueberschriften, ' + sum.inOversized + ' in Riesen-Einheiten (davon ' + sum.midWord + ' mitten im Wort)');
  if (oversizedDocs.length) console.log('Normen mit Riesen-Einheit (Anlage/Tabelle > ' + THR + '): ' + oversizedDocs.join(', '));
}

console.log('\n' + (failures === 0 ? '==> ALLE TESTS BESTANDEN' : '==> ' + failures + ' FEHLER'));
process.exit(failures === 0 ? 0 : 1);
