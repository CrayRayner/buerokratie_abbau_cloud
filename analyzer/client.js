const config = require('../config.json');

async function analyzeWithLMStudio(prompt, docId, temperature, retries = 2) {
  const endpoint = config.lmStudioEndpoint;
  const model = config.model;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await doRequest(endpoint, model, prompt, docId, temperature);
    } catch (err) {
      if (err.message.includes('fetch failed') && attempt <= retries) {
        const wait = attempt * 5000;
        console.error(`  [LM] Retry ${attempt}/${retries} for ${docId} in ${wait}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function doRequest(endpoint, model, prompt, docId, temperature) {

  const body = {
    model: model,
    messages: [
      { role: 'system', content: 'Du bist ein hilfreicher Assistent, der Gesetzestexte auf Bürokratiebelastungen analysiert.' },
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
    ...(config.useJsonSchema ? { response_format: {
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
    }} : {})
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1200000)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LM Studio HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    let rawContent = data.choices?.[0]?.message?.content || '';
    const reasoningContent = data.choices?.[0]?.message?.reasoning_content || '';
    const reason = data.choices?.[0]?.finish_reason || 'unknown';

    // Qwen-Reasoning-Modelle legen Output gelegentlich in reasoning_content statt content
    // Nur als Fallback wenn reasoning_content mit einem JSON-Objekt beginnt
    if (!rawContent.trim() && reasoningContent.trim().startsWith('{')) {
      rawContent = reasoningContent;
    }

    // Empty content durch Token-Limit: als ungültig werfen (zählt nicht als 0-Hit-Stimme)
    if (!rawContent.trim() && reason === 'length') {
      throw new Error('Token-Limit erreicht, Antwort abgeschnitten');
    }

    if (!rawContent.trim()) {
      console.error(`  [LM] Empty content for ${docId} (finish: ${reason})`);
      return { hits: [], summary: '[LM Studio: empty content]' };
    }

    const usage = data.usage || {};
    if (usage.completion_tokens > 7000 || usage.total_tokens > 10000) {
      console.warn(`  [LM] Token high: ${usage.prompt_tokens}→${usage.completion_tokens} (${usage.total_tokens})`);
    }
    return parseResponse(rawContent);
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

function parseResponse(content) {
  content = content.trim();

  // Reasoning- und Markdown-Müll entfernen
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '');
  content = content.replace(/```json\s*/gi, '');
  content = content.replace(/```\s*/g, '');

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Kein JSON in LM Studio Antwort gefunden');
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

module.exports = { analyzeWithLMStudio };
