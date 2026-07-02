const { initSchema, getDb, setPipelineRunning, setPipelineTotal, updatePipelineStatus } = require('../db');
const { discoverDocuments } = require('./discover');
const { downloadDocument, saveDocument } = require('./download');
const config = require('../config.json');

async function crawl() {
  console.log('=== CRAWL PHASE ===');
  const db = initSchema();
  setPipelineRunning('crawl', true);

  try {
    const pendingCount = db.prepare('SELECT COUNT(*) as c FROM documents WHERE downloaded_at IS NULL').get().c;

    if (pendingCount > 0) {
      console.log(`[CRAWL] ${pendingCount} documents already in DB, skipping discovery`);
    } else {
      console.log('[CRAWL] Starting discovery...');
      const discovered = await discoverDocuments(config);
      setPipelineTotal('crawl', discovered.length);

      for (const d of discovered) {
        db.prepare(`
          INSERT OR IGNORE INTO crawl_jobs (url, doc_id, title, norm_type, status)
          VALUES (?, ?, ?, ?, 'pending')
        `).run(d.url, d.doc_id, d.title, d.norm_type);
      }

      console.log(`[CRAWL] Discovery complete: ${discovered.length} documents`);
    }

    const pendingJobs = db.prepare(`
      SELECT cj.* FROM crawl_jobs cj
      LEFT JOIN documents d ON d.doc_id = cj.doc_id AND d.text IS NOT NULL
      WHERE d.doc_id IS NULL
    `).all();

    const maxDocs = config.maxDownloadDocs || 0;
    const downloadList = maxDocs > 0 ? pendingJobs.slice(0, maxDocs) : pendingJobs;
    console.log(`[CRAWL] Downloading ${downloadList.length} documents...`);

    let done = 0;
    let errors = 0;
    const total = downloadList.length;

    for (const job of downloadList) {
      try {
        console.log(`[CRAWL] [${done + 1}/${total}] ${job.doc_id} - ${job.title?.substring(0, 60)}`);
        const doc = await downloadDocument(job);
        if (doc && doc.text) {
          await saveDocument(doc);
          db.prepare('UPDATE crawl_jobs SET status = ? WHERE id = ?').run('done', job.id);
          done++;
          updatePipelineStatus('crawl', 1);
        } else {
          db.prepare('UPDATE crawl_jobs SET status = ?, error = ? WHERE id = ?').run('empty', 'No text extracted', job.id);
          errors++;
          updatePipelineStatus('crawl', 1);
        }
      } catch (err) {
        console.error(`  [CRAWL] Error downloading ${job.doc_id}:`, err.message);
        db.prepare('UPDATE crawl_jobs SET status = ?, error = ? WHERE id = ?').run('error', err.message, job.id);
        errors++;
        updatePipelineStatus('crawl', 1);
      }

      if (config.requestDelayMs > 0) {
        await new Promise(r => setTimeout(r, config.requestDelayMs));
      }
    }

    console.log(`[CRAWL] Done: ${done} downloaded, ${errors} errors`);
  } catch (err) {
    console.error('[CRAWL] Fatal:', err);
  } finally {
    setPipelineRunning('crawl', false);
  }
}

if (require.main === module) {
  crawl().catch(console.error);
}

module.exports = { crawl };
