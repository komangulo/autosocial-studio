const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SCHEMA_VERSION = 9;

const MIGRATIONS = [
  () => {},
  (db) => db.exec(`
    ALTER TABLE studio_documents ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
    ALTER TABLE studio_documents ADD COLUMN parent_version INTEGER;
    ALTER TABLE studio_documents ADD COLUMN change_note TEXT NOT NULL DEFAULT '';
    CREATE TABLE studio_assets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL, kind TEXT NOT NULL, mime_type TEXT NOT NULL, original_name TEXT NOT NULL,
      storage_name TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
      metadata_json TEXT, created_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE INDEX studio_assets_project_created ON studio_assets(account_id, project_id, deleted_at, created_at DESC);
    CREATE INDEX studio_documents_versions ON studio_documents(project_id, kind, version DESC);
  `),
  (db) => db.exec(`
    CREATE TABLE studio_renders (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL, timeline_version INTEGER NOT NULL, preset TEXT NOT NULL, status TEXT NOT NULL,
      job_id TEXT REFERENCES studio_jobs(id) ON DELETE SET NULL, output_asset_id TEXT REFERENCES studio_assets(id) ON DELETE SET NULL,
      error_json TEXT, progress INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX studio_renders_project_created ON studio_renders(account_id, project_id, created_at DESC);
    CREATE TABLE studio_publications (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL, render_id TEXT NOT NULL REFERENCES studio_renders(id) ON DELETE CASCADE,
      platform TEXT NOT NULL, idempotency_key TEXT NOT NULL, status TEXT NOT NULL, scheduled_at TEXT,
      caption TEXT NOT NULL DEFAULT '', options_json TEXT NOT NULL DEFAULT '{}', queue_path TEXT,
      blocked_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX studio_publications_idempotency ON studio_publications(account_id, idempotency_key);
    CREATE INDEX studio_publications_project_created ON studio_publications(account_id, project_id, created_at DESC);
  `),
  (db) => db.exec(`
    CREATE INDEX studio_events_account_id ON studio_events(account_id, id);
    CREATE INDEX studio_jobs_project_created ON studio_jobs(account_id, project_id, created_at DESC);
    CREATE INDEX studio_job_dependencies_reverse ON studio_job_dependencies(depends_on_job_id, job_id);
  `),
  (db) => db.exec(`
    CREATE INDEX studio_documents_status ON studio_documents(project_id, kind, status, version DESC);
    CREATE INDEX studio_assets_sha ON studio_assets(account_id, project_id, sha256);
  `),
  (db) => db.exec(`
    ALTER TABLE studio_assets ADD COLUMN storage_area TEXT NOT NULL DEFAULT 'originals';
  `),
  (db) => db.exec(`
    UPDATE studio_documents
    SET status = CASE
      WHEN version = (
        SELECT MAX(newest.version)
        FROM studio_documents newest
        WHERE newest.project_id = studio_documents.project_id
          AND newest.kind = studio_documents.kind
          AND newest.approved_at IS NOT NULL
      ) THEN 'approved'
      ELSE 'superseded'
    END
    WHERE approved_at IS NOT NULL;
  `),
  (db) => db.exec(`
    CREATE TABLE studio_asset_derivatives (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
      source_asset_id TEXT NOT NULL REFERENCES studio_assets(id) ON DELETE CASCADE,
      derivative_asset_id TEXT NOT NULL REFERENCES studio_assets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      settings_hash TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(account_id, project_id, source_asset_id, kind, settings_hash)
    );
    CREATE INDEX studio_asset_derivatives_source ON studio_asset_derivatives(account_id, project_id, source_asset_id, kind, created_at DESC);
    CREATE INDEX studio_asset_derivatives_output ON studio_asset_derivatives(derivative_asset_id);
  `),
  (db) => {
    const renderColumns = new Set(db.pragma("table_info(studio_renders)").map((column) => column.name));
    if (!renderColumns.has("options_json")) db.exec("ALTER TABLE studio_renders ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'");
    const publicationColumns = new Set(db.pragma("table_info(studio_publications)").map((column) => column.name));
    const additions = {
      remote_status: "TEXT",
      remote_id: "TEXT",
      remote_url: "TEXT",
      confirmation_json: "TEXT",
      published_at: "TEXT",
    };
    for (const [name, type] of Object.entries(additions)) if (!publicationColumns.has(name)) db.exec(`ALTER TABLE studio_publications ADD COLUMN ${name} ${type}`);
    db.exec("CREATE INDEX IF NOT EXISTS studio_publications_remote_status ON studio_publications(account_id, remote_status, updated_at DESC)");
  },
];

class StudioDatabase {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.db = new Database(this.filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
    try { fs.chmodSync(this.filePath, 0o600); } catch {}
  }

  migrate() {
    let version = this.db.pragma("user_version", { simple: true });
    if (version > SCHEMA_VERSION) throw new Error(`Studio database schema ${version} is newer than supported schema ${SCHEMA_VERSION}.`);
    if (version === 0) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE studio_projects (
            id TEXT PRIMARY KEY, account_id TEXT NOT NULL, title TEXT NOT NULL, content_type TEXT NOT NULL,
            objective TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'es',
            target_duration_seconds INTEGER NOT NULL, aspect_ratio TEXT NOT NULL, width INTEGER NOT NULL,
            height INTEGER NOT NULL, fps INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
            current_stage TEXT NOT NULL DEFAULT 'brief', revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
          );
          CREATE INDEX studio_projects_account_updated ON studio_projects(account_id, archived_at, updated_at DESC);
          CREATE TABLE studio_documents (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
            kind TEXT NOT NULL, version INTEGER NOT NULL, content_json TEXT NOT NULL, approved_at TEXT,
            created_at TEXT NOT NULL, UNIQUE(project_id, kind, version)
          );
          CREATE TABLE studio_jobs (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
            account_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, dedupe_key TEXT,
            input_json TEXT NOT NULL DEFAULT '{}', result_json TEXT, error_json TEXT,
            progress_current INTEGER NOT NULL DEFAULT 0, progress_total INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 1,
            scheduled_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT, heartbeat_at TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
          );
          CREATE UNIQUE INDEX studio_jobs_dedupe ON studio_jobs(account_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
          CREATE INDEX studio_jobs_claim ON studio_jobs(status, scheduled_at, type);
          CREATE TABLE studio_job_dependencies (
            job_id TEXT NOT NULL REFERENCES studio_jobs(id) ON DELETE CASCADE,
            depends_on_job_id TEXT NOT NULL REFERENCES studio_jobs(id) ON DELETE CASCADE,
            PRIMARY KEY(job_id, depends_on_job_id), CHECK(job_id <> depends_on_job_id)
          );
          CREATE TABLE studio_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, project_id TEXT,
            type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
          );
          CREATE TABLE studio_provider_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
            project_id TEXT REFERENCES studio_projects(id) ON DELETE SET NULL,
            job_id TEXT REFERENCES studio_jobs(id) ON DELETE SET NULL, provider TEXT NOT NULL,
            operation TEXT NOT NULL, units REAL NOT NULL DEFAULT 0, estimated_cost REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
          );
        `);
        this.db.pragma("user_version = 1");
      })();
      version = 1;
    }
    while (version < SCHEMA_VERSION) {
      const next = version + 1;
      this.db.transaction(() => {
        MIGRATIONS[next - 1](this.db);
        this.db.pragma(`user_version = ${next}`);
      })();
      version = next;
    }
  }

  close() { this.db.close(); }
}

module.exports = { StudioDatabase, SCHEMA_VERSION };
