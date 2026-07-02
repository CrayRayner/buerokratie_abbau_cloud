const { chromium } = require('playwright');

const BASE_URL = 'https://www.gesetze-bayern.de';

const EXCLUDE_IDS = ['Rss','ffn','ffn-mbl','Hilfe','Datenschutz','Impressum','Barrierefreiheit','Datenschutz'];

async function discoverDocuments(config) {
  console.log('[DISCOVER] Starting Playwright discovery...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'de-DE' });
  const page = await context.newPage();

  const allDocs = new Map();

  try {
    // Direct filter URLs — no search needed, returns ALL docs per type
    const normTypes = [
      { param: 'NORMTYP/rv', label: 'Rechtsverordnungen' },
      { param: 'NORMTYP/ges', label: 'Gesetze' },
    //  { param: 'NORMTYP/vw', label: 'Verwaltungsvorschriften' },
    //  { param: 'NORMTYP/vtr', label: 'Verträge' },
    ];

    for (const { param, label } of normTypes) {
      console.log(`[DISCOVER] Fetching ${label}...`);

      // First request to get total hit count and page links
      await page.goto(`${BASE_URL}/Search/Filter/${param}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1500);

      // Extract hit count from body
      const body = await page.textContent('body');
      const hitMatch = body.match(/([\d.]+)\s*Treffer/i);
      const totalHits = hitMatch ? parseInt(hitMatch[1].replace(/\./g, '')) : 0;
      const totalPages = Math.ceil(totalHits / 10);
      console.log(`  ${totalHits} hits, ~${totalPages} pages`);

      // Get page links to find max page from pagination
      const pageNums = await page.$$eval('a[href*="/Search/Page/"]', as =>
        as.map(a => parseInt(a.textContent.trim())).filter(n => !isNaN(n))
      );
      const maxPagination = Math.max(...pageNums, 0);
      console.log(`  Pagination shows pages 1-${maxPagination}`);

      // Iterate all pages
      for (let p = 1; p <= totalPages; p++) {
        const pageUrl = p === 1
          ? `${BASE_URL}/Search/Filter/${param}`
          : `${BASE_URL}/Search/Page/${p}`;

        await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(800);

        const ids = await page.$$eval('a[href*="/Content/Document/"]', (anchors, exclude) => {
          return anchors.map(a => {
            const href = a.href;
            const id = href.split('/Content/Document/')[1]?.split('?')[0];
            const title = a.title || a.textContent.trim();
            return { id, title: title.substring(0, 200) };
          }).filter(({ id }) => {
            if (!id) return false;
            if (exclude.includes(id)) return false;
            if (id.includes('#')) return false;
            return true;
          });
        }, EXCLUDE_IDS);

        for (const doc of ids) {
          if (!allDocs.has(doc.id)) {
            allDocs.set(doc.id, {
              doc_id: doc.id,
              title: doc.title,
              url: `${BASE_URL}/Content/Document/${doc.id}`,
              norm_type: param === 'NORMTYP/rv' ? 'rechtsverordnung'
                       : param === 'NORMTYP/ges' ? 'gesetz'
                       : 'verwaltungsvorschrift'
            });
          }
        }

        if (p % 10 === 0 || p === totalPages) {
          console.log(`  Page ${p}/${totalPages}: ${ids.length} docs (total unique: ${allDocs.size})`);
        }
      }
    }

    console.log(`[DISCOVER] Total unique documents: ${allDocs.size}`);

    const rvs = [...allDocs.values()].filter(d => d.norm_type === 'rechtsverordnung');
    const gesetze = [...allDocs.values()].filter(d => d.norm_type === 'gesetz');
    console.log(`  Rechtsverordnungen: ${rvs.length}`);
    console.log(`  Gesetze: ${gesetze.length}`);

    if (rvs.length > 0) {
      console.log('  Sample RV:', rvs.slice(0, 10).map(d => d.doc_id).join(', '));
    }
    if (gesetze.length > 0) {
      console.log('  Sample Gesetze:', gesetze.slice(0, 10).map(d => d.doc_id).join(', '));
    }

  } catch (err) {
    console.error('[DISCOVER] Error:', err.message);
  } finally {
    await browser.close();
  }

  return [...allDocs.values()];
}

module.exports = { discoverDocuments };
