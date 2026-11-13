#!/usr/bin/env node
/**
 * TEST 4 — Normstellen-Aufloesung (kein LLM noetig).
 *
 * resolveNorm() soll zu einem Zitat die RICHTIGE Fundstelle liefern
 * ("§ 3 Abs. 1", "Art. 28 Abs. 3", "Anlage 2") — nicht irgendeine.
 *
 *   Teil 1: konstruierte Faelle (Inhaltsuebersicht, Verweise, Anlage, gekuerzte Zitate)
 *   Teil 2: Messung am echten Korpus gegen eine UNABHAENGIG ermittelte Wahrheit.
 *           Wahrheit = zeilenweiser Durchlauf durch den Gesetzestext (anderer Algorithmus
 *           als resolveNorm): aktuelle Ueberschrift und aktueller Absatz werden mitgefuehrt.
 *           Als "Zitate" dienen zufaellige, im Text eindeutige Saetze.
 *
 * Hintergrund: Die fruehere Fassung nahm "das letzte §-Zeichen vor der Fundstelle". Das
 * griff Verweise ("§ 35 BauGB") und kannte kein "Art." — gemessen 56 % richtig bei
 * Verordnungen, 0,4 % bei Gesetzen. Niemand hatte es bemerkt, weil nur geprueft wurde,
 * OB eine Normstelle da ist (Abdeckung), nicht ob sie STIMMT (Korrektheit).
 *
 * Aufruf:
 *   node tests/test-normstelle.js                    (nutzt data/buerokratie.db)
 *   node tests/test-normstelle.js pfad/zur/andere.db
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { findHeadings, buildNormMap, resolveNorm } = require('../classify');

const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'buerokratie.db');
const MIN_ACCURACY = 0.99; // Schwelle fuer Teil 2 (gemessen: 99,8 %)

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('[' + (ok ? '  OK  ' : ' FAIL ') + '] ' + name + (detail ? '  — ' + detail : ''));
}

// --- Teil 1: konstruierte Faelle -------------------------------------------
console.log('=== Teil 1: konstruierte Faelle ===');
const T = [
  'Mustergesetz (MuG) vom 1. Januar 2020',
  '',
  'Vollzitat: Mustergesetz, zuletzt durch § 2 des Gesetzes vom 23. April 2026 geändert',
  '',
  'Erster Teil Allgemeines',
  '',
  'Art. 1 Anwendungsbereich',
  '',
  'Art. 2 Anzeigepflichten der Betreiber',
  '',
  'Art. 1',
  '               Anwendungsbereich',
  '',
  '(1) 1Dieses Gesetz gilt für alle gewerblichen Anlagen im Freistaat. 2Es gilt nicht für Anlagen des Bundes.',
  '',
  '(2) Die zuständige Behörde kann im Einzelfall Ausnahmen von den Anforderungen zulassen.',
  '',
  'Art. 2',
  '               Anzeigepflichten der Betreiber',
  '',
  '(1) 1Der Betreiber hat die Aufnahme des Betriebs der Kreisverwaltungsbehörde schriftlich anzuzeigen.',
  '',
  '§ 35 BauGB gilt für diese Anzeige entsprechend und bleibt im Übrigen unberührt.',
  '',
  '(2) 1Der Anzeige sind beglaubigte Kopien der Befähigungsnachweise in dreifacher Ausfertigung beizufügen.',
  '',
  'Zweiter Teil Schluss',
  '',
  'Art. 3 Inkrafttreten',
  '',
  'Art. 3',
  '               Inkrafttreten',
  '',
  '1Dieses Gesetz tritt am 1. Januar 2020 in Kraft und ersetzt die bisherige Regelung vollständig.',
  '',
  'Anlage 1',
  '',
  'Verzeichnis der anzeigepflichtigen Anlagenarten nach Art. 2 mit den jeweiligen Schwellenwerten',
  ''
].join('\n');
const nm = buildNormMap(T);
const heads = findHeadings(T).map(h => h.label);
check('findHeadings: nur echte Ueberschriften (keine Inhaltsuebersicht, kein Verweis)',
  JSON.stringify(heads) === JSON.stringify(['Art. 1', 'Art. 2', 'Art. 3', 'Anlage 1']), heads.join(', '));

const cases = [
  ['Satz in Art. 1 Abs. 1', 'Es gilt nicht für Anlagen des Bundes.', 'Art. 1 Abs. 1'],
  ['Satz in Art. 1 Abs. 2', 'Die zuständige Behörde kann im Einzelfall Ausnahmen von den Anforderungen zulassen.', 'Art. 1 Abs. 2'],
  ['Zitat beginnt mit eigenem Absatz-Marker', '(2) 1Der Anzeige sind beglaubigte Kopien der Befähigungsnachweise', 'Art. 2 Abs. 2'],
  ['Verweis "§ 35 BauGB" am Zeilenanfang ist keine Fundstelle', 'gilt für diese Anzeige entsprechend und bleibt im Übrigen unberührt', 'Art. 2 Abs. 1'],
  ['Satz nach dem Verweis bleibt in Art. 2', 'Der Anzeige sind beglaubigte Kopien der Befähigungsnachweise in dreifacher Ausfertigung beizufügen.', 'Art. 2 Abs. 2'],
  ['Zitat = Ueberschrift samt Titel (steht auch in der Inhaltsuebersicht)', 'Art. 2 Anzeigepflichten der Betreiber', 'Art. 2'],
  ['Modell stellt Normangabe voran (nicht woertlich)', 'Art. 2 Abs. 1: Der Betreiber hat die Aufnahme des Betriebs der Kreisverwaltungsbehörde schriftlich anzuzeigen.', 'Art. 2 Abs. 1'],
  ['Gekuerztes Zitat mit Auslassung', 'Der Betreiber hat die Aufnahme des Betriebs … schriftlich anzuzeigen und beglaubigte Kopien der Befähigungsnachweise in dreifacher Ausfertigung', 'Art. 2 Abs. 1'],
  ['Artikel ohne Absatz-Gliederung', 'tritt am 1. Januar 2020 in Kraft und ersetzt die bisherige Regelung', 'Art. 3'],
  ['Zitat aus der Anlage', 'Verzeichnis der anzeigepflichtigen Anlagenarten nach Art. 2 mit den jeweiligen Schwellenwerten', 'Anlage 1'],
  ['Zitat aus der Praeambel -> keine geratene Normstelle', 'zuletzt durch § 2 des Gesetzes vom 23. April 2026 geändert', ''],
  ['Nicht im Text -> leer', 'Dieser Satz kommt im ganzen Gesetz an keiner einzigen Stelle vor.', '']
];
for (const [name, quote, expected] of cases) {
  const got = resolveNorm(quote, T, nm);
  check(name, got === expected, 'erwartet "' + expected + '", bekommen "' + got + '"');
}

// --- Teil 2: Messung am Korpus ----------------------------------------------
// Unabhaengige Wahrheit: Zeilen-Durchlauf.
function truthMap(text) {
  const marks = [];
  let pos = 0, head = '', abs = '';
  for (const line of text.split('\n')) {
    let m;
    if ((m = /^[ \t]*(Art\.|§)[ \t ]*(\d+[a-z]?)[ \t]*$/.exec(line))) { head = m[1] + ' ' + m[2]; abs = ''; marks.push([pos, head, abs]); }
    else if ((m = /^[ \t]*Anlagen?(?:[ \t]+(\d+(?:\.\d+)*[a-z]?))?[ \t]*($|:|\(zu\b|zu\b)/.exec(line))) { head = 'Anlage' + (m[1] ? ' ' + m[1] : ''); abs = ''; marks.push([pos, head, abs]); }
    else if (head && !head.startsWith('Anlage') && (m = /^[ \t]*\((\d+[a-z]?)\)/.exec(line))) { abs = m[1]; marks.push([pos, head, abs]); }
    pos += line.length + 1;
  }
  return p => {
    let cur = null;
    for (const k of marks) { if (k[0] <= p) cur = k; else break; }
    return cur ? (cur[2] ? cur[1] + ' Abs. ' + cur[2] : cur[1]) : '';
  };
}

if (!fs.existsSync(dbPath)) {
  console.log('\n(DB nicht gefunden: ' + dbPath + ' — Teil 2 uebersprungen)');
} else {
  console.log('\n=== Teil 2: Messung am Korpus (' + path.basename(dbPath) + ') ===');
  const db = new Database(dbPath, { readonly: true });
  const docs = db.prepare('SELECT doc_id, norm_type, text FROM documents WHERE text IS NOT NULL AND LENGTH(text) > 3000').all();
  db.close();
  let seed = 42; // fester Startwert -> jeder Lauf prueft dieselben Zitate (reproduzierbar)
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const stat = { gesetz: { n: 0, ok: 0, okAbs: 0 }, rechtsverordnung: { n: 0, ok: 0, okAbs: 0 } };
  const wrong = [];
  for (const d of docs) {
    const s = stat[d.norm_type]; if (!s) continue;
    const tm = truthMap(d.text);
    const dnm = buildNormMap(d.text);
    for (let k = 0; k < 6; k++) {
      const p = Math.floor(rnd() * (d.text.length - 400));
      const at = d.text.indexOf('. ', p);
      if (at < 0) continue;
      const quote = d.text.slice(at + 2, at + 2 + 110);
      if (/\n[ \t]*(Art\.|§|Anlage)/.test(quote)) continue;              // nicht ueber eine Ueberschrift hinweg
      if (quote.replace(/[^a-zäöüß0-9]/gi, '').length < 40) continue;     // zu wenig Substanz (Tabellenrest, Leerraum)
      const anchor = quote.slice(0, 60);
      if (d.text.indexOf(anchor) !== at + 2 || d.text.indexOf(anchor, at + 3) >= 0) continue; // nur eindeutige Stellen
      const truth = tm(at + 2);
      if (!truth) continue;                                                // Praeambel: keine Normstelle erwartet
      const got = resolveNorm(quote, d.text, dnm);
      s.n++;
      if (got.split(' Abs.')[0] === truth.split(' Abs.')[0]) s.ok++;
      else if (wrong.length < 10) wrong.push(d.doc_id + ': wahr "' + truth + '", bekommen "' + got + '" | ' + JSON.stringify(quote.slice(0, 50)));
      if (got === truth) s.okAbs++;
    }
  }
  for (const [type, s] of Object.entries(stat)) {
    const acc = s.n ? s.ok / s.n : 0;
    check(type + ': richtige Ueberschrift bei >= ' + (MIN_ACCURACY * 100) + ' % der Zitate', s.n > 100 && acc >= MIN_ACCURACY,
      s.ok + ' von ' + s.n + ' (' + (acc * 100).toFixed(1) + ' %), inkl. Absatz ' + (s.n ? (100 * s.okAbs / s.n).toFixed(1) : '0') + ' %');
  }
  if (wrong.length) console.log('Abweichungen (Auszug):\n  ' + wrong.join('\n  '));
}

console.log('\n' + (failures === 0 ? '==> ALLE TESTS BESTANDEN' : '==> ' + failures + ' FEHLER'));
process.exit(failures === 0 ? 0 : 1);
