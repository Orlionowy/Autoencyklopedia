const express = require('express');
const path = require('path');
const cors = require('cors');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');
const dbPath = path.resolve(__dirname, process.env.DATABASE_PATH || './data/vehicles.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    picture TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS vehicles (
    id TEXT PRIMARY KEY,
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('car', 'motorcycle', 'boat', 'engine')),
    rating TEXT NOT NULL CHECK (rating IN ('good', 'watch', 'avoid')),
    source_note TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS favorites (
    user_email TEXT NOT NULL,
    vehicle_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_email, vehicle_id),
    FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  );
`);

const seedVehicle = db.prepare(`
  INSERT INTO vehicles (id, make, model, category, rating, source_note)
  VALUES (@id, @make, @model, @category, @rating, @source_note)
  ON CONFLICT(id) DO UPDATE SET
    make = excluded.make,
    model = excluded.model,
    category = excluded.category,
    rating = excluded.rating,
    source_note = excluded.source_note,
    updated_at = CURRENT_TIMESTAMP
`);

[
  {
    id: 'toyota-corolla',
    make: 'Toyota',
    model: 'Corolla',
    category: 'car',
    rating: 'good',
    source_note: 'General buyer shortlist item. Confirm exact year, recalls, service history, rust, and trim-specific issues.'
  },
  {
    id: 'honda-civic',
    make: 'Honda',
    model: 'Civic',
    category: 'car',
    rating: 'good',
    source_note: 'General buyer shortlist item. Confirm generation-specific transmission, rust, A/C, and recall history.'
  },
  {
    id: 'mazda-3',
    make: 'Mazda',
    model: '3',
    category: 'car',
    rating: 'good',
    source_note: 'General buyer shortlist item. Older cars need careful rust and maintenance checks.'
  },
  {
    id: 'suzuki-sv650',
    make: 'Suzuki',
    model: 'SV650',
    category: 'motorcycle',
    rating: 'good',
    source_note: 'General motorcycle shortlist item. Confirm maintenance, crash history, tires, chain, brakes, and recalls.'
  }
].forEach((vehicle) => seedVehicle.run(vehicle));

const corsOrigin = process.env.CORS_ORIGIN || true;
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '100kb' }));

app.use(express.static(publicDir, {
  extensions: ['html'],
  index: 'index.html'
}));

function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, database: path.relative(__dirname, dbPath) });
});

app.post('/api/login', (req, res) => {
  const email = cleanText(req.body.email, 254).toLowerCase();
  const name = cleanText(req.body.name, 120);
  const picture = cleanText(req.body.picture, 1000);

  if (!isEmail(email) || !name) {
    return res.status(400).json({ error: 'Valid email and name are required.' });
  }

  const stmt = db.prepare(`
    INSERT INTO users (email, name, picture)
    VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = excluded.name,
      picture = excluded.picture,
      updated_at = CURRENT_TIMESTAMP
  `);

  stmt.run(email, name, picture || null);
  res.json({ success: true, user: { email, name, picture: picture || null } });
});

app.post('/api/save', (req, res) => {
  const email = cleanText(req.body.email, 254).toLowerCase();
  const vehicleId = cleanText(req.body.vehicleId, 120);

  if (!isEmail(email) || !vehicleId) {
    return res.status(400).json({ error: 'Valid email and vehicleId are required.' });
  }

  const vehicle = db.prepare('SELECT id FROM vehicles WHERE id = ?').get(vehicleId);
  if (!vehicle) {
    return res.status(404).json({ error: 'Vehicle not found in the database.' });
  }

  db.prepare('INSERT OR IGNORE INTO favorites (user_email, vehicle_id) VALUES (?, ?)').run(email, vehicleId);
  res.json({ success: true });
});

app.get('/api/favorites/:email', (req, res) => {
  const email = cleanText(req.params.email, 254).toLowerCase();
  if (!isEmail(email)) {
    return res.status(400).json({ error: 'Valid email is required.' });
  }

  const favorites = db.prepare(`
    SELECT vehicles.*
    FROM favorites
    JOIN vehicles ON vehicles.id = favorites.vehicle_id
    WHERE favorites.user_email = ?
    ORDER BY favorites.created_at DESC
  `).all(email);

  res.json(favorites);
});

app.delete('/api/favorites/:email/:vehicleId', (req, res) => {
  const email = cleanText(req.params.email, 254).toLowerCase();
  const vehicleId = cleanText(req.params.vehicleId, 120);

  if (!isEmail(email) || !vehicleId) {
    return res.status(400).json({ error: 'Valid email and vehicleId are required.' });
  }

  db.prepare('DELETE FROM favorites WHERE user_email = ? AND vehicle_id = ?').run(email, vehicleId);
  res.json({ success: true });
});

app.get('/api/best-buys', (req, res) => {
  const vehicles = db.prepare(`
    SELECT id, make, model, category, rating, source_note, updated_at
    FROM vehicles
    WHERE rating = 'good'
    ORDER BY make, model
  `).all();

  res.json(vehicles);
});

app.get('*splat', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

app.listen(port, () => {
  console.log(`AutoEncyclopedia server running at http://localhost:${port}`);
});
