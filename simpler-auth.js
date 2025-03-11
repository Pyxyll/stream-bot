// simpler-auth.js - A simpler alternative for authentication

const express = require('express');
const router = express.Router();

// Route for manual token entry
router.get('/manual-auth', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Twitch Bot Manual Authentication</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
          line-height: 1.6;
        }
        h1 {
          color: #6441A4;
        }
        .step {
          margin-bottom: 30px;
        }
        .step h2 {
          margin-bottom: 10px;
        }
        code {
          background: #f4f4f4;
          padding: 2px 5px;
          border-radius: 3px;
        }
        .note {
          background: #ffffdd;
          padding: 10px;
          border-left: 4px solid #ffcc00;
          margin: 20px 0;
        }
      </style>
    </head>
    <body>
      <h1>Twitch Bot Manual Authentication</h1>
      
      <div class="note">
        <strong>Note:</strong> This is a simplified setup method for testing. For production use, it's better to use the full OAuth flow.
      </div>
      
      <div class="step">
        <h2>Step 1: Get a Twitch Access Token</h2>
        <p>Visit <a href="https://twitchtokengenerator.com/" target="_blank">https://twitchtokengenerator.com/</a> and follow these steps:</p>
        <ol>
          <li>Select "Bot Chat Token"</li>
          <li>Connect with your Twitch account</li>
          <li>Authorize the application with the necessary scopes</li>
          <li>Copy the <strong>Access Token</strong> (not the refresh token)</li>
        </ol>
      </div>
      
      <div class="step">
        <h2>Step 2: Update Your .env File</h2>
        <p>Add or update the following in your .env file:</p>
        <pre><code>TWITCH_ACCESS_TOKEN=your_access_token_here</code></pre>
        <p>Make sure your Twitch username is also set:</p>
        <pre><code>TWITCH_BOT_USERNAME=your_bot_username</code></pre>
      </div>
      
      <div class="step">
        <h2>Step 3: Restart Your Application</h2>
        <p>After updating your .env file, restart your application for the changes to take effect.</p>
      </div>
      
      <div class="note">
        <p><strong>Important:</strong> Tokens from token generators typically expire after some time. If you experience authentication failures in the future, repeat these steps to get a new token.</p>
      </div>
    </body>
    </html>
  `);
});

module.exports = { router };