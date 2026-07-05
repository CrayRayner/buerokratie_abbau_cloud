// Viewer-Server — serviert NUR die vorgebackene dist.db (read-only).
// Kein classify.js, kein Gesetzestext, keine Pipeline. Der ganze IP-Flow bleibt im
// Haupt-Repo; hier wird ausschliesslich SELECT gemacht.
//
// Zwei Betriebsarten:
//   - Dev/CLI:   node server/index.js         (laeuft direkt, Port 3456 oder $PORT)
//   - Electron:  const { start } = require('../server')  (main.js startet inline —
//                KEIN fork, das macht in gepackten Apps Aerger)
const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const makeApi = require('./routes/api');

// dist.db-Pfad: ENV > gepackt (neben der App in resources/) > Dev (dist/dist.db).
function resolveDbPath() {
  if (process.env.DIST_DB && fs.existsSync(process.env.DIST_DB)) return process.env.DIST_DB;
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'dist.db') : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'dist.db'); // dist/dist.db (Dev)
}

// Startet den Server und liefert { port, server, db }. port:0 = freier Zufallsport.
function start({ port = process.env.PORT || 3456 } = {}) {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error('dist.db nicht gefunden: ' + dbPath + '\nErst backen: node dist/publish.js');
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', makeApi(db));
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  return new Promise((resolve) => {
    const server = app.listen(port, 'localhost', () => {
      const p = server.address().port;
      console.log('Viewer läuft: http://localhost:' + p + '  (DB: ' + path.basename(dbPath) + ')');
      resolve({ port: p, server, db });
    });
  });
}

module.exports = { start, resolveDbPath };

// Direktstart (Dev): node server/index.js
if (require.main === module) {
  start().catch(e => { console.error(e.message); process.exit(1); });
}
