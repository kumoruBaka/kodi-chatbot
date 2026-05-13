import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import multer from 'multer';
import { initDB, getDB } from './data/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const IS_DEV = process.env.DEV_MODE === "yes";
if (IS_DEV) console.log("[INFO] Developer Mode is active (Unlimited chats)");

// Initialize DB
await initDB();
const db = getDB();

// Usage tracking logic (SQLite)
const MAX_CHATS_PER_IP = 10;

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

const MODEL_NAME = "gemini-3-flash-preview";
const SYSTEM_INSTRUCTION = `You are Kodi, a helpful AI assistant made by Nekode.
You can help with anything — answering questions, writing, coding, brainstorming, and more.
Be friendly, clear, and concise. Match the user's language (Indonesian or English). Don't be overly formal — talk like a smart, helpful friend.`;

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
    chatsUsed: bypassLimit ? 0 : usage.count
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
    const message = req.body.message || "";
    const history = req.body.history ? JSON.parse(req.body.history) : [];
    const userId = req.body.userId;
    const aiModel = 'gemini';
    const files = req.files;
    const ip = getIP(req);

    if (!message && (!files || files.length === 0)) {
      return res.status(400).json({ error: "Message or files are required", code: 400 });
    }

    await logActivity(ip, userId, aiModel, message);

    const ipUsage = await getUsage(ip);
    const isLocalhost = ip === '::1' || ip === '127.0.0.1' || ip.includes('127.0.0.1');
    const bypassLimit = IS_DEV || isLocalhost;

    if (!bypassLimit && ipUsage.count >= MAX_CHATS_PER_IP) {
      return res.status(429).json({ error: "Daily limit reached.", code: 429 });
    }

    const formattedHistory = Array.isArray(history) 
      ? history.map(msg => ({
          role: msg.role === "bot" ? "model" : "user",
          parts: [{ text: msg.text }],
        }))
      : [];

    const contents = [...formattedHistory];
    const currentParts = [];
    if (message) currentParts.push({ text: message });
    if (files && files.length > 0) {
      currentParts.push(...files.map(f => ({ inlineData: { data: f.buffer.toString('base64'), mimeType: f.mimetype } })));
    }
    contents.push({ role: 'user', parts: currentParts });

    let result;
    let attempts = 0;
    const maxAttempts = apiKeys.length;

    while (attempts < maxAttempts) {
      try {
        const client = getRotatedClient();
        result = await client.models.generateContent({
          model: MODEL_NAME,
          systemInstruction: SYSTEM_INSTRUCTION,
          contents: contents,
          config: { temperature: 0.7, topP: 0.95, topK: 40 }
        });
        break; // Success!
      } catch (err) {
        attempts++;
        const isRetryable = err.status === 429 || err.status === 503;
        
        if (isRetryable && attempts < maxAttempts) {
          console.warn(`[WARNING] Gemini Key ${currentKeyIndex} failed (${err.status}). Retrying with next key (Attempt ${attempts + 1}/${maxAttempts})...`);
          continue;
        }
        throw err; // Out of keys or non-retryable error
      }
    }

    const reply = result.text;
    const usage = result.usageMetadata;

    if (!bypassLimit) {
      await incrementUsage(ip);
    }

    res.json({ reply, usage, chatsLeft: bypassLimit ? 999 : MAX_CHATS_PER_IP - (ipUsage.count + 1) });
  } catch (error) {
    console.error("[CRITICAL] Error in /api/chat:", error);
    
    const status = error.status || 500;
    let userMessage = "Internal server error";
    
    if (status === 503) {
      userMessage = "Gemini is currently overloaded. Please try again in a few seconds.";
    } else if (status === 429) {
      userMessage = "API Rate limit reached. Please wait a moment or add more API keys.";
    } else if (error.message && error.message.includes("API key")) {
      userMessage = "Invalid or expired API Key. Please check your .env configuration.";
    }

    res.status(status).json({ error: userMessage, code: status });
  }
});

app.listen(port, () => {
  console.log(`[INFO] Server is running on port ${port}`);
});
