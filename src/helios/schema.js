/**
 * Helios graph project schema.
 *
 * A project is a JSON (or YAML) document that describes a node canvas:
 *
 * {
 *   "version": 1,
 *   "name": "Podcast studio",
 *   "nodes": [
 *     { "id": "n1", "type": "prompt", "position": { "x": 0, "y": 0 }, "data": { "text": "..." } },
 *     { "id": "n2", "type": "config", "position": { "x": 320, "y": 0 }, "data": { "format": "json", "value": "{...}" } },
 *     { "id": "n3", "type": "provider", "position": { "x": 640, "y": 0 }, "data": { "model": "puter:sora-2" } },
 *     { "id": "n4", "type": "output", "position": { "x": 960, "y": 0 }, "data": {} }
 *   ],
 *   "edges": [ { "id": "e1", "source": "n1", "target": "n2" } ]
 * }
 *
 * The `config` node value is the source of truth for generation options and may
 * itself be JSON or YAML. The graph is intentionally permissive: unknown node
 * types survive a round trip so future node kinds do not break old files.
 */

const NODE_TYPES = ["prompt", "reference", "config", "provider", "output", "note"];
const CONFIG_FORMATS = ["json", "yaml"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampPosition(position) {
  const x = Number(position?.x);
  const y = Number(position?.y);
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}

function normalizeNode(raw, index) {
  const id = String(raw?.id || `node-${index + 1}`);
  const type = NODE_TYPES.includes(raw?.type) ? raw.type : "note";
  const data = isPlainObject(raw?.data) ? { ...raw.data } : {};
  return {
    id,
    type,
    position: clampPosition(raw?.position),
    ...(raw?.width ? { width: raw.width } : {}),
    ...(raw?.height ? { height: raw.height } : {}),
    ...(raw?.selected ? { selected: true } : {}),
    data,
  };
}

function normalizeEdge(raw, index) {
  const source = String(raw?.source || "");
  const target = String(raw?.target || "");
  return {
    id: String(raw?.id || `edge-${index + 1}`),
    source,
    target,
    ...(raw?.sourceHandle ? { sourceHandle: raw.sourceHandle } : {}),
    ...(raw?.targetHandle ? { targetHandle: raw.targetHandle } : {}),
  };
}

function emptyProject(name = "Untitled") {
  return {
    version: 1,
    name,
    nodes: [
      { id: "prompt-1", type: "prompt", position: { x: 40, y: 120 }, data: { text: "" } },
      { id: "config-1", type: "config", position: { x: 400, y: 80 }, data: { format: "json", value: defaultConfigValue() } },
      { id: "provider-1", type: "provider", position: { x: 760, y: 140 }, data: { model: "puter:sora-2" } },
      { id: "output-1", type: "output", position: { x: 1120, y: 160 }, data: {} },
    ],
    edges: [
      { id: "e-prompt-config", source: "prompt-1", target: "config-1" },
      { id: "e-config-provider", source: "config-1", target: "provider-1" },
      { id: "e-provider-output", source: "provider-1", target: "output-1" },
    ],
  };
}

function defaultConfigValue() {
  return JSON.stringify(
    {
      kind: "video",
      model: "puter:sora-2",
      prompt: "Describe the scene you want to generate.",
      aspectRatio: "16:9",
      duration: 8,
      resolution: "1080P",
      references: [],
      output: { count: 1 },
    },
    null,
    2
  );
}

function normalizeProject(raw, fallbackName = "Untitled") {
  if (!isPlainObject(raw)) throw new Error("Project must be a JSON object.");
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.map(normalizeNode) : [];
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(raw.edges) ? raw.edges.map(normalizeEdge) : []).filter(
    (edge) => edge.source && edge.target && ids.has(edge.source) && ids.has(edge.target)
  );
  return {
    version: Number(raw.version) || 1,
    name: String(raw.name || fallbackName).slice(0, 200),
    nodes,
    edges,
  };
}

/**
 * Minimal YAML parser/serializer for the subset used by config nodes:
 * plain objects, arrays, strings, numbers, booleans and null. It is not a full
 * YAML 1.2 implementation, but it round-trips the editor's own output and the
 * common hand-written cases. If anything looks ambiguous, the caller should
 * fall back to JSON.
 */
function parseScalar(text) {
  const value = text.trim();
  if (value === "" || value === "~" || value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item));
  }
  if (value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function parseYaml(text) {
  const lines = String(text || "")
    .replace(/\t/g, "  ")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
  let index = 0;

  function parseBlock(indent) {
    const first = lines[index];
    const firstIndent = first.match(/^\s*/)[0].length;
    if (first.trim().startsWith("- ")) {
      const arr = [];
      while (index < lines.length) {
        const line = lines[index];
        const lineIndent = line.match(/^\s*/)[0].length;
        if (lineIndent < indent || !line.trim().startsWith("- ")) break;
        const rest = line.trim().slice(2);
        index += 1;
        if (rest.includes(": ")) {
          const [key, ...tail] = rest.split(": ");
          const obj = { [key.trim()]: parseScalar(tail.join(": ")) };
          const nested = parseNestedForArrayItem(obj, indent + 2);
          arr.push(nested);
        } else if (rest === "") {
          arr.push(parseBlock(indent + 2));
        } else {
          arr.push(parseScalar(rest));
        }
      }
      return arr;
    }
    const obj = {};
    while (index < lines.length) {
      const line = lines[index];
      const lineIndent = line.match(/^\s*/)[0].length;
      if (lineIndent < indent || line.trim().startsWith("- ")) break;
      const match = /^(\s*)([^:]+):\s*(.*)$/.exec(line);
      if (!match) break;
      index += 1;
      const key = match[2].trim();
      const rest = match[3];
      if (rest === "") {
        const nextLine = lines[index];
        const nextIndent = nextLine ? nextLine.match(/^\s*/)[0].length : 0;
        obj[key] = nextLine && nextIndent > lineIndent ? parseBlock(nextIndent) : null;
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  function parseNestedForArrayItem(obj, indent) {
    while (index < lines.length) {
      const line = lines[index];
      const lineIndent = line.match(/^\s*/)[0].length;
      if (lineIndent < indent || line.trim().startsWith("- ")) break;
      const match = /^(\s*)([^:]+):\s*(.*)$/.exec(line);
      if (!match) break;
      index += 1;
      const key = match[2].trim();
      const rest = match[3];
      if (rest === "") {
        const nextLine = lines[index];
        const nextIndent = nextLine ? nextLine.match(/^\s*/)[0].length : 0;
        obj[key] = nextLine && nextIndent > lineIndent ? parseBlock(nextIndent) : null;
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  const result = parseBlock(0);
  return isPlainObject(lines.length ? result : {}) ? result : result;
}

function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return value
      .map((item) => {
        if (isPlainObject(item)) {
          const inner = toYaml(item, indent + 2)
            .split("\n")
            .map((line, i) => (i === 0 ? line.trimStart() : line))
            .join("\n");
          return `${pad}- ${inner}`;
        }
        if (Array.isArray(item)) {
          return `${pad}-\n${toYaml(item, indent + 2)}`;
        }
        return `${pad}- ${formatScalar(item)}`;
      })
      .join("\n");
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return entries
      .map(([key, item]) => {
        if (Array.isArray(item)) {
          if (!item.length) return `${pad}${key}: []`;
          if (item.every((entry) => !isPlainObject(entry) && !Array.isArray(entry))) {
            return `${pad}${key}:\n${toYaml(item, indent + 2)}`;
          }
          return `${pad}${key}:\n${toYaml(item, indent + 2)}`;
        }
        if (isPlainObject(item)) {
          return `${pad}${key}:\n${toYaml(item, indent + 2)}`;
        }
        return `${pad}${key}: ${formatScalar(item)}`;
      })
      .join("\n");
  }
  return `${pad}${formatScalar(value)}`;
}

function formatScalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  return /[:#\[\]{}",\n]|^\s|\s$/.test(text) ? JSON.stringify(text) : text;
}

/** Parse a config node value according to its declared format. */
function parseConfigValue(format, value) {
  const text = String(value || "").trim();
  if (!text) return {};
  if (format === "yaml") {
    try {
      const parsed = parseYaml(text);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringifyConfigValue(format, value) {
  return format === "yaml" ? toYaml(value) : JSON.stringify(value, null, 2);
}

/** Read the text from the first node of a given type connected upstream. */
function incomingText(project, targetId, type) {
  const edges = project.edges.filter((edge) => edge.target === targetId);
  for (const edge of edges) {
    const node = project.nodes.find((n) => n.id === edge.source);
    if (node?.type === type) return node.data?.text ?? node.data?.value ?? "";
  }
  return "";
}

module.exports = {
  NODE_TYPES,
  CONFIG_FORMATS,
  emptyProject,
  defaultConfigValue,
  normalizeProject,
  normalizeNode,
  normalizeEdge,
  parseConfigValue,
  stringifyConfigValue,
  parseYaml,
  toYaml,
  incomingText,
};
