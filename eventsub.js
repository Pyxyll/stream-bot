// eventsub.js - Twitch EventSub implementation

const crypto = require('crypto');
const axios = require('axios');
const express = require('express');
const router = express.Router();

// Twitch EventSub constants
const TWITCH_MESSAGE_ID = 'Twitch-Eventsub-Message-Id'.toLowerCase();
const TWITCH_MESSAGE_TIMESTAMP = 'Twitch-Eventsub-Message-Timestamp'.toLowerCase();
const TWITCH_MESSAGE_SIGNATURE = 'Twitch-Eventsub-Message-Signature'.toLowerCase();
const TWITCH_MESSAGE_TYPE = 'Twitch-Eventsub-Message-Type'.toLowerCase();
const MESSAGE_TYPE_VERIFICATION = 'webhook_callback_verification';
const MESSAGE_TYPE_NOTIFICATION = 'notification';
const MESSAGE_TYPE_REVOCATION = 'revocation';

// Global reference to the Socket.IO instance
let _io = null;

// Set the IO instance for emitting events
function setIO(io) {
  _io = io;
  console.log('Socket.IO instance set for EventSub');
}

// Helper function to verify Twitch signature
function verifyTwitchSignature(req, secret) {
  const message = req.headers[TWITCH_MESSAGE_ID] + 
                  req.headers[TWITCH_MESSAGE_TIMESTAMP] + 
                  JSON.stringify(req.body);
  
  const hmac = crypto.createHmac('sha256', secret)
    .update(message)
    .digest('hex');
  
  const signature = `sha256=${hmac}`;
  
  return signature === req.headers[TWITCH_MESSAGE_SIGNATURE];
}

// EventSub webhook endpoint
router.post('/webhook/twitch', express.json(), (req, res) => {
  const secret = process.env.TWITCH_WEBHOOK_SECRET;
  
  if (!secret) {
    console.error('TWITCH_WEBHOOK_SECRET not configured');
    return res.status(500).send('Webhook secret not configured');
  }
  
  // Verify the request is from Twitch
  if (!verifyTwitchSignature(req, secret)) {
    console.error('Invalid signature, possible forgery attempt');
    return res.status(403).send('Invalid signature');
  }
  
  const messageType = req.headers[TWITCH_MESSAGE_TYPE];
  
  // Handle different message types
  switch (messageType) {
    case MESSAGE_TYPE_VERIFICATION:
      // Respond to the webhook verification challenge
      console.log('Received webhook verification challenge');
      return res.status(200).send(req.body.challenge);
      
    case MESSAGE_TYPE_NOTIFICATION:
      // Handle the event notification
      handleEventNotification(req.body);
      return res.status(204).end();
      
    case MESSAGE_TYPE_REVOCATION:
      // The subscription was revoked
      console.log(`Subscription revoked: ${req.body.subscription.type}`, 
                 `Reason: ${req.body.subscription.status}`,
                 `ID: ${req.body.subscription.id}`);
      return res.status(204).end();
      
    default:
      console.warn(`Unknown message type: ${messageType}`);
      return res.status(204).end();
  }
});

// Handle event notifications from Twitch
function handleEventNotification(body) {
  const { subscription, event } = body;
  console.log(`Received event: ${subscription.type}`);
  
  switch (subscription.type) {
    case 'channel.follow':
      handleFollowEvent(event, subscription.type);
      break;
      
    case 'channel.subscribe':
    case 'channel.subscription.gift':
    case 'channel.subscription.message':
      handleSubscriptionEvent(event, subscription.type);
      break;
      
    case 'channel.raid':
      handleRaidEvent(event);
      break;
      
    case 'channel.cheer':
      handleCheerEvent(event);
      break;
      
    default:
      console.log(`Event type "${subscription.type}" not handled`, event);
  }
}

// Handle follow events
function handleFollowEvent(event, eventType) {
  // For v1 and v2 follow events
  const userName = event.user_name || event.user_login;
  
  console.log(`New follower: ${userName}`);
  
  if (_io) {
    _io.emit('follow', { 
      username: userName,
      followedAt: event.followed_at
    });
  }
}

// Handle subscription events
function handleSubscriptionEvent(event, eventType) {
  // Different events have different structures
  let username, months, tier, isGift;
  
  if (eventType === 'channel.subscribe') {
    // New subscription
    username = event.user_name || event.user_login;
    tier = event.tier;
    isGift = false;
    months = 1;
  } else if (eventType === 'channel.subscription.gift') {
    // Gift sub
    username = event.is_anonymous ? 'Anonymous' : (event.user_name || event.user_login);
    tier = event.tier;
    isGift = true;
    months = 1;
  } else if (eventType === 'channel.subscription.message') {
    // Resub with message
    username = event.user_name || event.user_login;
    tier = event.tier;
    isGift = false;
    months = event.cumulative_months || 1;
  }
  
  console.log(`Subscription event: ${username}, Tier ${tier}, ${months} months, Gift: ${isGift}`);
  
  if (_io) {
    _io.emit('subscription', { 
      username, 
      months: months.toString(),
      tier,
      isGift
    });
  }
}

// Handle raid events
function handleRaidEvent(event) {
  const { from_broadcaster_user_login, from_broadcaster_user_name, viewers } = event;
  
  console.log(`Raid from ${from_broadcaster_user_name} with ${viewers} viewers`);
  
  if (_io) {
    _io.emit('raid', { 
      username: from_broadcaster_user_name || from_broadcaster_user_login,
      viewers
    });
  }
}

// Handle cheer events
function handleCheerEvent(event) {
  const { user_name, user_login, is_anonymous, bits } = event;
  
  const username = is_anonymous ? 'Anonymous' : (user_name || user_login);
  
  console.log(`Cheer from ${username}: ${bits} bits`);
  
  if (_io) {
    _io.emit('cheer', { 
      username,
      bits
    });
  }
}

// Set up all required EventSub subscriptions
async function setupEventSub(channelName) {
  try {
    // Check if we have necessary credentials
    if (!process.env.TWITCH_APP_ACCESS_TOKEN || !process.env.TWITCH_CLIENT_ID) {
      console.error('Missing required Twitch API credentials');
      return {
        success: false,
        error: 'Missing Twitch API credentials'
      };
    }
    
    // Get user ID from channel name
    const userId = await getUserId(channelName);
    
    if (!userId.success) {
      return userId; // Return error
    }
    
    console.log(`Setting up EventSub for ${channelName} (ID: ${userId.id})`);
    
    // Define event types to subscribe to
    const eventTypes = [
      'channel.follow',
      'channel.subscribe',
      'channel.subscription.gift',
      'channel.subscription.message',
      'channel.raid',
      'channel.cheer'
    ];
    
    const results = {};
    
    // Register each subscription
    for (const type of eventTypes) {
      results[type] = await registerSubscription(type, userId.id);
    }
    
    return {
      success: true,
      results
    };
  } catch (error) {
    console.error('Error setting up EventSub:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Register a single subscription
async function registerSubscription(type, userId) {
  try {
    // Check if we have the required credentials
    if (!process.env.TWITCH_APP_ACCESS_TOKEN || !process.env.TWITCH_CLIENT_ID || 
        !process.env.TWITCH_WEBHOOK_SECRET || !process.env.PUBLIC_URL) {
      return { 
        success: false, 
        error: 'Missing required configuration' 
      };
    }
    
    // Define the version and condition based on the event type
    let version = '1'; // Default version
    let condition = {};
    
    // Set up proper conditions for each event type
    switch(type) {
      case 'channel.follow':
        // Try version 1 by default
        condition = { broadcaster_user_id: userId };
        break;
        
      case 'channel.raid':
        // For raids, we need to specify we want to receive raids to our channel
        condition = { to_broadcaster_user_id: userId };
        break;
        
      default:
        // Default condition for most subscription types
        condition = { broadcaster_user_id: userId };
        break;
    }
    
    // Create subscription payload
    const subscriptionData = {
      type,
      version,
      condition,
      transport: {
        method: 'webhook',
        callback: `${process.env.PUBLIC_URL}/webhook/twitch`,
        secret: process.env.TWITCH_WEBHOOK_SECRET
      }
    };
    
    console.log(`Registering subscription for ${type}:`, JSON.stringify(subscriptionData));
    
    // Send subscription request
    const response = await axios.post(
      'https://api.twitch.tv/helix/eventsub/subscriptions',
      subscriptionData,
      {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${process.env.TWITCH_APP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`Successfully registered ${type} subscription`);
    return { success: true, data: response.data };
  } catch (error) {
    console.error(`Error registering ${type} subscription:`, error.response?.data || error.message);
    
    // If there was an error with version 1 and it's the follow event, try version 2
    if (type === 'channel.follow' && error.response?.status) {
      try {
        console.log('Trying channel.follow with version 2');
        
        const subscriptionData = {
          type,
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
              'Authorization': `Bearer ${process.env.TWITCH_APP_ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );
        
        console.log(`Successfully registered channel.follow v2 subscription`);
        return { success: true, data: response.data };
      } catch (errorV2) {
        return { 
          success: false, 
          error: errorV2.response?.data || errorV2.message,
          details: 'Both v1 and v2 failed for channel.follow'
        };
      }
    }
    
    return { 
      success: false, 
      error: error.response?.data || error.message 
    };
  }
}

// Get all current subscriptions
async function getSubscriptions() {
  try {
    if (!process.env.TWITCH_APP_ACCESS_TOKEN || !process.env.TWITCH_CLIENT_ID) {
      return { 
        success: false, 
        error: 'Missing Twitch API credentials' 
      };
    }
    
    const response = await axios.get('https://api.twitch.tv/helix/eventsub/subscriptions', {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${process.env.TWITCH_APP_ACCESS_TOKEN}`
      }
    });
    
    return { success: true, data: response.data };
  } catch (error) {
    console.error('Error getting EventSub subscriptions:', error.response?.data || error.message);
    return { 
      success: false, 
      error: error.response?.data || error.message 
    };
  }
}

// Get user ID from username
async function getUserId(username) {
  try {
    if (!username) {
      return { success: false, error: 'No username provided' };
    }
    
    if (!process.env.TWITCH_APP_ACCESS_TOKEN || !process.env.TWITCH_CLIENT_ID) {
      return { success: false, error: 'Missing Twitch API credentials' };
    }
    
    const response = await axios.get(`https://api.twitch.tv/helix/users?login=${username}`, {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${process.env.TWITCH_APP_ACCESS_TOKEN}`
      }
    });
    
    const userData = response.data.data[0];
    if (!userData) {
      return { success: false, error: 'User not found' };
    }
    
    return { success: true, id: userData.id, data: userData };
  } catch (error) {
    console.error('Error getting user ID:', error.response?.data || error.message);
    return { 
      success: false, 
      error: error.response?.data || error.message 
    };
  }
}

// API endpoint to view EventSub status
router.get('/api/eventsub/status', async (req, res) => {
  const result = await getSubscriptions();
  res.json(result);
});

// API endpoint to set up EventSub
router.get('/api/eventsub/setup', async (req, res) => {
  const channelName = process.env.TWITCH_CHANNEL;
  if (!channelName) {
    return res.status(400).json({
      success: false,
      error: 'TWITCH_CHANNEL not set in environment variables'
    });
  }
  
  const result = await setupEventSub(channelName);
  res.json(result);
});

// UI endpoint for EventSub status
router.get('/eventsub-status', async (req, res) => {
  try {
    const result = await getSubscriptions();
    
    if (!result.success) {
      return res.status(400).send(`
        <h1>Error Getting EventSub Status</h1>
        <p>Could not fetch current subscriptions</p>
        <p>Error: ${JSON.stringify(result.error)}</p>
        <a href="/">Back to Dashboard</a>
      `);
    }
    
    const { data } = result;
    const subscriptions = data.data || [];
    
    let subscriptionsHtml = '';
    
    if (subscriptions.length === 0) {
      subscriptionsHtml = '<p>No active subscriptions found.</p>';
    } else {
      subscriptionsHtml = `<table style="width: 100%; border-collapse: collapse;">
        <tr>
          <th style="text-align: left; padding: 8px; border-bottom: 1px solid #ddd;">Type</th>
          <th style="text-align: left; padding: 8px; border-bottom: 1px solid #ddd;">Version</th>
          <th style="text-align: left; padding: 8px; border-bottom: 1px solid #ddd;">Status</th>
          <th style="text-align: left; padding: 8px; border-bottom: 1px solid #ddd;">Created At</th>
        </tr>`;
        
      for (const sub of subscriptions) {
        subscriptionsHtml += `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${sub.type}</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${sub.version}</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${sub.status}</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${new Date(sub.created_at).toLocaleString()}</td>
          </tr>`;
      }
      
      subscriptionsHtml += '</table>';
    }
    
    // Display our current environment configuration
    const configHtml = `
      <h2>Current Configuration</h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <th style="text-align: left; padding: 8px; border-bottom: 1px solid #ddd;">Setting</th>
          <th style="text-align: left; padding: 8px; border-bottom: 1px solid #ddd;">Value</th>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">TWITCH_CHANNEL</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${process.env.TWITCH_CHANNEL || 'Not set'}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">PUBLIC_URL</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${process.env.PUBLIC_URL || 'Not set'}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">TWITCH_CLIENT_ID</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${process.env.TWITCH_CLIENT_ID ? 'Set' : 'Not set'}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">TWITCH_APP_ACCESS_TOKEN</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${process.env.TWITCH_APP_ACCESS_TOKEN ? 'Set' : 'Not set'}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">TWITCH_WEBHOOK_SECRET</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${process.env.TWITCH_WEBHOOK_SECRET ? 'Set' : 'Not set'}</td>
        </tr>
      </table>
    `;
    
    res.send(`
      <h1>EventSub Status</h1>
      <p>Total Subscriptions: ${subscriptions.length}</p>
      <p>Max Subscriptions: ${data.max_total_cost || 'Unknown'}</p>
      <p>Total Cost: ${data.total_cost || 'Unknown'}</p>
      
      ${configHtml}
      
      <h2>Active Subscriptions</h2>
      ${subscriptionsHtml}
      
      <div style="margin-top: 20px;">
        <a href="/api/eventsub/setup" style="
          display: inline-block;
          background: #6441A4;
          color: white;
          padding: 10px 20px;
          text-decoration: none;
          border-radius: 4px;
          margin-right: 10px;
        ">Set Up EventSub</a>
        
        <a href="/" style="
          display: inline-block;
          background: #333;
          color: white;
          padding: 10px 20px;
          text-decoration: none;
          border-radius: 4px;
        ">Back to Dashboard</a>
      </div>
    `);
  } catch (error) {
    console.error('Error getting EventSub status:', error);
    res.status(500).send(`
      <h1>Error Getting EventSub Status</h1>
      <p>An unexpected error occurred: ${error.message}</p>
      <a href="/">Back to Dashboard</a>
    `);
  }
});

module.exports = {
  router,
  setIO,
  setupEventSub,
  getUserId,
  getSubscriptions
};