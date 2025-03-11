// db.js - MongoDB Database Integration

const mongoose = require('mongoose');
const crypto = require('crypto');

// Connect to MongoDB
async function connectToDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('Connected to MongoDB');
    return true;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    return false;
  }
}

// Define Token schema
const TokenSchema = new mongoose.Schema({
  name: { type: String, unique: true, required: true },
  value: { type: String, required: true },
  encrypted: { type: Boolean, default: false },
  updated_at: { type: Date, default: Date.now }
});

// Define Token model
const Token = mongoose.model('Token', TokenSchema);

// Helper function to encrypt sensitive data
function encrypt(text) {
  if (!process.env.ENCRYPTION_KEY) {
    return text; // No encryption if key not provided
  }
  
  try {
    const iv = crypto.randomBytes(16);
    const key = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest('base64').substr(0, 32);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
    
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (error) {
    console.error('Encryption error:', error);
    return text;
  }
}

// Helper function to decrypt sensitive data
function decrypt(text) {
  if (!process.env.ENCRYPTION_KEY || !text.includes(':')) {
    return text; // No decryption if key not provided or text not encrypted
  }
  
  try {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts[0], 'hex');
    const encryptedText = Buffer.from(textParts[1], 'hex');
    const key = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest('base64').substr(0, 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), iv);
    
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString();
  } catch (error) {
    console.error('Decryption error:', error);
    return text;
  }
}

// Store a token in the database
async function storeToken(name, value, shouldEncrypt = true) {
  try {
    const storedValue = shouldEncrypt ? encrypt(value) : value;
    
    const result = await Token.findOneAndUpdate(
      { name },
      { 
        value: storedValue, 
        encrypted: shouldEncrypt,
        updated_at: new Date() 
      },
      { upsert: true, new: true }
    );
    
    console.log(`Token ${name} stored successfully`);
    return true;
  } catch (error) {
    console.error(`Error storing token ${name}:`, error);
    return false;
  }
}

// Retrieve a token from the database
async function getToken(name) {
  try {
    const token = await Token.findOne({ name });
    
    if (!token) {
      return null;
    }
    
    return token.encrypted ? decrypt(token.value) : token.value;
  } catch (error) {
    console.error(`Error retrieving token ${name}:`, error);
    return null;
  }
}

// Update multiple tokens at once
async function updateTokens(tokenData) {
  try {
    const operations = [];
    
    for (const [name, value] of Object.entries(tokenData)) {
      if (value) {
        operations.push({
          updateOne: {
            filter: { name },
            update: { 
              value: encrypt(value), 
              encrypted: true,
              updated_at: new Date() 
            },
            upsert: true
          }
        });
      }
    }
    
    if (operations.length > 0) {
      await Token.bulkWrite(operations);
      console.log(`Updated ${operations.length} tokens`);
    }
    
    return true;
  } catch (error) {
    console.error('Error updating tokens:', error);
    return false;
  }
}

// Get all stored tokens (for diagnostics)
async function getAllTokens() {
  try {
    const tokens = await Token.find({}, { name: 1, updated_at: 1, encrypted: 1 });
    return tokens.map(token => ({
      name: token.name,
      encrypted: token.encrypted,
      updated_at: token.updated_at
    }));
  } catch (error) {
    console.error('Error getting all tokens:', error);
    return [];
  }
}

// Delete a token
async function deleteToken(name) {
  try {
    await Token.deleteOne({ name });
    console.log(`Token ${name} deleted successfully`);
    return true;
  } catch (error) {
    console.error(`Error deleting token ${name}:`, error);
    return false;
  }
}

// Initialize database with important tokens from environment variables
async function initializeFromEnv() {
  const tokenNames = [
    'TWITCH_ACCESS_TOKEN',
    'TWITCH_REFRESH_TOKEN',
    'TWITCH_USER_TOKEN',
    'TWITCH_USER_REFRESH_TOKEN',
    'TWITCH_APP_ACCESS_TOKEN'
  ];
  
  for (const name of tokenNames) {
    if (process.env[name]) {
      await storeToken(name, process.env[name], true);
    }
  }
  
  console.log('Initialized tokens from environment variables');
}

module.exports = {
  connectToDatabase,
  storeToken,
  getToken,
  updateTokens,
  getAllTokens,
  deleteToken,
  initializeFromEnv
};