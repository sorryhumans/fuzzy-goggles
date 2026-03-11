require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const APIFY_TOKEN = process.env.APIFY_TOKEN;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Lead priority scoring ───────────────────────────────────────────
function scoreLead(lead) {
  let score = 0;
  if (lead.phone) score += 40;
  if (lead.website) score += 30;
  if (lead.reviews >= 500) score += 50;
  else if (lead.reviews >= 100) score += 20;
  else if (lead.reviews >= 20) score += 10;
  if (lead.rating >= 4.6) score += 40;
  else if (lead.rating >= 4.2) score += 25;
  else if (lead.rating >= 4.0) score += 10;
  return score;
}

// ─── Extract enriched contact details from website scrape ────────────
function extractContacts(raw) {
  const emails = raw.emails || raw.email
    ? Array.isArray(raw.emails) ? raw.emails : (raw.email ? [raw.email] : [])
    : [];

  const socials = {};
  const socialFields = [
    "facebook", "instagram", "twitter", "linkedin",
    "youtube", "tiktok", "pinterest", "yelp",
  ];
  for (const key of socialFields) {
    const val = raw[key] || raw[`${key}Url`] || null;
    if (val) socials[key] = val;
  }

  if (raw.socialMedia && typeof raw.socialMedia === "object") {
    for (const [key, val] of Object.entries(raw.socialMedia)) {
      if (val && !socials[key.toLowerCase()]) {
        socials[key.toLowerCase()] = val;
      }
    }
  }

  const openingHours = raw.openingHours || raw.hours || null;

  return { emails, socials, openingHours };
}

// ─── Normalize one Apify result into a clean lead object ─────────────
function normalizeLead(raw) {
  const lat = raw.location?.lat ?? null;
  const lng = raw.location?.lng ?? null;
  const contacts = extractContacts(raw);

  const lead = {
    name: raw.title || "Unknown",
    category: raw.categoryName || raw.categories?.[0] || "N/A",
    address: raw.address || raw.street || "N/A",
    phone: raw.phone || null,
    website: raw.website || null,
    rating: raw.totalScore ?? null,
    reviews: raw.reviewsCount ?? 0,
    mapsUrl: raw.url || null,
    imageUrl: raw.imageUrl || raw.thumbnailUrl || null,
    lat,
    lng,
    emails: contacts.emails,
    socials: contacts.socials,
    openingHours: contacts.openingHours,
  };

  lead.priority = scoreLead(lead);
  return lead;
}

// ─── POST /api/search ────────────────────────────────────────────────
app.post("/api/search", async (req, res) => {
  try {
    const zip = (req.body.zip || "").trim();
    const category = (req.body.category || "").trim();

    if (!zip || !category) {
      return res.status(400).json({ error: "Both ZIP code and category are required." });
    }

    if (!APIFY_TOKEN) {
      return res.status(500).json({ error: "Server is missing the Apify API token." });
    }

    // Extract postcode district: "e3 2zn" → "E3", "SW1A" → "SW1A", "E3" → "E3"
    const zipDistrict = zip.replace(/\s+/g, "").toUpperCase().match(/^[A-Z]{1,2}\d{1,2}[A-Z]?/)?.[0] || zip.toUpperCase().trim();

    // Word-boundary regex so "E3" matches " E3 2ZN" but NOT "WC2E 3XX"
    const zipRegex = new RegExp(`\\b${zipDistrict}\\b`, "i");

    const searchString = `${category} ${zipDistrict} London`;
    const apifyUrl =
      `https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;

    const apifyBody = {
      searchStringsArray: [searchString],
      locationQuery: `${zipDistrict}, London, UK`,
      maxCrawledPlacesPerSearch: 40,
      includeEnrichedContactInformation: true,
      additionalInfo: true,
    };

    console.log(`[search] query="${searchString}" location="${zipDistrict}, London, UK" filter=/${zipRegex.source}/i`);

    const response = await fetch(apifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(apifyBody),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("[apify] error:", response.status, text);
      return res.status(502).json({ error: "Apify request failed. Check your token and try again." });
    }

    const rawResults = await response.json();

    const withCoords = rawResults
      .map(normalizeLead)
      .filter((l) => l.lat !== null && l.lng !== null);

    // Strict filter: only keep leads whose address contains the postcode district
    const leads = withCoords
      .filter((l) => {
        if (!l.address || l.address === "N/A") return false;
        return zipRegex.test(l.address);
      })
      .sort((a, b) => b.priority - a.priority);

    console.log(`[search] ${rawResults.length} raw → ${withCoords.length} with coords → ${leads.length} in ${zipDistrict}`);
    if (leads.length === 0 && withCoords.length > 0) {
      console.log(`[search] sample addresses that were filtered out:`);
      withCoords.slice(0, 5).forEach((l) => console.log(`  - "${l.address}"`));
    }
    res.json(leads);
  } catch (err) {
    console.error("[search] unexpected error:", err);
    res.status(500).json({ error: "Something went wrong on the server." });
  }
});

app.listen(PORT, () => {
  console.log(`Local Lead Finder running → http://localhost:${PORT}`);
});
