const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const { GoogleGenAI, Type } = require('@google/genai');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --- SUPABASE POSTGRES CONNECTION (FROM .ENV) ---
const db = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

// --- GEMINI CLIENT (server-side only — the key never reaches the browser) ---
// AQ.-format keys from Google AI Studio need the @google/genai SDK —
// raw fetch() calls to the REST endpoint are unreliable with this key
// format, per prior findings in this project.
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

// --- DATABASE INITIALIZATION (creates tables in PostgreSQL) ---
async function initDb() {
  try {
    await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                email VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255),
                picture TEXT
            );

            CREATE TABLE IF NOT EXISTS vehicles (
                id SERIAL PRIMARY KEY,
                brand VARCHAR(100),
                model VARCHAR(100),
                rating VARCHAR(50),
                description TEXT,
                image_url TEXT
            );

            CREATE TABLE IF NOT EXISTS favorites (
                id SERIAL PRIMARY KEY,
                user_email VARCHAR(255) REFERENCES users(email) ON DELETE CASCADE,
                vehicle_id INT REFERENCES vehicles(id) ON DELETE CASCADE,
                UNIQUE(user_email, vehicle_id)
            );
        `);
    console.log('🟢 Successfully connected to PostgreSQL on Supabase and initialized tables!');
  } catch (err) {
    console.error('🔴 Database initialization error:', err.message);
  }
}

initDb();

app.use(cors());
app.use(express.json());

// --- STATIC FILE SERVING ---
app.use(express.static(path.join(__dirname, 'public')));

// --- API ---

// User login
app.post('/api/login', async (req, res) => {
  const { email, name, picture } = req.body;
  try {
    const query = `
            INSERT INTO users (email, name, picture) 
            VALUES ($1, $2, $3)
            ON CONFLICT (email) DO UPDATE 
            SET name = EXCLUDED.name, picture = EXCLUDED.picture;
        `;
    await db.query(query, [email, name, picture]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Save a favorite
app.post('/api/save', async (req, res) => {
  const { email, vehicleId } = req.body;
  try {
    const query = 'INSERT INTO favorites (user_email, vehicle_id) VALUES ($1, $2)';
    await db.query(query, [email, vehicleId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get the "Good Buys" list
app.get('/api/best-buys', async (req, res) => {
  try {
    const query = "SELECT * FROM vehicles WHERE rating = 'good'";
    const result = await db.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- AI CAR FINDER (knowledge-based, no external redirection) ---
// The AI recommends real-world car MODELS from its own automotive
// knowledge (not a live inventory search) matching the buyer's budget,
// seats, features, and usage. Price ranges here are general/approximate
// — this is the model's training knowledge, not live market data — the
// frontend labels them accordingly rather than presenting them as
// current pricing. The API key stays server-side; the client only ever
// sees this endpoint's JSON response.
//
// Whether a recommended model is actually in Autoencyklopedia's own
// catalog is deliberately NOT decided by Gemini here — that check is a
// real, separate Supabase lookup done on the frontend after this
// response comes back. Asking an LLM to self-report a precise database
// ID match from a list embedded in its prompt risks it getting a match
// wrong, which would silently produce a broken or incorrect "View
// In-House Inspection" link — a real query can't hallucinate that.
app.post('/api/ai-recommendations', async (req, res) => {
  if (!genAI) {
    return res.status(503).json({ error: 'AI assistant is not configured — GEMINI_API_KEY is missing from the server environment.' });
  }
  const { answers } = req.body;
  if (!answers) {
    return res.status(400).json({ error: 'No buyer preferences provided.' });
  }

  const prompt = `You are Gemini — Official Autoencyklopedia AI Advisor. A buyer gave these preferences:
- Budget: ${answers?.budget?.label || 'not specified'}
- Seats needed: ${answers?.seats || 'not specified'}
- Must-have features: ${(answers?.features || []).join(', ') || 'none specified'}
- Primary usage: ${answers?.usage || 'not specified'}
- Preferred body style: ${answers?.bodyStyle || 'no preference'}

Using your general automotive knowledge, recommend 3 to 5 REAL, well-known car models (never invent a fictional model) that reasonably fit this budget and these criteria. For each recommendation:
- brand
- model (include generation/trim where it matters, e.g. "A4 B8 Allroad")
- yearRange (e.g. "2009–2012")
- matchedFeatures: which of the buyer's requested features this model is actually known for (don't claim a feature it doesn't have)
- priceRange: an approximate typical used-market price range for this budget context, clearly a general estimate (e.g. "roughly $12,000–$16,000")`;

  try {
    const response = await genAI.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            recommendations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  brand: { type: Type.STRING },
                  model: { type: Type.STRING },
                  yearRange: { type: Type.STRING },
                  matchedFeatures: { type: Type.ARRAY, items: { type: Type.STRING } },
                  priceRange: { type: Type.STRING },
                },
                required: ['brand', 'model', 'yearRange', 'matchedFeatures', 'priceRange'],
              },
            },
          },
          required: ['recommendations'],
        },
      },
    });
    const parsed = JSON.parse(response.text);
    res.json(parsed);
  } catch (err) {
    console.error('AI car finder error:', err.message);
    res.status(500).json({ error: `AI search failed: ${err.message}` });
  }
});

app.listen(port, 'localhost', () => {
  const url = `http://localhost:${port}`;
  console.log(`Your server is running on port ${port}`);
  console.log(url);

  // Auto-open the browser on start. Uses each OS's own built-in command
  // (no extra npm package needed) — 'open' on macOS, 'start' on Windows,
  // 'xdg-open' on Linux.
  const openCommand =
    process.platform === 'darwin' ? `open ${url}` :
    process.platform === 'win32' ? `start ${url}` :
    `xdg-open ${url}`;
  exec(openCommand, (err) => {
    if (err) console.log('Could not auto-open the browser — just open the link above manually.');
  });
});