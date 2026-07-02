const {getDb} = require('./db');
const db = getDb();

const total = db.prepare('SELECT COUNT(*) c FROM analyses').get().c;
const empty = db.prepare("SELECT COUNT(*) c FROM analyses WHERE category = 'sonstiges'").get().c;
const hits = db.prepare("SELECT COUNT(*) c FROM analyses WHERE category != 'sonstiges'").get().c;
const rel = db.prepare("SELECT business_relevance, COUNT(*) c FROM analyses GROUP BY business_relevance").all();
const prio = db.prepare("SELECT priority, COUNT(*) c FROM analyses GROUP BY priority").all();
const cats = db.prepare("SELECT category, COUNT(*) c FROM analyses WHERE category != 'sonstiges' GROUP BY category ORDER BY c DESC").all();

console.log('Total:', total, 'Leer:', empty, 'Mit Treffern:', hits);
console.log('Business:', rel.map(r => r.business_relevance + ':' + r.c).join(', '));
console.log('Priority:', prio.map(r => r.priority + ':' + r.c).join(', '));
console.log('Categories:', cats.map(c => c.category + ':' + c.c).join(', '));

// Show empty docs
const emptyDocs = db.prepare("SELECT doc_id, substr(summary,1,120) as s FROM analyses WHERE category = 'sonstiges'").all();
console.log('\n=== Empty docs ===');
for (const r of emptyDocs) console.log('  ' + r.doc_id + ': ' + r.s);

// Show successful docs
const good = db.prepare(`
  SELECT doc_id, priority, category, business_relevance, substr(summary,1,120) as s
  FROM analyses WHERE category != 'sonstiges' ORDER BY doc_id LIMIT 15
`).all();
console.log('\n=== Docs with hits ===');
for (const r of good) console.log('  [' + r.priority + '][' + r.category + '][' + r.business_relevance + '] ' + r.doc_id + ': ' + r.s);

// Check proposed_change diversity
const pc = db.prepare(`
  SELECT doc_id, substr(proposed_change,1,80) as pc FROM analyses WHERE proposed_change != '' LIMIT 10
`).all();
console.log('\n=== proposed_change samples ===');
for (const r of pc) console.log('  ' + r.doc_id + ': ' + r.pc);

// Check paragraph hallucination
const paras = db.prepare(`
  SELECT doc_id, description FROM analyses WHERE category != 'sonstiges' LIMIT 10
`).all();
let totalPara = 0;
let emptyPara = 0;
for (const r of paras) {
  try {
    const hits2 = JSON.parse(r.description);
    for (const h of hits2) {
      totalPara++;
      if (!h.paragraph || h.paragraph === '?' || h.paragraph === '') emptyPara++;
    }
  } catch {}
}
console.log('\nParagraphs: ' + totalPara + ' total, ' + emptyPara + ' empty/unsure (' + Math.round(emptyPara/totalPara*100) + '%)');
