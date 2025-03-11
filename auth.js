// auth.js - OAuth implementation for regular access tokens (with MongoDB)

const express = require('express');
const axios = require('axios');
const router = express.Router();
const db = require('./db'); // Import database functions

// Scopes needed for your bot
const TWITCH_SCOPES = [
  'chat:read',
  'chat:edit',
  'channel:moderate'
].join(' ');

// Route to initiate OAuth flow
router.get('/auth/twitch', (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const redirectUri = `${process.env.BASE_URL}/auth/twitch/callback`;
  const responseType = 'code';
  
  const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=${responseType}&scope=${encodeURIComponent(TWITCH_SCOPES)}`;
  
  res.redirect(authUrl);
});

// OAuth callback route
router.get('/auth/twitch/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  
  if (error) {
    return res.status(400).send(`
      <h1>Authentication Error</h1>
      <p>Error: ${error}</p>
      <p>Description: ${error_description || 'No description provided'}</p>
      <p><a href="/">Return to dashboard</a></p>
    `);
  }
  
  if (!code) {
    return res.status(400).send('Authorization code not provided');
  }
  
  try {
    // Exchange code for access token
    const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${process.env.BASE_URL}/auth/twitch/callback`
      }
    });
    
    const { access_token, refresh_token } = tokenResponse.data;
    
    // Get user info to verify who authenticated
    const userResponse = await axios.get('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Client-Id': process.env.TWITCH_CLIENT_ID
      }
    });
    
    const userData = userResponse.data.data[0];
    
    // Store tokens in MongoDB instead of .env file
    await db.storeToken('TWITCH_ACCESS_TOKEN', access_token);
    await db.storeToken('TWITCH_REFRESH_TOKEN', refresh_token);
    
    // Also update local process.env for current session
    process.env.TWITCH_ACCESS_TOKEN = access_token;
    process.env.TWITCH_REFRESH_TOKEN = refresh_token;
    
    res.send(`
      <h1>Authentication Successful!</h1>
      <p>Authenticated as: ${userData.display_name}</p>
      <p>Your access token has been saved to the database.</p>
      <p>The bot will now be able to connect to Twitch chat.</p>
      <p><a href="/">Return to dashboard</a></p>
    `);
  } catch (error) {
    console.error('Error during OAuth callback:', error);
    res.status(500).send(`
      <h1>Authentication Failed</h1>
      <p>Error: ${error.message}</p>
      <pre>${error.response?.data ? JSON.stringify(error.response.data, null, 2) : error.stack}</pre>
      <p><a href="/">Return to dashboard</a></p>
    `);
  }
});

// Refresh token function - call this periodically to keep tokens valid
async function refreshTwitchToken() {
  try {
    const refreshToken = await db.getToken('TWITCH_REFRESH_TOKEN');
    
    if (!refreshToken) {
      console.log('No refresh token available, skipping token refresh');
      return null;
    }
    
    const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }
    });
    
    const { access_token, refresh_token } = tokenResponse.data;
    
    // Store tokens in MongoDB
    await db.storeToken('TWITCH_ACCESS_TOKEN', access_token);
    
    if (refresh_token) {
      await db.storeToken('TWITCH_REFRESH_TOKEN', refresh_token);
    }
    
    // Update process.env for current session
    process.env.TWITCH_ACCESS_TOKEN = access_token;
    
    if (refresh_token) {
      process.env.TWITCH_REFRESH_TOKEN = refresh_token;
    }
    
    console.log('Twitch token refreshed successfully');
    return access_token;
  } catch (error) {
    console.error('Error refreshing Twitch token:', error.response?.data || error.message);
    return null;
  }
}

// API endpoint to manually trigger token refresh
router.get('/api/refresh-token', async (req, res) => {
  try {
    const result = await refreshTwitchToken();
    
    if (result) {
      res.json({ success: true, message: 'Token refreshed successfully' });
    } else {
      res.status(400).json({ 
        success: false, 
        message: 'Failed to refresh token. Check if refresh token is available.' 
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error refreshing token', 
      error: error.message 
    });
  }
});

// Get current token status
router.get('/api/token-status', async (req, res) => {
  try {
    const accessToken = await db.getToken('TWITCH_ACCESS_TOKEN');
    const refreshToken = await db.getToken('TWITCH_REFRESH_TOKEN');
    
    res.json({
      access_token: accessToken ? 'Available' : 'Not available',
      refresh_token: refreshToken ? 'Available' : 'Not available',
      tokens_in_db: await db.getAllTokens()
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Error getting token status', 
      error: error.message 
    });
  }
});

// Set up token refresh every 3 hours (tokens last for 4 hours)
setInterval(refreshTwitchToken, 3 * 60 * 60 * 1000);
console.log('Token refresh scheduled to run every 3 hours');

module.exports = { router, refreshTwitchToken };