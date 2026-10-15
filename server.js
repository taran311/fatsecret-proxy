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
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import rateLimit from "express-rate-limit";
import { startReminders } from "./reminders.js";
import {
  registerBilling,
  useCoachMessage,
  refundCoachMessage,
  isPremium,
} from "./billing.js";
import { registerPlayBilling } from "./play_billing.js";
import { registerAccount } from "./account.js";
import { registerGames } from "./games.js";
import { registerChat } from "./chat.js";
import { registerGifts, isAdmin } from "./gifts.js";
import { registerAnalytics, countEvent } from "./analytics.js";
import { readFileSync } from "node:fs";
import { parseFood, plausible, learn, serve } from "./food_base.js";
import { createOffSearch, offDescription } from "./off.js";
import { loadCofid, cofidDescription } from "./cofid.js";

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

// -------------------- Premium (Stripe and Google Play) --------------------
registerBilling(app, { requireFirebaseUser, firestoreReady: !!SERVICE_ACCOUNT });
// Premium bought in the Android app (Google Play).
registerPlayBilling(app, {
  requireFirebaseUser,
  firestoreReady: !!SERVICE_ACCOUNT,
  serviceAccount: SERVICE_ACCOUNT,
});
registerAccount(app, { requireFirebaseUser, firestoreReady: !!SERVICE_ACCOUNT });
registerGames(app, { requireFirebaseUser, firestoreReady: !!SERVICE_ACCOUNT });
registerChat(app, { requireFirebaseUser, firestoreReady: !!SERVICE_ACCOUNT });
registerGifts(app, { requireFirebaseUser, firestoreReady: !!SERVICE_ACCOUNT });
registerAnalytics(app, { requireFirebaseUser, firestoreReady: !!SERVICE_ACCOUNT });

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

// In-memory cache. Nutrition for "2 crumpets" doesn't change, so successful
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
// Share of the food's own words (not amounts or units) that the database
// entry's name must contain: both of "firm tofu", 2 of 3, 3 of 4.
const MIN_DB_TOKEN_SCORE = 0.6;
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

// Words that say how much, not what: left out when matching names.
const AMOUNT_WORDS = new Set([
  "g", "gram", "grams", "kg", "ml", "l", "litre", "liter", "cl", "oz", "lb",
  "tbsp", "tablespoon", "tsp", "teaspoon", "cup", "slice", "can", "tin",
  "bottle", "pack", "packet", "bag", "serving", "portion", "piece", "scoop",
  "glass", "pint", "handful", "bowl", "small", "medium", "large", "regular",
  "of", "a", "an", "the", "with", "x", "and", "half", "one", "two", "three",
  "four", "five", "six",
]);

/** "crumpets" and "crumpet", "tomatoes" and "tomato", "berries" and "berry". */
function stem(t) {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(ches|shes|xes|sses|oes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 2 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** The words that name the food: no numbers, amounts or units, stemmed. */
function foodWords(s) {
  return [
    ...new Set(
      tokenize(s)
        .map(stem)
        .filter((t) => !/^\d/.test(t) && !AMOUNT_WORDS.has(t))
    ),
  ];
}

/**
 * How well a database entry's name fits the food asked for: the share of
 * the food's own words found in the entry's brand and name. "2 crumpets"
 * and "Crumpet" score 1; "tofu curry" and "Tofu Scramble" score 0.5.
 */
function tokenScore(query, candidate) {
  const q = foodWords(query);
  if (!q.length) return 0;
  const c = new Set(foodWords(`${candidate.brand || ""} ${candidate.name || ""}`));
  return q.filter((t) => c.has(t)).length / q.length;
}

/**
 * The words of a brand the AI found in the food ("McCain", "Tesco
 * Finest"), for checking a database entry is that brand. No list of
 * brands: any brand works the same way.
 */
function brandWords(brand) {
  return normText(brand || "").split(" ").filter((w) => w.length > 1);
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

  // and a count at the start: "2 slices of toast" → "toast"
  q = q.replace(
    /^(?:\d+|a|an|one|two|three|four|five|six|half)\s+(?:(?:a|an)\s+)?(?:x\s+)?(?:(?:slices?|cans?|tins?|bottles?|packs?|packets?|bags?|bars?|cups?|mugs?|tbsp|tablespoons?|tsp|teaspoons?|servings?|portions?|pieces?|scoops?|glass(?:es)?|pints?)\s+)?(?:of\s+)?/,
    " "
  );

  // remove common size tokens that can hurt recall
  q = q.replace(
    /\b(small|medium|large|grande|venti|tall|regular|king|mini)\b/g,
    " "
  );

  return q.replace(/\s+/g, " ").trim();
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

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, half: 0.5,
};

/** Units something can be counted in, by every name people use. */
const COUNT_UNITS = {
  slice: "slice", slices: "slice",
  can: "can", cans: "can", tin: "can", tins: "can",
  bottle: "bottle", bottles: "bottle",
  pack: "pack", packs: "pack", packet: "pack", packets: "pack",
  bag: "bag", bags: "bag",
  bar: "bar", bars: "bar",
  cup: "cup", cups: "cup", mug: "cup", mugs: "cup",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  serving: "serving", servings: "serving", portion: "serving", portions: "serving",
  piece: "piece", pieces: "piece",
  scoop: "scoop", scoops: "scoop",
  glass: "glass", glasses: "glass",
  pint: "pint", pints: "pint",
};

/**
 * "2 slices of toast" → { count: 2, unit: "slice" }; "3 crumpets" → { count: 3,
 * unit: null }; "half an avocado" → { count: 0.5 }; "a banana" → 1.
 * Only an amount at the start counts, and only 0.25-20 of something.
 */
function extractCountAndUnit(text) {
  const t = String(text).toLowerCase().trim();
  const m = t.match(
    /^(\d+(?:\.\d+)?|[a-z]+)\s+(?:(?:a|an)\s+)?(?:x\s+)?(?:(?:small|medium|large|big|regular)\s+)?([a-z]+)/
  );
  if (!m) return null;
  const n = /^\d/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
  if (!Number.isFinite(n) || n < 0.25 || n > 20) return null;
  return { count: n, unit: COUNT_UNITS[m[2]] || null };
}

function extractExplicitCount(text) {
  return extractCountAndUnit(text)?.count ?? null;
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
/** FatSecret's serving: "Per 1 medium - Calories: …" → "1 medium". */
function servingText(desc) {
  const m = String(desc || "").match(/^\s*Per\s+(.+?)\s+-\s/i);
  return m ? m[1].trim() : null;
}

/** "Per 1 slice" → { n: 1, unit: "slice" }; "Per 2 biscuits" → { n: 2, unit: null }. */
function perUnit(desc) {
  const m = String(desc || "").match(/^\s*Per\s+(\d+(?:\.\d+)?)\s+([a-z]+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  return { n, unit: COUNT_UNITS[m[2].toLowerCase()] || null };
}

/** The entry is per a weight or volume ("Per 100g", "Per 250 ml"), not per item. */
function isPerWeight(desc) {
  return /^\s*Per\s+\d+(?:\.\d+)?\s*g\b/i.test(String(desc || ""));
}
function isPerVolume(desc) {
  return /^\s*Per\s+\d+(?:\.\d+)?\s*(?:ml|fl\s*oz)\b/i.test(String(desc || ""));
}

/** Counted things that are one item each: "2 Nakd bars", "2 bags of crisps". */
const ITEM_UNITS = new Set(["bar", "pack", "bag", "can", "bottle", "piece", "serving"]);

function fmtAmount(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * How much of a database entry the food is: the factor to multiply its
 * numbers by, plus the amount to show. Returns null when it can't be
 * scaled reliably (the AI answer is used instead).
 *
 * [ai] is the AI estimate, used for its portion size when the entry is
 * per 100g and the food doesn't say how much: "Tesco porridge oats" is
 * the database's numbers for the AI's 40g, not 100g.
 */
function planScale(candidate, { grams, ml, count, unit, ai, query }) {
  const desc = candidate.description;
  const serving = servingText(desc);
  const aiGrams = ai && !ai.failed ? toPositiveNumberOrNull(ai.grams) : null;
  const aiMl = ai && !ai.failed ? toPositiveNumberOrNull(ai.ml) : null;
  const byWeight = (g) => ({
    factor: g / candidate.per_grams,
    mode: "weight",
    grams: Math.round(g),
    ml: null,
  });
  const byVolume = (v) => ({
    factor: v / candidate.per_ml,
    mode: "volume",
    grams: null,
    ml: Math.round(v),
  });

  // "200g …" / "330ml …"
  if (grams) {
    // An entry without a weight can't be scaled to one: the label lookup
    // or the AI answers instead.
    return candidate.per_grams ? byWeight(grams) : null;
  }
  if (ml) return candidate.per_ml ? byVolume(ml) : null;

  const pu = perUnit(desc);

  // "2 slices of toast", "3 crumpets", "half an avocado"
  if (count) {
    const servings = (factor) => ({
      factor,
      mode: "serving",
      grams: null,
      ml: null,
      serving: serving && factor !== 1 ? `${fmtAmount(factor)} × ${serving}` : serving,
    });
    if (unit) {
      if (pu && pu.unit === unit) return servings(count / pu.n);
    } else if (candidate.per_item_count) {
      return servings(count / candidate.per_item_count);
    } else if (pu && ITEM_UNITS.has(pu.unit)) {
      return servings(count / pu.n);
    }
    // Per 100g: use the AI's weight for this many.
    if (isPerWeight(desc) && candidate.per_grams && aiGrams) return byWeight(aiGrams);
    if (isPerVolume(desc) && candidate.per_ml && aiMl) return byVolume(aiMl);
    return null;
  }

  // No amount at all ("Tesco porridge oats", "banana").
  if (isPerWeight(desc)) return candidate.per_grams && aiGrams ? byWeight(aiGrams) : null;
  if (isPerVolume(desc)) return candidate.per_ml && aiMl ? byVolume(aiMl) : null;
  // Already one item or serving ("Per 1 medium", "Per 1 bar").
  return { factor: 1, mode: "serving", grams: null, ml: null, serving };
}

function isStrongGenericFallbackAllowed(query, candidate, token_score, grams, ml, count) {
  if (!grams && !ml && !count) return false;
  if (token_score < 0.75) return false;
  if (grams && !candidate.per_grams) return false;
  if (ml && !candidate.per_ml) return false;
  return true;
}

// -------------------- Where the person is --------------------
// Foods differ by country: a can of Coke is 330ml in the UK and 355ml in
// the US, brands and recipes change, and so do the usual sizes. The app
// sends its country (the phone's region); everything that depends on it
// (sizes, which products and labels, saved answers) follows it.
const DEFAULT_COUNTRY = (process.env.DEFAULT_COUNTRY || "GB").toUpperCase();
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** A two-letter country code ("GB", "US"), or the default. */
function normCountry(c) {
  const cc = String(c || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return DEFAULT_COUNTRY;
  try {
    return regionNames.of(cc) && regionNames.of(cc) !== cc ? cc : DEFAULT_COUNTRY;
  } catch {
    return DEFAULT_COUNTRY;
  }
}

/** "the UK", "the United States", "France": for the AI's instructions. */
function placeName(cc) {
  if (cc === "GB") return "the UK";
  const name = regionNames.of(cc) || cc;
  return /^(United|Netherlands|Philippines|Czech|Dominican|Bahamas|Gambia|Maldives)/.test(name)
    ? `the ${name}`
    : name;
}

// -------------------- AI: estimate --------------------
async function estimateAI(food, country = DEFAULT_COUNTRY) {
  const place = placeName(country);
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
            "Return ONLY valid JSON. Always return values strictly PER 100g for the described food. Do NOT scale totals. " +
            `The person is in ${place}: foods and brands are as sold there.`,
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
"brand" is the brand or chain if the description names one (e.g. "Yubi", "Greggs", "Tesco"), otherwise null. People often type brand names in lower case: a word that isn't a food you recognise (e.g. "surreal", "grenade", "huel") is probably a brand or product from ${place}, so put it in "brand" and keep "confidence" low unless you know that product's label.`,
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
    temperature: 0,
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
          `The person is in ${place}: foods, brands and sizes are as sold there.\n\n` +
          `If neither is specified, estimate a realistic serving in ${place} and use grams for solids and ml for drinks.\n\n` +
          "For a number of items (\"3 biscuits\", \"2 rolls\", \"1 pear\"), use the standard size sold in " +
          `${place}'s supermarkets, not restaurant, takeaway or homemade sizes, unless the description says otherwise. ` +
          "For fruit and veg, count only the part that's eaten (no stone, skin or core) of a medium one.\n\n" +
          "Never assign grams to drinks when ml is appropriate.\n\n" +
          `Return realistic nutrition estimates for ${place}.`,
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
  "per_100g": { "calories": number, "protein": number, "carbs": number, "fat": number } | null,
  "one_item": { "grams": number | null, "calories": number, "protein": number, "carbs": number, "fat": number } | null,
  "brand": string | null,
  "confidence": number
}
calories/protein/carbs/fat are for the whole amount described. For a solid food, also give "per_100g" (the values per 100g of it as eaten) and make "estimated_serving_grams" the realistic weight of the part that's eaten (no shell, stone, skin or packaging); for drinks set "per_100g" to null. If the description is a number of countable items ("3 biscuits", "half a pear", "2 rolls"), also fill "one_item" with the values for ONE single item (one biscuit, not one serving of several); otherwise set it to null.
"brand" is the brand or chain if the description names one (e.g. "Yubi", "Greggs", "Tesco"), otherwise null. People often type brand names in lower case: a word that isn't a food you recognise (e.g. "surreal", "grenade", "huel") is probably a brand or product from ${place}, so put it in "brand" and keep "confidence" low unless you know that product's label.`,
      },
    ],
  });

  const j = JSON.parse(response.output_text);

  // Solids: per-100g values × the estimated weight. The model is very
  // accurate per 100g but tends to over-guess calories for "one of"
  // something directly (a large egg as 90 rather than ~72).
  const per100 = j.per_100g;
  const servingGrams = toPositiveNumberOrNull(j.estimated_serving_grams);
  // Not for named brands or chains ("McPlant", "Greggs ..."): their own
  // figure for the item is better than a generic weight guess.
  if (!cleanBrand(j.brand) && !toPositiveNumberOrNull(j.ml) && !explicitMl && servingGrams &&
      per100 && Number(per100.calories) > 0) {
    const f = servingGrams / 100;
    j.calories = Number(per100.calories) * f;
    j.protein = (Number(per100.protein) || 0) * f;
    j.carbs = (Number(per100.carbs) || 0) * f;
    j.fat = (Number(per100.fat) || 0) * f;
    if (j.one_item) j.one_item = null; // the total above is what's wanted
    j._basis = `${Math.round(Number(per100.calories))} kcal/100g × ${Math.round(servingGrams)}g`;
  }

  // A number of items: one item's values times the number asked for, so
  // "3 Weetabix" is three biscuits (not one 2-biscuit serving) and half an
  // avocado is always half of a whole one.
  const amount = explicitMl ? null : extractCountAndUnit(food);
  const one = j.one_item;
  if (amount && !amount.unit && one && Number(one.calories) > 0) {
    const n = amount.count;
    j.calories = Number(one.calories) * n;
    j.protein = (Number(one.protein) || 0) * n;
    j.carbs = (Number(one.carbs) || 0) * n;
    j.fat = (Number(one.fat) || 0) * n;
    const g = toPositiveNumberOrNull(one.grams);
    if (g) j.estimated_serving_grams = g * n;
  }

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
    ...(j._basis ? { basis: j._basis } : {}),
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

async function webLookup(food, grams, ml, country = DEFAULT_COUNTRY) {
  const place = placeName(country);
  const response = await openai.responses.create({
    model: WEB_MODEL,
    temperature: 0,
    tools: [{ type: "web_search", user_location: { type: "approximate", country } }],
    input: [
      {
        role: "system",
        content:
          `You find the official nutrition label for a branded food or drink sold in ${place}. ` +
          "The description may give the brand in lower case or without saying what the product is " +
          '(e.g. "40g surreal" is Surreal cereal): work out the product first. ' +
          `Search the web, prefer the brand's own site for ${place}, a supermarket listing there or a nutrition ` +
          "database entry for that exact product (recipes and sizes differ between countries). If no flavour " +
          "is given, use the brand's standard or most common one. " +
          "Reply with ONLY a JSON object, no other text:\n" +
          '{"found": boolean, "name": string, "serving_description": string, "serving_grams": number|null, ' +
          '"serving_ml": number|null, "calories": number, "protein": number, "carbs": number, "fat": number, ' +
          '"calories_per_100g": number|null, "protein_per_100g": number|null, "carbs_per_100g": number|null, ' +
          '"fat_per_100g": number|null, "label_serving": {"description": string, "items": number|null, ' +
          '"item": string|null, "grams": number|null, "calories": number, "protein": number, "carbs": number, ' +
          '"fat": number}|null}\n' +
          "calories/protein/carbs/fat are for EXACTLY the amount described: \"4 Jaffa Cakes\" is four cakes, " +
          "\"2 Nakd bars\" is two bars. Labels often give a serving of several items, so work out the " +
          "amount asked for from the per-item or per-100g values. If no amount is given, use one serving " +
          "as sold (one bar, one pack, one bottle). serving_description says what the numbers are for, " +
          "e.g. \"3 biscuits (33g)\". " +
          "label_serving is the serving exactly as printed on the label, numbers copied not worked out: " +
          "its description (\"3 hash browns (118g)\"), items = how many separate pieces that serving is " +
          "(3 for 3 hash browns, 2 for \"2 biscuits\", 1 for one bar; null if it isn't pieces, like 30g of " +
          "cereal), item = one piece's name in the singular (\"hash brown\"), and its grams and values. " +
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
    // The per-serving and per-100g figures should agree. When they don't
    // (the pot's values put in the per-100g boxes, say), the serving
    // figures are the ones read straight off the label: use those.
    const servingGrams = toPositiveNumberOrNull(j.serving_grams);
    const fromServing = servingGrams ? (Number(j.calories) / servingGrams) * 100 : null;
    if (fromServing && Math.abs(per100 - fromServing) > fromServing * 0.25) {
      const f = grams / servingGrams;
      return {
        source: "web",
        mode: "weight",
        name: j.name || food,
        grams,
        ml: null,
        calories: Math.round(Number(j.calories) * f),
        protein: round1((Number(j.protein) || 0) * f),
        carbs: round1((Number(j.carbs) || 0) * f),
        fat: round1((Number(j.fat) || 0) * f),
        confidence: 0.85,
      };
    }
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

  // A number of pieces ("3 hash browns", "1 Weetabix"): worked out here
  // from the label's own serving and how many pieces it is, rather than
  // trusting the model's arithmetic (it would sometimes give a 2-biscuit
  // serving as one biscuit).
  const amount = ml ? null : extractCountAndUnit(food);
  const ls = j.label_serving;
  const items = toPositiveNumberOrNull(ls?.items);
  const lsKcal = Number(ls?.calories);
  if (amount && (!amount.unit || ITEM_UNITS.has(amount.unit)) && items && lsKcal > 0 &&
      plausible({ calories: lsKcal, protein: ls.protein, carbs: ls.carbs, fat: ls.fat, grams: ls.grams })) {
    const f = amount.count / items;
    const each = toPositiveNumberOrNull(ls.grams) ? Number(ls.grams) / items : null;
    const piece = String(ls.item || "").trim() || "piece";
    const label = `${fmtAmount(amount.count)} ${piece}${each ? ` (${Math.round(each)}g)` : ""}`;
    return {
      source: "web",
      mode: "serving",
      name: j.name || food,
      grams: each ? Math.round(each * amount.count) : null,
      ml: null,
      serving_description: label,
      calories: Math.round(lsKcal * f),
      protein: round1((Number(ls.protein) || 0) * f),
      carbs: round1((Number(ls.carbs) || 0) * f),
      fat: round1((Number(ls.fat) || 0) * f),
      confidence: 0.85,
      basis: `label: ${Math.round(lsKcal)} kcal per ${ls.description || `${items} pieces`} × ${fmtAmount(amount.count)}/${fmtAmount(items)}`,
    };
  }

  // Already for the amount asked for ("3 Oreos"): no multiplying here.
  return {
    source: "web",
    mode: "serving",
    name: j.name || food,
    grams: toPositiveNumberOrNull(j.serving_grams),
    ml: toPositiveNumberOrNull(j.serving_ml),
    serving_description: j.serving_description,
    calories: Math.round(Number(j.calories)),
    protein: round1(Number(j.protein) || 0),
    carbs: round1(Number(j.carbs) || 0),
    fat: round1(Number(j.fat) || 0),
    confidence: 0.85,
  };
}

/**
 * The AI estimate, or the real label from the web: for a named brand the
 * database missed, and whenever the model wasn't sure what the food is
 * (e.g. a brand typed in lower case, like "40g surreal").
 */
const UNSURE = 0.6; // the app shows "Check this" below this

/** The label online, with one more try: web searches sometimes come back
 *  empty. Null if it couldn't be found. */
async function labelLookup(food, grams, ml, country) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const web = await webLookup(food, grams, ml, country);
      if (web) return web;
    } catch (err) {
      console.error("Web lookup failed:", err.response?.data || err.message || err);
    }
  }
  return null;
}

async function aiOrWebResult(food, aiResultPromise, grams, ml, { triedLabel = false, country } = {}) {
  const ai = await aiResultPromise;
  const unsure = !(Number(ai.confidence) >= UNSURE);
  const named = !!ai.brand;
  if (triedLabel || !WEB_LOOKUP || ai.failed || (!named && !unsure) || !process.env.OPENAI_API_KEY) {
    return ai;
  }
  return (await labelLookup(food, grams, ml, country)) ?? ai;
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
          'Pick the single best matching candidate index for the query.\nReturn ONLY JSON: {"index": number, "confidence": number}\nDo NOT pick unrelated foods.\nPrefer exact brand/name matches.\nIf the query names a brand and no candidate is that brand, return {"index": -1, "confidence": 0}.\nIf the query names a brand but not a flavour, any flavour of that brand is a good match.\n' +
            "The candidate must be the same food in the same form as the query: not a dry mix, powder, " +
            "capsule, concentrate or raw ingredient when the query is the made-up dish or drink (or the " +
            "other way round), and not a different dish that shares a word. A candidate that contradicts a " +
            "detail in the query (sweetened vs unsweetened, raw vs cooked, with vs without skin, light vs " +
            "full fat) is not a match either. If none is, return " +
            '{"index": -1, "confidence": 0}.\n',
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
  // FatSecret reports problems (an IP address it doesn't allow, a bad
  // token) as a normal reply with an "error" in it. Treat that as a
  // failure, so it's logged and shows in the food check, rather than
  // looking like "no matches".
  const fsError = fsRes.data?.error;
  if (fsError) {
    throw new Error(`FatSecret ${fsError.code ?? ""}: ${fsError.message ?? "error"}`.trim());
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
  unit,
  debug,
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

  // The AI estimate has been running alongside the database search and
  // pick; only now do we need to wait for it.
  const aiResult = await aiResultPromise;

  // Brand gate: a food with a brand has to be that brand's entry, never
  // the closest-sounding other brand. The brand comes from the AI, so it
  // works for any brand.
  const brand = brandWords(aiResult?.failed ? null : aiResult?.brand);
  if (brand.length && !containsAllKeywords(chosenText, brand)) {
    return {
      upgraded: false,
      out: null,
      reason: "brand_gate_failed",
      meta: { brand: aiResult.brand, chosen: { name: chosen.name, brand: chosen.brand }, chosenScore },
    };
  }

  // Confidence gate.
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

  // How much: the amount asked for, or the AI's portion for an entry
  // that's per 100g. Can't tell reliably: use the AI answer instead.
  const scaled = planScale(chosen, { grams, ml, count, unit, ai: aiResult, query: originalFood });
  if (!scaled || !(scaled.factor > 0) || scaled.factor > 50) {
    return {
      upgraded: false,
      out: null,
      reason: "db_scaling_mismatch_veto",
      meta: { chosen: { name: chosen.name, brand: chosen.brand, description: chosen.description }, chosenScore },
    };
  }

  // Cleaned retry accept rule
  if (phaseLabel === "cleaned_retry") {
    if (!isStrongGenericFallbackAllowed(query, chosen, chosenScore, grams, ml, count)) {
      return {
        upgraded: false,
        out: null,
        reason: "cleaned_retry_not_strong_enough",
        meta: { chosenScore },
      };
    }
  }

  const base = chosen.nutrition;
  const dbResult = {
    source: "fatsecret",
    mode: scaled.mode,
    name: chosen.brand ? `${chosen.brand} ${chosen.name}` : chosen.name,
    grams: scaled.grams ?? null,
    ml: scaled.ml ?? null,
    ...(scaled.serving ? { serving_description: scaled.serving } : {}),
    calories: Math.round(base.calories * scaled.factor),
    protein: round1(base.protein * scaled.factor),
    carbs: round1(base.carbs * scaled.factor),
    fat: round1(base.fat * scaled.factor),
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
/** Same food, same cache entry: "2 Crumpets " and "2 crumpets" share a lookup. */
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
  const country = normCountry(req.body?.country);

  if (!food || typeof food !== "string" || !food.trim()) {
    return res.status(400).json({ error: "food is required" });
  }
  if (food.length > 200) {
    return res.status(400).json({ error: "Describe one food at a time" });
  }

  if (!debug) countEvent("food_lookup");
  // Only keep real answers. A failed lookup returns an error so the app
  // can offer a retry, rather than silently logging 0 kcal (and
  // remembering that 0).
  // "Look up again" in the app: someone thinks the saved answer is wrong.
  const refresh = req.body?.refresh === true;
  const out = await lookupFood(food, { debug: !!debug, country, refresh });
  if (out.failed && !debug) {
    return res.status(502).json({ error: "Couldn't look that up, try again" });
  }
  return res.json(out);
});

/**
 * One food, the quickest way there is:
 * 1. the same words asked before (memory, then saved), as they were;
 * 2. the same food in another amount, worked out from its saved record
 *    ("tofu 350g" from "200g tofu");
 * 3. otherwise the full lookup, whose answer is saved for both, but only
 *    when its numbers add up.
 * [debug] skips 1 and 2 and saves nothing (the admin Food check).
 */
async function lookupFood(food, { debug = false, country = DEFAULT_COUNTRY, refresh = false } = {}) {
  // Saved per country: the same words can mean a different product or size.
  const key = savedKey(country, food);
  const cacheKey = `resolve:v${RESOLVE_VERSION}:${key}`;
  if (refresh && !debug) {
    // Throw the saved answers away (this text, and this food in any
    // amount), so a wrong one can't come back, then look it up fresh.
    await forgetFood(food, country).catch(() => {});
    const c = countedFood(food);
    if (c) await forgetFood(c.single, country).catch(() => {});
    countEvent("food_lookup_refresh");
  }
  if (!debug && !refresh) {
    const cached = cache.get(cacheKey) || (await readSavedLookup(key));
    if (cached) {
      cache.set(cacheKey, cached, RESOLVE_TTL_SECONDS);
      countEvent("food_lookup_saved");
      return cached;
    }
    const fromSaved = await fromFoodBase(food, country);
    if (fromSaved) {
      countEvent("food_lookup_saved");
      return fromSaved;
    }
  }
  const out = await resolveFood(food, { debug, country });
  // An answer marked for checking isn't saved for anyone else.
  if (!debug && !out.failed && !out.check && plausible(out)) {
    cache.set(cacheKey, out, RESOLVE_TTL_SECONDS);
    saveLookup(key, food, out);
    learnFoodBase(food, out, country);
  }
  return out;
}

// -------------------- Open Food Facts (branded foods) --------------------
const off = createOffSearch({
  get: (url, opts) => axios.get(url, opts),
  cache,
  perMinute: Number(process.env.OFF_SEARCHES_PER_MIN) || 8,
  userAgent: process.env.OFF_USER_AGENT || "TheCalorieCard/1.0 (thecaloriecard.com)",
});

/**
 * A branded food from Open Food Facts: the product the AI picks among the
 * products found in their country (it has to be that brand), its label values per 100g
 * times the amount. The amount is the weight or volume typed, or with
 * [aiWeight] the AI's weight for what was described ("2 slices"). Not its
 * listed serving: Open Food Facts often gives 100g there when the pack
 * doesn't say ("Tesco porridge oats" came out as a 100g bowl). Null if
 * there's no clear match or no reliable amount.
 */
async function offLookup(food, { brand, ai, grams, ml, aiWeight, country }) {
  // Two passes share one search (it's remembered), so this costs one.
  if (!aiWeight && !grams && !ml) return null;
  const terms = cleanQueryForFatSecret(food, []);
  const products = await off.search(terms, country);
  if (!products?.length) return null;

  const words = brandWords(brand);
  const candidates = products
    .filter((p) => containsAllKeywords(`${p.brand} ${p.name}`, words))
    .slice(0, 6);
  if (!candidates.length) return null;
  let pick;
  try {
    pick = await pickBestCandidateIndex(
      food,
      candidates.map((p) => ({ name: p.name, brand: p.brand, description: offDescription(p) }))
    );
  } catch {
    return null;
  }
  if (!(pick.index >= 0 && pick.index < candidates.length) || pick.confidence < MIN_DB_AI_PICK_CONF) {
    return null;
  }
  const p = candidates[pick.index];

  let qty = null; // grams, or ml for a drink
  let volume = false;
  if (ml) {
    if (!p.liquid) return null; // per 100g can't be poured into ml
    qty = ml;
    volume = true;
  } else if (grams) {
    qty = grams;
  } else if (aiWeight) {
    const w = toPositiveNumberOrNull(p.liquid ? ai?.ml : ai?.grams);
    if (!w || ai?.failed) return null;
    qty = w;
    volume = p.liquid && !!ai?.ml;
  }
  if (!qty) return null;

  const f = qty / 100;
  const unit = volume ? "ml" : "g";
  return {
    source: "label",
    mode: volume ? "volume" : "weight",
    name: p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? `${p.brand} ${p.name}` : p.name,
    grams: volume ? null : Math.round(qty),
    ml: volume ? Math.round(qty) : null,
    calories: Math.round(p.per100.calories * f),
    protein: round1(p.per100.protein * f),
    carbs: round1(p.per100.carbs * f),
    fat: round1(p.per100.fat * f),
    confidence: 0.9,
    basis: `${Math.round(p.per100.calories)} kcal/100${unit} × ${Math.round(qty)}${unit} (Open Food Facts)`,
  };
}

// -------------------- UK food tables (everyday foods) --------------------
const COFID = loadCofid(new URL("./data/cofid.json", import.meta.url));
const COFID_COUNTRIES = new Set(["GB", "IE", "IM", "JE", "GG"]);
console.log(`UK food tables: ${COFID.size} foods`);

/**
 * An unbranded food from the UK food tables: the entry the AI picks among
 * those sharing its words, per 100g times the weight typed, or the AI's
 * weight for what was described ("1 banana", "a bowl of rice"). Null if
 * nothing in the tables is clearly that food.
 */
async function cofidLookup(food, { ai, grams, ml, country }) {
  // UK foods and recipes: for people in the UK and Ireland.
  if (!COFID.size || !COFID_COUNTRIES.has(country)) return null;
  const candidates = COFID.search(food, 10);
  if (!candidates.length) return null;
  let pick;
  try {
    pick = await pickBestCandidateIndex(
      food,
      candidates.map((f) => ({ name: f.name, brand: null, description: cofidDescription(f) }))
    );
  } catch {
    return null;
  }
  if (!(pick.index >= 0 && pick.index < candidates.length) || pick.confidence < MIN_DB_AI_PICK_CONF) {
    return null;
  }
  const f = candidates[pick.index];
  // Most drinks weigh about what their volume is (1ml ≈ 1g); alcoholic
  // drinks are given per 100ml in the tables anyway.
  const aiAmount = ai?.failed ? null : toPositiveNumberOrNull(ai?.grams) ?? toPositiveNumberOrNull(ai?.ml);
  const qty = grams || ml || aiAmount;
  if (!qty) return null;
  const volume = !!ml || (!grams && !toPositiveNumberOrNull(ai?.grams) && !!toPositiveNumberOrNull(ai?.ml));
  const unit = volume ? "ml" : "g";
  const fct = qty / 100;
  return {
    source: "tables",
    mode: volume ? "volume" : "weight",
    name: f.name,
    grams: volume ? null : Math.round(qty),
    ml: volume ? Math.round(qty) : null,
    calories: Math.round(f.per100.calories * fct),
    protein: round1(f.per100.protein * fct),
    carbs: round1(f.per100.carbs * fct),
    fat: round1(f.per100.fat * fct),
    // The values are measured; the amount may be the AI's estimate.
    confidence: grams || ml ? 0.92 : 0.8,
    basis: `${Math.round(f.per100.calories)} kcal/100${unit} × ${Math.round(qty)}${unit} (UK food tables)`,
  };
}

/**
 * A label answer that's far from what the AI expects for the same words
 * (under half or over double) is probably a different product from the
 * one meant: "linda mccartney sausages" read off a pack of mini sausages,
 * say. It's still shown, but marked "Check this" with the product it
 * matched, and never saved for anyone else.
 */
function crossCheck(result, ai) {
  const expected = Number(ai?.calories);
  const got = Number(result?.calories);
  if (ai?.failed || !(expected > 0) || !(got > 0)) return result;
  const ratio = got / expected;
  if (ratio >= 0.5 && ratio <= 2) return result;
  return {
    ...result,
    confidence: Math.min(Number(result.confidence) || 0.5, 0.5),
    check: `Matched "${result.name}": ${Math.round(got)} kcal, where a typical one is about ${Math.round(expected)}`,
  };
}

/**
 * The hybrid lookup for one food: the AI estimate and the database
 * search + pick run at the same time, so it takes about as long as the
 * slower of the two, not both added up.
 */
async function resolveFood(food, { debug = false, country = DEFAULT_COUNTRY } = {}) {
  // "3 Weetabix", "half an avocado", "2 crumpets": one item, looked up
  // once (and remembered), times the number. So a number of something
  // always agrees with one of it, and gives the same answer every time.
  const counted = await resolveCounted(food, { debug, country });
  if (counted) return counted;

  const aiResultPromise = estimateAI(food, country).catch((err) => {
    console.error("AI estimate failed:", err.response?.data || err.message || err);
    return aiFailure(food);
  });

  const grams = extractExplicitGrams(food);
  const ml = extractExplicitMl(food);
  const amount = !grams && !ml ? extractCountAndUnit(food) : null;
  const count = amount?.count ?? null;
  const unit = amount?.unit ?? null;
  const common = { originalFood: food, aiResultPromise, grams, ml, count, unit, debug };

  // The database search starts now, alongside the AI estimate.
  const primaryPromise = tryUpgradeFromDb({ ...common, query: food, phaseLabel: "primary" })
    .catch((error) => ({ upgraded: false, error }));

  // A branded product (any brand: the AI spots it): its own label first.
  // The database's entries are mostly US products and the AI has to guess
  // sizes, so the brand's label is the most accurate source there is:
  // 1. Open Food Facts when a weight or volume is given: the label's
  //    numbers, plain arithmetic;
  // 2. the label online (it can count: "3 hash browns" off the pack);
  // 3. Open Food Facts with the AI's weight for the amount.
  const ai = await aiResultPromise;
  const brand = ai.failed ? null : cleanBrand(ai.brand);
  let triedLabel = false;
  if (brand) {
    const off = await offLookup(food, { brand, ai, grams, ml, aiWeight: false, country });
    if (off) {
      const checked = crossCheck(off, ai);
      return debug ? { ...checked, debug: { used: "open_food_facts", brand } } : checked;
    }
    if (WEB_LOOKUP && process.env.OPENAI_API_KEY) {
      triedLabel = true;
      const found = await labelLookup(food, grams, ml, country);
      const label = found && crossCheck(found, ai);
      if (label) return debug ? { ...label, debug: { used: "label", brand } } : label;
    }
    const guessed = await offLookup(food, { brand, ai, grams, ml, aiWeight: true, country });
    const offGuess = guessed && crossCheck(guessed, ai);
    if (offGuess) {
      return debug ? { ...offGuess, debug: { used: "open_food_facts_ai_weight", brand } } : offGuess;
    }
  } else {
    // An everyday food with no brand: the UK government food tables (for
    // people in the UK).
    const uk = await cofidLookup(food, { ai, grams, ml, country });
    if (uk) return debug ? { ...uk, debug: { used: "uk_food_tables" } } : uk;
  }
  const fallback = () => aiOrWebResult(food, aiResultPromise, grams, ml, { triedLabel, country });

  try {
    const primary = await primaryPromise;
    if (primary.error) throw primary.error;
    if (primary.upgraded) return primary.out;

    // ONE cleaned retry (hard-capped)
    const cleaned = cleanQueryForFatSecret(food, brandWords(brand));
    if (cleaned && cleaned !== normText(food)) {
      const cleanedRetry = await tryUpgradeFromDb({
        ...common,
        query: cleaned,
        phaseLabel: "cleaned_retry",
      });
      if (cleanedRetry.upgraded) return cleanedRetry.out;

      const aiResult = await fallback();
      return debug
        ? {
            ...aiResult,
            debug: {
              used: "ai_only",
              reason: "db_upgrade_failed_after_one_retry",
              primary: { reason: primary.reason, meta: primary.meta },
              cleaned_retry: { query: cleaned, reason: cleanedRetry.reason, meta: cleanedRetry.meta },
            },
          }
        : aiResult;
    }

    const aiResult = await fallback();
    return debug
      ? { ...aiResult, debug: { used: "ai_only", reason: primary.reason, meta: primary.meta } }
      : aiResult;
  } catch (err) {
    console.error("FatSecret resolve error:", err.response?.data || err.message || err);
    const aiResult = await fallback();
    return debug
      ? { ...aiResult, debug: { used: "ai_only", reason: "db_exception", error: err.message } }
      : aiResult;
  }
}

// -------------------- Counted foods --------------------
/**
 * "3 Weetabix" → { count: 3, single: "1 weetabix" }. Only a plain number of
 * things (not "2 slices of", "a can of", "200g") and not 1 itself.
 */
function countedFood(food) {
  if (extractExplicitGrams(food) || extractExplicitMl(food)) return null;
  const amount = extractCountAndUnit(food);
  if (!amount || amount.unit || amount.count === 1) return null;
  const rest = String(food)
    .trim()
    .replace(
      /^(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half)\s+(?:(?:a|an)\s+)?(?:x\s+)?/i,
      ""
    )
    .trim();
  if (!rest || rest.length < 2) return null;
  // "2 large eggs" → "1 large egg"
  const words = rest.split(/\s+/);
  if (amount.count > 1) {
    const last = words[words.length - 1];
    const lower = last.toLowerCase();
    const single = stem(lower);
    if (single !== lower) {
      words[words.length - 1] = lower.startsWith(single) ? last.slice(0, single.length) : single;
    }
  }
  return { count: amount.count, single: `1 ${words.join(" ")}` };
}

/** A lookup through the saved answers, saved when new. */
function cachedResolve(food, country) {
  return lookupFood(food, { country });
}

async function resolveCounted(food, { debug = false, country = DEFAULT_COUNTRY } = {}) {
  const c = countedFood(food);
  if (!c) return null;
  // The admin Food check (debug) looks the single one up fresh too, so it
  // tests the lookup as it is now rather than an answer saved earlier.
  const one = debug
    ? await lookupFood(c.single, { debug: true, country })
    : await cachedResolve(c.single, country);
  if (one.failed || !(Number(one.calories) > 0)) return null;
  const n = c.count;
  const each = one.serving_description || (one.grams ? `${one.grams}g` : one.ml ? `${one.ml}ml` : "1");
  const amountLabel = n === 0.5 ? "½" : String(Math.round(n * 100) / 100);
  return {
    ...one,
    mode: "serving",
    grams: one.grams ? Math.round(one.grams * n) : null,
    ml: one.ml ? Math.round(one.ml * n) : null,
    serving_description: `${amountLabel} × ${each}`,
    calories: Math.round(Number(one.calories) * n),
    protein: round1((Number(one.protein) || 0) * n),
    carbs: round1((Number(one.carbs) || 0) * n),
    fat: round1((Number(one.fat) || 0) * n),
    ...(debug
      ? {
          debug: {
            via: `counted: ${n} × "${c.single}"${one.basis ? ` (${one.basis})` : ` (${one.source})`}`,
          },
        }
      : {}),
  };
}

// -------------------- Food check (admins) --------------------
// The foods in benchmark/foods.json, looked up live one at a time by the
// app's admin-only Food check screen, so lookup accuracy can be checked on
// the real server without setting anything up. Skips the saved answers,
// so it always tests the current lookup.
const FOOD_CHECK = (() => {
  try {
    const raw = readFileSync(new URL("./benchmark/foods.json", import.meta.url), "utf8");
    return JSON.parse(raw).foods || [];
  } catch (err) {
    console.warn("Food check list not loaded:", err.message);
    return [];
  }
})();

app.get("/admin/food-check", requireFirebaseUser, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Not allowed." });
  res.json({
    foods: FOOD_CHECK.map((f) => ({
      query: f.query,
      kcal: f.kcal,
      protein: f.protein,
      carbs: f.carbs,
      fat: f.fat,
      ref: f.ref || "",
      tolerance: f.tolerance ?? 15,
    })),
  });
});

app.post("/admin/food-check", requireFirebaseUser, ensureFatSecretToken, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Not allowed." });
  const index = Number(req.body?.index);
  const f = Number.isInteger(index) ? FOOD_CHECK[index] : null;
  if (!f) return res.status(400).json({ error: "No food at that number." });
  try {
    const r = await resolveFood(f.query, { debug: true });
    const kcal = Number(r.calories) || 0;
    const diff = f.kcal ? ((kcal - f.kcal) / f.kcal) * 100 : 0;
    const tolerance = f.tolerance ?? 15;
    res.json({
      index,
      kcal: Math.round(kcal),
      protein: round1(Number(r.protein) || 0),
      carbs: round1(Number(r.carbs) || 0),
      fat: round1(Number(r.fat) || 0),
      diff: round1(diff),
      ok: !r.failed && Math.abs(diff) <= tolerance,
      failed: !!r.failed,
      source: r.source || "",
      name: r.name || "",
      portion: r.serving_description || (r.grams ? `${r.grams}g` : r.ml ? `${r.ml}ml` : ""),
      why: [
        r.debug?.reason || r.debug?.via,
        r.basis && `worked out: ${r.basis}`,
        r.check && `CHECK: ${r.check}`,
        r.debug?.primary?.reason && `first try: ${r.debug.primary.reason}`,
        r.debug?.error,
      ]
        .filter(Boolean)
        .join("; "),
    });
  } catch (err) {
    console.error("Food check failed:", err.message || err);
    res.status(502).json({ error: "Lookup failed" });
  }
});

// -------------------- Saved lookups (Firestore) --------------------
// The in-memory cache is wiped on every deploy, so answers are also kept
// in Firestore: the same food gives the same numbers every time (not a
// slightly different AI guess each week), and isn't paid for twice.
// Bump RESOLVE_VERSION when the lookup logic changes, so old answers are
// looked up again. Server-only: under meta/, which the app can't read.
const RESOLVE_VERSION = 15;
const SAVED_LOOKUP_DAYS = 60;

function savedLookups() {
  return getFirestore().collection("meta").doc("food_cache").collection("items");
}

/** The saved answer's key: the words as typed, in that country. */
function savedKey(country, food) {
  return `${country}|${normalizeFood(food)}`;
}

function savedLookupId(key) {
  return createHash("sha1").update(key).digest("hex");
}

async function readSavedLookup(key) {
  if (!SERVICE_ACCOUNT) return null;
  try {
    const snap = await savedLookups().doc(savedLookupId(key)).get();
    const d = snap.data();
    if (!d || d.version !== RESOLVE_VERSION || !d.result) return null;
    const saved = d.saved_at?.toMillis?.() ?? 0;
    if (Date.now() - saved > SAVED_LOOKUP_DAYS * 24 * 60 * 60 * 1000) return null;
    return d.result;
  } catch (err) {
    console.warn("Saved lookup read failed:", err.message);
    return null;
  }
}

function saveLookup(key, food, result) {
  if (!SERVICE_ACCOUNT) return;
  savedLookups()
    .doc(savedLookupId(key))
    // Firestore refuses undefined fields; a JSON round trip drops them.
    .set({
      food: normalizeFood(food),
      country: key.split("|")[0],
      version: RESOLVE_VERSION,
      result: JSON.parse(JSON.stringify(result)),
      saved_at: FieldValue.serverTimestamp(),
    })
    .catch((err) => console.warn("Saving lookup failed:", err.message));
}

// -------------------- Saved foods (any amount) --------------------
// Each food once, any amount of it worked out with arithmetic: see
// food_base.js. Kept for half a year, and started afresh whenever the
// lookup itself changes (RESOLVE_VERSION).
const FOOD_BASE_DAYS = 180;

/** People who corrected a saved food before it's looked up again. */
const CORRECTIONS_TO_FORGET = 3;

function foodBaseRef(key, country) {
  return getFirestore()
    .collection("meta")
    .doc("food_base")
    .collection("items")
    .doc(savedLookupId(`${country}|${key}`));
}

async function fromFoodBase(food, country) {
  if (!SERVICE_ACCOUNT) return null;
  const parsed = parseFood(food);
  if (!parsed) return null;
  try {
    const d = (await foodBaseRef(parsed.key, country).get()).data();
    if (!d || d.version !== RESOLVE_VERSION || d.key !== parsed.key) return null;
    const saved = d.saved_at?.toMillis?.() ?? 0;
    if (Date.now() - saved > FOOD_BASE_DAYS * 24 * 60 * 60 * 1000) return null;
    return serve(parsed, food, d);
  } catch (err) {
    console.warn("Saved food read failed:", err.message);
    return null;
  }
}

/** Adds what a fresh answer says about the food to its saved record. */
function learnFoodBase(food, result, country) {
  if (!SERVICE_ACCOUNT) return;
  const parsed = parseFood(food);
  const fields = learn(parsed, result);
  if (!fields) return;
  const ref = foodBaseRef(parsed.key, country);
  getFirestore()
    .runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data();
      const data = {
        ...JSON.parse(JSON.stringify(fields)),
        key: parsed.key,
        country,
        version: RESOLVE_VERSION,
        saved_at: FieldValue.serverTimestamp(),
      };
      // An older lookup's record (or another food's, in the unlikely
      // event of the same id) is replaced, not mixed in.
      if (!d || d.version !== RESOLVE_VERSION || d.key !== parsed.key) tx.set(ref, data);
      else tx.set(ref, data, { merge: true });
    })
    .catch((err) => console.warn("Saving food failed:", err.message));
}

/** Clears remembered answers in memory (after a saved food is dropped). */
function clearMemoryLookups() {
  for (const k of cache.keys()) if (k.startsWith("resolve:")) cache.del(k);
}

/** Drops the saved answers for this text and for its food. */
async function forgetFood(food, country) {
  const parsed = parseFood(food);
  const jobs = [];
  if (SERVICE_ACCOUNT) {
    jobs.push(savedLookups().doc(savedLookupId(savedKey(country, food))).delete());
    if (parsed) jobs.push(foodBaseRef(parsed.key, country).delete());
  }
  await Promise.all(jobs);
  clearMemoryLookups();
  return { food: normalizeFood(food), country, saved_food: parsed?.key ?? null };
}

const feedbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: "Slow down a little." },
});

// Someone fixed the calories of a looked-up food. When enough different
// people correct the same saved answer, it's dropped and looked up afresh
// next time, so one bad answer can't stick for everyone.
// Body: { food, calories } (calories for exactly what was typed, ×1).
app.post("/food/feedback", requireFirebaseUser, feedbackLimiter, async (req, res) => {
  const uid = req.user?.uid;
  const food = typeof req.body?.food === "string" ? req.body.food : "";
  const calories = Number(req.body?.calories);
  if (!uid || !food.trim() || food.length > 200 || !Number.isFinite(calories) || calories < 0) {
    return res.status(400).json({ error: "Which food?" });
  }
  if (!SERVICE_ACCOUNT) return res.json({ counted: false });
  try {
    const country = normCountry(req.body?.country);
    const key = savedKey(country, food);
    const served = (await readSavedLookup(key)) || (await fromFoodBase(food, country));
    const was = Number(served?.calories);
    // Nothing saved, or close enough to what we said: nothing to fix.
    if (!(was > 0) || Math.abs(calories - was) <= Math.max(was * 0.15, 20)) {
      return res.json({ counted: false });
    }
    const parsed = parseFood(food);
    // Who corrected it, as a one-way hash: only needed to count people.
    const who = savedLookupId(`fix:${uid}`);
    const refs = [savedLookups().doc(savedLookupId(key))];
    if (parsed) refs.push(foodBaseRef(parsed.key, country));
    let forgot = false;
    await getFirestore().runTransaction(async (tx) => {
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));
      const by = new Set(snaps.flatMap((s) => (Array.isArray(s.data()?.corrected_by) ? s.data().corrected_by : [])));
      by.add(who);
      forgot = by.size >= CORRECTIONS_TO_FORGET;
      snaps.forEach((snap, i) => {
        if (!snap.exists) return;
        if (forgot) tx.delete(refs[i]);
        else tx.update(refs[i], { corrected_by: FieldValue.arrayUnion(who) });
      });
    });
    if (forgot) {
      clearMemoryLookups();
      countEvent("food_saved_dropped");
    }
    return res.json({ counted: true, forgot });
  } catch (err) {
    console.warn("Food feedback failed:", err.message);
    return res.json({ counted: false });
  }
});

// Admin: saved answers people have corrected, most corrected first, for
// the Food check screen (each one is a food the lookup got wrong for
// someone: worth a look, and worth adding to the accuracy test).
app.get("/admin/food-corrections", requireFirebaseUser, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Not allowed." });
  if (!SERVICE_ACCOUNT) return res.json({ foods: [] });
  try {
    const corrected = (col) => col.where("corrected_by", "!=", null).limit(100).get();
    const [texts, foods] = await Promise.all([
      corrected(savedLookups()),
      corrected(getFirestore().collection("meta").doc("food_base").collection("items")),
    ]);
    const people = (d) => (Array.isArray(d.corrected_by) ? d.corrected_by.length : 0);
    const out = [
      ...texts.docs.map((doc) => {
        const d = doc.data();
        return { food: String(d.food || ""), country: String(d.country || DEFAULT_COUNTRY), kind: "text", people: people(d),
          calories: Math.round(Number(d.result?.calories) || 0), source: String(d.result?.source || "") };
      }),
      ...foods.docs.map((doc) => {
        const d = doc.data();
        return { food: String(d.key || ""), country: String(d.country || DEFAULT_COUNTRY), kind: "food", people: people(d),
          calories: null, source: String(d.source || "") };
      }),
    ]
      .filter((f) => f.food && f.people > 0)
      .sort((a, b) => b.people - a.people);
    return res.json({ foods: out });
  } catch (err) {
    console.error("Food corrections failed:", err.message);
    return res.status(502).json({ error: "Couldn't load corrections" });
  }
});

// Admin: drop a saved food now ("Forget saved answer" on Food check).
app.post("/admin/food-forget", requireFirebaseUser, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Not allowed." });
  const food = typeof req.body?.food === "string" ? req.body.food.trim() : "";
  if (!food || food.length > 200) return res.status(400).json({ error: "Which food?" });
  try {
    return res.json({ forgot: await forgetFood(food, normCountry(req.body?.country)) });
  } catch (err) {
    console.error("Forgetting food failed:", err.message);
    return res.status(502).json({ error: "Couldn't forget that" });
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

    // Same limits as the app (lib/services/profile_limits.dart).
    if (!Number.isFinite(ageNum) || ageNum < 13 || ageNum > 120) {
      return res.status(400).json({ error: "age must be 13–120" });
    }
    if (!Number.isFinite(heightCm) || heightCm < 100 || heightCm > 250) {
      return res.status(400).json({ error: "height_cm must be 100–250" });
    }
    if (!Number.isFinite(weightKg) || weightKg < 30 || weightKg > 350) {
      return res.status(400).json({ error: "weight_kg must be 30–350" });
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
// ["150g grilled tofu", "1 cup white rice"]. The app then looks
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
            '(e.g. "150g grilled tofu", "1 slice toast with peanut butter", "330ml cola"). ' +
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
  "You are Calorie Coach, the friendly assistant inside The Calorie Card, a calorie-tracking app",
  "where the daily calorie budget works like a bank card balance (calories left = money left to spend).",
  "",
  "Tone: warm, upbeat, non-judgemental, practical. British English (reply in the person's language if they",
  "write in another). Talk like a supportive friend, not a",
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
  "Dining out and drinks nights (the app's 'Dining out' and 'Drinks night out' buttons send these):",
  "Give a short, scannable plan built around their calories left (from the context, or the number they",
  "give). For dining out: 4-6 specific dishes or combos that suit that kind of place (or that chain's",
  "menu, if named), each with a rough kcal estimate, grouped as 'fits easily' / 'a bit of a treat';",
  "plus 2-3 practical tips (sharing a starter or dessert, sauces and sides, bread, swapping chips for",
  "salad or half and half). It's fine to suggest the dish they'll really enjoy and fitting the rest around",
  "it. For drinks: rough kcal per drink for what they're having (e.g. pint of 4% lager ~180, 175ml wine",
  "~160, single spirit with a diet mixer ~60, most cocktails 150-300), how many roughly fit alongside",
  "food, and lower-calorie swaps; remind them to eat a proper meal first and alternate with water. Never",
  "suggest skipping meals to 'save' calories for alcohol. Don't encourage heavy drinking; if they plan a",
  "big night, it's fine to mention their country's low-risk drinking guideline (in the UK: no more than 14",
  "units a week, spread out).",
  "If they'll go over, say so kindly and suggest the most enjoyable way to do it rather than forbidding it.",
  "These answers may be a little longer (a short list is fine). Offer to log it when they get back.",
  "",
  "Safety rules (never break these):",
  "- Never suggest skipping meals, fasting to compensate, eating below about 1200 kcal (women) or",
  "  1500 kcal (men) a day, purging, laxatives, diet pills, or exercising to 'burn off' food.",
  "- Never shame, moralise about food, or call foods 'bad' or 'cheat' foods.",
  "- If the user mentions restricting heavily, bingeing and purging, feeling out of control around food,",
  "  intense guilt about eating, or self-harm, respond with care, don't give calorie advice, and gently",
  "  suggest talking to someone they trust or their doctor; in the UK, Beat (the eating disorder charity) has",
  "  a helpline at beateatingdisorders.org.uk, and Samaritans can be reached on 116 123 any time;",
  "  elsewhere, point to that country's eating disorder charity or crisis line if you know it.",
  "- For medical conditions, pregnancy, medication or diabetes, keep it general and suggest their GP or a",
  "  registered dietitian.",
  "- Don't invent numbers you weren't given; estimate food calories roughly and say they're estimates.",
  "- Stay on topic (food, nutrition, habits, the app). Politely steer back if asked about other things.",
  "",
  "Changing their diary and recipes:",
  "You can PROPOSE changes; the app shows each one as a summary card with Accept / Reject, and nothing",
  "changes until the user accepts. Only propose a change when the user clearly asks for it (e.g. 'add 2",
  "crumpets to breakfast', 'log my chilli for dinner', 'remove the crisps', 'save this as a recipe'). If you",
  "suggested a meal and they say 'add that', propose it. If something important is unclear (which meal,",
  "how much), ask instead of guessing wildly; otherwise use sensible everyday portions.",
  "In 'reply', say briefly what you've put together (e.g. 'Here you go, tap Accept to add it.'). Don't",
  "claim anything has been added yet. The app works out the calories itself, so don't list numbers for",
  "proposed items unless asked.",
  "",
  "Always answer with a JSON object: {\"reply\": string, \"actions\": [ ... ]} (actions may be empty).",
  "Action types (at most 3 per answer):",
  '- {"type":"log_food","meal":"Breakfast|Lunch|Dinner|Snacks","items":["150g scrambled tofu","1 slice',
  '  wholemeal toast with vegan spread"]}  items are plain food descriptions WITH amounts, one food each (max 10).',
  '- {"type":"log_recipe","recipe_id":"<id from context.recipes>","meal":"...","servings":1}',
  '- {"type":"remove_food","entry_ids":["<id from context.entries_today>", ...]}',
  '- {"type":"create_recipe","name":"Tofu stir fry","servings":2,"ingredients":["300g firm tofu",',
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
  countEvent("coach_message");

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
            `The person is in ${placeName(normCountry(req.body?.country))}: suggest foods, chains, ` +
            "portion sizes and services as they are there.",
        },
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
