const {getDb} = require('./db');
const db = getDb();

const rows = db.prepare(`
  SELECT doc_id, priority, category, summary, description, substr(raw_response,1,300) as raw
  FROM analyses WHERE priority='A' AND category != 'sonstiges'
  ORDER BY doc_id LIMIT 15
`).all();

for (const r of rows) {
  let hits = [];
  try { hits = JSON.parse(r.description); } catch {}
  console.log(r.doc_id + ' [' + r.priority + '/' + r.category + ']');
  console.log('  ' + r.summary);
  for (const h of hits.slice(0, 3)) {
    console.log('  - ' + (h.paragraph||'?') + ': ' + (h.burden||h.burden_type||'?') + ' (' + h.priority + ')');
  }
  console.log();
}
