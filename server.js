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

const cache = new NodeCache({ stdTTL: 600 }); // 10 mins
const FATSECRET_MIN_CONFIDENCE = 0.65;

let accessToken = null;
let tokenExpirationTime = null;

const getAccessToken = async () => {
  console.log("Fetching new access token...");
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
  console.log("Access token fetched successfully");
};

const ensureFatSecretToken = async (req, res, next) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: "FatSecret CLIENT_ID/CLIENT_SECRET missing" });
  }
  if (!accessToken || Date.now() >= tokenExpirationTime) {
    try {
      await getAccessToken();
    } catch (err) {
      console.error("Failed to refresh access token:", err.response?.data || err.message);
      return res.status(500).json({ error: "Failed to fetch access token" });
    }
  }
  next();
};

// -------------------- Health --------------------
app.get("/health", (req, res) => res.status(200).send("OK"));

// -------------------- Helpers --------------------
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function asArray(x) {
  return Array.isArray(x) ? x : [];
}
function clamp01(n, fallback = 0.7) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(0, Math.min(1, x));
}
function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
function includesAny(haystack, needles) {
  const h = normText(haystack);
  return needles.some((n) => h.includes(n));
}
function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Number(x.toFixed(1));
}

// ---- Explicit quantity parsing from user input ----
function extractExplicitGrams(foodText) {
  const match = String(foodText).match(/(\d+(?:\.\d+)?)\s*(g|gram|grams)\b/i);
  if (!match) return null;
  const grams = Number(match[1]);
  return Number.isFinite(grams) ? grams : null;
}
function extractExplicitMl(foodText) {
  const t = String(foodText);

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

// ---- Extract scaling bases from FatSecret description ----
function extractPerGramsFromDescription(desc) {
  if (!desc) return null;
  const m = String(desc).match(/\bPer\s+(\d+(?:\.\d+)?)\s*g\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function extractPerMlFromDescription(desc) {
  if (!desc) return null;
  const m = String(desc).match(/\bPer\s+(\d+(?:\.\d+)?)\s*ml\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function extractPackSizeGramsFromName(name) {
  const t = String(name || "");

  let m = t.match(/\((\d+(?:\.\d+)?)\s*g\b/i);
  if (m) {
    const g = Number(m[1]);
    return Number.isFinite(g) && g > 0 ? g : null;
  }

  m = t.match(/\b(\d+(?:\.\d+)?)\s*g\b/i);
  if (m) {
    const g = Number(m[1]);
    return Number.isFinite(g) && g > 0 ? g : null;
  }

  return null;
}

// ---- Parse macros from FatSecret description (so we NEVER trust the model’s math) ----
// Expected patterns like:
// "Per 100ml - Calories: 42kcal | Fat: 0.00g | Carbs: 10.60g | Protein: 0.00g"
function parseNutritionFromDescription(desc) {
  const d = String(desc || "");

  const calMatch = d.match(/Calories:\s*([0-9]+(?:\.[0-9]+)?)\s*kcal/i);
  const fatMatch = d.match(/Fat:\s*([0-9]+(?:\.[0-9]+)?)\s*g/i);
  const carbsMatch = d.match(/Carbs:\s*([0-9]+(?:\.[0-9]+)?)\s*g/i);
  const proteinMatch = d.match(/Protein:\s*([0-9]+(?:\.[0-9]+)?)\s*g/i);

  const calories = calMatch ? Number(calMatch[1]) : null;
  const fat = fatMatch ? Number(fatMatch[1]) : null;
  const carbs = carbsMatch ? Number(carbsMatch[1]) : null;
  const protein = proteinMatch ? Number(proteinMatch[1]) : null;

  const ok =
    Number.isFinite(calories) &&
    Number.isFinite(fat) &&
    Number.isFinite(carbs) &&
    Number.isFinite(protein);

  return ok ? { calories, fat, carbs, protein } : null;
}

function looksPerPackServing(desc) {
  const d = normText(desc);
  return (
    d.includes("per 1 pack") ||
    d.includes("per 1 bag") ||
    d.includes("per pack") ||
    d.includes("per bag") ||
    d.includes("per 1 bar") ||
    d.includes("per bar") ||
    d.includes("per 1 serving") ||
    d.includes("per serving") ||
    d.includes("per 1 mug") ||
    d.includes("per mug")
  );
}

function looksComposite(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes(" and ") || t.includes(",") || t.includes(" + ")) return true;

  const qtyMatches = t.match(
    /\b\d+(\.\d+)?\s*(x\s*)?(slice|slices|egg|eggs|tbsp|tsp|cup|cups|bar|bars|piece|pieces|portion|portions)\b/g
  );
  if (qtyMatches && qtyMatches.length >= 2) return true;

  return false;
}

function buildFatSecretCandidates(fsData) {
  const foods = fsData?.foods?.food || [];
  const arr = asArray(foods);

  return arr.slice(0, 12).map((f) => {
    const description = f.food_description || null;
    const name = f.food_name;
    return {
      food_id: f.food_id,
      name,
      brand: f.brand_name || null,
      description,
      per_grams: extractPerGramsFromDescription(description),
      per_ml: extractPerMlFromDescription(description),
      pack_grams: extractPackSizeGramsFromName(name),
      nutrition: parseNutritionFromDescription(description),
      type: f.food_type || null,
      url: f.food_url || null,
    };
  });
}

// -------------------- Generic mismatch guardrails --------------------
const TOKENS = {
  drinkSizes: ["small", "medium", "large", "grande", "venti", "tall"],
  capsule: [
    "tassimo",
    "nespresso",
    "dolce gusto",
    "dolcegusto",
    "k-cup",
    "kcup",
    "keurig",
    "pod",
    "pods",
    "capsule",
    "capsules",
  ],
  variants: [
    "baked",
    "light",
    "lite",
    "zero",
    "diet",
    "sugar free",
    "sugar-free",
    "low fat",
    "reduced fat",
    "fat free",
  ],
};

function candidateText(c) {
  return `${c?.brand || ""} ${c?.name || ""} ${c?.description || ""}`;
}
function userImpliesInStoreDrink(userText) {
  return includesAny(userText, TOKENS.drinkSizes);
}
function candidateLooksCapsuleProduct(c) {
  return includesAny(candidateText(c), TOKENS.capsule);
}
function userAsksForVariant(userText) {
  return includesAny(userText, TOKENS.variants);
}
function candidateIsVariant(c) {
  return includesAny(candidateText(c), TOKENS.variants);
}
function packSizeMismatch(userGrams, candidatePackGrams) {
  if (!Number.isFinite(Number(userGrams)) || !Number.isFinite(Number(candidatePackGrams)))
    return false;
  const u = Number(userGrams);
  const p = Number(candidatePackGrams);
  if (u <= 0 || p <= 0) return false;
  return Math.abs(p - u) / u > 0.2;
}

// NEW POLICY: explicit grams requires scalable nutrition OR confirm pack size
function cannotSafelyUseForExplicitGrams(candidate, explicitGrams) {
  if (explicitGrams === null) return false;

  // If we have "Per Ng" we can scale safely.
  if (candidate?.per_grams && candidate?.nutrition) return false;

  // If it’s explicitly a pack size and close match, accept (and we can optionally scale by pack_grams).
  if (
    candidate?.pack_grams &&
    candidate?.nutrition &&
    !packSizeMismatch(explicitGrams, candidate.pack_grams)
  ) {
    return false;
  }

  // If it’s per pack/bag/serving and we cannot scale/confirm -> unsafe
  if (looksPerPackServing(candidate?.description || "")) return true;

  return false;
}

function computeMismatch(userText, chosenCandidate, { explicitGrams }) {
  const mismatches = [];

  if (userImpliesInStoreDrink(userText) && candidateLooksCapsuleProduct(chosenCandidate)) {
    mismatches.push("product_type_mismatch");
  }

  if (!userAsksForVariant(userText) && candidateIsVariant(chosenCandidate)) {
    mismatches.push("variant_mismatch_user_unspecified");
  }

  if (
    explicitGrams !== null &&
    chosenCandidate?.pack_grams !== null &&
    packSizeMismatch(explicitGrams, chosenCandidate.pack_grams)
  ) {
    mismatches.push("explicit_weight_vs_pack_size_mismatch");
  }

  if (cannotSafelyUseForExplicitGrams(chosenCandidate, explicitGrams)) {
    mismatches.push("explicit_weight_requires_scalable_source");
  }

  // If FatSecret candidate doesn’t even have parsable macros, veto.
  if (!chosenCandidate?.nutrition) {
    mismatches.push("unparseable_fatsecret_description");
  }

  return mismatches;
}

function filterCandidatesByMismatches(candidates, userText, mismatches, { explicitGrams }) {
  if (!mismatches.length) return candidates;

  return candidates.filter((c) => {
    if (mismatches.includes("product_type_mismatch")) {
      if (candidateLooksCapsuleProduct(c)) return false;
    }
    if (mismatches.includes("variant_mismatch_user_unspecified")) {
      if (candidateIsVariant(c)) return false;
    }
    if (mismatches.includes("explicit_weight_vs_pack_size_mismatch")) {
      if (
        explicitGrams !== null &&
        c?.pack_grams !== null &&
        packSizeMismatch(explicitGrams, c.pack_grams)
      ) {
        return false;
      }
    }
    if (mismatches.includes("explicit_weight_requires_scalable_source")) {
      if (cannotSafelyUseForExplicitGrams(c, explicitGrams)) return false;
    }
    if (mismatches.includes("unparseable_fatsecret_description")) {
      if (!c?.nutrition) return false;
    }
    return true;
  });
}

// -------------------- AI estimate (fallback) --------------------
async function estimateWithGPT(food) {
  const grams = extractExplicitGrams(food);
  const isWeightBased = grams !== null;

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

  if (isWeightBased) {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      text: { format: { type: "json_object" } },
      input: [
        {
          role: "system",
          content:
            "Return ONLY valid JSON. Always return values strictly PER 100g for the described food. Do NOT scale totals to any quantity mentioned.",
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

    const per100g = safeJsonParse(response.output_text);
    if (!per100g) throw new Error("Bad JSON from model (weight)");

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
      confidence: clamp01(per100g.confidence, 0.75),
      calories_per_100g: Number(per100g.calories_per_100g),
      protein_per_100g: Number(per100g.protein_per_100g),
      carbs_per_100g: Number(per100g.carbs_per_100g),
      fat_per_100g: Number(per100g.fat_per_100g),
    };
  }

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    text: { format: { type: "json_object" } },
    input: [
      {
        role: "system",
        content:
          "Return ONLY valid JSON.\n" +
          "- If the user specifies a portion (e.g. 1 slice, 1 tbsp, 1 cup), estimate nutrition for that portion.\n" +
          "- If the input contains multiple items (e.g. '2 eggs and toast'), estimate each mentally and return a single summed total.\n" +
          "- If a UK brand/chain is mentioned (e.g. Greggs, Costa), use a conservative typical UK value if uncertain.\n" +
          "- If no portion is specified, assume a typical single serving. Be realistic for UK portions.",
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

  const out = safeJsonParse(response.output_text);
  if (!out) throw new Error("Bad JSON from model (serving)");

  return {
    source: "ai",
    mode: "serving",
    name: out.name,
    grams: Number.isFinite(Number(out.estimated_serving_grams))
      ? Number(out.estimated_serving_grams)
      : null,
    ml: null,
    serving_description: out.serving_description,
    calories: Math.round(Number(out.calories) || 0),
    protein: round1(Number(out.protein) || 0),
    carbs: round1(Number(out.carbs) || 0),
    fat: round1(Number(out.fat) || 0),
    confidence: clamp01(out.confidence, 0.7),
  };
}

// -------------------- AI selector (ONLY chooses candidate; code computes nutrition) --------------------
async function selectCandidateIndex({ food, candidates }) {
  const selector = await openai.responses.create({
    model: "gpt-4.1-mini",
    temperature: 0.1,
    text: { format: { type: "json_object" } },
    input: [
      {
        role: "system",
        content:
          "Return ONLY valid JSON.\n" +
          "Pick the SINGLE best FatSecret candidate index for the user input.\n" +
          "Do not do any nutrition math.\n" +
          "If none fit, set use_fallback=true.\n" +
          "Confidence must be 0..1.\n",
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            user_input: food,
            candidates: candidates.map((c, i) => ({
              i,
              brand: c.brand,
              name: c.name,
              description: c.description,
              per_grams: c.per_grams,
              per_ml: c.per_ml,
              pack_grams: c.pack_grams,
              has_parsed_nutrition: Boolean(c.nutrition),
            })),
            schema: {
              use_fallback: "boolean",
              chosen_index: "number | null",
              confidence: "number",
              reason: "string",
            },
          },
          null,
          2
        ),
      },
    ],
  });

  return safeJsonParse(selector.output_text);
}

// -------------------- Deterministic scaling (fixes your 10x Coke bug permanently) --------------------
function computeFromCandidate({ candidate, explicitGrams, explicitMl }) {
  const n = candidate?.nutrition;
  if (!n) return null;

  // Base quantity in description (Per Ng / Per Nml)
  const perG = candidate?.per_grams ?? null;
  const perMl = candidate?.per_ml ?? null;

  // If user provided ML and candidate provides per_ml -> volume scaling
  if (explicitMl !== null && perMl) {
    const factor = explicitMl / perMl; // <-- correct, no /10 nonsense
    return {
      mode: "volume",
      grams: null,
      ml: explicitMl,
      calories: Math.round(n.calories * factor),
      protein: round1(n.protein * factor),
      carbs: round1(n.carbs * factor),
      fat: round1(n.fat * factor),
      base_per_ml: perMl,
      base_per_grams: null,
      factor,
    };
  }

  // If user provided grams and candidate provides per_grams -> weight scaling
  if (explicitGrams !== null && perG) {
    const factor = explicitGrams / perG;
    return {
      mode: "weight",
      grams: explicitGrams,
      ml: null,
      calories: Math.round(n.calories * factor),
      protein: round1(n.protein * factor),
      carbs: round1(n.carbs * factor),
      fat: round1(n.fat * factor),
      base_per_ml: null,
      base_per_grams: perG,
      factor,
    };
  }

  // If user provided grams but candidate is per-pack and we have pack_grams close => optionally scale by grams/pack_grams
  if (
    explicitGrams !== null &&
    candidate?.pack_grams &&
    !packSizeMismatch(explicitGrams, candidate.pack_grams) &&
    looksPerPackServing(candidate?.description || "")
  ) {
    const factor = explicitGrams / candidate.pack_grams;
    return {
      mode: "weight",
      grams: explicitGrams,
      ml: null,
      calories: Math.round(n.calories * factor),
      protein: round1(n.protein * factor),
      carbs: round1(n.carbs * factor),
      fat: round1(n.fat * factor),
      base_per_ml: null,
      base_per_grams: candidate.pack_grams,
      factor,
    };
  }

  // Otherwise treat as serving (no scaling)
  return {
    mode: "serving",
    grams: explicitGrams ?? null,
    ml: explicitMl ?? null,
    calories: Math.round(n.calories),
    protein: round1(n.protein),
    carbs: round1(n.carbs),
    fat: round1(n.fat),
    base_per_ml: perMl,
    base_per_grams: perG,
    factor: 1,
  };
}

// -------------------- OPTIONAL: keep your FatSecret passthrough search --------------------
app.get("/foods/search/v1", ensureFatSecretToken, async (req, res) => {
  const { search_expression, max_results, format } = req.query;
  const cacheKey = `fssearch:${search_expression}-${max_results}-${format || "json"}`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(FATSECRET_API_URL, {
      params: {
        method: "foods.search",
        search_expression,
        max_results,
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
    console.error("foods.search error:", err.response?.data || err.message);
    return res
      .status(err.response?.status || 500)
      .json(err.response?.data || { error: "Internal Server Error" });
  }
});

// -------------------- SINGLE ENDPOINT: Hybrid resolve --------------------
app.post("/food/resolve", ensureFatSecretToken, async (req, res) => {
  try {
    const { food, max_results, debug } = req.body || {};

    if (!food || typeof food !== "string") return res.status(400).json({ error: "food is required" });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY is not set" });

    const grams = extractExplicitGrams(food);
    const ml = extractExplicitMl(food);
    const fsMax = Number.isFinite(Number(max_results)) ? Number(max_results) : 12;

    const cacheKey = `resolve:${food}:${fsMax}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Composite => AI directly
    if (looksComposite(food)) {
      const fallback = await estimateWithGPT(food);
      if (debug) fallback.debug = { fallback_reason: "composite_input_detected" };
      cache.set(cacheKey, fallback);
      return res.json(fallback);
    }

    // 1) FatSecret search
    let fsData;
    try {
      const fsResp = await axios.get(FATSECRET_API_URL, {
        params: {
          method: "foods.search",
          search_expression: food,
          max_results: fsMax,
          format: "json",
        },
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });
      fsData = fsResp.data;
    } catch (err) {
      console.error("FatSecret search failed:", err?.response?.data || err.message);
      const fallback = await estimateWithGPT(food);
      if (debug) fallback.debug = { fallback_reason: "fatsecret_search_failed" };
      cache.set(cacheKey, fallback);
      return res.json(fallback);
    }

    const candidates = buildFatSecretCandidates(fsData);
    if (!candidates.length) {
      const fallback = await estimateWithGPT(food);
      if (debug) fallback.debug = { fallback_reason: "no_candidates" };
      cache.set(cacheKey, fallback);
      return res.json(fallback);
    }

    // 2) AI pick candidate index (NO math)
    const pick = await selectCandidateIndex({ food, candidates });
    const modelConfidence = clamp01(pick?.confidence, 0);

    const shouldFallbackInitial =
      !pick || pick.use_fallback || pick.chosen_index === null || modelConfidence < FATSECRET_MIN_CONFIDENCE;

    if (shouldFallbackInitial) {
      const fallback = await estimateWithGPT(food);
      if (debug) {
        fallback.debug = {
          fallback_reason:
            !pick
              ? "invalid_model_output"
              : pick.use_fallback
              ? "model_requested_fallback"
              : pick.chosen_index === null
              ? "no_candidate_selected"
              : `confidence_too_low (${modelConfidence} < ${FATSECRET_MIN_CONFIDENCE})`,
          model_confidence: modelConfidence,
          threshold: FATSECRET_MIN_CONFIDENCE,
          candidate_count: candidates.length,
        };
      }
      cache.set(cacheKey, fallback);
      return res.json(fallback);
    }

    let chosen = candidates[pick.chosen_index];
    if (!chosen) {
      const fallback = await estimateWithGPT(food);
      if (debug) fallback.debug = { fallback_reason: "chosen_index_out_of_range" };
      cache.set(cacheKey, fallback);
      return res.json(fallback);
    }

    // 3) mismatch guardrails + retry once
    const mismatches = computeMismatch(food, chosen, { explicitGrams: grams });
    let didRetry = false;
    let usedFiltered = false;

    if (mismatches.length) {
      const filtered = filterCandidatesByMismatches(candidates, food, mismatches, { explicitGrams: grams });
      if (filtered.length && filtered.length !== candidates.length) {
        didRetry = true;
        usedFiltered = true;

        const retryPick = await selectCandidateIndex({ food, candidates: filtered });
        const retryConf = clamp01(retryPick?.confidence, 0);

        if (retryPick && !retryPick.use_fallback && retryPick.chosen_index !== null && retryConf >= FATSECRET_MIN_CONFIDENCE) {
          chosen = filtered[retryPick.chosen_index] || chosen;

          const mism2 = computeMismatch(food, chosen, { explicitGrams: grams });
          if (mism2.length) {
            const fallback = await estimateWithGPT(food);
            if (debug) {
              fallback.debug = {
                fallback_reason: "mismatch_after_retry",
                mismatches: mism2,
                threshold: FATSECRET_MIN_CONFIDENCE,
                candidate_count: candidates.length,
                filtered_candidate_count: filtered.length,
              };
            }
            cache.set(cacheKey, fallback);
            return res.json(fallback);
          }
        } else {
          const fallback = await estimateWithGPT(food);
          if (debug) {
            fallback.debug = {
              fallback_reason: "mismatch_veto_then_retry_failed",
              mismatches,
              model_confidence: modelConfidence,
              threshold: FATSECRET_MIN_CONFIDENCE,
              candidate_count: candidates.length,
              filtered_candidate_count: filtered.length,
            };
          }
          cache.set(cacheKey, fallback);
          return res.json(fallback);
        }
      } else {
        const fallback = await estimateWithGPT(food);
        if (debug) {
          fallback.debug = {
            fallback_reason: "mismatch_veto_no_filter_possible",
            mismatches,
            threshold: FATSECRET_MIN_CONFIDENCE,
            candidate_count: candidates.length,
          };
        }
        cache.set(cacheKey, fallback);
        return res.json(fallback);
      }
    }

    // 4) Deterministic compute nutrition (fixes Coke 10x bug)
    const computed = computeFromCandidate({ candidate: chosen, explicitGrams: grams, explicitMl: ml });
    if (!computed) {
      const fallback = await estimateWithGPT(food);
      if (debug) {
        fallback.debug = {
          fallback_reason: "fatsecret_unparseable_nutrition",
          candidate_count: candidates.length,
        };
      }
      cache.set(cacheKey, fallback);
      return res.json(fallback);
    }

    const result = {
      source: "fatsecret",
      mode: computed.mode,
      name: chosen.brand ? `${chosen.brand} ${chosen.name}` : chosen.name,
      grams: computed.grams,
      ml: computed.ml,
      calories: computed.calories,
      protein: computed.protein,
      carbs: computed.carbs,
      fat: computed.fat,
      confidence: modelConfidence,
    };

    if (debug) {
      result.debug = {
        chosen_index: pick.chosen_index,
        chosen_food_id: chosen.food_id,
        chosen_brand: chosen.brand,
        chosen_name: chosen.name,
        chosen_description: chosen.description,
        chosen_per_grams: chosen.per_grams,
        chosen_per_ml: chosen.per_ml,
        chosen_pack_grams: chosen.pack_grams,
        parsed_nutrition: chosen.nutrition,
        computed_factor: computed.factor,
        computed_base_per_grams: computed.base_per_grams,
        computed_base_per_ml: computed.base_per_ml,
        reason: pick.reason,
        candidate_count: candidates.length,
        threshold: FATSECRET_MIN_CONFIDENCE,
        explicit_grams: grams,
        explicit_ml: ml,
        mismatch_retry_performed: didRetry,
        mismatch_retry_used_filtered: usedFiltered,
      };
    }

    cache.set(cacheKey, result);
    return res.json(result);
  } catch (err) {
    console.error("Resolve error:", err?.response?.data || err.message || err);

    try {
      const { food } = req.body || {};
      if (food && typeof food === "string") {
        const fallback = await estimateWithGPT(food);
        return res.json(fallback);
      }
    } catch {
      // ignore
    }

    return res.status(500).json({ error: "Resolve failed" });
  }
});

// -------------------- Macro helpers --------------------
function activityFactor(exerciseLevel) {
  const key = String(exerciseLevel || "").trim().toLowerCase();
  if (key === "no activity") return 1.2;
  if (key === "1-3 hours per week") return 1.375;
  if (key === "4-6 hours per week") return 1.55;
  if (key === "7-9 hours per week") return 1.725;
  if (key === "10 hour+ per week" || key === "10 hours+ per week" || key === "10+ hours per week") return 1.9;
  return 1.2;
}

function bmrMifflin({ gender, weightKg, heightCm, age }) {
  const g = String(gender || "").trim().toLowerCase();
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  if (g === "male" || g === "m") return base + 5;
  if (g === "female" || g === "f") return base - 161;
  return base - 78;
}

function buildMacros({ calories, weightKg, protein_g_per_kg, fat_pct }) {
  const protein_g = Math.round(weightKg * protein_g_per_kg);
  const protein_kcal = protein_g * 4;

  const fat_kcal = Math.round(calories * fat_pct);
  const fat_g = Math.round(fat_kcal / 9);

  const remaining_kcal = calories - protein_kcal - fat_g * 9;
  const carbs_g = Math.max(0, Math.round(remaining_kcal / 4));

  return { calories, protein_g, carbs_g, fat_g };
}

function clampNumber(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.min(max, Math.max(min, x));
}

function normalizeStatus(s) {
  const v = String(s || "").trim().toLowerCase();
  if (v === "verified") return "verified";
  if (v === "verified_with_suggestions") return "verified_with_suggestions";
  if (v === "adjusted") return "adjusted";
  return "verified_with_suggestions";
}

// -------------------- GPT-verified macro targets --------------------
app.post("/macro-targets", async (req, res) => {
  try {
    const { age, gender, height_cm, weight_kg, exercise_level } = req.body || {};

    const ageNum = Number(age);
    const heightCm = Number(height_cm);
    const weightKg = Number(weight_kg);

    if (!Number.isFinite(ageNum) || ageNum < 13 || ageNum > 90) {
      return res.status(400).json({ error: "age must be 13–90" });
    }
    if (!Number.isFinite(heightCm) || heightCm < 120 || heightCm > 230) {
      return res.status(400).json({ error: "height_cm must be 120–230" });
    }
    if (!Number.isFinite(weightKg) || weightKg < 35 || weightKg > 250) {
      return res.status(400).json({ error: "weight_kg must be 35–250" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    }

    const bmr = Math.round(bmrMifflin({ gender, weightKg, heightCm, age: ageNum }));
    const tdee = Math.round(bmr * activityFactor(exercise_level));

    const maintainCalories = tdee;
    const loseCalories = Math.max(1200, tdee - 500);
    const gainCalories = tdee + 300;

    const baseline = {
      inputs: {
        age: ageNum,
        gender,
        height_cm: heightCm,
        weight_kg: weightKg,
        exercise_level,
      },
      bmr,
      tdee,
      targets: {
        lose: buildMacros({ calories: loseCalories, weightKg, protein_g_per_kg: 2.0, fat_pct: 0.25 }),
        maintain: buildMacros({ calories: maintainCalories, weightKg, protein_g_per_kg: 1.8, fat_pct: 0.27 }),
        gain: buildMacros({ calories: gainCalories, weightKg, protein_g_per_kg: 1.8, fat_pct: 0.22 }),
      },
    };

    const aiResponse = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      text: { format: { type: "json_object" } },
      input: [
        {
          role: "system",
          content:
            "You are a nutrition calculator auditor.\n\n" +
            "Your job is to VERIFY the baseline targets. Do NOT change any numbers if they are within the hard rules.\n\n" +
            "Hard rules:\n" +
            "- Protein must be 1.2–2.4 g/kg/day\n" +
            "- Fat must be 20–35% of calories\n" +
            "- Loss calories should be 10–25% below TDEE\n" +
            "- Gain calories should be 5–15% above TDEE\n" +
            "- Carbs are the remainder\n\n" +
            "Output rules:\n" +
            '- If all targets pass hard rules, set status="verified" and final MUST equal baseline exactly.\n' +
            '- If targets pass hard rules but you have optional improvements, set status="verified_with_suggestions", final MUST equal baseline exactly, and list suggestions in suggestions[].\n' +
            '- Only if baseline violates hard rules, set status="adjusted" and modify final minimally to comply.\n' +
            "Return JSON only.",
        },
        {
          role: "user",
          content: `Inputs:
${JSON.stringify(baseline.inputs)}

Baseline calculation (from code):
${JSON.stringify(baseline, null, 2)}

Return JSON ONLY with this shape:
{
  "status": "verified" | "verified_with_suggestions" | "adjusted",
  "confidence": number,
  "issues": string[],
  "suggestions": string[],
  "final": {
    "bmr": number,
    "tdee": number,
    "targets": {
      "lose": { "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number },
      "maintain": { "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number },
      "gain": { "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number }
    }
  },
  "explanation": string
}`,
        },
      ],
    });

    let ai = safeJsonParse(aiResponse.output_text) || {};

    ai.status = normalizeStatus(ai.status);
    ai.confidence = clampNumber(ai.confidence, 0, 1) ?? 0.75;
    ai.issues = Array.isArray(ai.issues) ? ai.issues : [];
    ai.suggestions = Array.isArray(ai.suggestions) ? ai.suggestions : [];

    const baselineFinal = {
      bmr: baseline.bmr,
      tdee: baseline.tdee,
      targets: {
        lose: baseline.targets.lose,
        maintain: baseline.targets.maintain,
        gain: baseline.targets.gain,
      },
    };

    if (ai.status === "verified" || ai.status === "verified_with_suggestions") {
      ai.final = baselineFinal;
    } else {
      if (!ai.final || !ai.final.targets) ai.final = baselineFinal;
    }

    return res.json({ mode: "verified_by_ai", baseline, ai });
  } catch (err) {
    console.error("Macro targets error:", err?.response?.data || err.message || err);
    return res.status(500).json({ error: "Failed to calculate macro targets" });
  }
});

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setInterval(() => {
    axios.get(`http://localhost:${PORT}/health`).catch(() => {});
  }, 5 * 60 * 1000);
});
