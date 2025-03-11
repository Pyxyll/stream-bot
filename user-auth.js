// user-auth.js - User OAuth implementation for follow events

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// Define the scopes we need for follow events - update this with the correct scope
const TWITCH_USER_SCOPES = [
  'moderator:read:followers',    // This is the scope needed for follows
  'channel:read:subscriptions'   // Optional: add this if you want to check subs too
].join(' ');

// Route to initiate OAuth flow for user token
router.get('/auth/user-token', (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const redirectUri = `${process.env.PUBLIC_URL}/auth/twitch/callback`;
  const responseType = 'code';
  
  // Log the complete scopes we're requesting
  console.log(`Requesting scopes: ${TWITCH_USER_SCOPES}`);
  
  const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=${responseType}&scope=${encodeURIComponent(TWITCH_USER_SCOPES)}&force_verify=true`;
  
  console.log(`Redirecting to Twitch auth: ${authUrl}`);
  res.redirect(authUrl);
});

// Register follow subscription using user token
async function setupFollowSubscription(userId, userToken = null) {
  try {
    // Get the app token for webhook setup
    const appToken = process.env.TWITCH_APP_ACCESS_TOKEN;
    
    if (!appToken) {
      console.error('No app token available for webhook subscription');
      return { success: false, error: 'No app access token available' };
    }
    
    console.log(`Setting up follow subscription with app token`);
    
    // Check if we have required variables
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_WEBHOOK_SECRET || !process.env.PUBLIC_URL) {
      console.error('Missing required configuration for follow subscription');
      return { success: false, error: 'Missing required configuration' };
    }
    
    // Make sure we have a valid broadcaster ID
    if (!userId) {
      console.error('No broadcaster ID provided');
      return { success: false, error: 'No broadcaster ID provided' };
    }
    
    console.log(`Using broadcaster ID: ${userId}`);
    
    // Get all current subscriptions first to check if one already exists
    try {
      const subResponse = await axios.get('https://api.twitch.tv/helix/eventsub/subscriptions', {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${appToken}`
        }
      });
      
      console.log(`Current subscriptions: ${subResponse.data.data.length}`);
      
      // Check if a follow subscription already exists for this broadcaster
      const existingFollowSub = subResponse.data.data.find(sub => 
        sub.type === 'channel.follow' && 
        sub.condition.broadcaster_user_id === userId
      );
      
      if (existingFollowSub) {
        console.log('Follow subscription already exists:', existingFollowSub);
        return { 
          success: true, 
          data: existingFollowSub,
          message: 'Subscription already exists' 
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
      
      console.log('Trying follow subscription with version 1:', JSON.stringify(subscriptionData));
      
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
      
      console.log('Successfully registered follow subscription with version 1');
      return { success: true, data: response.data };
    } catch (errorV1) {
      console.log('Version 1 failed, trying version 2 with moderator_user_id');
      
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
        
        console.log('Trying follow subscription with version 2:', JSON.stringify(subscriptionData));
        
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
        
        console.log('Successfully registered follow subscription with version 2');
        return { success: true, data: response.data };
      } catch (errorV2) {
        console.error('Both version 1 and 2 failed:');
        console.error('Version 1 error:', errorV1.response?.data || errorV1.message);
        console.error('Version 2 error:', errorV2.response?.data || errorV2.message);
        
        return { 
          success: false, 
          error: 'Both follow subscription versions failed',
          details: {
            v1Error: errorV1.response?.data || errorV1.message,
            v2Error: errorV2.response?.data || errorV2.message
          }
        };
      }
    }
  } catch (error) {
    console.error('Error setting up follow subscription:', error.response?.data || error.message);
    
    return { 
      success: false, 
      error: error.response?.data || error.message
    };
  }
}

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
        redirect_uri: `${process.env.PUBLIC_URL}/auth/twitch/callback` // Match the same URI here
      }
    });
    
    const { access_token, refresh_token } = tokenResponse.data;
    
    // Log the token for debugging (just the first few characters for security)
    console.log(`Received access token: ${access_token.substring(0, 5)}...`);
    
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
    console.log(`Updating .env file at: ${envPath}`);
    
    let result = { success: false, error: 'Unknown error' };
    
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
      console.log('Successfully updated .env file with new tokens');
      
      // Set the tokens directly in process.env
      process.env.TWITCH_USER_TOKEN = access_token;
      process.env.TWITCH_USER_REFRESH_TOKEN = refresh_token;
      
      // Now try to set up the follow subscription with the token we just got
      console.log('Setting up follow subscription with the new token');
      result = await setupFollowSubscription(userData.id, access_token);
      
    } catch (error) {
      console.error('Error updating .env file:', error);
      // Continue with the process even if saving to .env fails
      // Set the tokens directly in process.env
      process.env.TWITCH_USER_TOKEN = access_token;
      process.env.TWITCH_USER_REFRESH_TOKEN = refresh_token;
      
      result = await setupFollowSubscription(userData.id, access_token);
    }
    
    if (result.success) {
      res.send(`
        <h1>Authentication Successful!</h1>
        <p>Authenticated as: ${userData.display_name}</p>
        <p>Follow subscription has been set up successfully!</p>
        <p><a href="/">Return to dashboard</a></p>
      `);
    } else {
      res.send(`
        <h1>Authentication Successful!</h1>
        <p>Authenticated as: ${userData.display_name}</p>
        <p>Token saved, but there was an error setting up follow subscription:</p>
        <pre>${JSON.stringify(result.error, null, 2)}</pre>
        <p><a href="/">Return to dashboard</a></p>
      `);
    }
  } catch (error) {
    console.error('Error during OAuth callback:', error);
    res.status(500).send(`
      <h1>Authentication Failed</h1>
      <p>Error: ${error.message}</p>
      <pre>${error.stack}</pre>
      <p><a href="/">Return to dashboard</a></p>
    `);
  }
});

// Endpoint to check user token status
router.get('/auth/token-status', (req, res) => {
  const userToken = process.env.TWITCH_USER_TOKEN;
  const refreshToken = process.env.TWITCH_USER_REFRESH_TOKEN;
  
  let tokenStatus = 'Not available';
  if (userToken) {
    tokenStatus = `Available (${userToken.substring(0, 5)}...)`;
  }
  
  let refreshStatus = 'Not available';
  if (refreshToken) {
    refreshStatus = `Available (${refreshToken.substring(0, 5)}...)`;
  }
  
  res.send(`
    <h1>Twitch User Token Status</h1>
    <p><strong>User Token:</strong> ${tokenStatus}</p>
    <p><strong>Refresh Token:</strong> ${refreshStatus}</p>
    
    <h2>Manual Setup</h2>
    <p>If the token is not available, you can try to set up follows again:</p>
    <div>
      <a href="/auth/user-token" style="
        display: inline-block;
        background: #6441A4;
        color: white;
        padding: 10px 15px;
        text-decoration: none;
        border-radius: 4px;
        font-weight: bold;
      ">Authorize Again</a>
      
      <a href="/auth/retry-follow-setup" style="
        display: inline-block;
        background: #333;
        color: white;
        margin-left: 10px;
        padding: 10px 15px;
        text-decoration: none;
        border-radius: 4px;
        font-weight: bold;
      ">Retry Follow Setup</a>
    </div>
    
    <p style="margin-top: 20px;"><a href="/">Back to Dashboard</a></p>
  `);
});

// Endpoint to check token scopes
router.get('/auth/check-scopes', async (req, res) => {
  try {
    const userToken = process.env.TWITCH_USER_TOKEN;
    
    if (!userToken) {
      return res.send(`
        <h1>No User Token Available</h1>
        <p>You need to authorize with Twitch first.</p>
        <p><a href="/auth/user-token">Click here to authorize</a></p>
      `);
    }
    
    // Validate the token with Twitch
    try {
      const response = await axios.get('https://id.twitch.tv/oauth2/validate', {
        headers: {
          'Authorization': `OAuth ${userToken}`
        }
      });
      
      const { client_id, login, scopes, user_id, expires_in } = response.data;
      
      res.send(`
        <h1>Twitch Token Information</h1>
        <p><strong>User:</strong> ${login} (ID: ${user_id})</p>
        <p><strong>Client ID:</strong> ${client_id}</p>
        <p><strong>Expires In:</strong> ${expires_in} seconds (${Math.floor(expires_in / 3600)} hours)</p>
        
        <h2>Token Scopes:</h2>
        <ul>
          ${scopes.map(scope => `<li>${scope}</li>`).join('')}
        </ul>
        
        <h2>Required Scopes:</h2>
        <ul>
          <li>moderator:read:followers - ${scopes.includes('moderator:read:followers') ? '✅ Present' : '❌ Missing'}</li>
        </ul>
        
        <div style="margin-top: 20px;">
          <a href="/auth/user-token" style="
            display: inline-block;
            background: #6441A4;
            color: white;
            padding: 10px 15px;
            text-decoration: none;
            border-radius: 4px;
            font-weight: bold;
          ">Re-authorize with Twitch</a>
        </div>
        
        <p style="margin-top: 20px;"><a href="/">Back to Dashboard</a></p>
      `);
    } catch (error) {
      res.send(`
        <h1>Invalid Token</h1>
        <p>The token could not be validated with Twitch.</p>
        <p>Error: ${error.message}</p>
        <pre>${JSON.stringify(error.response?.data || {}, null, 2)}</pre>
        <p><a href="/auth/user-token">Click here to re-authorize</a></p>
      `);
    }
  } catch (error) {
    res.status(500).send(`
      <h1>Error Checking Token</h1>
      <p>An unexpected error occurred: ${error.message}</p>
      <pre>${error.stack}</pre>
      <p><a href="/">Back to Dashboard</a></p>
    `);
  }
});

// Endpoint to retry setting up follow event
router.get('/auth/retry-follow-setup', async (req, res) => {
  try {
    // Check if we have a user token
    const userToken = process.env.TWITCH_USER_TOKEN;
    if (!userToken) {
      return res.send(`
        <h1>Error: No User Token Available</h1>
        <p>You need to authorize with Twitch first.</p>
        <p><a href="/auth/user-token">Click here to authorize</a></p>
      `);
    }
    
    // Get the user ID
    const userResponse = await axios.get('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Client-Id': process.env.TWITCH_CLIENT_ID
      }
    });
    
    const userData = userResponse.data.data[0];
    
    // Try to set up the follow subscription
    const setupResult = await setupFollowSubscription(userData.id, userToken);
    
    if (setupResult.success) {
      res.send(`
        <h1>Follow Subscription Setup Successful!</h1>
        <p>User: ${userData.display_name}</p>
        <pre>${JSON.stringify(setupResult.data, null, 2)}</pre>
        <p><a href="/">Back to Dashboard</a></p>
      `);
    } else {
      res.send(`
        <h1>Error Setting Up Follow Subscription</h1>
        <p>User: ${userData.display_name}</p>
        <p>Error:</p>
        <pre>${JSON.stringify(setupResult.error, null, 2)}</pre>
        <p><a href="/">Back to Dashboard</a></p>
      `);
    }
  } catch (error) {
    console.error('Error retrying follow setup:', error);
    res.status(500).send(`
      <h1>Error Retrying Follow Setup</h1>
      <p>Error: ${error.message}</p>
      <pre>${error.stack}</pre>
      <p><a href="/">Back to Dashboard</a></p>
    `);
  }
});

module.exports = { router, setupFollowSubscription };