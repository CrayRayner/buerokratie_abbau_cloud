const express = require('express');
const path = require('path');
const { initSchema } = require('../../db');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3456;

initSchema();

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', apiRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const server = app.listen(PORT, 'localhost', () => {
  console.log(`[DASHBOARD] Läuft auf http://localhost:${PORT}`);
  if (process.send) process.send({ type: 'ready', port: PORT });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[DASHBOARD] Port ${PORT} ist bereits belegt — vermutlich läuft schon ein Dashboard.`);
    console.error(`  Öffne einfach http://localhost:${PORT} im Browser,`);
    console.error(`  oder beende den alten Prozess:  npx kill-port ${PORT}\n`);
    process.exit(1);
  }
  throw err;
});
