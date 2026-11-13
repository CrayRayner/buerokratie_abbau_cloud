#!/usr/bin/env node
/**
 * TEST 3 — Ausfall-Behandlung (kein LLM, keine DB noetig).
 *
 * Prueft die Regel "ein Ausfall darf nie wie ein Ergebnis aussehen" (fail-closed):
 *
 *   (A) ensembleOutcome  — wann traegt ein Ensemble eine Entscheidung, wann nicht?
 *   (B) aggregateEnsemble — unentschiedene Ensembles liefern { incomplete: true }
 *                           statt eines Negativbefunds
 *   (C) isFailedAnalysisRow — Altlasten (Totalausfall als "kein Befund" gespeichert)
 *                           werden erkannt, echte Negativbefunde NICHT angefasst
 *   (D) isFatalError     — nur systemische Fehler brechen den Lauf sofort ab
 *
 * Aufruf:  node tests/test-outcome.js
 */
const {
  ensembleOutcome, aggregateEnsemble, isFailedAnalysisRow, isFatalError
} = require('../analyzer/index');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('[' + (ok ? '  OK  ' : ' FAIL ') + '] ' + name + (detail ? '  — ' + detail : ''));
}

const HIT = { hits: [{ paragraph: 'x' }], summary: '' };   // Lauf meldet Treffer
const NONE = { hits: [], summary: 'nichts' };              // Lauf meldet: geprueft, nichts gefunden
const FAIL = null;                                         // Lauf ausgefallen

// --- (A) ensembleOutcome bei 3 Laeufen (Mehrheit = 2) ---
const cases3 = [
  // [Laeufe,               erwartet,      Erklaerung]
  [[HIT, HIT, HIT],         'hits',        'einstimmig Treffer'],
  [[HIT, HIT, NONE],        'hits',        'Mehrheit Treffer'],
  [[HIT, NONE, NONE],       'none',        'Mehrheit nichts (unveraendert zum alten Verhalten)'],
  [[NONE, NONE, NONE],      'none',        'einstimmig nichts'],
  [[HIT, HIT, FAIL],        'hits',        '2 Treffer reichen trotz Ausfall'],
  [[NONE, NONE, FAIL],      'none',        '2x nichts: der Ausfall haette es nicht mehr kippen koennen'],
  [[HIT, NONE, FAIL],       'incomplete',  'Patt + Ausfall: der fehlende Lauf entscheidet'],
  [[HIT, FAIL, FAIL],       'incomplete',  '1 Treffer, 2 Ausfaelle'],
  [[NONE, FAIL, FAIL],      'incomplete',  '1x nichts, 2 Ausfaelle — frueher: Negativbefund'],
  [[FAIL, FAIL, FAIL],      'incomplete',  'Totalausfall — frueher: Negativbefund 0/3'],
];
for (const [runs, expected, why] of cases3) {
  const got = ensembleOutcome(runs.filter(Boolean), 3).outcome;
  check('(A) ' + why, got === expected, 'erwartet ' + expected + ', bekommen ' + got);
}

// Kaputte Antwort ohne hits-Array zaehlt wie ein Ausfall, nicht wie "nichts gefunden".
check('(A) Antwort ohne hits-Array = Ausfall',
  ensembleOutcome([{ summary: 'nur Text' }, NONE], 3).outcome === 'incomplete');

// Ohne Ausfaelle aendert sich NICHTS am Voting — auch nicht bei gerader Laufzahl.
check('(A) 2 Laeufe, 1:1 ohne Ausfall bleibt "none" (wie bisher)',
  ensembleOutcome([HIT, NONE], 2).outcome === 'none');
check('(A) 5 Laeufe, 3 Treffer = hits', ensembleOutcome([HIT, HIT, HIT, NONE, NONE], 5).outcome === 'hits');
check('(A) 5 Laeufe, 2 Treffer + 2 Ausfaelle = incomplete',
  ensembleOutcome([HIT, HIT, NONE], 5).outcome === 'incomplete');
check('(A) 5 Laeufe, 3x nichts + 2 Ausfaelle = none',
  ensembleOutcome([NONE, NONE, NONE], 5).outcome === 'none');

// --- (B) aggregateEnsemble ---
const aggFail = aggregateEnsemble([], 3, 'Text');
check('(B) Totalausfall -> incomplete, kein Negativbefund',
  aggFail.incomplete === true && aggFail.failedRuns === 3 && !('summary' in aggFail));
const aggNone = aggregateEnsemble([NONE, NONE, NONE], 3, 'Text');
check('(B) echter Negativbefund bleibt Negativbefund',
  !aggNone.incomplete && aggNone.decided === false && aggNone.confidence === '0/3');
const aggTie = aggregateEnsemble([HIT, NONE], 3, 'Text');
check('(B) Patt + Ausfall -> incomplete', aggTie.incomplete === true && aggTie.failedRuns === 1);

// --- (C) isFailedAnalysisRow ---
check('(C) [null,null,null] = Altlast', isFailedAnalysisRow('[]', '[null,null,null]') === true);
check('(C) 6x null (gechunktes Doc) = Altlast', isFailedAnalysisRow('[]', '[null,null,null,null,null,null]') === true);
check('(C) ERROR-Zeile = Altlast', isFailedAnalysisRow('ERROR: timeout', 'timeout') === true);
check('(C) echter Negativbefund wird NICHT angefasst',
  isFailedAnalysisRow('[]', JSON.stringify([NONE, NONE, NONE])) === false);
check('(C) Teilausfall wird NICHT angefasst (nur eindeutiger Totalausfall)',
  isFailedAnalysisRow('[]', JSON.stringify([null, NONE, NONE])) === false);
check('(C) unlesbares raw_response wird NICHT angefasst', isFailedAnalysisRow('[]', 'kein json') === false);
check('(C) leeres/fehlendes raw_response wird NICHT angefasst',
  isFailedAnalysisRow('[]', null) === false && isFailedAnalysisRow('[]', '[]') === false);

// --- (D) isFatalError ---
check('(D) fehlender API-Key = fatal', isFatalError('OPENROUTER_API_KEY fehlt — .env anlegen') === true);
check('(D) HTTP 401 (Key ungueltig) = fatal', isFatalError('OpenRouter HTTP 401: No auth credentials') === true);
check('(D) HTTP 402 (Guthaben leer) = fatal', isFatalError('OpenRouter HTTP 402: Insufficient credits') === true);
check('(D) HTTP 403 (kann doc-spezifisch sein) = nicht fatal', isFatalError('OpenRouter HTTP 403: flagged') === false);
check('(D) HTTP 429/5xx = nicht fatal', !isFatalError('OpenRouter HTTP 429: rate') && !isFatalError('OpenRouter HTTP 502: bad gateway'));
check('(D) Timeout = nicht fatal', isFatalError('LM Studio timeout for BayBO (1200s)') === false);
check('(D) JSON-Fehler = nicht fatal', isFatalError('JSON parse error: Unexpected token') === false);

console.log('\n==> ' + (failures ? failures + ' FEHLER' : 'ALLE TESTS BESTANDEN'));
process.exit(failures ? 1 : 0);
