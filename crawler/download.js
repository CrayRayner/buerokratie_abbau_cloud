const { getDb } = require('../db');

async function downloadDocument(doc) {
  const fullUrl = `https://www.gesetze-bayern.de/Content/Document/${doc.doc_id}/true`;
  const result = await fetchFullText(fullUrl);

  if (!result || !result.text || result.text.length < 10) {
    console.log(`  [DOWNLOAD] Empty text for ${doc.doc_id}, trying single view...`);
    const singleUrl = `https://www.gesetze-bayern.de/Content/Document/${doc.doc_id}`;
    const singleResult = await fetchFullText(singleUrl);
    if (!singleResult || !singleResult.text || singleResult.text.length < 10) {
      console.log(`  [DOWNLOAD] SKIP ${doc.doc_id} - no text content`);
      return null;
    }
    return { ...doc, ...singleResult };
  }

  return { ...doc, ...result };
}

async function fetchFullText(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8'
      }
    });

    if (!response.ok) {
      console.error(`  [DOWNLOAD] HTTP ${response.status} for ${url}`);
      return null;
    }

    const html = await response.text();
    return parseTextFromHtml(html, url);
  } catch (err) {
    console.error(`  [DOWNLOAD] Network error for ${url}:`, err.message);
    return null;
  }
}

function parseTextFromHtml(html, url) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);

  const title = $('h1.titelzeile').text().trim() || $('title').text().split('-')[0].trim();

  const textParts = [];
  $('.cont').each((i, el) => {
    $(el).children().each((j, ch) => {
      const $ch = $(ch);
      if ($ch.prop('tagName') === 'TABLE') {
        const rows = [];
        $ch.find('tr').each((r, tr) => {
          const cells = $(tr).find('th,td').map((c, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
          if (cells.join('').trim()) rows.push(cells.join(' | '));
        });
        if (rows.length) textParts.push(rows.join('\n'));
      } else {
        const t = $ch.text().trim();
        if (t) textParts.push(t);
      }
    });
  });

  const text = textParts.join('\n\n');
  return { text, title, char_count: text.length };
}

async function saveDocument(doc) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO documents (doc_id, title, norm_type, url, text, char_count, was_truncated, downloaded_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))
  `).run(doc.doc_id, doc.title || doc.doc_id, doc.norm_type || 'rechtsverordnung', doc.url, doc.text, doc.text.length);
}

module.exports = { downloadDocument, saveDocument };
