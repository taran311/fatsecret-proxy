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

// Enable CORS
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow production domain
      if (origin === "https://thecaloriecard.com") {
        return callback(null, true);
      }
      // Allow all localhost connections
      if (
        !origin ||
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:")
      ) {
        return callback(null, true);
      }
      // Deny all other origins
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

const FATSECRET_API_URL = "https://platform.fatsecret.com/rest/server.api";
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// Cache for storing API responses
const cache = new NodeCache({ stdTTL: 300 }); // Cache duration: 5 minutes

let accessToken = null;
let tokenExpirationTime = null; // Track token expiration

// OpenAI client (Render will inject env vars; locally you can use .env)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Function to fetch a new FatSecret access token
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
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    accessToken = response.data.access_token;
    tokenExpirationTime = Date.now() + response.data.expires_in * 1000;
    console.log("Access token fetched successfully");
  } catch (err) {
    console.error("Error fetching access token:", err.response?.data || err.message);
    throw new Error("Failed to fetch access token");
  }
};

// Middleware to ensure a valid FatSecret access token (only for FatSecret routes)
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

// Endpoint for health check
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/**
 * FatSecret: foods.search proxy
 * GET /foods/search/v1?search_expression=...&max_results=...&format=json
 */
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
    res.json(response.data);
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
        return res
          .status(500)
          .json({ error: "Failed to retry request after refreshing token" });
      }
    }

    res
      .status(err.response?.status || 500)
      .json(err.response?.data || { error: "Internal Server Error" });
  }
});

/**
 * Utility: extract grams from the user's free-text input.
 * Supports: "400g", "400 g", "400 gram", "400 grams"
 */
function extractGrams(foodText) {
  const match = foodText.match(/(\d+(?:\.\d+)?)\s*(g|gram|grams)\b/i);
  if (!match) return null;
  const grams = Number(match[1]);
  return Number.isFinite(grams) ? grams : null;
}

/**
 * GPT nutrition estimation
 *
 * IMPORTANT: We force the model to return PER-100g values only.
 * If the user includes grams (e.g. "400g tofu"), we compute totals in code,
 * preventing inconsistencies like 100g vs 400g giving different per-100g bases.
 */
app.post("/estimate", async (req, res) => {
  try {
    const { food } = req.body;

    if (!food || typeof food !== "string") {
      return res.status(400).json({ error: "food is required" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    }

    const grams = extractGrams(food);

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "You are a nutrition estimation system. Return ONLY valid JSON. Always return values strictly PER 100g for the described food. Do NOT scale totals to any quantity mentioned.",
        },
        {
          role: "user",
          content: `Food description: "${food}"

Return JSON only in this exact shape:
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
      text: { format: { type: "json_object" } },
      temperature: 0.2,
    });

    const per100g = JSON.parse(response.output_text);

    // Compute totals if grams provided
    let totals = {};
    if (grams !== null) {
      const factor = grams / 100;

      // calories as integer, macros to 1dp (you can change if you prefer)
      totals = {
        grams,
        calories: Math.round(Number(per100g.calories_per_100g) * factor),
        protein: Number((Number(per100g.protein_per_100g) * factor).toFixed(1)),
        carbs: Number((Number(per100g.carbs_per_100g) * factor).toFixed(1)),
        fat: Number((Number(per100g.fat_per_100g) * factor).toFixed(1)),
      };
    }

    return res.json({
      ...per100g,
      ...totals,
    });
  } catch (err) {
    console.error("Estimate error:", err?.response?.data || err.message || err);
    res.status(500).json({ error: "Estimate failed" });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Keep-alive pings (optional; not needed on paid Render but harmless)
  setInterval(() => {
    console.log("Sending keep-alive ping to /health");
    axios
      .get(`http://localhost:${PORT}/health`)
      .then(() => console.log("Keep-alive ping successful"))
      .catch((err) => console.error("Keep-alive ping failed:", err.message));
  }, 5 * 60 * 1000);
});
