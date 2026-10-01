const fs=require("fs"),path=require("path"),ROOT=process.cwd();
const S=(f)=>{try{return JSON.parse(fs.readFileSync(f,"utf8"))}catch{return null}};
const L=(a)=>{try{return fs.readdirSync(a,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort()}catch{return[]}};
const hs=(id)=>{const b=path.join(ROOT,".profiles",id,"tiktok");return[path.join(b,"Default","Cookies"),path.join(b,"Cookies"),path.join(b,"Network","Cookies")].some(c=>{try{const s=fs.statSync(c);return s.isFile()&&s.size>0}catch{return false}})};
const nh=(v)=>String(v||"").trim().replace(/^@+/,"").split(/[/?#\s]/)[0].toLowerCase().slice(0,60);
async function det(page){
 try{const r=await page.evaluate(async()=>{try{const res=await fetch("https://www.tiktok.com/passport/web/account/info/?aid=1459",{credentials:"include",headers:{accept:"application/json"}});const j=await res.json();const d=(j&&(j.data||j.userInfo||j))||{};return d.username||d.uniqueId||""}catch(e){return""}});const u=nh(r);if(u)return{username:u,source:"api"}}catch(e){}
 try{const r=await page.evaluate(()=>{for(const s of ['a[data-e2e="profile-icon"]','a[href^="/@"]','a[href*="tiktok.com/@"]']){const el=document.querySelector(s);const h=el&&el.getAttribute&&el.getAttribute("href");if(h&&h.includes("/@")){const m=h.match(/\/@([A-Za-z0-9._]+)/);if(m)return m[1]}}return""});const u=nh(r);if(u)return{username:u,source:"dom"}}catch(e){}
 try{const ck=await page.context().cookies("https://www.tiktok.com");for(const k of ["uniqueId","unique_id","username"]){const h=ck.find(c=>c.name===k&&c.value);const u=nh(h&&h.value);if(u)return{username:u,source:"cookie"}}}catch(e){}
 return{username:"",source:"no"};
}
(async()=>{
 const st=S(path.join(ROOT,"accounts-state.json"));const acc=(st&&st.accounts)||[];
 console.log("Cuentas:",acc.length,"activa:",st&&st.activeAccountId);
 const profs=L(path.join(ROOT,".profiles"));
 console.log("Perfiles:",profs.join(", "));
 let chromium=null;try{({chromium}=require("playwright"))}catch(e){console.log("AVISO: falta playwright, ejecuta: npx playwright install chromium")}
 for(const a of acc){
   const dir=path.join(ROOT,".profiles",a.id,"tiktok");const ex=fs.existsSync(dir);
   let real="(sin perfil)";
   if(ex&&chromium){let ctx=null;try{for(const l of["SingletonLock","SingletonCookie","SingletonSocket"]){try{fs.rmSync(path.join(dir,l),{force:true})}catch(e){}}ctx=await chromium.launchPersistentContext(dir,{headless:true,viewport:{width:1280,height:900},args:["--disable-blink-features=AutomationControlled"]});const p=ctx.pages()[0]||await ctx.newPage();await p.goto("https://www.tiktok.com/foryou",{waitUntil:"domcontentloaded",timeout:45000}).catch(()=>{});const d=await det(p);real=d.username?"@"+d.username:"(no logueado) ["+d.source+"]"}catch(e){real="ERROR: "+e.message}finally{if(ctx)await ctx.close().catch(()=>{})}}
   console.log(a.id.padEnd(18)+" esperado=("+a.name+")   sesion="+(hs(a.id)?"SI":"no")+"   real="+real);
 }
 console.log("\nSOLO LECTURA. Nada modificado.");
})();
