import type { GenerateResult, GraphProject, HeliosSettings, HistoryItem, ModelInfo, ProviderInfo } from "./types";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/helios${path}`, {
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

export const heliosApi = {
  catalog: () => request<{ imageModels: ModelInfo[]; videoModels: ModelInfo[]; providers: ProviderInfo[] }>("/models"),
  settings: () => request<{ settings: HeliosSettings }>("/settings"),
  saveSettings: (payload: Record<string, unknown>) =>
    request<{ settings: HeliosSettings }>("/settings", { method: "POST", body: JSON.stringify(payload) }),
  history: (kind?: string) => request<{ items: HistoryItem[] }>(`/history${kind ? `?kind=${kind}` : ""}`),
  clearHistory: () => request<{ ok: boolean }>("/history/clear", { method: "POST", body: "{}" }),
  deleteHistory: (id: string) => request<{ ok: boolean }>(`/history/${encodeURIComponent(id)}`, { method: "DELETE" }),

  generate: (config: Record<string, unknown>, kind: "image" | "video") =>
    request<GenerateResult>("/generate", { method: "POST", body: JSON.stringify({ config, kind }) }),
  saveGenerated: (payload: Record<string, unknown>) =>
    request<{ ok: boolean; imageUrl?: string; videoUrl?: string }>("/save-generated", { method: "POST", body: JSON.stringify(payload) }),
  upload: (dataUrl: string) =>
    request<{ upload: { url: string; name: string } }>("/upload", { method: "POST", body: JSON.stringify({ dataUrl }) }),

  parseConfig: (format: "json" | "yaml", value: string) =>
    request<{ config: Record<string, unknown> }>("/config/parse", { method: "POST", body: JSON.stringify({ format, value }) }),
  stringifyConfig: (format: "json" | "yaml", config: Record<string, unknown>) =>
    request<{ value: string }>("/config/stringify", { method: "POST", body: JSON.stringify({ format, config }) }),
  defaults: () => request<{ value: string; example: GraphProject }>("/config/default"),

  listProjects: () => request<{ projects: { id: string; name: string; nodes: number; updatedAt: string | null }[] }>("/projects"),
  getProject: (id: string) => request<{ project: GraphProject }>(`/projects/${encodeURIComponent(id)}`),
  saveProject: (project: GraphProject) =>
    request<{ id: string; project: GraphProject }>("/projects", { method: "POST", body: JSON.stringify({ id: project.id, project }) }),
  updateProject: (id: string, project: GraphProject) =>
    request<{ id: string; project: GraphProject }>(`/projects/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ project }) }),
  deleteProject: (id: string) => request<{ ok: boolean }>(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
