import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { heliosApi } from "./api";
import { NodeContext, nodeTypes } from "./nodes";
import type { GraphNodeData, GraphProject, HeliosSettings, ModelInfo, ProviderInfo } from "./types";
import "./helios.css";

const FLOW_URL = "https://labs.google/fx/tools/flow";

let puterPromise: Promise<any> | null = null;
function loadPuter(): Promise<any> {
  if ((window as any).puter) return Promise.resolve((window as any).puter);
  if (puterPromise) return puterPromise;
  puterPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://js.puter.com/v2/";
    script.onload = () => resolve((window as any).puter);
    script.onerror = () => reject(new Error("No se pudo cargar Puter.js"));
    document.head.appendChild(script);
  });
  return puterPromise;
}

function toReactNode(node: GraphProject["nodes"][number]): Node {
  return { id: node.id, type: node.type, position: node.position, data: { ...node.data } };
}

function fromFlowProject(name: string, id: string | null, nodes: Node[], edges: Edge[]): GraphProject {
  return {
    version: 1,
    name,
    id: id || undefined,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: (node.type || "note") as GraphProject["nodes"][number]["type"],
      position: node.position,
      data: node.data as GraphNodeData,
    })),
    edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
  };
}

/** Parse the config text of the node feeding the provider, JSON or YAML. */
function parseConfigText(value: string, format: "json" | "yaml"): Record<string, unknown> {
  const text = String(value || "").trim();
  if (!text) return {};
  if (format === "yaml") return parseYamlLite(text);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseYamlLite(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^\s*/)?.[0].length || 0;
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    const rest = match[2].trim();
    if (rest === "") {
      currentKey = key;
      result[key] ||= {};
      continue;
    }
    let value: unknown = rest;
    if (rest === "true") value = true;
    else if (rest === "false") value = false;
    else if (rest === "null" || rest === "~") value = null;
    else if (/^-?\d+(\.\d+)?$/.test(rest)) value = Number(rest);
    else if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) value = rest.slice(1, -1);
    else if (rest.startsWith("[") || rest.startsWith("{")) {
      try { value = JSON.parse(rest); } catch { value = rest; }
    }
    const parent = currentKey ? result[currentKey] : undefined;
    if (indent > 0 && parent && typeof parent === "object" && !Array.isArray(parent)) {
      (parent as Record<string, unknown>)[key] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function HeliosInner() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [settings, setSettings] = useState<HeliosSettings | null>(null);
  const [projectName, setProjectName] = useState("Sin título");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string; nodes: number }[]>([]);
  const [showProjects, setShowProjects] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [outputNodeId, setOutputNodeId] = useState<string | null>(null);
  const [geminiKey, setGeminiKey] = useState("");
  const [hfToken, setHfToken] = useState("");
  const { fitView, getViewport, setViewport } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const notify = (text: string) => setMessage(text);

  const bootstrap = useCallback(async () => {
    try {
      const [catalog, settingsResult, defaults, projectList] = await Promise.all([
        heliosApi.catalog(),
        heliosApi.settings(),
        heliosApi.defaults(),
        heliosApi.listProjects(),
      ]);
      setModels([...catalog.imageModels, ...catalog.videoModels]);
      setProviders(catalog.providers);
      setSettings(settingsResult.settings);
      setProjects(projectList.projects);
      const example = defaults.example;
      setNodes(example.nodes.map(toReactNode));
      setEdges(example.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })));
      setProjectName(example.name || "Sin título");
      setOutputNodeId("output-1");
      setTimeout(() => fitView({ padding: 0.2 }), 50);
    } catch (error) {
      notify(error instanceof Error ? error.message : "No se pudo cargar Helios");
    }
  }, [fitView]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes((current) => applyNodeChanges(changes, current)), []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((current) => applyEdgeChanges(changes, current)), []);
  const onConnect = useCallback((connection: Connection) => setEdges((current) => addEdge(connection, current)), []);

  const onChangeNode = useCallback((id: string, patch: Partial<GraphNodeData>) => {
    setNodes((current) => current.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node));
  }, []);

  const onRemoveImage = useCallback((id: string, index: number) => {
    setNodes((current) => current.map((node) => {
      if (node.id !== id) return node;
      const images = [...(((node.data as GraphNodeData).images) || [])];
      images.splice(index, 1);
      return { ...node, data: { ...node.data, images } };
    }));
  }, []);

  const contextValue = useMemo(() => ({
    models,
    providers,
    onChange: onChangeNode,
    onRemoveImage,
    hasGeminiKey: Boolean(settings?.hasGeminiKey),
    hasHfToken: Boolean(settings?.hasHfToken),
  }), [models, providers, onChangeNode, onRemoveImage, settings?.hasGeminiKey, settings?.hasHfToken]);

  function collectConfig(): { config: Record<string, unknown>; kind: "image" | "video" } {
    const configNode = nodes.find((node) => node.type === "config");
    const providerNode = nodes.find((node) => node.type === "provider");
    const promptNode = nodes.find((node) => node.type === "prompt");
    const referenceNode = nodes.find((node) => node.type === "reference");
    const format = (configNode?.data as GraphNodeData)?.format ?? "json";
    const parsed = parseConfigText((configNode?.data as GraphNodeData)?.value ?? "", format);
    const modelId = (providerNode?.data as GraphNodeData)?.model as string | undefined;
    const model = models.find((candidate) => candidate.id === (parsed.model || modelId));
    const images = (((referenceNode?.data as GraphNodeData)?.images) || []).map((image) => image.url);
    const kind: "image" | "video" = (parsed.kind === "video" || parsed.kind === "image") ? parsed.kind : (model?.id?.includes("video") || false) ? "video" : "image";
    const detectedKind: "image" | "video" = models.find((candidate) => candidate.id === (parsed.model || modelId))?.durations ? "video" : kind;
    const parsedReferences = Array.isArray(parsed.references) ? parsed.references : [];
    return {
      kind: detectedKind,
      config: {
        ...parsed,
        kind: detectedKind,
        model: parsed.model || modelId,
        prompt: parsed.prompt ?? (promptNode?.data as GraphNodeData | undefined)?.text ?? "",
        references: parsedReferences.length ? parsedReferences : images,
      },
    };
  }

  async function generate() {
    setBusy(true);
    notify("Generando...");
    try {
      const { config, kind } = collectConfig();
      if (!config.model) throw new Error("Selecciona un modelo en el nodo Modelo.");
      if (!config.prompt) throw new Error("Escribe un prompt en el nodo Prompt.");
      const result = await heliosApi.generate(config, kind);
      setOutputNodeId((current) => current || nodes.find((node) => node.type === "output")?.id || null);

      if (result.client === "puter") {
        await runPuter(result, kind);
      } else if (result.client === "flow") {
        notify("Google Flow no tiene API: se abrirá Flow. Copia el prompt y genera allí.");
        window.open(FLOW_URL, "_blank", "noopener");
      } else if (result.imageUrl || result.videoUrl) {
        applyResult(result.historyId, { imageUrl: result.imageUrl, videoUrl: result.videoUrl, kind });
        notify("Listo.");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "La generación falló");
    } finally {
      setBusy(false);
    }
  }

  async function runPuter(result: { historyId?: string; call?: any }, kind: "image" | "video") {
    notify("Generando con Puter.js (sin API key)...");
    const puter = await loadPuter();
    const call = result.call || {};
    const fn = kind === "image" ? puter.ai.txt2img : puter.ai.txt2vid;
    const output = await fn(call.prompt, { model: call.model, ...(call.options || {}) });
    const url: string = typeof output === "string" ? output : output?.src || output?.getAttribute?.("src") || "";
    if (!url) throw new Error("Puter.js no devolvió un resultado.");
    await heliosApi.saveGenerated({ historyId: result.historyId, remoteUrl: url, kind });
    applyResult(result.historyId, { imageUrl: kind === "image" ? url : undefined, videoUrl: kind === "video" ? url : undefined, kind });
    notify("Listo (Puter.js).");
  }

  function applyResult(historyId: string | undefined, patch: { imageUrl?: string; videoUrl?: string; kind: "image" | "video" }) {
    setNodes((current) => current.map((node) => {
      if (node.type !== "output") return node;
      return { ...node, data: { ...node.data, imageUrl: patch.imageUrl, videoUrl: patch.videoUrl, kind: patch.kind, historyId } };
    }));
  }

  async function saveProject() {
    try {
      const project = fromFlowProject(projectName, projectId, nodes, edges);
      const result = await heliosApi.saveProject(project);
      setProjectId(result.id);
      setProjects(await heliosApi.listProjects().then((list) => list.projects));
      notify("Proyecto guardado.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "No se pudo guardar");
    }
  }

  async function loadProject(id: string) {
    try {
      const { project } = await heliosApi.getProject(id);
      setNodes(project.nodes.map(toReactNode));
      setEdges(project.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })));
      setProjectName(project.name);
      setProjectId(project.id || id);
      setShowProjects(false);
      setTimeout(() => fitView({ padding: 0.2 }), 50);
      notify(`Proyecto cargado: ${project.name}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "No se pudo cargar");
    }
  }

  async function removeProject(id: string) {
    await heliosApi.deleteProject(id);
    setProjects(await heliosApi.listProjects().then((list) => list.projects));
    if (projectId === id) setProjectId(null);
  }

  function downloadProject() {
    const project = fromFlowProject(projectName, projectId, nodes, edges);
    void heliosApi.saveProject(project).then(async (result) => {
      const response = await fetch(`/api/helios/projects/${encodeURIComponent(result.id)}`);
      const data = await response.json();
      const blob = new Blob([JSON.stringify(data.project, null, 2)], { type: "application/json" });
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = `${projectName.replace(/\s+/g, "-").toLowerCase() || "helios"}.json`;
      anchor.click();
      URL.revokeObjectURL(anchor.href);
    });
  }

  function addNode(type: string) {
    const id = `${type}-${Date.now().toString(36)}`;
    const viewport = getViewport();
    const position = { x: (-viewport.x + 300) / viewport.zoom, y: (-viewport.y + 200) / viewport.zoom };
    const base: Record<string, GraphNodeData> = {
      prompt: { text: "" },
      reference: { images: [] },
      config: { format: "json", value: '{\n  "kind": "image",\n  "model": "pollinations:flux",\n  "prompt": "",\n  "aspectRatio": "1:1"\n}' },
      provider: { model: models[0]?.id },
      output: {},
      note: { text: "" },
    };
    setNodes((current) => [...current, { id, type, position, data: base[type] || {} }]);
  }

  async function saveSettings() {
    try {
      const payload: Record<string, unknown> = {};
      if (geminiKey.trim()) payload.geminiApiKey = geminiKey.trim();
      if (hfToken.trim()) payload.hfToken = hfToken.trim();
      const result = await heliosApi.saveSettings(payload);
      setSettings(result.settings);
      setGeminiKey("");
      setHfToken("");
      notify("Ajustes guardados.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "No se pudieron guardar los ajustes");
    }
  }

  return (
    <NodeContext.Provider value={contextValue}>
    <div className="helios-shell" ref={wrapperRef}>
      <header className="helios-topbar">
        <div className="helios-brand">
          <span className="helios-logo">HG</span>
          <input
            className="helios-project-name"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            placeholder="Nombre del proyecto"
          />
        </div>
        <div className="helios-addbar">
          {[["prompt", "Prompt"], ["reference", "Referencia"], ["config", "Config"], ["provider", "Modelo"], ["output", "Salida"], ["note", "Nota"]].map(([type, label]) => (
            <button key={type} onClick={() => addNode(type)}>+ {label}</button>
          ))}
        </div>
        <div className="helios-actions">
          <button onClick={() => setShowProjects((value) => !value)}>Proyectos</button>
          <button onClick={saveProject}>Guardar</button>
          <button onClick={downloadProject}>Exportar JSON</button>
          <button onClick={() => setShowSettings((value) => !value)}>Ajustes</button>
          <button className="primary" onClick={generate} disabled={busy}>{busy ? "Generando..." : "Generar"}</button>
        </div>
      </header>

      {message && <div className="helios-message">{message}</div>}

      <div className="helios-canvas-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2a3142" />
          <Controls />
          <MiniMap pannable zoomable nodeColor="#5b8cff" maskColor="rgba(8,10,15,.75)" />
        </ReactFlow>

        {showProjects && (
          <div className="helios-drawer">
            <div className="helios-drawer-head"><strong>Proyectos</strong><button onClick={() => setShowProjects(false)}>×</button></div>
            <button className="helios-drawer-new" onClick={() => { setNodes([]); setEdges([]); setProjectId(null); setProjectName("Sin título"); }}>+ Nuevo tapiz</button>
            {projects.map((project) => (
              <div className="helios-drawer-item" key={project.id}>
                <button onClick={() => loadProject(project.id)}>
                  <strong>{project.name}</strong>
                  <small>{project.nodes} nodos</small>
                </button>
                <button className="ghost" onClick={() => removeProject(project.id)}>×</button>
              </div>
            ))}
            {!projects.length && <div className="helios-drawer-empty">No hay proyectos guardados.</div>}
          </div>
        )}

        {showSettings && (
          <div className="helios-drawer helios-settings-drawer">
            <div className="helios-drawer-head"><strong>Ajustes y proveedores</strong><button onClick={() => setShowSettings(false)}>×</button></div>
            <div className="helios-provider-list">
              {providers.map((provider) => (
                <div className="helios-provider-row" key={provider.id}>
                  <div>
                    <strong>{provider.label}</strong>
                    <small>{provider.needsKey ? `Requiere ${provider.keyLabel || "key"}` : "Gratis, sin key"} · {provider.runtime === "browser" ? "navegador" : provider.runtime === "server" ? "servidor" : "ambos"}</small>
                  </div>
                  {provider.docs && <a href={provider.docs} target="_blank" rel="noopener">docs</a>}
                </div>
              ))}
            </div>
            <label className="helios-field">
              <span>Gemini API key (Nano Banana / Imagen) {settings?.hasGeminiKey ? `· guardada ${settings.geminiKeyMasked}` : "· sin configurar"}</span>
              <input value={geminiKey} onChange={(event) => setGeminiKey(event.target.value)} placeholder="AIza..." type="password" />
            </label>
            <label className="helios-field">
              <span>Hugging Face token {settings?.hasHfToken ? `· guardado ${settings.hfTokenMasked}` : "· opcional"}</span>
              <input value={hfToken} onChange={(event) => setHfToken(event.target.value)} placeholder="hf_..." type="password" />
            </label>
            <button className="primary" onClick={saveSettings}>Guardar claves</button>
            <p className="helios-hint">Los proveedores marcados como "sin key" (Puter.js, Pollinations, Google Flow) funcionan sin configurar nada.</p>
          </div>
        )}
      </div>
    </div>
    </NodeContext.Provider>
  );
}

export function HeliosStudio() {
  return (
    <ReactFlowProvider>
      <HeliosInner />
    </ReactFlowProvider>
  );
}
