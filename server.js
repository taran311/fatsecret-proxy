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

const cache = new NodeCache({ stdTTL: 300 }); // 5 minutes

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

// -------------------- FatSecret foods.search --------------------
app.get("/foods/search/v1", ensureFatSecretToken, async (req, res) => {
  const { search_expression, max_results, format } = req.query;
  const cacheKey = `${search_expression}-${max_results}-${format}`;

  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    console.log("Serving data from cache:", cacheKey);
    return res.json(cachedData);
  }

  try {
    const response = await axios.get(FATSECRET_API_URL, {
      params: {
        method: "foods.search",
        search_expression,
        max_results,
        format,
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    cache.set(cacheKey, response.data);
    return res.json(response.data);
  } catch (err) {
    console.error("Error forwarding request:", err.response?.data || err.message);

    if (err.response?.status === 401) {
      console.log("Access token expired. Refreshing...");
      try {
        await getAccessToken();
        const retryResponse = await axios.get(FATSECRET_API_URL, {
          params: {
            method: "foods.search",
            search_expression,
            max_results,
            format,
          },
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        });

        cache.set(cacheKey, retryResponse.data);
        return res.json(retryResponse.data);
      } catch (retryError) {
        console.error("Failed after refreshing token:", retryError.message);
        return res.status(500).json({
          error: "Failed to retry request after refreshing token",
        });
      }
    }

    return res
      .status(err.response?.status || 500)
      .json(err.response?.data || { error: "Internal Server Error" });
  }
});

// -------------------- Estimate helpers --------------------
function extractExplicitGrams(foodText) {
  // Only triggers if the user explicitly typed g/gram/grams
  const match = String(foodText).match(/(\d+(?:\.\d+)?)\s*(g|gram|grams)\b/i);
  if (!match) return null;
  const grams = Number(match[1]);
  return Number.isFinite(grams) ? grams : null;
}

// -------------------- GPT: /estimate --------------------
app.post("/estimate", async (req, res) => {
  try {
    const { food } = req.body;

    if (!food || typeof food !== "string") {
      return res.status(400).json({ error: "food is required" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    }

    const grams = extractExplicitGrams(food);
    const isWeightBased = grams !== null;

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

      const per100g = JSON.parse(response.output_text);
      const factor = grams / 100;

      return res.json({
        mode: "weight",
        ...per100g,
        grams,
        calories: Math.round(Number(per100g.calories_per_100g) * factor),
        protein: Number((Number(per100g.protein_per_100g) * factor).toFixed(1)),
        carbs: Number((Number(per100g.carbs_per_100g) * factor).toFixed(1)),
        fat: Number((Number(per100g.fat_per_100g) * factor).toFixed(1)),
      });
    }

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      text: { format: { type: "json_object" } },
      input: [
        {
          role: "system",
          content:
            "Return ONLY valid JSON. If the user specifies a portion (e.g. 1 slice, 1 tbsp, 1 cup), estimate nutrition for that portion. If no portion is specified, assume a typical single serving. Be realistic for UK portions.",
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

    return res.json({
      mode: "serving",
      ...JSON.parse(response.output_text),
    });
  } catch (err) {
    console.error("Estimate error:", err?.response?.data || err.message || err);
    return res.status(500).json({ error: "Estimate failed" });
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

    // ---- AI verification (should NOT change numbers unless rules violated) ----
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

    let ai = JSON.parse(aiResponse.output_text);

    // ---- Normalize / enforce rules in code (so UI stays consistent) ----
    ai.status = normalizeStatus(ai.status);
    ai.confidence = clampNumber(ai.confidence, 0, 1) ?? 0.75;
    ai.issues = Array.isArray(ai.issues) ? ai.issues : [];
    ai.suggestions = Array.isArray(ai.suggestions) ? ai.suggestions : [];

    // If status is verified* the final MUST be baseline (enforce regardless of model slip-ups)
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
      // adjusted: make sure ai.final exists; if not, fall back to baselineFinal
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

  // Optional keep-alive ping (harmless)
  setInterval(() => {
    axios.get(`http://localhost:${PORT}/health`).catch(() => {});
  }, 5 * 60 * 1000);
});
