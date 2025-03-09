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
    case 'channel.follow.v2':  // Added support for v2
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
    // For v2 follow events, the data structure is:
    // {
    //   "user_id": "1234",
    //   "user_login": "cool_user",
    //   "user_name": "Cool_User",
    //   "broadcaster_user_id": "5678",
    //   "broadcaster_user_login": "broadcaster",
    //   "broadcaster_user_name": "Broadcaster",
    //   "followed_at": "2020-07-15T18:16:11.17106713Z"
    // }
    
    console.log(`Follow event received:`, event);
    
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

// Register a subscription for a specific event type
async function registerSubscription(type, userId) {
    try {
      // Check if we have the required credentials
      if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_APP_ACCESS_TOKEN || !process.env.TWITCH_WEBHOOK_SECRET) {
        console.error('Missing required Twitch credentials for EventSub');
        return { success: false, error: 'Missing credentials' };
      }
      
      // The callback URL must be publicly accessible
      if (!process.env.PUBLIC_URL) {
        console.error('PUBLIC_URL not set - cannot register EventSub subscriptions');
        return { success: false, error: 'Missing PUBLIC_URL' };
      }
      
      const callbackUrl = `${process.env.PUBLIC_URL}/webhook/twitch`;
      const accessToken = process.env.TWITCH_APP_ACCESS_TOKEN;
      
      // Define the correct condition based on event type
      let condition = {};
      let version = '1';  // Default version
      
      // Set up proper conditions for each event type
      switch(type) {
        case 'channel.follow':
          version = '2';  // Use version 2 for follow events
          condition = { broadcaster_user_id: userId, moderator_user_id: userId };
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
      
      // Create subscription with proper data
      const subscriptionData = {
        type,
        version,
        condition,
        transport: {
          method: 'webhook',
          callback: callbackUrl,
          secret: process.env.TWITCH_WEBHOOK_SECRET
        }
      };
      
      console.log(`Registering EventSub for ${type} v${version}:`, condition);
      
      const response = await axios.post('https://api.twitch.tv/helix/eventsub/subscriptions', subscriptionData, {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log(`Registered EventSub subscription for ${type}`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error(`Error registering EventSub subscription for ${type}:`, error.response?.data || error.message);
      return { 
        success: false, 
        error: error.response?.data || error.message 
      };
    }
  }

// Get all current subscriptions
async function getSubscriptions() {
  try {
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

// Setup all required subscriptions
async function setupEventSub(userId) {
    // Updated event types that work with current API
    const types = [
      // 'channel.follow' is temporarily removed until we implement user token auth
      'channel.subscribe',
      'channel.subscription.gift',
      'channel.subscription.message',
      'channel.raid'
    ];
    
    const results = {};
    
    for (const type of types) {
      results[type] = await registerSubscription(type, userId);
    }
    
    return results;
  }

// Get user ID from username
async function getUserId(username) {
  try {
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

module.exports = {
  router,
  setIO,
  setupEventSub,
  getUserId,
  getSubscriptions
};