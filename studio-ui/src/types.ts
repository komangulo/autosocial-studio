export type PipelineStage = { id: string; label: string; status: "completed" | "ready" | "blocked" };
export type StudioProject = { id: string; accountId: string; title: string; contentType: string; objective: string; prompt: string; language: string; targetDurationSeconds: number; aspectRatio: "16:9" | "9:16"; width: number; height: number; fps: number; status: string; currentStage: string; revision: number; createdAt: string; updatedAt: string; pipeline: PipelineStage[] };
export type StorageStatus = { known: boolean; freeBytes: number | null; totalBytes: number | null; minimumFreeBytes: number; recommendedFreeBytes: number; longFormReady: boolean; error?: string };
export type Provider = { id: string; capability: string; mode: string; enabled: boolean };
export type StudioHealth = { ok: true; account: { id: string; name: string }; storage: StorageStatus; limits: { maxDurationSeconds: number; aspectRatios: string[]; maxWidth: number; maxHeight: number; zeroBudgetMode: boolean }; providers: Provider[] };
export type ProjectInput = { title: string; contentType: string; objective: string; prompt: string; language: string; targetDurationSeconds: number; aspectRatio: "16:9" | "9:16"; fps: number };

export type DocumentKind = "brief" | "script" | "bible" | "references" | "storyboard" | "timeline" | "graph";
export type VersionSummary = { version: number; approved: boolean; changeNote?: string; createdAt?: string; updatedAt?: string };
export type VersionedDocument<T> = { kind: DocumentKind; version: number; projectRevision: number; approved: boolean; content: T; changeNote?: string; createdAt?: string };
export type DocumentResult<T> = { document: VersionedDocument<T> | null; versions: VersionSummary[] };

export type BriefContent = { title: string; audience: string; objective: string; format: string; tone: string; themes: string; constraints: string; successCriteria: string };
export type ScriptBlock = { id: string; type: "action" | "dialogue" | "voiceover" | "transition"; speaker: string; text: string };
export type ScriptScene = { id: string; heading: string; location: string; timeOfDay: string; summary: string; blocks: ScriptBlock[] };
export type ScriptAct = { id: string; title: string; purpose: string; scenes: ScriptScene[] };
export type ScriptContent = { logline: string; synopsis: string; acts: ScriptAct[] };
export type BibleEntityKind = "characters" | "locations" | "wardrobe" | "props";
export type BibleEntity = { id: string; name: string; description: string; continuity: string; canonicalPrompt: string; negativePrompt: string; assetIds: string[]; locked: boolean; approved: boolean };
export type BibleContent = { style: string; continuity: string; canonicalPrompt: string; negativePrompt: string; palette: string[]; locked: boolean; approved: boolean; characters: BibleEntity[]; locations: BibleEntity[]; wardrobe: BibleEntity[]; props: BibleEntity[] };
export type ReferencesContent = { notes: string; assetIds: string[]; locked: boolean; approved: boolean };
export type ShotStatus = "draft" | "ready" | "approved" | "generating" | "failed";
export type StoryboardShot = { id: string; sceneId: string; title: string; durationMs: number; camera: string; framing: string; lens: string; movement: string; action: string; dialogue: string; prompt: string; referenceAssetIds: string[]; generatedAssetId?: string; status: ShotStatus };
export type StoryboardContent = { shots: StoryboardShot[]; roughCutApproved: boolean };

export type GraphNode = { id: string; label: string; type: string; x: number; y: number; workspace: string; config: Record<string, unknown> };
export type GraphEdge = { id: string; from: string; to: string };
export type GraphContent = { nodes: GraphNode[]; edges: GraphEdge[]; settings: { autoRun: boolean } };

export type AssetKind = "image" | "video" | "audio" | "subtitle" | "lut" | "other";
export type ProxyStatus = "none" | "queued" | "processing" | "completed" | "failed";
export type StudioAsset = { id: string; projectId: string; name: string; kind: AssetKind; mimeType: string; sizeBytes: number; durationMs?: number; createdAt?: string; contentUrl: string; proxyStatus?: ProxyStatus; proxyAvailable?: boolean; proxyError?: string };
export type Keyframe<T = number> = { id: string; timeMs: number; value: T; easing: "linear" | "ease-in" | "ease-out" | "ease-in-out" };
export type ClipTransform = { opacity: number; x: number; y: number; scale: number; rotation: number; keyframes: Record<string, Keyframe[]> };
export type ColorGrade = { exposure: number; contrast: number; gamma: number; highlights: number; shadows: number; saturation: number; temperature: number; tint: number; vignette: number; keyframes: Record<string, Keyframe[]> };
export type AudioRole = "dialogue" | "voiceover" | "music" | "sfx";
export type AudioMix = { gainDb: number; pan: number; muted: boolean; solo: boolean; fadeInMs: number; fadeOutMs: number; ducking: number; normalization: "none" | "peak" | "loudness"; role: AudioRole; peakDb?: number };
export type TimelineClip = { id: string; trackId: string; assetId?: string; name: string; kind: AssetKind; startMs: number; durationMs: number; sourceStartMs: number; transform: ClipTransform; grade: ColorGrade; audio: AudioMix };
export type TimelineTrack = { id: string; name: string; kind: "video" | "audio" | "subtitle"; muted: boolean; solo: boolean; locked: boolean; clips: TimelineClip[] };
export type SubtitleCue = { id: string; startMs: number; endMs: number; text: string };
export type SubtitleStyle = { fontFamily: string; fontSize: number; textColor: string; backgroundColor: string; position: "top" | "center" | "bottom"; animation: "none" | "fade" | "pop" | "karaoke" };
export type TimelineContent = { durationMs: number; tracks: TimelineTrack[]; subtitles: SubtitleCue[]; subtitleStyle: SubtitleStyle; lutAssetId?: string };

export type MediaJobInput =
  | { operation: "proxy"; assetId: string }
  | { operation: "speech"; text: string; language: string; voice?: string; rate?: number }
  | { operation: "procedural-audio"; audioKind: "music" | "sfx"; durationMs: number; seed?: number; preset?: string }
  | { operation: "scopes"; assetId: string; scope: "waveform" | "vectorscope" }
  | { operation: "local-relight"; assetId: string; exposure: number; temperature: number; tint: number; vignette: number }
  | { operation: "flow-video"; shotIds: string[] };
export type StudioJob = { id: string; projectId: string; kind: string; provider: string; status: string; progress?: number; error?: string; outputAssetId?: string; input?: Record<string, unknown>; createdAt?: string };
export type RenderPreset = "preview" | "1080p-horizontal" | "1080p-vertical" | "4k-horizontal" | "4k-vertical";
export type RenderOptions = { subtitleMode: "embed" | "burn"; subtitleStyle: SubtitleStyle; lutAssetId?: string; codec?: string };
export type StudioRender = { id: string; projectId: string; preset: RenderPreset; status: string; progress?: number; outputUrl?: string; error?: string; createdAt?: string };
export type PublicationPlatform = "youtube" | "tiktok" | "instagram";
export type StudioPublication = { id: string; projectId: string; renderId: string; platform: PublicationPlatform; caption: string; scheduledAt?: string; idempotencyKey: string; status: string; remoteId?: string; remoteUrl?: string; evidence?: string; blockedReason?: string; error?: string; createdAt?: string };
export type PublicationConfirmation = { status: "published" | "failed" | "uncertain"; remoteId?: string; remoteUrl?: string; evidence?: string };
