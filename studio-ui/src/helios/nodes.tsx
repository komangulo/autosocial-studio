import { createContext, memo, useContext, type ReactNode } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNodeData, ModelInfo, ProviderInfo } from "./types";

export interface NodeContextValue {
  models: ModelInfo[];
  providers: ProviderInfo[];
  onChange: (id: string, patch: Partial<GraphNodeData>) => void;
  onRemoveImage: (id: string, index: number) => void;
  hasGeminiKey: boolean;
  hasHfToken: boolean;
}

export const NodeContext = createContext<NodeContextValue | null>(null);
export function useNodeContext(): NodeContextValue {
  const ctx = useContext(NodeContext);
  if (!ctx) throw new Error("NodeContext missing");
  return ctx;
}

function Shell({
  title,
  accent,
  selected,
  children,
  inputs = ["in"],
  outputs = ["out"],
}: {
  title: string;
  accent: string;
  selected: boolean;
  children: ReactNode;
  inputs?: string[];
  outputs?: string[];
}) {
  return (
    <div className={`hf-node${selected ? " is-selected" : ""}`} style={{ borderTopColor: accent }}>
      {inputs.map((handle) => (
        <Handle key={`in-${handle}`} id={handle} type="target" position={Position.Left} className="hf-handle" />
      ))}
      <div className="hf-node-head">{title}</div>
      <div className="hf-node-body">{children}</div>
      {outputs.map((handle) => (
        <Handle key={`out-${handle}`} id={handle} type="source" position={Position.Right} className="hf-handle" />
      ))}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { image: "Imagen", video: "Vídeo" };

export const PromptNode = memo(function PromptNode({ id, data, selected }: NodeProps) {
  const ctx = useNodeContext();
  const value = (data as GraphNodeData).text ?? "";
  return (
    <Shell title="Prompt" accent="#5b8cff" selected={Boolean(selected)} outputs={["prompt"]}>
      <textarea
        className="hf-textarea nodrag"
        rows={5}
        value={value}
        placeholder="Describe la escena..."
        onChange={(event) => ctx.onChange(id, { text: event.target.value })}
      />
      <div className="hf-node-meta">{value.length} caracteres</div>
    </Shell>
  );
});

export const ReferenceNode = memo(function ReferenceNode({ id, data, selected }: NodeProps) {
  const ctx = useNodeContext();
  const images = (data as GraphNodeData).images ?? [];
  return (
    <Shell title="Imagen de referencia" accent="#c48a5b" selected={Boolean(selected)} inputs={[]} outputs={["ref"]}>
      <label className="hf-drop">
        <input
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            Array.from(event.target.files || []).forEach((file) => {
              const reader = new FileReader();
              reader.onload = () => {
                const current = (data as GraphNodeData).images ?? [];
                ctx.onChange(id, { images: [...current, { name: file.name, url: String(reader.result) }] });
              };
              reader.readAsDataURL(file);
            });
            event.target.value = "";
          }}
        />
        <span>+ Añadir imagen</span>
      </label>
      {images.length > 0 && (
        <div className="hf-thumbs">
          {images.map((image, index) => (
            <div className="hf-thumb" key={`${image.name}-${index}`}>
              <img src={image.url} alt={image.name} />
              <button className="nodrag" onClick={() => ctx.onRemoveImage(id, index)} title="Quitar">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
});

export const ConfigNode = memo(function ConfigNode({ id, data, selected }: NodeProps) {
  const ctx = useNodeContext();
  const nodeData = data as GraphNodeData;
  const format = nodeData.format ?? "json";
  const value = nodeData.value ?? "";
  return (
    <Shell title={`Configuración (${format.toUpperCase()})`} accent="#8a6bff" selected={Boolean(selected)}>
      <div className="hf-format-tabs nodrag">
        {(["json", "yaml"] as const).map((candidate) => (
          <button
            key={candidate}
            className={format === candidate ? "active" : ""}
            onClick={() => ctx.onChange(id, { format: candidate })}
          >
            {candidate.toUpperCase()}
          </button>
        ))}
      </div>
      <textarea
        className="hf-code nodrag"
        rows={10}
        spellCheck={false}
        value={value}
        onChange={(event) => ctx.onChange(id, { value: event.target.value })}
      />
    </Shell>
  );
});

export const ProviderNode = memo(function ProviderNode({ id, data, selected }: NodeProps) {
  const ctx = useNodeContext();
  const nodeData = data as GraphNodeData;
  const model = ctx.models.find((candidate) => candidate.id === nodeData.model) || ctx.models[0];
  const provider = ctx.providers.find((candidate) => candidate.id === model?.provider);

  const grouped = ctx.models.reduce<Record<string, ModelInfo[]>>((acc, item) => {
    (acc[item.provider] ||= []).push(item);
    return acc;
  }, {});

  return (
    <Shell title="Modelo / Proveedor" accent="#3fb950" selected={Boolean(selected)} outputs={["model"]}>
      <select
        className="hf-select nodrag"
        value={model?.id || ""}
        onChange={(event) => ctx.onChange(id, { model: event.target.value })}
      >
        {Object.entries(grouped).map(([providerId, items]) => (
          <optgroup key={providerId} label={ctx.providers.find((p) => p.id === providerId)?.label || providerId}>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {provider && (
        <div className="hf-node-meta">
          {provider.label}
          {provider.needsKey ? (provider.id === "google" ? (ctx.hasGeminiKey ? " · key ✓" : " · falta key") : ctx.hasHfToken ? " · token ✓" : " · falta token") : " · sin key"}
        </div>
      )}
    </Shell>
  );
});

export const OutputNode = memo(function OutputNode({ data, selected }: NodeProps) {
  const nodeData = data as GraphNodeData;
  const url = nodeData.imageUrl || nodeData.videoUrl;
  return (
    <Shell title="Salida" accent="#e0a73c" selected={Boolean(selected)} inputs={["in"]} outputs={[]}>
      {url ? (
        nodeData.videoUrl
          ? <video className="hf-result" src={String(url)} controls autoPlay loop />
          : <img className="hf-result" src={String(url)} alt="resultado" />
      ) : (
        <div className="hf-placeholder">Sin resultado todavía</div>
      )}
      {Boolean(nodeData.kind) && <div className="hf-node-meta">{KIND_LABEL[String(nodeData.kind)] || String(nodeData.kind)}</div>}
    </Shell>
  );
});

export const NoteNode = memo(function NoteNode({ id, data, selected }: NodeProps) {
  const ctx = useNodeContext();
  return (
    <Shell title="Nota" accent="#6b7280" selected={Boolean(selected)} inputs={[]} outputs={[]}>
      <textarea
        className="hf-textarea nodrag"
        rows={3}
        value={(data as GraphNodeData).text ?? ""}
        placeholder="Notas..."
        onChange={(event) => ctx.onChange(id, { text: event.target.value })}
      />
    </Shell>
  );
});

export const nodeTypes = {
  prompt: PromptNode,
  reference: ReferenceNode,
  config: ConfigNode,
  provider: ProviderNode,
  output: OutputNode,
  note: NoteNode,
};
