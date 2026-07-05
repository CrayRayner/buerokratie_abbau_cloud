// env.js — Minimaler, abhängigkeitsfreier .env-Loader (KEY=VALUE, # Kommentare).
// Überschreibt bereits gesetzte process.env-Werte NICHT (z.B. wenn extern schon gesetzt).
// Gemeinsames Modul für second-check.js und analyzer/client.js.

function loadDotEnv() {
  const path = require('path').join(__dirname, '.env');
  let raw;
  try { raw = require('fs').readFileSync(path, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

module.exports = { loadDotEnv };
