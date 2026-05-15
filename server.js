import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import multer from 'multer';
import cors from 'cors';
import { initDB, getDB } from './data/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Config
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const app = express();
const port = process.env.PORT || config.server.port;

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const IS_DEV = process.env.DEV_MODE === "yes";
if (IS_DEV) console.log("[INFO] Developer Mode is active (Unlimited chats)");

// Initialize DB
await initDB();
const db = getDB();

// Usage tracking logic (SQLite)
const MAX_CHATS_PER_IP = config.server.maxChatsPerIP;

async function getUsage(ip) {
  const today = new Date().toDateString();
  try {
    const row = await db.get('SELECT * FROM usage_stats WHERE ip = ?', [ip]);
    if (!row || row.last_reset !== today) {
      await db.run('INSERT INTO usage_stats (ip, count, last_reset) VALUES (?, 0, ?) ON CONFLICT(ip) DO UPDATE SET count = 0, last_reset = ?', [ip, today, today]);
      console.log(`[DB] Initialized usage for IP: ${ip}`);
      return { count: 0, lastReset: today };
    }
    return { count: row.count, lastReset: row.last_reset };
  } catch (err) {
    console.error("[ERROR] getUsage failed:", err.message);
    return { count: 0, lastReset: today };
  }
}

async function incrementUsage(ip) {
  try {
    await db.run('UPDATE usage_stats SET count = count + 1 WHERE ip = ?', [ip]);
  } catch (err) {
    console.error("[ERROR] incrementUsage failed:", err.message);
  }
}

async function logActivity(ip, userId, model, message) {
  try {
    const snippet = message ? message.substring(0, 500) : '[Media Only]';
    await db.run(
      'INSERT INTO activity_logs (ip, user_id, model, message_snippet) VALUES (?, ?, ?, ?)',
      [ip, userId || 'anonymous', model, snippet]
    );
  } catch (err) {
    console.error("[ERROR] Logging failed:", err.message);
  }
}

function getIP(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  const remote = req.socket.remoteAddress;
  if (cfIp) return cfIp;
  if (forwarded) return forwarded.split(',')[0].trim();
  return remote;
}

// Initialize Gemini API
const apiKeys = (process.env.GEMINI_API_KEY || "").split(";").map(k => k.trim()).filter(k => k);
if (apiKeys.length === 0) {
  console.error("[CRITICAL] No Gemini API Keys found in .env!");
  process.exit(1);
}

const MODEL_NAME = config.gemini.modelName;
const SYSTEM_INSTRUCTION = config.gemini.systemInstruction;

let currentKeyIndex = 0;
function getRotatedClient() {
  const key = apiKeys[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
  return new GoogleGenAI({ apiKey: key });
}

// Routes
app.get("/api/config", async (req, res) => {
  const ip = getIP(req);
  const usage = await getUsage(ip);
  const isLocalhost = ip === '::1' || ip === '127.0.0.1' || ip.includes('127.0.0.1');
  const bypassLimit = IS_DEV || isLocalhost;

  res.json({ 
    model: MODEL_NAME, 
    maxChats: bypassLimit ? 999 : MAX_CHATS_PER_IP,
    chatsUsed: bypassLimit ? 0 : usage.count,
    defaultGreeting: config.gemini.defaultGreeting
  });
});

app.get("/api/sessions/:userId", async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC', [req.params.userId]);
    const sessions = rows.map(r => ({
      ...r,
      history: JSON.parse(r.history),
      isTemp: Boolean(r.is_temp)
    }));
    res.json(sessions);
  } catch (err) {
    console.error("[ERROR] Load sessions failed:", err.message);
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

app.post("/api/sessions/sync", async (req, res) => {
  const { userId, sessions } = req.body;
  try {
    for (const session of sessions) {
      if (session.temp) continue;
      const updatedTimeStr = new Date(session.updatedAt || parseInt(session.id)).toISOString().replace('T', ' ').replace('Z', '');
      await db.run(
        'INSERT INTO chat_sessions (id, user_id, name, history, is_temp, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, history = excluded.history, is_temp = excluded.is_temp, updated_at = excluded.updated_at',
        [session.id, userId, session.name, JSON.stringify(session.history), session.temp ? 1 : 0, updatedTimeStr]
      );
    }
    console.log(`[DB] Synced ${sessions.length} sessions for user: ${userId}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[ERROR] Sync failed:", err.message);
    res.status(500).json({ error: "Failed to sync sessions" });
  }
});

app.delete("/api/sessions/:id", async (req, res) => {
  try {
    await db.run('DELETE FROM chat_sessions WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete session" });
  }
});

const upload = multer({ storage: multer.memoryStorage() });

app.post("/api/chat", upload.array('files'), async (req, res) => {
  try {
    const { message = "", history = "[]", userId } = req.body;
    const files = req.files;
    const ip = getIP(req);
    const aiModel = 'gemini';

    if (!message && (!files || files.length === 0)) {
      return res.status(400).json({ error: "Message or files are required", code: 400 });
    }

    // Rate limiting & Logging
    await logActivity(ip, userId, aiModel, message);
    const ipUsage = await getUsage(ip);
    const isLocalhost = ip === '::1' || ip === '127.0.0.1' || ip.includes('127.0.0.1');
    const bypassLimit = IS_DEV || isLocalhost;

    if (!bypassLimit && ipUsage.count >= MAX_CHATS_PER_IP) {
      return res.status(429).json({ error: "Daily limit reached.", code: 429 });
    }

    const result = await processGeminiChat({ message, history, files });
    
    if (!bypassLimit) await incrementUsage(ip);

    res.json({ 
      reply: result.text, 
      usage: result.usageMetadata, 
      chatsLeft: bypassLimit ? 999 : MAX_CHATS_PER_IP - (ipUsage.count + 1) 
    });
  } catch (error) {
    handleChatError(res, error);
  }
});

/**
 * Process chat with Gemini API
 */
async function processGeminiChat({ message, history, files }) {
  const parsedHistory = JSON.parse(history);
  const contents = [
    ...parsedHistory.map(msg => ({
      role: msg.role === "bot" ? "model" : "user",
      parts: [{ text: msg.text }],
    })),
    {
      role: 'user',
      parts: [
        ...(message ? [{ text: message }] : []),
        ...(files || []).map(f => ({ 
          inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype } 
        }))
      ]
    }
  ];

  let lastError;
  for (let i = 0; i < apiKeys.length; i++) {
    try {
      const client = getRotatedClient();
      return await client.models.generateContent({
        model: MODEL_NAME,
        contents,
        config: { 
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: config.gemini.temperature, 
          topP: config.gemini.topP, 
          topK: config.gemini.topK 
        }
      });
    } catch (err) {
      lastError = err;
      if (err.status !== 429 && err.status !== 503) break;
      console.warn(`[WARNING] Gemini Key rotation triggered due to status ${err.status}`);
    }
  }
  throw lastError;
}

/**
 * Consistent error handler for chat route
 */
function handleChatError(res, error) {
  console.error("[CRITICAL] Chat Error:", error);
  const status = error.status || 500;
  const messages = {
    503: "Gemini is overloaded. Try again soon.",
    429: "Rate limit reached. Please wait.",
    404: `Model ${MODEL_NAME} not found. Check config.json`,
    401: "Invalid API Key. Check your .env"
  };
  
  res.status(status).json({ 
    error: messages[status] || error.message || "Internal server error", 
    code: status 
  });
}

app.listen(port, () => {
  console.log(`[INFO] Server is running on port ${port}`);
});
