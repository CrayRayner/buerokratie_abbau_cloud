const { initSchema, getDb } = require('./db');

async function showStatus() {
  const db = initSchema();

  const pipeStatus = db.prepare('SELECT * FROM pipeline_status').all();
  console.log('\n=== PIPELINE STATUS ===');
  for (const ps of pipeStatus) {
    const icon = ps.running ? '\u25B6' : ps.done_count > 0 ? '\u2713' : '\u25CB';
    console.log(`  ${icon} ${ps.phase}: ${ps.done_count}/${ps.total_count} (running: ${ps.running > 0})`);
  }

  const docCount = db.prepare('SELECT COUNT(*) as c FROM documents').get();
  const textCount = db.prepare('SELECT COUNT(*) as c FROM documents WHERE text IS NOT NULL').get();
  const crawlCount = db.prepare('SELECT COUNT(*) as c FROM crawl_jobs').get();
  const analysisCount = db.prepare('SELECT COUNT(*) as c FROM analyses WHERE priority IS NOT NULL').get();
  const errorCount = db.prepare("SELECT COUNT(*) as c FROM analyses WHERE description LIKE 'ERROR:%'").get();
  const aCount = db.prepare("SELECT COUNT(*) as c FROM analyses WHERE priority = 'A'").get();
  const bCount = db.prepare("SELECT COUNT(*) as c FROM analyses WHERE priority = 'B'").get();

  console.log(`\n  Documents in DB: ${docCount.c}`);
  console.log(`  With text: ${textCount.c}`);
  console.log(`  Crawl jobs: ${crawlCount.c}`);
  console.log(`  Analyzed: ${analysisCount.c}`);
  console.log(`  Errors: ${errorCount.c}`);
  console.log(`  Priority A: ${aCount.c}`);
  console.log(`  Priority B: ${bCount.c}`);

  if (analysisCount.c > 0) {
    console.log('\n  Top categories:');
    const cats = db.prepare('SELECT category, COUNT(*) as c FROM analyses WHERE category IS NOT NULL GROUP BY category ORDER BY c DESC LIMIT 5').all();
    for (const cat of cats) {
      console.log(`    ${cat.category}: ${cat.c}`);
    }
  }
  console.log('');
}

async function runPipeline() {
  console.log('=== PIPELINE: CRAWL + ANALYZE ===');

  const { crawl } = require('./crawler/index');
  await crawl();

  const { analyze } = require('./analyzer/index');
  await analyze();

  console.log('=== PIPELINE COMPLETE ===');
  await showStatus();
}

if (process.argv.includes('--status')) {
  showStatus().catch(console.error);
} else if (process.argv.includes('--analyze')) {
  const { analyze } = require('./analyzer/index');
  analyze().catch(console.error);
} else {
  runPipeline().catch(console.error);
}
