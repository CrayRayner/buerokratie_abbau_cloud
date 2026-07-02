const { getDb } = require('./db');
const db = getDb();

const session = db.prepare("SELECT MAX(run_session) as s FROM analyses").get().s;
console.log('Session:', session);

// Check analyses table for current session
const rows = db.prepare("SELECT doc_id, priority, category, description, summary FROM analyses WHERE run_session = ?").all(session);
console.log('\n=== Analyses ===');
rows.forEach(r => {
  const desc = JSON.parse(r.description || '[]');
  console.log(`\n${r.doc_id}: priority=${r.priority} category=${r.category}`);
  console.log(`  summary: ${(r.summary||'').substring(0,120)}`);
  desc.forEach((h, i) => console.log(`  [${i+1}] para=${(h.paragraph||'').substring(0,70)} cat=${h.category} burd=${(h.burden||'').substring(0,50)} prio=${h.priority} votes=${h.votes} proposed=${(h.proposed_change||'').substring(0,80)}`));
  if (desc.length === 0) console.log('  (no hits)');
});

// Check reasoning_content presence in raw_analyses
const raws = db.prepare("SELECT doc_id, run_index, LENGTH(raw_response) as len, SUBSTR(raw_response,1,100) as preview FROM raw_analyses WHERE run_session = ?").all(session);
console.log('\n=== Raw Analyses (first 100 chars) ===');
raws.forEach(r => console.log(`  ${r.doc_id} r${r.run_index} (${r.len}B): ${r.preview.replace(/\n/g,' ')}`));

// Count parse errors in raw
const withNull = db.prepare("SELECT COUNT(*) as c FROM raw_analyses WHERE run_session = ? AND raw_response = 'null'").get(session).c;
console.log(`\nNull entries: ${withNull} / ${raws.length}`);
