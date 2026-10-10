import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import cors from "cors";
import compression from "compression";
import NodeCache from "node-cache";
import OpenAI from "openai";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import rateLimit from "express-rate-limit";
import { startReminders } from "./reminders.js";
import {
  registerBilling,
  useCoachMessage,
  refundCoachMessage,
  isPremium,
} from "./billing.js";

dotenv.config();

const app = express();
// Render sits behind a proxy; needed so rate limiting sees real client IPs.
app.set("trust proxy", 1);
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

// Body parsing comes after CORS, so even a "too large" error reaches the
// web app as a readable response. Small JSON bodies everywhere; meal photos
// (base64) get a bigger limit, parsed only after the user is signed in.
const smallJson = bodyParser.json({ limit: "20kb" });
const photoJson = bodyParser.json({ limit: "6mb" });
// Stripe's webhook needs the raw body (it's signed), so it skips this too.
app.use((req, res, next) =>
  req.path === "/food/photo" || req.path === "/billing/webhook"
    ? next()
    : smallJson(req, res, next)
);

// -------------------- Auth (Firebase ID tokens) --------------------
// Verifying ID tokens only needs the project ID (Google's public keys are
// fetched automatically). The evening reminders also read Firestore and
// send pushes, which needs a service account: put its JSON (or the JSON
// base64-encoded) in FIREBASE_SERVICE_ACCOUNT. Without it, reminders are off
// and everything else works as before.
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "auth-af04a";

function readServiceAccount(raw) {
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(text);
  } catch (err) {
    console.error("FIREBASE_SERVICE_ACCOUNT isn't valid JSON:", err.message);
    return null;
  }
}

const SERVICE_ACCOUNT = readServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp(
  SERVICE_ACCOUNT
    ? { credential: cert(SERVICE_ACCOUNT), projectId: FIREBASE_PROJECT_ID }
    : { projectId: FIREBASE_PROJECT_ID }
);

// Set REQUIRE_AUTH=false on Render only as a temporary escape hatch.
const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== "false";

async function requireFirebaseUser(req, res, next) {
  const header = req.get("Authorization") || "";
  const match = header.match(/^Bearer (.+)$/);

  if (!match) {
    if (!REQUIRE_AUTH) return next();
    return res.status(401).json({ error: "Missing auth token" });
  }

  try {
    const decoded = await getAuth().verifyIdToken(match[1]);
    req.user = { uid: decoded.uid, email: decoded.email || null };
    return next();
  } catch (err) {
    console.warn("Rejected auth token:", err.code || err.message);
    return res.status(401).json({ error: "Invalid or expired auth token" });
  }
}

// -------------------- Premium (Stripe) --------------------
registerBilling(app, { requireFirebaseUser, firestoreReady: !!SERVICE_ACCOUNT });

// Per-user limits (falls back to IP when auth is off). Keeps a leaked or
// abusive client from running up the OpenAI / FatSecret bill.
function userOrIpKey(req) {
  return req.user?.uid ? `uid:${req.user.uid}` : `ip:${req.ip}`;
}

const foodLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.FOOD_RATE_LIMIT_PER_MIN) || 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Too many requests, slow down a little." },
});

const macroLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.MACRO_RATE_LIMIT_PER_HOUR) || 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Too many requests, try again later." },
});

// -------------------- Clients --------------------
// The SDK's defaults (10 minute timeout, 2 retries) would leave someone
// staring at a spinner; fail fast and let the app show a retry instead.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: Number(process.env.OPENAI_TIMEOUT_MS) || 25000,
  maxRetries: 1,
});

// Models are settable on Render without a code change. The "pick" model
// only chooses between a few database matches, so a smaller/faster model
// works well there if you want to save time and money.
const AI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const AI_PICK_MODEL = process.env.OPENAI_PICK_MODEL || AI_MODEL;

// -------------------- FatSecret --------------------
const FATSECRET_API_URL = "https://platform.fatsecret.com/rest/server.api";
// FatSecret's Basic plan only has the US database. With a plan that includes
// the UK data, set FATSECRET_REGION=GB so UK brands are found.
const FATSECRET_REGION = (process.env.FATSECRET_REGION || "").trim().toUpperCase();
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// In-memory cache. Nutrition for "2 eggs" doesn't change, so successful
// lookups are kept for a week (until the server restarts); maxKeys stops it
// growing without limit on the small Render instance.
const cache = new NodeCache({ stdTTL: 300, maxKeys: 5000 });
const RESOLVE_TTL_SECONDS = 60 * 60 * 24 * 7;

// FatSecret calls get a timeout: without one a stuck request hangs forever.
const fatsecret = axios.create({ timeout: 10000 });

let accessToken = null;
let tokenExpirationTime = 0;
let tokenRefresh = null;

// Fetches a token, sharing one request between everyone who needs it at
// the same moment (instead of each request fetching its own).
function refreshAccessToken() {
  if (!tokenRefresh) {
    tokenRefresh = getAccessToken().finally(() => {
      tokenRefresh = null;
    });
  }
  return tokenRefresh;
}

async function getAccessToken() {
  const response = await fatsecret.post(
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
  // Refresh a minute early so a token never expires mid-request.
  tokenExpirationTime = Date.now() + (response.data.expires_in - 60) * 1000;
}

async function ensureFatSecretToken(req, res, next) {
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).json({ error: "CLIENT_ID/CLIENT_SECRET not set" });
    }
    if (!accessToken || Date.now() >= tokenExpirationTime) {
      await refreshAccessToken();
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

// ======================================================================
// ========================= HYBRID RESOLVE ENGINE =======================
// ======================================================================

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

const LABEL_WORDS = new Set(["calories", "kcal", "fat", "carbs", "protein", "per"]);

function tokenScore(query, candidate) {
  const qTokens = tokenize(query);
  const q = new Set(qTokens);
  if (!q.size) return 0;

  // The description is FatSecret's label text ("Per 1 bar - Calories: ... |
  // Protein: ..."), so words like "protein" or "fat" in it say nothing about
  // which food it is. Each query word counts once.
  const cTokens = new Set(
    tokenize(
      `${candidate.brand || ""} ${candidate.name || ""} ${candidate.description || ""}`
    ).filter((t) => !LABEL_WORDS.has(t))
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
    "chiquita",
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

function extractExplicitCount(text) {
  // e.g. "3 bell peppers", "2 bananas"
  // Only counts at the START, and only integers 1-20 to avoid weird cases.
  const m = String(text).trim().match(/^(\d{1,2})\s+([a-zA-Z])/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 && n <= 20 ? n : null;
}

function extractPerItemCount(desc) {
  // e.g. "Per 1 medium pepper - ..." should return 1
  // Avoid measurement units like tbsp/tsp/cup/g/ml/oz/etc.
  const d = String(desc || "").toLowerCase();
  const m = d.match(/\bper\s+(\d{1,2})\s+([a-z]+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = String(m[2] || "").toLowerCase();

  const measurementUnits = new Set([
    "g","gram","grams","kg","ml","l","litre","liter","oz","fl","floz",
    "tbsp","tablespoon","tsp","teaspoon","cup","cups","serving","portion",
    "pack","bag","bottle","can","slice","slices"
  ]);

  if (!Number.isFinite(n) || n <= 0) return null;
  if (measurementUnits.has(unit)) return null;

  return n;
}

function extractPerGrams(desc) {
  const d = String(desc || "");
  // Matches: "Per 100g" / "Per 1152g"
  let m = d.match(/\bPer\s+(\d+(?:\.\d+)?)\s*g\b/i);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  // Matches: "Per 1 serving (100g)"
  m = d.match(/\((\d+(?:\.\d+)?)\s*g\)/i);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function extractPerMl(desc) {
  const d = String(desc || "");
  // Matches: "Per 100ml" / "Per 250 ml"
  let m = d.match(/\bPer\s+(\d+(?:\.\d+)?)\s*ml\b/i);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  // Matches: "Per 1 serving (250ml)"
  m = d.match(/\((\d+(?:\.\d+)?)\s*ml\)/i);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
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
        per_item_count: extractPerItemCount(desc),
      };
    })
    .filter((c) => c.nutrition);
}

// -------------------- Deterministic scaling for DB candidate --------------------
function scaleCandidate(candidate, grams, ml, count) {
  const base = candidate.nutrition;
  let factor = 1;
  let mode = "serving";

  if (grams && candidate.per_grams) {
    factor = grams / candidate.per_grams;
    mode = "weight";
  } else if (ml && candidate.per_ml) {
    factor = ml / candidate.per_ml;
    mode = "volume";
  } else if (!grams && !ml && count && candidate.per_item_count) {
    factor = count / candidate.per_item_count;
    mode = "serving";
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
    // snack pack exception (crisps etc): "per pack" is acceptable even without per_grams
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
  if (!process.env.OPENAI_API_KEY) return aiFailure(food);

  const grams = extractExplicitGrams(food);
  const explicitMl = extractExplicitMl(food);

  // Weight-based: return per-100g, then scale in code
  if (grams) {
    const response = await openai.responses.create({
      model: AI_MODEL,
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
  "brand": string | null,
  "confidence": number
}
"brand" is the brand or chain if the description names one (e.g. "Yubi", "Greggs", "Tesco"), otherwise null.`,
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
      confidence: Number.isFinite(Number(per100g.confidence))
        ? Number(per100g.confidence)
        : 0.7,
      brand: cleanBrand(per100g.brand),
      calories_per_100g: Number(per100g.calories_per_100g),
      protein_per_100g: Number(per100g.protein_per_100g),
      carbs_per_100g: Number(per100g.carbs_per_100g),
      fat_per_100g: Number(per100g.fat_per_100g),
    };
  }

  // Serving/volume-based
  const response = await openai.responses.create({
    model: AI_MODEL,
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
  "brand": string | null,
  "confidence": number
}
"brand" is the brand or chain if the description names one (e.g. "Yubi", "Greggs", "Tesco"), otherwise null.`,
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
    brand: cleanBrand(j.brand),
  };
}

function cleanBrand(b) {
  const s = typeof b === "string" ? b.trim() : "";
  return s && !/^(null|none|n\/a|generic|homemade)$/i.test(s) ? s : null;
}

// -------------------- AI + web: branded products --------------------
// FatSecret doesn't have every brand (and its free plan is US-only), and the
// model can't know every product's label. For a named brand the database
// didn't have, look the label up online. Off with WEB_LOOKUP=off.
const WEB_LOOKUP = process.env.WEB_LOOKUP !== "off";
const WEB_MODEL = process.env.OPENAI_WEB_MODEL || "gpt-4.1-mini";

async function webLookup(food, grams, ml) {
  const response = await openai.responses.create({
    model: WEB_MODEL,
    temperature: 0,
    tools: [{ type: "web_search", user_location: { type: "approximate", country: "GB" } }],
    input: [
      {
        role: "system",
        content:
          "You find the official nutrition label for a branded food or drink sold in the UK. " +
          "Search the web, prefer the brand's own site, a UK supermarket listing or a nutrition database " +
          "entry for that exact product. If no flavour is given, use the brand's standard or most common one. " +
          "Reply with ONLY a JSON object, no other text:\n" +
          '{"found": boolean, "name": string, "serving_description": string, "serving_grams": number|null, ' +
          '"serving_ml": number|null, "calories": number, "protein": number, "carbs": number, "fat": number, ' +
          '"calories_per_100g": number|null, "protein_per_100g": number|null, "carbs_per_100g": number|null, ' +
          '"fat_per_100g": number|null}\n' +
          "calories/protein/carbs/fat are for ONE serving as sold (one bar, one pack, one bottle). " +
          'If you can\'t find this product\'s label, reply {"found": false}.',
      },
      { role: "user", content: food },
    ],
  });

  const text = String(response.output_text || "");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]);
  if (!j?.found || !(Number(j.calories) > 0)) return null;

  // "70g of X": scale from per-100g when the label gives it.
  const per100 = Number(j.calories_per_100g);
  if (grams && per100 > 0) {
    const f = grams / 100;
    return {
      source: "web",
      mode: "weight",
      name: j.name || food,
      grams,
      ml: null,
      calories: Math.round(per100 * f),
      protein: round1((Number(j.protein_per_100g) || 0) * f),
      carbs: round1((Number(j.carbs_per_100g) || 0) * f),
      fat: round1((Number(j.fat_per_100g) || 0) * f),
      confidence: 0.85,
    };
  }

  const count = !grams && !ml ? extractExplicitCount(food) : null;
  const k = count && count > 1 ? count : 1;
  return {
    source: "web",
    mode: "serving",
    name: j.name || food,
    grams: toPositiveNumberOrNull(j.serving_grams) ? toPositiveNumberOrNull(j.serving_grams) * k : null,
    ml: toPositiveNumberOrNull(j.serving_ml) ? toPositiveNumberOrNull(j.serving_ml) * k : null,
    serving_description: j.serving_description,
    calories: Math.round(Number(j.calories) * k),
    protein: round1((Number(j.protein) || 0) * k),
    carbs: round1((Number(j.carbs) || 0) * k),
    fat: round1((Number(j.fat) || 0) * k),
    confidence: 0.85,
  };
}

/** The AI estimate, or for a named brand the database missed, its real label. */
async function aiOrWebResult(food, aiResultPromise, grams, ml) {
  const ai = await aiResultPromise;
  if (!WEB_LOOKUP || ai.failed || !ai.brand || !process.env.OPENAI_API_KEY) return ai;
  try {
    const web = await webLookup(food, grams, ml);
    return web || ai;
  } catch (err) {
    console.error("Web lookup failed:", err.response?.data || err.message || err);
    return ai;
  }
}

// -------------------- AI: choose best DB candidate among top-N --------------------
async function pickBestCandidateIndex(query, candidates) {
  if (!process.env.OPENAI_API_KEY) return { index: -1, confidence: 0, failed: true };

  const simplified = candidates.map((c, i) => ({
    index: i,
    name: c.name,
    brand: c.brand,
    description: c.description,
  }));

  const resp = await openai.responses.create({
    model: AI_PICK_MODEL,
    temperature: 0,
    text: { format: { type: "json_object" } },
    input: [
      {
        role: "system",
        content:
          'Pick the single best matching candidate index for the query.\nReturn ONLY JSON: {"index": number, "confidence": number}\nDo NOT pick unrelated foods.\nPrefer exact brand/name matches.\nIf the query names a brand and no candidate is that brand, return {"index": -1, "confidence": 0}.\nIf the query names a brand but not a flavour, any flavour of that brand is a good match.\n',
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
  const cacheKey = `fs:${FATSECRET_REGION}:${normalizeFood(search_expression)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const search = () =>
    fatsecret.get(FATSECRET_API_URL, {
      params: {
        method: "foods.search",
        search_expression,
        max_results: MAX_RESULTS,
        format: "json",
        ...(FATSECRET_REGION ? { region: FATSECRET_REGION } : {}),
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

  let fsRes;
  try {
    fsRes = await search();
  } catch (err) {
    // Token revoked or expired early: get a new one and try once more.
    if (err.response?.status !== 401) throw err;
    await refreshAccessToken();
    fsRes = await search();
  }
  const candidates = buildCandidates(fsRes.data);
  cache.set(cacheKey, candidates, RESOLVE_TTL_SECONDS);
  return candidates;
}

// -------------------- One-pass upgrade attempt --------------------
async function tryUpgradeFromDb({
  query,
  originalFood,
  aiResultPromise,
  grams,
  ml,
  count,
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

  let pick = { index: -1, confidence: 0, failed: true };
  try {
    pick = await pickBestCandidateIndex(query, top);
  } catch {}

  // The picker looked and said none of these is the food asked for (say a
  // different brand). Don't log the closest-sounding one anyway.
  if (!pick.failed && pick.index < 0) {
    return { upgraded: false, out: null, reason: "db_no_matching_candidate" };
  }

  const chosen =
    pick.index >= 0 && pick.index < top.length ? top[pick.index] : bestDet.c;
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
      meta: {
        phraseMustHave,
        chosen: { name: chosen.name, brand: chosen.brand },
        chosenScore,
      },
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

  // Confidence gate. The AI estimate has been running alongside the
  // database search and pick; only now do we need to wait for it.
  const aiResult = await aiResultPromise;
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

  const scaled = scaleCandidate(chosen, grams, ml, count);

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
/** Same food, same cache entry: "2 Eggs " and "2 eggs" share a lookup. */
function normalizeFood(food) {
  return String(food).trim().toLowerCase().replace(/\s+/g, " ");
}

/** Returned when the AI estimate itself failed (not just low confidence). */
function aiFailure(food) {
  return {
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
    failed: true,
  };
}

// -------------------- AI-first Hybrid Resolve --------------------
// The AI estimate and the database search + pick run at the same time, so
// a lookup takes about as long as the slower of the two, not both added up.
app.post("/food/resolve", requireFirebaseUser, foodLimiter, ensureFatSecretToken, async (req, res) => {
  const { food, debug } = req.body || {};

  if (!food || typeof food !== "string" || !food.trim()) {
    return res.status(400).json({ error: "food is required" });
  }
  if (food.length > 200) {
    return res.status(400).json({ error: "Describe one food at a time" });
  }

  const cacheKey = `resolve:v2:${normalizeFood(food)}`;
  const cached = cache.get(cacheKey);
  if (cached && !debug) return res.json(cached);

  const aiResultPromise = estimateAI(food).catch((err) => {
    console.error("AI estimate failed:", err.response?.data || err.message || err);
    return aiFailure(food);
  });

  const grams = extractExplicitGrams(food);
  const ml = extractExplicitMl(food);
  const count = !grams && !ml ? extractExplicitCount(food) : null;
  const brandHints = extractBrandHints(food);

  // Only cache real answers. A failed lookup returns an error so the app
  // can offer a retry, rather than silently logging 0 kcal (and remembering
  // that 0 for a week).
  const finish = (out) => {
    if (out.failed && !debug) {
      return res.status(502).json({ error: "Couldn't look that up, try again" });
    }
    if (!debug) cache.set(cacheKey, out, RESOLVE_TTL_SECONDS);
    return res.json(out);
  };

  try {
    // Primary attempt
    const primary = await tryUpgradeFromDb({
      query: food,
      originalFood: food,
      aiResultPromise,
      grams,
      ml,
      count,
      debug,
      brandHints,
      phaseLabel: "primary",
    });
    if (primary.upgraded) return finish(primary.out);

    // ONE cleaned retry (hard-capped)
    const cleaned = cleanQueryForFatSecret(food, brandHints);
    if (cleaned && cleaned !== normText(food)) {
      const cleanedRetry = await tryUpgradeFromDb({
        query: cleaned,
        originalFood: food,
        aiResultPromise,
        grams,
        ml,
        debug,
        brandHints,
        phaseLabel: "cleaned_retry",
      });
      if (cleanedRetry.upgraded) return finish(cleanedRetry.out);

      const aiResult = await aiOrWebResult(food, aiResultPromise, grams, ml);
      return finish(
        debug
          ? {
              ...aiResult,
              debug: {
                used: "ai_only",
                reason: "db_upgrade_failed_after_one_retry",
                primary: { reason: primary.reason, meta: primary.meta },
                cleaned_retry: {
                  query: cleaned,
                  reason: cleanedRetry.reason,
                  meta: cleanedRetry.meta,
                },
              },
            }
          : aiResult
      );
    }

    const aiResult = await aiOrWebResult(food, aiResultPromise, grams, ml);
    return finish(
      debug
        ? { ...aiResult, debug: { used: "ai_only", reason: primary.reason, meta: primary.meta } }
        : aiResult
    );
  } catch (err) {
    console.error("FatSecret resolve error:", err.response?.data || err.message || err);
    const aiResult = await aiOrWebResult(food, aiResultPromise, grams, ml);
    return finish(
      debug
        ? { ...aiResult, debug: { used: "ai_only", reason: "db_exception", error: err.message } }
        : aiResult
    );
  }
});

// ======================================================================
// ============================= MACRO TARGETS ===========================
// ======================================================================

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

/** An AI "adjusted" result must have every goal, with sensible numbers
 *  within 25% of the calculated calories. */
function adjustedTargetsLookSane(final, baselineFinal) {
  const t = final?.targets;
  if (!t) return false;
  return ["lose", "maintain", "gain"].every((goal) => {
    const g = t[goal];
    const base = baselineFinal.targets[goal]?.calories;
    if (!g || !base) return false;
    const nums = [g.calories, g.protein_g, g.carbs_g, g.fat_g].map(Number);
    if (!nums.every((n) => Number.isFinite(n) && n >= 0)) return false;
    return Math.abs(nums[0] - base) <= base * 0.25;
  });
}

app.post("/macro-targets", requireFirebaseUser, macroLimiter, async (req, res) => {
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
    const bmr = Math.round(
      bmrMifflin({ gender, weightKg, heightCm, age: ageNum })
    );
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

    const baselineFinal = {
      bmr: baseline.bmr,
      tdee: baseline.tdee,
      targets: {
        lose: baseline.targets.lose,
        maintain: baseline.targets.maintain,
        gain: baseline.targets.gain,
      },
    };

    // ---- AI verification (should NOT change numbers unless rules violated) ----
    // The numbers above are already complete. If the AI check is slow or
    // fails, answer with them rather than an error.
    let aiResponse;
    try {
      aiResponse = await openai.responses.create({
      model: AI_MODEL,
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
    } catch (err) {
      console.warn("Macro AI check skipped:", err?.message || err);
      return res.json({ mode: "baseline", baseline, ai: { status: "verified", final: baselineFinal } });
    }

    let ai;
    try {
      ai = JSON.parse(aiResponse.output_text);
    } catch {
      ai = { status: "verified" };
    }

    // ---- Normalize / enforce rules in code (so UI stays consistent) ----
    ai.status = normalizeStatus(ai.status);
    ai.confidence = clampNumber(ai.confidence, 0, 1) ?? 0.75;
    ai.issues = Array.isArray(ai.issues) ? ai.issues : [];
    ai.suggestions = Array.isArray(ai.suggestions) ? ai.suggestions : [];

    if (ai.status === "verified" || ai.status === "verified_with_suggestions") {
      ai.final = baselineFinal;
    } else if (!adjustedTargetsLookSane(ai.final, baselineFinal)) {
      // Don't trust an "adjustment" that's missing numbers or far off the
      // calculated baseline.
      ai.status = "verified";
      ai.final = baselineFinal;
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

// -------------------- Contactless: barcode --------------------
// Looks a packaged food up by its barcode in Open Food Facts (free, no key,
// strong UK coverage). Returns nutrition per serving when the pack lists
// one, otherwise per 100 g / 100 ml.
const barcodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.BARCODE_RATE_LIMIT_PER_MIN) || 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Too many requests, slow down a little." },
});

function numOrNull(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

app.get("/food/barcode", requireFirebaseUser, barcodeLimiter, async (req, res) => {
  const code = String(req.query.code || "").replace(/\D/g, "");
  if (code.length < 6 || code.length > 14) {
    return res.status(400).json({ error: "That doesn't look like a barcode" });
  }

  const cacheKey = `barcode:${code}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const r = await axios.get(
      `https://world.openfoodfacts.org/api/v2/product/${code}.json`,
      {
        params: {
          fields:
            "product_name,brands,serving_size,serving_quantity,nutriments,quantity",
        },
        headers: { "User-Agent": "TheCalorieCard/1.0 (thecaloriecard.com)" },
        timeout: 10000,
      }
    );
    const p = r.data?.product;
    if (r.data?.status !== 1 || !p) {
      return res.status(404).json({ error: "Product not found" });
    }

    const n = p.nutriments || {};
    // Some packs only list energy in kJ (Open Food Facts' plain "energy"
    // is kJ too): convert those to kcal.
    const kcal = (kcalKey, kjKeys) => {
      const direct = numOrNull(n[kcalKey]);
      if (direct != null) return direct;
      for (const k of kjKeys) {
        const kj = numOrNull(n[k]);
        if (kj != null) return kj / 4.184;
      }
      return null;
    };
    const perServing = kcal("energy-kcal_serving", ["energy-kj_serving", "energy_serving"]);
    const per100 = kcal("energy-kcal_100g", ["energy-kj_100g", "energy_100g"]);
    const useServing = perServing != null && perServing > 0;
    if (!useServing && per100 == null) {
      return res.status(404).json({ error: "No nutrition info for this product" });
    }

    const pick = (key) =>
      numOrNull(n[`${key}_${useServing ? "serving" : "100g"}`]) ?? 0;
    const brand = String(p.brands || "").split(",")[0].trim();
    const name = [brand, p.product_name].filter(Boolean).join(" ").trim();

    const result = {
      source: "barcode",
      barcode: code,
      name: name || "Scanned product",
      portion: useServing ? String(p.serving_size || "1 serving") : "100 g",
      calories: round1(useServing ? perServing : per100),
      protein: round1(pick("proteins")),
      carbs: round1(pick("carbohydrates")),
      fat: round1(pick("fat")),
    };
    cache.set(cacheKey, result, 60 * 60 * 24);
    return res.json(result);
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: "Product not found" });
    }
    console.error("Barcode lookup error:", err.response?.data || err.message);
    return res.status(502).json({ error: "Barcode lookup failed" });
  }
});

// -------------------- Contactless: meal photo --------------------
// Turns a photo of a meal into a list of foods with portions, e.g.
// ["150g grilled chicken breast", "1 cup white rice"]. The app then looks
// each one up through /food/resolve like typed food, so the database
// still gets first say on the numbers.
const photoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.PHOTO_RATE_LIMIT_PER_HOUR) || 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Too many photos this hour, try again later." },
});

app.post("/food/photo", requireFirebaseUser, photoLimiter, photoJson, async (req, res) => {
  if (!(await isPremium(req.user?.uid))) {
    return res.status(402).json({
      error: "Photo logging is part of Premium.",
      code: "premium_required",
    });
  }
  const image = String(req.body?.image || "");
  const mime = String(req.body?.mime || "image/jpeg");
  if (!image || image.length > 5_500_000) {
    return res.status(400).json({ error: "Send one photo under about 4 MB" });
  }
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) {
    return res.status(400).json({ error: "Unsupported image type" });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "AI is not configured" });
  }

  try {
    const response = await openai.responses.create({
      model: AI_MODEL,
      temperature: 0.1,
      text: { format: { type: "json_object" } },
      input: [
        {
          role: "system",
          content:
            "You identify food in photos for a calorie tracker. Return ONLY JSON: " +
            '{"items": ["<portion> <food>", ...]}. One entry per distinct food or drink, ' +
            "with a realistic portion estimate in grams, ml or units " +
            '(e.g. "150g grilled chicken breast", "1 slice toast with butter", "330ml cola"). ' +
            "Include sauces and drinks you can see. At most 8 items. " +
            'If there is no food in the photo, return {"items": []}.',
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: "What food is in this photo?" },
            { type: "input_image", image_url: `data:${mime};base64,${image}` },
          ],
        },
      ],
    });

    let items = [];
    try {
      const parsed = JSON.parse(response.output_text || "{}");
      if (Array.isArray(parsed.items)) {
        items = parsed.items
          .map((s) => String(s).trim())
          .filter((s) => s.length > 0 && s.length <= 120)
          .slice(0, 8);
      }
    } catch (_) {
      items = [];
    }
    return res.json({ items });
  } catch (err) {
    console.error("Photo error:", err?.response?.data || err.message || err);
    return res.status(502).json({ error: "Couldn't read that photo" });
  }
});

// -------------------- Calorie Coach --------------------
// A friendly chat about your day. The app sends today's numbers (balance,
// goals, what you've eaten, the last week) so answers are about you.
// Safety rules live here, on the server, so they can't be switched off.
const coachLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.COACH_RATE_LIMIT_PER_HOUR) || 40,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "You've chatted a lot this hour. Take a breather and come back soon." },
});

const COACH_SYSTEM_PROMPT = [
  "You are Calorie Coach, the friendly assistant inside The Calorie Card, a UK calorie-tracking app",
  "where the daily calorie budget works like a bank card balance (calories left = money left to spend).",
  "",
  "Tone: warm, upbeat, non-judgemental, practical. British English. Talk like a supportive friend, not a",
  "doctor. Keep replies short: usually 2-6 sentences or a few bullet points. Use the user's real numbers",
  "from the context when helpful. One or two emoji at most.",
  "",
  "What you help with: meal and snack ideas that fit the calories and macros left; hitting protein;",
  "healthier swaps; eating out; cravings; reflecting on the day or week; motivation; explaining macros",
  "and how the app works (card balance, Pots, direct debits, finishing a day, streaks).",
  "",
  "When someone is over budget: be kind first. One day over is normal and does not undo progress;",
  "consistency over weeks is what matters. If they want to balance it out, suggest spreading it gently:",
  "at most about 10% of their daily goal (and never more than 200 kcal) less on each of the next few",
  "days, through easy swaps and lighter choices, or simply getting back to normal tomorrow. Mention that",
  "unspent calories can go in their Pot if Pots is on.",
  "",
  "Safety rules (never break these):",
  "- Never suggest skipping meals, fasting to compensate, eating below about 1200 kcal (women) or",
  "  1500 kcal (men) a day, purging, laxatives, diet pills, or exercising to 'burn off' food.",
  "- Never shame, moralise about food, or call foods 'bad' or 'cheat' foods.",
  "- If the user mentions restricting heavily, bingeing and purging, feeling out of control around food,",
  "  intense guilt about eating, or self-harm, respond with care, don't give calorie advice, and gently",
  "  suggest talking to someone they trust or their GP; in the UK, Beat (the eating disorder charity) has",
  "  a helpline at beateatingdisorders.org.uk, and Samaritans can be reached on 116 123 any time.",
  "- For medical conditions, pregnancy, medication or diabetes, keep it general and suggest their GP or a",
  "  registered dietitian.",
  "- Don't invent numbers you weren't given; estimate food calories roughly and say they're estimates.",
  "- Stay on topic (food, nutrition, habits, the app). Politely steer back if asked about other things.",
  "",
  "Changing their diary and recipes:",
  "You can PROPOSE changes; the app shows each one as a summary card with Accept / Reject, and nothing",
  "changes until the user accepts. Only propose a change when the user clearly asks for it (e.g. 'add 2",
  "eggs to breakfast', 'log my chilli for dinner', 'remove the crisps', 'save this as a recipe'). If you",
  "suggested a meal and they say 'add that', propose it. If something important is unclear (which meal,",
  "how much), ask instead of guessing wildly; otherwise use sensible everyday portions.",
  "In 'reply', say briefly what you've put together (e.g. 'Here you go, tap Accept to add it.'). Don't",
  "claim anything has been added yet. The app works out the calories itself, so don't list numbers for",
  "proposed items unless asked.",
  "",
  "Always answer with a JSON object: {\"reply\": string, \"actions\": [ ... ]} (actions may be empty).",
  "Action types (at most 3 per answer):",
  '- {"type":"log_food","meal":"Breakfast|Lunch|Dinner|Snacks","items":["2 large scrambled eggs","1 slice',
  '  wholemeal toast with butter"]}  items are plain food descriptions WITH amounts, one food each (max 10).',
  '- {"type":"log_recipe","recipe_id":"<id from context.recipes>","meal":"...","servings":1}',
  '- {"type":"remove_food","entry_ids":["<id from context.entries_today>", ...]}',
  '- {"type":"create_recipe","name":"Chicken stir fry","servings":2,"ingredients":["300g chicken breast",',
  '  "1 tbsp soy sauce", ...]}  ingredients for the WHOLE recipe, with amounts (max 20).',
  '- {"type":"delete_recipe","recipe_id":"<id from context.recipes>"}',
  "Only use ids that appear in the context. Diary changes are for today only. Pick the meal from what",
  "they said, or the time of day if they didn't say (morning Breakfast, midday Lunch, evening Dinner,",
  "anything small between meals Snacks).",
].join("\n");

const COACH_MEALS = ["Breakfast", "Lunch", "Dinner", "Snacks"];

// Keeps only well-formed actions that point at things the user really has.
function sanitizeCoachActions(actions, context) {
  if (!Array.isArray(actions)) return [];
  const entryIds = new Set(
    (Array.isArray(context?.entries_today) ? context.entries_today : [])
      .map((e) => String(e?.id ?? ""))
      .filter(Boolean)
  );
  const recipeIds = new Set(
    (Array.isArray(context?.recipes) ? context.recipes : [])
      .map((r) => String(r?.id ?? ""))
      .filter(Boolean)
  );
  const meal = (m) => {
    let want = String(m ?? "").toLowerCase();
    if (want === "brekkie") want = "breakfast"; // the app's old name for it
    const hit = COACH_MEALS.find((x) => x.toLowerCase() === want);
    return hit || null;
  };
  const texts = (list, max) =>
    (Array.isArray(list) ? list : [])
      .map((t) => clip(String(t ?? "").trim(), 120))
      .filter(Boolean)
      .slice(0, max);
  const servings = (n) => {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 && v <= 20 ? Math.round(v * 100) / 100 : 1;
  };

  const out = [];
  for (const a of actions.slice(0, 3)) {
    const type = String(a?.type ?? "");
    if (type === "log_food") {
      const items = texts(a.items, 10);
      if (items.length) out.push({ type, meal: meal(a.meal) || "Snacks", items });
    } else if (type === "log_recipe") {
      const id = String(a.recipe_id ?? "");
      if (recipeIds.has(id)) {
        out.push({ type, recipe_id: id, meal: meal(a.meal) || "Snacks", servings: servings(a.servings) });
      }
    } else if (type === "remove_food") {
      const ids = (Array.isArray(a.entry_ids) ? a.entry_ids : [])
        .map((x) => String(x ?? ""))
        .filter((x) => entryIds.has(x));
      if (ids.length) out.push({ type, entry_ids: [...new Set(ids)].slice(0, 20) });
    } else if (type === "create_recipe") {
      const name = clip(String(a.name ?? "").trim(), 60);
      const ingredients = texts(a.ingredients, 20);
      if (name && ingredients.length) {
        out.push({ type, name, servings: servings(a.servings), ingredients });
      }
    } else if (type === "delete_recipe") {
      const id = String(a.recipe_id ?? "");
      if (recipeIds.has(id)) out.push({ type, recipe_id: id });
    }
  }
  return out;
}

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) : s;
}

app.post("/coach", requireFirebaseUser, coachLimiter, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "AI is not configured" });
  }
  const body = req.body || {};
  const raw = Array.isArray(body.messages) ? body.messages : [];
  // Last 12 turns, user/assistant only, each kept short.
  const messages = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-12)
    .map((m) => ({ role: m.role, content: clip(m.content, 1000) }))
    .filter((m) => m.content.trim().length > 0);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "Ask me something first" });
  }

  // Free accounts get a few Coach messages a day; Premium is unlimited.
  const allowance = await useCoachMessage(req.user?.uid);
  if (!allowance.allowed) {
    return res.status(402).json({
      error: "You've used today's free Coach messages. They reset at midnight.",
      code: "coach_limit",
    });
  }

  const ctx = body.context && typeof body.context === "object" ? body.context : {};
  let context = "";
  try {
    context = clip(JSON.stringify(ctx), 16000);
  } catch {
    context = "{}";
  }

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_COACH_MODEL || AI_MODEL,
      temperature: 0.6,
      max_output_tokens: 900,
      text: { format: { type: "json_object" } },
      input: [
        { role: "system", content: COACH_SYSTEM_PROMPT },
        {
          role: "system",
          content:
            "Today's context from the app (numbers in kcal and grams; 'left' is what's left on the card, " +
            "negative means over budget):\n" +
            context,
        },
        ...messages,
      ],
    });
    let parsed = {};
    try {
      parsed = JSON.parse(response.output_text || "{}");
    } catch {
      // Not JSON after all: treat the whole thing as the reply.
      parsed = { reply: response.output_text };
    }
    let actions = sanitizeCoachActions(parsed.actions, ctx);
    let reply = String(parsed.reply ?? "").trim();
    if (!reply && actions.length) reply = "Here's what I've put together. Have a look:";
    if (!reply) {
      refundCoachMessage(req.user?.uid);
      return res.status(502).json({ error: "Coach is lost for words. Try again?" });
    }
    // Coach making changes for you is a Premium feature.
    let lockedActions = 0;
    if (!allowance.premium && actions.length) {
      lockedActions = actions.length;
      actions = [];
    }
    return res.json({
      reply,
      actions,
      free_left: allowance.freeLeft,
      locked_actions: lockedActions,
    });
  } catch (err) {
    refundCoachMessage(req.user?.uid);
    console.error("Coach error:", err?.response?.data || err.message || err);
    return res.status(502).json({ error: "Coach couldn't answer just now. Try again?" });
  }
});

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (SERVICE_ACCOUNT && process.env.REMINDERS !== "off") {
    startReminders();
  } else {
    console.log("[reminders] off (no FIREBASE_SERVICE_ACCOUNT)");
  }
});
