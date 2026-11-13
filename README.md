# Room Change Evidence

Upload up to 3 BEFORE and 3 AFTER photos of one desk or small room. The app reports
which objects were moved, added or removed, with paired image crops as evidence. It
never reports lighting, shadow or colour differences as changes, marks hidden objects
as not verifiable instead of removed, lists low-confidence matches separately with a
request for one more camera angle, and declines when the photos show different scenes
or are too dark or blurred.

## Setup

Requirements: Node.js 24 (or 22), npm, a Gemini API key.

```bash
cp .env.example .env        # then set GEMINI_API_KEY, GEMINI_MODEL_ID and the two prices
npm ci
npm run dev                 # http://localhost:3000
```

Other commands:

```bash
npm run test                # unit tests (Vitest), no network
npm run build && npm start  # production build and server
npm run debug:overlay -- testset/dev/A1 testset/dev/A2   # draw the model's boxes on the photos
```

### Docker

```bash
cp .env.example .env        # fill in as above
docker compose up --build   # http://localhost:3000
```

The image builds with `npm ci`, runs `next build` (needs network access for the
Google fonts) and ships only production dependencies. `runs/` is mounted as a volume,
so `runs/log.jsonl` survives restarts. The key is passed at runtime through `env_file`
and never copied into the image (`.dockerignore` excludes `.env*`).

## Evaluation

`testset/changelog.json` holds the ground truth for each pair (BEFORE state → AFTER
state). `npm run eval` runs every pair through the real pipeline, scores the verdicts
and prints one markdown table per model.

```bash
npm run eval                                    # dev pairs, model from .env, 3 runs each
npm run eval -- --model gemini-3.5-flash-lite --model gemini-3.8-flash
npm run eval -- --pairs P02,P08 --runs 1 --concurrency 2
npm run eval -- --holdout                       # include holdout pairs: only at the very end
```

- Columns: true positives, false positives, misses (and how many of them were hedged
  as uncertain / not verifiable), verdicts the ground truth forbids, decline
  correctness, median and max time, mean cost.
- Model labels are matched to ground-truth objects with a small per-scene synonym map
  (`lib/eval/score.ts`). Labels that match nothing are listed under the table for review.
- Results go to `runs/eval-<date-time>.md`, raw verdicts to the matching `.json`.
  Every run is also a line in `runs/log.jsonl` tagged `source: eval`.
- Holdout pairs are skipped by default. Prompts are never tuned on them.
- Cost uses prices from env only: `PRICE_*_PER_MTOK_USD` for `GEMINI_MODEL_ID`,
  `PRICE_*_PER_MTOK_USD__<MODEL>` for other models. Missing prices show as n/a.

## Architecture

1. `POST /api/compare` validates the upload, then streams NDJSON progress events and the result.
2. Preprocess (`lib/preprocess.ts`): HEIC decode, EXIF rotation, a full-size copy for crops and a 1536 px copy for the model.
3. Quality gate (`lib/quality.ts`): brightness and sharpness per photo; unusable photos decline the report in code, before any model call.
4. Observe (`lib/vision/`): one model call with all photos returns an Observation (scene check, anchors, up to 5 objects, a sighting per object per photo), validated with Zod, one retry on schema failure.
5. The provider sits behind `VisionProvider`; the Gemini adapter converts its native boxes to `{x, y, w, h}` in 0..1.
6. Verdict (`lib/verdict.ts`): pure TypeScript, no AI, unit-tested. It applies the rules from the brief and picks the evidence pair for each object.
7. Evidence (`lib/evidence.ts`): crops from the full-size photos with 15% padding; added / removed claims whose empty-place box does not match the object are not confirmed.
8. Verify: one more model call checks the crop pairs of every moved / added / removed claim; anything not confirmed becomes uncertain.
9. Report (`app/`, `components/`): changes with side-by-side crops, uncertain and not-verifiable items with the requested angle, conditions shown as "not a change".
10. Measurement (`lib/runlog.ts`): each run appends one line to `runs/log.jsonl` with tokens, retries, stage times and cost from env prices.

## Reused libraries vs own code

Reused (not written here):

| Library | Used for |
|---|---|
| Next.js, React | App Router app, API route, production server |
| `@google/genai` | Gemini API client (`generateContent`, structured output, retries) |
| sharp | Image decoding, EXIF rotation, resizing, crops, overlays |
| heic-convert | HEIC / HEIF decoding |
| Zod | Schemas for every model response, JSON Schema for structured output |
| Tailwind CSS, `next/font` (Archivo, IBM Plex Mono) | Styling with the design tokens, fonts |
| Vitest, tsx, TypeScript | Tests, running scripts, types |

Own code in this repository (line counts include comments):

| Area | Files | Lines |
|---|---|---|
| Upload, preprocessing, quality gate | `lib/upload.ts`, `lib/preprocess.ts`, `lib/quality.ts` | ~220 |
| Vision provider, Gemini adapter, schemas, prompts | `lib/vision/` | ~540 |
| Verdict rules | `lib/verdict.ts` | ~290 |
| Evidence crops and region check | `lib/evidence.ts` | ~100 |
| Pipeline, run log, stream events | `lib/pipeline.ts`, `lib/runlog.ts`, `lib/compare-events.ts` | ~460 |
| UI: upload, progress, report | `app/`, `components/`, `lib/report-view.ts` | ~880 |
| Eval scoring and scripts | `lib/eval/`, `scripts/` | ~550 |
| Unit tests | `tests/` | ~1600 |

The design (layout, tokens, copy) comes from the handoff in `design/export/`, which is
not part of the repository.

## Project rules

See `CLAUDE.md`: the model only observes, verdicts are computed in code, every model
response is validated, prices and model ids come from env, and every run is measured.
