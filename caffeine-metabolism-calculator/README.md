# Caffeine Metabolism Calculator

A single-page React app that estimates how much caffeine is in your body over the
course of a day and what it means for a workout or for sleep. It uses a
one-compartment pharmacokinetic model (first-order absorption + elimination —
the Bateman function). All output is a rough estimate, not medical advice.

Built with Vite + React + Recharts.

## Run locally

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # production build -> dist/
npm run preview  # serve the production build locally
```

## Deploy to Vercel

**Option A — Git (recommended)**

1. Push this folder to a new GitHub/GitLab/Bitbucket repo.
2. In Vercel: **Add New… → Project**, import the repo.
3. Vercel auto-detects Vite. Defaults are correct, so just deploy:
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Output directory: `dist`

**Option B — Vercel CLI**

```bash
npm i -g vercel
vercel        # preview deployment
vercel --prod # production deployment
```

No `vercel.json` is needed — it's a static single-page app, so the default Vite
settings work. If you later add client-side routing, add a rewrite so deep links
resolve to `index.html`.

### Embedding in Wix (same as the Workout Wheel)

Deploy here first, then drop the Vercel URL into a Wix **Embed → Embed a site
(iframe)** element. Give the iframe enough height (~1000px+) so the results and
chart aren't clipped on mobile.

## Tuning the model

Every scientific assumption lives in the `CONFIG` object at the top of
`src/CaffeineCalculator.jsx`:

- `halfLifeByUse` — elimination half-life (hours) per habitual-use bracket.
  Baseline ~5 h; the gradient by habitual use is low-confidence (see notes below).
- `smokingMultiplier` — `0.6`, i.e. combustible-tobacco smoke induces CYP1A2 and
  speeds clearance ~40%. (Nicotine itself does not — smoke does.)
- `absorptionHalfLifeMin` — `8.5`, which yields a ~45 min time-to-peak at a 5 h
  half-life. Lower it to peak sooner, raise it to peak later.
- `negligibleMg` — `10`, the "fully metabolized" threshold in mg remaining.
- `safeDailyLimitMg` — `400`, the over-limit warning threshold.

The workout and sleep impact text lives in `workoutImpact()` and `sleepImpact()`.

### Modeling caveats (already noted in-app under "Model & sources")

- The Y-axis is caffeine **remaining in the body (mg)**, not blood concentration
  (mg/L) — the latter would need a volume-of-distribution assumption.
- Body weight, when entered, is used only to express the workout effect in mg/kg.
- Individual variability is large (CYP1A2 genotype dwarfs the habitual-use effect).
- The timeline assumes a single forward ~24 h window anchored at your first dose.
