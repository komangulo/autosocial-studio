const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_HOSTS = new Set(["localhost:3028", "127.0.0.1:3028", "[::1]:3028"]);

function getHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  return headers[name.toLowerCase()] || headers[name] || "";
}

function isLoopbackAddress(value) {
  const address = String(value || "127.0.0.1").replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1";
}

function hasSameHost(urlValue, host) {
  if (!urlValue || !host || urlValue === "null") return false;
  try {
    const parsed = new URL(urlValue);
    return parsed.protocol === "http:" && parsed.host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

function isAllowedDashboardRequest({ method, headers, remoteAddress }) {
  const host = getHeader(headers, "host").toLowerCase();
  if (!isLoopbackAddress(remoteAddress) || !ALLOWED_HOSTS.has(host)) return false;
  if (SAFE_METHODS.has(String(method || "").toUpperCase())) return true;

  const fetchSite = getHeader(headers, "sec-fetch-site").toLowerCase();
  if (fetchSite === "cross-site") return false;
  const origin = getHeader(headers, "origin");
  const referer = getHeader(headers, "referer");
  return hasSameHost(origin || referer, host);
}

function createDashboardRequestGuard() {
  return (req, res, next) => {
    if (isAllowedDashboardRequest({
      method: req.method,
      headers: req.headers,
      remoteAddress: req.socket?.remoteAddress,
    })) {
      next();
      return;
    }
    res.status(403).json({ ok: false, error: "Only same-origin requests from localhost:3028 are allowed." });
  };
}

module.exports = { createDashboardRequestGuard, isAllowedDashboardRequest, isLoopbackAddress };
