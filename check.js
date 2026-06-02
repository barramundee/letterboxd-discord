const https = require("https");
const fs = require("fs");

// ─── Config ────────────────────────────────────────────────────────────────
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LETTERBOXD_USERS = (process.env.LETTERBOXD_USERS || "")
  .split(",").map((u) => u.trim()).filter(Boolean);
const SEEN_FILE = "seen.json";

if (!WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");
if (!LETTERBOXD_USERS.length) throw new Error("Missing LETTERBOXD_USERS");

// ─── Helpers ────────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "letterboxd-discord-bot/1.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function httpsPost(url, body) {
  const data = JSON.stringify(body);
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── RSS parser ──────────────────────────────────────────────────────────────
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
  const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim()
  ).filter((p) => p.length > 0 && !p.startsWith("<img"));
  return paras[0] || null;
}

// ─── Watchlist scraper (HTML) ────────────────────────────────────────────────
async function fetchWatchlist(username) {
  const html = await httpsGet(`https://letterboxd.com/${username}/watchlist/`);
  if (!html || typeof html !== "string") return { films: [], total: null };

  // Extract total count from e.g. "You want to see 158 films" or "158 films"
  const totalMatch = html.match(/want to see ([\d,]+) film/i) || html.match(/([\d,]+) film/i);
  const total = totalMatch ? parseInt(totalMatch[1].replace(/,/g, "")) : null;

  // Extract films from the poster list
  // Letterboxd renders each film as <li data-film-slug="slug" ...><div ...><img ... alt="Title" ...>
  const films = [];
  const slugMatches = [...html.matchAll(/data-film-slug="([^"]+)"/g)];
  const altMatches = [...html.matchAll(/class="image"[^>]*alt="([^"]+)"/g)];

  // Also try: <img alt="Film Title" ... inside a watchlist item
  const imgMatches = [...html.matchAll(/data-film-slug="([^"]+)"[\s\S]{0,300}?<img[^>]+alt="([^"]+)"/g)];

  for (const m of imgMatches) {
    const slug = m[1];
    const title = m[2].replace(/&amp;/g, "&").replace(/&#039;/g, "'").replace(/&quot;/g, '"').trim();
    if (slug && title && !films.find(f => f.slug === slug)) {
      films.push({ slug, title, guid: `watchlist-${username}-${slug}` });
    }
  }

  console.log(`    Watchlist: found ${films.length} films, total=${total}`);
  return { films, total };
}

// ─── Embed builders ──────────────────────────────────────────────────────────
function buildDiaryPayload(username, item) {
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

function buildWatchlistPayload(username, newFilms, total) {
  const names = newFilms.map(f => `**${f.title}**`);
  let filmList;
  if (names.length === 1) filmList = names[0];
  else if (names.length === 2) filmList = `${names[0]} and ${names[1]}`;
  else filmList = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  return {
    embeds: [{
      color: 0xF5A623,
      author: {
        name: `${username} added to their watchlist`,
        url: `https://letterboxd.com/${username}/watchlist/`,
      },
      description: `Added ${filmList} to their watchlist.${total ? ` They now have **${total}** films to watch!` : ""}`,
    }]
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  let seen = new Set();
  try {
    seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")));
  } catch {
    console.log("No seen.json yet — first run, seeding without posting.");
  }
  const isFirstRun = seen.size === 0;
  console.log(`isFirstRun: ${isFirstRun}, seen size: ${seen.size}`);

  let changed = false;

  for (const username of LETTERBOXD_USERS) {
    console.log(`Checking ${username}...`);

    // ── Diary feed ────────────────────────────────────────────────────────
    try {
      const xml = await httpsGet(`https://letterboxd.com/${username}/rss/`);
      const items = parseRSS(xml);
      const newItems = items.filter((i) => i.guid && !seen.has(i.guid)).reverse();
      console.log(`  Diary: ${items.length} items, ${newItems.length} new`);

      for (const item of newItems) {
        const isFilm = item.filmTitle || (item.link && item.link.includes("/film/"));
        if (!isFilm) { seen.add(item.guid); changed = true; continue; }

        if (!isFirstRun) {
          const payload = buildDiaryPayload(username, item);
          const res = await httpsPost(WEBHOOK_URL, payload);
          if (res.status === 204 || res.status === 200) {
            console.log(`  ✓ Diary: ${item.filmTitle || item.title}`);
          } else {
            console.error(`  ✗ Webhook error ${res.status}:`, res.body);
          }
          await sleep(1000);
        } else {
          console.log(`  Seeding diary: ${item.filmTitle || item.title}`);
        }

        seen.add(item.guid);
        changed = true;
      }
    } catch (err) {
      console.error(`  Failed diary feed for ${username}:`, err.message);
    }

    await sleep(500);

    // ── Watchlist (HTML scrape) ───────────────────────────────────────────
    try {
      const { films, total } = await fetchWatchlist(username);
      const newFilms = films.filter(f => !seen.has(f.guid));
      console.log(`  Watchlist: ${films.length} total, ${newFilms.length} new`);

      if (newFilms.length > 0) {
        if (!isFirstRun) {
          const payload = buildWatchlistPayload(username, newFilms, total);
          const res = await httpsPost(WEBHOOK_URL, payload);
          if (res.status === 204 || res.status === 200) {
            console.log(`  ✓ Watchlist: ${newFilms.map(f => f.title).join(", ")}`);
          } else {
            console.error(`  ✗ Watchlist webhook error ${res.status}:`, res.body);
          }
          await sleep(1000);
        } else {
          console.log(`  Seeding watchlist: ${newFilms.length} films`);
        }
        newFilms.forEach(f => { seen.add(f.guid); changed = true; });
      }
    } catch (err) {
      console.error(`  Failed watchlist for ${username}:`, err.message);
    }

    await sleep(500);
  }

  if (changed || isFirstRun) {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]), "utf8");
    console.log("Saved seen.json");
    fs.writeFileSync("changed.txt", "1");
  } else {
    console.log("Nothing new.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
