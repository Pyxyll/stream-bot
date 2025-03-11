// main.js - The entry point for the application

// Import necessary libraries
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const tmi = require('tmi.js'); // Twitch chat client
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
require('dotenv').config(); // For environment variables

// Import our custom modules
const auth = require('./auth');
const userAuth = require('./user-auth');
const eventSub = require('./eventsub');

// Initialize Express app for serving web content
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files (browser sources, animations, etc.)
app.use(express.static('public'));

// Use our auth routers
app.use(auth.router);
app.use(userAuth.router);
app.use(eventSub.router);

// Pass the io instance to eventSub for emitting events
eventSub.setIO(io);

// Initialize Twitch client
const twitchClient = new tmi.Client({
  options: { debug: true },
  identity: {
    username: process.env.TWITCH_BOT_USERNAME,
    password: `oauth:${process.env.TWITCH_ACCESS_TOKEN}` // Using access token from Twitch OAuth
  },
  channels: [process.env.TWITCH_CHANNEL]
});

// Initialize Discord client
const discordClient = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ] 
});

// Connect to Twitch chat with error handling
twitchClient.connect().catch(err => {
  console.log('Failed to connect to Twitch chat:', err);
  console.log('Please make sure your Twitch credentials are correct in .env file');
});

// Connect to Discord if token is provided
if (process.env.DISCORD_BOT_TOKEN) {
  discordClient.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
    console.log('Failed to connect to Discord:', err);
    console.log('Discord integration will be disabled');
  });
} else {
  console.log('Discord bot token not provided, Discord integration disabled');
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
    case 'mockraid':
      handleRaid(tags.username, args || '5');
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
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_APP_ACCESS_TOKEN) {
      console.log('Missing Twitch API credentials. Stream status check skipped.');
      return;
    }

    const response = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${process.env.TWITCH_CHANNEL}`, {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${process.env.TWITCH_APP_ACCESS_TOKEN}`
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
  if (!process.env.DISCORD_CHANNEL_ID || !discordClient || !discordClient.isReady()) {
    console.log('Discord integration not available, skipping notification');
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
      const mentionEveryone = process.env.DISCORD_MENTION_EVERYONE === 'true' ? '@everyone' : '';
      const content = `${mentionEveryone} **${process.env.TWITCH_CHANNEL}** is live now! Come join the stream!`;
      
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

// Handle raid event
function handleRaid(username, viewers) {
  console.log(`New raid: ${username} (${viewers} viewers)`);
  // Emit event to browser sources
  io.emit('raid', { username, viewers });
}

// Set up Socket.IO connection for browser sources
io.on('connection', (socket) => {
  console.log('Browser source connected');
  
  socket.on('disconnect', () => {
    console.log('Browser source disconnected');
  });
});

// Add a status endpoint
app.get('/status', (req, res) => {
  const twitchConnected = twitchClient ? twitchClient.readyState() === 'OPEN' : false;
  const discordConnected = discordClient ? discordClient.isReady() : false;
  
  const status = {
    twitch: twitchConnected,
    discord: discordConnected,
    eventSubConfigured: !!process.env.TWITCH_WEBHOOK_SECRET && !!process.env.PUBLIC_URL
  };
  res.json(status);
});

// Add test endpoints for manually triggering events
app.get('/test/subscription', (req, res) => {
  const username = req.query.username || 'TestUser';
  const months = req.query.months || '1';
  
  // Emit the subscription event
  io.emit('subscription', { username, months });
  
  res.send(`
    <h1>Subscription Test Triggered</h1>
    <p>Username: ${username}</p>
    <p>Months: ${months}</p>
    <p><a href="/test/subscription?username=AnotherUser&months=3">Try another subscription</a></p>
    <p><a href="/test-events.html">Back to test dashboard</a></p>
  `);
});

app.get('/test/follow', (req, res) => {
  const username = req.query.username || 'TestFollower';
  
  // Emit the follow event
  io.emit('follow', { username });
  
  res.send(`
    <h1>Follow Test Triggered</h1>
    <p>Username: ${username}</p>
    <p><a href="/test/follow?username=AnotherFollower">Try another follow</a></p>
    <p><a href="/test-events.html">Back to test dashboard</a></p>
  `);
});

app.get('/test/raid', (req, res) => {
  const username = req.query.username || 'TestRaider';
  const viewers = req.query.viewers || '5';
  
  // Emit the raid event
  io.emit('raid', { username, viewers });
  
  res.send(`
    <h1>Raid Test Triggered</h1>
    <p>Username: ${username}</p>
    <p>Viewers: ${viewers}</p>
    <p><a href="/test/raid?username=AnotherRaider&viewers=10">Try another raid</a></p>
    <p><a href="/test-events.html">Back to test dashboard</a></p>
  `);
});

// Test endpoint for Discord live notification
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
      <pre>${error.stack}</pre>
      <p><a href="/test-events.html">Back to test dashboard</a></p>
    `);
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`-----------------------------------------`);
  console.log(`Dashboard URL: http://localhost:${PORT}`);
  console.log(`Alerts URL: http://localhost:${PORT}/alerts.html`);
  console.log(`-----------------------------------------`);
});