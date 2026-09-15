const { randomUUID } = require("crypto");
const { StudioValidationError, normalizeBaseRevision } = require("./validation");
const { DOCUMENT_KINDS, validateDocument } = require("./document-validation");

const APPROVAL_ORDER = ["brief", "script", "bible", "references", "storyboard", "timeline"];
const NEXT_STAGE = { brief: "script", script: "bible", bible: "references", references: "storyboard", storyboard: "assembly", timeline: "master" };
const NEXT_STATUS = { brief: "script-review", script: "bible-review", bible: "storyboard-review", references: "storyboard-review", storyboard: "editing", timeline: "ready-to-render" };

function parse(value) { return value == null ? null : JSON.parse(value); }
function mapDocument(row) {
  if (!row) return null;
  return { id: row.id, projectId: row.project_id, kind: row.kind, version: row.version, content: parse(row.content_json), status: row.status, parentVersion: row.parent_version, changeNote: row.change_note, approvedAt: row.approved_at, createdAt: row.created_at };
}

class DocumentService {
  constructor({ database, projectService, eventHub }) { this.db = database.db; this.projectService = projectService; this.eventHub = eventHub; }
  assertKind(kind) { if (!DOCUMENT_KINDS.has(kind)) throw new StudioValidationError("Unsupported document kind."); }
  list(accountId, projectId, kind) {
    this.projectService.get(accountId, projectId); this.assertKind(kind);
    return this.db.prepare("SELECT d.* FROM studio_documents d JOIN studio_projects p ON p.id=d.project_id WHERE d.project_id=? AND d.kind=? AND p.account_id=? ORDER BY d.version DESC").all(projectId, kind, accountId).map(mapDocument);
  }
  get(accountId, projectId, kind, version) {
    this.projectService.get(accountId, projectId); this.assertKind(kind);
    const row = this.db.prepare("SELECT d.* FROM studio_documents d JOIN studio_projects p ON p.id=d.project_id WHERE d.project_id=? AND d.kind=? AND d.version=? AND p.account_id=?").get(projectId, kind, Number(version), accountId);
    if (!row) throw new StudioValidationError("Document version not found.", 404);
    return mapDocument(row);
  }
  create(accountId, projectId, kind, input = {}) {
    this.assertKind(kind);
    const content = validateDocument(kind, input.content);
    const baseVersion = Number(input.baseVersion);
    if (!Number.isInteger(baseVersion) || baseVersion < 0) throw new StudioValidationError("Base version must be a non-negative integer.");
    const baseRevision = normalizeBaseRevision(input.baseProjectRevision);
    const note = String(input.changeNote || "").trim();
    if (note.length > 500) throw new StudioValidationError("Change note must be 500 characters or fewer.");
    const now = new Date().toISOString(); let version;
    this.db.transaction(() => {
      const project = this.db.prepare("SELECT revision FROM studio_projects WHERE id=? AND account_id=? AND archived_at IS NULL").get(projectId, accountId);
      if (!project) throw new StudioValidationError("Studio project not found.", 404);
      if (project.revision !== baseRevision) throw new StudioValidationError(`Project changed in another session. Current revision is ${project.revision}.`, 409);
      const latest = this.db.prepare("SELECT COALESCE(MAX(version),0) version FROM studio_documents WHERE project_id=? AND kind=?").get(projectId, kind).version;
      if (latest !== baseVersion) throw new StudioValidationError(`Document changed in another session. Current version is ${latest}.`, 409);
      version = latest + 1;
      this.db.prepare("INSERT INTO studio_documents (id,project_id,kind,version,content_json,status,parent_version,change_note,created_at) VALUES (?,?,?,?,?,'draft',?,?,?)").run(randomUUID(), projectId, kind, version, JSON.stringify(content), latest || null, note, now);
      this.db.prepare("UPDATE studio_projects SET revision=revision+1,updated_at=? WHERE id=?").run(now, projectId);
      this.projectService.recordEvent(accountId, projectId, "document.created", { kind, version }, now);
    })();
    const document = this.get(accountId, projectId, kind, version);
    this.eventHub.publish({ type: "document.created", accountId, projectId, document });
    return { document, project: this.projectService.get(accountId, projectId) };
  }
  approve(accountId, projectId, kind, versionValue, input = {}) {
    this.assertKind(kind); const version = Number(versionValue); const baseRevision = normalizeBaseRevision(input.baseProjectRevision);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const project = this.db.prepare("SELECT revision FROM studio_projects WHERE id=? AND account_id=? AND archived_at IS NULL").get(projectId, accountId);
      if (!project) throw new StudioValidationError("Studio project not found.", 404);
      if (project.revision !== baseRevision) throw new StudioValidationError(`Project changed in another session. Current revision is ${project.revision}.`, 409);
      const latest = this.db.prepare("SELECT MAX(version) version FROM studio_documents WHERE project_id=? AND kind=?").get(projectId, kind).version;
      if (latest !== version) throw new StudioValidationError("Only the latest document version can be approved.", 409);
      const order = APPROVAL_ORDER.indexOf(kind);
      if (order > 0) {
        const prior = APPROVAL_ORDER[order - 1];
        const gate = this.db.prepare("SELECT 1 FROM studio_documents WHERE project_id=? AND kind=? AND status='approved' LIMIT 1").get(projectId, prior);
        if (!gate) throw new StudioValidationError(`${prior} must be approved first.`, 409);
      }
      const result = this.db.prepare("UPDATE studio_documents SET status='approved',approved_at=? WHERE project_id=? AND kind=? AND version=? AND status<>'approved'").run(now, projectId, kind, version);
      if (!result.changes) {
        const exists = this.db.prepare("SELECT status FROM studio_documents WHERE project_id=? AND kind=? AND version=?").get(projectId, kind, version);
        if (!exists) throw new StudioValidationError("Document version not found.", 404);
        throw new StudioValidationError("Document version is already approved.", 409);
      }
      this.db.prepare("UPDATE studio_documents SET status='superseded' WHERE project_id=? AND kind=? AND version<>? AND status='approved'").run(projectId, kind, version);
      if (order >= 0) {
        this.db.prepare("UPDATE studio_projects SET revision=revision+1,current_stage=?,status=?,updated_at=? WHERE id=?").run(NEXT_STAGE[kind], NEXT_STATUS[kind], now, projectId);
      } else {
        this.db.prepare("UPDATE studio_projects SET revision=revision+1,updated_at=? WHERE id=?").run(now, projectId);
      }
      this.projectService.recordEvent(accountId, projectId, "document.approved", { kind, version }, now);
    })();
    return { document: this.get(accountId, projectId, kind, version), project: this.projectService.get(accountId, projectId) };
  }
  restore(accountId, projectId, kind, version, input = {}) {
    const source = this.get(accountId, projectId, kind, version);
    const latest = this.list(accountId, projectId, kind)[0]?.version || 0;
    return this.create(accountId, projectId, kind, { content: source.content, baseVersion: latest, baseProjectRevision: input.baseProjectRevision, changeNote: input.changeNote || `Restored from version ${version}` });
  }
}

module.exports = { DocumentService, mapDocument, APPROVAL_ORDER };
