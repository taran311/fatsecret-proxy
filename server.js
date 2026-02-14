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
    console.error("FatSecret token error:", err.response?.data || err.message || err);
    return res.status(500).json({ error: "Failed to fetch FatSecret access token" });
  }
}

// -------------------- Health --------------------
app.get("/health", (req, res) => res.status(200).send("OK"));

// -------------------- FatSecret passthrough (optional) --------------------
app.get("/foods/search/v1", ensureFatSecretToken, async (req, res) => {
  const { search_expression, max_results, format } = req.query;
  const cacheKey = `fs:${search_expression}:${max_results || 12}:${format || "json"}`;

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

// -------------------- Config thresholds (tune later) --------------------
const MIN_AI_CONFIDENCE = 0.65;      // if AI confidence below this, prefer DB if DB is strong
const MIN_DB_TOKEN_SCORE = 0.35;     // DB must “look like” the query
const MIN_DB_AI_PICK_CONF = 0.60;    // AI must be reasonably confident in chosen DB candidate
const MAX_RESULTS = 12;

// -------------------- Text helpers --------------------
function normText(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(s) {
  return normText(s).split(" ").filter(Boolean);
}

function tokenScore(query, candidate) {
  const qTokens = tokenize(query);
  const q = new Set(qTokens);
  if (!q.size) return 0;

  const cTokens = tokenize(`${candidate.brand || ""} ${candidate.name || ""} ${candidate.description || ""}`);
  let hit = 0;
  for (const t of cTokens) if (q.has(t)) hit++;

  return hit / Math.max(4, qTokens.length);
}

function extractBrandHints(query) {
  const q = normText(query);
  const hints = [];
  // Add more over time if needed, but this is NOT required for correctness.
  // This is just to prevent obvious brand mismatches like "Greggs" -> random sausage.
  const known = ["greggs", "walkers", "tesco", "costa", "mcdonald", "mcdonalds", "coca", "coca-cola", "coca cola", "alpro"];
  for (const k of known) {
    if (q.includes(k)) hints.push(k);
  }
  return hints;
}

function containsAllKeywords(haystack, words) {
  const h = normText(haystack);
  return words.every(w => h.includes(normText(w)));
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

// Generic serving-unit detector: "Per 1 ___" or "Per serving"
function looksPerServingUnit(desc) {
  const d = String(desc || "");
  if (/\bPer\s+1\s+[A-Za-z]/i.test(d)) return true;
  if (/\bPer\s+serving\b/i.test(d)) return true;
  return false;
}

// Snack-pack allowlist: if query grams look like a single-pack (25–80g) and DB says "Per 1 bag/pack"
function looksLikeSnackPackQuery(query, grams) {
  if (!grams) return false;
  if (grams < 20 || grams > 100) return false;
  const q = normText(query);
  return q.includes("crisps") || q.includes("chips") || q.includes("snack") || q.includes("bag") || q.includes("pack");
}

function isBagOrPackServing(desc) {
  const d = normText(desc);
  return d.includes("per 1 bag") || d.includes("per 1 pack") || d.includes("per bag") || d.includes("per pack");
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

// -------------------- DB scaling veto (generic) --------------------
function isScalingMismatch(candidate, grams, ml, query) {
  // if explicit grams/ml but candidate is "Per 1 ___" and not scalable -> veto
  if (grams && !candidate.per_grams && looksPerServingUnit(candidate.description)) {
    // except snack-pack case where "Per 1 bag/pack" is acceptable
    if (looksLikeSnackPackQuery(query, grams) && isBagOrPackServing(candidate.description)) {
      return false;
    }
    return true;
  }
  if (ml && !candidate.per_ml && looksPerServingUnit(candidate.description)) return true;
  return false;
}

// -------------------- AI: estimate (single brain for resolve) --------------------
async function estimateAI(food) {
  const grams = extractExplicitGrams(food);
  const ml = extractExplicitMl(food);

  // grams => per 100g + scale in code (more consistent)
  if (grams) {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
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
      // keep per-100g details for debug/tuning
      calories_per_100g: Number(per100g.calories_per_100g),
      protein_per_100g: Number(per100g.protein_per_100g),
      carbs_per_100g: Number(per100g.carbs_per_100g),
      fat_per_100g: Number(per100g.fat_per_100g),
    };
  }

  // ml (drinks) or no quantity => serving estimate
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    text: { format: { type: "json_object" } },
    input: [
      {
        role: "system",
        content:
          "Return ONLY valid JSON. If the user specifies a portion (e.g. 1 slice, 1 tbsp, 1 cup, 330ml), estimate nutrition for that portion. If no portion is specified, assume a typical single serving. Be realistic for UK portions.",
      },
      {
        role: "user",
        content: `Food description: "${food}"

Return JSON:
{
  "name": string,
  "serving_description": string,
  "estimated_serving_grams": number,
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

  return {
    source: "ai",
    mode: ml ? "volume" : "serving",
    name: j.name,
    grams: Number.isFinite(Number(j.estimated_serving_grams)) ? Number(j.estimated_serving_grams) : null,
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
          "Pick the single best matching candidate index for the query.\n" +
          "Return ONLY JSON: {\"index\": number, \"confidence\": number}\n" +
          "Do NOT pick unrelated foods.\n" +
          "Prefer exact brand/name matches.\n",
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

// -------------------- AI-first Hybrid Resolve --------------------
app.post("/food/resolve", ensureFatSecretToken, async (req, res) => {
  const { food, debug } = req.body || {};

  if (!food || typeof food !== "string") {
    return res.status(400).json({ error: "food is required" });
  }

  const cacheKey = `resolve-ai-first:${food}`;
  const cached = cache.get(cacheKey);
  if (cached && !debug) return res.json(cached);

  // 1) Always compute AI result first (UX stable)
  let aiResult;
  try {
    aiResult = await estimateAI(food);
  } catch (err) {
    console.error("AI estimate failed:", err.response?.data || err.message || err);
    // ultra-safe fallback if OpenAI fails
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

  // 2) Try to upgrade using FatSecret if it’s a strong match
  try {
    const fsRes = await axios.get(FATSECRET_API_URL, {
      params: {
        method: "foods.search",
        search_expression: food,
        max_results: MAX_RESULTS,
        format: "json",
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const candidates = buildCandidates(fsRes.data);
    if (!candidates.length) {
      const out = debug ? { ...aiResult, debug: { used: "ai_only", reason: "no_db_candidates" } } : aiResult;
      if (!debug) cache.set(cacheKey, out);
      return res.json(out);
    }

    // Deterministic prefilter by token score
    const scored = candidates
      .map((c) => ({ c, s: tokenScore(food, c) }))
      .sort((a, b) => b.s - a.s);

    const bestDet = scored[0];
    const top = scored.slice(0, 6).map((x) => x.c);

    // Brand gate: if query contains a strong brand hint, require it appears somewhere in chosen candidate text
    const brandHints = extractBrandHints(food);

    // Phrase gate: simple compound phrase constraint for common cases like "sausage roll"
    const qTokens = tokenize(food);
    const phraseMustHave = [];
    if (normText(food).includes("sausage roll")) phraseMustHave.push("sausage", "roll");
    if (normText(food).includes("chicken tikka masala")) phraseMustHave.push("chicken", "tikka", "masala");
    if (normText(food).includes("ready salted")) phraseMustHave.push("ready", "salted");

    // If DB doesn't even vaguely match, keep AI
    if (!bestDet || bestDet.s < MIN_DB_TOKEN_SCORE) {
      const out = debug
        ? { ...aiResult, debug: { used: "ai_only", reason: "db_low_token_score", best_token_score: bestDet?.s ?? 0, min: MIN_DB_TOKEN_SCORE } }
        : aiResult;
      if (!debug) cache.set(cacheKey, out);
      return res.json(out);
    }

    // Ask AI to pick among top candidates
    let pick = { index: -1, confidence: 0 };
    try {
      pick = await pickBestCandidateIndex(food, top);
    } catch (e) {
      // ignore, fallback to deterministic best
      pick = { index: -1, confidence: 0 };
    }

    const chosen = pick.index >= 0 && pick.index < top.length ? top[pick.index] : bestDet.c;
    const chosenScore = tokenScore(food, chosen);

    // Apply brand/phrase gates
    const chosenText = `${chosen.brand || ""} ${chosen.name || ""} ${chosen.description || ""}`;
    if (brandHints.length && !containsAllKeywords(chosenText, brandHints)) {
      const out = debug
        ? { ...aiResult, debug: { used: "ai_only", reason: "brand_gate_failed", brandHints, chosen: { name: chosen.name, brand: chosen.brand }, chosenScore } }
        : aiResult;
      if (!debug) cache.set(cacheKey, out);
      return res.json(out);
    }

    if (phraseMustHave.length && !containsAllKeywords(chosenText, phraseMustHave)) {
      const out = debug
        ? { ...aiResult, debug: { used: "ai_only", reason: "phrase_gate_failed", phraseMustHave, chosen: { name: chosen.name, brand: chosen.brand }, chosenScore } }
        : aiResult;
      if (!debug) cache.set(cacheKey, out);
      return res.json(out);
    }

    // If AI isn’t confident about this DB pick, prefer AI unless AI itself is low-confidence
    const aiIsLow = (aiResult?.confidence ?? 0) < MIN_AI_CONFIDENCE;
    const dbPickIsWeak = pick.confidence < MIN_DB_AI_PICK_CONF;

    if (dbPickIsWeak && !aiIsLow) {
      const out = debug
        ? { ...aiResult, debug: { used: "ai_only", reason: "db_pick_confidence_low", db_pick_confidence: pick.confidence, min: MIN_DB_AI_PICK_CONF, chosenScore } }
        : aiResult;
      if (!debug) cache.set(cacheKey, out);
      return res.json(out);
    }

    // Scaling veto (generic)
    if (isScalingMismatch(chosen, grams, ml, food)) {
      const out = debug
        ? { ...aiResult, debug: { used: "ai_only", reason: "db_scaling_mismatch_veto", chosen: { name: chosen.name, brand: chosen.brand }, chosenScore } }
        : aiResult;
      if (!debug) cache.set(cacheKey, out);
      return res.json(out);
    }

    // Scale DB candidate deterministically
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
            thresholds: {
              MIN_AI_CONFIDENCE,
              MIN_DB_TOKEN_SCORE,
              MIN_DB_AI_PICK_CONF,
            },
          },
        }
        : {}),
    };

    // If AI confidence is very high and DB upgrade is only marginal match, you can keep AI.
    // (Optional: commented out for now; you can enable later)
    // if ((aiResult?.confidence ?? 0) >= 0.9 && chosenScore < 0.55) return res.json(aiResult);

    if (!debug) cache.set(cacheKey, dbResult);
    return res.json(dbResult);
  } catch (err) {
    // DB failure should never break UX — return AI result
    console.error("FatSecret resolve error:", err.response?.data || err.message || err);
    const out = debug ? { ...aiResult, debug: { used: "ai_only", reason: "db_exception", error: err.message } } : aiResult;
    if (!debug) cache.set(cacheKey, out);
    return res.json(out);
  }
});

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
