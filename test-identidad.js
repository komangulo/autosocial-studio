const assert = require("assert");
const id = require("/tmp/bcode/gh_id/autosocial-studio-main/src/tiktok-identity.js");

function makePage({ apiUsername, domHref, cookies }) {
  return {
    async goto() {},
    async evaluate(fnOrStr) {
      if (typeof fnOrStr === "function") {
        // Simulamos el entorno del navegador: document + fetch.
        global.document = {
          querySelector(sel) {
            if (domHref && (sel.includes("profile-icon") || sel.includes('href^="/@"') || sel.includes('tiktok.com/@'))) {
              return { getAttribute: () => domHref };
            }
            return null;
          },
        };
        global.fetch = async () => ({
          json: async () => ({ data: { username: apiUsername || "", nickname: "Nick" } }),
        });
        try {
          return await fnOrStr();
        } finally {
          delete global.document; delete global.fetch;
        }
      }
      return "";
    },
    context() {
      return { async cookies() { return cookies || []; } };
    },
  };
}

(async () => {
  assert.strictEqual(id.normalizeHandle("@QuintaDeGym"), "quintadegym");
  assert.strictEqual(id.normalizeHandle("https://www.tiktok.com/@quinta.de.gym?lang=es"), "quinta.de.gym");
  console.log("1) normalizeHandle OK");

  let r = await id.detectTiktokUsernameFromPage(makePage({ apiUsername: "quintadegym" }));
  assert.strictEqual(r.username, "quintadegym");
  console.log("2) deteccion por API OK ->", r.username);

  r = await id.detectTiktokUsernameFromPage(makePage({ domHref: "/@asilowcost" }));
  assert.strictEqual(r.username, "asilowcost", "DOM debe detectar @asilowcost, dio: " + r.username);
  console.log("3) deteccion por DOM OK ->", r.username);

  r = await id.detectTiktokUsernameFromPage(makePage({ cookies: [{ name: "uniqueId", value: "kitty.miau" }] }));
  assert.strictEqual(r.username, "kitty.miau");
  console.log("4) deteccion por cookie OK ->", r.username);

  const v1 = await id.verifyTiktokIdentity({
    page: makePage({ apiUsername: "otracuenta" }),
    expectedUsername: "quintadegym",
  });
  assert.strictEqual(v1.mismatch, true);
  console.log("5) mismatch detectado y bloqueado OK ->", v1.detected, "!=", v1.expected);

  const v2 = await id.verifyTiktokIdentity({
    page: makePage({ apiUsername: "quintadegym" }),
    expectedUsername: "@QuintaDeGym",
  });
  assert.strictEqual(v2.ok, true);
  console.log("6) coincidencia OK -> publica");

  const v3 = await id.verifyTiktokIdentity({
    page: makePage({ apiUsername: "cualquiera" }),
    expectedUsername: "",
  });
  assert.strictEqual(v3.ok, true);
  console.log("7) cuenta sin usuario esperado -> no bloquea OK");

  console.log("\nTODOS LOS TESTS DE IDENTIDAD PASAN");
})();
