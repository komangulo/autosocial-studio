const fs = require("fs");
const path = require("path");
const { StudioDatabase } = require("./database");
const { StudioEventHub } = require("./event-hub");
const { StudioProjectService } = require("./project-service");
const { DocumentService } = require("./document-service");
const { TimelineService } = require("./timeline-service");
const { JobService } = require("./job-service");
const { AssetService } = require("./asset-service");
const { ProviderService } = require("./provider-service");
const { RenderService } = require("./render-service");
const { PublicationService } = require("./publication-service");
const { MediaService } = require("./media-service");
const defaultGoogleFlow = require("../google-flow");
const { createStudioRouter } = require("./routes");

function createStudioModule({ rootPath, databasePath, getActiveAccount, requireAccount, getAccountQueueDirs, flowConfig, fetchImpl, googleFlow = defaultGoogleFlow, mediaPollMs, probeImpl }) {
  const resolvedRoot = path.resolve(rootPath); fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  const database = new StudioDatabase(databasePath), eventHub = new StudioEventHub();
  const projectService = new StudioProjectService({ database, rootPath: resolvedRoot, eventHub });
  const documentService = new DocumentService({ database, projectService, eventHub });
  const jobService = new JobService({ database, projectService });
  const assetService = new AssetService({ database, projectService, rootPath: resolvedRoot });
  const timelineService = new TimelineService({ documentService, assetService });
  const mediaService = new MediaService({ database, projectService, documentService, assetService, jobService, googleFlow, pollMs: mediaPollMs });
  const providerService = new ProviderService({ database, projectService, documentService, jobService, flowConfig, fetchImpl, googleFlow });
  const renderService = new RenderService({ database, projectService, documentService, assetService, jobService, rootPath: resolvedRoot });
  const publicationService = new PublicationService({ database, projectService, renderService, getAccountQueueDirs });
  const services = { database, eventHub, projectService, documentService, timelineService, jobService, assetService, mediaService, providerService, renderService, publicationService };
  const router = createStudioRouter({ ...services, rootPath: resolvedRoot, getActiveAccount, requireAccount });
  return { router, ...services, close() { mediaService.close(); renderService.close(); publicationService.close(); database.close(); } };
}
module.exports = { createStudioModule };
