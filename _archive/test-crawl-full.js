const { chromium } = require('playwright');
const cheerio = require('cheerio');

async function getTextWithPlaywright(id) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // Fetch /true URL with Playwright (JS enabled)
  await page.goto(`https://www.gesetze-bayern.de/Content/Document/${id}/true`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);
  
  // Try clicking expand buttons
  const btns = await page.$$('button, a[class*="expand"], a[class*="mehr"], .show-more, .toggle');
  console.log(`${id}: ${btns.length} expandable elements found`);
  for (const btn of btns) {
    try { await btn.click(); await page.waitForTimeout(300); } catch {}
  }
  
  // Extract same way as download.js: .cont .paratext
  const textParts = await page.$$eval('.cont', els => {
    const parts = [];
    for (const el of els) {
      const paras = el.querySelectorAll('.paratext');
      if (paras.length > 0) {
        paras.forEach(p => {
          const t = p.textContent.trim();
          if (t) parts.push(t);
        });
      } else {
        const titleLine = el.querySelector('h1.absatz');
        if (titleLine) parts.push(titleLine.textContent.trim());
      }
    }
    return parts;
  });
  
  const pwText = textParts.join('\n\n');
  
  // Now fetch same URL with raw HTTP (no JS)
  const resp = await fetch(`https://www.gesetze-bayern.de/Content/Document/${id}/true`);
  const html = await resp.text();
  const $ = cheerio.load(html);
  const httpParts = [];
  $('.cont').each((i, el) => {
    const paras = $(el).find('.paratext');
    if (paras.length > 0) {
      paras.each((j, p) => { const t = $(p).text().trim(); if (t) httpParts.push(t); });
    } else {
      const titleLine = $(el).find('h1.absatz').text().trim();
      if (titleLine) httpParts.push(titleLine);
    }
  });
  const httpText = httpParts.join('\n\n');
  
  console.log(`${id}: Playwright len=${pwText.length}, fetch len=${httpText.length}, diff=${pwText.length - httpText.length}`);
  
  // Try fetching sub-articles individually
  // Some laws have expandable children that load via separate URLs
  // Look for links like /Content/Document/BayBO-XXX
  const subLinks = await page.$$eval('a[href*="/Content/Document/' + id + '"]', as => 
    as.map(a => a.href).filter(h => {
      const after = h.split('/Content/Document/')[1];
      return after && after.includes('-') && !after.includes('#') && !after.includes('?');
    })
  );
  console.log(`${id}: Sub-article links: ${subLinks.length}`);
  
  await browser.close();
  return { pwText, httpText, subLinks };
}

(async () => {
  for (const id of ['BayBO', 'BayHIG', 'BayWG']) {
    await getTextWithPlaywright(id);
    console.log();
  }
})().catch(e => { console.error(e.message); process.exit(1); });
