const {getDb} = require('./db');
const db = getDb();

// Aktuelle Session finden
const session = db.prepare("SELECT run_session, COUNT(*) c FROM raw_analyses GROUP BY run_session ORDER BY MAX(created_at) DESC LIMIT 1").get();
console.log('Session:', session.run_session, '(' + session.c + ' rows)');

// Alle Docs mit 3+/5 Runs mit Hits
const docs = db.prepare(`
  SELECT doc_id, COUNT(*) as votes
  FROM raw_analyses
  WHERE run_session = ? AND raw_response LIKE '%"hits":[{%'
  GROUP BY doc_id
  HAVING votes >= 3
  ORDER BY votes DESC
`).all(session.run_session);

console.log('Docs mit 3+/5:', docs.length);
for (const d of docs) {
  const a = db.prepare('SELECT priority, category, business_relevance, confidence, summary FROM analyses WHERE doc_id = ?').get(d.doc_id);
  console.log(' ' + d.votes + '/5 ' + d.doc_id + ' -> analyses: prio=' + a.priority + ' cat=' + a.category + ' biz=' + a.business_relevance + ' conf=' + a.confidence);
  if (a.summary && a.summary.length > 0) console.log('   summary: ' + a.summary.substring(0, 120));
}

// Grounding: check a sample hit
const sample = db.prepare(`
  SELECT doc_id, raw_response FROM raw_analyses 
  WHERE run_session = ? AND raw_response LIKE '%"hits":[{%'
  LIMIT 3
`).all(session.run_session);
console.log('\nSample raw hits:');
for (const s of sample) {
  const parsed = JSON.parse(s.raw_response);
  if (parsed.hits && parsed.hits.length > 0) {
    console.log(' ' + s.doc_id + ': ' + JSON.stringify(parsed.hits.map(h => h.paragraph)));
  }
}
