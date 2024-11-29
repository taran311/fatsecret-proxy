const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const compression = require('compression'); // Enable compression
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(compression()); // Compress responses

// Enable CORS
app.use(
  cors({
    origin: [
      'https://thecaloriecard.com', // Production domain
      'http://localhost:3000', // Local development
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

const FATSECRET_API_URL = 'https://platform.fatsecret.com/rest/server.api';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// Cache for storing API responses
const cache = new NodeCache({ stdTTL: 300 }); // Cache duration: 5 minutes

let accessToken = null;
let tokenExpirationTime = null; // Track token expiration

// Function to fetch a new access token
const getAccessToken = async () => {
  try {
    console.log('Fetching new access token...');
    const response = await axios.post(
      'https://oauth.fatsecret.com/connect/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: 'basic', // Ensure the 'basic' scope is included
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    accessToken = response.data.access_token;
    tokenExpirationTime = Date.now() + response.data.expires_in * 1000; // Set expiration time
    console.log('Access token fetched successfully:', accessToken);
  } catch (err) {
    console.error('Error fetching access token:', err.response?.data || err.message);
    throw new Error('Failed to fetch access token');
  }
};

// Middleware to ensure a valid access token
app.use(async (req, res, next) => {
  if (!accessToken || Date.now() >= tokenExpirationTime) {
    try {
      await getAccessToken();
    } catch (err) {
      console.error('Failed to refresh access token:', err.message);
      return res.status(500).json({ error: 'Failed to fetch access token' });
    }
  }
  next();
});

// Endpoint for health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Endpoint for foods.search
app.get('/foods/search/v1', async (req, res) => {
  const { search_expression, max_results, format } = req.query;
  const cacheKey = `${search_expression}-${max_results}-${format}`;

  // Check if data is cached
  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    console.log('Serving data from cache:', cacheKey);
    return res.json(cachedData);
  }

  try {
    const response = await axios.get(FATSECRET_API_URL, {
      params: {
        method: 'foods.search',
        search_expression,
        max_results,
        format,
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    // Cache the response
    cache.set(cacheKey, response.data);
    res.json(response.data);
  } catch (err) {
    console.error('Error forwarding request:', err.response?.data || err.message);

    if (err.response?.status === 401) {
      // Retry on token expiration
      console.log('Access token expired. Refreshing...');
      try {
        await getAccessToken();
        const retryResponse = await axios.get(FATSECRET_API_URL, {
          params: {
            method: 'foods.search',
            search_expression,
            max_results,
            format,
          },
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        // Cache the retry response
        cache.set(cacheKey, retryResponse.data);
        return res.json(retryResponse.data);
      } catch (retryError) {
        console.error('Failed after refreshing token:', retryError.message);
        return res.status(500).json({ error: 'Failed to retry request after refreshing token' });
      }
    }

    res.status(err.response?.status || 500).json(err.response?.data || { error: 'Internal Server Error' });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Keep-alive pings
  setInterval(() => {
    console.log('Sending keep-alive ping to /health');
    axios
      .get(`http://localhost:${PORT}/health`)
      .then(() => console.log('Keep-alive ping successful'))
      .catch((err) => console.error('Keep-alive ping failed:', err.message));
  }, 5 * 60 * 1000); // Every 5 minutes
});
