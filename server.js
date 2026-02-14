import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import cors from "cors";
import compression from "compression";
import NodeCache from "node-cache";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(compression());

// -------------------- CORS --------------------
app.use(
  cors({
    origin: function (origin, callback) {
      if (origin === "https://thecaloriecard.com") return callback(null, true);
      if (
        !origin ||
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:")
      ) {
        return callback(null, true);
      }
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// -------------------- Clients --------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -------------------- FatSecret --------------------
const FATSECRET_API_URL = "https://platform.fatsecret.com/rest/server.api";
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const cache = new NodeCache({ stdTTL: 300 }); // 5 minutes

let accessToken = null;
let tokenExpirationTime = 0;

async function getAccessToken() {
  const response = await axios.post(
    "https://oauth.fatsecret.com/connect/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "basic",
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  accessToken = response.data.access_token;
  tokenExpirationTime = Date.now() + response.data.expires_in * 1000;
}

async function ensureFatSecretToken(req, res, next) {
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).json({ error: "CLIENT_ID/CLIENT_SECRET not set" });
    }
    if (!accessToken || Date.now() >= tokenExpirationTime) {
      await getAccessToken();
    }
    next();
  } catch (err) {
    console.error(
      "FatSecret token error:",
      err.response?.data || err.message || err
    );
    return res
      .status(500)
      .json({ error: "Failed to fetch FatSecret access token" });
  }
}

// -------------------- Health --------------------
app.get("/health", (req, res) => res.status(200).send("OK"));

// -------------------- FatSecret passthrough (optional) --------------------
app.get("/foods/search/v1", ensureFatSecretToken, async (req, res) => {
  const { search_expression, max_results, format } = req.query;
  const cacheKey = `fs:${search_expression}:${max_results || 12}:${format || "json"
    }`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(FATSECRET_API_URL, {
      params: {
        method: "foods.search",
        search_expression,
        max_results: max_results || 12,
        format: format || "json",
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    cache.set(cacheKey, response.data);
    return res.json(response.data);
  } catch (err) {
    console.error("foods.search error:", err.response?.data || err.message || err);
    return res
      .status(err.response?.status || 500)
      .json(err.response?.data || { error: "Internal Server Error" });
  }
});

// -------------------- Config thresholds --------------------
const MIN_AI_CONFIDENCE = 0.65;
const MIN_DB_TOKEN_SCORE = 0.35;
const MIN_DB_AI_PICK_CONF = 0.6;
const MAX_RESULTS = 12;

// -------------------- Text helpers --------------------
function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  return normText(s).split(" ").filter(Boolean);
}

function tokenScore(query, candidate) {
  const qTokens = tokenize(query);
  const q = new Set(qTokens);
  if (!q.size) return 0;

  const cTokens = tokenize(
    `${candidate.brand || ""} ${candidate.name || ""} ${candidate.description || ""}`
  );

  let hit = 0;
  for (const t of cTokens) if (q.has(t)) hit++;

  return hit / Math.max(4, qTokens.length);
}

function extractBrandHints(query) {
  const q = normText(query);
  const hints = [];

  // small list: only for obvious brand mismatch protection
  const known = [
    "greggs",
    "walkers",
    "tesco",
    "costa",
    "mcdonald",
    "mcdonalds",
    "coca",
    "coca cola",
    "coca-cola",
    "alpro",
  ];

  for (const k of known) {
    if (q.includes(k)) hints.push(k);
  }
  return hints;
}

function containsAllKeywords(haystack, words) {
  const h = normText(haystack);
  return words.every((w) => h.includes(normText(w)));
}

function stripBrandHintsFromQuery(query, brandHints) {
  let q = ` ${normText(query)} `;
  for (const b of brandHints) {
    const bb = normText(b).replace(/\s+/g, " ").trim();
    q = q.replaceAll(` ${bb} `, " ");
  }
  return q.replace(/\s+/g, " ").trim();
}

// single “cleaned query” used for the ONE retry
function cleanQueryForFatSecret(query, brandHints) {
  let q = normText(query);

  // remove brand hints
  q = stripBrandHintsFromQuery(q, brandHints);

  // remove explicit quantities like 400g, 330ml, 2l, etc.
  q = q.replace(/\b\d+(?:\.\d+)?\s*(g|gram|grams|ml|l)\b/g, " ");

  // remove common size tokens that can hurt recall
  q = q.replace(
    /\b(small|medium|large|grande|venti|tall|regular|king|mini)\b/g,
    " "
  );

  return q.replace(/\s+/g, " ").trim();
}

// coffee-shop intent + capsule/pod veto
function hasCoffeeShopIntent(query) {
  const q = normText(query);
  const sizeSignals =
    /\b(small|medium|large|grande|venti|tall)\b/.test(q) ||
    /\b(costa|starbucks|caffe|café|coffee shop)\b/.test(q);
  const drinkSignals = /\b(latte|cappuccino|flat white|americano|mocha)\b/.test(q);
  return sizeSignals && drinkSignals;
}

function isCapsuleOrInstantDrinkCandidate(candidateText) {
  const t = normText(candidateText);
  return (
    /\b(tassimo|nespresso|dolce|gusto|keurig|pod|pods|capsule|capsules)\b/.test(t) ||
    /\b(instant|powder|sachet|mug)\b/.test(t)
  );
}

// -------------------- Quantity extractors --------------------
function extractExplicitGrams(text) {
  const match = String(text).match(/(\d+(?:\.\d+)?)\s*(g|gram|grams)\b/i);
  if (!match) return null;
  const grams = Number(match[1]);
  return Number.isFinite(grams) && grams > 0 ? grams : null;
}

function extractExplicitMl(text) {
  const t = String(text);

  let m = t.match(/(\d+(?:\.\d+)?)\s*ml\b/i);
  if (m) {
    const ml = Number(m[1]);
    return Number.isFinite(ml) && ml > 0 ? ml : null;
  }

  m = t.match(/(\d+(?:\.\d+)?)\s*l\b/i);
  if (m) {
    const l = Number(m[1]);
    const ml = l * 1000;
    return Number.isFinite(ml) && ml > 0 ? ml : null;
  }

  return null;
}

function extractPerGrams(desc) {
  const m = String(desc || "").match(/\bPer\s+(\d+(?:\.\d+)?)\s*g\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractPerMl(desc) {
  const m = String(desc || "").match(/\bPer\s+(\d+(?:\.\d+)?)\s*ml\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractPerFlOzAsMl(desc) {
  const m = String(desc || "").match(/\bPer\s+(\d+(?:\.\d+)?)\s*fl\s*oz\b/i);
  if (!m) return null;
  const flOz = Number(m[1]);
  if (!Number.isFinite(flOz) || flOz <= 0) return null;
  return flOz * 29.5735;
}

function looksPerServingUnit(desc) {
  const d = String(desc || "");
  if (/\bPer\s+1\s+[A-Za-z]/i.test(d)) return true;
  if (/\bPer\s+serving\b/i.test(d)) return true;
  return false;
}

function looksLikeSnackPackQuery(query, grams) {
  if (!grams) return false;
  if (grams < 20 || grams > 100) return false;
  const q = normText(query);
  return (
    q.includes("crisps") ||
    q.includes("chips") ||
    q.includes("snack") ||
    q.includes("bag") ||
    q.includes("pack")
  );
}

function isBagOrPackServing(desc) {
  const d = normText(desc);
  return (
    d.includes("per 1 bag") ||
    d.includes("per 1 pack") ||
    d.includes("per bag") ||
    d.includes("per pack")
  );
}

// -------------------- Nutrition parser --------------------
function parseNutrition(desc) {
  const d = String(desc || "");

  const cal = d.match(/Calories:\s*([0-9]+(?:\.[0-9]+)?)\s*kcal/i);
  const fat = d.match(/Fat:\s*([0-9]+(?:\.[0-9]+)?)\s*g/i);
  const carbs = d.match(/Carbs:\s*([0-9]+(?:\.[0-9]+)?)\s*g/i);
  const protein = d.match(/Protein:\s*([0-9]+(?:\.[0-9]+)?)\s*g/i);

  if (!cal) return null;

  const obj = {
    calories: Number(cal[1]),
    fat: fat ? Number(fat[1]) : 0,
    carbs: carbs ? Number(carbs[1]) : 0,
    protein: protein ? Number(protein[1]) : 0,
  };

  if (!Number.isFinite(obj.calories)) return null;
  return obj;
}

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Number(x.toFixed(1));
}

// NEW: prevent 0 values being treated as “present”
function toPositiveNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// -------------------- Build FatSecret candidates --------------------
function buildCandidates(fsData) {
  const foods = fsData?.foods?.food || [];
  const arr = Array.isArray(foods) ? foods : [foods];

  return arr
    .map((f) => {
      const desc = f.food_description || "";
      return {
        id: f.food_id,
        name: f.food_name || "",
        brand: f.brand_name || null,
        description: desc,
        nutrition: parseNutrition(desc),
        per_grams: extractPerGrams(desc),
        per_ml: extractPerMl(desc) ?? extractPerFlOzAsMl(desc),
      };
    })
    .filter((c) => c.nutrition);
}

// -------------------- Deterministic scaling for DB candidate --------------------
function scaleCandidate(candidate, grams, ml) {
  const base = candidate.nutrition;
  let factor = 1;
  let mode = "serving";

  if (grams && candidate.per_grams) {
    factor = grams / candidate.per_grams;
    mode = "weight";
  } else if (ml && candidate.per_ml) {
    factor = ml / candidate.per_ml;
    mode = "volume";
  }

  return {
    mode,
    calories: Math.round(base.calories * factor),
    protein: round1(base.protein * factor),
    carbs: round1(base.carbs * factor),
    fat: round1(base.fat * factor),
    factor,
  };
}

function isScalingMismatch(candidate, grams, ml, query) {
  if (grams && !candidate.per_grams && looksPerServingUnit(candidate.description)) {
    if (looksLikeSnackPackQuery(query, grams) && isBagOrPackServing(candidate.description)) {
      return false;
    }
    return true;
  }
  if (ml && !candidate.per_ml && looksPerServingUnit(candidate.description)) return true;
  return false;
}

function isStrongGenericFallbackAllowed(query, candidate, token_score, grams, ml) {
  if (!grams && !ml) return false;
  if (token_score < 0.55) return false;
  if (grams && !candidate.per_grams) return false;
  if (ml && !candidate.per_ml) return false;
  return true;
}

// -------------------- AI: estimate --------------------
async function estimateAI(food) {
  const grams = extractExplicitGrams(food);
  const explicitMl = extractExplicitMl(food);

  // Weight-based: return per-100g, then scale in code
  if (grams) {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0.05,
      text: { format: { type: "json_object" } },
      input: [
        {
          role: "system",
          content:
            "Return ONLY valid JSON. Always return values strictly PER 100g for the described food. Do NOT scale totals.",
        },
        {
          role: "user",
          content: `Food description: "${food}"

Return JSON:
{
  "name": string,
  "calories_per_100g": number,
  "protein_per_100g": number,
  "carbs_per_100g": number,
  "fat_per_100g": number,
  "confidence": number
}`,
        },
      ],
    });

    const per100g = JSON.parse(response.output_text);
    const factor = grams / 100;

    return {
      source: "ai",
      mode: "weight",
      name: per100g.name,
      grams,
      ml: null,
      calories: Math.round(Number(per100g.calories_per_100g) * factor),
      protein: round1(Number(per100g.protein_per_100g) * factor),
      carbs: round1(Number(per100g.carbs_per_100g) * factor),
      fat: round1(Number(per100g.fat_per_100g) * factor),
      confidence: Number.isFinite(Number(per100g.confidence)) ? Number(per100g.confidence) : 0.7,
      calories_per_100g: Number(per100g.calories_per_100g),
      protein_per_100g: Number(per100g.protein_per_100g),
      carbs_per_100g: Number(per100g.carbs_per_100g),
      fat_per_100g: Number(per100g.fat_per_100g),
    };
  }

  // Serving/volume-based
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    temperature: 0.05,
    text: { format: { type: "json_object" } },
    input: [
      {
        role: "system",
        content:
          "Return ONLY valid JSON.\n\n" +
          "If the food is a DRINK and volume is specified or implied (ml, l, oz, cup, bottle, can, medium, large, etc), populate:\n" +
          "- ml: number\n" +
          "- estimated_serving_grams: null\n\n" +
          "If the food is SOLID and weight is specified or implied, populate:\n" +
          "- estimated_serving_grams: number\n" +
          "- ml: null\n\n" +
          "If neither is specified, estimate a realistic UK serving and use grams for solids and ml for drinks.\n\n" +
          "Never assign grams to drinks when ml is appropriate.\n\n" +
          "Return realistic UK nutrition estimates.",
      },
      {
        role: "user",
        content: `Food description: "${food}"

Return JSON:
{
  "name": string,
  "serving_description": string,
  "estimated_serving_grams": number | null,
  "ml": number | null,
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "confidence": number
}`,
      },
    ],
  });

  const j = JSON.parse(response.output_text);

  // Prefer explicit ml from input if model left it blank
  const ml = toPositiveNumberOrNull(j.ml) ?? explicitMl;

  return {
    source: "ai",
    mode: ml ? "volume" : "serving",
    name: j.name,
    grams: toPositiveNumberOrNull(j.estimated_serving_grams),
    ml: ml ?? null,
    serving_description: j.serving_description,
    calories: Math.round(Number(j.calories) || 0),
    protein: round1(Number(j.protein) || 0),
    carbs: round1(Number(j.carbs) || 0),
    fat: round1(Number(j.fat) || 0),
    confidence: Number.isFinite(Number(j.confidence)) ? Number(j.confidence) : 0.65,
  };
}

// -------------------- AI: choose best DB candidate among top-N --------------------
async function pickBestCandidateIndex(query, candidates) {
  const simplified = candidates.map((c, i) => ({
    index: i,
    name: c.name,
    brand: c.brand,
    description: c.description,
  }));

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    text: { format: { type: "json_object" } },
    input: [
      {
        role: "system",
        content:
          'Pick the single best matching candidate index for the query.\nReturn ONLY JSON: {"index": number, "confidence": number}\nDo NOT pick unrelated foods.\nPrefer exact brand/name matches.\n',
      },
      {
        role: "user",
        content: JSON.stringify({ query, candidates: simplified }),
      },
    ],
  });

  const out = JSON.parse(resp.output_text);
  const idx = Number(out?.index);
  const conf = Number(out?.confidence);

  return {
    index: Number.isFinite(idx) ? idx : -1,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
  };
}

// -------------------- FatSecret search helper --------------------
async function fatSecretSearch(search_expression) {
  const fsRes = await axios.get(FATSECRET_API_URL, {
    params: {
      method: "foods.search",
      search_expression,
      max_results: MAX_RESULTS,
      format: "json",
    },
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  return buildCandidates(fsRes.data);
}

// -------------------- One-pass upgrade attempt --------------------
async function tryUpgradeFromDb({
  query,
  originalFood,
  aiResult,
  grams,
  ml,
  debug,
  brandHints,
  phaseLabel,
}) {
  const candidates = await fatSecretSearch(query);
  if (!candidates.length) {
    return { upgraded: false, out: null, reason: "no_db_candidates" };
  }

  const scored = candidates
    .map((c) => ({ c, s: tokenScore(query, c) }))
    .sort((a, b) => b.s - a.s);

  const bestDet = scored[0];
  const top = scored.slice(0, 6).map((x) => x.c);

  if (!bestDet || bestDet.s < MIN_DB_TOKEN_SCORE) {
    return {
      upgraded: false,
      out: null,
      reason: "db_low_token_score",
      meta: { best_token_score: bestDet?.s ?? 0 },
    };
  }

  let pick = { index: -1, confidence: 0 };
  try {
    pick = await pickBestCandidateIndex(query, top);
  } catch { }

  const chosen = pick.index >= 0 && pick.index < top.length ? top[pick.index] : bestDet.c;
  const chosenScore = tokenScore(query, chosen);
  const chosenText = `${chosen.brand || ""} ${chosen.name || ""} ${chosen.description || ""}`;

  // Phrase gate (minimal)
  const phraseMustHave = [];
  const qNorm = normText(originalFood);
  if (qNorm.includes("sausage roll")) phraseMustHave.push("sausage", "roll");
  if (qNorm.includes("chicken tikka masala")) phraseMustHave.push("chicken", "tikka", "masala");
  if (qNorm.includes("ready salted")) phraseMustHave.push("ready", "salted");

  if (phraseMustHave.length && !containsAllKeywords(chosenText, phraseMustHave)) {
    return {
      upgraded: false,
      out: null,
      reason: "phrase_gate_failed",
      meta: { phraseMustHave, chosen: { name: chosen.name, brand: chosen.brand }, chosenScore },
    };
  }

  // Brand gate only for primary
  if (phaseLabel === "primary") {
    if (brandHints.length && !containsAllKeywords(chosenText, brandHints)) {
      return {
        upgraded: false,
        out: null,
        reason: "brand_gate_failed",
        meta: { brandHints, chosen: { name: chosen.name, brand: chosen.brand }, chosenScore },
      };
    }
  }

  // Coffee-shop intent veto
  if (hasCoffeeShopIntent(originalFood) && isCapsuleOrInstantDrinkCandidate(chosenText)) {
    return {
      upgraded: false,
      out: null,
      reason: "coffee_shop_format_veto",
      meta: { chosen: { name: chosen.name, brand: chosen.brand } },
    };
  }

  // Confidence gate
  const aiIsLow = (aiResult?.confidence ?? 0) < MIN_AI_CONFIDENCE;
  const dbPickIsWeak = pick.confidence < MIN_DB_AI_PICK_CONF;
  if (dbPickIsWeak && !aiIsLow) {
    return {
      upgraded: false,
      out: null,
      reason: "db_pick_confidence_low",
      meta: { db_pick_confidence: pick.confidence, chosenScore },
    };
  }

  // Scaling veto
  if (isScalingMismatch(chosen, grams, ml, query)) {
    return {
      upgraded: false,
      out: null,
      reason: "db_scaling_mismatch_veto",
      meta: { chosen: { name: chosen.name, brand: chosen.brand }, chosenScore },
    };
  }

  // Cleaned retry accept rule
  if (phaseLabel === "cleaned_retry") {
    if (!isStrongGenericFallbackAllowed(query, chosen, chosenScore, grams, ml)) {
      return {
        upgraded: false,
        out: null,
        reason: "cleaned_retry_not_strong_enough",
        meta: { chosenScore },
      };
    }
  }

  const scaled = scaleCandidate(chosen, grams, ml);

  const dbResult = {
    source: "fatsecret",
    mode: scaled.mode,
    name: chosen.brand ? `${chosen.brand} ${chosen.name}` : chosen.name,
    grams: grams ?? null,
    ml: ml ?? null,
    calories: scaled.calories,
    protein: scaled.protein,
    carbs: scaled.carbs,
    fat: scaled.fat,
    confidence: 0.9,
    ...(debug
      ? {
        debug: {
          upgraded_from_ai: true,
          via: phaseLabel,
          query_used: query,
          ai_confidence: aiResult?.confidence ?? null,
          best_token_score: bestDet.s,
          chosen_token_score: chosenScore,
          db_pick: pick,
          factor: scaled.factor,
          per_grams: chosen.per_grams,
          per_ml: chosen.per_ml,
          description: chosen.description,
          candidate_count: candidates.length,
          prefiltered_count: top.length,
          thresholds: { MIN_AI_CONFIDENCE, MIN_DB_TOKEN_SCORE, MIN_DB_AI_PICK_CONF },
        },
      }
      : {}),
  };

  return { upgraded: true, out: dbResult, reason: "upgraded" };
}

// -------------------- AI-first Hybrid Resolve --------------------
app.post("/food/resolve", ensureFatSecretToken, async (req, res) => {
  const { food, debug } = req.body || {};

  if (!food || typeof food !== "string") {
    return res.status(400).json({ error: "food is required" });
  }

  const cacheKey = `resolve-ai-first:${food}`;
  const cached = cache.get(cacheKey);
  if (cached && !debug) return res.json(cached);

  // Always compute AI first
  let aiResult;
  try {
    aiResult = await estimateAI(food);
  } catch (err) {
    console.error("AI estimate failed:", err.response?.data || err.message || err);
    aiResult = {
      source: "ai",
      mode: "serving",
      name: food,
      grams: null,
      ml: null,
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      confidence: 0.1,
    };
  }

  const grams = extractExplicitGrams(food);
  const ml = extractExplicitMl(food);
  const brandHints = extractBrandHints(food);

  try {
    // Primary attempt
    const primary = await tryUpgradeFromDb({
      query: food,
      originalFood: food,
      aiResult,
      grams,
      ml,
      debug,
      brandHints,
      phaseLabel: "primary",
    });

    if (primary.upgraded) {
      if (!debug) cache.set(cacheKey, primary.out);
      return res.json(primary.out);
    }

    // ONE cleaned retry (hard-capped)
    const cleaned = cleanQueryForFatSecret(food, brandHints);
    if (cleaned && cleaned !== normText(food)) {
      const cleanedRetry = await tryUpgradeFromDb({
        query: cleaned,
        originalFood: food,
        aiResult,
        grams,
        ml,
        debug,
        brandHints,
        phaseLabel: "cleaned_retry",
      });

      if (cleanedRetry.upgraded) {
        if (!debug) cache.set(cacheKey, cleanedRetry.out);
        return res.json(cleanedRetry.out);
      }

      const out = debug
        ? {
          ...aiResult,
          debug: {
            used: "ai_only",
            reason: "db_upgrade_failed_after_one_retry",
            primary: { reason: primary.reason, meta: primary.meta },
            cleaned_retry: { query: cleaned, reason: cleanedRetry.reason, meta: cleanedRetry.meta },
          },
        }
        : aiResult;

      if (!debug) cache.set(cacheKey, out);
      return res.json(out);
    }

    const out = debug
      ? { ...aiResult, debug: { used: "ai_only", reason: primary.reason, meta: primary.meta } }
      : aiResult;

    if (!debug) cache.set(cacheKey, out);
    return res.json(out);
  } catch (err) {
    console.error("FatSecret resolve error:", err.response?.data || err.message || err);
    const out = debug
      ? { ...aiResult, debug: { used: "ai_only", reason: "db_exception", error: err.message } }
      : aiResult;
    if (!debug) cache.set(cacheKey, out);
    return res.json(out);
  }
});

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
