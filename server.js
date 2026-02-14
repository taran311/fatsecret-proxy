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
app.use(compression()); // Compress responses

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

// Cache resolve results for faster UX
const cache = new NodeCache({ stdTTL: 600 }); // 10 minutes

// Minimum confidence required to trust FatSecret match.
// If the match confidence is below this, we fallback to AI estimate.
const FATSECRET_MIN_CONFIDENCE = 0.65;

let accessToken = null;
let tokenExpirationTime = null;

const getAccessToken = async () => {
  try {
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
  } catch (err) {
    console.error("Error fetching access token:", err.response?.data || err.message);
    throw new Error("Failed to fetch access token");
  }
};

const ensureFatSecretToken = async (req, res, next) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: "FatSecret CLIENT_ID/CLIENT_SECRET missing" });
  }

  if (!accessToken || Date.now() >= tokenExpirationTime) {
    try {
      await getAccessToken();
    } catch (err) {
      console.error("Failed to refresh access token:", err.message);
      return res.status(500).json({ error: "Failed to fetch access token" });
    }
  }
  next();
};

// -------------------- Health --------------------
app.get("/health", (req, res) => res.status(200).send("OK"));

// -------------------- Small helpers --------------------
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

// ---- Explicit quantity parsing from user input ----

// Only triggers if the user explicitly typed g/gram/grams
function extractExplicitGrams(foodText) {
  const match = String(foodText).match(/(\d+(?:\.\d+)?)\s*(g|gram|grams)\b/i);
  if (!match) return null;
  const grams = Number(match[1]);
  return Number.isFinite(grams) ? grams : null;
}

// Parses explicit ml/L in user input.
// Supports: "330ml", "330 ml", "0.5l", "1L"
function extractExplicitMl(foodText) {
  const t = String(foodText);

  // ml
  let m = t.match(/(\d+(?:\.\d+)?)\s*ml\b/i);
  if (m) {
    const ml = Number(m[1]);
    return Number.isFinite(ml) && ml > 0 ? ml : null;
  }

  // liters
  m = t.match(/(\d+(?:\.\d+)?)\s*l\b/i);
  if (m) {
    const l = Number(m[1]);
    const ml = l * 1000;
    return Number.isFinite(ml) && ml > 0 ? ml : null;
  }

  return null;
}

// ---- Extract scaling bases from FatSecret descriptions ----
// Examples:
// "Per 100g - ..."
// "Per 1152g - ..."
// "Per 100ml - ..."
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

// Detect “composite” multi-item inputs (e.g. "2 eggs and toast with butter").
// For composites, it's better UX to go straight to AI rather than forcing a single DB match.
function looksComposite(text) {
  const t = String(text || "").toLowerCase();

  // common separators indicating multiple foods
  if (t.includes(" and ") || t.includes(",") || t.includes(" + ")) return true;

  // If it has 2+ explicit quantity patterns, treat as composite
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
    return {
      food_id: f.food_id,
      name: f.food_name,
      brand: f.brand_name || null,
      description,
      per_grams: extractPerGramsFromDescription(description),
      per_ml: extractPerMlFromDescription(description),
      type: f.food_type || null,
      url: f.food_url || null,
    };
  });
}

// -------------------- Internal AI estimate (fallback + quick add) --------------------
async function estimateWithGPT(food) {
  const grams = extractExplicitGrams(food);
  const isWeightBased = grams !== null;

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

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
      calories: Math.round(Number(per100g.calories_per_100g) * factor),
      protein: Number((Number(per100g.protein_per_100g) * factor).toFixed(1)),
      carbs: Number((Number(per100g.carbs_per_100g) * factor).toFixed(1)),
      fat: Number((Number(per100g.fat_per_100g) * factor).toFixed(1)),
      confidence: clamp01(per100g.confidence, 0.75),
      calories_per_100g: Number(per100g.calories_per_100g),
      protein_per_100g: Number(per100g.protein_per_100g),
      carbs_per_100g: Number(per100g.carbs_per_100g),
      fat_per_100g: Number(per100g.fat_per_100g),
    };
  }

  // Composite-friendly serving estimator
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
    serving_description: out.serving_description,
    calories: Math.round(Number(out.calories) || 0),
    protein: Number((Number(out.protein) || 0).toFixed(1)),
    carbs: Number((Number(out.carbs) || 0).toFixed(1)),
    fat: Number((Number(out.fat) || 0).toFixed(1)),
    confidence: clamp01(out.confidence, 0.7),
  };
}

// -------------------- SINGLE ENDPOINT: Hybrid resolve --------------------
app.post("/food/resolve", ensureFatSecretToken, async (req, res) => {
  try {
    const { food, max_results, debug } = req.body || {};

    if (!food || typeof food !== "string") {
      return res.status(400).json({ error: "food is required" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    }

    const grams = extractExplicitGrams(food);
    const ml = extractExplicitMl(food);
    const fsMax = Number.isFinite(Number(max_results)) ? Number(max_results) : 12;

    const cacheKey = `resolve:${food}:${fsMax}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Composite inputs go straight to AI
    if (looksComposite(food)) {
      const fallback = await estimateWithGPT(food);
      if (debug) fallback.debug = { fallback_reason: "composite_input_detected" };
      cache.set(cacheKey, fallback);
      return res.json(fallback);
    }

    // 1) FatSecret search
    let fsData = null;
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
      console.error("FatSecret search failed, falling back:", err?.response?.data || err.message);
      const fallback = await estimateWithGPT(food);
      cache.set(cacheKey, fallback);
      return res.json(fallback);
    }

    const candidates = buildFatSecretCandidates(fsData);

    // If no candidates -> AI fallback
    if (!candidates.length) {
      const fallback = await estimateWithGPT(food);
      cache.set(cacheKey, fallback);
      return res.json(fallback);
    }

    // 2) AI selection layer (now supports Per {N}g and Per {N}ml)
    const selector = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0.1,
      text: { format: { type: "json_object" } },
      input: [
        {
          role: "system",
          content:
            "Return ONLY valid JSON.\n\n" +
            "Task:\n" +
            "- Choose the SINGLE best FatSecret candidate for the user's input.\n" +
            "- Use brand/name/description to match.\n" +
            "- If none are suitable, set use_fallback=true.\n\n" +
            "IMPORTANT disambiguation rules:\n" +
            "- If the user query implies a coffee shop drink size (small/medium/large) like 'Costa latte medium', prefer in-store drink entries.\n" +
            "- Avoid at-home pod/capsule products (Tassimo, Nespresso, Dolce Gusto, K-Cup, pods/capsules) UNLESS the user explicitly mentions them.\n" +
            "- Avoid 'baked', 'diet', 'zero', 'light', 'low fat' variants unless the user explicitly mentioned those words.\n\n" +
            "Candidate fields:\n" +
            "- candidate.per_grams is present if description contains 'Per {N}g'.\n" +
            "- candidate.per_ml is present if description contains 'Per {N}ml'.\n\n" +
            "SCALING RULES (IMPORTANT):\n" +
            "- If user provided explicit grams AND candidate.per_grams is present, scale by factor = grams / per_grams and set mode='weight'.\n" +
            "- If user provided explicit ml AND candidate.per_ml is present, scale by factor = ml / per_ml and set mode='volume'.\n" +
            "- If description is per serving/bar/slice/pack/mug (no per_grams/per_ml), DO NOT scale; set mode='serving'.\n\n" +
            "Fallback rule:\n" +
            "- If you cannot reliably extract calories and at least 2 macros from description, set use_fallback=true.\n\n" +
            "Output must match the schema exactly. confidence is 0..1.",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              user_input: food,
              explicit_grams: grams,
              explicit_ml: ml,
              candidates,
              schema: {
                use_fallback: "boolean",
                chosen_index: "number | null",
                name: "string",
                mode: '"weight" | "volume" | "serving"',
                grams: "number | null",
                ml: "number | null",
                calories: "number",
                protein: "number",
                carbs: "number",
                fat: "number",
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

    const pick = safeJsonParse(selector.output_text);
    const modelConfidence = clamp01(pick?.confidence, 0);

    // Minimum confidence threshold fallback
    if (
      !pick ||
      pick.use_fallback ||
      pick.chosen_index === null ||
      modelConfidence < FATSECRET_MIN_CONFIDENCE
    ) {
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

    const chosen = candidates[pick.chosen_index];
    if (!chosen) {
      const fallback = await estimateWithGPT(food);
      cache.set(cacheKey, fallback);
      return res.json(fallback);
    }

    const result = {
      source: "fatsecret",
      mode: pick.mode || (grams ? "weight" : ml ? "volume" : "serving"),
      name: pick.name || chosen.name,
      grams: pick.grams ?? grams ?? null,
      ml: pick.ml ?? ml ?? null,
      calories: Math.round(Number(pick.calories) || 0),
      protein: Number((Number(pick.protein) || 0).toFixed(1)),
      carbs: Number((Number(pick.carbs) || 0).toFixed(1)),
      fat: Number((Number(pick.fat) || 0).toFixed(1)),
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
        reason: pick.reason,
        candidate_count: candidates.length,
        threshold: FATSECRET_MIN_CONFIDENCE,
        explicit_grams: grams,
        explicit_ml: ml,
      };
    }

    cache.set(cacheKey, result);
    return res.json(result);
  } catch (err) {
    console.error("Resolve error:", err?.response?.data || err.message || err);

    // last-resort fallback if possible
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
  if (
    key === "10 hour+ per week" ||
    key === "10 hours+ per week" ||
    key === "10+ hours per week"
  )
    return 1.9;

  return 1.2;
}

function bmrMifflin({ gender, weightKg, heightCm, age }) {
  const g = String(gender || "").trim().toLowerCase();
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  if (g === "male" || g === "m") return base + 5;
  if (g === "female" || g === "f") return base - 161;
  return base - 78; // neutral-ish fallback
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

    // ---- Baseline calculation (code) ----
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
        lose: buildMacros({
          calories: loseCalories,
          weightKg,
          protein_g_per_kg: 2.0,
          fat_pct: 0.25,
        }),
        maintain: buildMacros({
          calories: maintainCalories,
          weightKg,
          protein_g_per_kg: 1.8,
          fat_pct: 0.27,
        }),
        gain: buildMacros({
          calories: gainCalories,
          weightKg,
          protein_g_per_kg: 1.8,
          fat_pct: 0.22,
        }),
      },
    };

    // ---- AI verification ----
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

    return res.json({
      mode: "verified_by_ai",
      baseline,
      ai,
    });
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
