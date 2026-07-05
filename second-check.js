// second-check.js — Kritischer Zweitcheck der Reform-Shortlist (A/B) durch ein
// UNABHÄNGIGES, stärkeres Modell. Zwei Provider:
//  - "openrouter" (Standard): Cloud, z.B. z-ai/glm-5.2 — schnell, kein LM-Studio-
//    Eigenheiten-Risiko. Braucht OPENROUTER_API_KEY in .env (siehe .env.example).
//  - "lmstudio": lokal, 0 €, aber langsamer und je nach Modell/Quant mit Eigenheiten
//    (z.B. manche Reasoning-Modelle denken nur OHNE system-Rolle — siehe README).
// Überschreibt NICHTS vom Erstlauf — schreibt Urteil in analyses.second_check und
// setzt needs_review bei Beanstandung. Läuft IMMER auf Reform-Priorität A+B.
// Resumability: bereits geprüfte Docs werden übersprungen (kein doppeltes Abrechnen).
//
// Nutzung:  node second-check.js            (A+B, überspringt bereits Geprüfte)
//           node second-check.js --force    (erzwingt Re-Check aller A+B-Docs)
// Isolierter Test:  BUERO_DB="…/kopie.db" node second-check.js

const { getDb } = require('./db');
const config = require('./config.json');
const { bestHitPriority, parseHits, reformPriority } = require('./classify');
const { Agent } = require('undici');

// .env-Loader: gemeinsames Modul (env.js) — auch von analyzer/client.js genutzt.
const { loadDotEnv } = require('./env');
loadDotEnv();

const PROVIDER = config.secondCheckProvider || 'openrouter';

// Eigener Dispatcher: undici killt non-streaming-Requests sonst nach 300s
// (Headers-Timeout). Reasoning-Antworten brauchen länger bis zur ersten Antwort.
const dispatcher = new Agent({ headersTimeout: 1200000, bodyTimeout: 1200000, connectTimeout: 30000 });
// Check-Urteil ist klein → Ausgabe bewusst begrenzen (kein Runaway).
const CHECK_MAX_TOKENS = config.secondCheckMaxTokens || 16000;

// WICHTIG (nur lmstudio): das GELADENE Modell ansprechen (nicht config.model = Qwen!),
// sonst lädt LM Studio per JIT ein zweites Modell dazu → beide im VRAM → alles langsam.
let CHECK_MODEL = config.secondCheckModel || null;
async function resolveModel() {
  if (CHECK_MODEL) return CHECK_MODEL; // explizit gesetzt = foolproof
  // sonst: das TATSÄCHLICH geladene Modell aus LM Studios nativer API (hat state-Feld;
  // /v1/models listet dagegen ALLE heruntergeladenen → unbrauchbar).
  const base = config.lmStudioEndpoint.replace(/\/v1\/.*$/, '');
  const res = await fetch(base + '/api/v0/models', { dispatcher });
  const d = await res.json();
  const loaded = (d.data || []).filter(m => m.state === 'loaded').map(m => m.id);
  if (loaded.length === 1) { CHECK_MODEL = loaded[0]; return CHECK_MODEL; }
  throw new Error(loaded.length === 0
    ? 'Kein Modell geladen (oder idle-entladen). Setze config.secondCheckModel auf die geladene Modell-ID.'
    : `Mehrere Modelle geladen: ${loaded.join(', ')}. Setze config.secondCheckModel eindeutig.`);
}

// Reform-Priorität: siehe classify.js (gemeinsames Modul).

const MAX_PROPOSALS = 12; // Ausgabe begrenzen; sehr treffer-reiche Docs oben kappen

const SYSTEM = `Du bist ein kritischer, unabhängiger juristischer Gegenprüfer für ein Bürokratieabbau-Projekt in Bayern.
Ein ERSTES Modell hat zu einer Norm MEHRERE einzelne Reformvorschläge markiert. Du bekommst sie NUMMERIERT.
Bewerte JEDEN Vorschlag EINZELN und begründe NUR zu genau diesem Vorschlag — NICHT zum ganzen Gesetz.
Prüfe je Vorschlag:
1) UNTERNEHMENSBINDUNG: Belastet die zitierte Pflicht tatsächlich UNTERNEHMEN? Reine Zuständigkeits-/Organisations-/Behördenregeln sind KEINE Unternehmensbelastung.
2) RECHTSBINDUNG: Ist DIESER Vorschlag mit der Rechtsbindung vereinbar? Bei EU/Bund darf die SUBSTANZ nicht einseitig gekürzt werden (Digitalisierung/Verfahren ist ok).
3) HEBEL-RICHTUNG: Reduziert DIESER Vorschlag wirklich Bürokratie? (Meldefrist verkürzen = mehr Last; Aufbewahrungsfrist verkürzen = weniger Last; Schwelle SENKEN = mehr Last, ANHEBEN = weniger Last.)
4) BELEG-PLAUSIBILITÄT: Passt die Belegstelle zum behaupteten Belastungstyp?

WICHTIG für gültiges JSON: Verwende in "begruendung" KEINERLEI Anführungszeichen
(weder „…", noch "…", noch '…') um Begriffe hervorzuheben — das bricht die JSON-
Antwort. Schreibe Begriffe ohne Anführungszeichen oder mit *Sternchen* hervorgehoben.

Antworte AUSSCHLIESSLICH mit einem JSON-ARRAY — GENAU ein Objekt pro Vorschlag, gleiche Nummerierung, keine Einleitung:
[
  {"nr": 1, "unternehmensbindung": "ja|nein|unklar", "rechtsbindung_respektiert": "ja|nein|unklar", "hebel_richtung_korrekt": "ja|nein|unklar", "beleg_plausibel": "ja|nein|unklar", "empfehlung": "behalten|herabstufen|verwerfen", "begruendung": "1-2 Sätze, NUR zu diesem Vorschlag"}
]`;

function buildPrompt(row, hits) {
  const n = Math.min(hits.length, MAX_PROPOSALS);
  const list = hits.slice(0, n).map((h, i) =>
    `${i + 1}. Belegstelle: "${(h.paragraph || '').slice(0, 240)}"\n   Pflichttyp: ${h.category || '?'}\n   Vorschlag: ${(h.proposed_change || '—').slice(0, 280)}`
  ).join('\n\n');
  return `GESETZ: ${row.title}
RECHTSBINDUNG (deterministisch ermittelt): ${row.legal_restrictions || 'Landesrecht (frei kürzbar)'}

Es folgen ${n} EINZELNE Reformvorschläge. Bewerte jeden einzeln und gib ein JSON-Array mit GENAU ${n} Objekten zurück:

${list}`;
}

function parseVerdicts(content) {
  content = (content || '').trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  const m = content.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('kein JSON-Array in Antwort');
  let arr;
  try { arr = JSON.parse(m[0]); }
  catch { arr = JSON.parse(m[0].replace(/,(\s*[}\]])/g, '$1')); }
  if (!Array.isArray(arr)) throw new Error('Antwort ist kein Array');
  return arr;
}

async function callOpenRouter(prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY fehlt — .env aus .env.example anlegen und Key eintragen.');
  const model = config.secondCheckOpenRouterModel || 'z-ai/glm-5.2';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://github.com/CrayRayner/buerokratie_abbau',
      'X-Title': 'Buerokratieabbau Bayern - Zweitcheck'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: CHECK_MAX_TOKENS,
      reasoning: { effort: config.secondCheckReasoningEffort || 'high' } // 'high' | 'xhigh' (max)
    }),
    dispatcher,
    signal: AbortSignal.timeout(600000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  const finish = data.choices?.[0]?.finish_reason;
  if (finish === 'length') console.warn('    [!] Antwort bei max_tokens abgeschnitten (finish_reason=length) — secondCheckMaxTokens erhöhen.');
  let content = msg.content || '';
  const rc = msg.reasoning_content || msg.reasoning || '';
  if (!content.trim() && (rc.trim().startsWith('[') || rc.trim().startsWith('{'))) content = rc;
  return parseVerdicts(content);
}

async function callLMStudio(prompt) {
  const res = await fetch(config.lmStudioEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      model: CHECK_MODEL,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
      temperature: 0.3, top_p: 0.95, top_k: 20, min_p: 0,
      presence_penalty: 0, frequency_penalty: 0, repeat_penalty: 1.1,
      max_tokens: CHECK_MAX_TOKENS, stream: false,
      ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {})
    }),
    dispatcher,
    signal: AbortSignal.timeout(1200000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const data = await res.json();
  let content = data.choices?.[0]?.message?.content || '';
  const rc = data.choices?.[0]?.message?.reasoning_content || '';
  if (!content.trim() && (rc.trim().startsWith('[') || rc.trim().startsWith('{'))) content = rc;
  return parseVerdicts(content);
}

async function callLLM(prompt) {
  return PROVIDER === 'openrouter' ? callOpenRouter(prompt) : callLMStudio(prompt);
}

function flagged(v) {
  return !!v && (v.unternehmensbindung === 'nein' || v.rechtsbindung_respektiert === 'nein' ||
    v.hebel_richtung_korrekt === 'nein' || v.beleg_plausibel === 'nein' ||
    v.empfehlung === 'verwerfen' || v.empfehlung === 'herabstufen');
}

async function main() {
  const WANTED = 'AB'; // Zweitcheck läuft immer auf Reform-Priorität A+B (kein Argument mehr nötig)
  const force = process.argv[2] === '--force'; // erzwingt Re-Check bereits geprüfter Docs
  const db = getDb();
  try { db.exec('ALTER TABLE analyses ADD COLUMN second_check TEXT'); } catch { /* existiert schon */ }

  if (PROVIDER === 'openrouter') {
    if (!process.env.OPENROUTER_API_KEY) {
      console.error('[ZWEITCHECK] OPENROUTER_API_KEY fehlt. .env.example nach .env kopieren und Key eintragen.');
      process.exit(1);
    }
    console.log(`[ZWEITCHECK] Provider: OpenRouter — Modell: ${config.secondCheckOpenRouterModel || 'z-ai/glm-5.2'}`);
  } else {
    const model = await resolveModel();
    console.log(`[ZWEITCHECK] Provider: LM Studio — Ziel-Modell (geladen): ${model}`);
  }

  const rows = db.prepare(`
    SELECT a.doc_id, a.priority, a.description, a.legal_restrictions, a.business_relevance,
           a.needs_review, a.second_check, d.title
    FROM analyses a JOIN documents d ON d.doc_id = a.doc_id
    WHERE a.analyzed_at >= d.downloaded_at AND a.priority IN ('A','B','C')
    ORDER BY a.doc_id
  `).all();

  // Resumability: bereits geprüfte Docs überspringen (kein doppeltes Abrechnen bei
  // erneutem Lauf) — genau wie beim Haupt-Analyzer. --force erzwingt Re-Check.
  // Auswahl per bestHitPriority (bestes Pro-Vorschlag-Ergebnis), NICHT Doc-Schnitt —
  // sonst rutschen Docs durch, deren Doc-Mittel C ist, die aber einzelne A/B-würdige
  // Vorschläge haben (real passiert: BayGutAV, Bund + mode=mittel → Doc C, aber
  // hoch-Treffer → B im Dashboard, ohne je einen Zweitcheck bekommen zu haben).
  const skippedDone = rows.filter(r => r.second_check && !force).length;
  const shortlist = rows.filter(r => {
    if (r.second_check && !force) return false;
    const p = bestHitPriority(r.legal_restrictions, r.business_relevance, parseHits(r.description));
    return WANTED.includes(p);
  });
  if (skippedDone) console.log(`[ZWEITCHECK] ${skippedDone} bereits geprüfte Docs übersprungen (--force zum Erzwingen).`);

  console.log(`[ZWEITCHECK] ${shortlist.length} Docs zu prüfen (Reform-Prio A/B)`);
  let checked = 0, flags = 0;

  for (const r of shortlist) {
    let hits = [];
    try { hits = JSON.parse(r.description || '[]'); } catch { hits = []; }
    if (!hits.length) continue;
    try {
      const verdicts = await callLLM(buildPrompt(r, hits));
      // Urteile an die Treffer ausrichten: nach nr, sonst nach Position. Länge = hits.length.
      const aligned = hits.map((h, i) => {
        const byNr = verdicts.find(v => Number(v.nr) === i + 1);
        return byNr || verdicts[i] || null;
      });
      const flaggedCount = aligned.filter(flagged).length;
      const nr = flaggedCount > 0 ? 1 : r.needs_review;
      db.prepare('UPDATE analyses SET second_check = ?, needs_review = ? WHERE doc_id = ?')
        .run(JSON.stringify(aligned), nr, r.doc_id);
      checked++; if (flaggedCount > 0) flags++;
      const counts = {};
      for (const v of aligned) if (v && v.empfehlung) counts[v.empfehlung] = (counts[v.empfehlung] || 0) + 1;
      const summ = Object.entries(counts).map(([k, n]) => `${n}×${k}`).join(' ') || '—';
      console.log(`  ${flaggedCount ? '⚠ ' : '✓ '}${r.doc_id.padEnd(16)} [${summ}] ${r.title.slice(0, 42)}`);
    } catch (e) {
      console.error(`  ✗ ${r.doc_id}: ${e.message}`);
    }
  }
  console.log(`[ZWEITCHECK] fertig: ${checked} geprüft, ${flags} mit Beanstandung (→ needs_review).`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
// Kein Re-Export von reformPriority mehr — einzige Quelle ist classify.js.
