# 🐾 Kodi AI Assistant

Kodi is a production-grade, multimodal AI chatbot powered by the modern Google Gemini SDK. It features a premium glassmorphic interface, multi-key rotation for high availability, and centralized tuning via `config.json`.

<img src="public/favicon.png" width="100" alt="Kodi Logo">

## ✨ Key Features

- **🚀 Multimodal Intelligence**: Robust binary file handling using Multer. Full support for Images, PDFs, and Audio files.
- **⚙️ Centralized Tuning**: Fine-tune your AI directly in `config.json` — adjust Temperature, TopK, TopP, and System Instructions without touching the code.
- **🎨 Premium UI/UX**: Stunning glassmorphic design with smooth animations, interactive loaders, and custom toast notifications.
- **🗄️ Persistent History**: Chat sessions are automatically synced to a local SQLite database (`/data/kodi.db`), solving browser storage quota limits.
- **🔐 Usage Control**: Built-in IP-based rate limiting with Cloudflare support and configurable CORS security.
- **🔁 API Key Rotation**: Supports multiple Gemini API keys in a round-robin rotation to maximize reliability.
- **🛠️ Developer Friendly**: Includes an "Unlimited Developer Mode" and `--watch` reloading for fast development.

## 🛠️ Tech Stack

- **Backend**: Node.js (ES Modules), Express.js
- **Database**: SQLite (via `sqlite3` & `sqlite` wrapper)
- **AI Core**: `@google/genai` (Modern Gemini SDK)
- **Middleware**: Multer (File Handling), CORS (Security)
- **Frontend**: Vanilla HTML5, CSS3 (Glassmorphism), JavaScript (ES6+)

## 🚀 Getting Started

### 1. Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- A Gemini API Key from [Google AI Studio](https://aistudio.google.com/)

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/kumoruBaka/kodi-chatbot.git
cd kodi-chatbot

# Install dependencies
npm install
```

### 3. Configuration

1. **Environment**: Create a `.env` file (refer to `.env.example`):
```env
GEMINI_API_KEY=your_key1;your_key2
PORT=3000
DEV_MODE=yes
CORS_ORIGIN=*
```

2. **Model Tuning**: Adjust AI behavior in `config.json`:
```json
{
  "gemini": {
    "temperature": 0.75,
    "systemInstruction": "You are Kodi, a chill friend..."
  }
}
```

### 4. Run the App

```bash
# Development mode with auto-reload
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## 📁 Project Structure

- `/public` - Frontend assets (HTML, CSS, Favicon)
- `/data` - SQLite database and persistence logic
- `config.json` - Centralized AI and server settings
- `server.js` - Main ESM Express server
- `.env` - Sensitive configuration (Ignored by Git)

## 📊 Repository Stats

![Clones](https://img.shields.io/badge/Clones-112-4caf50?style=for-the-badge&logo=github)
![Unique Cloners](https://img.shields.io/badge/Unique%20Cloners-46-2196f3?style=for-the-badge&logo=github)
![Views](https://img.shields.io/badge/Views-14-ff9800?style=for-the-badge&logo=github)
![Visitors](https://img.shields.io/badge/Visitors-5-9c27b0?style=for-the-badge&logo=github)

## 🤝 Contributors

- **KumoruBaka** - Main Developer & Architect

---

_Made with ❤️ by Raditya Budi Santosa_
