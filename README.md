# SickleScan Lab

A browser-based lab workspace for sickle cell blood smear analysis. It analyses several microscope fields per slide, lets the technician correct any cell, pools the counts into a % sickled with a 95% interval, raises QC flags, tracks each patient over time and prints a report.

- **Local-first and private.** Patients, slides and images are stored in the browser (IndexedDB) on the lab's computer. Nothing is uploaded and there are no accounts. Patients are identified by codes only.
- **No build step.** Plain HTML, CSS and JavaScript modules, deployed on Cloudflare Pages or Workers.

> Research and education use only. Not a diagnostic device. Confirm with HPLC or haemoglobin electrophoresis and clinical review.

## Features

| Area | What it does |
| --- | --- |
| Dashboard | Patients, slides reported, cells counted, slides per week chart, items needing attention, latest result per patient |
| Patients | Coded records with sex, birth year, genotype on record, hydroxyurea status and start date; search and genotype filter |
| Patient page | % sickled timeline with 95% intervals and the hydroxyurea start marked; change since previous and since first slide |
| Slide workspace | Slide details (date, stain, magnification, technician); add many field images (drop, choose, camera, paste); per-field include/exclude; re-analyse for light cells; autosave |
| Cell review | Click a cell to see its measurements; reclassify with buttons or keys N, B, S, X, R; corrected cells are marked |
| Slide total | Pooled counts across fields, 95% Wilson interval, composition bar, descriptive band, QC flags (minimum cells, clumps, field disagreement) |
| Report | Printable A4 report (Print / Save as PDF) with patient and sample details, results, QC notes, field table, annotated thumbnails, method and sign-off lines; draft watermark |
| Exports | Per-slide cell CSV, all-slides summary CSV, full JSON backup (with or without images) and restore |
| Settings | Lab name and report footer, QC limits, lab default thresholds, storage use, erase all |

## Deploy on Cloudflare Pages

Repo layout must have `public/`, `functions/`, `src/` at the top level.

Settings → Build configuration:

- Framework preset: **None**
- Build command: **empty**
- Build output directory: **`public`**
- Root directory: **empty**

Push to `main` to deploy. (On a Workers project instead, use deploy command `npx wrangler deploy`.)

## Run locally

```bash
npm install
npx wrangler pages dev public   # http://localhost:8788
npm test                        # engine + aggregation unit tests
```

## Project layout

```
public/
  index.html            app shell + navigation
  css/styles.css        all styles, including print layout for reports
  js/main.js            hash router
  js/db.js              IndexedDB storage, backup/restore
  js/analysis.js        image analysis engine (segmentation, shape measures, rules)
  js/analysis-worker.js runs the engine off the main thread
  js/engine.js          image loading, drawing, hit-testing
  js/aggregate.js       corrections, pooling across fields, QC flags, CSV
  js/charts.js          SVG charts
  js/ui.js              DOM helpers, dialogs, toasts
  js/views/*.js         dashboard, patients, patient, slides, workspace, report, settings, guide
  sample-smear.jpg      synthetic demo image (generated, not patient data)
functions/api/          Pages Functions entry for the optional /api routes
src/worker.js           optional API (health + D1 summaries); not needed by the app
test/                   Node unit tests
```

## How the analysis works

Green channel → 3×3 blur → Otsu threshold → opening → hole filling → connected regions → contour tracing → area, circularity 4πA/P², elongation √(λ1/λ2), solidity. Default rules: **sickled** if elongation ≥ 2.0, or ≥ 1.6 with circularity < 0.55; **borderline** if elongation ≥ 1.5; **clump** if area > 2.2× median (or low solidity and > 1.5× median); **debris** if area < 0.25× median; cells touching the image edge are excluded. Technician corrections override the rules. Slide % sickled = pooled sickled ÷ (normal + borderline + sickled) across included fields.

## Roadmap

- Watershed splitting of touching cells
- Trained detector (ONNX in the browser) alongside the rule engine
- Optional multi-user cloud sync with logins (needed before any shared online storage of patient data)
