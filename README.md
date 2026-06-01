# 🎬 Letterboxd → Discord (GitHub Actions)

Posts to a Discord channel whenever a followed Letterboxd user logs or reviews a film.
Runs entirely free on GitHub Actions — no server, no credit card.

## How it works

Every 5 minutes, a GitHub Actions workflow:
1. Fetches each user's public Letterboxd RSS feed
2. Compares entries against `seen.json` (committed in this repo)
3. Posts any new films to Discord via a webhook
4. Commits the updated `seen.json` back to the repo

---

## Setup (step by step)

### Step 1 — Create a Discord webhook

1. Open Discord and go to the channel you want updates posted in
2. Click the **gear icon** next to the channel name → **Integrations** → **Webhooks**
3. Click **New Webhook**, give it a name (e.g. "Letterboxd") and optionally an avatar
4. Click **Copy Webhook URL** — save this for later

### Step 2 — Create a GitHub repository

1. Go to [github.com](https://github.com) and sign in (or create a free account)
2. Click **+** → **New repository**
3. Name it something like `letterboxd-discord` and set it to **Private**
4. Check **"Add a README file"** so the repo isn't empty, then click **Create repository**

### Step 3 — Upload the bot files

You need to add three files to the repo: `check.js`, `seen.json`, and `.github/workflows/check.yml`.

The easiest way is via GitHub's web UI:

**Add `seen.json`:**
1. In your repo, click **Add file** → **Create new file**
2. Name it `seen.json`
3. Paste in `[]` as the content
4. Click **Commit changes**

**Add `check.js`:**
1. Click **Add file** → **Upload files**
2. Upload `check.js` from this folder
3. Click **Commit changes**

**Add the workflow:**
1. Click **Add file** → **Create new file**
2. Type `.github/workflows/check.yml` as the filename (GitHub will create the folders)
3. Paste in the contents of `.github/workflows/check.yml` from this folder
4. Click **Commit changes**

### Step 4 — Add your secrets

1. In your repo, click **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** and add these two secrets:

| Name | Value |
|------|-------|
| `DISCORD_WEBHOOK_URL` | The webhook URL you copied in Step 1 |
| `LETTERBOXD_USERS` | Comma-separated Letterboxd usernames, e.g. `alice,bob,charlie` |

### Step 5 — Enable Actions and do a test run

1. Click the **Actions** tab in your repo
2. If prompted, click **"I understand my workflows, go ahead and enable them"**
3. Click **Letterboxd Checker** in the left sidebar
4. Click **Run workflow** → **Run workflow** to trigger it manually

The first run will silently seed `seen.json` with existing entries (so it won't spam old posts).
After that, any new Letterboxd activity will be posted to your Discord channel within 5 minutes.

---

## Notes

- GitHub Actions free tier includes 2,000 minutes/month. Each run takes ~10 seconds, so 5-minute polling uses ~300 runs/day × 10s ≈ ~50 minutes/day — well within the free limit.
- If the repo has no commits for **60 days**, GitHub will pause scheduled workflows. You'll get an email and can re-enable with one click.
- Letterboxd profiles must be **public** for the RSS feed to work.
- To add or remove followed users, just update the `LETTERBOXD_USERS` secret.
