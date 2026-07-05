#!/usr/bin/env node
/**
 * gen-htpasswd.js — erzeugt/erweitert dist/web/.htpasswd für den Web-Viewer.
 *
 * Sicherheit:
 *   - Passwörter werden ZUFÄLLIG & stark erzeugt (kein Tippen, kein Terminal-Echo-Leak).
 *   - Gespeichert wird NUR der Hash (APR1, salted MD5 — Apache-Standard, universell
 *     unterstützt). Der Klartext wird EINMALIG angezeigt und danach nie wieder.
 *   - .htpasswd ist per .gitignore ausgeschlossen (kommt nie in git).
 *
 * Aufruf:
 *   node dist/gen-htpasswd.js kunde1 kunde2        # neu erzeugen (überschreibt)
 *   node dist/gen-htpasswd.js --add kunde3          # Benutzer anhängen (Rest bleibt)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function md5(buf) { return crypto.createHash('md5').update(buf).digest(); }

// APR1 (Apache MD5-crypt) — Referenzalgorithmus, salted, 1000 Runden.
function apr1(password, salt) {
  const magic = '$apr1$';
  salt = salt.substring(0, 8);
  const pw = Buffer.from(password, 'utf8');
  const saltBuf = Buffer.from(salt, 'utf8');

  let ctx = Buffer.concat([pw, Buffer.from(magic), saltBuf]);
  let final = md5(Buffer.concat([pw, saltBuf, pw]));
  for (let pl = pw.length; pl > 0; pl -= 16) ctx = Buffer.concat([ctx, final.slice(0, Math.min(16, pl))]);
  for (let i = pw.length; i; i >>= 1) {
    ctx = Buffer.concat([ctx, (i & 1) ? Buffer.from([0]) : pw.slice(0, 1)]);
  }
  final = md5(ctx);
  for (let i = 0; i < 1000; i++) {
    let c = (i & 1) ? Buffer.from(pw) : final.slice(0, 16);
    if (i % 3) c = Buffer.concat([c, saltBuf]);
    if (i % 7) c = Buffer.concat([c, pw]);
    c = Buffer.concat([c, (i & 1) ? final.slice(0, 16) : pw]);
    final = md5(c);
  }

  const to64 = (v, n) => { let s = ''; while (--n >= 0) { s += ITOA64[v & 0x3f]; v >>= 6; } return s; };
  let out = '';
  out += to64((final[0] << 16) | (final[6] << 8) | final[12], 4);
  out += to64((final[1] << 16) | (final[7] << 8) | final[13], 4);
  out += to64((final[2] << 16) | (final[8] << 8) | final[14], 4);
  out += to64((final[3] << 16) | (final[9] << 8) | final[15], 4);
  out += to64((final[4] << 16) | (final[10] << 8) | final[5], 4);
  out += to64(final[11], 2);
  return magic + salt + '$' + out;
}

function randSalt() {
  let s = '';
  for (let i = 0; i < 8; i++) s += ITOA64[crypto.randomInt(64)];
  return s;
}
// Starkes Passwort ohne mehrdeutige Zeichen (0/O, 1/l/I) — leichter zu diktieren.
function randPassword(len = 16) {
  const alpha = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789#%+=?';
  let p = '';
  for (let i = 0; i < len; i++) p += alpha[crypto.randomInt(alpha.length)];
  return p;
}

// Als Modul (require) nur die Funktionen exportieren — keine CLI-Ausfuehrung.
if (require.main !== module) { module.exports = { apr1, randSalt, randPassword }; return; }

// --- Args ---
const argv = process.argv.slice(2);
const add = argv.includes('--add');
const users = argv.filter(a => !a.startsWith('--'));
if (users.length === 0) {
  console.error('Nutzung: node dist/gen-htpasswd.js [--add] <benutzer1> <benutzer2> ...');
  process.exit(1);
}

const webDir = path.join(__dirname, 'web');
fs.mkdirSync(webDir, { recursive: true });
const file = path.join(webDir, '.htpasswd');

// Bestehende Zeilen (bei --add erhalten, sonst frisch).
const existing = new Map();
if (add && fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) existing.set(line.slice(0, i), line);
  }
}

const created = [];
for (const u of users) {
  if (!/^[A-Za-z0-9_.-]+$/.test(u)) { console.error('Ungültiger Benutzername: ' + u); process.exit(1); }
  const pw = randPassword();
  existing.set(u, u + ':' + apr1(pw, randSalt()));
  created.push({ user: u, pw });
}

fs.writeFileSync(file, [...existing.values()].join('\n') + '\n', 'utf8');

console.log('\n.htpasswd geschrieben -> ' + file + '  (' + existing.size + ' Benutzer gesamt)\n');
console.log('==================== EINMALIG ANZEIGEN — JETZT SICHER SPEICHERN ====================');
for (const c of created) console.log('  Benutzer: ' + c.user.padEnd(16) + 'Passwort: ' + c.pw);
console.log('====================================================================================');
console.log('Diese Passwörter erscheinen NICHT erneut. In einen Passwortmanager übernehmen.');
console.log('Die .htpasswd enthält nur die Hashes und darf hochgeladen werden (nie in git).\n');
