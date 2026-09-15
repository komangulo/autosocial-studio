const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const source = path.join(projectRoot, "node_modules", "@phosphor-icons", "web", "src", "regular");
const target = path.join(projectRoot, "web", "vendor", "phosphor");
fs.mkdirSync(target, { recursive: true });
for (const name of ["style.css", "Phosphor.woff2"]) {
  fs.copyFileSync(path.join(source, name), path.join(target, name));
}
console.log("Local Phosphor assets copied.");
