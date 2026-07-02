const {getDb} = require('./db');
const db = getDb();
const a = db.prepare('SELECT COUNT(*) c FROM analyses').get().c;
const e = db.prepare("SELECT COUNT(*) c FROM analyses WHERE description LIKE 'ERROR:%'").get().c;
const hits = db.prepare("SELECT COUNT(*) c FROM analyses WHERE category != 'sonstiges'").get().c;
const prioA = db.prepare("SELECT COUNT(*) c FROM analyses WHERE priority='A'").get().c;
console.log('Analyzed:', a, 'Errors:', e, 'With hits:', hits, 'Prio A:', prioA);
if (a > 0) {
  const cats = db.prepare('SELECT category, COUNT(*) c FROM analyses WHERE category NOT NULL GROUP BY category ORDER BY c DESC').all();
  console.log('Categories:', cats.map(c => c.category + ':' + c.c).join(', '));
}
