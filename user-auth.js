const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const db = require('./db'); // Import the database module

// Define the scopes needed for follow events
const TWITCH_USER_SCOPES = [
  'moderator:read:followers',
  'channel:read:subscriptions',
  'chat:read',
  'chat:edit'
].join(' ');

// Route to initiate OAuth flow for user token
// In your user-auth.js file, add this to the auth endpoint
router.get('/auth/user-token', (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const redirectUri = `${process.env.PUBLIC_URL}/auth/twitch/callback`;
  const responseType = 'code';
  
  const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=${responseType}&scope=${encodeURIComponent(TWITCH_USER_SCOPES)}&force_verify=true`;
  
  // Show a page explaining what permissions are being requested
  res.send(`
    <h1>Twitch Authorization Required</h1>
    <p>The bot needs the following permissions:</p>
    <ul>
      <li><strong>moderator:read:followers</strong> - For follow event notifications</li>
      <li><strong>channel:read:subscriptions</strong> - For subscription data</li>
      <li><strong>chat:read</strong> - To read messages in your chat</li>
      <li><strong>chat:edit</strong> - To send messages as your bot</li>
    </ul>
    <p>Please make sure to accept ALL requested permissions on the next screen.</p>
    <p>
      <a href="${authUrl}" style="
        display: inline-block;
        background: #6441A4;
        color: white;
        padding: 10px 20px;
        text-decoration: none;
        border-radius: 4px;
        font-weight: bold;
      ">Continue to Twitch Authorization</a>
    </p>
  `);
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
    
    // Store tokens in process.env for immediate use
    process.env.TWITCH_USER_TOKEN = access_token;
    process.env.TWITCH_USER_REFRESH_TOKEN = refresh_token;
    
    // Save tokens to persistent storage
    let tokensStoredSuccessfully = false;
    
    try {
      // Save to database
      await db.saveToken('TWITCH_USER_TOKEN', access_token);
      await db.saveToken('TWITCH_USER_REFRESH_TOKEN', refresh_token);
      tokensStoredSuccessfully = true;
      console.log('Tokens saved to database successfully');
      
      // Also try to save to .env file if in development
      if (process.env.NODE_ENV === 'development') {
        const envPath = path.resolve(process.cwd(), '.env');
        let envContent = fs.readFileSync(envPath, 'utf8');
        
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
        console.log('Tokens also saved to .env file');
      }
    } catch (error) {
      console.error('Error saving tokens to persistent storage:', error);
    }
    
    // Set up follow subscription
    const result = await setupFollowSubscription(userData.id);
    
    if (result.success) {
      res.send(`
        <h1>Authentication Successful!</h1>
        <p>Authenticated as: ${userData.display_name}</p>
        <p>Follow events have been set up successfully!</p>
        
        ${!tokensStoredSuccessfully ? `
        <div style="margin: 20px 0; padding: 15px; background: #fff8e8; border-left: 4px solid #ffcc00;">
          <strong>Note:</strong> Your tokens could not be saved to persistent storage.
          If the server restarts, you may need to re-authenticate.
        </div>
        ` : `
        <div style="margin: 20px 0; padding: 15px; background: #e8ffe8; border-left: 4px solid green;">
          <strong>Success:</strong> Your tokens have been saved to persistent storage.
          They will be automatically loaded when the server restarts.
        </div>
        `}
        
        <p><a href="/" style="
          display: inline-block;
          background: #6441A4;
          color: white;
          padding: 10px 15px;
          text-decoration: none;
          border-radius: 4px;
          font-weight: bold;
        ">Return to Dashboard</a></p>
      `);
    } else {
      res.send(`
        <h1>Authentication Partially Successful</h1>
        <p>Authenticated as: ${userData.display_name}</p>
        <p>Token saved, but there was an error setting up follow events:</p>
        <p>${result.message || JSON.stringify(result.error)}</p>
        
        ${!tokensStoredSuccessfully ? `
        <div style="margin: 20px 0; padding: 15px; background: #fff8e8; border-left: 4px solid #ffcc00;">
          <strong>Note:</strong> Your tokens could not be saved to persistent storage.
          If the server restarts, you may need to re-authenticate.
        </div>
        ` : `
        <div style="margin: 20px 0; padding: 15px; background: #e8ffe8; border-left: 4px solid green;">
          <strong>Success:</strong> Your tokens have been saved to persistent storage.
          They will be automatically loaded when the server restarts.
        </div>
        `}
        
        <p><a href="/" style="
          display: inline-block;
          background: #6441A4;
          color: white;
          padding: 10px 15px;
          text-decoration: none;
          border-radius: 4px;
          font-weight: bold;
        ">Return to Dashboard</a></p>
      `);
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

// Route to check token status
router.get('/auth/token-status', async (req, res) => {
  const userToken = process.env.TWITCH_USER_TOKEN;
  
  // Try to get token from database if not in memory
  let dbToken = null;
  if (!userToken) {
    try {
      dbToken = await db.getToken('TWITCH_USER_TOKEN');
      if (dbToken) {
        // If found in DB but not in memory, load it into memory
        process.env.TWITCH_USER_TOKEN = dbToken;
      }
    } catch (err) {
      console.error('Error retrieving token from database:', err);
    }
  }
  
  const tokenStatus = userToken || dbToken ? 'Available' : 'Not available';
  const tokenSource = userToken ? 'memory' : (dbToken ? 'database' : 'none');
  
  res.send(`
    <h1>Twitch Authorization Status</h1>
    <p>User Token: ${tokenStatus} (from ${tokenSource})</p>
    
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

// Helper function to refresh tokens when needed
async function refreshUserToken() {
  const refreshToken = process.env.TWITCH_USER_REFRESH_TOKEN;
  
  if (!refreshToken) {
    console.log('No refresh token available');
    return null;
  }
  
  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }
    });
    
    const { access_token, refresh_token } = response.data;
    
    // Update tokens in memory
    process.env.TWITCH_USER_TOKEN = access_token;
    if (refresh_token) {
      process.env.TWITCH_USER_REFRESH_TOKEN = refresh_token;
    }
    
    // Save to database
    try {
      await db.saveToken('TWITCH_USER_TOKEN', access_token);
      if (refresh_token) {
        await db.saveToken('TWITCH_USER_REFRESH_TOKEN', refresh_token);
      }
      console.log('Refreshed tokens saved to database');
    } catch (error) {
      console.error('Error saving refreshed tokens to database:', error);
    }
    
    return access_token;
  } catch (error) {
    console.error('Error refreshing token:', error.response?.data || error.message);
    return null;
  }
}

outer.get('/auth/chat-token', (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const redirectUri = `${process.env.PUBLIC_URL}/auth/chat-callback`;
  const responseType = 'code';
  
  // Only request chat scopes
  const chatScopes = 'chat:read chat:edit';
  
  const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=${responseType}&scope=${encodeURIComponent(chatScopes)}&force_verify=true`;
  
  res.redirect(authUrl);
});

// Callback for chat token
router.get('/auth/chat-callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).send('No authorization code provided');
  }
  
  try {
    // Exchange code for token
    const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${process.env.PUBLIC_URL}/auth/chat-callback`
      }
    });
    
    const { access_token } = tokenResponse.data;
    
    // Save to database
    await db.saveToken('TWITCH_CHAT_TOKEN', access_token);
    
    // Set in environment
    process.env.TWITCH_CHAT_TOKEN = access_token;
    
    // Try to connect to chat immediately
    if (global.connectChat) {
      global.connectChat(access_token);
    }
    
    res.send(`
      <h1>Chat Authentication Successful!</h1>
      <p>Your chat token has been saved. The bot should now be able to connect to chat.</p>
      <p><a href="/">Return to Dashboard</a></p>
    `);
  } catch (error) {
    console.error('Error getting chat token:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

module.exports = { router, setupFollowSubscription, refreshUserToken };