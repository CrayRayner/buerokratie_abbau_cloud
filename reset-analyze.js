const {getDb} = require('./db');
const db = getDb();
// Nur pipeline_status zurücksetzen — KEINE Daten löschen
db.exec("UPDATE pipeline_status SET running=0, done_count=0, total_count=0 WHERE phase='analyze'");
console.log('reset (pipeline_status only, data preserved)');
