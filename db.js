// db.js - Updated with promise-based initialization

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Create a tokens database in the /tmp directory (writable on most cloud platforms)
const dbPath = process.env.NODE_ENV === 'production' 
  ? path.join('/tmp', 'tokens.db')
  : path.join(__dirname, 'tokens.db');

// Initialize database with a promise so we can await it
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('Error opening database:', err.message);
        reject(err);
        return;
      }
      
      console.log('Connected to the tokens database');
      
      // Create the tokens table if it doesn't exist
      db.run(`
        CREATE TABLE IF NOT EXISTS tokens (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `, (tableErr) => {
        if (tableErr) {
          console.error('Error creating tokens table:', tableErr.message);
          reject(tableErr);
        } else {
          console.log('Tokens table verified/created successfully');
          resolve(db);
        }
      });
    });
  });
}

// Create the database instance
let db;
let dbInitialized = false;
let dbInitializing = false;
let dbPromise = null;

// Ensure database is initialized before any operations
async function ensureDbInitialized() {
  if (dbInitialized) {
    return db;
  }
  
  if (!dbInitializing) {
    dbInitializing = true;
    dbPromise = initializeDatabase();
  }
  
  db = await dbPromise;
  dbInitialized = true;
  return db;
}

// Save a token to the database
async function saveToken(key, value) {
  try {
    await ensureDbInitialized();
    
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
  } catch (err) {
    console.error('Error ensuring database before saving token:', err);
    throw err;
  }
}

// Get a token from the database
async function getToken(key) {
  try {
    await ensureDbInitialized();
    
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
  } catch (err) {
    console.error('Error ensuring database before getting token:', err);
    throw err;
  }
}

// Load all tokens into process.env
async function loadAllTokens() {
  try {
    await ensureDbInitialized();
    
    return new Promise((resolve, reject) => {
      db.all('SELECT key, value FROM tokens', [], (err, rows) => {
        if (err) {
          console.error('Error loading tokens:', err);
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
  } catch (err) {
    console.error('Error ensuring database before loading tokens:', err);
    throw err;
  }
}

// Close the database connection
async function close() {
  if (!db) return Promise.resolve();
  
  return new Promise((resolve, reject) => {
    db.close(err => {
      if (err) {
        console.error('Error closing database:', err.message);
        reject(err);
      } else {
        console.log('Database connection closed');
        dbInitialized = false;
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