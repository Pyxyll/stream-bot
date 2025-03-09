// user-auth.js - User OAuth implementation for follow events

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// Define the scopes needed for follow events
const TWITCH_USER_SCOPES = [
  'moderator:read:followers',
  'channel:read:subscriptions'
].join(' ');

// Route to initiate OAuth flow for user token
router.get('/auth/user-token', (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const redirectUri = `${process.env.PUBLIC_URL}/auth/twitch/callback`;
  const responseType = 'code';
  
  const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=${responseType}&scope=${encodeURIComponent(TWITCH_USER_SCOPES)}&force_verify=true`;
  
  res.redirect(authUrl);
});

// OAuth callback route
router.get('/auth/twitch/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  
  if (error) {
    return res.status(400).send(`
      <h1>Authentication Error</h1>
      <p>Error: ${error}</p>
      <p>Description: ${error_description}</p>
      <p><a href="/">Return to dashboard</a></p>
    `);
  }
  
  if (!code) {
    return res.status(400).send(`
      <h1>Authentication Error</h1>
      <p>Authorization code not provided</p>
      <p><a href="/">Return to dashboard</a></p>
    `);
  }
  
  try {
    // Exchange code for access token
    const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${process.env.PUBLIC_URL}/auth/twitch/callback`
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
    
    // Store tokens in .env file (for development only - use a proper database for production)
    const envPath = path.resolve(process.cwd(), '.env');
    
    try {
      let envContent = fs.readFileSync(envPath, 'utf8');
      
      // Update environment variables in the file
      if (envContent.includes('TWITCH_USER_TOKEN=')) {
        envContent = envContent.replace(/TWITCH_USER_TOKEN=.*/g, `TWITCH_USER_TOKEN=${access_token}`);
      } else {
        envContent += `\nTWITCH_USER_TOKEN=${access_token}`;
      }
      
      if (envContent.includes('TWITCH_USER_REFRESH_TOKEN=')) {
        envContent = envContent.replace(/TWITCH_USER_REFRESH_TOKEN=.*/g, `TWITCH_USER_REFRESH_TOKEN=${refresh_token}`);
      } else {
        envContent += `\nTWITCH_USER_REFRESH_TOKEN=${refresh_token}`;
      }
      
      fs.writeFileSync(envPath, envContent);
      
      // Set the tokens directly in process.env
      process.env.TWITCH_USER_TOKEN = access_token;
      process.env.TWITCH_USER_REFRESH_TOKEN = refresh_token;
      
      // Set up follow subscription
      const result = await setupFollowSubscription(userData.id);
      
      if (result.success) {
        res.send(`
          <h1>Authentication Successful!</h1>
          <p>Authenticated as: ${userData.display_name}</p>
          <p>Follow events have been set up successfully!</p>
          <p><a href="/">Return to dashboard</a></p>
        `);
      } else {
        res.send(`
          <h1>Authentication Successful!</h1>
          <p>Authenticated as: ${userData.display_name}</p>
          <p>Token saved, but there was an error setting up follow events:</p>
          <p>${result.message || JSON.stringify(result.error)}</p>
          <p><a href="/">Return to dashboard</a></p>
        `);
      }
    } catch (error) {
      console.error('Error updating .env file:', error);
      
      // Set the tokens directly in process.env even if file save fails
      process.env.TWITCH_USER_TOKEN = access_token;
      process.env.TWITCH_USER_REFRESH_TOKEN = refresh_token;
      
      const result = await setupFollowSubscription(userData.id);
      
      if (result.success) {
        res.send(`
          <h1>Authentication Successful!</h1>
          <p>Authenticated as: ${userData.display_name}</p>
          <p>Follow events have been set up successfully!</p>
          <p>Note: Could not save token to .env file.</p>
          <p><a href="/">Return to dashboard</a></p>
        `);
      } else {
        res.send(`
          <h1>Authentication Successful!</h1>
          <p>Authenticated as: ${userData.display_name}</p>
          <p>Token saved in memory, but there was an error setting up follow events:</p>
          <p>${result.message || JSON.stringify(result.error)}</p>
          <p><a href="/">Return to dashboard</a></p>
        `);
      }
    }
  } catch (error) {
    console.error('Error during OAuth callback:', error);
    res.status(500).send(`
      <h1>Authentication Failed</h1>
      <p>Error: ${error.message}</p>
      <p><a href="/">Return to dashboard</a></p>
    `);
  }
});

// Setup follow subscription
async function setupFollowSubscription(userId) {
  try {
    // Get the app token for webhook setup
    const appToken = process.env.TWITCH_APP_ACCESS_TOKEN;
    
    if (!appToken) {
      return { success: false, error: 'No app access token available' };
    }
    
    // Check if we have required variables
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_WEBHOOK_SECRET || !process.env.PUBLIC_URL) {
      return { success: false, error: 'Missing required configuration' };
    }
    
    // Make sure we have a valid broadcaster ID
    if (!userId) {
      return { success: false, error: 'No broadcaster ID provided' };
    }
    
    // Get all current subscriptions first to check if one already exists
    try {
      const subResponse = await axios.get('https://api.twitch.tv/helix/eventsub/subscriptions', {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${appToken}`
        }
      });
      
      // Check if a follow subscription already exists for this broadcaster
      const existingFollowSub = subResponse.data.data.find(sub => 
        sub.type === 'channel.follow' && 
        sub.condition.broadcaster_user_id === userId
      );
      
      if (existingFollowSub) {
        return { 
          success: true, 
          data: existingFollowSub,
          message: 'Follow events were already set up' 
        };
      }
    } catch (error) {
      console.error('Error checking existing subscriptions:', error.response?.data || error.message);
    }
    
    // Try with version 1 first
    try {
      const subscriptionData = {
        type: 'channel.follow',
        version: '1',
        condition: {
          broadcaster_user_id: userId
        },
        transport: {
          method: 'webhook',
          callback: `${process.env.PUBLIC_URL}/webhook/twitch`,
          secret: process.env.TWITCH_WEBHOOK_SECRET
        }
      };
      
      const response = await axios.post(
        'https://api.twitch.tv/helix/eventsub/subscriptions', 
        subscriptionData, 
        {
          headers: {
            'Client-ID': process.env.TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${appToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      return { success: true, data: response.data };
    } catch (errorV1) {
      // If version 1 fails, try version 2
      try {
        const subscriptionData = {
          type: 'channel.follow',
          version: '2',
          condition: {
            broadcaster_user_id: userId,
            moderator_user_id: userId
          },
          transport: {
            method: 'webhook',
            callback: `${process.env.PUBLIC_URL}/webhook/twitch`,
            secret: process.env.TWITCH_WEBHOOK_SECRET
          }
        };
        
        const response = await axios.post(
          'https://api.twitch.tv/helix/eventsub/subscriptions', 
          subscriptionData, 
          {
            headers: {
              'Client-ID': process.env.TWITCH_CLIENT_ID,
              'Authorization': `Bearer ${appToken}`,
              'Content-Type': 'application/json'
            }
          }
        );
        
        return { success: true, data: response.data };
      } catch (errorV2) {
        return { 
          success: false, 
          error: 'Could not set up follow events',
          details: {
            v1Error: errorV1.response?.data || errorV1.message,
            v2Error: errorV2.response?.data || errorV2.message
          }
        };
      }
    }
  } catch (error) {
    return { 
      success: false, 
      error: error.response?.data || error.message
    };
  }
}

// Route to check token status (simplified version)
router.get('/auth/token-status', (req, res) => {
  const userToken = process.env.TWITCH_USER_TOKEN;
  
  let tokenStatus = userToken ? 'Available' : 'Not available';
  
  res.send(`
    <h1>Twitch Authorization Status</h1>
    <p>User Token: ${tokenStatus}</p>
    
    <p><a href="/auth/user-token" style="
      display: inline-block;
      background: #6441A4;
      color: white;
      padding: 10px 15px;
      text-decoration: none;
      border-radius: 4px;
      font-weight: bold;
      margin-right: 10px;
    ">Authorize with Twitch</a>
    
    <a href="/" style="
      display: inline-block;
      padding: 10px 15px;
      text-decoration: none;
    ">Back to Dashboard</a></p>
  `);
});

module.exports = { router, setupFollowSubscription };