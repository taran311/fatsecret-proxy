const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const FATSECRET_API_URL = 'https://platform.fatsecret.com/rest/server.api';
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

let accessToken = null;

// Function to obtain a new access token
const getAccessToken = async () => {
  try {
    const response = await axios.post('https://oauth.fatsecret.com/connect/token', null, {
      params: {
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: 'basic', // Add this line
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    accessToken = response.data.access_token;
    return accessToken;
  } catch (err) {
    console.error('Error fetching access token:', err.response.data);
    throw err;
  }
};

// Middleware to ensure access token is valid
app.use(async (req, res, next) => {
  if (!accessToken) {
    await getAccessToken();
  }
  next();
});

// Proxy endpoint to forward requests to FatSecret API
app.post('/proxy', async (req, res) => {
  try {
    const response = await axios.post(FATSECRET_API_URL, req.body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    res.json(response.data);
  } catch (err) {
    console.error('Error forwarding request:', err.response.data);
    if (err.response.status === 401) {
      // Access token expired, renew it
      await getAccessToken();
      return res.redirect(req.originalUrl); // Retry the request
    }
    res.status(err.response.status).json(err.response.data);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
