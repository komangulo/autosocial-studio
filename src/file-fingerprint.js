const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");

async function fingerprintFile(filePath) {
  const stat = await fsp.stat(filePath);
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return { sizeBytes: stat.size, sha256: hash.digest("hex") };
}

module.exports = { fingerprintFile };
