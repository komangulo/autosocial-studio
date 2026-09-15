/**
 * Phase 6 — Build with auto-repair.
 *
 * Runs Gradle assembleDebug. On failure, sends the compiler output to Gemini,
 * asks for a JSON list of patch operations, applies them, and retries.
 */

const fs = require("fs/promises");
const path = require("path");
const tools = require("./tools");
const ai = require("./ai-providers");
const { projectDir, saveProject, readSettings, writeJson, apiKeyFor } = require("./store");

const REPAIR_SYSTEM = `Eres un ingeniero experto en Android, Kotlin, Gradle y Jetpack Compose.
Recibes la salida de error de un build de Gradle y el contenido de los archivos relevantes.
Debes devolver SOLO un objeto JSON con las correcciones mínimas necesarias.

Esquema:
{
  "diagnosis": "qué está fallando, en 1-3 frases",
  "operations": [
    { "path": "ruta relativa al proyecto android/", "content": "contenido COMPLETO del archivo corregido" }
  ]
}

Reglas:
- Solo incluye archivos que necesiten cambiar.
- El campo "content" debe ser el archivo completo, no un fragmento.
- Rutas relativas a la raíz del proyecto Android (donde está settings.gradle.kts).
- No cambies la versión de Gradle ni el AGP salvo que el error lo exija.
- Nunca añadas dependencias que no existan en Maven Central / Google.`;

function gradleCmd(androidRoot) {
  if (tools.IS_WIN) {
    const bat = path.join(androidRoot, "gradlew.bat");
    return { cmd: bat, args: ["assembleDebug", "--stacktrace", "--console=plain"] };
  }
  const sh = path.join(androidRoot, "gradlew");
  return { cmd: "/bin/sh", args: [sh, "assembleDebug", "--stacktrace", "--console=plain"] };
}

async function runBuild(project, { onProgress } = {}) {
  const androidRoot = project.scaffold?.androidRoot || path.join(projectDir(project.id), "android");
  if (!project.scaffold) throw new Error("Falta el scaffold. Ejecuta la fase 5 primero.");
  const settings = await readSettings();
  const java = tools.resolveJava();
  const sdk = tools.resolveAndroidSdk();
  if (!java) throw new Error("No se encontró Java (JDK 17). Instálalo para compilar.");
  if (!sdk) throw new Error("No se encontró el Android SDK. Instálalo con cmdline-tools.");

  const env = { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, JAVA_HOME: path.dirname(path.dirname(java)) };
  const maxAttempts = Math.max(1, Number(settings.repairAttempts) || 3);
  const attempts = [];
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    onProgress?.({ stage: "build", detail: `Compilando (intento ${attempt}/${maxAttempts})…`, attempt });
    const { cmd, args } = gradleCmd(androidRoot);
    let output = "";
    let ok = false;
    try {
      const result = await tools.run(cmd, args, { timeout: 900_000, cwd: androidRoot, env });
      output = `${result.stdout}\n${result.stderr}`;
      ok = true;
    } catch (error) {
      output = `${error.stdout || ""}\n${error.stderr || error.message}`;
      ok = false;
    }
    attempts.push({ attempt, ok, tail: tail(output, 4000) });
    if (ok) {
      const apk = await findApk(androidRoot);
      project.build = { ok: true, attempts, apk, builtAt: new Date().toISOString() };
      project.activePhase = 7;
      await saveProject(project);
      return project.build;
    }

    lastError = output;
    if (attempt === maxAttempts) break;

    onProgress?.({ stage: "repair", detail: `Error de compilación. Pidiendo corrección a Gemini (intento ${attempt})…` });
    try {
      await repairOnce(project, androidRoot, output, settings);
    } catch (repairError) {
      attempts.push({ attempt, ok: false, repairFailed: repairError.message });
      break;
    }
  }

  project.build = { ok: false, attempts, errorTail: tail(lastError, 4000), builtAt: new Date().toISOString() };
  await saveProject(project);
  return project.build;
}

async function repairOnce(project, androidRoot, output, settings) {
  const providerId = settings.code.provider;
  const apiKey = await apiKeyFor(providerId);
  if (!apiKey) throw new Error(`Sin API key de ${ai.getProvider(providerId).label} no se puede auto-reparar.`);
  const files = globalThis.__androidCloneRelevantFiles || [];
  const fileContents = [];
  for (const rel of files.slice(0, 20)) {
    const abs = path.join(androidRoot, rel);
    const content = await fs.readFile(abs, "utf8").catch(() => null);
    if (content !== null) fileContents.push({ path: rel, content: content.slice(0, 20000) });
  }
  if (!fileContents.length) {
    for (const rel of ["app/build.gradle.kts", "build.gradle.kts", "settings.gradle.kts"]) {
      const content = await fs.readFile(path.join(androidRoot, rel), "utf8").catch(() => null);
      if (content !== null) fileContents.push({ path: rel, content });
    }
  }

  const { text } = await ai.generate({
    providerId,
    apiKey,
    model: settings.code.model,
    system: REPAIR_SYSTEM,
    parts: [{ text: `Error de Gradle:\n${tail(output, 12000)}\n\nArchivos actuales:\n${JSON.stringify(fileContents, null, 2)}` }],
    json: true,
    temperature: 0.1,
    maxOutputTokens: 8192,
  });

  const fix = ai.parseJson(text);
  const applied = [];
  for (const op of fix.operations || []) {
    const rel = String(op.path || "").replace(/^[/\\]+/, "");
    if (!rel || rel.includes("..")) continue;
    const abs = path.join(androidRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, String(op.content ?? ""), "utf8");
    applied.push(rel);
  }
  if (!applied.length) throw new Error(fix.diagnosis || "Gemini no propuso cambios.");
  await writeJson(path.join(projectDir(project.id), `repair-${Date.now()}.json`), { diagnosis: fix.diagnosis, applied });
  return { diagnosis: fix.diagnosis, applied };
}

async function findApk(androidRoot) {
  const apk = path.join(androidRoot, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  const exists = await fs.stat(apk).then(() => true).catch(() => false);
  return exists ? apk : null;
}

function tail(text, max) {
  const str = String(text || "");
  return str.length <= max ? str : str.slice(str.length - max);
}

module.exports = { runBuild, REPAIR_SYSTEM, findApk };
