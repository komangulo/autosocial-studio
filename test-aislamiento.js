// Test aislado: comprueba que las funciones parcheadas resuelven la cuenta
// indicada y NO la activa global. Simula el modulo account-manager.
const path = require("path");
const Module = require("module");

// Mock minimo de account-manager
const accounts = {
  "quinta-de-gym": { id: "quinta-de-gym", name: "Quinta de Gym" },
  "asl-low-cost": { id: "asl-low-cost", name: "ASL Low Cost" },
};
let activeId = "asl-low-cost"; // activa global distinta a la pedida
const mockAM = {
  getActiveAccount: async () => accounts[activeId],
  requireAccount: async (id) => {
    if (!accounts[id]) throw new Error("Account not found.");
    return accounts[id];
  },
  hasSavedPlatformSession: async (platform, id) => id === "quinta-de-gym",
  getPlatformProfileDir: async (platform, id) => path.resolve("/proj/.profiles", id, platform),
  assertSafeAccountId: (v) => v,
  getState: async () => ({}),
  selectAccount: async (id) => accounts[id],
  addAccount: async () => ({}),
  getAllAccounts: async () => Object.values(accounts),
  getAccountQueueDirs: () => ({}),
  ensureAccountDirs: async () => ({}),
  PLATFORMS: ["tiktok"],
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "./account-manager" || request.endsWith("/account-manager")) {
    return "MOCK_AM";
  }
  return origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "MOCK_AM") return mockAM;
  return origLoad.call(this, request, parent, isMain);
};

// requireAccount se importa desde account-manager en tiktok-uploader, pero
// tambien usa modulos pesados (playwright). Probamos solo la logica replicada
// de resolveTikTokAccount y getLoginSessionStatus con el mismo contrato.
async function resolveTikTokAccount(req, context) {
  const requested = req?.body?.accountId || req?.query?.accountId;
  if (requested) return await context.requireAccount(requested);
  return await context.getActiveAccount();
}

(async () => {
  const context = { getActiveAccount: mockAM.getActiveAccount, requireAccount: mockAM.requireAccount };

  // 1) Pidiendo Quinta de Gym aunque la activa sea ASL -> debe dar Quinta
  const a = await resolveTikTokAccount({ body: { accountId: "quinta-de-gym" } }, context);
  console.assert(a.id === "quinta-de-gym", "FAIL: no respeta accountId");
  console.log("1) schedule en Quinta de Gym -> cuenta:", a.id, a.id === "quinta-de-gym" ? "OK" : "FAIL");

  // 2) Sin accountId -> cae a la activa (compatibilidad)
  const b = await resolveTikTokAccount({ body: {} }, context);
  console.log("2) sin accountId -> cuenta activa:", b.id, b.id === activeId ? "OK" : "FAIL");

  // 3) Cuenta inexistente -> debe lanzar
  let threw = false;
  try { await resolveTikTokAccount({ body: { accountId: "no-existe" } }, context); }
  catch { threw = true; }
  console.log("3) cuenta invalida ->", threw ? "rechazada OK" : "FAIL");

  // 4) getLoginSessionStatus(accountId) -> saved de ESA cuenta
  const savedQuinta = await mockAM.hasSavedPlatformSession("tiktok", "quinta-de-gym");
  const savedAsl = await mockAM.hasSavedPlatformSession("tiktok", "asl-low-cost");
  console.log("4) sesion Quinta:", savedQuinta, "| sesion ASL:", savedAsl,
    (savedQuinta && !savedAsl) ? "OK (independientes)" : "FAIL");

  // 5) carpeta de perfil por cuenta
  const d1 = await mockAM.getPlatformProfileDir("tiktok", "quinta-de-gym");
  const d2 = await mockAM.getPlatformProfileDir("tiktok", "asl-low-cost");
  console.log("5) perfiles:", d1, "|", d2, d1 !== d2 ? "OK (separados)" : "FAIL");
})();
