const fs = require("fs");

const css = fs.readFileSync("web/style.css", "utf8").replace(/@import[^;]+;/g, "");
const phosphor = fs.readFileSync("web/vendor/phosphor/style.css", "utf8");
const html = fs.readFileSync("web/index.html", "utf8");
const auto = fs.readFileSync("web/autoclone.js", "utf8");
const appjs = fs.readFileSync("web/app.js", "utf8");

const match = html.match(/<section id="view-autoclone"[\s\S]*?<\/section>/);
let section = match ? match[0] : "";
section = section.replace('class="view-section"', 'class="view-section active"');

const demo = `
function demoRun(){
  var steps=[
    ["analysis","Analizando el perfil @usuario...","8"],
    ["download","Descargando video 3/6...","38"],
    ["translate","Leyendo y traduciendo el texto del video 3...","61"],
    ["uniquify","Uniquificando el video 3...","74"],
    ["done","Pipeline completado: 6 de 6 videos.","100"]
  ];
  steps.forEach(function(s,i){
    setTimeout(function(){
      document.getElementById("autocloneStage").textContent=s[1];
      document.getElementById("autocloneBarFill").style.width=s[2]+"%";
      if(s[0]==="download"){
        var rows="";
        for(var n=1;n<=4;n++){
          var ok=n<4;
          var tag=ok?"texto traducido (7)":"sin texto traducible";
          rows+='<div class="autoclone-video"><span class="autoclone-video-idx">'+n+'</span>'
            +'<div class="autoclone-video-body"><span class="autoclone-video-id">7378496789139'+n+'8</span>'
            +'<span class="autoclone-video-tags">'+tag+'</span>'
            +(ok?'':'<span class="autoclone-video-err">No se detecto texto traducible (La API key no es valida.)</span>')
            +'</div>'
            +'<span class="autoclone-video-status '+(ok?"ok":"wait")+'">'+(ok?"Listo":"Pendiente")+'</span>'
            +(ok?'<a class="control-btn-small" href="#">Descargar</a>':'')+'</div>';
        }
        document.getElementById("autocloneVideos").innerHTML=rows;
      }
      if(s[0]==="analysis"){
        document.getElementById("autocloneAnalysis").hidden=false;
        document.getElementById("autocloneAnalysis").innerHTML='<div class="card"><div class="card-title">Análisis del perfil @usuario</div><p>Contenido de nicho con ganchos visuales fuertes en los primeros 3 segundos. Predominan vídeos cortos con texto grande en pantalla y música trending.</p><div class="autoclone-metrics"><span><strong>482K</strong> vistas medias</span><span><strong>24</strong> vídeos</span><span><strong>7.4%</strong> engagement</span></div></div>';
      }
    }, i*700);
  });
}
document.addEventListener("DOMContentLoaded", function(){ if(window.Router) Router.init(); });
`;

const out = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${phosphor}
${css}</style></head>
<body>
<div style="display:flex;min-height:100vh">
<aside class="sidebar" style="width:292px">
<div class="brand"><span class="brand-name">AutoSocial</span></div>
<nav class="nav-menu">
<button class="nav-item" data-view="overview"><i class="ph ph-house"></i><span>Overview</span></button>
<button class="nav-item active" data-view="autoclone"><i class="ph ph-magic-wand"></i><span>Auto Clone</span></button>
<button class="nav-item" data-view="competitor"><i class="ph ph-binoculars"></i><span>Competencia</span></button>
<button class="nav-item" data-view="uniquifier"><i class="ph ph-fingerprint"></i><span>Video Uniquifier</span></button>
<button class="nav-item" data-view="setup"><i class="ph ph-gear"></i><span>Setup</span></button>
<button class="nav-item" data-view="settings"><i class="ph ph-sliders"></i><span>Settings</span></button>
</nav></aside>
<main class="main-content" style="flex:1;padding:32px;max-width:1100px">
${section}
<div class="card" style="margin-top:16px;padding:16px">
<div class="card-title">Simulación visual (sin backend)</div>
<button class="control-btn primary" onclick="demoRun()"><i class="ph ph-lightning"></i> Ver estados de demo</button>
</div>
</main></div>
<script>${appjs}
${auto}
${demo}</script></body></html>`;

fs.writeFileSync("web/autoclone-preview.html", out);
console.log("preview bytes", out.length);
