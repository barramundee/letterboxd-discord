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

function decodeHtml(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#034;/g, '"')
    .trim();
}

// ─── RSS parser ──────────────────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const match of itemMatches) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`));
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

function getFilmPagePoster(html) {
  if (!html) return null;
  const og = html.match(/property="og:image"\s+content="([^"]+)"/i);
  if (og && og[1]) return og[1];
  const twitter = html.match(/name="twitter:image"\s+content="([^"]+)"/i);
  if (twitter && twitter[1]) return twitter[1];
  const img = html.match(/<img[^>]+src="([^"]+)"[^>]*class="[^"]*image[^"]*"/i);
  return img ? img[1] : null;
}

// ─── Poster resolver ─────────────────────────────────────────────────────────
// Tries the canonical film page first (/film/slug/), which reliably has og:image.
// Falls back to the user's diary film page (/username/film/slug/) if needed.
async function resolvePosterFromFilmPage(username, slug) {
  // 1. Canonical film page — most reliable source of poster art
  try {
    const html = await httpsGet(`https://letterboxd.com/film/${slug}/`);
    const poster = getFilmPagePoster(html);
    if (poster && poster.startsWith("http")) return poster;
  } catch {}

  // 2. User's film page as fallback
  try {
    const html = await httpsGet(`https://letterboxd.com/${username}/film/${slug}/`);
    const poster = getFilmPagePoster(html);
    if (poster && poster.startsWith("http")) return poster;
  } catch {}

  return null;
}

// ─── Watchlist scraper ──────────────────────────────────────────────────────
async function fetchWatchlist(username) {
  const html = await httpsGet(`https://letterboxd.com/${username}/watchlist/`);
  if (!html || typeof html !== "string") return { films: [], total: null };

  const totalMatch =
    html.match(/data-num-entries="?(\d+)"?/) ||
    html.match(/js-watchlist-count(?:[^0-9]|>)*?(\d+)/) ||
    html.match(/js-watchlist-main-content[\s\S]*?section[^>]*>.*?([\d,]+) films?/i);
  const total = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ""), 10) : null;

  const films = [];
  const posterTags = [...html.matchAll(/<div[^>]*class="react-component[^"]*"[^>]*data-component-class="LazyPoster"[^>]*>/g)];

  for (const match of posterTags) {
    const tag = match[0];
    const slug = (tag.match(/data-item-slug="([^"]+)"/) || [])[1];
    const title = (tag.match(/data-item-name="([^"]+)"/) || [])[1];

    const innerImg = (tag.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    const poster = innerImg && innerImg.startsWith("http") && !innerImg.includes("empty-poster")
      ? innerImg
      : null;

    if (slug && title && !films.find(f => f.slug === slug)) {
      films.push({
        slug,
        title: decodeHtml(title),
        poster: poster || null,
        guid: `watchlist-${username}-${slug}`,
      });
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

  const embed = {
    color: 0xF5A623,
    author: {
      name: `${username} added to their watchlist`,
      url: `https://letterboxd.com/${username}/watchlist/`,
    },
    description: `Added ${filmList} to their watchlist.${total ? ` They now have **${total}** films to watch!` : ""}`,
  };

  const firstWithPoster = newFilms.find(f => f.poster);
  if (firstWithPoster && firstWithPoster.poster) {
    embed.thumbnail = { url: firstWithPoster.poster };
  }

  return { embeds: [embed] };
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

    try {
      const { films, total } = await fetchWatchlist(username);
      const newFilms = films.filter(f => !seen.has(f.guid));
      console.log(`  Watchlist: ${films.length} total, ${newFilms.length} new`);

      if (newFilms.length > 0) {
        if (!isFirstRun) {
          const toSend = [];
          for (const film of newFilms) {
            // Always resolve from the canonical film page — the watchlist HTML
            // rarely includes a usable poster src (lazy-loaded by JS), so we
            // fetch /film/slug/ which reliably exposes og:image.
            const resolved = await resolvePosterFromFilmPage(username, film.slug);
            if (resolved) film.poster = resolved;
            toSend.push(film);
          }

          const payload = buildWatchlistPayload(username, toSend, total);
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
