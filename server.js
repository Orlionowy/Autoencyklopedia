const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --- POŁĄCZENIE Z BAZĄ SUPABASE (Z POBRANYMI PARAMETRAMI Z .ENV) ---
const db = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

// --- INICJALIZACJA BAZY DANYCH (Tworzenie tabel w PostgreSQL) ---
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
    console.log('🟢 Pomyślnie połączono z PostgreSQL na Supabase i zinicjalizowano tabele!');
  } catch (err) {
    console.error('🔴 Błąd inicjalizacji bazy danych:', err.message);
  }
}

initDb();

app.use(cors());
app.use(express.json());

// --- SERWOWANIE PLIKÓW STATYCZNYCH ---
app.use(express.static(path.join(__dirname, 'public')));

// --- API ---

// Logowanie użytkownika
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

// Zapisywanie ulubionych
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

// Pobieranie listy "Warto kupić"
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

// --- URUCHOMIENIE SERWERA LOKALNEGO ---
app.listen(port, 'localhost', () => {
  const url = `http://localhost:${port}`;
  console.log(`Serwer Twojego biznesu działa na porcie ${port}`);
  console.log(url);

  // Automatyczne otwieranie przeglądarki na macos/win/linux
  const openCommand =
    process.platform === 'darwin' ? `open ${url}` :
    process.platform === 'win32' ? `start ${url}` :
    `xdg-open ${url}`;
    
  exec(openCommand, (err) => {
    if (err) console.log('Could not auto-open the browser — just open the link above manually.');
  });
});