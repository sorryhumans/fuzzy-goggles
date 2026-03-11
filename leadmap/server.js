require('dotenv').config();
const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = 3000;

function geocodeZip(zip, city) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'nominatim.openstreetmap.org',
      path: `/search?postalcode=${encodeURIComponent(zip)}&city=${encodeURIComponent(city)}&format=json&limit=1`,
      method: 'GET',
      headers: { 'User-Agent': 'LeadMap/1.0' },
      timeout: 10000
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.length) return reject(new Error('no_results'));
          resolve({ lat: data[0].lat, lng: data[0].lon });
        } catch { reject(new Error('no_results')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('no_results')); });
    req.end();
  });
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/search', async (req, res) => {
  const { zip, city, category } = req.body;

  if (!zip || !city || !category) {
    return res.status(400).json({ error: 'zip, city, and category are required.' });
  }

  let coords;
  try {
    coords = await geocodeZip(zip, city);
  } catch {
    return res.status(400).json({ error: 'Could not find location for ZIP code' });
  }

  try {
    const data = await apifyRequest({
      searchStringsArray: [`${category} in ${zip} ${city}`],
      maxCrawledPlacesPerSearch: 10,
      language: 'en',
      lat: coords.lat,
      lng: coords.lng,
      zoom: 13,
    });

    const filtered = data.filter((item) => item.totalScore >= 4.0);
    res.json(filtered);
  } catch (err) {
    if (err.message === 'timeout') {
      return res.status(504).json({ error: 'Request timed out (120s). Try again.' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`LEADMAP running → http://localhost:${PORT}`);
});
