 # SickleScan

Browser-based blood smear analyzer for sickle cell disease. It counts red blood cells in a stained smear photo, classifies each cell's shape as **normal**, **borderline** or **sickled**, and reports the percentage of sickled cells.

- Images are processed **in the browser** (Web Worker) and never uploaded.
- Hosted on **Cloudflare Workers** with static assets; no build step.
- Optional **Cloudflare D1** database for shared history. Without it, history is kept on each device.

> Research and education use only. Not a diagnostic device. Confirm with HPLC or haemoglobin electrophoresis and clinical review.

## Deploy to Cloudflare (about 3 minutes)

1. Create a new GitHub repository and push this folder to it:
   ```bash
   git init && git add . && git commit -m "SickleScan v1"
   git branch -M main
   git remote add origin https://github.com/<you>/sicklescan.git
   git push -u origin main
   ```
2. In the Cloudflare dashboard: **Workers & Pages → Create → Import a repository** and pick the repo.
3. Use these settings (they are usually filled in automatically):
   - **Build command:** leave empty
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** `/`
4. Click **Deploy**. Your app goes live at `https://sicklescan.<your-subdomain>.workers.dev`.

Every push to `main` redeploys automatically.

### Using a Cloudflare Pages project instead (`*.pages.dev`)

This also works. In the Pages project go to **Settings → Build** and set:

- **Framework preset:** None
- **Build command:** leave empty
- **Build output directory:** `public`  ← required; without it the site is blank

Then go to **Deployments → Retry deployment** (or push a commit). The `/api` routes run from the `functions/` folder automatically. For cloud history on Pages, add the D1 binding under **Settings → Bindings → D1 database**, with variable name `DB`.

### Optional: turn on cloud history (D1)

```bash
npm install
npx wrangler login
npx wrangler d1 create sicklescan-db
```

Copy the `database_id` it prints into `wrangler.toml`, uncomment the `[[d1_databases]]` block, then commit and push. The table is created automatically on first use (or run `npm run db:migrate`). The History panel badge changes from **This device** to **Cloud**.

## Run locally

```bash
npm install
npm run dev      # http://localhost:8787
npm test         # analysis engine unit tests
```

## How it works

| Step | What happens |
| --- | --- |
| 1 | Image resized to at most 1400 px on the longest side |
| 2 | Green channel extracted (haemoglobin absorbs green, so cells read dark) |
| 3 | 3×3 blur, then Otsu automatic threshold |
| 4 | Morphological opening removes specks; hole filling fills each cell's pale centre |
| 5 | Connected regions labelled; each traced for outline and perimeter |
| 6 | Shape measures: area, circularity 4πA/P², elongation √(λ1/λ2), solidity A/A_hull |
| 7 | Rules classify each region; thresholds adjustable live in the UI |

Default rules: **sickled** if elongation ≥ 2.0, or elongation ≥ 1.6 with circularity < 0.55. **Borderline** if elongation ≥ 1.5. **Clump** if area > 2.2× median cell, or solidity < 0.80 with area > 1.5× median. **Debris** if area < 0.25× median. Cells touching the image edge are excluded. % sickled = sickled ÷ (normal + borderline + sickled).

## Best results

- Use the thin monolayer area of the smear, where cells do not overlap.
- 40× to 100× magnification, in focus, evenly lit.
- Analyse several fields per slide and look at the trend, not one number.
- If your stain makes cells lighter than the background, tick **Cells lighter than background**.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, db, version }` |
| GET | `/api/analyses?limit=50` | Newest first, max 100 |
| POST | `/api/analyses` | JSON summary (no image). 201 `{ id, created_at }` |
| GET | `/api/analyses/:id` | One result |
| DELETE | `/api/analyses/:id` | 204 |

Without a D1 binding, data endpoints return `503 database_not_configured` and the app falls back to on-device history.

## Project layout

```
public/            static site (served by Cloudflare assets)
  index.html
  css/styles.css
  js/app.js        UI, drawing, export, save
  js/analysis.js   image analysis engine (pure functions)
  js/analysis-worker.js
  js/history.js    D1 / on-device history
  sample-smear.jpg synthetic demo image (generated, not patient data)
  _headers         security headers (CSP)
src/worker.js      /api routes + D1
schema.sql         D1 schema (auto-applied)
test/              Node unit tests
wrangler.toml      Cloudflare config
```

## Roadmap

- **v1.1** Watershed splitting of touching cells; batch analysis of several fields.
- **v2** Trained detector (YOLO or MobileNet) exported to ONNX and run in the browser with ONNX Runtime Web; the rule-based engine stays as a fallback. Only `classifyCells` / `segmentAndMeasure` in `analysis.js` change.
