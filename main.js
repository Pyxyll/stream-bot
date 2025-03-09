// main.js - The entry point for your application

// Import necessary libraries
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const tmi = require('tmi.js'); // Twitch chat client
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const db = require('./db');
require('dotenv').config(); // For environment variables

// Import custom modules
const eventSub = require('./eventsub');
const userAuth = require('./user-auth');

// Initialize Express app for serving web content
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Pass the io instance to eventSub for real-time events
eventSub.setIO(io);

// Serve static files (your browser sources, animations, etc.)
app.use(express.static('public'));

// Use auth routes
app.use(userAuth.router);
app.use(eventSub.router);

// Initialize Twitch client
function setupTwitchClient() {
  // Get the token (prefer user token, fall back to access token)
  const token = process.env.TWITCH_USER_TOKEN || process.env.TWITCH_ACCESS_TOKEN;
  
  if (!token) {
    console.log('No token available for Twitch chat');
    return null;
  }
  
  // Format the token correctly (add oauth: prefix if needed)
  const formattedToken = token.startsWith('oauth:') ? token : `oauth:${token}`;
  
  return new tmi.Client({
    options: { debug: true },
    identity: {
      username: process.env.TWITCH_BOT_USERNAME || process.env.TWITCH_CHANNEL,
      password: formattedToken
    },
    channels: [process.env.TWITCH_CHANNEL]
  });
}

const twitchClient = setupTwitchClient();

// Initialize Discord client
const discordClient = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ] 
});

async function startServer() {
  try {
    // Load tokens from database
    console.log('Loading tokens from database...');
    await db.loadAllTokens();
    
    // Log token status (first few characters only for security)
    if (process.env.TWITCH_USER_TOKEN) {
      console.log(`TWITCH_USER_TOKEN is available: ${process.env.TWITCH_USER_TOKEN.substring(0, 5)}...`);
      
      // Recreate the Twitch client with the loaded token
      const newClient = setupTwitchClient();
      
      if (newClient) {
        // Connect to Twitch chat with error handling
        newClient.connect().catch(err => {
          console.log('Failed to connect to Twitch chat:', err);
          console.log('Please make sure your token has chat:read and chat:edit scopes');
        });
        
        // Replace the old client with the new one
        Object.assign(twitchClient, newClient);
      }
    } else {
      console.log('TWITCH_USER_TOKEN is not available');
    }
    
    // Connect to Discord if token is provided
    if (process.env.DISCORD_BOT_TOKEN) {
      discordClient.login(process.env.DISCORD_BOT_TOKEN)
        .catch(err => {
          console.log('Failed to connect to Discord:', err);
          console.log('Please make sure your DISCORD_BOT_TOKEN is valid');
        });
    }
    
    // Start the server
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`-----------------------------------------`);
      console.log(`Open http://localhost:${PORT} in your browser to access the dashboard`);
      console.log(`-----------------------------------------`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// When Discord client is ready
discordClient.on('ready', () => {
  console.log(`Logged in to Discord as ${discordClient.user.tag}!`);
  
  // Set up a periodic check for stream status
  setInterval(checkStreamStatus, 60000); // Check every minute
});

// Handle chat messages from Twitch
twitchClient.on('message', (channel, tags, message, self) => {
  // Ignore messages from the bot itself
  if(self) return;
  
  // Handle commands
  if(message.startsWith('!')) {
    const command = message.slice(1).split(' ')[0].toLowerCase();
    handleCommand(channel, tags, command, message.slice(command.length + 2));
  }
});

// Function to handle commands
function handleCommand(channel, tags, command, args) {
  switch(command) {
    case 'hello':
      twitchClient.say(channel, `@${tags.username}, hello there!`);
      break;
    // Mock events for testing
    case 'mockfollow':
      handleFollow(tags.username);
      break;
    case 'mocksub':
      handleSubscription(tags.username, args || '1');
      break;
    // Add more commands as needed
    default:
      // Unknown command, do nothing
      break;
  }
}

// Function to check if the channel is live
async function checkStreamStatus() {
  try {
    // Make sure we have the required tokens
    if (!process.env.TWITCH_USER_TOKEN || !process.env.TWITCH_CLIENT_ID) {
      console.log('Missing Twitch credentials. Stream status check skipped.');
      return;
    }

    const response = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${process.env.TWITCH_CHANNEL}`, {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${process.env.TWITCH_USER_TOKEN}` // Use USER_TOKEN instead of ACCESS_TOKEN
      }
    });
    
    const streamData = response.data.data[0];
    const isLive = !!streamData;
    
    // Store stream status in a variable to detect changes
    if(isLive && !global.isChannelLive) {
      // Channel just went live
      console.log(`Channel ${process.env.TWITCH_CHANNEL} just went live!`);
      sendDiscordNotification(streamData);
    } else if(!isLive && global.isChannelLive) {
      console.log(`Channel ${process.env.TWITCH_CHANNEL} just went offline.`);
    }
    
    global.isChannelLive = isLive;
  } catch (error) {
    console.error('Error checking stream status:', error.message);
    
    // If we get a 401 Unauthorized error, the token might be expired
    if (error.response && error.response.status === 401) {
      console.error('Authentication error: Twitch token may be expired or invalid.');
      console.error('Try refreshing your token or generating a new one.');
    }
  }
}

// Function to send Discord notification when stream goes live
function sendDiscordNotification(streamData) {
  // Check if Discord is connected and channel ID is set
  if(!discordClient.isReady() || !process.env.DISCORD_CHANNEL_ID) {
    console.log('Discord not configured. Skipping notification.');
    return;
  }

  const channel = discordClient.channels.cache.get(process.env.DISCORD_CHANNEL_ID);
  
  if(channel) {
    try {
      // Format stream start time if available
      let streamTimeInfo = '';
      if (streamData.started_at) {
        const startTime = new Date(streamData.started_at);
        streamTimeInfo = `\nStarted at: ${startTime.toLocaleTimeString()}`;
      }
      
      // Create a more visually appealing embed
      const embed = new EmbedBuilder()
        .setColor(0x6441A4) // Twitch purple
        .setTitle(`${process.env.TWITCH_CHANNEL} is LIVE NOW! 🔴`)
        .setURL(`https://twitch.tv/${process.env.TWITCH_CHANNEL}`)
        .setDescription(`**${streamData.title || 'Streaming now!'}**${streamTimeInfo}`)
        .setImage(streamData.thumbnail_url 
          ? streamData.thumbnail_url.replace('{width}', '1280').replace('{height}', '720') 
          : null)
        .addFields(
          { name: '🎮 Category', value: streamData.game_name || 'Just Chatting', inline: true },
          { name: '👁️ Viewers', value: streamData.viewer_count ? streamData.viewer_count.toString() : '0', inline: true }
        )
        .setFooter({ 
          text: `Click "Join Stream" to watch live!`, 
          iconURL: 'https://static.twitchcdn.net/assets/favicon-32-d6025c14e900565d6177.png' 
        })
        .setTimestamp();
      
      // Create action button text
      const content = `Hey @everyone! **${process.env.TWITCH_CHANNEL}** is live now! Come join the stream!`;
      
      channel.send({ content, embeds: [embed] })
        .then(() => console.log('Discord notification sent successfully'))
        .catch(err => console.error('Error sending Discord notification:', err));
    } catch (error) {
      console.error('Error creating Discord notification:', error);
    }
  } else {
    console.error('Discord channel not found. Check your DISCORD_CHANNEL_ID.');
  }
}

// Handle follower event
function handleFollow(username) {
  console.log(`New follower: ${username}`);
  // Emit event to browser sources
  io.emit('follow', { username });
}

// Handle subscription event
function handleSubscription(username, months) {
  console.log(`New subscription: ${username} (${months} months)`);
  // Emit event to browser sources
  io.emit('subscription', { username, months });
}

// Add a status endpoint
app.get('/status', (req, res) => {
  const status = {
    twitch: twitchClient.readyState() === 'OPEN',
    discord: discordClient ? discordClient.isReady() : false
  };
  res.json(status);
});

// Add test endpoints for events
app.get('/test/follow', (req, res) => {
  const username = req.query.username || 'TestFollower';
  io.emit('follow', { username });
  
  res.send(`
    <h1>Follow Test Triggered</h1>
    <p>Username: ${username}</p>
    <p><a href="/test-events.html">Back to test dashboard</a></p>
  `);
});

app.get('/test/subscription', (req, res) => {
  const username = req.query.username || 'TestUser';
  const months = req.query.months || '1';
  io.emit('subscription', { username, months });
  
  res.send(`
    <h1>Subscription Test Triggered</h1>
    <p>Username: ${username}</p>
    <p>Months: ${months}</p>
    <p><a href="/test-events.html">Back to test dashboard</a></p>
  `);
});

app.get('/test/raid', (req, res) => {
  const username = req.query.username || 'TestRaider';
  const viewers = req.query.viewers || '10';
  io.emit('raid', { username, viewers });
  
  res.send(`
    <h1>Raid Test Triggered</h1>
    <p>Username: ${username}</p>
    <p>Viewers: ${viewers}</p>
    <p><a href="/test-events.html">Back to test dashboard</a></p>
  `);
});

app.get('/test/discord-live', async (req, res) => {
  try {
    const mockStreamData = {
      title: req.query.title || "Test Stream - Software and Game Development",
      game_name: req.query.game || "Software and Game Development",
      viewer_count: req.query.viewers || 1,
      thumbnail_url: "https://static-cdn.jtvnw.net/previews-ttv/live_user_{width}x{height}.jpg",
      started_at: new Date().toISOString()
    };
    
    sendDiscordNotification(mockStreamData);
    
    res.send(`
      <h1>Discord Live Notification Test Triggered</h1>
      <p>A test notification should have been sent to your Discord channel.</p>
      <p><a href="/test-events.html">Back to test dashboard</a></p>
    `);
  } catch (error) {
    console.error('Error sending Discord notification:', error);
    
    res.status(500).send(`
      <h1>Error Sending Discord Notification</h1>
      <p>Error: ${error.message}</p>
      <p><a href="/test-events.html">Back to test dashboard</a></p>
    `);
  }
});

// Add endpoint to set up EventSub
app.get('/setup-eventsub', async (req, res) => {
  try {
    // Get user ID for the channel
    const userResult = await eventSub.getUserId(process.env.TWITCH_CHANNEL);
    
    if (!userResult.success) {
      return res.status(400).send(`
        <h1>Error Setting Up EventSub</h1>
        <p>Could not find user ID for channel: ${process.env.TWITCH_CHANNEL}</p>
        <p>Error: ${userResult.error}</p>
        <a href="/">Back to Dashboard</a>
      `);
    }
    
    // Setup EventSub subscriptions
    const setupResults = await eventSub.setupEventSub(userResult.id);
    
    // Display results
    let resultsHtml = '';
    let hasErrors = false;
    
    for (const [type, result] of Object.entries(setupResults)) {
      resultsHtml += `<div style="margin-bottom: 10px;">
        <strong>${type}:</strong> ${result.success ? '✅ Success' : '❌ Failed'}
        ${!result.success ? `<p style="color: red; margin: 5px 0 0 20px;">Error: ${result.error}</p>` : ''}
      </div>`;
      
      if (!result.success) {
        hasErrors = true;
      }
    }
    
    res.send(`
      <h1>EventSub Setup ${hasErrors ? 'Completed with Some Errors' : 'Successful'}</h1>
      <p>Channel: ${process.env.TWITCH_CHANNEL} (ID: ${userResult.id})</p>
      <h2>Subscription Results:</h2>
      <div style="margin: 20px 0;">${resultsHtml}</div>
      <p><a href="/eventsub-status">View EventSub Status</a></p>
      <p><a href="/">Back to Dashboard</a></p>
    `);
  } catch (error) {
    console.error('Error setting up EventSub:', error);
    res.status(500).send(`
      <h1>Error Setting Up EventSub</h1>
      <p>An unexpected error occurred: ${error.message}</p>
      <a href="/">Back to Dashboard</a>
    `);
  }
});

// Add endpoint to view EventSub status
app.get('/eventsub-status', async (req, res) => {
  try {
    const result = await eventSub.getSubscriptions();
    
    if (!result.success) {
      return res.status(400).send(`
        <h1>Error Getting EventSub Status</h1>
        <p>Could not fetch current subscriptions</p>
        <p>Error: ${result.error}</p>
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
          <th style="text-align: left; padding: 8px; border-bottom: 1px solid #ddd;">Status</th>
          <th style="text-align: left; padding: 8px; border-bottom: 1px solid #ddd;">Created At</th>
        </tr>`;
        
      for (const sub of subscriptions) {
        subscriptionsHtml += `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${sub.type}</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${sub.status}</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${new Date(sub.created_at).toLocaleString()}</td>
          </tr>`;
      }
      
      subscriptionsHtml += '</table>';
    }
    
    res.send(`
      <h1>EventSub Status</h1>
      <p>Total Subscriptions: ${subscriptions.length}</p>
      <p>Max Subscriptions: ${data.max_total_cost || 'Unknown'}</p>
      <p>Total Cost: ${data.total_cost || 'Unknown'}</p>
      
      <h2>Active Subscriptions</h2>
      ${subscriptionsHtml}
      
      <div style="margin-top: 20px;">
        <a href="/setup-eventsub">Set Up EventSub</a> | 
        <a href="/">Back to Dashboard</a>
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

// Start the server
startServer();