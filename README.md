# Room Change Evidence

A browser prototype that compares BEFORE and AFTER photos of one desk or small room
and reports which objects were **moved**, **added** or **removed**, with paired image
crops as evidence. The user only uploads photos; nothing has to be typed.

- Up to 3 BEFORE and 3 AFTER photos (JPEG, PNG, WebP, HEIC; up to 30 MB each)
- Up to 5 salient objects per scene
- One vision-model call observes, plain TypeScript decides, a second call verifies

## What it will and will not say

| Situation | Result |
|---|---|
| Lighting, shadow, colour cast or exposure differs | Never a change (shown as a condition, not a finding) |
| Object hidden behind something or outside the frame | `not_verifiable`, with a request for a specific camera angle |
| Object gone and its original place is visible and empty in an AFTER photo | `removed` |
| New object and its place is visible and empty in a BEFORE photo | `added` |
| Object visible in both sets, position changed | `moved` |
| Match confidence below 0.6, or position unclear | `uncertain`, with a request for a specific camera angle |
| Verify step does not confirm a claimed change | downgraded to `uncertain` |
| Photos show different scenes, or are too dark / blurred | The report is declined, with the reason |

No damage valuation and no general building inspection.

## Quick start

Requirements: Node.js 24 (or 22), npm, a Gemini API key.

```bash
cp .env.example .env        # set GEMINI_API_KEY, GEMINI_MODEL_ID and the two prices
npm ci
npm run dev                 # http://localhost:3000
```

### Docker

```bash
cp .env.example .env        # fill in as above
docker compose up --build   # http://localhost:3000
```

The image runs `next build` (needs network access for Google Fonts) and ships only
production dependencies. `runs/` is mounted as a volume, so `runs/log.jsonl` survives
restarts. The API key is passed at runtime through `env_file` and is never copied into
the image (`.dockerignore` excludes `.env*`).

### Configuration

All settings come from `.env` (see [.env.example](.env.example)):

| Variable | Meaning |
|---|---|
| `VISION_PROVIDER` | `gemini` (the only implementation so far) |
| `GEMINI_API_KEY` | API key |
| `GEMINI_MODEL_ID` | Any model id that supports `generateContent` with images |
| `PRICE_INPUT_PER_MTOK_USD`, `PRICE_OUTPUT_PER_MTOK_USD` | Prices per 1M tokens for cost logging; empty means cost is logged as `null` |
| `PRICE_*_PER_MTOK_USD__<MODEL>` | Optional per-model prices for `npm run eval -- --model <id>` |
| `RUN_LOG_PATH` | Optional, default `runs/log.jsonl` |

Model ids and prices are never hardcoded.

## Commands

```bash
npm run test                # unit tests (Vitest), no network
npm run build && npm start  # production build and server
npm run debug:overlay -- testset/dev/A1 testset/dev/A2   # draw the model's boxes on the photos
npm run eval                # score the pipeline against the ground truth
```

## How it works

```
upload -> preprocess -> quality gate -> observe (1 model call) -> verdict (code)
       -> evidence crops -> verify (1 model call) -> report
```

1. **Upload** - `POST /api/compare` validates the files, then streams NDJSON progress events and the result.
2. **Preprocess** ([lib/preprocess.ts](lib/preprocess.ts)) - HEIC decode, EXIF rotation, a full-size copy for crops and a 1536 px copy for the model.
3. **Quality gate** ([lib/quality.ts](lib/quality.ts)) - brightness and sharpness per photo; unusable photos decline the report before any model call.
4. **Observe** ([lib/vision/](lib/vision/)) - one call with all photos returns an Observation: scene check, fixed anchors, up to 5 objects and one sighting per object per photo. Validated with Zod, one retry on schema failure.
5. **Provider** - behind the `VisionProvider` interface; the Gemini adapter converts native boxes to `{x, y, w, h}` normalised 0..1.
6. **Verdict** ([lib/verdict.ts](lib/verdict.ts)) - pure TypeScript, no AI calls, unit-tested. Applies the rules in the table above and picks the evidence pair for each object.
7. **Evidence** ([lib/evidence.ts](lib/evidence.ts)) - crops from the full-size photos with 15% padding; added / removed claims whose empty-place box does not match the object are not confirmed.
8. **Verify** - one more call checks the crop pairs of every moved / added / removed claim; anything not confirmed becomes uncertain.
9. **Report** ([app/](app/), [components/](components/)) - changes with side-by-side crops, uncertain and not-verifiable items with the requested angle, conditions shown as "not a change".
10. **Measurement** ([lib/runlog.ts](lib/runlog.ts)) - each run appends one line to `runs/log.jsonl`: model id, tokens per call, retries, time per stage, cost from env prices.

The key design rule: **the model only observes, the code decides.** Verdict logic is
never moved into prompts, so it stays deterministic and testable.

## Evaluation

[testset/changelog.json](testset/changelog.json) holds the ground truth for each photo
pair. `npm run eval` runs every pair through the real pipeline, scores the verdicts and
prints one markdown table per model.

```bash
npm run eval                                    # dev pairs, model from .env, 3 runs each
npm run eval -- --model <model-a> --model <model-b>
npm run eval -- --pairs P02,P08 --runs 1 --concurrency 2
npm run eval -- --holdout                       # include holdout pairs: only at the very end
```

- Columns: true positives, false positives, misses (and how many were hedged as
  uncertain / not verifiable), verdicts the ground truth forbids, decline correctness,
  median and max time, mean cost.
- Model labels are matched to ground-truth objects with a small per-scene synonym map
  ([lib/eval/score.ts](lib/eval/score.ts)); labels that match nothing are listed for review.
- Results go to `runs/eval-<date-time>.md` and `.json`; each run is also logged to
  `runs/log.jsonl` with `source: eval`.
- Holdout pairs are skipped by default, and prompts are never tuned on them.

## Project layout

```
app/            Next.js App Router: page, layout, /api/compare route
components/     Upload drop zones, progress indicator, report
lib/            Pipeline stages, verdict rules, vision provider, eval scoring
scripts/        eval, debug overlay, test runner
tests/          Vitest unit tests (fake provider, no network)
testset/        Dev and holdout photo pairs + ground truth
```

## Built with

| Library | Used for |
|---|---|
| Next.js, React | App Router app, API route, production server |
| `@google/genai` | Gemini API client (structured output) |
| sharp | Decoding, EXIF rotation, resizing, crops, overlays |
| heic-convert | HEIC / HEIF decoding |
| Zod | Schemas for every model response |
| Tailwind CSS | Styling |
| Vitest, tsx, TypeScript | Tests, scripts, types |

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

## Limitations

- Built for one small scene with a handful of objects, not whole apartments.
- Only the Gemini provider is implemented.
- No database or accounts; each comparison is stateless.
- English UI only.

## Project rules

See [CLAUDE.md](CLAUDE.md) for the full rules this prototype follows.
