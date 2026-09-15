const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const {
  StudioValidationError,
  normalizeCreateProject,
  normalizeProjectPatch,
  normalizeBaseRevision,
} = require("./validation");

const PIPELINE_STAGES = [
  { id: "brief", label: "Brief" },
  { id: "script", label: "Script" },
  { id: "bible", label: "Visual Bible" },
  { id: "references", label: "References" },
  { id: "storyboard", label: "Storyboard" },
  { id: "shots", label: "Shots" },
  { id: "audio", label: "Audio" },
  { id: "assembly", label: "Assembly" },
  { id: "color", label: "Color" },
  { id: "mix", label: "Mix" },
  { id: "master", label: "Master" },
  { id: "deliver", label: "Deliver" },
];

function assertAccountId(accountId) {
  const value = String(accountId || "");
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/i.test(value)) throw new StudioValidationError("Invalid account identifier.");
  return value;
}

function mapProject(row) {
  if (!row) return null;
  const currentIndex = Math.max(0, PIPELINE_STAGES.findIndex((stage) => stage.id === row.current_stage));
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    contentType: row.content_type,
    objective: row.objective,
    prompt: row.prompt,
    language: row.language,
    targetDurationSeconds: row.target_duration_seconds,
    aspectRatio: row.aspect_ratio,
    width: row.width,
    height: row.height,
    fps: row.fps,
    status: row.status,
    currentStage: row.current_stage,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    pipeline: PIPELINE_STAGES.map((stage, index) => ({
      ...stage,
      status: index < currentIndex ? "completed" : index === currentIndex ? "ready" : "blocked",
    })),
  };
}

class StudioProjectService {
  constructor({ database, rootPath, eventHub }) {
    this.database = database;
    this.db = database.db;
    this.rootPath = path.resolve(rootPath);
    this.eventHub = eventHub;
  }

  projectPath(accountId, projectId) {
    const safeAccount = assertAccountId(accountId);
    if (!/^[0-9a-f-]{36}$/i.test(String(projectId || ""))) throw new StudioValidationError("Invalid project identifier.");
    return path.join(this.rootPath, "accounts", safeAccount, "projects", projectId);
  }

  async ensureProjectFolders(accountId, projectId) {
    const root = this.projectPath(accountId, projectId);
    const directories = ["originals", "references", "storyboards", "clips", "audio", "proxies", "previews", "renders", "tmp"];
    await Promise.all(directories.map((directory) => fs.mkdir(path.join(root, directory), { recursive: true, mode: 0o700 })));
    return root;
  }

  list(accountId, options = {}) {
    const safeAccount = assertAccountId(accountId);
    const includeArchived = Boolean(options.includeArchived);
    const rows = this.db.prepare(`
      SELECT * FROM studio_projects
      WHERE account_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}
      ORDER BY updated_at DESC
      LIMIT 200
    `).all(safeAccount);
    return rows.map(mapProject);
  }

  get(accountId, projectId, options = {}) {
    const safeAccount = assertAccountId(accountId);
    const row = this.db.prepare(`
      SELECT * FROM studio_projects
      WHERE id = ? AND account_id = ? ${options.includeArchived ? "" : "AND archived_at IS NULL"}
    `).get(projectId, safeAccount);
    if (!row) throw new StudioValidationError("Studio project not found.", 404);
    return mapProject(row);
  }

  async create(accountId, input) {
    const safeAccount = assertAccountId(accountId);
    const value = normalizeCreateProject(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const projectRoot = this.projectPath(safeAccount, id);
    await this.ensureProjectFolders(safeAccount, id);

    try {
      this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO studio_projects (
            id, account_id, title, content_type, objective, prompt, language,
            target_duration_seconds, aspect_ratio, width, height, fps,
            status, current_stage, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'brief', 1, ?, ?)
        `).run(
          id, safeAccount, value.title, value.contentType, value.objective, value.prompt, value.language,
          value.targetDurationSeconds, value.aspectRatio, value.width, value.height, value.fps, now, now
        );
        this.db.prepare(`
          INSERT INTO studio_documents (id, project_id, kind, version, content_json, created_at)
          VALUES (?, ?, 'brief', 1, ?, ?)
        `).run(randomUUID(), id, JSON.stringify({ objective: value.objective, prompt: value.prompt }), now);
        this.recordEvent(safeAccount, id, "project.created", { projectId: id, title: value.title }, now);
      })();
    } catch (error) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    const project = this.get(safeAccount, id);
    this.eventHub.publish({ type: "project.created", accountId: safeAccount, projectId: id, project });
    return project;
  }

  update(accountId, projectId, input) {
    const safeAccount = assertAccountId(accountId);
    const baseRevision = normalizeBaseRevision(input?.baseRevision);
    const patch = normalizeProjectPatch(input);
    const columnMap = {
      title: "title",
      contentType: "content_type",
      objective: "objective",
      prompt: "prompt",
      language: "language",
      targetDurationSeconds: "target_duration_seconds",
      aspectRatio: "aspect_ratio",
      width: "width",
      height: "height",
      fps: "fps",
      status: "status",
    };
    const entries = Object.entries(patch);
    const assignments = entries.map(([key]) => `${columnMap[key]} = ?`);
    const values = entries.map(([, value]) => value);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE studio_projects
        SET ${assignments.join(", ")}, revision = revision + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND archived_at IS NULL AND revision = ?
      `).run(...values, now, projectId, safeAccount, baseRevision);

      if (!result.changes) {
        const exists = this.db.prepare("SELECT revision FROM studio_projects WHERE id = ? AND account_id = ? AND archived_at IS NULL").get(projectId, safeAccount);
        if (!exists) throw new StudioValidationError("Studio project not found.", 404);
        throw new StudioValidationError(`Project changed in another session. Current revision is ${exists.revision}.`, 409);
      }
      this.recordEvent(safeAccount, projectId, "project.updated", { projectId }, now);
    })();
    const project = this.get(safeAccount, projectId);
    this.eventHub.publish({ type: "project.updated", accountId: safeAccount, projectId, project });
    return project;
  }

  archive(accountId, projectId, baseRevisionValue) {
    const safeAccount = assertAccountId(accountId);
    const baseRevision = normalizeBaseRevision(baseRevisionValue);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE studio_projects
        SET status = 'archived', archived_at = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND archived_at IS NULL AND revision = ?
      `).run(now, now, projectId, safeAccount, baseRevision);
      if (!result.changes) {
        const exists = this.db.prepare("SELECT revision FROM studio_projects WHERE id = ? AND account_id = ? AND archived_at IS NULL").get(projectId, safeAccount);
        if (!exists) throw new StudioValidationError("Studio project not found.", 404);
        throw new StudioValidationError(`Project changed in another session. Current revision is ${exists.revision}.`, 409);
      }
      this.recordEvent(safeAccount, projectId, "project.archived", { projectId }, now);
    })();
    this.eventHub.publish({ type: "project.archived", accountId: safeAccount, projectId });
    return { id: projectId, archivedAt: now };
  }

  recordEvent(accountId, projectId, type, payload, createdAt = new Date().toISOString()) {
    this.db.prepare(`
      INSERT INTO studio_events (account_id, project_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(accountId, projectId || null, type, JSON.stringify(payload || {}), createdAt);
  }
}

module.exports = { StudioProjectService, PIPELINE_STAGES, mapProject };
