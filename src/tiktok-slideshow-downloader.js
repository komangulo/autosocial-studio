const fs = require("fs/promises");
const path = require("path");

const INFO_JSON_SUFFIX = ".info.json";

function normalizeUrlCandidate(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }

  return null;
}

function pickFirstUrl(...candidates) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (Array.isArray(candidate)) {
      for (const value of candidate) {
        const normalized = normalizeUrlCandidate(value);
        if (normalized) {
          return normalized;
        }
      }
      continue;
    }

    const normalized = normalizeUrlCandidate(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractScriptJson(html, scriptId) {
  const escapedId = escapeRegExp(scriptId);
  const regex = new RegExp(
    `<script[^>]+id=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/script>`,
    "i"
  );
  const match = html.match(regex);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function findItemStructById(root, videoId) {
  if (!root || typeof root !== "object") {
    return null;
  }

  const stack = [root];
  const seen = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (
      isObject(current) &&
      (current.id === videoId ||
        current.aweme_id === videoId ||
        current.awemeId === videoId ||
        current.itemId === videoId)
    ) {
      return current;
    }

    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry);
      }
      continue;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return null;
}

function findFirstArrayByKeys(root, allowedKeys) {
  if (!root || typeof root !== "object") {
    return null;
  }

  const stack = [root];
  const seen = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      for (const entry of current) {
        if (entry && typeof entry === "object") {
          stack.push(entry);
        }
      }
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      if (allowedKeys.has(key) && Array.isArray(value) && value.length > 0) {
        return value;
      }

      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return null;
}

function extractImageUrlFromEntry(entry) {
  if (typeof entry === "string") {
    return normalizeUrlCandidate(entry);
  }

  if (!isObject(entry)) {
    return null;
  }

  return pickFirstUrl(
    entry.imageURL?.urlList,
    entry.imageUrl?.urlList,
    entry.displayImage?.urlList,
    entry.ownerWatermarkImage?.urlList,
    entry.thumbnail?.urlList,
    entry.urlList,
    entry.url,
    entry.src
  );
}

function extractItemStructFromHtml(html, videoId) {
  const universal = extractScriptJson(html, "__UNIVERSAL_DATA_FOR_REHYDRATION__");
  const universalItem =
    universal?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
    findItemStructById(universal, videoId);
  if (universalItem) {
    return universalItem;
  }

  const sigi =
    extractScriptJson(html, "SIGI_STATE") ||
    extractScriptJson(html, "sigi-persisted-data");
  return findItemStructById(sigi, videoId);
}

function extractSlideshowImageUrls(itemStruct) {
  if (!itemStruct) {
    return [];
  }

  const imageEntries =
    itemStruct.imagePost?.images ||
    itemStruct.imagePost?.imageList ||
    itemStruct.images ||
    findFirstArrayByKeys(
      itemStruct.imagePost || itemStruct,
      new Set(["images", "imageList", "slides"])
    );

  if (!Array.isArray(imageEntries) || imageEntries.length === 0) {
    return [];
  }

  const urls = [];
  const seen = new Set();

  for (const entry of imageEntries) {
    const url = extractImageUrlFromEntry(entry);
    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    urls.push(url);
  }

  return urls;
}

function looksLikeAudioOnlyFormat(formats) {
  if (!Array.isArray(formats) || formats.length === 0) {
    return false;
  }

  let sawAudioOnly = false;
  for (const format of formats) {
    if (!format || typeof format !== "object") {
      continue;
    }

    const vcodec = String(format.vcodec || "").toLowerCase();
    if (vcodec && vcodec !== "none") {
      return false;
    }

    if (vcodec === "none") {
      sawAudioOnly = true;
    }
  }

  return sawAudioOnly;
}

function isLikelySlideshowInfo(info) {
  if (!info || typeof info !== "object") {
    return false;
  }

  const webpageUrl = String(info.webpage_url || info.original_url || "");
  if (!/tiktok\.com/i.test(webpageUrl)) {
    return false;
  }

  if (looksLikeAudioOnlyFormat(info.formats)) {
    return true;
  }

  const ext = String(info.ext || "").toLowerCase();
  return ext === "m4a" || ext === "mp3" || ext === "aac";
}

function getBaseStemFromInfoJsonPath(infoJsonPath) {
  const fileName = path.basename(infoJsonPath);
  if (!fileName.endsWith(INFO_JSON_SUFFIX)) {
    return path.join(path.dirname(infoJsonPath), path.parse(fileName).name);
  }

  return path.join(
    path.dirname(infoJsonPath),
    fileName.slice(0, -INFO_JSON_SUFFIX.length)
  );
}

function getHeadersFromInfo(info) {
  const sourceHeaders = isObject(info.http_headers) ? info.http_headers : {};
  const headers = {
    "User-Agent":
      sourceHeaders["User-Agent"] ||
      sourceHeaders["user-agent"] ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    Accept:
      sourceHeaders.Accept ||
      sourceHeaders.accept ||
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language":
      sourceHeaders["Accept-Language"] ||
      sourceHeaders["accept-language"] ||
      "en-US,en;q=0.9",
  };

  const referer =
    sourceHeaders.Referer ||
    sourceHeaders.referer ||
    info.webpage_url ||
    info.original_url;
  if (referer) {
    headers.Referer = referer;
  }

  return headers;
}

async function fetchText(url, headers) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is unavailable. Node 18+ is required.");
  }

  const response = await fetch(url, {
    headers,
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while requesting ${url}`);
  }

  return response.text();
}

function inferImageExtension(url, contentType) {
  const normalizedType = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  const typeMap = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
  };

  if (typeMap[normalizedType]) {
    return typeMap[normalizedType];
  }

  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).replace(/^\./, "").toLowerCase();
    if (ext) {
      return ext;
    }
  } catch {
    // Ignore bad URLs and fall back to jpg.
  }

  return "jpg";
}

async function downloadImage(url, destinationStem, headers) {
  const response = await fetch(url, {
    headers: {
      ...headers,
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while downloading ${url}`);
  }

  const extension = inferImageExtension(
    response.url || url,
    response.headers.get("content-type")
  );
  const finalPath = `${destinationStem}.${extension}`;
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(finalPath, buffer);
  return finalPath;
}

async function collectRecentInfoJsonFiles(rootDir, sinceMs) {
  const infoFiles = [];

  async function walk(currentDir) {
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(INFO_JSON_SUFFIX)) {
        continue;
      }

      try {
        const stat = await fs.stat(fullPath);
        if (stat.mtimeMs >= sinceMs - 2000) {
          infoFiles.push(fullPath);
        }
      } catch {
        // Ignore files that disappear mid-scan.
      }
    }
  }

  await walk(rootDir);
  return infoFiles.sort((a, b) => a.localeCompare(b));
}

async function downloadSlideshowAssetsForInfo(infoJsonPath, log) {
  let info;
  try {
    info = JSON.parse(await fs.readFile(infoJsonPath, "utf8"));
  } catch (error) {
    log(
      `Could not read slideshow info file ${path.basename(infoJsonPath)}: ${error.message}`,
      "error"
    );
    return { processed: false, imageCount: 0 };
  }

  if (!isLikelySlideshowInfo(info)) {
    return { processed: false, imageCount: 0 };
  }

  const webpageUrl = info.webpage_url || info.original_url;
  if (!webpageUrl) {
    log(
      `Skipping slideshow asset lookup for ${path.basename(infoJsonPath)}: missing webpage URL.`,
      "error"
    );
    return { processed: false, imageCount: 0 };
  }

  log(
    `Detected audio-only TikTok post ${info.id || path.basename(
      infoJsonPath
    )}. Looking for slideshow images...`
  );

  let html;
  try {
    html = await fetchText(webpageUrl, getHeadersFromInfo(info));
  } catch (error) {
    log(`Could not fetch slideshow page ${webpageUrl}: ${error.message}`, "error");
    return { processed: false, imageCount: 0 };
  }

  const itemStruct = extractItemStructFromHtml(html, String(info.id || ""));
  const imageUrls = extractSlideshowImageUrls(itemStruct);

  if (imageUrls.length === 0) {
    log(`No slideshow images found for ${info.id || path.basename(infoJsonPath)}.`, "error");
    return { processed: true, imageCount: 0 };
  }

  const slidesDir = `${getBaseStemFromInfoJsonPath(infoJsonPath)}_slides`;
  await fs.mkdir(slidesDir, { recursive: true });

  const headers = getHeadersFromInfo(info);
  let downloadedCount = 0;

  for (let index = 0; index < imageUrls.length; index += 1) {
    const targetStem = path.join(
      slidesDir,
      `slide-${String(index + 1).padStart(2, "0")}`
    );

    try {
      const finalPath = await downloadImage(imageUrls[index], targetStem, headers);
      downloadedCount += 1;
      log(
        `  Saved slideshow image ${downloadedCount}/${imageUrls.length}: ${path.basename(
          finalPath
        )}`
      );
    } catch (error) {
      log(`  Failed to download slideshow image ${index + 1}: ${error.message}`, "error");
    }
  }

  if (downloadedCount > 0) {
    log(`Saved ${downloadedCount} slideshow image(s) to ${slidesDir}`);
  }

  return {
    processed: true,
    imageCount: downloadedCount,
  };
}

async function enrichRecentSlideshowDownloads(downloadsDir, sinceMs, log) {
  const infoJsonFiles = await collectRecentInfoJsonFiles(downloadsDir, sinceMs);
  if (infoJsonFiles.length === 0) {
    return {
      candidates: 0,
      processed: 0,
      images: 0,
    };
  }

  let processed = 0;
  let images = 0;

  for (const infoJsonPath of infoJsonFiles) {
    const result = await downloadSlideshowAssetsForInfo(infoJsonPath, log);
    if (!result.processed) {
      continue;
    }

    processed += 1;
    images += result.imageCount;
  }

  return {
    candidates: infoJsonFiles.length,
    processed,
    images,
  };
}

module.exports = {
  enrichRecentSlideshowDownloads,
};
