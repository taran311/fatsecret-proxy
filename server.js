import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import cors from "cors";
import compression from "compression";
import OpenAI from "openai";

dotenv.config();

const app = express();

app.use(bodyParser.json());
app.use(compression());

app.use(cors({
  origin: true
}));

// -------------------- CONFIG --------------------

const FATSECRET_API_URL =
  "https://platform.fatsecret.com/rest/server.api";

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let accessToken = null;
let tokenExpirationTime = 0;


// -------------------- TOKEN --------------------

async function getAccessToken() {

  const res = await axios.post(
    "https://oauth.fatsecret.com/connect/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "basic",
    }),
    {
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      }
    }
  );

  accessToken = res.data.access_token;

  tokenExpirationTime =
    Date.now() + res.data.expires_in * 1000;
}


async function ensureFatSecretToken(req, res, next) {

  try {

    if (
      !accessToken ||
      Date.now() >= tokenExpirationTime
    ) {
      await getAccessToken();
    }

    next();

  }
  catch (err) {

    console.error("Token error:", err.message);

    res.status(500).json({
      error: "token failed"
    });
  }
}


// -------------------- HELPERS --------------------

function extractExplicitGrams(text) {

  const m =
    String(text).match(/(\d+(?:\.\d+)?)\s*g\b/i);

  return m ? Number(m[1]) : null;
}

function extractExplicitMl(text) {

  const m =
    String(text).match(/(\d+(?:\.\d+)?)\s*ml\b/i);

  return m ? Number(m[1]) : null;
}

function extractPerGrams(desc) {

  const m =
    String(desc).match(
      /\bPer\s+(\d+(?:\.\d+)?)\s*g\b/i
    );

  return m ? Number(m[1]) : null;
}

function extractPerMl(desc) {

  const m =
    String(desc).match(
      /\bPer\s+(\d+(?:\.\d+)?)\s*ml\b/i
    );

  return m ? Number(m[1]) : null;
}

function extractPerFlOz(desc) {

  const m =
    String(desc).match(
      /\bPer\s+(\d+(?:\.\d+)?)\s*fl\s*oz\b/i
    );

  if (!m) return null;

  return Number(m[1]) * 29.5735;
}

function looksPerServingUnit(desc) {

  if (!desc) return false;

  if (/\bPer\s+1\s+[A-Za-z]/i.test(desc))
    return true;

  if (/\bPer\s+serving\b/i.test(desc))
    return true;

  return false;
}


function parseNutrition(desc) {

  if (!desc) return null;

  const cal =
    desc.match(/Calories:\s*(\d+(?:\.\d+)?)/i);

  const fat =
    desc.match(/Fat:\s*(\d+(?:\.\d+)?)/i);

  const carbs =
    desc.match(/Carbs:\s*(\d+(?:\.\d+)?)/i);

  const protein =
    desc.match(/Protein:\s*(\d+(?:\.\d+)?)/i);

  if (!cal) return null;

  return {
    calories: Number(cal[1]),
    fat: fat ? Number(fat[1]) : 0,
    carbs: carbs ? Number(carbs[1]) : 0,
    protein: protein ? Number(protein[1]) : 0
  };
}


// -------------------- BUILD CANDIDATES --------------------

function buildCandidates(fsData) {

  const foods =
    fsData?.foods?.food || [];

  return foods
    .map(f => {

      const desc =
        f.food_description || "";

      return {
        name: f.food_name,
        brand: f.brand_name || null,
        description: desc,
        nutrition: parseNutrition(desc),
        per_grams: extractPerGrams(desc),
        per_ml:
          extractPerMl(desc) ??
          extractPerFlOz(desc)
      };
    })
    .filter(c => c.nutrition);
}


// -------------------- SCALE --------------------

function scaleCandidate(candidate, grams, ml) {

  const base =
    candidate.nutrition;

  let factor = 1;
  let mode = "serving";

  if (
    grams &&
    candidate.per_grams
  ) {
    factor =
      grams /
      candidate.per_grams;

    mode = "weight";
  }

  else if (
    ml &&
    candidate.per_ml
  ) {
    factor =
      ml /
      candidate.per_ml;

    mode = "volume";
  }

  return {
    mode,
    calories:
      Math.round(base.calories * factor),
    protein:
      +(base.protein * factor).toFixed(1),
    carbs:
      +(base.carbs * factor).toFixed(1),
    fat:
      +(base.fat * factor).toFixed(1),
    factor
  };
}


// -------------------- MISMATCH --------------------

function isMismatch(candidate, grams, ml) {

  if (
    grams &&
    !candidate.per_grams &&
    looksPerServingUnit(candidate.description)
  ) return true;

  if (
    ml &&
    !candidate.per_ml &&
    looksPerServingUnit(candidate.description)
  ) return true;

  return false;
}


// -------------------- AI SELECT --------------------

async function pickBestCandidateIndex(food, candidates) {

  try {

    const simplified =
      candidates.map((c, i) => ({
        index: i,
        name: c.name,
        brand: c.brand
      }));

    const res =
      await openai.responses.create({

        model: "gpt-4.1-mini",

        temperature: 0,

        text: {
          format: {
            type: "json_object"
          }
        },

        input: [
          {
            role: "user",
            content: JSON.stringify({
              query: food,
              candidates: simplified
            })
          }
        ]
      });

    const parsed =
      JSON.parse(res.output_text);

    if (
      typeof parsed.index === "number" &&
      parsed.index >= 0 &&
      parsed.index < candidates.length
    ) {
      return parsed.index;
    }

  }
  catch {}

  return -1;
}


// -------------------- AI FALLBACK --------------------

async function aiFallback(food) {

  const res =
    await openai.responses.create({

      model: "gpt-4.1-mini",

      temperature: 0.2,

      text: {
        format: {
          type: "json_object"
        }
      },

      input: [
        {
          role: "user",
          content: food
        }
      ]
    });

  return {
    source: "ai",
    ...JSON.parse(res.output_text)
  };
}


// -------------------- RESOLVE --------------------

app.post(
  "/food/resolve",
  ensureFatSecretToken,
  async (req, res) => {

    try {

      const { food, debug } =
        req.body;

      const grams =
        extractExplicitGrams(food);

      const ml =
        extractExplicitMl(food);

      const fsRes =
        await axios.get(
          FATSECRET_API_URL,
          {
            params: {
              method: "foods.search",
              search_expression: food,
              max_results: 12,
              format: "json"
            },
            headers: {
              Authorization:
                `Bearer ${accessToken}`
            }
          }
        );

      const candidates =
        buildCandidates(fsRes.data);

      if (!candidates.length)
        return res.json(
          await aiFallback(food)
        );

      let index =
        await pickBestCandidateIndex(
          food,
          candidates
        );

      let candidate =
        candidates[index] ||
        candidates[0];

      if (
        isMismatch(
          candidate,
          grams,
          ml
        )
      ) {
        return res.json(
          await aiFallback(food)
        );
      }

      const scaled =
        scaleCandidate(
          candidate,
          grams,
          ml
        );

      return res.json({
        source: "fatsecret",
        name: candidate.name,
        grams,
        ml,
        ...scaled,
        confidence: 0.9,
        debug:
          debug && {
            candidate:
              candidate.name,
            index,
            factor:
              scaled.factor
          }
      });

    }
    catch (err) {

      console.error(
        "Resolve error:",
        err.message
      );

      res.status(500).json({
        error: "resolve failed"
      });
    }
  }
);


// -------------------- START --------------------

app.listen(
  process.env.PORT || 3000,
  () =>
    console.log(
      "Server running"
    )
);
