const express = require('express');
const axios = require('axios');
const cors = require('cors');
const compression = require('compression');
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(compression());

// =====================
// CORS (FIXED FOR FLUTTER WEB)
// =====================
const PROD_DOMAIN = 'https://thecaloriecard.com';

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser tools (curl, server-to-server)
      if (!origin) return callback(null, true);

      // Allow ANY localhost port (Flutter Web uses random ports)
      if (origin.startsWith('http://localhost')) {
        return callback(null, true);
      }

      // Allow production domain
      if (origin === PROD_DOMAIN) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked origin: ${origin}`));
    },
    credentials: true,
  })
);

// =====================
// CONSTANTS
// =====================
const FATSECRET_API_URL = 'https://platform.fatsecret.com/rest/server.api';
const TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing CLIENT_ID or CLIENT_SECRET');
  process.exit(1);
}

// =====================
// CACHE
// =====================
const cache = new NodeCache({ stdTTL: 300 }); // 5 minutes

// =====================
// TOKEN STATE (RACE-SAFE)
// =====================
let accessToken = null;
let tokenExpiresAt = 0;
let tokenPromise = null;

// =====================
// TOKEN FETCH
// =====================
async function fetchAccessToken() {
  if (tokenPromise) return tokenPromise;

  tokenPromise = axios
    .post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: 'basic',
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    )
    .then((res) => {
      accessToken = res.data.access_token;
      tokenExpiresAt = Date.now() + res.data.expires_in * 1000 - 30_000; // safety buffer
      console.log('✅ FatSecret access token refreshed');
      return accessToken;
    })
    .finally(() => {
      tokenPromise = null;
    });

  return tokenPromise;
}

// =====================
// TOKEN MIDDLEWARE
// =====================
async function ensureToken(req, res, next) {
  try {
    if (!accessToken || Date.now() >= tokenExpiresAt) {
      await fetchAccessToken();
    }
    next();
  } catch (err) {
    console.error('❌ Token error:', err.message);
    res.status(500).json({ error: 'Authentication with FatSecret failed' });
  }
}

app.use(ensureToken);

// =====================
// HEALTH CHECK
// =====================
app.get('/health', (_, res) => {
  res.send('OK');
});

// =====================
// FOOD SEARCH ENDPOINT
// =====================
// Frontend calls:
// GET /foods/search?q=apple
app.get('/foods/search', async (req, res) => {
  const query = req.query.q;
  const maxResults = req.query.max ?? 10;

  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter: q' });
  }

  const cacheKey = `foods:${query}:${maxResults}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const response = await axios.get(FATSECRET_API_URL, {
      params: {
        method: 'foods.search',
        search_expression: query,
        max_results: maxResults,
        format: 'json',
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    cache.set(cacheKey, response.data);
    res.json(response.data);
  } catch (err) {
    console.error(
      '❌ FatSecret request failed:',
      err.response?.data || err.message
    );

    res
      .status(err.response?.status || 500)
      .json({ error: 'Failed to fetch foods' });
  }
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 FatSecret proxy running on port ${PORT}`);
});
