const {getDb} = require('./db');
const db = getDb();

const t = db.prepare('SELECT COUNT(*) c FROM analyses').get().c;
const e = db.prepare("SELECT COUNT(*) c FROM analyses WHERE category='sonstiges'").get().c;
const h = t - e;
console.log('=== Basis ===');
console.log('Total:', t, 'Leer:', e, 'Treffer:', h);

const r = db.prepare('SELECT business_relevance, COUNT(*) c FROM analyses GROUP BY business_relevance').all();
console.log('Biz:', r.map(x => x.business_relevance + ':' + x.c).join(', '));
const p = db.prepare('SELECT priority, COUNT(*) c FROM analyses GROUP BY priority').all();
console.log('Prio:', p.map(x => x.priority + ':' + x.c).join(', '));
const c = db.prepare("SELECT category, COUNT(*) c FROM analyses WHERE category != 'sonstiges' GROUP BY category").all();
console.log('Cats:', c.map(x => x.category + ':' + x.c).join(', '));

console.log('\n=== FN-Prüfung ===');
['BayLHafSchiffUntO', 'BayPflAbfV', 'BayGastV', 'BayArbSchV', 'BayAPO', 'BayAbfZustV', 'BayIVUAbwWPBV'].forEach(id => {
  const d = db.prepare('SELECT category, priority, business_relevance, substr(summary,1,100) as s FROM analyses WHERE doc_id=?').get(id);
  if (d) console.log(id + ': [' + d.priority + '][' + d.category + '][' + d.business_relevance + '] ' + d.s);
});

console.log('\n=== Treffer-Liste ===');
const hits = db.prepare("SELECT doc_id, category, priority, business_relevance FROM analyses WHERE category != 'sonstiges'").all();
for (const x of hits) console.log('  [' + x.priority + '][' + x.category + '][' + x.business_relevance + '] ' + x.doc_id);

// proposed_change diversity
const pc = db.prepare("SELECT doc_id, proposed_change FROM analyses WHERE proposed_change != '' AND proposed_change IS NOT NULL").all();
let digital = 0;
for (const x of pc) {
  const lc = x.proposed_change.toLowerCase();
  if (lc.includes('digital') || lc.includes('online') || lc.includes('portal') || lc.includes('qr')) digital++;
}
console.log('\nproposed_change: ' + pc.length + ' filled, ' + Math.round(digital/pc.length*100) + '% digitalisierung');
