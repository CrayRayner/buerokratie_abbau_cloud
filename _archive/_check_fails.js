const { getDb } = require('./db');
const db = getDb();

const session = db.prepare("SELECT MAX(run_session) as s FROM raw_analyses").get().s;

// Show raw responses that failed
const failed = db.prepare(`
  SELECT doc_id, run_index, raw_response FROM raw_analyses 
  WHERE run_session = ? AND raw_response = 'null' OR raw_response IS NULL
`).all(session);
console.log('Null entries:', failed.length);

// Show first 200 chars of a few raw responses to see the pattern
const sample = db.prepare(`
  SELECT doc_id, run_index, SUBSTR(raw_response, 1, 200) as preview FROM raw_analyses 
  WHERE run_session = ? ORDER BY doc_id LIMIT 5
`).all(session);
console.log('\nSample raw responses:');
sample.forEach(r => console.log(`\n${r.doc_id} r${r.run_index}: [${r.preview.replace(/\n/g,'\\n')}]`));
