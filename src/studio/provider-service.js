const { spawn } = require("child_process");
const { getFlowConfig } = require("../flow-config");
const { config } = require("../config");
const { StudioValidationError } = require("./validation");
const { findSpeechEngine } = require("./media-service");

function commandAvailable(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["-version"], { stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function extractJson(text) {
  const value = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(value);
  } catch {
    throw new StudioValidationError("Provider returned invalid JSON.", 502);
  }
}

function localDocument(kind, project) {
  const premise = String(project.prompt || project.objective || project.title || "Untitled story").trim();
  if (kind === "script") {
    const purposes = [
      "Establish the world, central desire, and inciting incident.",
      "Escalate the conflict and force a decisive choice.",
      "Resolve the central question and show the change.",
    ];
    const acts = purposes.map((purpose, index) => ({
      id: `act-${index + 1}`,
      title: `Act ${index + 1}`,
      purpose,
      scenes: [{
        id: `scene-${index + 1}`,
        heading: index === 0 ? "OPENING" : index === 1 ? "TURNING POINT" : "RESOLUTION",
        location: "TBD",
        timeOfDay: "DAY",
        summary: purpose,
        blocks: [{ id: `block-${index + 1}`, type: "action", speaker: "", text: purpose }],
      }],
    }));
    return {
      logline: premise.split(/\n|\./)[0].slice(0, 180),
      synopsis: premise,
      acts,
      scenes: acts.flatMap((act) => act.scenes),
    };
  }
  if (kind === "bible") {
    return {
      summary: `Visual direction for ${project.title}.`,
      style: "Cinematic, coherent, and restrained",
      continuity: "Keep identity, wardrobe, geography, palette, and light direction consistent between shots.",
      canonicalPrompt: premise,
      negativePrompt: "identity drift, inconsistent wardrobe, discontinuous geography, text artifacts",
      palette: ["#20242b", "#d9b26f"],
      locked: false,
      approved: false,
      characters: [],
      locations: [],
      wardrobe: [],
      props: [],
    };
  }
  if (kind === "storyboard") {
    return {
      shots: [{
        id: "shot-1",
        sceneId: "scene-1",
        title: "Opening establishing shot",
        durationMs: Math.min(project.targetDurationSeconds * 1000, 10000),
        camera: "Eye level",
        framing: "Wide",
        lens: "35mm",
        movement: "Locked",
        action: premise,
        dialogue: "",
        prompt: premise,
        referenceAssetIds: [],
        status: "draft",
      }],
      roughCutApproved: false,
    };
  }
  throw new StudioValidationError("Generation supports script, bible, and storyboard.");
}

function requiredShape(kind) {
  if (kind === "script") {
    return "{logline:string,synopsis:string,acts:[{id:string,title:string,purpose:string,scenes:[{id:string,heading:string,location:string,timeOfDay:string,summary:string,blocks:[{id:string,type:'action'|'dialogue'|'voiceover'|'transition',speaker:string,text:string}]}]}],scenes:array}";
  }
  if (kind === "bible") {
    return "{summary:string,style:string,continuity:string,canonicalPrompt:string,negativePrompt:string,palette:string[],locked:false,approved:false,characters:array,locations:array,wardrobe:array,props:array}";
  }
  return "{shots:[{id:string,sceneId:string,title:string,durationMs:integer,camera:string,framing:string,lens:string,movement:string,action:string,dialogue:string,prompt:string,referenceAssetIds:[],status:'draft'}],roughCutApproved:false}";
}

function normalizeProviderDocument(kind, raw, project) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const fallback = localDocument(kind, project);
  if (kind === "script") {
    const acts = Array.isArray(value.acts) && value.acts.length
      ? value.acts
      : [{ id: "act-1", title: "Act 1", purpose: "Generated structure", scenes: Array.isArray(value.scenes) ? value.scenes : [] }];
    return {
      logline: String(value.logline || fallback.logline),
      synopsis: String(value.synopsis || value.text || fallback.synopsis),
      acts,
      scenes: acts.flatMap((act) => Array.isArray(act.scenes) ? act.scenes : []),
    };
  }
  if (kind === "bible") {
    return {
      ...fallback,
      ...value,
      style: typeof value.style === "string" ? value.style : JSON.stringify(value.style || fallback.style),
      characters: Array.isArray(value.characters) ? value.characters : [],
      locations: Array.isArray(value.locations) ? value.locations : [],
      wardrobe: Array.isArray(value.wardrobe) ? value.wardrobe : [],
      props: Array.isArray(value.props) ? value.props : [],
      palette: Array.isArray(value.palette) ? value.palette : fallback.palette,
      locked: false,
      approved: false,
    };
  }
  const shots = (Array.isArray(value.shots) ? value.shots : fallback.shots).map((shot, index) => ({
    id: String(shot?.id || `shot-${index + 1}`).replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 100),
    sceneId: String(shot?.sceneId || ""),
    title: String(shot?.title || `Shot ${index + 1}`),
    durationMs: Number.isInteger(shot?.durationMs) ? shot.durationMs : 3000,
    camera: String(shot?.camera || ""),
    framing: String(shot?.framing || ""),
    lens: String(shot?.lens || ""),
    movement: String(shot?.movement || ""),
    action: String(shot?.action || shot?.description || ""),
    dialogue: String(shot?.dialogue || ""),
    prompt: String(shot?.prompt || shot?.description || ""),
    referenceAssetIds: Array.isArray(shot?.referenceAssetIds) ? shot.referenceAssetIds.map(String) : [],
    status: "draft",
  }));
  return { shots, roughCutApproved: false };
}

class ProviderService {
  constructor({ database, projectService, documentService, jobService, flowConfig = getFlowConfig, fetchImpl = global.fetch, googleFlow }) {
    Object.assign(this, { db: database.db, projectService, documentService, jobService, flowConfig, fetch: fetchImpl, googleFlow });
  }

  async health(accountId) {
    const [flow, ffmpeg, ffprobe, speech] = await Promise.all([
      this.flowConfig(accountId, { includePrivate: true }),
      commandAvailable("ffmpeg"),
      commandAvailable("ffprobe"),
      findSpeechEngine(),
    ]);
    const flowAdapter = typeof this.googleFlow === "function" || typeof this.googleFlow?.generateVideos === "function";
    const unavailable = (available, reason) => ({ available, ...(available ? {} : { reason }) });
    return {
      providers: [
        { id: "local", capability: "text", mode: "deterministic", enabled: true, estimatedCost: 0 },
        { id: "gemini", capability: "text", mode: "api-free-quota", enabled: Boolean(flow.geminiApiKey), estimatedCost: null },
        { id: "external-video", capability: "video", mode: "manual", enabled: true, estimatedCost: 0 },
        { id: "google-flow", capability: "video", mode: "browser-adapter-9:16", enabled: flowAdapter, estimatedCost: null },
        { id: "local-speech", capability: "voice", mode: speech?.id || "unavailable", enabled: Boolean(speech), estimatedCost: 0 },
        { id: "local-media", capability: "proxy-scopes-grade", mode: "ffmpeg", enabled: ffmpeg && ffprobe, estimatedCost: 0 },
        { id: "procedural-audio", capability: "music-sfx", mode: "deterministic", enabled: true, estimatedCost: 0 },
      ],
      tools: { ffmpeg, ffprobe, speech: speech?.id || null },
      capabilities: {
        speech: { ...unavailable(Boolean(speech), "Install espeak-ng or use Windows with System.Speech."), engine: speech?.id || null, mode: "local" },
        proxy: { ...unavailable(ffmpeg, "FFmpeg is not available on PATH."), mode: "local-ffmpeg" },
        scopes: { ...unavailable(ffmpeg, "FFmpeg is not available on PATH."), modes: ["waveform", "vectorscope"] },
        localRelight: { ...unavailable(ffmpeg, "FFmpeg is not available on PATH."), mode: "local-ffmpeg-grade", generative: false },
        proceduralAudio: { available: true, mode: "deterministic-node", formats: ["wav"] },
        flowVideo: { ...unavailable(flowAdapter, "Google Flow generation adapter is unavailable."), mode: "browser-adapter", aspectRatios: ["9:16"], readiness: flowAdapter ? "Sign-in is verified when the job runs." : "unavailable" },
      },
    };
  }

  async gemini(accountId, kind, project) {
    const flow = await this.flowConfig(accountId, { includePrivate: true });
    if (!flow.geminiApiKey) throw new StudioValidationError("Gemini API key is not configured for this account.", 409);
    const sourceKind = kind === "bible" || kind === "storyboard" ? "script" : "brief";
    const sourceDocument = this.documentService.list(accountId, project.id, sourceKind).find((document) => document.status === "approved");
    const sourceContext = sourceDocument ? JSON.stringify(sourceDocument.content).slice(0, 50000) : "No approved source document is available.";
    if (typeof this.fetch !== "function") throw new StudioValidationError("This Node.js runtime does not provide Fetch.", 500);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let response;
    try {
      response = await this.fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel || "gemini-2.5-flash")}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": flow.geminiApiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: [
              `Create a structured ${kind} document for a long-form production.`,
              `Project title: ${project.title}`,
              `Language: ${project.language}`,
              `Objective: ${project.objective}`,
              `Creative prompt: ${project.prompt}`,
              `Approved ${sourceKind} source: ${sourceContext}`,
              `Target duration: ${project.targetDurationSeconds} seconds`,
              `Return only valid JSON matching this exact shape: ${requiredShape(kind)}`,
              "Use stable ASCII identifiers. Do not include Markdown or commentary.",
            ].join("\n") }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.5 },
          }),
          signal: controller.signal,
        }
      );
    } catch (error) {
      throw new StudioValidationError(error.name === "AbortError" ? "Gemini request timed out." : "Gemini request failed.", 502);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      let detail = "";
      try { detail = String((await response.json())?.error?.message || "").slice(0, 300); } catch {}
      const status = response.status === 429 ? 429 : 502;
      throw new StudioValidationError(response.status === 429 ? "Gemini free quota is unavailable or exhausted." : `Gemini request failed with status ${response.status}${detail ? `: ${detail}` : ""}.`, status);
    }
    let body;
    try { body = await response.json(); } catch { throw new StudioValidationError("Gemini returned an invalid response.", 502); }
    const text = body?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
    if (!text) throw new StudioValidationError("Gemini returned no document.", 502);
    return normalizeProviderDocument(kind, extractJson(text), project);
  }

  async generate(accountId, projectId, input = {}) {
    const kind = String(input.kind || "");
    const provider = String(input.provider || "local");
    if (!["script", "bible", "storyboard"].includes(kind)) throw new StudioValidationError("Generation supports script, bible, and storyboard.");
    const project = this.projectService.get(accountId, projectId);
    if (provider === "external-video") {
      const job = this.jobService.enqueue(accountId, projectId, {
        type: "external-video",
        status: "blocked",
        dedupeKey: input.idempotencyKey,
        input: { kind, manual: true, reason: "External video generation requires manual provider handoff." },
      });
      return { job, blocked: true, reason: "External video generation requires manual provider handoff.", estimatedCost: 0 };
    }
    if (!["local", "gemini"].includes(provider)) throw new StudioValidationError("Unsupported generation provider.");
    const latest = this.documentService.list(accountId, projectId, kind)[0]?.version || 0;
    const baseVersion = input.baseVersion === undefined ? latest : Number(input.baseVersion);
    const baseProjectRevision = input.baseProjectRevision === undefined ? project.revision : Number(input.baseProjectRevision);
    const content = provider === "local" ? localDocument(kind, project) : await this.gemini(accountId, kind, project);
    const result = this.documentService.create(accountId, projectId, kind, {
      content,
      baseVersion,
      baseProjectRevision,
      changeNote: `Generated with ${provider}`,
    });
    this.db.prepare("INSERT INTO studio_provider_usage(account_id,project_id,provider,operation,units,estimated_cost,created_at) VALUES (?,?,?,?,1,0,?)")
      .run(accountId, projectId, provider, `generate-${kind}`, new Date().toISOString());
    return { ...result, provider, estimatedCost: provider === "local" ? 0 : null };
  }
}

module.exports = { ProviderService, commandAvailable, localDocument, normalizeProviderDocument, extractJson };
