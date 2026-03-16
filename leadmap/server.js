// Redeployed: fix env variables
require('dotenv').config();
const express = require('express');
const https = require('https');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ── Stripe webhook (must be registered before express.json) ──
app.post('/api/webhook', express.raw({ type: 'application/json' }), wrap(async (req, res) => {
  if (!stripe || !supabase) return res.status(503).json({ error: 'Service not configured' });

  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = secret
      ? stripe.webhooks.constructEvent(req.body, sig, secret)
      : JSON.parse(req.body);
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  switch (event.type) {
    case 'customer.subscription.created': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      const customer = await stripe.customers.retrieve(customerId);
      const email = customer.email;
      if (email) {
        await supabase
          .from('users')
          .update({ plan: 'pro', stripe_customer_id: customerId })
          .eq('email', email);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      const customer = await stripe.customers.retrieve(customerId);
      if (customer.email) {
        await supabase
          .from('users')
          .update({ plan: 'free' })
          .eq('email', customer.email);
      }
      break;
    }
  }

  res.json({ received: true });
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers: geocoding & Apify ──

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
      timeout: 10000
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function geocodeLocation(zip, city) {
  const attempts = [
    `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zip)}&countrycode=gb&format=json&limit=1`,
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(zip + ' ' + city)}&format=json&limit=1`,
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&countrycode=gb&format=json&limit=1`
  ];

  for (const url of attempts) {
    try {
      const result = await httpGet(url, { 'User-Agent': 'LeadMap/1.0' });
      const data = JSON.parse(result);
      if (data && data.length > 0) {
        return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

function apifyRequest(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'api.apify.com',
      path: `/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items?token=${process.env.APIFY_TOKEN}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 120000
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Auth helper ──
async function resolveUser(req) {
  if (!supabase) return null;
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
  } catch {
    return null;
  }
}

async function getUserPlan(userId) {
  if (!supabase) return 'free';
  const { data } = await supabase
    .from('users')
    .select('plan')
    .eq('id', userId)
    .single();
  return data?.plan || 'free';
}

// ── GET /api/user-plan ──
app.get('/api/user-plan', wrap(async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return res.json({ plan: 'free' });
  const plan = await getUserPlan(user.id);
  res.json({ plan });
}));

// ── POST /api/ensure-user (called after sign-up to seed users table) ──
app.post('/api/ensure-user', wrap(async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  let user = await resolveUser(req);

  if (!user && req.body.userId) {
    const { data } = await supabase.auth.admin.getUserById(req.body.userId);
    if (data?.user) user = data.user;
  }

  if (!user) return res.status(400).json({ error: 'Could not resolve user.' });

  const { error } = await supabase
    .from('users')
    .upsert({ id: user.id, email: user.email, plan: 'free' }, { onConflict: 'id' });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
}));

// ── POST /api/search ──
app.post('/api/search', wrap(async (req, res) => {
  const { zip, city, category } = req.body;
  if (!zip || !city || !category) {
    return res.status(400).json({ error: 'zip, city, and category are required.' });
  }

  let limit = 5;
  try {
    const user = await resolveUser(req);
    if (user) {
      const plan = await getUserPlan(user.id);
      if (plan === 'pro') limit = 15;
    }
  } catch { /* auth failed — use default limit */ }

  const coords = await geocodeLocation(zip, city);

  try {
    const apifyBody = {
      searchStringsArray: [`${category} in ${zip} ${city}`],
      maxCrawledPlacesPerSearch: limit,
      language: 'en',
    };
    if (coords) {
      apifyBody.lat = coords.lat;
      apifyBody.lng = coords.lng;
      apifyBody.zoom = 13;
    }
    const data = await apifyRequest(apifyBody);

    if (!Array.isArray(data)) {
      const msg = data?.error?.message || data?.message || 'Apify returned invalid response';
      return res.status(502).json({ error: msg });
    }

    const filtered = data.filter((item) => item.totalScore >= 4.0);
    res.json(filtered);
  } catch (err) {
    if (err.message === 'timeout') {
      return res.status(504).json({ error: 'Request timed out (120s). Try again.' });
    }
    res.status(500).json({ error: err.message });
  }
}));

// ── POST /api/create-checkout ──
app.post('/api/create-checkout', wrap(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });

  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  try {
    const origin = req.headers.origin || req.headers.host;
    const baseUrl = origin.startsWith('http') ? origin : `https://${origin}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${baseUrl}?upgraded=true`,
      cancel_url: baseUrl,
      customer_email: user.email,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ── GET /api/health (diagnostics) ──
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    supabase: !!supabase,
    stripe: !!stripe,
    env: {
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
      STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
      STRIPE_PRICE_ID: !!process.env.STRIPE_PRICE_ID,
      APIFY_TOKEN: !!process.env.APIFY_TOKEN,
      APP_URL: process.env.APP_URL || '(not set)',
    }
  });
});

// ── Global error handler (catches unhandled async errors) ──
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`LEADMAP running → http://localhost:${PORT}`);
  });
}

module.exports = app;
