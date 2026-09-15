const fs = require("fs");

const css = fs.readFileSync("web/style.css", "utf8").replace(/@import[^;]+;/g, "");
const phosphor = fs.readFileSync("web/vendor/phosphor/style.css", "utf8");
const html = fs.readFileSync("web/index.html", "utf8");
const autopost = fs.readFileSync("web/autopost.js", "utf8");

const match = html.match(/<section id="view-tiktok"[\s\S]*?<\/section>/);
let section = match ? match[0] : "";
section = section.replace('class="view-section"', 'class="view-section active"');
// Strip the native tiktok sync bits we cannot run offline; keep the new panel.
const appjs = fs.readFileSync("web/app.js", "utf8");
const API = `const API = { async request(e,o={}){const r=await fetch(e,o);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('API '+r.status));return d;}, get(e){return this.request(e);}, post(e,b){return this.request(e,{method:'POST',headers:{'Content-Type':'application/json'},body:b!==undefined?JSON.stringify(b):undefined});} };`;
const demo = `
API.get = async () => ({ activeAccount: { id: 'default', name: 'Cuenta TikTok' } });
API.post = async (url) => {
  if (url.endsWith('/list')) return { ok:true, folder:'C:\\\\Videos\\\\TikTok\\\\jayandrews69', videos:['7684651993666686222_unique.mp4','7684486413802310942_unique.mp4','7684551111222333444_unique.mp4'] };
  if (url.endsWith('/preview')) return { ok:true, timezone:'Europe/Madrid', total:3, plan:[
    {videoName:'7684651993666686222_unique.mp4', local:'2026-09-14 10:00'},
    {videoName:'7684486413802310942_unique.mp4', local:'2026-09-14 18:00'},
    {videoName:'7684551111222333444_unique.mp4', local:'2026-09-16 10:00'} ] };
  return { ok:true, total:3, created:[{videoName:'7684651993666686222_unique.mp4',local:'2026-09-14 10:00'},{videoName:'7684486413802310942_unique.mp4',local:'2026-09-14 18:00'},{videoName:'7684551111222333444_unique.mp4',local:'2026-09-16 10:00'}] };
};
document.addEventListener('autosocial:viewchange', ()=>{});
${autopost}
setTimeout(()=>{ document.getElementById('apLoadBtn').click(); setTimeout(()=>document.getElementById('apPreviewBtn').click(), 200); }, 300);
`;

const out = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${phosphor}
${css}</style></head>
<body style="background:#09090b;color:#f4f4f5">
<div style="display:flex;min-height:100vh">
<aside class="sidebar" style="width:270px">
<div class="brand"><span class="brand-name">AutoSocial</span></div>
<nav class="nav-menu">
<button class="nav-item active" data-view="tiktok"><i class="ph ph-tiktok-logo"></i><span>TikTok Auto Post</span></button>
<button class="nav-item" data-view="autoclone"><i class="ph ph-magic-wand"></i><span>Auto Clone</span></button>
</nav></aside>
<main class="main-content" style="flex:1;padding:32px;max-width:1100px">
${section}
</main></div>
<script>${API}
${appjs.replace(/\(function[\s\S]*/,'')}
${demo}</script></body></html>`;

fs.writeFileSync("web/autopost-preview.html", out);
console.log("preview bytes", out.length);
