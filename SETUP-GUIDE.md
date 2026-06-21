# Meridian — Setup Guide (start to finish)

This turns the files into a live website you can open from your iPhone or any device, anywhere. Do the setup on a **computer** (much easier). It takes about 15–20 minutes. You only do this once.

There are 3 parts: **(1) get a free data key, (2) put the code on GitHub, (3) deploy on Vercel.**

---

## PART 1 — Get your free Finnhub data key (3 min)

This key is what lets your app pull live stock data.

1. Go to **https://finnhub.io/register**
2. Sign up with your email (free plan is fine — do NOT pay for anything).
3. After signing in, you land on the **Dashboard**. You'll see a box labeled **API Key** with a string of letters and numbers.
4. Click to copy it. Paste it somewhere safe for a minute (a note). You'll need it in Part 3.

That's it for Finnhub. Keep this key private — treat it like a password.

---

## PART 2 — Put the code on GitHub (6 min)

GitHub stores your code so Vercel can read it. Free.

1. Go to **https://github.com** and make a free account (or sign in).
2. Click the **+** in the top-right corner → **New repository**.
3. Name it `meridian` (anything is fine). Leave it **Public**. Click **Create repository**.
4. On the next page, find the link that says **"uploading an existing file"** (it's in the line: *"…or upload an existing file"*). Click it.
5. Now drag in the project files. **Important: keep the folder structure.** The easiest way:
   - On your computer, open the `meridian` folder I gave you.
   - Select everything inside it (the `api` folder, `index.html`, `package.json`, this guide) and drag them all into the GitHub upload box at once.
6. Scroll down, click **Commit changes**.

You should now see your files listed on GitHub: the `api` folder, `index.html`, and `package.json`.

---

## PART 3 — Deploy on Vercel (5 min)

This is what makes it a real website.

1. Go to **https://vercel.com/signup**
2. Click **Continue with GitHub** — this links the two so Vercel can see your code. Approve the access it asks for.
3. On your Vercel dashboard, click **Add New… → Project**.
4. You'll see your `meridian` repository in the list. Click **Import** next to it.
5. **Before clicking Deploy**, find the section called **Environment Variables**. This is where your secret key goes (so it's never exposed in the code):
   - In the **Key** (or **Name**) box, type exactly: `FINNHUB_KEY`
   - In the **Value** box, paste the Finnhub key you copied in Part 1.
   - Click **Add**.
6. Now click **Deploy**. Wait ~1 minute while it builds.
7. When it's done you'll see a celebration screen and a link like **`meridian-xxxx.vercel.app`**. Click **Visit** (or **Continue to Dashboard** then **Visit**).

**That's your live app.** 🎉

---

## Using it on your iPhone

1. Open the `vercel.app` link in Safari on your phone.
2. Tap the **Share** button (square with the up-arrow).
3. Tap **Add to Home Screen**.
4. It now sits on your home screen like a normal app and opens straight to Meridian — accessible from anywhere.

---

## If something doesn't work

- **You see "404: NOT_FOUND"** → The files were uploaded with the wrong structure. Make sure `index.html` sits at the **top level** of your repository (not inside any folder), with the `api` folder right next to it. If `index.html` is inside a folder, move it to the root and redeploy.
- **Dropdown shows "Server is missing FINNHUB_KEY"** → The environment variable wasn't saved. In Vercel: your project → **Settings → Environment Variables** → add `FINNHUB_KEY` with your key → then go to **Deployments**, click the latest one's "…" menu → **Redeploy**.
- **Dropdown says "Finnhub 401" or "403"** → The key is wrong or has a typo. Recopy it from Finnhub and update the variable, then redeploy.
- **Dropdown says "Finnhub 429"** → You hit the free-tier rate limit (60 calls/minute). Wait a minute and try again.
- **Some fields show "—"** → That specific data point isn't included on Finnhub's free plan. The app fills what it can and dashes the rest on purpose, rather than breaking.
- **A stock shows no Technical/Analyst data** → Free tier covers US stocks best; some symbols (especially non-US) have limited data.

---

## What's live vs. limited (so you're not surprised)

**Live on the free plan:** current price, daily change, market cap, 52-week range, P/E and other ratios, beta, dividend yield, earnings beats/misses, analyst buy/hold/sell counts, price targets, and technical signals (RSI, moving averages, support/resistance) computed from real price history.

**Not on the free plan:** some deeper valuation breakdowns. If you ever want those, Finnhub and similar providers have paid tiers — but you don't need them to use everything in this app.

You're done. Open the link anywhere, anytime.
