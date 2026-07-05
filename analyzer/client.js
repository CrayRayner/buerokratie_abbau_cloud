// client.js — LLM-Anbindung der Erstanalyse. Zwei Provider:
//  - "openrouter": Cloud (z.B. deepseek/deepseek-v4-flash) mit Reasoning.
//    Braucht OPENROUTER_API_KEY in .env (siehe .env.example).
//  - "lmstudio" (Fallback/Default): lokal, 0 €, config.model via LM Studio.
const config = require('../config.json');
const { loadDotEnv } = require('../env');
const { Agent } = require('undici');
loadDotEnv();

const PROVIDER = config.analyzeProvider || 'lmstudio';

// Eigener Dispatcher: undici killt non-streaming-Requests sonst nach 300s
// (Headers-Timeout). Reasoning-Antworten brauchen länger bis zur ersten Antwort.
const dispatcher = new Agent({ headersTimeout: 1200000, bodyTimeout: 1200000, connectTimeout: 30000 });

// Effektiver Modellname des Erstlaufs — für raw_analyses/analyses (Provenienz).
function analyzeModelName() {
  return PROVIDER === 'openrouter'
    ? (config.analyzeOpenRouterModel || 'deepseek/deepseek-v4-flash')
    : config.model;
}

async function analyzeWithLLM(prompt, docId, temperature, retries = 2) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return PROVIDER === 'openrouter'
        ? await doOpenRouterRequest(prompt, docId, temperature)
        : await doLMStudioRequest(prompt, docId, temperature);
    } catch (err) {
      // Transiente Fehler: Netzwerk, Rate-Limit, Provider-5xx
      const transient = err.message.includes('fetch failed')
        || err.message.includes('HTTP 429')
        || /HTTP 5\d\d/.test(err.message);
      if (transient && attempt <= retries) {
        const wait = attempt * 5000;
        console.error(`  [LLM] Retry ${attempt}/${retries} for ${docId} in ${wait}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// Optionales striktes JSON-Schema (config.useJsonSchema) — identisch für beide Provider.
function jsonSchemaFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "buerokratie",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          hits: {
            type: "array", maxItems: 5,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                paragraph:          { type: "string" },
                category:           { type: "string",
                  enum: ["SCHRIFTFORM","BERICHTSPFLICHT","DOKUMENTATION","GENEHMIGUNG","ANZEIGE","NACHWEIS","SCHWELLENWERT","MEHRFACHZUSTÄNDIGKEIT"] },
                burden_type:        { type: "string" },
                priority:           { type: "string", enum: ["A","B","C"] },
                business_relevance: { type: "string", enum: ["hoch","mittel","niedrig"] },
                relief_potential:   { type: "string", enum: ["hoch","mittel","niedrig"] },
                baymog_suitability: { type: "string", enum: ["hoch","mittel","niedrig"] },
                proposed_change:    { type: "string" }
              },
              required: ["paragraph","category","burden_type","priority","business_relevance"]
            }
          },
          summary: { type: "string" }
        },
        required: ["hits","summary"]
      }
    }
  };
}

const SYSTEM_ROLE = 'Du bist ein hilfreicher Assistent, der Gesetzestexte auf Bürokratiebelastungen analysiert.';

async function doOpenRouterRequest(prompt, docId, temperature) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY fehlt — .env aus .env.example anlegen und Key eintragen.');

  const body = {
    model: analyzeModelName(),
    messages: [
      { role: 'system', content: SYSTEM_ROLE },
      { role: 'user', content: prompt }
    ],
    temperature: temperature,
    top_p: 0.95,
    max_tokens: config.maxTokens || 8192,
    stream: false,
    // DeepSeek V4 unterstützt effort 'high' | 'xhigh'
    ...(config.analyzeReasoningEffort ? { reasoning: { effort: config.analyzeReasoningEffort } } : {}),
    ...(config.useJsonSchema ? { response_format: jsonSchemaFormat() } : {})
  };

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://github.com/CrayRayner/buerokratie_abbau',
      'X-Title': 'Buerokratieabbau Bayern - Erstanalyse'
    },
    body: JSON.stringify(body),
    dispatcher,
    signal: AbortSignal.timeout(1200000)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter HTTP ${response.status}: ${errText.substring(0, 200)}`);
  }

  return handleCompletion(await response.json(), docId, 'OR');
}

async function doLMStudioRequest(prompt, docId, temperature) {
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_ROLE },
      { role: 'user', content: prompt }
    ],
    temperature: temperature,
    top_p: 0.95,
    top_k: 20,
    min_p: 0,
    presence_penalty: 0,
    frequency_penalty: 0,
    repeat_penalty: 1.1,
    max_tokens: config.maxTokens || 8192,
    stream: false,
    ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
    ...(config.useJsonSchema ? { response_format: jsonSchemaFormat() } : {})
  };

  try {
    const response = await fetch(config.lmStudioEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      dispatcher,
      signal: AbortSignal.timeout(1200000)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LM Studio HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }

    return handleCompletion(await response.json(), docId, 'LM');
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`LM Studio timeout for ${docId} (1200s)`);
    }
    if (err.message.includes('ECONNREFUSED')) {
      throw new Error('LM Studio nicht erreichbar. Läuft der Server auf http://127.0.0.1:1234?');
    }
    if (err.message.includes('Kein JSON')) {
      console.error(`  [LM] No JSON found in response`);
    }
    throw err;
  }
}

// Gemeinsame Antwort-Auswertung (beide Provider liefern OpenAI-kompatible Completions).
function handleCompletion(data, docId, tag) {
  const msg = data.choices?.[0]?.message || {};
  let rawContent = msg.content || '';
  // OpenRouter normalisiert Reasoning nach msg.reasoning; LM Studio nutzt reasoning_content
  const reasoningContent = msg.reasoning_content || msg.reasoning || '';
  const reason = data.choices?.[0]?.finish_reason || 'unknown';

  // Reasoning-Modelle legen Output gelegentlich in reasoning statt content ab.
  // Nur als Fallback wenn das Reasoning mit einem JSON-Objekt beginnt.
  if (!rawContent.trim() && reasoningContent.trim().startsWith('{')) {
    rawContent = reasoningContent;
  }

  // Empty content durch Token-Limit: als ungültig werfen (zählt nicht als 0-Hit-Stimme)
  if (!rawContent.trim() && reason === 'length') {
    throw new Error('Token-Limit erreicht, Antwort abgeschnitten');
  }

  if (!rawContent.trim()) {
    console.error(`  [${tag}] Empty content for ${docId} (finish: ${reason})`);
    return { hits: [], summary: `[${tag}: empty content]` };
  }

  const usage = data.usage || {};
  if (usage.completion_tokens > 7000 || usage.total_tokens > 10000) {
    console.warn(`  [${tag}] Token high: ${usage.prompt_tokens}→${usage.completion_tokens} (${usage.total_tokens})`);
  }
  return parseResponse(rawContent);
}

function parseResponse(content) {
  content = content.trim();

  // Reasoning- und Markdown-Müll entfernen
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '');
  content = content.replace(/```json\s*/gi, '');
  content = content.replace(/```\s*/g, '');

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Kein JSON in LLM-Antwort gefunden');
  }

  // Korrektes JSON per Brace-Counting extrahieren
  // Von der ersten { bis zur dazugehörigen } (ignoriert Nachlauf mit }-Zeichen)
  function extractBalanced(text) {
    let depth = 0, start = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') { if (depth === 0) start = i; depth++; }
      else if (text[i] === '}') { depth--; if (depth === 0 && start >= 0) return text.substring(start, i + 1); }
      else if (text[i] === '"') { i++; while (i < text.length && (text[i] !== '"' || text[i - 1] === '\\')) i++; }
    }
    return text;
  }

  const balanced = extractBalanced(jsonMatch[0]);

  try {
    return JSON.parse(balanced);
  } catch (err) {
    const fixed = balanced
      .replace(/'/g, '"')
      .replace(/(\w+):/g, '"$1":')
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/\\"/g, "'");

    try {
      return JSON.parse(fixed);
    } catch {
      throw new Error(`JSON parse error: ${err.message}`);
    }
  }
}

module.exports = { analyzeWithLLM, analyzeModelName, PROVIDER };
