const { initSchema, getDb, setPipelineRunning, setPipelineTotal, updatePipelineStatus } = require('../db');
const { buildPrompt } = require('./prompt');
const { analyzeWithLMStudio } = require('./client');
const { generateReport } = require('../review-report');
const { isGrounded } = require('../classify');
const config = require('../config.json');

async function analyze() {
  console.log('=== ANALYZE PHASE (Ensemble: ' + (config.ensembleRuns || 1) + ' runs, temp=' + (config.ensembleTemperature || 0.1) + ') ===');
  const db = initSchema();
  setPipelineRunning('analyze', true);

  const runSession = new Date().toISOString().replace(/[:.]/g, '-');

  try {
    let query;
    const params = [];
    if (config.testDocIds && config.testDocIds.length > 0) {
      const ph = config.testDocIds.map(() => '?').join(',');
      query = `SELECT d.* FROM documents d WHERE d.text IS NOT NULL AND d.char_count > 10 AND d.doc_id IN (${ph})`;
      params.push(...config.testDocIds);
    } else {
      query = `SELECT d.* FROM documents d WHERE d.text IS NOT NULL AND d.char_count > 10 AND NOT EXISTS (SELECT 1 FROM analyses a WHERE a.doc_id = d.doc_id AND a.analyzed_at >= d.downloaded_at)`;
      if (config.maxDocChars > 0) {
        query += ` AND d.char_count <= ?`;
        params.push(config.maxDocChars);
      }
    }
    const pendingDocs = db.prepare(query).all(...params);

    const maxAnalyze = config.maxAnalyzeDocs || 0;
    const analyzeList = maxAnalyze > 0 ? pendingDocs.slice(0, maxAnalyze) : pendingDocs;
    const total = analyzeList.length;
    setPipelineTotal('analyze', total);
    console.log(`[ANALYZE] ${total} documents to analyze`);

    if (total === 0) {
      console.log('[ANALYZE] Nothing to analyze');
      return;
    }

    const concurrency = config.concurrency || 1;
    const ensembleRuns = config.ensembleRuns || 1;
    const ensembleTemp = config.ensembleTemperature || 0.1;

    let done = 0;
    let errors = 0;
    let idx = 0;

    // Ein Ensemble (ensembleRuns Läufe) auf einem Textstück; speichert raw_analyses.
    async function runEnsembleOnText(doc, text, tag, runOffset) {
      const prompt = buildPrompt(doc.title, text);
      const results = [];
      for (let r = 0; r < ensembleRuns; r++) {
        try {
          const result = await analyzeWithLMStudio(prompt, doc.doc_id + (tag || ''), ensembleTemp);
          results.push(result);
          db.prepare(`
            INSERT INTO raw_analyses (doc_id, run_index, temperature, raw_response, model, run_session)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(doc.doc_id, runOffset + r, ensembleTemp, JSON.stringify(result), config.model, runSession);
          process.stdout.write(`    ${tag ? tag + ' ' : ''}run ${r + 1}/${ensembleRuns}: ${result.hits ? result.hits.length : 0} hits\n`);
        } catch (runErr) {
          console.error(`    ${tag ? tag + ' ' : ''}run ${r + 1}/${ensembleRuns} FAILED:`, runErr.message);
          results.push(null);
        }
      }
      return results;
    }

    async function processDoc(doc) {
      try {
        const charCount = doc.char_count || doc.text.length;
        const chunkThreshold = config.chunkThreshold || 70000;
        let aggregated;
        let rawResults = [];
        const wasSummarized = false;

        if (charCount > chunkThreshold) {
          // Große Gesetze: an §-Grenzen in Fenster splitten, jedes Fenster im Ensemble
          // bewerten, Treffer mergen. Grounding läuft gegen den VOLLTEXT.
          const windows = splitIntoWindows(doc.text, chunkThreshold);
          console.log(`[ANALYZE] [${++done}/${total}] ${doc.doc_id} (${charCount} chars) — GECHUNKT in ${windows.length} §-Fenster`);
          const perWindow = [];
          for (let w = 0; w < windows.length; w++) {
            const winResults = await runEnsembleOnText(doc, windows[w], `#f${w + 1}`, w * ensembleRuns);
            rawResults.push(...winResults);
            perWindow.push(aggregateEnsemble(winResults.filter(Boolean), ensembleRuns, doc.text));
          }
          aggregated = mergeChunkAggregates(perWindow, doc.text, ensembleRuns);
        } else {
          console.log(`[ANALYZE] [${++done}/${total}] ${doc.doc_id} (${charCount} chars, ${ensembleRuns} runs)`);
          rawResults = await runEnsembleOnText(doc, doc.text, '', 0);
          aggregated = aggregateEnsemble(rawResults.filter(Boolean), ensembleRuns, doc.text);
        }

        if (aggregated.decided && aggregated.hits.length > 0) {
          db.prepare(`
            INSERT OR REPLACE INTO analyses (doc_id, priority, category, summary, description, business_relevance,
              relief_potential, baymog_suitability, proposed_change, risks, legal_restrictions,
              raw_response, model, was_summarized, confidence, needs_review, run_session, analyzed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).run(
            doc.doc_id,
            aggregated.priority,
            aggregated.mainCategory,
            aggregated.summary,
            JSON.stringify(aggregated.hits),
            aggregated.business_relevance,
            aggregated.relief_potential,
            aggregated.baymog_suitability,
            aggregated.proposed_change,
            aggregated.risks,
            aggregated.legal_restrictions,
            JSON.stringify(rawResults),
            config.model,
            wasSummarized ? 1 : 0,
            aggregated.confidence,
            aggregated.needsReview ? 1 : 0,
            runSession
          );
        } else {
          db.prepare(`
            INSERT OR REPLACE INTO analyses (doc_id, priority, category, summary, description, legal_restrictions,
              raw_response, model, confidence, needs_review, run_session, analyzed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).run(
            doc.doc_id,
            'nicht bewertet',
            'sonstiges',
            aggregated.summary || 'Keine unternehmensrelevanten Bürokratiebelastungen gefunden',
            '[]',
            aggregated.legal_restrictions || '',
            JSON.stringify(rawResults),
            config.model,
            aggregated.confidence,
            aggregated.needsReview ? 1 : 0,
            runSession
          );
        }

        updatePipelineStatus('analyze', 1);
      } catch (err) {
        console.error(`  [ANALYZE] Error for ${doc.doc_id}:`, err.message);
        db.prepare(`
          INSERT OR REPLACE INTO analyses (doc_id, description, raw_response, model, run_session, analyzed_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
        `).run(doc.doc_id, `ERROR: ${err.message}`, err.message, config.model, runSession);
        errors++;
        updatePipelineStatus('analyze', 1);
      }
    }

    // Concurrent pool: stagger requests
    while (idx < analyzeList.length) {
      const batch = analyzeList.slice(idx, idx + concurrency);
      idx += concurrency;

      const promises = batch.map((doc, i) =>
        new Promise(resolve => setTimeout(resolve, i * 2000)).then(() => processDoc(doc))
      );
      await Promise.all(promises);

      if (config.requestDelayMs > 0) {
        await new Promise(r => setTimeout(r, config.requestDelayMs));
      }
    }

    console.log(`[ANALYZE] Done: ${done} analyzed, ${errors} errors`);
  } catch (err) {
    console.error('[ANALYZE] Fatal:', err);
  } finally {
    setPipelineRunning('analyze', false);
    // Review-Report nach jedem Lauf (defensiv: darf den Lauf nie brechen)
    try {
      generateReport(db);
    } catch (e) {
      console.error('[REVIEW] Report fehlgeschlagen:', e.message);
    }
  }
}

// === ENSEMBLE AGGREGATION ===

function normPara(p) {
  return (p || '').toLowerCase().replace(/\s+/g, '').replace(/§+/g, '§');
}

// isGrounded: siehe classify.js (gemeinsames Modul — vorher hier die 4. Kopie).

function classifyLegalBasis(docText) {
  const t = docText || '';
  const euVO = t.match(/Verordnung\s*\(?(EU|EG|EWG)\)?\s*(Nr\.?\s*)?\d+[\/\d]*/i);
  const euRL = t.match(/Richtlinie\s*\(?(EU|EG|EWG)?\)?\s*(Nr\.?\s*)?\d+[\/\d]*/i);
  const bund = t.match(/\b(BNatSchG|GastG|GewO|BImSchG|WHG|KrWG|BGB|HGB|AO|SGB|ArbSchG|ProdSG|EnWG|GenTG|ChemG|TierSchG|LFGB|AufenthG|AsylG|AsylbLG|BauGB|StVG|BDSG|VwVfG|HwO|PBefG|AMG|ApoG)\b/);
  if (euVO) return 'EU-Verordnung (unmittelbar geltend) – Substanz und Verfahren gebunden: ' + euVO[0];
  if (euRL) return 'EU-Richtlinie – Substanz gebunden, Verfahren ggf. kürzbar: ' + euRL[0];
  if (bund) return 'Bundesrechtlich gebunden (' + bund[1] + ') – Abweichungsspielraum prüfen';
  return '';
}

const PRIO_RANK = { A: 3, B: 2, C: 1 };
const PRIO_UNRANK = { 3: 'A', 2: 'B', 1: 'C' };

function rank(v) {
  return { hoch: 3, mittel: 2, niedrig: 1, 'nicht bewertet': 0 }[v] || 0;
}

function unrank(n) {
  return { 3: 'hoch', 2: 'mittel', 1: 'niedrig', 0: 'nicht bewertet' }[Math.round(n)] || 'nicht bewertet';
}

function aggregateEnsemble(results, totalRuns, docText) {
  const majority = Math.floor(totalRuns / 2) + 1; // 3 bei 5

  // Ebene 1: Dokument-Entscheid (Mehrheit)
  const aVotes = results.filter(r => r.hits && r.hits.length > 0).length;
  const decided = aVotes >= majority;
  const confidence = aVotes + '/' + totalRuns;
  const legalBasis = classifyLegalBasis(docText);
  const needsReview = decided && (aVotes < totalRuns || legalBasis.length > 0);

  if (!decided) {
    return { decided: false, hits: [], confidence, needsReview: false, summary: 'Keine unternehmensrelevanten Bürokratiebelastungen gefunden', priority: 'nicht bewertet', business_relevance: 'niedrig', relief_potential: 'nicht bewertet', baymog_suitability: 'nicht bewertet', proposed_change: '', risks: '',      legal_restrictions: legalBasis,
    mainCategory: 'sonstiges' };
  }

  // Ebene 2: Hits sammeln + deduplizieren + grounden (kein Cross-Run-Vote mehr)
  const paraMap = {};

  for (const r of results) {
    const seen = new Set();
    for (const h of (r.hits || [])) {
      const k = normPara(h.paragraph);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      if (!paraMap[k]) paraMap[k] = [];
      paraMap[k].push(h);
    }
  }

  const survivors = [];

  for (const [k, cands] of Object.entries(paraMap)) {
    // Grounding: Paragraph muss im Quelltext vorkommen
    if (!isGrounded(cands[0].paragraph, docText)) continue;

    const cnt = cands.length;

    // Mode category
    const catCounts = {};
    for (const c of cands) {
      const cat = (c.category || 'sonstiges').split('|')[0]
        .replace(/SCHWELLENWORT/gi, 'SCHWELLENWERT')
        .replace(/FRIESTEN/gi, 'FRISTEN')
        .replace(/NAHWEIS/gi, 'NACHWEIS')
        .replace(/DOKUMENTATIONSPFLICHT/gi, 'DOKUMENTATION')
        .replace(/BERICHTSPFLICHTIG/gi, 'BERICHTSPFLICHT')
        .replace(/SCHRIFTFORMULAR/gi, 'SCHRIFTFORM')
        .replace(/MEHRFACHZUSTAENDIGKEIT/gi, 'MEHRFACHZUSTÄNDIGKEIT')
        .replace(/GENEHMIGUNGSPFLICHT/gi, 'GENEHMIGUNG')
        .replace(/ANZEIGEPFLICHT/gi, 'ANZEIGE');
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    }
    const bestCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0][0];

    // Mode adressat (optionales Modell-Feld, Weg 2 — kann fehlen, dann Fallback im
    // Dashboard/Export auf classify.js-Heuristik aus Titel+Text, Weg 1)
    const adrCounts = {};
    for (const c of cands) { const a = c.adressat; if (a) adrCounts[a] = (adrCounts[a] || 0) + 1; }
    const adrEntries = Object.entries(adrCounts).sort((a, b) => b[1] - a[1]);
    const bestAdressat = adrEntries.length ? adrEntries[0][0] : '';

    // Median ranks (separate Mappings)
    const medRank = f => unrank(median(cands.map(c => rank(c[f] || 'mittel'))));
    const medPrio = () => {
      const vals = cands.map(c => PRIO_RANK[c.priority]).filter(v => v);
      if (vals.length === 0) return 'B';
      return PRIO_UNRANK[Math.round(median(vals))] || 'B';
    };

    // Longest proposed_change, risks, legal_restrictions
    const bestByLen = f => cands.map(c => c[f] || '').sort((a, b) => b.length - a.length)[0];

    survivors.push({
      paragraph: cands[0].paragraph || '',
      category: bestCat,
      adressat: bestAdressat,
      burden: cands[0].burden || cands[0].burden_type || '',
      priority: medPrio(),
      business_relevance: medRank('business_relevance'),
      relief_potential: medRank('relief_potential'),
      baymog_suitability: medRank('baymog_suitability'),
      proposed_change: bestByLen('proposed_change'),
      risks: bestByLen('risks'),
      legal_restrictions: bestByLen('legal_restrictions'),
      votes: cnt + '/' + totalRuns,
      reviewSuggested: cnt < majority
    });
  }

  if (survivors.length === 0) {
    return { decided: true, hits: [], confidence, needsReview: true, summary: 'Treffer vorhanden aber keine grounded (Paragraph nicht im Quelltext)', priority: 'nicht bewertet', business_relevance: 'niedrig', relief_potential: 'nicht bewertet', baymog_suitability: 'nicht bewertet', proposed_change: '', risks: '', legal_restrictions: legalBasis, mainCategory: 'sonstiges' };
  }

  // Aggregate summaries
  const summaryTexts = results.filter(r => r.hits && r.hits.length > 0).map(r => r.summary || '').filter(Boolean);
  const bestSummary = summaryTexts.sort((a, b) => b.length - a.length)[0] || survivors.map(s => s.burden).join('; ');

  // Mode for doc-level fields
  const modeField = (arr, f) => {
    const c = {};
    for (const x of arr) { const v = x[f]; if (v) c[v] = (c[v] || 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || 'nicht bewertet';
  };

  const bizRels = survivors.map(s => s.business_relevance);
  const reliefs = survivors.map(s => s.relief_potential);
  const baymogs = survivors.map(s => s.baymog_suitability);

  // Nur hoch/mittel business_relevance in final hits
  const relevantHits = survivors.filter(s => s.business_relevance === 'hoch' || s.business_relevance === 'mittel');

  if (relevantHits.length === 0) {
    return { decided: false, hits: [], confidence, needsReview: false, summary: 'Keine unternehmensrelevanten Bürokratiebelastungen (nur niedrige Relevanz)', priority: 'nicht bewertet', business_relevance: 'niedrig', relief_potential: 'nicht bewertet', baymog_suitability: 'nicht bewertet', proposed_change: '', risks: '', legal_restrictions: legalBasis, mainCategory: 'sonstiges' };
  }

  return {
    decided: true,
    priority: relevantHits.some(s => s.priority === 'A') ? 'A' : relevantHits.some(s => s.priority === 'B') ? 'B' : 'C',
    mainCategory: modeField(relevantHits, 'category'),
    business_relevance: modeField(bizRels.map(v => ({v})), 'v'),
    relief_potential: modeField(reliefs.map(v => ({v})), 'v'),
    baymog_suitability: modeField(baymogs.map(v => ({v})), 'v'),
    proposed_change: relevantHits.filter(s => s.proposed_change).map(s => s.proposed_change).join('; '),
    risks: relevantHits.filter(s => s.risks).map(s => s.risks).join('; '),
    legal_restrictions: legalBasis,
    summary: bestSummary,
    hits: relevantHits.sort((a, b) => {
      const vA = parseInt(a.votes);
      const vB = parseInt(b.votes);
      if (vB !== vA) return vB - vA;
      return (a.priority === 'A' ? 3 : a.priority === 'B' ? 2 : 1) - (b.priority === 'A' ? 3 : b.priority === 'B' ? 2 : 1);
    }),
    confidence,
    needsReview
  };
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// === CHUNKING (große Gesetze > chunkThreshold) ===

// Text an §-Grenzen in Fenster <= maxChars teilen. Präambel (Ermächtigung) kommt ins
// erste Fenster; ein einzelner übergroßer §-Block wird zu einem eigenen (Über-)Fenster
// (prompt.js kappt den dann bei 80k). Kein Split mitten im Paragraphen.
function splitIntoWindows(text, maxChars) {
  const re = /(?:^|\n)\s*§\s*\d+[a-z]?/g;
  const idxs = [];
  let m;
  while ((m = re.exec(text)) !== null) idxs.push(m.index);

  let windows;
  if (idxs.length < 2) {
    windows = [text]; // 0–1 § → keine §-Struktur
  } else {
    const segs = [];
    for (let i = 0; i < idxs.length; i++) {
      segs.push(text.slice(idxs[i], i + 1 < idxs.length ? idxs[i + 1] : text.length));
    }
    windows = [];
    let cur = text.slice(0, idxs[0]); // Präambel vor dem ersten §
    for (const seg of segs) {
      if (cur.length && cur.length + seg.length > maxChars) { windows.push(cur); cur = ''; }
      cur += seg;
    }
    if (cur.trim()) windows.push(cur);
  }

  // Fallback: übergroße Fenster (kein §-Struktur / Riesen-§, z.B. Tabellen-Verordnungen)
  // hart nach Größe teilen → volle Abdeckung statt 80k-Kappung.
  const out = [];
  for (const win of windows) {
    if (win.length <= maxChars) { out.push(win); continue; }
    for (let i = 0; i < win.length; i += maxChars) out.push(win.slice(i, i + maxChars));
  }
  return out;
}

// Fenster-Aggregate zu EINEM Doc-Ergebnis mergen (Treffer dedupen, Doc-Felder ableiten).
// Jedes perWindow-Element ist bereits ein aggregateEnsemble()-Ergebnis (gevotet+grounded).
function mergeChunkAggregates(perWindow, docText, totalRuns) {
  const legalBasis = classifyLegalBasis(docText);
  const bestVotes = Math.max(0, ...perWindow.map(a => parseInt(a.confidence) || 0));
  const confidence = bestVotes + '/' + totalRuns;
  const decidedWindows = perWindow.filter(a => a.decided && a.hits && a.hits.length);

  if (decidedWindows.length === 0) {
    return { decided: false, hits: [], confidence, needsReview: false,
      summary: 'Keine unternehmensrelevanten Bürokratiebelastungen gefunden',
      priority: 'nicht bewertet', business_relevance: 'niedrig', relief_potential: 'nicht bewertet',
      baymog_suitability: 'nicht bewertet', proposed_change: '', risks: '',
      legal_restrictions: legalBasis, mainCategory: 'sonstiges' };
  }

  // gleiche Belegstelle über Fenster hinweg -> Treffer mit den meisten Votes gewinnt
  const byPara = {};
  for (const a of decidedWindows) {
    for (const h of a.hits) {
      const k = normPara(h.paragraph);
      if (!byPara[k] || (parseInt(h.votes) || 0) > (parseInt(byPara[k].votes) || 0)) byPara[k] = h;
    }
  }
  const hits = Object.values(byPara).sort((a, b) => (parseInt(b.votes) || 0) - (parseInt(a.votes) || 0));
  const modeOf = f => {
    const c = {};
    for (const h of hits) { const v = h[f]; if (v) c[v] = (c[v] || 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || 'nicht bewertet';
  };

  return {
    decided: true,
    priority: hits.some(h => h.priority === 'A') ? 'A' : hits.some(h => h.priority === 'B') ? 'B' : 'C',
    mainCategory: modeOf('category'),
    business_relevance: modeOf('business_relevance'),
    relief_potential: modeOf('relief_potential'),
    baymog_suitability: modeOf('baymog_suitability'),
    proposed_change: hits.filter(h => h.proposed_change).map(h => h.proposed_change).join('; '),
    risks: hits.filter(h => h.risks).map(h => h.risks).join('; '),
    legal_restrictions: legalBasis,
    summary: decidedWindows.map(a => a.summary).filter(Boolean).sort((a, b) => b.length - a.length)[0] || '',
    hits,
    confidence,
    needsReview: bestVotes < totalRuns || legalBasis.length > 0
  };
}

if (require.main === module) {
  analyze().catch(console.error);
}

module.exports = { analyze };