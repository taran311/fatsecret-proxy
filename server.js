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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------- FatSecret --------------------
const FATSECRET_API_URL = "https://platform.fatsecret.com/rest/server.api";
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const cache = new NodeCache({ stdTTL: 300 }); // 5 mins

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
      return res.status(500).json({ error: "CLIENT_ID/CLIENT_SECRET missing" });
    }
    if (!accessToken || Date.now() >= tokenExpirationTime) {
      await getAccessToken();
    }
    next();
  } catch (err) {
    console.error("FatSecret token error:", err.response?.data || err.message || err);
    return res.status(500).json({ error: "Failed to fetch access token" });
  }
}

// -------------------- Health --------------------
app.get("/health", (req, res) => res.status(200).send("OK"));

// -------------------- Passthrough search (keep for debugging / UI) --------------------
app.get("/foods/search/v1", ensureFatSecretToken, async (req, res) => {
  const { search_expression, max_results, format } = req.query;
  const cacheKey = `fssearch:${search_expression}:${max_results || ""}:${format || "json"}`;

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

// -------------------- Parsing helpers --------------------
function extractExplicitGrams(text) {
  const m = String(text).match(/(\d+(?:\.\d+)?)\s*(g|gram|grams)\b/i);
  if (!m) return null;
  const grams = Number(m[1]);
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
  return flOz * 29.5735; // US fl oz → ml
}

function looksPerServingUnit(desc) {
  const d = String(desc || "");
  // Generic: "Per 1 anything" + "Per serving"
  if (/\bPer\s+1\s+[A-Za-z]/i.test(d)) return true;
  if (/\bPer\s+serving\b/i.test(d)) return true;
  return false;
}

// Parse FatSecret macros from description
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

// -------------------- Candidate builder --------------------
function buildCandidates(fsData) {
  const foods = fsData?.foods?.food || [];
  const arr = Array.isArray(foods) ? foods : [foods];

  return arr
    .map((f) => {
      const desc = f.food_description || "";
      const perG = extractPerGrams(desc);
      const perMl = extractPerMl(desc) ?? extractPerFlOzAsMl(desc);
      const nutrition = parseNutrition(desc);

      return {
        id: f.food_id,
        name: f.food_name || "",
        brand: f.brand_name || null,
        description: desc,
        nutrition,
        per_grams: perG,
        per_ml: perMl,
      };
    })
    .filter((c) => c.nutrition);
}

// -------------------- Deterministic scaling --------------------
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

// -------------------- Generic mismatch rule --------------------
// If user gave grams/ml but candidate is "Per 1 ___" (serving unit) and not scalable → veto
function isMismatch(candidate, grams, ml) {
  if (grams && !candidate.per_grams && looksPerServingUnit(candidate.description)) return true;
  if (ml && !candidate.per_ml && looksPerServingUnit(candidate.description)) return true;
  return false;
}

// -------------------- Deterministic semantic gate (stops mackerel/crisps) --------------------
function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function tokenScore(query, candidate) {
  const qTokens = tokenize(query);
  const q = new Set(qTokens);

  if (!q.size) return 0;

  const cTokens = tokenize(`${candidate.brand || ""} ${candidate.name || ""} ${candidate.description || ""}`);

  let hit = 0;
  for (const t of cTokens) {
    if (q.has(t)) hit++;
  }

  // normalize a bit so short queries aren't too harsh
  return hit / Math.max(4, qTokens.length);
}

function bestTokenMatch(query, candidates) {
  let best = null;
  let bestScore = -1;

  for (const c of candidates) {
    const s = tokenScore(query, c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return { best, bestScore };
}

// -------------------- AI candidate selector --------------------
async function pickBestCandidateIndex(food, candidates) {
  // Keep it cheap: only send name+brand+description
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
          "Do not pick unrelated foods.\n" +
          "If unsure, pick the closest by name/brand.\n",
      },
      {
        role: "user",
        content: JSON.stringify({ query: food, candidates: simplified }),
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

// -------------------- AI fallback (never crash) --------------------
async function aiFallback(food) {
  // Two modes:
  // - if explicit grams: ask per-100g and scale in code (more consistent)
  // - else serving estimate
  const grams = extractExplicitGrams(food);
  const ml = extractExplicitMl(food);

  if (grams) {
    const r = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      text: { format: { type: "json_object" } },
      input: [
        {
          role: "system",
          content:
            "Return ONLY JSON. Provide nutrition strictly PER 100g. Do NOT scale totals.",
        },
        {
          role: "user",
          content: `Food: "${food}"
Return:
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

    const j = JSON.parse(r.output_text);
    const factor = grams / 100;

    return {
      source: "ai",
      mode: "weight",
      name: j.name,
      grams,
      ml: null,
      calories: Math.round(Number(j.calories_per_100g) * factor),
      protein: round1(Number(j.protein_per_100g) * factor),
      carbs: round1(Number(j.carbs_per_100g) * factor),
      fat: round1(Number(j.fat_per_100g) * factor),
      confidence: Number.isFinite(Number(j.confidence)) ? Number(j.confidence) : 0.75,
      calories_per_100g: Number(j.calories_per_100g),
      protein_per_100g: Number(j.protein_per_100g),
      carbs_per_100g: Number(j.carbs_per_100g),
      fat_per_100g: Number(j.fat_per_100g),
    };
  }

  // If ml given and it's a drink, AI can do serving; DB will often be better, but fallback is fine.
  const r = await openai.responses.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    text: { format: { type: "json_object" } },
    input: [
      {
        role: "system",
        content:
          "Return ONLY JSON. Estimate nutrition for the described portion. If no portion, assume typical single serving in the UK.",
      },
      {
        role: "user",
        content: `Food: "${food}"
Return:
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

  const j = JSON.parse(r.output_text);
  return {
    source: "ai",
    mode: "serving",
    name: j.name,
    grams: Number.isFinite(Number(j.estimated_serving_grams)) ? Number(j.estimated_serving_grams) : null,
    ml: ml ?? null,
    serving_description: j.serving_description,
    calories: Math.round(Number(j.calories) || 0),
    protein: round1(Number(j.protein) || 0),
    carbs: round1(Number(j.carbs) || 0),
    fat: round1(Number(j.fat) || 0),
    confidence: Number.isFinite(Number(j.confidence)) ? Number(j.confidence) : 0.7,
  };
}

// -------------------- Hybrid resolve --------------------
app.post("/food/resolve", ensureFatSecretToken, async (req, res) => {
  const { food, debug } = req.body || {};

  // Always validate input
  if (!food || typeof food !== "string") {
    return res.status(400).json({ error: "food is required" });
  }

  // Cache resolve results (helps with repeated quick-add)
  const cacheKey = `resolve:${food}`;
  const cached = cache.get(cacheKey);
  if (cached && !debug) return res.json(cached);

  const grams = extractExplicitGrams(food);
  const ml = extractExplicitMl(food);

  try {
    // 1) FatSecret search
    const fsRes = await axios.get(FATSECRET_API_URL, {
      params: {
        method: "foods.search",
        search_expression: food,
        max_results: 12,
        format: "json",
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const candidates = buildCandidates(fsRes.data);

    // If no candidates → AI fallback
    if (!candidates.length) {
      const fb = await aiFallback(food);
      if (!debug) cache.set(cacheKey, fb);
      return res.json(debug ? { ...fb, debug: { fallback: true, reason: "no_candidates" } } : fb);
    }

    // 2) Deterministic pre-filter: pick top candidates by token score
    // This makes AI selection robust and prevents "mackerel for crisps"
    const scored = candidates
      .map((c) => ({ c, s: tokenScore(food, c) }))
      .sort((a, b) => b.s - a.s);

    const top = scored.slice(0, 6).map((x) => x.c);
    const bestDet = scored[0];

    // If nothing even vaguely matches, bail to AI early
    const MIN_TOKEN_SCORE = 0.25;
    if (!bestDet || bestDet.s < MIN_TOKEN_SCORE) {
      const fb = await aiFallback(food);
      const out = debug
        ? { ...fb, debug: { fallback: true, reason: "low_token_match", best_token_score: bestDet?.s ?? 0, min: MIN_TOKEN_SCORE } }
        : fb;
      if (!debug) cache.set(cacheKey, out);
      return res.json(out);
    }

    // 3) AI choose among top candidates (safe)
    let chosen = null;
    let aiPick = { index: -1, confidence: 0 };

    try {
      aiPick = await pickBestCandidateIndex(food, top);
      if (aiPick.index >= 0 && aiPick.index < top.length) {
        chosen = top[aiPick.index];
      }
    } catch (e) {
      // If OpenAI fails, fall back to best deterministic match
      chosen = bestDet.c;
    }

    // 4) Final safety: ensure chosen still meets minimum token match
    const chosenScore = chosen ? tokenScore(food, chosen) : 0;
    if (!chosen || chosenScore < MIN_TOKEN_SCORE) {
      const fb = await aiFallback(food);
      const out = debug
        ? { ...fb, debug: { fallback: true, reason: "chosen_low_token_match", chosenScore, min: MIN_TOKEN_SCORE } }
        : fb;
      if (!debug) cache.set(cacheKey, out);
      return res.json(out);
    }

    // 5) Mismatch/scaling veto (grams/ml vs per-1-unit)
    if (isMismatch(chosen, grams, ml)) {
      const fb = await aiFallback(food);
      const out = debug
        ? { ...fb, debug: { fallback: true, reason: "scaling_mismatch_veto" } }
        : fb;
      if (!debug) cache.set(cacheKey, out);
      return res.json(out);
    }

    // 6) Scale deterministically
    const scaled = scaleCandidate(chosen, grams, ml);

    const result = {
      source: "fatsecret",
      mode: scaled.mode,
      name: chosen.brand ? `${chosen.brand} ${chosen.name}` : chosen.name,
      grams: grams ?? null,
      ml: ml ?? null,
      calories: scaled.calories,
      protein: scaled.protein,
      carbs: scaled.carbs,
      fat: scaled.fat,
      confidence: 0.9, // UI confidence (we keep stable)
      ...(debug
        ? {
            debug: {
              chosen_name: chosen.name,
              chosen_brand: chosen.brand,
              token_score: chosenScore,
              best_token_score: bestDet.s,
              ai_pick: aiPick,
              factor: scaled.factor,
              per_grams: chosen.per_grams,
              per_ml: chosen.per_ml,
              description: chosen.description,
              candidate_count: candidates.length,
              prefiltered_count: top.length,
              min_token_score: MIN_TOKEN_SCORE,
            },
          }
        : {}),
    };

    if (!debug) cache.set(cacheKey, result);
    return res.json(result);
  } catch (err) {
    // ✅ NEVER 500 on resolve; always return AI fallback
    console.error("RESOLVE ERROR:", err.response?.data || err.message || err);
    try {
      const fb = await aiFallback(food);
      const out = debug ? { ...fb, debug: { fallback: true, reason: "exception", error: err.message } } : fb;
      if (!debug) cache.set(cacheKey, out);
      return res.json(out);
    } catch (e) {
      console.error("FALLBACK ERROR:", e.message || e);
      // absolute last resort
      return res.json({
        source: "ai",
        mode: "serving",
        name: food,
        grams: grams ?? null,
        ml: ml ?? null,
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
        confidence: 0.1,
        ...(debug ? { debug: { fallback: true, reason: "fallback_failed" } } : {}),
      });
    }
  }
});

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
