const path = require('path');
const Database = require('better-sqlite3');

// Standard: data/buerokratie.db. Fuer isolierte Test-/Vergleichslaeufe per
// Umgebungsvariable BUERO_DB auf eine andere Datei umleitbar.
const DB_PATH = process.env.BUERO_DB || path.join(__dirname, 'data', 'buerokratie.db');

let db;

function getDb() {
  if (db) return db;
  const fs = require('fs');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initSchema() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS crawl_jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      url           TEXT NOT NULL,
      doc_id        TEXT,
      title         TEXT,
      norm_type     TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      error         TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id         TEXT UNIQUE NOT NULL,
      title          TEXT NOT NULL,
      norm_type      TEXT NOT NULL,
      url            TEXT NOT NULL,
      text           TEXT,
      char_count     INTEGER DEFAULT 0,
      was_truncated  INTEGER DEFAULT 0,
      downloaded_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id           TEXT UNIQUE NOT NULL,
      priority         TEXT,
      category         TEXT,
      summary          TEXT,
      description      TEXT,
      business_relevance TEXT,
      relief_potential TEXT,
      baymog_suitability TEXT,
      proposed_change   TEXT,
      risks            TEXT,
      legal_restrictions TEXT,
      raw_response     TEXT,
      model            TEXT,
      was_summarized   INTEGER DEFAULT 0,
      confidence       TEXT,
      needs_review     INTEGER DEFAULT 0,
      run_session      TEXT,
      analyzed_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS raw_analyses (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id           TEXT NOT NULL,
      run_index        INTEGER NOT NULL,
      temperature      REAL,
      raw_response     TEXT,
      model            TEXT,
      run_session      TEXT,
      created_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reporting_duties (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id   INTEGER NOT NULL REFERENCES analyses(id),
      subject       TEXT,
      authority     TEXT,
      frequency     TEXT,
      has_sunset    INTEGER DEFAULT 0,
      has_evaluation INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS form_requirements (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id       INTEGER NOT NULL REFERENCES analyses(id),
      requirement_type  TEXT,
      could_be_electronic INTEGER DEFAULT 0,
      could_be_textform   INTEGER DEFAULT 0,
      digitalization_note TEXT
    );

    CREATE TABLE IF NOT EXISTS approval_procedures (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id       INTEGER NOT NULL REFERENCES analyses(id),
      procedure_type    TEXT,
      num_steps         INTEGER DEFAULT 1,
      multiple_authorities INTEGER DEFAULT 0,
      has_strict_deadline INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pipeline_status (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      phase         TEXT UNIQUE NOT NULL,
      total_count   INTEGER DEFAULT 0,
      done_count    INTEGER DEFAULT 0,
      last_run      TEXT,
      running       INTEGER DEFAULT 0
    );

    INSERT OR IGNORE INTO pipeline_status (phase, total_count, done_count, running) VALUES ('crawl', 0, 0, 0);
    INSERT OR IGNORE INTO pipeline_status (phase, total_count, done_count, running) VALUES ('analyze', 0, 0, 0);
  `);

  // Migration: add columns if missing (table already exists from prior runs)
  const existingRawCols = db.prepare("PRAGMA table_info(raw_analyses)").all().map(c => c.name);
  const existingAnaCols = db.prepare("PRAGMA table_info(analyses)").all().map(c => c.name);

  if (!existingAnaCols.includes('confidence')) {
    db.exec("ALTER TABLE analyses ADD COLUMN confidence TEXT");
  }
  if (!existingAnaCols.includes('needs_review')) {
    db.exec("ALTER TABLE analyses ADD COLUMN needs_review INTEGER DEFAULT 0");
  }
  if (!existingAnaCols.includes('run_session')) {
    db.exec("ALTER TABLE analyses ADD COLUMN run_session TEXT");
  }
  if (!existingRawCols.includes('run_session')) {
    db.exec("ALTER TABLE raw_analyses ADD COLUMN run_session TEXT");
  }

  return db;
}

function updatePipelineStatus(phase, delta = 0) {
  const db = getDb();
  if (delta !== 0) {
    db.prepare('UPDATE pipeline_status SET done_count = done_count + ?, last_run = datetime(\'now\') WHERE phase = ?').run(delta, phase);
  } else {
    db.prepare('UPDATE pipeline_status SET last_run = datetime(\'now\') WHERE phase = ?').run(phase);
  }
}

function setPipelineRunning(phase, running) {
  const db = getDb();
  db.prepare('UPDATE pipeline_status SET running = ? WHERE phase = ?').run(running ? 1 : 0, phase);
}

function setPipelineTotal(phase, total) {
  const db = getDb();
  db.prepare('UPDATE pipeline_status SET total_count = ? WHERE phase = ?').run(total, phase);
}

module.exports = { getDb, initSchema, updatePipelineStatus, setPipelineRunning, setPipelineTotal };
