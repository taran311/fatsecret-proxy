const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors'); // Import CORS for handling cross-origin requests
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// Enable CORS
app.use(
  cors({
    origin: [
      'https://thecaloriecard.com', // Allow your production domain
      'http://localhost:3000', // Allow localhost for development
    ],
    methods: ['GET', 'POST'], // Specify allowed methods
    allowedHeaders: ['Content-Type', 'Authorization'], // Specify allowed headers
  })
);

const FATSECRET_API_URL = 'https://platform.fatsecret.com/rest/server.api';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

let accessToken = null;
let tokenExpirationTime = null; // Store expiration time

// Debugging: Log client credentials
console.log('Client ID:', CLIENT_ID);
console.log('Client Secret:', CLIENT_SECRET ? '*****' : 'Not Provided');

// Function to obtain a new access token
const getAccessToken = async () => {
  try {
    console.log('Fetching new access token...');
    const response = await axios.post(
      'https://oauth.fatsecret.com/connect/token',
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
    );
    accessToken = response.data.access_token;
    tokenExpirationTime = Date.now() + response.data.expires_in * 1000; // Set expiration time
    console.log('Access token fetched successfully.');
    return accessToken;
  } catch (err) {
    console.error('Error fetching access token:', err.response?.data || err.message);
    throw err;
  }
};

// Middleware to ensure access token is valid
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

// Proxy endpoint for foods.search/v1
app.get('/foods/search/v1', async (req, res) => {
  const { search_expression, max_results, format } = req.query;

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

    res.json(response.data);
  } catch (err) {
    console.error('Error forwarding request:', err.response?.data || err.message);

    if (err.response?.status === 401) {
      // Access token expired, renew it
      console.log('Access token expired. Renewing...');
      try {
        await getAccessToken();
        // Retry the request after refreshing the token
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
});
