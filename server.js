import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import cors from "cors";
import compression from "compression";
import NodeCache from "node-cache";
import OpenAI from "openai";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

// Function to fetch a new access token
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

// Middleware to ensure a valid access token (only for FatSecret routes)
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

// Endpoint for foods.search (FatSecret) — protected by token middleware
app.get("/foods/search/v1", ensureFatSecretToken, async (req, res) => {
  const { search_expression, max_results, format } = req.query;
  const cacheKey = `${search_expression}-${max_results}-${format}`;

  // Check if data is cached
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

    // Cache the response
    cache.set(cacheKey, response.data);
    res.json(response.data);
  } catch (err) {
    console.error("Error forwarding request:", err.response?.data || err.message);

    if (err.response?.status === 401) {
      // Retry on token expiration
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

// GPT estimate endpoint (does NOT need FatSecret token)
app.post("/estimate", async (req, res) => {
  try {
    const { food } = req.body;

    if (!food || typeof food !== "string") {
      return res.status(400).json({ error: "food is required" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    }

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: "You estimate nutrition for foods. Return only JSON.",
        },
        {
          role: "user",
          content: `Estimate calories and macros for: "${food}"

Return JSON:
{
  "name": string,
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "confidence": number
}`,
        },
      ],
      text: { format: { type: "json_object" } },
      temperature: 0.2,
    });

    res.json(JSON.parse(response.output_text));
  } catch (err) {
    console.error("Estimate error:", err?.response?.data || err.message || err);
    res.status(500).json({ error: "Estimate failed" });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Keep-alive pings (optional)
  setInterval(() => {
    console.log("Sending keep-alive ping to /health");
    axios
      .get(`http://localhost:${PORT}/health`)
      .then(() => console.log("Keep-alive ping successful"))
      .catch((err) => console.error("Keep-alive ping failed:", err.message));
  }, 5 * 60 * 1000); // Every 5 minutes
});
