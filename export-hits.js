const { getDb } = require('./db');
const {
  classifyAddressee, legalDisplay, reformPriority,
  isGrounded, buildNormMap, resolveNorm, endstatus
} = require('./classify');

function escapeCsv(val) {
  const s = String(val == null ? '' : val);
  if (s.includes(';') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const db = getDb();

const hasSC = (() => {
  try { return db.prepare('PRAGMA table_info(analyses)').all().some(c => c.name === 'second_check'); }
  catch { return false; }
})();
const scCol = hasSC ? 'a.second_check' : 'NULL AS second_check';

const rows = db.prepare(`
  SELECT a.doc_id, a.priority, a.description, a.confidence, a.needs_review,
         a.legal_restrictions, a.business_relevance, a.model, ${scCol},
         d.title, d.norm_type, d.url, d.text
  FROM analyses a
  JOIN documents d ON d.doc_id = a.doc_id
  WHERE a.priority IN ('A', 'B', 'C')
    AND a.analyzed_at >= d.downloaded_at
  ORDER BY a.priority, a.doc_id
`).all();

const header = [
  'Gesetz', 'Normtyp', 'Normstelle', 'Belegstelle', 'Pflichttyp', 'Adressat', 'Belegtext',
  'Aenderungsvorschlag', 'Risiko', 'Prioritaet', 'ensemble_votes',
  'beleg_sicherheit', 'rechtlich_gebunden', 'human_review',
  'Zweitcheck', 'Zweitcheck_Begruendung', 'Endstatus', 'URL', 'Modell'
];

const out = ['﻿' + header.join(';')];

for (const row of rows) {
  const hits = JSON.parse(row.description || '[]');
  const nm = buildNormMap(row.text || '');
  const docAddresseeFallback = classifyAddressee(row.title, row.text);
  let scParsed = null;
  try { scParsed = JSON.parse(row.second_check || 'null'); } catch { /* leer */ }
  const scArr = Array.isArray(scParsed) ? scParsed : null;
  const scDoc = (scParsed && !Array.isArray(scParsed)) ? scParsed : null;
  for (let hi = 0; hi < hits.length; hi++) {
    const hit = hits[hi];
    const v = scArr ? scArr[hi] : scDoc;
    const scEmp = v ? v.empfehlung || '' : '';
    const scBeg = v ? v.begruendung || '' : '';
    // Pro-Vorschlag-Prioritaet: business_relevance ist schon je Belegstelle vom
    // Ensemble berechnet (nicht auf den Doc-Schnitt glaetten).
    const prio = reformPriority(row.legal_restrictions, hit.business_relevance || row.business_relevance || '');
    const fields = [
      row.title || row.doc_id,
      row.norm_type || '',
      resolveNorm(hit.paragraph, row.text || '', nm),
      hit.paragraph || '',
      hit.category || '',
      hit.adressat || docAddresseeFallback,
      hit.burden || hit.burden_type || '',
      hit.proposed_change || '',
      hit.risks || '',
      prio,
      row.confidence || '',
      isGrounded(hit.paragraph, row.text) ? 'hoch' : 'niedrig',
      legalDisplay(row.legal_restrictions),
      row.needs_review ? 'JA' : 'nein',
      scEmp,
      scBeg,
      endstatus(prio, v),
      row.url || '',
      // row.model = das Modell, das DIESE Analyse gemacht hat (nicht config.model,
      // das nur den aktuellen Config-Stand widerspiegelt — bei Run-DB-Exporten falsch)
      row.model || ''
    ];
    out.push(fields.map(escapeCsv).join(';'));
  }
}

const outPath = require('path').join(__dirname, 'data', 'export-hits.csv');
require('fs').writeFileSync(outPath, out.join('\n'), 'utf8');
console.log(`Export: ${rows.length} Dokumente, ${out.length - 1} Zeilen -> ${outPath}`);
