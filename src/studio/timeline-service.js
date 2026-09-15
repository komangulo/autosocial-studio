const { StudioValidationError } = require("./validation");

class TimelineService {
  constructor({ documentService, assetService }) {
    this.documentService = documentService;
    this.assetService = assetService;
  }
  list(accountId, projectId) { return this.documentService.list(accountId, projectId, "timeline"); }
  get(accountId, projectId, version) { return this.documentService.get(accountId, projectId, "timeline", version); }
  create(accountId, projectId, input) { return this.documentService.create(accountId, projectId, "timeline", input); }
  approve(accountId, projectId, version, input) { return this.documentService.approve(accountId, projectId, "timeline", version, input); }
  restore(accountId, projectId, version, input) { return this.documentService.restore(accountId, projectId, "timeline", version, input); }

  createRoughCut(accountId, projectId, input = {}) {
    const storyboard = this.documentService.list(accountId, projectId, "storyboard").find((item) => item.status === "approved");
    if (!storyboard) throw new StudioValidationError("An approved storyboard is required for an automatic rough cut.", 409);
    const shots = storyboard.content?.shots;
    if (!Array.isArray(shots) || !shots.length || shots.length > 2000) throw new StudioValidationError("Approved storyboard must contain between 1 and 2000 shots.", 409);
    let startMs = 0;
    const clips = shots.map((shot, index) => {
      const durationMs = Number(shot?.durationMs);
      if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 86_400_000 - startMs) throw new StudioValidationError(`Storyboard shot ${index + 1} has an invalid duration.`);
      let assetId = shot?.generatedAssetId || shot?.assetId;
      if (!assetId) {
        const references = Array.isArray(shot?.referenceAssetIds) ? shot.referenceAssetIds : [];
        if (references.length !== 1) throw new StudioValidationError(`Storyboard shot ${index + 1} must identify one generated asset, asset, or reference asset.`);
        [assetId] = references;
      }
      const asset = this.assetService.get(accountId, projectId, String(assetId));
      if (!asset || !["video", "image"].includes(asset.kind)) throw new StudioValidationError(`Storyboard shot ${index + 1} requires a visual asset.`);
      const clip = {
        id: `rough-cut-${index + 1}`,
        shotId: String(shot?.id || `shot-${index + 1}`),
        assetId: asset.id,
        startMs,
        durationMs,
      };
      startMs += durationMs;
      return clip;
    });
    return this.documentService.create(accountId, projectId, "timeline", {
      content: {
        durationMs: startMs,
        sourceStoryboardVersion: storyboard.version,
        tracks: [{ id: "rough-cut-video", type: "video", clips }],
      },
      baseVersion: input.baseVersion,
      baseProjectRevision: input.baseProjectRevision,
      changeNote: input.changeNote || `Automatic rough cut from approved storyboard v${storyboard.version}`,
    });
  }
}
module.exports = { TimelineService };
