# Local Lead Finder

A dark-mode CRM dashboard that lets a sales manager search for local business leads by ZIP code and category, powered by Google Maps data via Apify.

## What it does

1. Enter a postal/ZIP code and a business category (e.g. "restaurants").
2. Click **Search** — the backend queries the Apify Google Maps Scraper.
3. Results appear as markers on a Leaflet map with a dark tile layer.
4. Click a marker to see full lead info (phone, website, rating, address).
5. A **Top Leads** sidebar ranks the best leads by a priority score.
6. Copy phone or website to clipboard with one click.

## Tech stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla HTML / CSS / JS
- **Map:** Leaflet with CARTO dark tiles
- **Data:** Apify `compass~crawler-google-places` actor

## Setup

```bash
cd local-lead-finder
npm install
```

Create a `.env` file (copy the example):

```bash
cp .env.example .env
```

Open `.env` and paste your Apify API token:

```
APIFY_TOKEN=apify_api_XXXXXXXXXXXX
PORT=3000
```

You can get a token at https://console.apify.com/account/integrations

## Run

```bash
npm start
```

Then open http://localhost:3000 in your browser.

## Example search

| Field    | Value       |
| -------- | ----------- |
| ZIP code | E1          |
| Category | restaurants |

This sends `"restaurants E1 London"` to the Apify scraper and returns up to 20 leads with coordinates, phone numbers, websites, and ratings.

## Priority scoring

Leads are ranked by a simple point system:

| Condition        | Points |
| ---------------- | ------ |
| Has phone        | +40    |
| Has website      | +30    |
| Reviews >= 500   | +50    |
| Reviews >= 100   | +20    |
| Reviews >= 20    | +10    |
| Rating >= 4.6    | +40    |
| Rating >= 4.2    | +25    |
| Rating >= 4.0    | +10    |

## Project structure

```
local-lead-finder/
  public/
    index.html      ← UI shell
    styles.css      ← Dark CRM theme
    app.js          ← Frontend logic + Leaflet map
  server.js         ← Express API proxy
  package.json
  .env.example
  README.md
```
