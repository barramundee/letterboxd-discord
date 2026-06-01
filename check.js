const https = require("https");
const fs = require("fs");

// ─── Config (set via GitHub Actions secrets / env vars) ────────────────────
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LETTERBOXD_USERS = (process.env.LETTERBOXD_USERS || "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const SEEN_FILE = "seen.json";

if (!WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");
if (!LETTERBOXD_USERS.length) throw new Error("Missing LETTERBOXD_USERS");

// ─── Helpers ────────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "letterboxd-discord-bot/1.0" } }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function httpsPost(url, body) {
  const data = JSON.stringify(body);
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ─── RSS parser (no dependencies) ───────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const match of itemMatches) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\/${tag}>|<${tag}[^>]*>([^<]*)<\/${tag}>`));
      return m ? (m[1] ?? m[2] ?? "").trim() : null;
    };
    const getAttr = (tag, attr) => {
      const m = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]+)"`));
      return m ? m[1] : null;
    };
    items.push({
      guid: get("guid"),
      title: get("title"),
      link: get("link") || getAttr("link", "href"),
      pubDate: get("pubDate"),
      filmTitle: get("letterboxd:filmTitle"),
      filmYear: get("letterboxd:filmYear"),
      memberRating: get("letterboxd:memberRating"),
      watchedDate: get("letterboxd:watchedDate"),
      rewatch: get("letterboxd:rewatch"),
      description: get("description"),
    });
  }
  return items;
}

function ratingToStars(rating) {
  if (!rating) return null;
  const num = parseFloat(rating);
  const full = Math.floor(num);
  const half = num % 1 >= 0.5;
  return "★".repeat(full) + (half ? "½" : "");
}

function extractPoster(html) {
  if (!html) return null;
  const m = html.match(/<img[^>]+src="([^"]+)"/);
  return m ? m[1] : null;
}

function extractReview(html) {
  if (!html) return null;
  // Skip the first <p> which is usually the poster img wrapper
  const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim()
  ).filter((p) => p.length > 0 && !p.startsWith("<img"));
  return paras[0] || null;
}

// ─── Discord webhook payload ─────────────────────────────────────────────────
function buildPayload(username, item) {
  const stars = ratingToStars(item.memberRating);
  const poster = extractPoster(item.description);
  const review = extractReview(item.description);
  const isRewatch = item.rewatch === "Yes";

  const filmTitle = item.filmTitle
    ? `${item.filmTitle}${item.filmYear ? ` (${item.filmYear})` : ""}`
    : item.title;

  const fields = [];
  if (stars) fields.push({ name: "Rating", value: stars, inline: true });
  if (isRewatch) fields.push({ name: "Rewatch", value: "🔁 Yes", inline: true });

  const embed = {
    color: 0x00c030,
    author: {
      name: `${username} ${isRewatch ? "rewatched" : "watched"} a film`,
      url: `https://letterboxd.com/${username}/`,
    },
    title: filmTitle,
    url: item.link,
    fields,
  };

  if (review) embed.description = review.length > 300 ? review.slice(0, 297) + "…" : review;
  if (poster) embed.thumbnail = { url: poster };

  return { embeds: [embed] };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // Load seen GUIDs
  let seen = new Set();
  try {
    seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")));
  } catch {
    console.log("No seen.json yet — first run, seeding without posting.");
  }
  const isFirstRun = seen.size === 0;

  let changed = false;

  for (const username of LETTERBOXD_USERS) {
    console.log(`Checking ${username}...`);
    let xml;
    try {
      xml = await httpsGet(`https://letterboxd.com/${username}/rss/`);
    } catch (err) {
      console.error(`  Failed to fetch RSS for ${username}:`, err.message);
      continue;
    }

    const items = parseRSS(xml);
    const newItems = items.filter((i) => i.guid && !seen.has(i.guid)).reverse();

    for (const item of newItems) {
      // Only diary/film entries
      const isFilm = item.filmTitle || (item.link && item.link.includes("/film/"));
      if (!isFilm) {
        seen.add(item.guid);
        changed = true;
        continue;
      }

      if (!isFirstRun) {
        try {
          const payload = buildPayload(username, item);
          const res = await httpsPost(WEBHOOK_URL, payload);
          if (res.status === 204 || res.status === 200) {
            console.log(`  ✓ Posted: ${item.filmTitle || item.title}`);
          } else {
            console.error(`  ✗ Webhook error ${res.status}:`, res.body);
          }
          // Respect Discord rate limits
          await new Promise((r) => setTimeout(r, 1000));
        } catch (err) {
          console.error(`  ✗ Failed to post:`, err.message);
        }
      } else {
        console.log(`  Seeding (first run): ${item.filmTitle || item.title}`);
      }

      seen.add(item.guid);
      changed = true;
    }
  }

  if (changed || isFirstRun) {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]), "utf8");
    console.log("saved seen.json");
    // Signal to the workflow that seen.json changed
    fs.writeFileSync("changed.txt", "1");
  } else {
    console.log("Nothing new.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
