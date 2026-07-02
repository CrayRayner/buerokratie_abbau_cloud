// review-report.js
// Erzeugt nach jedem Analyse-Lauf einen deterministischen Review-Report (Markdown).
// Liest NUR die DB, schreibt eine REVIEW_<session>.md + JSON-Snapshot. Ändert nichts.
// Standalone:  node review-report.js
// Eingebunden: am Ende von analyzer/index.js (siehe require('../review-report')).

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const {
  classifyAddressee, bestHitPriority, isGrounded, parseHits
} = require('./classify');

const SNAP_DIR = path.join(__dirname, 'data', 'review-snapshots');

// Verdächtige Vorschläge: Entbürokratisierung in falscher Wirkrichtung
// Verdächtig = Entbürokratisierung in FALSCHER Richtung.
// Aber: Aufbewahrungs-/Speicher-/Löschfristen kürzen = WENIGER Last (korrekt, nicht flaggen);
// "Frist verlängern" = gute Richtung (nicht flaggen). Nur echte Fehlrichtungen melden.
function isInvertedProposal(text) {
  const t = text || '';
  // Schwelle/Grenze SENKEN = mehr Fälle erfasst = mehr Last
  const thresholdDown = /(schwelle|schwellenwert|bagatellgrenze|geringfügigkeitsgrenze)[^.;]{0,40}(senk|reduz|herabsetz|absenk|verringer)/i.test(t);
  // Frist VERKÜRZEN = mehr Druck …
  const fristDown = /frist[^.;]{0,40}(verkürz|senk|kürz|herabsetz|reduz)/i.test(t);
  // … außer Aufbewahrungs-/Speicherfristen (kürzen = Entlastung) und "verlängern" (gute Richtung)
  const retention = /(aufbewahr|speicher|lösch|vorhalte|verjährung|archivier|dokumentationsdauer)/i.test(t);
  const extend = /(verläng|erhöh|ausweit|anheb|aufheb)/i.test(t);
  return thresholdDown || (fristDown && !retention && !extend);
}

// Reform-Priorität, legalShort, isGrounded: siehe classify.js (gemeinsames Modul).

function cell(s) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\|/g, '/').trim();
}


function generateReport(db) {
  db = db || getDb();

  const hasSC = (() => {
    try { return db.prepare('PRAGMA table_info(analyses)').all().some(c => c.name === 'second_check'); }
    catch { return false; }
  })();
  const scCol = hasSC ? 'a.second_check' : 'NULL AS second_check';

  const rows = db.prepare(`
    SELECT a.doc_id, d.title, d.text, a.priority, a.category, a.summary,
           a.business_relevance, a.relief_potential, a.baymog_suitability,
           a.proposed_change, a.legal_restrictions, a.confidence, a.needs_review,
           a.run_session, a.analyzed_at, a.description, ${scCol}
    FROM analyses a JOIN documents d ON a.doc_id = d.doc_id
    WHERE a.analyzed_at >= d.downloaded_at
  `).all();

  // Reform-Priorität + Adressat pro Doc ableiten (bewertete Docs); unbewertete bleiben es.
  // Prioritaet = BESTES Pro-Vorschlag-Ergebnis im Dokument (nicht der Doc-Schnitt) —
  // Qwen berechnet business_relevance schon je Belegstelle; ein Dokument mit gemischten
  // Vorschlaegen (z.B. echte Unternehmenslast + individuelle Bewerberpflicht) soll nicht
  // auf einen mittleren Wert verwaschen. Identisch zu Dashboard/Export (best-of-hits).
  // Adressat: Mehrheit unter den Treffer-Feldern (Weg 2), sonst Titel/Text-Heuristik (Weg 1).
  for (const r of rows) {
    const rated = r.priority === 'A' || r.priority === 'B' || r.priority === 'C';
    r.prio = rated
      ? bestHitPriority(r.legal_restrictions, r.business_relevance, parseHits(r.description))
      : 'nicht bewertet';
    const hitsForAdr = parseHits(r.description);
    const adrCounts = {};
    for (const h of hitsForAdr) if (h.adressat) adrCounts[h.adressat] = (adrCounts[h.adressat] || 0) + 1;
    const best = Object.entries(adrCounts).sort((a, b) => b[1] - a[1])[0];
    r.adressat = best ? best[0] : classifyAddressee(r.title, r.text);
  }

  if (rows.length === 0) {
    console.log('[REVIEW] Keine Analysen vorhanden — kein Report.');
    return null;
  }

  // Aktuelle Session = jüngste run_session
  const sessions = rows.map(r => r.run_session).filter(Boolean).sort();
  const session = sessions.length ? sessions[sessions.length - 1] : 'unbekannt';
  const meta = db.prepare(`
    SELECT a.model, MIN(a.analyzed_at) a, MAX(a.analyzed_at) b
    FROM analyses a JOIN documents d ON a.doc_id = d.doc_id
    WHERE a.analyzed_at >= d.downloaded_at
  `).get();

  // --- Statistik ---
  const byPrio = {};
  const byConf = {};
  const byAdressat = {};
  let needsReview = 0;
  for (const r of rows) {
    byPrio[r.prio] = (byPrio[r.prio] || 0) + 1;
    if (r.prio !== 'nicht bewertet' && r.confidence) byConf[r.confidence] = (byConf[r.confidence] || 0) + 1;
    if (r.needs_review) needsReview++;
    if (r.prio === 'A' || r.prio === 'B' || r.prio === 'C') byAdressat[r.adressat] = (byAdressat[r.adressat] || 0) + 1;
  }

  const ab = rows
    .filter(r => r.prio === 'A' || r.prio === 'B')
    .sort((x, y) => (x.prio).localeCompare(y.prio) ||
                    String(y.confidence).localeCompare(String(x.confidence)));

  // --- Auffälligkeiten ---
  const ungrounded = [];
  const invertedHits = [];
  const euSubstantive = [];
  for (const r of ab) {
    const hits = parseHits(r.description);
    for (const h of hits) {
      if (!isGrounded(h.paragraph, r.text)) {
        ungrounded.push({ title: r.title, para: h.paragraph });
      }
      if (isInvertedProposal(h.proposed_change)) {
        invertedHits.push({ title: r.title, prop: h.proposed_change });
      }
    }
    if (isInvertedProposal(r.proposed_change)) {
      invertedHits.push({ title: r.title, prop: r.proposed_change });
    }
    const euBound = /^EU-/.test(r.legal_restrictions || '');
    if (euBound && /(streich|schwelle|frist|bagatellgrenze)/i.test(r.proposed_change || '')) {
      euSubstantive.push({ title: r.title, legal: r.legal_restrictions, prop: r.proposed_change });
    }
  }

  // --- Diff zum vorherigen Lauf (über JSON-Snapshots) ---
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const curSet = {};
  for (const r of ab) curSet[r.doc_id] = { title: r.title, priority: r.prio, confidence: r.confidence };

  let diffText = '_Kein vorheriger Lauf zum Vergleich._';
  const prevFiles = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json')).sort();
  if (prevFiles.length) {
    try {
      const prev = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, prevFiles[prevFiles.length - 1]), 'utf8'));
      const prevSet = prev.ab || {};
      const added = Object.keys(curSet).filter(id => !prevSet[id]);
      const removed = Object.keys(prevSet).filter(id => !curSet[id]);
      const lines = [`Vergleich mit Lauf \`${prev.session || '?'}\`:`, ''];
      lines.push(added.length
        ? '**Neu als A/B:**\n' + added.map(id => `- ${cell(curSet[id].title)} (${curSet[id].priority}, ${curSet[id].confidence})`).join('\n')
        : '**Neu als A/B:** keine');
      lines.push('');
      lines.push(removed.length
        ? '**Weggefallen (war A/B):**\n' + removed.map(id => `- ${cell(prevSet[id].title)} (war ${prevSet[id].priority})`).join('\n')
        : '**Weggefallen (war A/B):** keine');
      diffText = lines.join('\n');
    } catch { /* ignore corrupt snapshot */ }
  }

  // --- Markdown bauen ---
  const L = [];
  L.push(`# Review-Report — Lauf \`${session}\``);
  L.push('');
  L.push(`- **Generiert:** ${new Date().toISOString()}`);
  L.push(`- **Modell:** ${meta.model || '?'}`);
  L.push(`- **Analysiert am:** ${meta.a} → ${meta.b}`);
  L.push(`- **Dokumente:** ${rows.length}`);
  L.push('');
  L.push('## Überblick');
  L.push(`- **Reform-Priorität:** ` + ['A', 'B', 'C', 'nicht bewertet'].map(p => `${p}: ${byPrio[p] || 0}`).join(' · '));
  const confKeys = Object.keys(byConf).sort().reverse();
  L.push(`- **Confidence:** ` + (confKeys.length ? confKeys.map(c => `${c}: ${byConf[c]}`).join(' · ') : '—'));
  L.push(`- **Prüfung nötig (needs_review):** ${needsReview}`);
  const adrKeys = Object.keys(byAdressat).sort((a, b) => byAdressat[b] - byAdressat[a]);
  L.push(`- **Adressaten (bewertete Docs):** ` + (adrKeys.length ? adrKeys.map(k => `${cell(k)}: ${byAdressat[k]}`).join(' · ') : '—'));
  L.push('');
  L.push('## Änderungen ggü. vorherigem Lauf');
  L.push(diffText);
  L.push('');
  L.push('## Priorisierte Treffer (A/B)');
  L.push('');
  L.push('| Prio | Conf | Review | 2.Check | Relevanz | Entlastung | Rechtsbindung | Hits | Titel |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of ab) {
    const legalShort = (r.legal_restrictions || '').split('–')[0].trim() || 'Landesrecht (frei)';
    let sc = '–';
    try {
      const v = JSON.parse(r.second_check || 'null');
      const sym = { behalten: '✓', herabstufen: '↓', verwerfen: '✗' };
      if (Array.isArray(v)) {
        const c = {};
        for (const x of v) if (x && x.empfehlung) c[x.empfehlung] = (c[x.empfehlung] || 0) + 1;
        const parts = ['behalten', 'herabstufen', 'verwerfen'].filter(k => c[k]).map(k => `${c[k]}${sym[k]}`);
        if (parts.length) sc = parts.join(' ');
      } else if (v && v.empfehlung) sc = v.empfehlung;
    } catch { /* – */ }
    L.push(`| ${r.prio} | ${cell(r.confidence)} | ${r.needs_review ? 'JA' : '–'} | ${sc} | ${cell(r.business_relevance)} | ${cell(r.relief_potential)} | ${cell(legalShort)} | ${parseHits(r.description).length} | ${cell(r.title).slice(0, 70)} |`);
  }
  L.push('');
  L.push('## ⚠️ Automatische Auffälligkeiten');
  L.push('');
  L.push(`### Ungrounded Hits (Beleg nicht im Quelltext) — ${ungrounded.length}`);
  L.push(ungrounded.length
    ? ungrounded.map(u => `- **${cell(u.title).slice(0, 50)}**: \`${cell(u.para).slice(0, 80)}\``).join('\n')
    : '_keine — alle Belegstellen verifiziert ✅_');
  L.push('');
  L.push(`### Verdächtige Vorschläge (falsche Hebel-Richtung) — ${invertedHits.length}`);
  L.push(invertedHits.length
    ? invertedHits.map(i => `- **${cell(i.title).slice(0, 50)}**: ${cell(i.prop).slice(0, 100)}`).join('\n')
    : '_keine erkannt ✅_');
  L.push('');
  L.push(`### EU/Bund-gebunden mit substanziellem Kürzungsvorschlag — ${euSubstantive.length}`);
  L.push(euSubstantive.length
    ? euSubstantive.map(e => `- **${cell(e.title).slice(0, 50)}** (${cell(e.legal).slice(0, 40)}): ${cell(e.prop).slice(0, 90)}`).join('\n')
    : '_keine ✅_');
  L.push('');
  L.push('---');
  L.push('_Automatisch erzeugt von `review-report.js`. Zum Prüfen den Inhalt an Claude weitergeben._');

  const outFile = path.join(__dirname, `REVIEW_${session}.md`);
  fs.writeFileSync(outFile, L.join('\n'), 'utf8');

  // Snapshot für den nächsten Diff
  fs.writeFileSync(path.join(SNAP_DIR, `${session}.json`),
    JSON.stringify({ session, ab: curSet }, null, 0), 'utf8');

  console.log(`[REVIEW] Report geschrieben: REVIEW_${session}.md (A/B: ${ab.length}, ungrounded: ${ungrounded.length}, verdächtig: ${invertedHits.length})`);
  return outFile;
}

if (require.main === module) {
  generateReport();
}

module.exports = { generateReport };
