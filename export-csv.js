const {getDb} = require('./db');
const fs = require('fs');
const db = getDb();

const docs = db.prepare(`
  SELECT doc_id, norm_type, title, char_count, url, text
  FROM documents ORDER BY norm_type, doc_id
`).all();

const csv = [
  'doc_id;norm_type;title;char_count;url;text',
  ...docs.map(d =>
    [
      d.doc_id,
      d.norm_type,
      '"' + (d.title||'').replace(/"/g,'""') + '"',
      d.char_count,
      d.url,
      '"' + (d.text||'').replace(/"/g,'""') + '"'
    ].join(';')
  )
].join('\n');

fs.writeFileSync('docs-export-full.csv', '\ufeff' + csv, 'utf8');
const size = fs.statSync('docs-export-full.csv').size;
console.log(`Exported ${docs.length} docs to docs-export-full.csv (${(size/1024/1024).toFixed(1)} MB)`);
