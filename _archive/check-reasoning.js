const {getDb} = require('./db');
const db = getDb();

const total = db.prepare('SELECT COUNT(*) c FROM analyses').get().c;
const errors = db.prepare("SELECT COUNT(*) c FROM analyses WHERE description LIKE 'ERROR:%'").get().c;
const empty = db.prepare("SELECT category, COUNT(*) c FROM analyses WHERE category = 'sonstiges' GROUP BY category").get();
const rel = db.prepare("SELECT business_relevance, COUNT(*) c FROM analyses GROUP BY business_relevance").all();
const prio = db.prepare("SELECT priority, COUNT(*) c FROM analyses GROUP BY priority").all();
const cats = db.prepare("SELECT category, COUNT(*) c FROM analyses WHERE category != 'sonstiges' GROUP BY category ORDER BY c DESC").all();

console.log('=== Basis ===');
console.log('Total:', total, 'Errors:', errors, 'Empty:', empty ? empty.c : 0);
console.log('Business:', rel.map(r => r.business_relevance + ':' + r.c).join(', '));
console.log('Priority:', prio.map(r => r.priority + ':' + r.c).join(', '));
console.log('Categories:', cats.map(c => c.category + ':' + c.c).join(', '));

// Check the new fields
const hasFields = db.prepare(`
  SELECT doc_id, relief_potential, baymog_suitability,
         substr(proposed_change,1,80) as pc, substr(risks,1,80) as rk
  FROM analyses WHERE category != 'sonstiges' AND proposed_change != ''
  LIMIT 10
`).all();
console.log('\n=== New fields (relief_potential, baymog, proposed_change, risks) ===');
for (const r of hasFields) {
  console.log(r.doc_id + ' | rel:' + r.relief_potential + ' baymog:' + r.baymog_suitability);
  console.log('  propose: ' + r.pc);
  console.log('  risks: ' + r.rk);
}
const filledPC = db.prepare("SELECT COUNT(*) c FROM analyses WHERE proposed_change != '' AND proposed_change IS NOT NULL").get().c;
const filledRisks = db.prepare("SELECT COUNT(*) c FROM analyses WHERE risks != '' AND risks IS NOT NULL").get().c;
console.log('\nFilled: proposed_change=' + filledPC + '/' + total + ', risks=' + filledRisks + '/' + total);

// Detailed sample of one business-relevant law
const gastV = db.prepare(`SELECT * FROM analyses WHERE doc_id='BayGastV'`).get();
if (gastV) {
  console.log('\n=== BayGastV (Gaststättenverordnung) Detail ===');
  console.log('Priority:', gastV.priority, 'Category:', gastV.category);
  console.log('Business relevance:', gastV.business_relevance);
  console.log('Relief potential:', gastV.relief_potential);
  console.log('BayMOG suitability:', gastV.baymog_suitability);
  console.log('Summary:', gastV.summary);
  try {
    const hits = JSON.parse(gastV.description);
    for (const h of hits) {
      console.log('  [' + h.priority + '][' + h.category + '][' + h.business_relevance + '] ' + h.paragraph + ': ' + h.burden_type);
      if (h.proposed_change) console.log('    -> ' + h.proposed_change);
      if (h.risks) console.log('    !! Risiko: ' + h.risks);
    }
  } catch {}
}

console.log('\n=== Test Summary ===');
