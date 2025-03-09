// get-app-token.js
// Run this script to generate an app access token

const axios = require('axios');
require('dotenv').config();

async function getAppAccessToken() {
  try {
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
      console.error('Error: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set in .env file');
      return;
    }

    const params = new URLSearchParams();
    params.append('client_id', process.env.TWITCH_CLIENT_ID);
    params.append('client_secret', process.env.TWITCH_CLIENT_SECRET);
    params.append('grant_type', 'client_credentials');
    
    // Add required scopes for all EventSub features
    // Note: App tokens can only have certain scopes. Most EventSub features don't need
    // specific scopes when using app tokens, but a few do.
    params.append('scope', 'channel:read:subscriptions bits:read');

    const response = await axios.post('https://id.twitch.tv/oauth2/token', params);

    console.log('=============================================');
    console.log('App Access Token successfully generated:');
    console.log('=============================================');
    console.log(`TWITCH_APP_ACCESS_TOKEN=${response.data.access_token}`);
    console.log('=============================================');
    console.log('Add this to your .env file (replacing any existing TWITCH_APP_ACCESS_TOKEN)');
    console.log('This token is different from your normal access token!');
    console.log('=============================================');

    return response.data;
  } catch (error) {
    console.error('Error getting app access token:', error.response?.data || error.message);
  }
}

getAppAccessToken();