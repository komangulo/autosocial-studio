import type { DocumentKind, DocumentResult, MediaJobInput, ProjectInput, PublicationConfirmation, RenderOptions, StudioAsset, StudioHealth, StudioJob, StudioProject, StudioPublication, StudioRender, VersionedDocument } from "./types";

type ApiErrorBody = { error?: string; message?: string; details?: string };
const root = "/api/studio";

async function request<T>(url: string, accountId: string | undefined, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (accountId) headers.set("x-autosocial-account-id", accountId);
  const response = await fetch(url, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("json") ? await response.json().catch(() => ({})) as ApiErrorBody : {};
  if (!response.ok) {
    const explanation = body.error || body.message || body.details || response.statusText;
    throw new Error(`${explanation || "Studio request failed"} (${response.status})`);
  }
  return body as T;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
function projectPath(projectId: string, suffix = "") { return `${root}/projects/${encodeURIComponent(projectId)}${suffix}`; }
function documentPayload(kind: DocumentKind, content: unknown): unknown {
  if (!content || typeof content !== "object") return content;
  const value = content as Record<string, unknown>;
  if (kind === "script") {
    const acts = Array.isArray(value.acts) ? value.acts as Array<{ scenes?: unknown[] }> : [];
    return { ...value, scenes: acts.flatMap((act) => Array.isArray(act.scenes) ? act.scenes : []) };
  }
  if (kind === "references") return { ...value, items: Array.isArray(value.items) ? value.items : Array.isArray(value.assetIds) ? value.assetIds : [] };
  if (kind !== "timeline") return value;
  const tracks = Array.isArray(value.tracks) ? value.tracks as Array<Record<string, unknown>> : [];
  return { ...value, tracks: tracks.map((track) => ({ ...track, type: track.kind || track.type, clips: (Array.isArray(track.clips) ? track.clips as Array<Record<string, unknown>> : []).map((clip) => {
    const transform = (clip.transform || {}) as Record<string, unknown>, grade = (clip.grade || clip.color || {}) as Record<string, unknown>, audio = (clip.audio || {}) as Record<string, unknown>;
    const keyframes = [transform.keyframes, grade.keyframes].flatMap((groups) => groups && typeof groups === "object" ? Object.entries(groups as Record<string, Array<{ timeMs: number; value: number; easing?: string }>>).flatMap(([property, frames]) => Array.isArray(frames) ? frames.map((frame) => ({ property, ...frame })) : []) : []);
    const muted = Boolean(audio.muted) || Boolean(track.muted);
    return { ...clip, editor: { transform, grade, audio }, trimStartMs: clip.sourceStartMs || 0, transform: Object.fromEntries(Object.entries(transform).filter(([, v]) => typeof v === "number")), color: Object.fromEntries(Object.entries(grade).filter(([, v]) => typeof v === "number")), audio: { volume: muted ? 0 : Math.pow(10, (Number(audio.gainDb) || 0) / 20), pan: Number(audio.pan) || 0, fadeInMs: Number(audio.fadeInMs) || 0, fadeOutMs: Number(audio.fadeOutMs) || 0, ducking: Number(audio.ducking) || 0, role: String(audio.role || "dialogue"), normalization: String(audio.normalization || "none") }, keyframes };
  }) })) };
}

export const studioApi = {
  health: (accountId?: string) => request<StudioHealth>(`${root}/health`, accountId),
  listProjects: (accountId: string) => request<{ ok: true; projects: StudioProject[] }>(`${root}/projects`, accountId),
  createProject: (accountId: string, input: ProjectInput) => request<{ ok: true; project: StudioProject }>(`${root}/projects`, accountId, json("POST", input)),
  updateProject: (project: StudioProject, input: Partial<ProjectInput>) => request<{ ok: true; project: StudioProject }>(projectPath(project.id), project.accountId, json("PATCH", { ...input, baseRevision: project.revision })),
  archiveProject: (project: StudioProject) => request<{ ok: true }>(projectPath(project.id), project.accountId, json("DELETE", { baseRevision: project.revision })),
  getDocument: async <T>(project: StudioProject, kind: DocumentKind) => {
    const result = await request<{ document: VersionedDocument<T> | null; documents?: Array<VersionedDocument<T> & { status?: string }> }>(projectPath(project.id, `/documents/${kind}`), project.accountId);
    const documents = result.documents || [];
    const normalizeDocument = (document: (VersionedDocument<T> & { status?: string }) | null) => document ? { ...document, approved: document.approved ?? document.status === "approved", projectRevision: document.projectRevision ?? project.revision } : null;
    return { document: normalizeDocument(result.document), versions: documents.map((document) => ({ version: document.version, approved: document.approved ?? document.status === "approved", changeNote: document.changeNote, createdAt: document.createdAt })) } satisfies DocumentResult<T>;
  },
  saveDocument: async <T>(project: StudioProject, kind: DocumentKind, content: T, baseVersion: number, changeNote: string) => {
    const result = await request<{ document: VersionedDocument<T> & { status?: string }; project?: StudioProject }>(projectPath(project.id, `/documents/${kind}`), project.accountId, json("POST", { content: documentPayload(kind, content), baseVersion, baseProjectRevision: project.revision, changeNote }));
    if (result.project) project.revision = result.project.revision;
    return { ...result, document: { ...result.document, approved: result.document.approved ?? result.document.status === "approved" } };
  },
  approveDocument: async <T>(project: StudioProject, kind: DocumentKind, version: number) => {
    const result = await request<{ document: VersionedDocument<T> & { status?: string }; project?: StudioProject }>(projectPath(project.id, `/documents/${kind}/${version}/approve`), project.accountId, json("POST", { baseProjectRevision: project.revision }));
    if (result.project) project.revision = result.project.revision;
    return { ...result, document: { ...result.document, approved: result.document.approved ?? result.document.status === "approved" } };
  },
  getDocumentVersion: async <T>(project: StudioProject, kind: DocumentKind, version: number) => {
    const result = await request<{ document: VersionedDocument<T> & { status?: string } }>(projectPath(project.id, `/documents/${kind}/${version}`), project.accountId);
    return { ...result.document, approved: result.document.approved ?? result.document.status === "approved" };
  },
  restoreDocument: async <T>(project: StudioProject, kind: DocumentKind, version: number) => {
    const result = await request<{ document: VersionedDocument<T> & { status?: string }; project?: StudioProject }>(projectPath(project.id, `/documents/${kind}/${version}/restore`), project.accountId, json("POST", { baseProjectRevision: project.revision, changeNote: `Restored from version ${version}` }));
    if (result.project) project.revision = result.project.revision;
    return { ...result, document: { ...result.document, approved: result.document.approved ?? result.document.status === "approved" } };
  },
  generate: async (project: StudioProject, kind: "script" | "bible" | "storyboard", provider: string, baseVersion: number) => {
    const result = await request<{ job?: StudioJob; document?: unknown; project?: StudioProject }>(projectPath(project.id, "/generate"), project.accountId, json("POST", { kind, provider, baseVersion, baseProjectRevision: project.revision }));
    if (result.project) project.revision = result.project.revision;
    return result;
  },
  listAssets: async (project: StudioProject) => {
    const result = await request<{ assets: Array<StudioAsset & { originalName?: string; metadata?: { format?: { duration?: string } } }> }>(projectPath(project.id, "/assets"), project.accountId);
    return { assets: result.assets.map((asset) => ({ ...asset, name: asset.name || asset.originalName || "Asset", durationMs: asset.durationMs ?? (asset.metadata?.format?.duration ? Math.round(Number(asset.metadata.format.duration) * 1000) : undefined), contentUrl: asset.contentUrl || projectPath(project.id, `/assets/${encodeURIComponent(asset.id)}/content`) })) };
  },
  uploadAsset: async (project: StudioProject, file: File) => {
    const uploadId = crypto.randomUUID();
    const chunkSize = 8 * 1024 * 1024;
    const mimeType = file.type || (file.name.toLowerCase().endsWith(".cube") ? "application/x-cube" : "application/octet-stream");
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
      await request(projectPath(project.id, `/uploads/${uploadId}/chunks`), project.accountId, { method: "POST", headers: { "content-type": "application/octet-stream", "x-upload-offset": String(offset), "x-upload-total": String(file.size), "x-upload-mime": mimeType, "x-file-name": file.name }, body: chunk });
    }
    return request<{ asset: StudioAsset }>(projectPath(project.id, `/uploads/${uploadId}/finalize`), project.accountId, json("POST"));
  },
  assetContentUrl: (project: StudioProject, assetId: string) => `${projectPath(project.id, `/assets/${encodeURIComponent(assetId)}/content`)}?accountId=${encodeURIComponent(project.accountId)}`,
  assetProxyContentUrl: (project: StudioProject, assetId: string) => `${projectPath(project.id, `/assets/${encodeURIComponent(assetId)}/proxy-content`)}?accountId=${encodeURIComponent(project.accountId)}`,
  createMediaJob: (project: StudioProject, input: MediaJobInput) => request<{ job: StudioJob }>(projectPath(project.id, "/media-jobs"), project.accountId, json("POST", input)),
  createRoughCut: async <T>(project: StudioProject, baseVersion: number) => {
    const result = await request<{ document: VersionedDocument<T>; project?: StudioProject }>(projectPath(project.id, "/rough-cut"), project.accountId, json("POST", { baseProjectRevision: project.revision, baseVersion }));
    if (result.project) project.revision = result.project.revision;
    return result;
  },
  listJobs: (project: StudioProject) => request<{ jobs: StudioJob[] } | StudioJob[]>(projectPath(project.id, "/jobs"), project.accountId),
  createJob: (project: StudioProject, input: Record<string, unknown>) => request<{ job: StudioJob }>(projectPath(project.id, "/jobs"), project.accountId, json("POST", input)),
  listRenders: async (project: StudioProject) => {
    const result = await request<{ renders: Array<Omit<StudioRender, "error"> & { error?: string | { message?: string }; outputAssetId?: string }> } | StudioRender[]>(projectPath(project.id, "/renders"), project.accountId);
    const renders = Array.isArray(result) ? result : result.renders;
    return { renders: renders.map((render) => ({
      ...render,
      error: typeof render.error === "string" ? render.error : render.error?.message,
      outputUrl: render.outputUrl || (render.status === "completed" ? `${projectPath(project.id, `/renders/${encodeURIComponent(render.id)}/content`)}?accountId=${encodeURIComponent(project.accountId)}` : undefined),
    })) };
  },
  createRender: (project: StudioProject, preset: string, timelineVersion: number, options: RenderOptions) => request<{ render: StudioRender }>(projectPath(project.id, "/renders"), project.accountId, json("POST", { preset, timelineVersion, options })),
  renderAction: (project: StudioProject, renderId: string, action: "process" | "cancel" | "retry") => request<{ render: StudioRender }>(projectPath(project.id, `/renders/${encodeURIComponent(renderId)}/${action}`), project.accountId, json("POST")),
  listPublications: (project: StudioProject) => request<{ publications: StudioPublication[] } | StudioPublication[]>(projectPath(project.id, "/publications"), project.accountId),
  createPublication: (project: StudioProject, input: Omit<StudioPublication, "id" | "projectId" | "status">) => request<{ publication: StudioPublication }>(projectPath(project.id, "/publications"), project.accountId, json("POST", input)),
  publicationAction: (project: StudioProject, id: string, action: "cancel" | "retry") => request<{ publication: StudioPublication }>(projectPath(project.id, `/publications/${encodeURIComponent(id)}/${action}`), project.accountId, json("POST")),
  confirmPublication: (project: StudioProject, id: string, confirmation: PublicationConfirmation) => request<{ publication: StudioPublication }>(projectPath(project.id, `/publications/${encodeURIComponent(id)}/confirm`), project.accountId, json("POST", confirmation)),
};
