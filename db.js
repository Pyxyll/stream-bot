// This is a more advanced solution - you would need to install sqlite3 first
// npm install sqlite3

// db.js - Simple database for token storage
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Create a tokens database in the /tmp directory (writable on most cloud platforms)
const dbPath = process.env.NODE_ENV === 'production' 
  ? path.join('/tmp', 'tokens.db')
  : path.join(__dirname, 'tokens.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the tokens database');
    
    // Create the tokens table if it doesn't exist
    db.run(`
      CREATE TABLE IF NOT EXISTS tokens (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }
});

// Save a token to the database
function saveToken(key, value) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT OR REPLACE INTO tokens VALUES (?, ?, ?)');
    stmt.run(key, value, Date.now(), function(err) {
      if (err) {
        console.error('Error saving token:', err.message);
        reject(err);
      } else {
        console.log(`Token ${key} saved successfully`);
        resolve(this.lastID);
      }
    });
    stmt.finalize();
  });
}

// Get a token from the database
function getToken(key) {
  return new Promise((resolve, reject) => {
    db.get('SELECT value FROM tokens WHERE key = ?', [key], (err, row) => {
      if (err) {
        console.error('Error getting token:', err.message);
        reject(err);
      } else {
        resolve(row ? row.value : null);
      }
    });
  });
}

// Load all tokens into process.env
async function loadAllTokens() {
  return new Promise((resolve, reject) => {
    db.all('SELECT key, value FROM tokens', [], (err, rows) => {
      if (err) {
        console.error('Error loading tokens:', err.message);
        reject(err);
      } else {
        rows.forEach(row => {
          process.env[row.key] = row.value;
        });
        console.log(`Loaded ${rows.length} tokens from database`);
        resolve(rows.length);
      }
    });
  });
}

// Close the database connection
function close() {
  return new Promise((resolve, reject) => {
    db.close(err => {
      if (err) {
        console.error('Error closing database:', err.message);
        reject(err);
      } else {
        console.log('Database connection closed');
        resolve();
      }
    });
  });
}

module.exports = {
  saveToken,
  getToken,
  loadAllTokens,
  close
};