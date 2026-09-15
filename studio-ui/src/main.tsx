import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { studioApi } from "./api";
import { Workspace } from "./workspaces";
import { HeliosStudio } from "./helios/HeliosStudio";
import type { ProjectInput, StudioHealth, StudioProject } from "./types";
import "./styles.css";
import "./workspaces.css";

const WORKSPACES = ["Projects", "Story", "References", "Storyboard", "Edit", "Graph", "Color", "Audio", "Deliver"];
const CONTENT_TYPES = [
  ["story", "Story"],
  ["mini-film", "Mini film"],
  ["narrative-ad", "Narrative ad"],
  ["documentary", "Documentary"],
  ["educational", "Educational"],
  ["custom", "Custom"],
] as const;

const EMPTY_PROJECT: ProjectInput = {
  title: "",
  contentType: "story",
  objective: "",
  prompt: "",
  language: "es",
  targetDurationSeconds: 300,
  aspectRatio: "16:9",
  fps: 30,
};

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function inputFromProject(project: StudioProject): ProjectInput {
  return {
    title: project.title,
    contentType: project.contentType,
    objective: project.objective,
    prompt: project.prompt,
    language: project.language,
    targetDurationSeconds: project.targetDurationSeconds,
    aspectRatio: project.aspectRatio,
    fps: project.fps,
  };
}

function ProjectFields({ value, onChange }: { value: ProjectInput; onChange: (value: ProjectInput) => void }) {
  const set = <K extends keyof ProjectInput>(key: K, next: ProjectInput[K]) => onChange({ ...value, [key]: next });
  return (
    <div className="studio-form-grid">
      <label className="studio-field studio-field-wide">
        <span>Project title</span>
        <input value={value.title} maxLength={120} onChange={(event) => set("title", event.target.value)} required />
      </label>
      <label className="studio-field">
        <span>Content type</span>
        <select value={value.contentType} onChange={(event) => set("contentType", event.target.value)}>
          {CONTENT_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <label className="studio-field">
        <span>Language</span>
        <input value={value.language} maxLength={20} onChange={(event) => set("language", event.target.value)} />
      </label>
      <label className="studio-field">
        <span>Duration</span>
        <select value={value.targetDurationSeconds} onChange={(event) => set("targetDurationSeconds", Number(event.target.value))}>
          {[60, 180, 300, 600, 900, 1800, 3600].map((seconds) => <option key={seconds} value={seconds}>{formatDuration(seconds)}</option>)}
        </select>
      </label>
      <label className="studio-field">
        <span>Canvas</span>
        <select value={value.aspectRatio} onChange={(event) => set("aspectRatio", event.target.value as "16:9" | "9:16")}>
          <option value="16:9">16:9 - 3840x2160</option>
          <option value="9:16">9:16 - 2160x3840</option>
        </select>
      </label>
      <label className="studio-field">
        <span>Frame rate</span>
        <select value={value.fps} onChange={(event) => set("fps", Number(event.target.value))}>
          {[24, 25, 30, 50, 60].map((fps) => <option key={fps} value={fps}>{fps} fps</option>)}
        </select>
      </label>
      <label className="studio-field studio-field-wide">
        <span>Objective</span>
        <textarea value={value.objective} maxLength={2000} rows={3} onChange={(event) => set("objective", event.target.value)} placeholder="What should this video achieve?" />
      </label>
      <label className="studio-field studio-field-wide">
        <span>Creative prompt</span>
        <textarea value={value.prompt} maxLength={10000} rows={5} onChange={(event) => set("prompt", event.target.value)} placeholder="Describe the story, audience, style, constraints and desired result." />
      </label>
    </div>
  );
}

function Pipeline({ project }: { project: StudioProject }) {
  return (
    <div className="studio-pipeline" aria-label="Production pipeline">
      {project.pipeline.map((stage, index) => (
        <React.Fragment key={stage.id}>
          <div className={`studio-pipeline-node is-${stage.status}`}>
            <span className="studio-node-index">{String(index + 1).padStart(2, "0")}</span>
            <strong>{stage.label}</strong>
            <small>{stage.status}</small>
          </div>
          {index < project.pipeline.length - 1 && <div className="studio-pipeline-link" aria-hidden="true" />}
        </React.Fragment>
      ))}
    </div>
  );
}

function StudioApp() {
  const [health, setHealth] = useState<StudioHealth | null>(null);
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState("Projects");
  const [showCreate, setShowCreate] = useState(false);
  const [createDraft, setCreateDraft] = useState<ProjectInput>({ ...EMPTY_PROJECT });
  const [editDraft, setEditDraft] = useState<ProjectInput>({ ...EMPTY_PROJECT });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refreshSequence = useRef(0);
  const desiredAccountId = useRef<string | null>(null);

  const selected = useMemo(() => projects.find((project) => project.id === selectedId) || null, [projects, selectedId]);

  const refresh = useCallback(async (requestedAccountId?: string) => {
    if (requestedAccountId) desiredAccountId.current = requestedAccountId;
    const sequence = ++refreshSequence.current;
    try {
      const nextHealth = await studioApi.health(requestedAccountId);
      if (requestedAccountId && desiredAccountId.current !== requestedAccountId) return;
      if (!requestedAccountId) desiredAccountId.current = nextHealth.account.id;
      const result = await studioApi.listProjects(nextHealth.account.id);
      if (sequence !== refreshSequence.current || desiredAccountId.current !== nextHealth.account.id) return;
      setHealth(nextHealth);
      setProjects(result.projects);
      setSelectedId((current) => current && result.projects.some((project) => project.id === current) ? current : result.projects[0]?.id || null);
      setMessage("");
    } catch (error) {
      if (sequence !== refreshSequence.current || (requestedAccountId && desiredAccountId.current !== requestedAccountId)) return;
      setMessage(error instanceof Error ? error.message : "Could not load Long-form Studio.");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (selected) setEditDraft(inputFromProject(selected));
  }, [selected]);

  useEffect(() => {
    const onViewChange = (event: Event) => {
      const detail = (event as CustomEvent<{ viewName?: string }>).detail;
      if (detail?.viewName === "long-video") void refresh();
    };
    const onAccountChange = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId?: string }>).detail;
      if (detail?.accountId) void refresh(detail.accountId);
    };
    document.addEventListener("autosocial:viewchange", onViewChange);
    document.addEventListener("autosocial:accountchange", onAccountChange);
    return () => {
      document.removeEventListener("autosocial:viewchange", onViewChange);
      document.removeEventListener("autosocial:accountchange", onAccountChange);
    };
  }, [refresh]);

  useEffect(() => {
    if (!health?.account.id) return;
    const accountId = health.account.id;
    const events = new EventSource(`/api/studio/events?accountId=${encodeURIComponent(accountId)}`);
    const reload = () => {
      if (desiredAccountId.current === accountId) void refresh(accountId);
    };
    events.addEventListener("project.created", reload);
    events.addEventListener("project.updated", reload);
    events.addEventListener("project.archived", reload);
    return () => events.close();
  }, [health?.account.id, refresh]);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      if (!health?.account.id) throw new Error("Wait for the active account to load.");
      const result = await studioApi.createProject(health.account.id, createDraft);
      await refresh(result.project.accountId);
      setSelectedId(result.project.id);
      setCreateDraft({ ...EMPTY_PROJECT });
      setShowCreate(false);
      setMessage("Project created. The brief stage is ready.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Project creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveProject(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await studioApi.updateProject(selected, editDraft);
      setProjects((current) => current.map((project) => project.id === result.project.id ? result.project : project));
      setMessage("Project saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Project save failed.");
      await refresh(selected.accountId);
    } finally {
      setBusy(false);
    }
  }

  async function archiveProject() {
    if (!selected || !window.confirm(`Archive "${selected.title}"?`)) return;
    setBusy(true);
    try {
      await studioApi.archiveProject(selected);
      setProjects((current) => current.filter((project) => project.id !== selected.id));
      setSelectedId(null);
      setMessage("Project archived. Media was retained.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Project archive failed.");
      await refresh(selected.accountId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="studio-shell">
      <header className="studio-topbar">
        <div className="studio-title">
          <span className="studio-logo">LF</span>
          <div><strong>AI Long-form Studio</strong><small>{health?.account.name || "Loading account"}</small></div>
        </div>
        <nav className="studio-tabs" aria-label="Studio workspaces">
          {WORKSPACES.map((name) => <button key={name} className={workspace === name ? "active" : ""} onClick={() => setWorkspace(name)}>{name}</button>)}
        </nav>
        <div className="studio-engine"><span />ENGINE - LOCAL-FIRST</div>
      </header>

      {message && <div className="studio-message" role="status">{message}</div>}

      <div className="studio-body">
        <aside className="studio-panel studio-project-panel">
          <div className="studio-panel-header"><span>PROJECTS</span><button onClick={() => setShowCreate(true)}>+ New</button></div>
          <div className="studio-project-list">
            {projects.map((project) => (
              <button key={project.id} className={selectedId === project.id ? "active" : ""} onClick={() => { setSelectedId(project.id); setShowCreate(false); }}>
                <span className={`studio-project-thumb is-${project.aspectRatio.replace(":", "x")}`}>{project.aspectRatio}</span>
                <span><strong>{project.title}</strong><small>{project.contentType} - {formatDuration(project.targetDurationSeconds)}</small></span>
              </button>
            ))}
            {!projects.length && <div className="studio-empty">No projects for this account.</div>}
          </div>
          <div className="studio-account-lock">Account scope<br /><strong>{health?.account.id || "-"}</strong></div>
        </aside>

        <main className="studio-main-panel">
          {showCreate ? (
            <form className="studio-editor-card" onSubmit={createProject}>
              <div className="studio-section-heading"><div><span className="studio-kicker">NEW PRODUCTION</span><h3>Create long-form project</h3></div><button type="button" onClick={() => setShowCreate(false)}>Cancel</button></div>
              <ProjectFields value={createDraft} onChange={setCreateDraft} />
              <div className="studio-form-actions"><span>Zero-budget mode stops generation when free quotas are exhausted.</span><button className="primary" disabled={busy}>Create project</button></div>
            </form>
          ) : workspace === "Projects" ? (
            selected ? (
              <div className="studio-project-workspace">
                <form className="studio-editor-card" onSubmit={saveProject}>
                  <div className="studio-section-heading">
                    <div><span className="studio-kicker">REVISION {selected.revision}</span><h3>{selected.title}</h3></div>
                    <span className="studio-status">{selected.status}</span>
                  </div>
                  <ProjectFields value={editDraft} onChange={setEditDraft} />
                  <div className="studio-form-actions"><button type="button" className="danger" onClick={archiveProject} disabled={busy}>Archive</button><button className="primary" disabled={busy}>Save project</button></div>
                </form>
                <section className="studio-editor-card">
                  <div className="studio-section-heading"><div><span className="studio-kicker">PIPELINE GRAPH</span><h3>Production plan</h3></div><button disabled title="Available in the preproduction milestone">Generate plan</button></div>
                  <Pipeline project={selected} />
                </section>
              </div>
            ) : (
              <button className="studio-create-empty" onClick={() => setShowCreate(true)}><strong>Create the first project</strong><span>Start with an objective, prompt and output format.</span></button>
            )
          ) : <Workspace name={workspace} project={selected} providers={health?.providers || []} storageReady={Boolean(health?.storage.longFormReady)} notify={setMessage} navigate={setWorkspace} />}
        </main>

        <aside className="studio-panel studio-inspector">
          <div className="studio-panel-header"><span>SYSTEM</span><span className={health?.storage.longFormReady ? "studio-dot ready" : "studio-dot"} /></div>
          <section>
            <span className="studio-kicker">STORAGE</span>
            <strong className="studio-metric">{formatBytes(health?.storage.freeBytes ?? null)}</strong>
            <small>free - minimum {formatBytes(health?.storage.minimumFreeBytes ?? 0)}</small>
            <div className="studio-progress"><span style={{ width: health?.storage.longFormReady ? "100%" : "20%" }} /></div>
            {!health?.storage.longFormReady && <p className="studio-warning">Long-form 4K is blocked until safe free space is available.</p>}
          </section>
          <section>
            <span className="studio-kicker">PROVIDERS</span>
            {health?.providers.map((provider) => <div className="studio-provider" key={provider.id}><span>{provider.id}</span><small>{provider.capability} - {provider.mode}</small><i className={provider.enabled ? "ready" : ""} /></div>)}
          </section>
          <section>
            <span className="studio-kicker">OUTPUT</span>
            <div className="studio-output-meta"><span>Canvas</span><strong>{selected ? `${selected.width}x${selected.height}` : "3840x2160"}</strong></div>
            <div className="studio-output-meta"><span>Frame rate</span><strong>{selected?.fps || 30} fps</strong></div>
            <div className="studio-output-meta"><span>Budget</span><strong>Zero-budget policy</strong></div>
          </section>
        </aside>
      </div>

    </div>
  );
}

const mount = document.getElementById("longFormStudioRoot");
if (mount) createRoot(mount).render(<StudioApp />);

const heliosMount = document.getElementById("heliosStudioRoot");
if (heliosMount) createRoot(heliosMount).render(<HeliosStudio />);
