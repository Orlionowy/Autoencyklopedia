const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const { GoogleGenAI, Type } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const PDFDocument = require('pdfkit');

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

// --- SUPABASE ADMIN CLIENT (service role — server-side only) ---
// Used to (a) verify a user's access token so we know who's really
// making a request, and (b) write to valuation_credits/valuation_logs,
// which RLS deliberately blocks the browser from writing to directly.
// This key bypasses RLS entirely — it must never be sent to the client
// or committed anywhere; it only ever lives in this server's .env.
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

// --- STRIPE (server-side only) ---
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

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
app.use(express.json({
  // Captures the exact raw bytes of every request body into req.rawBody
  // BEFORE they're parsed into req.body. The Stripe webhook handler
  // below uses req.rawBody specifically, because signature verification
  // fails if given the re-serialized parsed object instead of the exact
  // bytes Stripe originally signed — this holds true regardless of
  // where the webhook route is registered relative to this middleware.
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

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

// --- AUTH HELPER ---
// Verifies the caller's real Supabase session token (sent as
// "Authorization: Bearer <token>") rather than trusting a client-
// supplied user id, which anyone could fake. Returns the verified user
// object or null. Every valuation-engine route below uses this — it's
// the actual security boundary between "user asking about their own
// credits" and "user claiming to be someone else to drain their
// credits or dodge the paywall."
async function getVerifiedUser(req) {
  if (!supabaseAdmin) return null;
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

// --- AI VEHICLE VALUATION ENGINE ---
// Free trial + paid credits, tied to the real authenticated user (see
// 26_ai_valuation_engine.sql for why — not IP/session, both of which
// are trivially reset by anyone trying to get unlimited free trials).

// Looks up (creating if needed) a user's credit row. First-ever lookup
// grants their single free trial credit automatically.
async function getOrCreateCredits(userId) {
  const { data: existing } = await supabaseAdmin
    .from('valuation_credits')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await supabaseAdmin
    .from('valuation_credits')
    .insert({ user_id: userId, credits: 1 })
    .select()
    .single();
  if (error) throw error;
  return created;
}

app.post('/api/valuation/check-access', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Valuation engine is not configured — SUPABASE_SERVICE_ROLE_KEY is missing from the server environment.' });
  const user = await getVerifiedUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });
  try {
    const credits = await getOrCreateCredits(user.id);
    res.json({ hasAccess: credits.credits > 0, creditsRemaining: credits.credits });
  } catch (err) {
    console.error('check-access error:', err.message);
    res.status(500).json({ error: 'Could not check valuation access.' });
  }
});

// Server-side source of truth for pack pricing — never trust a price or
// credit amount sent from the client, since that would let anyone just
// request a €0.01 charge for 10 credits by editing the request body.
const VALUATION_PACKS = {
  single:  { credits: 1,  amountCents: 299,  label: 'AI Vehicle Valuation — 1 use' },
  pack_5:  { credits: 5,  amountCents: 999,  label: 'AI Vehicle Valuation — 5-pack' },
  pack_10: { credits: 10, amountCents: 1499, label: 'AI Vehicle Valuation — 10-pack' },
};

app.post('/api/checkout/valuation-pass', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured — STRIPE_SECRET_KEY is missing from the server environment.' });
  const user = await getVerifiedUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });
  const packType = VALUATION_PACKS[req.body.pack_type] ? req.body.pack_type : 'single';
  const pack = VALUATION_PACKS[packType];
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      client_reference_id: user.id,
      metadata: { pack_type: packType }, // read back in the webhook below to know how many credits to grant
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: pack.label },
          unit_amount: pack.amountCents,
        },
        quantity: 1,
      }],
      success_url: `${process.env.APP_BASE_URL || 'http://localhost:' + port}/?valuation=success`,
      cancel_url: `${process.env.APP_BASE_URL || 'http://localhost:' + port}/?valuation=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout session error:', err.message);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

// Stripe webhook — this is the ONLY place credits get added from a
// payment. Uses req.rawBody (captured by the verify option on
// express.json() above), NOT req.body, since signature verification
// needs the exact original bytes Stripe signed, not a re-parsed object.
app.post('/api/webhook/stripe', async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Webhook not configured.');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    // Re-derive the credit amount from our own server-side pack table
    // using the pack_type read back from Stripe metadata — never trust
    // a credit count that could have come from the client.
    const packType = session.metadata?.pack_type;
    const pack = VALUATION_PACKS[packType] || VALUATION_PACKS.single;
    if (userId) {
      try {
        const credits = await getOrCreateCredits(userId);
        await supabaseAdmin
          .from('valuation_credits')
          .update({ credits: credits.credits + pack.credits, updated_at: new Date().toISOString() })
          .eq('user_id', userId);
      } catch (err) {
        console.error('Failed to credit user after payment:', err.message);
        // Still return 200 below — Stripe will retry on non-2xx, but a
        // DB failure here needs manual investigation, not an infinite
        // retry loop hammering the same broken write.
      }
    }
  }

  res.json({ received: true }); // Respond quickly; Stripe times out and retries otherwise.
});

// Computed in code, not by the AI — counting ratings is arithmetic, and
// arithmetic shouldn't be delegated to an LLM when it can just be
// computed correctly and reliably instead.
function computeDiagnosticScore(condition) {
  const values = Object.values(condition || {});
  const total = values.length;
  if (!total) return { good: 0, ok: 0, bad: 0, total: 0, percentage: 0 };
  const good = values.filter(v => v === 'Good').length;
  const ok = values.filter(v => v === 'OK').length;
  const bad = values.filter(v => v === 'Bad').length;
  const percentage = Math.round(((good * 100) + (ok * 50)) / total);
  return { good, ok, bad, total, percentage };
}

app.post('/api/valuation/generate', async (req, res) => {
  if (!genAI) return res.status(503).json({ error: 'AI valuation is not configured — GEMINI_API_KEY is missing.' });
  if (!supabaseAdmin) return res.status(503).json({ error: 'Valuation engine is not configured — SUPABASE_SERVICE_ROLE_KEY is missing.' });
  const user = await getVerifiedUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });

  const { vehicleDetails } = req.body;
  if (!vehicleDetails) return res.status(400).json({ error: 'No vehicle details provided.' });

  try {
    const credits = await getOrCreateCredits(user.id);
    if (credits.credits <= 0) {
      return res.status(402).json({ error: 'No valuation credits remaining.', needsPayment: true });
    }

    const diagnosticScore = computeDiagnosticScore(vehicleDetails.condition);

    const prompt = `You are an expert automotive appraiser for Autoencyklopedia. A buyer inspected a used vehicle against a detailed checklist and rated each item they were able to assess as Bad, OK, or Good. Given the vehicle details and the inspection results below, provide a fair market valuation and itemized repair cost estimate.

Vehicle: ${vehicleDetails.brand || ''} ${vehicleDetails.model || ''} (${vehicleDetails.year || 'year unknown'}), ${vehicleDetails.mileageKm || 'unknown'} km
Seller's claimed price: ${vehicleDetails.claimedPrice || 'not given'}

Inspection results (organized by category — each item listed was rated Bad, OK, or Good; anything not listed simply wasn't assessed, which is not the same as being Bad — don't treat missing items as evidence of a problem):
${JSON.stringify(vehicleDetails.condition, null, 2)}

Overall diagnostic score: ${diagnosticScore.percentage}% (${diagnosticScore.good} Good, ${diagnosticScore.ok} OK, ${diagnosticScore.bad} Bad, out of ${diagnosticScore.total} items actually rated)

Respond with a realistic estimated fair transaction value (compare this against the seller's claimed price if one was given), an itemized list of likely repair costs implied by any "Bad" or "OK" ratings (skip items rated "Good" — no genuine issue there), and a short 2-3 sentence justification referencing the specific inspection findings.`;

    const response = await genAI.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            estimatedPriceRange: { type: Type.STRING },
            itemizedRepairCosts: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  item: { type: Type.STRING },
                  estimatedCost: { type: Type.STRING },
                },
                required: ['item', 'estimatedCost'],
              },
            },
            justification: { type: Type.STRING },
          },
          required: ['estimatedPriceRange', 'itemizedRepairCosts', 'justification'],
        },
      },
    });
    const aiResult = JSON.parse(response.text);
    aiResult.diagnosticScore = diagnosticScore;

    // Deduct the credit and log the result only after a successful
    // generation — a failed AI call shouldn't cost the user their credit.
    await supabaseAdmin
      .from('valuation_credits')
      .update({ credits: credits.credits - 1, updated_at: new Date().toISOString() })
      .eq('user_id', user.id);
    const { data: logRow } = await supabaseAdmin
      .from('valuation_logs')
      .insert({ user_id: user.id, vehicle_details: vehicleDetails, ai_result: aiResult, paid: credits.credits <= 1 })
      .select()
      .single();

    res.json({ result: aiResult, creditsRemaining: credits.credits - 1, logId: logRow?.id || null });
  } catch (err) {
    console.error('valuation generate error:', err.message);
    res.status(500).json({ error: 'Valuation failed.' });
  }
});

// --- PDF REPORT DOWNLOAD ---
// Generated fresh on each request rather than saved to disk — a budget
// VPS has limited storage, and there's no reason to accumulate PDF
// files for reports that might only ever be downloaded once (or never).
// Critically: this verifies the log actually belongs to the requesting
// authenticated user before generating anything — without that check,
// anyone could download anyone else's valuation report just by
// guessing/incrementing an id in the URL.
// Labels for the PDF, matching the real item ids from index.html's
// index.html exactly (same ids as CHECKLIST_SECTIONS above) — only
// used to display which items were verified, grouped under their real
// category headers, instead of a flat dump of raw ids.
const PDF_CHECKLIST_LABELS = [
  { category: 'External Bodywork', items: [
    { id: 'ext_paint', label: 'Paint condition — consistent color/texture, no overspray or mismatched shades' },
    { id: 'ext_gaps', label: 'Panel gaps — even and symmetrical' },
    { id: 'ext_rust', label: 'Rust — wheel arches, sills, door bottoms, trunk floor' },
    { id: 'ext_glass', label: 'Glass condition — chips, cracks, wiper wear, tint' },
  ]},
  { category: 'Technical Condition (Under Hood & Underbody)', items: [
    { id: 'mech_fluids', label: 'Fluid levels — engine oil, coolant, brake fluid, power steering fluid' },
    { id: 'mech_oil_color', label: 'Oil condition — dipstick check for milky residue' },
    { id: 'mech_leaks', label: 'Visible leaks — under the engine and on the ground' },
    { id: 'mech_belts', label: 'Belt condition — cracks, fraying, glazing' },
    { id: 'mech_battery', label: 'Battery terminals — corrosion or loose connections' },
    { id: 'mech_suspension', label: 'Suspension — bushings, shocks/struts' },
    { id: 'mech_underbody_rust', label: 'Underbody rust — subframe, exhaust, floor pans' },
  ]},
  { category: 'Interior & Electronics', items: [
    { id: 'int_ac', label: 'Air conditioning — blows cold within about a minute' },
    { id: 'int_dash', label: 'Dashboard warning lights — all clear after startup' },
    { id: 'int_upholstery', label: 'Upholstery and seat wear — consistent with claimed mileage' },
    { id: 'int_windows', label: 'Windows and central locking — open, close, lock smoothly' },
    { id: 'int_switches', label: 'Infotainment, mirrors, lights, wipers — every switch works' },
  ]},
  { category: 'Test Drive', items: [
    { id: 'td_clutch', label: 'Clutch engagement / gearbox shifts — smooth, no slipping or grinding' },
    { id: 'td_brakes', label: 'Braking — straight line, no pulling, no pedal vibration' },
    { id: 'td_steering', label: 'Steering — no excessive play, holds straight line' },
    { id: 'td_noises', label: 'Unusual noises — knocks, whines, rattles' },
    { id: 'td_coldstart', label: 'Cold start behavior' },
  ]},
  { category: 'Documents & History', items: [
    { id: 'doc_vin', label: 'VIN number — matches dashboard, door jamb, documents' },
    { id: 'doc_registration', label: "Registration papers — match seller's ID and the car" },
    { id: 'doc_servicebook', label: 'Service book / maintenance records — line up with odometer' },
    { id: 'doc_finance', label: 'Outstanding finance check — no unsettled loan' },
    { id: 'doc_writeoff', label: 'Accident / insurance write-off history' },
  ]},
];

app.get('/api/valuation/pdf/:logId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Valuation engine is not configured.' });
  const user = await getVerifiedUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });

  try {
    const { data: log, error } = await supabaseAdmin
      .from('valuation_logs')
      .select('*')
      .eq('id', req.params.logId)
      .single();
    if (error || !log) return res.status(404).json({ error: 'Report not found.' });
    if (log.user_id !== user.id) return res.status(403).json({ error: 'This report does not belong to you.' });

    const v = log.vehicle_details || {};
    const r = log.ai_result || {};

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="valuation-${log.id}.pdf"`);

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    doc.fontSize(20).fillColor('#0ea5e9').text('Autoencyklopedia', { continued: true }).fillColor('#0f172a').text(' — AI Vehicle Valuation Report');
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#64748b').text(new Date(log.created_at).toLocaleString());
    doc.moveDown(1.2);

    doc.fontSize(13).fillColor('#0f172a').text('Vehicle Details', { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(11).fillColor('#334155');
    doc.text(`Make: ${v.brand || '—'}`);
    doc.text(`Model: ${v.model || '—'}`);
    doc.text(`Year: ${v.year || '—'}`);
    doc.text(`Mileage: ${v.mileageKm ? v.mileageKm + ' km' : '—'}`);
    if (v.claimedPrice) doc.text(`Seller's claimed price: ${v.claimedPrice}`);
    doc.moveDown(1);

    if (r.diagnosticScore) {
      doc.fontSize(13).fillColor('#0f172a').text('Overall Diagnostic Score', { underline: true });
      doc.moveDown(0.4);
      doc.fontSize(18).fillColor(r.diagnosticScore.percentage >= 70 ? '#16a34a' : r.diagnosticScore.percentage >= 40 ? '#d97706' : '#dc2626')
        .text(`${r.diagnosticScore.percentage}%`);
      doc.fontSize(10).fillColor('#64748b')
        .text(`${r.diagnosticScore.good} Good · ${r.diagnosticScore.ok} OK · ${r.diagnosticScore.bad} Bad (of ${r.diagnosticScore.total} items rated)`);
      doc.moveDown(1);
    }

    doc.fontSize(13).fillColor('#0f172a').text('Inspection Checklist Results', { underline: true });
    doc.moveDown(0.4);
    const condition = v.condition || {};
    PDF_CHECKLIST_LABELS.forEach(cat => {
      const catItems = cat.items.filter(i => condition[i.id]);
      if (!catItems.length) return;
      doc.fontSize(10.5).fillColor('#0ea5e9').text(cat.category);
      catItems.forEach(i => {
        const rating = condition[i.id];
        const color = rating === 'Good' ? '#16a34a' : rating === 'OK' ? '#d97706' : '#dc2626';
        doc.fontSize(10).fillColor('#334155').text(`  ${i.label}: `, { continued: true }).fillColor(color).text(rating);
      });
      doc.moveDown(0.5);
    });
    if (!Object.keys(condition).length) {
      doc.fontSize(10).fillColor('#64748b').text('No items were rated on the checklist before this report was generated.');
    }
    doc.moveDown(0.5);

    doc.fontSize(13).fillColor('#0f172a').text('Itemized Repair Cost Estimate', { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(11).fillColor('#334155');
    const items = Array.isArray(r.itemizedRepairCosts) ? r.itemizedRepairCosts : [];
    if (items.length) {
      items.forEach(i => doc.text(`• ${i.item}: ${i.estimatedCost}`));
    } else {
      doc.text('No repair items flagged — condition ratings given did not indicate outstanding issues.');
    }
    doc.moveDown(1);

    doc.fontSize(13).fillColor('#0f172a').text('Estimated Real Transaction Value', { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(16).fillColor('#0ea5e9').text(r.estimatedPriceRange || '—');
    doc.moveDown(0.8);
    doc.fontSize(10).fillColor('#64748b').text(r.justification || '');

    doc.moveDown(2);
    doc.fontSize(8).fillColor('#94a3b8').text('This report is an AI-generated estimate for informational purposes only and does not constitute a professional appraisal or guarantee of sale price.', { align: 'center' });

    doc.end();
  } catch (err) {
    console.error('PDF generation error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not generate PDF.' });
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