const {getDb} = require('./db');
const db = getDb();
const session = db.prepare("SELECT run_session FROM raw_analyses GROUP BY run_session ORDER BY MAX(created_at) DESC LIMIT 1").get();
const rows = db.prepare(`
  SELECT doc_id, priority, category, business_relevance, confidence
  FROM analyses WHERE run_session = ?
  ORDER BY doc_id
`).all(session.run_session);
console.log('Session:', session.run_session);
for (const r of rows) {
  const hits = db.prepare("SELECT COUNT(*) c FROM raw_analyses WHERE run_session=? AND doc_id=? AND raw_response LIKE ?").get(session.run_session, r.doc_id, '%"hits":[{%');
  const fails = db.prepare("SELECT COUNT(*) c FROM raw_analyses WHERE run_session=? AND doc_id=? AND raw_response IS NULL").get(session.run_session, r.doc_id);
  console.log(r.confidence + ' ' + r.doc_id + ' ' + r.priority + '/' + r.category + '/' + r.business_relevance + ' (runs_with_hits:' + hits.c + ' failed:' + fails.c + ')');
}
