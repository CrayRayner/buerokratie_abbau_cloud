const { getDb } = require('./db');
const db = getDb();
const session = db.prepare("SELECT MAX(run_session) as s FROM raw_analyses").get().s;

const runs = db.prepare("SELECT doc_id, run_index FROM raw_analyses WHERE run_session = ?").all(session);
const failedCount = db.prepare("SELECT COUNT(*) as c FROM (SELECT doc_id FROM raw_analyses WHERE run_session = ? GROUP BY doc_id HAVING COUNT(*) < 3)").get(session).c;
const totalDocs = db.prepare("SELECT COUNT(DISTINCT doc_id) as c FROM raw_analyses WHERE run_session = ?").get(session).c;

const a = db.prepare("SELECT doc_id, priority, description FROM analyses WHERE run_session = ? ORDER BY doc_id").all(session);
const pos = a.filter(r => JSON.parse(r.description||'[]').length > 0);
console.log(`Runs: ${runs.length}, Docs: ${totalDocs}, Docs with <3 runs: ${failedCount}, Positive: ${pos.length}`);
pos.forEach(r => console.log(`  ${r.doc_id}: ${r.priority}`));
