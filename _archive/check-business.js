const {getDb} = require('./db');
const db = getDb();

const total = db.prepare('SELECT COUNT(*) c FROM analyses').get().c;
const errors = db.prepare("SELECT COUNT(*) c FROM analyses WHERE description LIKE 'ERROR:%'").get().c;
const empty = db.prepare("SELECT COUNT(*) c FROM analyses WHERE category = 'sonstiges'").get().c;
const withHits = db.prepare("SELECT COUNT(*) c FROM analyses WHERE category != 'sonstiges'").get().c;
const prioA = db.prepare("SELECT COUNT(*) c FROM analyses WHERE priority='A'").get().c;
const relHoch = db.prepare("SELECT COUNT(*) c FROM analyses WHERE business_relevance='hoch'").get().c;

console.log('Total:', total, 'Errors:', errors);
console.log('With hits:', withHits, 'Empty:', empty);
console.log('Priority A:', prioA, 'Business hoch:', relHoch);

// Categories
const cats = db.prepare('SELECT category, COUNT(*) c FROM analyses WHERE category NOT NULL GROUP BY category ORDER BY c DESC').all();
console.log('Categories:', cats.map(c => c.category + ':' + c.c).join(', '));

// Detailed look at some hits
const rows = db.prepare(`
  SELECT doc_id, priority, category, business_relevance, substr(summary,1,120) as smry
  FROM analyses WHERE category != 'sonstiges' ORDER BY business_relevance DESC LIMIT 15
`).all();
console.log('\n=== Sample hits ===');
for (const r of rows) {
  console.log(`[${r.priority}] ${r.doc_id} (${r.category}, rel:${r.business_relevance}) ${r.smry}`);
}

// Show what got filtered (business_relevance=niedrig)
const niedrig = db.prepare("SELECT COUNT(*) c FROM analyses WHERE business_relevance='niedrig'").get().c;
console.log('\nFiltered out (business_relevance=niedrig):', niedrig);
