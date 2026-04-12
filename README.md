# EVS Reports

Internal reporting site for Electric Vehicle Services. Two reports — Weekly WIP and Daily Activity — with per-branch detail pages, week-over-week and day-over-day comparisons, targets, and alerts. Built with Next.js, deployed on Vercel.

## What it does

- **Weekly Report** — cumulative WIP snapshots, ranked branch list, sales trends, alerts when metrics worsen
- **Daily Report** — yesterday's activity, ranked branch list, day-over-day deltas
- **Per-branch detail pages** — every branch has its own page accessible from the overview
- **Admin form** — paste numbers into a simple form to update the live site
- **Password-protected** — single shared password gates the entire site

## Local development

```bash
npm install
cp .env.example .env.local   # then edit .env.local to set your password
npm run dev
```

Open http://localhost:3000. Default password is `evs2026` (change this before deploying).

## Deploying to Vercel — first time setup

This is the one-time setup. After this, updating the site is just `git push` or using the admin form.

### 1. Create a GitHub repository

1. Go to [github.com/new](https://github.com/new)
2. Create a new **private** repository (e.g. `evs-reports`)
3. Don't initialize with README, .gitignore, or license — we already have those

### 2. Push the code

From the project folder on your computer:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/evs-reports.git
git push -u origin main
```

### 3. Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) and sign in with your GitHub account (free)
2. Click **Add New… → Project**
3. Select your `evs-reports` repository and click **Import**
4. Under **Environment Variables**, add:
   - Name: `SITE_PASSWORD`
   - Value: choose a strong password for your team
5. Click **Deploy**

After ~60 seconds your site will be live at `https://evs-reports-xxxx.vercel.app`. Vercel will give you the exact URL.

### 4. (Optional) Custom domain

In your Vercel project settings → Domains, add a custom domain like `reports.evs.ae`. Vercel will give you DNS records to add at your domain registrar. Free on Vercel; you only pay your domain registrar (~$10/year).

## Updating data — two ways

### Option A: Admin form (recommended for routine updates)

1. Visit `/admin` on your live site
2. Sign in with the password
3. Choose Weekly or Daily, enter the new date, type the values
4. Click **Save changes**
5. The site updates immediately for everyone

The admin form auto-archives the previous snapshot, so your week-over-week and day-over-day comparisons keep working without manual maintenance.

> **Important note about Vercel + JSON storage:** Vercel deployments are read-only at runtime, which means data saved through the admin form persists only for the lifetime of that serverless instance and may reset on redeploy. For long-term storage of changes made through the admin form, you have three options:
>
> 1. **Easiest:** After saving, also commit the updated `data/data.json` to git. The site will rebuild and the data persists permanently. (You can do this from GitHub's web UI.)
> 2. **Better:** Switch to Vercel KV (a free Redis store, takes ~10 minutes to wire up). Tell me if you want this and I'll add it.
> 3. **Best long-term:** Connect to your Odoo API directly so nothing needs to be typed.

### Option B: Edit `data/data.json` directly and push

1. Open `data/data.json` in any text editor (or GitHub's web UI)
2. Update the numbers
3. Commit and push — Vercel auto-deploys within 30 seconds

This option is more permanent on the free Vercel plan and avoids the read-only issue above.

## File structure

```
app/
  page.tsx              # Home / landing
  weekly/
    page.tsx            # Weekly overview (all branches)
    [branch]/page.tsx   # Per-branch weekly detail
  daily/
    page.tsx            # Daily overview (all branches)
    [branch]/page.tsx   # Per-branch daily detail
  admin/page.tsx        # Data entry form
  login/page.tsx        # Password gate
  api/
    auth/route.ts       # Login/logout
    data/route.ts       # GET/POST data
components/             # Reusable UI pieces
lib/
  types.ts              # Data schema
  data-store.ts         # File read/write
  format.ts             # Number/currency/date formatters
  auth.ts               # Cookie helpers
data/
  data.json             # The actual data
middleware.ts           # Auth gate for all routes
```

## Updating targets

Targets aren't editable through the admin form yet (kept it simple). To change targets, edit `data/data.json` directly under `weekly.targets` or `daily.targets`, then commit and push.

## Customizing

- **Password:** change `SITE_PASSWORD` in Vercel environment variables
- **Branches:** edit `BRANCHES` in `lib/types.ts`
- **Metrics:** edit `WEEKLY_METRICS` or `DAILY_METRICS` in `lib/types.ts` (you'll also need to update the seed data)
- **Colors / fonts:** edit `tailwind.config.js` and `app/globals.css`

## Cost

- **Vercel:** free for this scale (Hobby plan)
- **GitHub:** free (private repo)
- **Domain (optional):** ~$10/year at Namecheap/Cloudflare

Total: $0/year, or $10/year with a custom domain.
