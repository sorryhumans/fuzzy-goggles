// ─── DOM refs ────────────────────────────────────────────────────────
const zipInput = document.getElementById("zipInput");
const categoryInput = document.getElementById("categoryInput");
const searchBtn = document.getElementById("searchBtn");
const statusMsg = document.getElementById("statusMsg");
const leadsList = document.getElementById("leadsList");
const leadsCount = document.getElementById("leadsCount");
const toastEl = document.getElementById("toast");

// ─── Map setup ───────────────────────────────────────────────────────
const map = L.map("map").setView([51.515, -0.07], 13);

L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution:
    '&copy; <a href="https://carto.com/">CARTO</a> · <a href="https://osm.org/copyright">OSM</a>',
  maxZoom: 19,
}).addTo(map);

let markers = [];
let allLeads = [];

// ─── Search ──────────────────────────────────────────────────────────
searchBtn.addEventListener("click", handleSearch);
zipInput.addEventListener("keydown", (e) => { if (e.key === "Enter") handleSearch(); });
categoryInput.addEventListener("keydown", (e) => { if (e.key === "Enter") handleSearch(); });

async function handleSearch() {
  const zip = zipInput.value.trim();
  const category = categoryInput.value.trim();

  if (!zip || !category) {
    showStatus("Please fill in both fields.", "error");
    return;
  }

  setLoading(true);
  showStatus("Searching leads…", "loading");

  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zip, category }),
    });

    const data = await res.json();

    if (!res.ok) {
      showStatus(data.error || "Search failed.", "error");
      return;
    }

    if (!data.length) {
      showStatus("No leads found. Try a different search.", "error");
      clearResults();
      return;
    }

    showStatus(`${data.length} leads found`, "success");
    renderResults(data);
  } catch {
    showStatus("Network error — is the server running?", "error");
  } finally {
    setLoading(false);
  }
}

// ─── Render ──────────────────────────────────────────────────────────
function renderResults(leads) {
  clearResults();
  allLeads = leads;

  const bounds = [];
  leads.forEach((lead) => {
    const marker = L.marker([lead.lat, lead.lng]).addTo(map);
    marker.bindPopup(buildPopupHTML(lead), { maxWidth: 320, className: "notion-popup" });
    markers.push(marker);
    bounds.push([lead.lat, lead.lng]);
  });

  if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });

  renderSidebar(leads.slice(0, 10));
}

function clearResults() {
  markers.forEach((m) => map.removeLayer(m));
  markers = [];
  allLeads = [];
  leadsCount.textContent = "";
  leadsList.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </div>
      <p>No leads yet</p>
      <span>Run a search to populate this list.</span>
    </div>`;
}

// ─── Popup ───────────────────────────────────────────────────────────
function buildPopupHTML(lead) {
  const rating = lead.rating !== null
    ? `<div class="popup-rating">
         <span class="popup-rating-score">${lead.rating}</span>
         <span>★</span>
         <span class="popup-rating-count">${lead.reviews ? lead.reviews.toLocaleString() + " reviews" : ""}</span>
       </div>` : "";

  const rows = [];
  rows.push(row("Address", esc(lead.address)));
  if (lead.phone) rows.push(row("Phone", esc(lead.phone)));
  if (lead.website) rows.push(row("Website", `<a href="${esc(lead.website)}" target="_blank" rel="noopener">${truncate(lead.website, 32)}</a>`));
  if (lead.emails && lead.emails.length) {
    const links = lead.emails.map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join(", ");
    rows.push(row("Email", links));
  }

  let socialsHTML = "";
  if (lead.socials && Object.keys(lead.socials).length) {
    const labels = { facebook:"fb", instagram:"ig", twitter:"x", linkedin:"in", youtube:"yt", tiktok:"tk", pinterest:"pin", yelp:"yelp" };
    const tags = Object.entries(lead.socials).map(([k, url]) =>
      `<a class="social-tag" href="${esc(url)}" target="_blank" rel="noopener">${labels[k] || k}</a>`
    ).join("");
    socialsHTML = `<div class="popup-socials">${tags}</div>`;
  }

  let hoursHTML = "";
  if (lead.openingHours) {
    let text = "";
    if (Array.isArray(lead.openingHours)) {
      text = lead.openingHours.map((h) => typeof h === "string" ? h : `${h.day || ""}: ${h.hours || ""}`.trim()).join(" · ");
    } else if (typeof lead.openingHours === "string") {
      text = lead.openingHours;
    }
    if (text) hoursHTML = `<div class="popup-hours">${esc(truncate(text, 100))}</div>`;
  }

  const actions = [];
  if (lead.phone)                    actions.push(`<button class="popup-btn" onclick="copyText('${esc(lead.phone)}','phone')">Copy phone</button>`);
  if (lead.website)                  actions.push(`<button class="popup-btn" onclick="copyText('${esc(lead.website)}','website')">Copy website</button>`);
  if (lead.emails && lead.emails[0]) actions.push(`<button class="popup-btn" onclick="copyText('${esc(lead.emails[0])}','email')">Copy email</button>`);
  if (lead.mapsUrl)                  actions.push(`<a class="popup-btn accent" href="${esc(lead.mapsUrl)}" target="_blank" rel="noopener">Google Maps</a>`);

  return `
    <div class="popup-name">${esc(lead.name)}</div>
    <div class="popup-category">${esc(lead.category)}</div>
    ${rating}
    <div class="popup-section">
      ${rows.join("")}
    </div>
    ${socialsHTML}
    ${hoursHTML}
    ${actions.length ? `<div class="popup-actions">${actions.join("")}</div>` : ""}
  `;
}

function row(label, value) {
  return `<div class="popup-row"><span class="popup-row-label">${label}</span><span class="popup-row-value">${value}</span></div>`;
}

// ─── Sidebar ─────────────────────────────────────────────────────────
function renderSidebar(leads) {
  leadsList.innerHTML = "";
  leadsCount.textContent = `${allLeads.length} total`;

  leads.forEach((lead, i) => {
    const card = document.createElement("div");
    card.className = "lead-card";

    const ratingStr = lead.rating !== null ? `★ ${lead.rating}` : "";
    const reviewsStr = lead.reviews ? `${lead.reviews.toLocaleString()} rev` : "";

    const tags = [];
    if (lead.phone) tags.push(tag("Phone"));
    if (lead.website) tags.push(tag("Web"));
    if (lead.emails && lead.emails.length) tags.push(tag("Email"));
    const sc = lead.socials ? Object.keys(lead.socials).length : 0;
    if (sc) tags.push(tag(`${sc} social`));

    card.innerHTML = `
      <div class="lead-card-row1">
        <span class="lead-card-name">${esc(lead.name)}</span>
        <span class="priority-badge">${lead.priority}</span>
      </div>
      <div class="lead-card-row2">
        <span>${esc(lead.category)}</span>
        <span class="divider">·</span>
        <span>${ratingStr}</span>
        ${reviewsStr ? `<span class="divider">·</span><span>${reviewsStr}</span>` : ""}
      </div>
      ${tags.length ? `<div class="lead-card-contacts">${tags.join("")}</div>` : ""}
    `;

    card.addEventListener("click", () => {
      map.setView([lead.lat, lead.lng], 16);
      if (markers[i]) markers[i].openPopup();
    });

    leadsList.appendChild(card);
  });
}

function tag(label) {
  return `<span class="contact-tag">${esc(label)}</span>`;
}

// ─── Helpers ─────────────────────────────────────────────────────────
function setLoading(on) {
  searchBtn.disabled = on;
  searchBtn.textContent = on ? "Searching…" : "Search";
}

function showStatus(msg, type) {
  statusMsg.textContent = msg;
  statusMsg.className = "status-pill " + (type || "");
}

function copyText(text, label) {
  navigator.clipboard.writeText(text).then(() => showToast(`Copied ${label}`));
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("visible");
  setTimeout(() => toastEl.classList.remove("visible"), 1800);
}

function esc(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n) + "…" : str;
}
