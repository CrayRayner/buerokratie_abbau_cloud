// Viewer-API — liest ausschliesslich die vorgebackene dist.db.
// Alles ist bereits berechnet (publish.js): kein classify.js, kein Gesetzestext.
const express = require('express');

module.exports = function makeApi(db) {
  const router = express.Router();

  const meta = () => Object.fromEntries(
    db.prepare('SELECT key, value FROM published_meta').all().map(r => [r.key, r.value])
  );

  // Ein fester Datensatz pro Lieferung — kein Run-Picker mehr (leeres Array blendet ihn aus).
  router.get('/runs', (req, res) => res.json({ runs: [] }));

  // /data: KPIs + Charts direkt aus published_meta, Trefferliste aus published_hits.
  // Feldnamen werden auf das Frontend-Schema gemappt (docId, normType, legalFull, …).
  router.get('/data', (req, res) => {
    const m = meta();
    const kpi = JSON.parse(m.kpi_json || '{}');
    const charts = JSON.parse(m.charts_json || '{}');
    const rows = db.prepare('SELECT * FROM published_hits ORDER BY id').all();
    const hits = rows.map(r => ({
      docId: r.doc_id,
      title: r.title,
      normType: r.norm_type,
      url: r.url,
      priority: r.priority,
      confidence: r.confidence,
      unanimous: !!r.unanimous,
      needsReview: !!r.needs_review,
      legal: r.legal,
      legalFull: r.legal_full,
      category: r.category,
      adressat: r.adressat,
      normstelle: r.normstelle,
      beleg: r.beleg,
      burden: r.burden,
      proposed: r.proposed,
      risks: r.risks,
      relevance: r.relevance,
      relief: r.relief,
      grounded: !!r.grounded,
      secondCheck: r.second_check ? JSON.parse(r.second_check) : null,
      endstatus: r.endstatus
    }));
    res.json({ kpi, charts, hits, dataDate: m.data_date || null });
  });

  // /export/csv: gleiche 19 Spalten wie das Original — nur aus vorgebackenen Feldern.
  router.get('/export/csv', (req, res) => {
    const rows = db.prepare(
      "SELECT * FROM published_hits WHERE priority IN ('A','B','C') ORDER BY priority, doc_id, hit_index"
    ).all();
    const esc = v => {
      const s = String(v == null ? '' : v);
      return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ['Gesetz', 'Normtyp', 'Normstelle', 'Belegstelle', 'Pflichttyp', 'Adressat', 'Belegtext',
      'Aenderungsvorschlag', 'Risiko', 'Prioritaet', 'ensemble_votes',
      'beleg_sicherheit', 'rechtlich_gebunden', 'human_review',
      'Zweitcheck', 'Zweitcheck_Begruendung', 'Endstatus', 'URL', 'Modell'];
    const lines = [header.join(';')];
    for (const r of rows) {
      let sc = null;
      try { sc = r.second_check ? JSON.parse(r.second_check) : null; } catch { /* leer */ }
      lines.push([
        r.title, r.norm_type, r.normstelle, r.beleg, r.category, r.adressat,
        r.burden, r.proposed, r.risks, r.priority, r.confidence,
        r.grounded ? 'hoch' : 'niedrig', r.legal_display, r.needs_review ? 'JA' : 'nein',
        sc ? sc.empfehlung || '' : '', sc ? sc.begruendung || '' : '',
        r.endstatus, r.url, r.model
      ].map(esc).join(';'));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=buerokratie-belegstellen.csv');
    res.send('﻿' + lines.join('\n'));
  });

  return router;
};
