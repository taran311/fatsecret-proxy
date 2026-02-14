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

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);

      if (
        origin === "https://thecaloriecard.com" ||
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1")
      ) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
  })
);

// -------------------- Clients --------------------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const FATSECRET_API_URL =
  "https://platform.fatsecret.com/rest/server.api";

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const cache = new NodeCache({ stdTTL: 300 });

let accessToken = null;
let tokenExpirationTime = 0;


// -------------------- Token --------------------

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
          "application/x-www-form-urlencoded",
      },
    }
  );

  accessToken = res.data.access_token;
  tokenExpirationTime =
    Date.now() + res.data.expires_in * 1000;
}

async function ensureFatSecretToken(
  req,
  res,
  next
) {
  if (
    !accessToken ||
    Date.now() >= tokenExpirationTime
  ) {
    await getAccessToken();
  }
  next();
}


// -------------------- Helpers --------------------

function extractExplicitGrams(text) {
  const m = String(text).match(
    /(\d+(?:\.\d+)?)\s*g\b/i
  );
  return m ? Number(m[1]) : null;
}

function extractExplicitMl(text) {
  const m = String(text).match(
    /(\d+(?:\.\d+)?)\s*ml\b/i
  );
  return m ? Number(m[1]) : null;
}

function extractPerGrams(desc) {
  const m = String(desc).match(
    /\bPer\s+(\d+(?:\.\d+)?)\s*g\b/i
  );
  return m ? Number(m[1]) : null;
}

function extractPerMl(desc) {
  const m = String(desc).match(
    /\bPer\s+(\d+(?:\.\d+)?)\s*ml\b/i
  );
  return m ? Number(m[1]) : null;
}

function extractPerFlOz(desc) {
  const m = String(desc).match(
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

  const cal = desc.match(
    /Calories:\s*(\d+(?:\.\d+)?)/i
  );
  const fat = desc.match(
    /Fat:\s*(\d+(?:\.\d+)?)/i
  );
  const carbs = desc.match(
    /Carbs:\s*(\d+(?:\.\d+)?)/i
  );
  const protein = desc.match(
    /Protein:\s*(\d+(?:\.\d+)?)/i
  );

  if (!cal) return null;

  return {
    calories: Number(cal[1]),
    fat: fat ? Number(fat[1]) : 0,
    carbs: carbs ? Number(carbs[1]) : 0,
    protein: protein
      ? Number(protein[1])
      : 0,
  };
}


// -------------------- Candidate builder --------------------

function buildCandidates(fsData) {
  const foods =
    fsData?.foods?.food || [];

  return foods
    .map((f) => {
      const desc =
        f.food_description || "";

      const perGrams =
        extractPerGrams(desc);

      const perMl =
        extractPerMl(desc) ??
        extractPerFlOz(desc);

      const nutrition =
        parseNutrition(desc);

      return {
        id: f.food_id,
        name: f.food_name,
        brand: f.brand_name,
        description: desc,
        nutrition,
        per_grams: perGrams,
        per_ml: perMl,
      };
    })
    .filter((c) => c.nutrition);
}


// -------------------- Scaling --------------------

function scaleCandidate(
  candidate,
  grams,
  ml
) {
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
    calories: Math.round(
      base.calories * factor
    ),
    protein: +(
      base.protein * factor
    ).toFixed(1),
    carbs: +(
      base.carbs * factor
    ).toFixed(1),
    fat: +(
      base.fat * factor
    ).toFixed(1),
    factor,
  };
}


// -------------------- Mismatch detection --------------------

function isMismatch(
  candidate,
  grams,
  ml
) {
  if (
    grams &&
    !candidate.per_grams &&
    looksPerServingUnit(
      candidate.description
    )
  ) {
    return true;
  }

  if (
    ml &&
    !candidate.per_ml &&
    looksPerServingUnit(
      candidate.description
    )
  ) {
    return true;
  }

  return false;
}


// -------------------- AI fallback --------------------

async function aiFallback(
  food,
  grams,
  ml
) {
  const response =
    await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      text: {
        format: {
          type: "json_object",
        },
      },
      input: [
        {
          role: "system",
          content:
            "Return nutrition estimate JSON.",
        },
        {
          role: "user",
          content: food,
        },
      ],
    });

  const data =
    JSON.parse(
      response.output_text
    );

  if (grams) {
    const factor =
      grams / 100;

    return {
      source: "ai",
      mode: "weight",
      name: data.name,
      grams,
      calories: Math.round(
        data.calories_per_100g *
        factor
      ),
      protein: +(
        data.protein_per_100g *
        factor
      ).toFixed(1),
      carbs: +(
        data.carbs_per_100g *
        factor
      ).toFixed(1),
      fat: +(
        data.fat_per_100g *
        factor
      ).toFixed(1),
      confidence:
        data.confidence ||
        0.9,
    };
  }

  return {
    source: "ai",
    ...data,
  };
}


// -------------------- Hybrid resolve --------------------

app.post(
  "/food/resolve",
  ensureFatSecretToken,
  async (req, res) => {
    try {
      const { food, debug } =
        req.body;

      const grams =
        extractExplicitGrams(
          food
        );

      const ml =
        extractExplicitMl(food);

      const fsRes =
        await axios.get(
          FATSECRET_API_URL,
          {
            params: {
              method:
                "foods.search",
              search_expression:
                food,
              max_results: 12,
              format: "json",
            },
            headers: {
              Authorization:
                `Bearer ${accessToken}`,
            },
          }
        );

      const candidates =
        buildCandidates(
          fsRes.data
        );

      for (const candidate of candidates) {
        if (
          isMismatch(
            candidate,
            grams,
            ml
          )
        )
          continue;

        const scaled =
          scaleCandidate(
            candidate,
            grams,
            ml
          );

        return res.json({
          source:
            "fatsecret",
          name:
            candidate.name,
          grams,
          ml,
          ...scaled,
          confidence: 0.9,
          debug:
            debug && {
              candidate:
                candidate.name,
              factor:
                scaled.factor,
            },
        });
      }

      const fallback =
        await aiFallback(
          food,
          grams,
          ml
        );

      res.json(fallback);
    } catch (err) {
      console.error(err);
      res
        .status(500)
        .json({
          error:
            "resolve failed",
        });
    }
  }
);


// -------------------- Health --------------------

app.get(
  "/health",
  (req, res) =>
    res.send("OK")
);


// -------------------- Start --------------------

const PORT =
  process.env.PORT ||
  3000;

app.listen(PORT, () => {
  console.log(
    "Server running on port",
    PORT
  );
});
