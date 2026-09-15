export type GraphNodeType = "prompt" | "reference" | "config" | "provider" | "output" | "note";

export interface GraphNodeData {
  text?: string;
  value?: string;
  format?: "json" | "yaml";
  model?: string;
  images?: ReferenceImage[];
  [key: string]: unknown;
}

export interface ReferenceImage {
  name: string;
  url: string;
}

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  data: GraphNodeData;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface GraphProject {
  version: number;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  id?: string;
  updatedAt?: string | null;
}

export interface ModelInfo {
  id: string;
  provider: string;
  providerModel: string;
  name: string;
  ratios?: string[];
  defaultRatio?: string;
  durations?: number[];
  defaultDuration?: number;
  resolutions?: string[];
  defaultResolution?: string;
  supportsReference?: boolean;
  maxReferences?: number;
  requiredReferences?: number;
}

export interface ProviderInfo {
  id: string;
  label: string;
  needsKey: boolean;
  runtime: "browser" | "server" | "any";
  keyLabel?: string;
  docs?: string;
}

export interface HeliosSettings {
  providers: ProviderInfo[];
  geminiKeyMasked: string;
  hfTokenMasked: string;
  hasGeminiKey: boolean;
  hasHfToken: boolean;
  autoDownload: boolean;
}

export interface HistoryItem {
  id: string;
  kind: "image" | "video";
  status: string;
  prompt: string;
  model: string;
  modelName: string;
  provider: string;
  aspectRatio?: string;
  imageUrl?: string;
  videoUrl?: string;
  error?: string;
  createdAt: string;
}

export interface GenerateResult {
  ok?: boolean;
  historyId?: string;
  client?: "puter" | "flow";
  call?: { method: string; prompt: string; model: string; options: Record<string, unknown> };
  status?: string;
  imageUrl?: string;
  videoUrl?: string;
  error?: string;
}
