import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db;

export async function initDB() {
  try {
    db = await open({
      filename: path.join(__dirname, 'kodi.db'),
      driver: sqlite3.Database
    });

    // Usage Tracking
    await db.exec(`
      CREATE TABLE IF NOT EXISTS usage_stats (
        ip TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0,
        last_reset TEXT
      )
    `);

    // Session History
    await db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT,
        history TEXT,
        is_temp INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Activity Logs
    await db.exec(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT,
        user_id TEXT,
        model TEXT,
        message_snippet TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("[INFO] SQLite Database initialized at /data/kodi.db");
  } catch (err) {
    console.error("[CRITICAL] SQLite Database initialization failed!");
    console.error("[ERROR DETAILS]:", err);
  }
}

export function getDB() {
  if (!db) {
    throw new Error("Database not initialized. Call initDB() first.");
  }
  return db;
}
