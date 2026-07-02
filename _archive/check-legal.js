const {getDb} = require('./db');
const db = getDb();

const docs = db.prepare(`
  SELECT doc_id, priority, category, business_relevance, confidence, needs_review,
         substr(legal_restrictions,1,120) as legal
  FROM analyses
  WHERE category != 'sonstiges' OR (legal_restrictions IS NOT NULL AND legal_restrictions != '')
  ORDER BY doc_id
`).all();

console.log('=== Ergebnisse + legal_restrictions ===');
console.log('Treffer:', docs.filter(d => d.category != 'sonstiges').length, '| Nicht-leere legal:', docs.filter(d => d.legal).length);
console.log('');
for (const d of docs) {
  console.log('[' + d.confidence + '][' + (d.needs_review ? 'REVIEW' : 'AUTO') + '] ' + d.doc_id + ' ' + d.priority + '/' + d.category + '/' + d.business_relevance);
  if (d.legal) console.log('  legal: ' + d.legal);
}
