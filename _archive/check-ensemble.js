const {getDb} = require('./db');
const db = getDb();

const t = db.prepare('SELECT COUNT(*) c FROM analyses').get().c;
const empty = db.prepare("SELECT COUNT(*) c FROM analyses WHERE category='sonstiges'").get().c;
const hits = t - empty;

console.log('=== Ensemble (50x5=250 Runs) ===');
console.log('Total:', t, 'Leer:', empty, 'Treffer:', hits);

const conf = db.prepare('SELECT confidence, COUNT(*) c FROM analyses GROUP BY confidence').all();
console.log('Confidence:', conf.map(x => x.confidence + ':' + x.c).join(', '));

const review = db.prepare('SELECT needs_review, COUNT(*) c FROM analyses GROUP BY needs_review').all();
console.log('Review:', review.map(x => (x.needs_review ? 'ja:' : 'nein:') + x.c).join(', '));

const biz = db.prepare('SELECT business_relevance, COUNT(*) c FROM analyses GROUP BY business_relevance').all();
console.log('Biz:', biz.map(x => x.business_relevance + ':' + x.c).join(', '));

const prio = db.prepare('SELECT priority, COUNT(*) c FROM analyses GROUP BY priority').all();
console.log('Prio:', prio.map(x => x.priority + ':' + x.c).join(', '));

const cats = db.prepare("SELECT category, COUNT(*) c FROM analyses WHERE category != 'sonstiges' GROUP BY category ORDER BY c DESC").all();
console.log('Cats:', cats.map(x => x.category + ':' + x.c).join(', '));

// Treffer mit Details
const rows = db.prepare(`
  SELECT doc_id, priority, category, business_relevance, confidence, needs_review, substr(summary,1,80) as s
  FROM analyses WHERE category != 'sonstiges' ORDER BY confidence DESC, doc_id
`).all();
console.log('\n=== Treffer ===');
for (const r of rows) {
  console.log('[' + r.confidence + '][' + (r.needs_review ? 'REVIEW' : 'AUTO') + '] ' + r.doc_id + ' [' + r.priority + '][' + r.category + '][' + r.business_relevance + '] ' + r.s);
}
