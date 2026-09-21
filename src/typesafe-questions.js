// Constantes de decision de TypeSafe (System One / Jev) para AutoSocial Studio.
// MARKER: TSAFE-Q-v1
//
// AQUI Y SOLO AQUI viven las preguntas y los umbrales. Es el archivo que un
// humano revisa y ajusta; el resto del codigo solo los consume.
//
// Cada "decision" agrupa sus preguntas para lanzarlas en UNA sola llamada
// (Speculative Fan-Out: se evaluan en paralelo, anadir preguntas no cuesta latencia).
//
// Docs de referencia: https://docs.typesafe.ai/primitives y /patterns/fan-out

// ---------------------------------------------------------------------------
// Umbrales (revisables). En una noul, 1 = si fuerte, 0 = no fuerte.
// En una score, el valor va de 0 a (levels-1) y puede caer entre niveles.
// ---------------------------------------------------------------------------
const THRESHOLDS = {
  // Radar: descartar/publicar tweets escaneados.
  radar: {
    minRelevance: 0.7,   // noul relevante_para_radar >= esto -> publicable
    skipBelow: 0.4,      // por debajo -> descartar sin mas
    minWorth: 1,         // score vale_la_pena >= esto (escala 0..2)
    minCollection: 0.6,  // noul es_producto_de_coleccion para aplicar afiliado
  },
  // Validador previo a publicar cualquier post generado.
  publish: {
    minLanguage: 0.8,    // noul respeta_idioma >= esto
    maxContact: 0.3,     // noul contiene_contacto_o_enlace <= esto
    maxSpam: 0.65,       // noul parece_spam <= esto (0.65 separa prosa normal ~0.4 de spam real ~0.99)
    minPromptFit: 0.5,   // noul cumple_el_prompt >= esto
    minQuality: 1,       // score calidad >= esto (escala 0..3; 1 = aceptable)
  },
};

// ---------------------------------------------------------------------------
// Decision: Radar / relevancia de un tweet escaneado.
// state: { tweet, temas: [...], idioma_preferido }
// ---------------------------------------------------------------------------
const RADAR_RELEVANCE = {
  key: "radar_relevance",
  questions: {
    relevante_para_radar: {
      type: "noul",
      instructions:
        "Is `tweet` a real news item or product update about at least one of `temas`? " +
        "True = it reports a launch, set, price, restock or event in that field. " +
        "False = it is only a mention, opinion, meme, second-hand sale, or a different topic.",
      criteria: {
        true: "Reports or announces something new in the field described by `temas`",
        false: "Only mentions the topic, or is an opinion, meme, resale or unrelated subject",
      },
    },
    tipo_contenido: {
      type: "choice",
      instructions: "What kind of content is `tweet`?",
      criteria: {
        noticia: "Straight news or announcement of a release, set, price or event",
        rumor: "Unconfirmed leak, rumor or speculation",
        preventa: "Pre-order, restock or pre-release listing",
        opinion: "Personal opinion, review or discussion",
        spam: "Ad, engagement bait or unrelated promotion",
      },
    },
    idioma: {
      type: "choice",
      instructions: "Which language is `tweet` mainly written in?",
      criteria: { es: "Spanish", en: "English", otro: null },
    },
    vale_la_pena: {
      type: "score",
      instructions: "How useful is `tweet` as a news post worth republishing to `temas` fans?",
      criteria: ["Noise, misleading or repetitive", "Acceptable but dull", "Fresh, clear news"],
    },
  },
};

// ---------------------------------------------------------------------------
// Decision: Radar / link de afiliado de un tweet.
// state: { url, texto_del_link, tiendas: [...] }
// ---------------------------------------------------------------------------
const RADAR_AFFILIATE = {
  key: "radar_affiliate",
  questions: {
    tienda: {
      type: "choice",
      instructions:
        "Which retail store does `url` belong to, if any, given `texto_del_link`? " +
        "Use `ninguna` when it is not one of `tiendas` or not a store link.",
      criteria: {
        amazon: "A link that points to Amazon (any amazon domain or shortener)",
        ebay: "A link that points to eBay (any ebay domain or shortener)",
        target: "A link that points to Target",
        ninguna: "Not one of the configured stores, or not a product link",
      },
    },
    es_producto_de_coleccion: {
      type: "noul",
      instructions:
        "Does `url` or `texto_del_link` refer to a collectible product (cards, figures, sealed product)?",
      criteria: {
        true: "Clearly a collectibles product listing",
        false: "Not a collectibles product or cannot tell",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Decision: validacion de un post ANTES de publicarlo.
// state: { texto_generado, master_prompt, idioma_esperado, max_caracteres }
// ---------------------------------------------------------------------------
const PUBLISH_QUALITY = {
  key: "publish_quality",
  questions: {
    respeta_idioma: {
      type: "noul",
      instructions: "Is `texto_generado` written entirely in `idioma_esperado`?",
      criteria: {
        true: "Whole text is in the expected language",
        false: "Contains text in another language or is mixed",
      },
    },
    contiene_contacto_o_enlace: {
      type: "noul",
      instructions:
        "Does `texto_generado` contain a @username, a URL, an email address or a hashtag?",
      criteria: {
        true: "Contains at least one @user, URL, email or hashtag",
        false: "Contains none of them",
      },
    },
    parece_spam: {
      type: "noul",
      instructions:
        "Does `texto_generado` read as aggressive spam or engagement bait, as opposed to a normal " +
        "informative post that simply promotes something?",
      criteria: {
        true:
          "Aggressive hard sell: repeated calls to click or buy, ALL CAPS hype, clickbait, " +
          "excessive punctuation, or meaningless filler",
        false:
          "A normal informative or promotional post with real content and a reasonable tone",
      },
    },
    cumple_el_prompt: {
      type: "noul",
      instructions: "Does `texto_generado` comply with what `master_prompt` asks for?",
      criteria: {
        true: "Follows the instructions in `master_prompt`",
        false: "Ignores or contradicts `master_prompt`",
      },
    },
    calidad: {
      type: "score",
      instructions: "How good is `texto_generado` as a post for X?",
      criteria: ["Poor", "Acceptable", "Good", "Excellent"],
    },
  },
};

// Registro de decisiones disponibles por nombre.
const DECISIONS = {
  [RADAR_RELEVANCE.key]: RADAR_RELEVANCE,
  [RADAR_AFFILIATE.key]: RADAR_AFFILIATE,
  [PUBLISH_QUALITY.key]: PUBLISH_QUALITY,
};

// ---------------------------------------------------------------------------
// Reglas en codigo: convierten respuestas tipadas en un veredicto booleano.
// Cada regla devuelve { ok, reason, scores } para poder auditar por que.
// ---------------------------------------------------------------------------

/** Radar: decidir si un tweet escaneado se publica. */
function radarRelevanceVerdict(answers) {
  const rel = answers.relevante_para_radar ? answers.relevante_para_radar.noul : 0;
  const worth = answers.vale_la_pena ? answers.vale_la_pena.score : 0;
  const tipo = answers.tipo_contenido ? answers.tipo_contenido.choice : "";
  const t = THRESHOLDS.radar;
  const ok = rel >= t.minRelevance && worth >= t.minWorth && tipo !== "spam";
  let reason;
  if (tipo === "spam") reason = "type=spam";
  else if (rel < t.skipBelow) reason = "irrelevant";
  else if (rel < t.minRelevance) reason = "uncertain-relevance";
  else if (worth < t.minWorth) reason = "low-worth";
  else reason = "ok";
  return { ok, reason, scores: { relevancia: rel, valor: worth, tipo, idioma: answers.idioma ? answers.idioma.choice : "" } };
}

/** Radar: decidir tienda de afiliado. */
function radarAffiliateVerdict(answers) {
  const store = answers.tienda ? answers.tienda.choice : "ninguna";
  const isProduct = answers.es_producto_de_coleccion ? answers.es_producto_de_coleccion.noul : 0;
  const t = THRESHOLDS.radar;
  const ok = store !== "ninguna" && isProduct >= t.minCollection;
  return { ok, store: ok ? store : null, reason: ok ? "ok" : (store === "ninguna" ? "not-a-store" : "not-collectible"), scores: { tienda: store, producto: isProduct } };
}

/** Publicacion: decidir si un post generado pasa el control de calidad. */
function publishQualityVerdict(answers) {
  const lang = answers.respeta_idioma ? answers.respeta_idioma.noul : 0;
  const contact = answers.contiene_contacto_o_enlace ? answers.contiene_contacto_o_enlace.noul : 1;
  const spam = answers.parece_spam ? answers.parece_spam.noul : 1;
  const fit = answers.cumple_el_prompt ? answers.cumple_el_prompt.noul : 0;
  const quality = answers.calidad ? answers.calidad.score : 0;
  const t = THRESHOLDS.publish;
  const problems = [];
  if (lang < t.minLanguage) problems.push("idioma");
  if (contact > t.maxContact) problems.push("enlace-o-contacto");
  if (spam > t.maxSpam) problems.push("spam");
  if (fit < t.minPromptFit) problems.push("no-cumple-prompt");
  if (quality < t.minQuality) problems.push("calidad-baja");
  return {
    ok: problems.length === 0,
    problems,
    reason: problems.length ? problems.join(",") : "ok",
    scores: { idioma: lang, contacto: contact, spam, prompt: fit, calidad: quality },
  };
}

module.exports = {
  THRESHOLDS,
  RADAR_RELEVANCE,
  RADAR_AFFILIATE,
  PUBLISH_QUALITY,
  DECISIONS,
  radarRelevanceVerdict,
  radarAffiliateVerdict,
  publishQualityVerdict,
};
