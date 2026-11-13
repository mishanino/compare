# Room Change Evidence: project rules

## What this is
A browser prototype for a take-home brief. A user uploads BEFORE and AFTER photos
(up to 3 each) of one small scene (desk or small room, up to 5 salient objects).
The app produces a concise report of supported changes (object added, removed,
moved) with paired image crops as evidence. The user never types descriptions.

## Non-negotiable behaviour (from the brief)
1. Lighting, shadow, colour-cast and exposure differences are NEVER reported as changes.
   There is no "appearance changed" verdict at all.
2. An object that is occluded or outside the frame is "not_verifiable", never "removed".
3. "removed" requires that the object's original location is visible and empty in at
   least one AFTER photo. "added" requires that its location is visible and empty in
   at least one BEFORE photo.
4. Low-confidence matches go to a separate "uncertain" list with a request for a
   specific extra camera angle.
5. If the two sets show different scenes, or photos are unusable (too dark, blurred),
   the app declines to conclude and says why.
6. No damage valuation, no general building inspection.
7. The app must process any new input. Never special-case the demo files.

## Architecture rule
The vision model only OBSERVES. The verdict is computed by pure TypeScript in
`lib/verdict.ts` with no AI calls, covered by unit tests. Do not move verdict
logic into prompts.

Pipeline: preprocess -> observe (1 model call, all photos) -> verdict (code)
-> verify (1 model call, crops of claimed changes) -> report.

## Stack
- Next.js (App Router) + TypeScript, single repo, no database
- sharp for EXIF rotation, resize and crops; heic-convert for HEIC input
- Zod for every model response; one retry on schema failure, then a clear error
- Vision provider behind `lib/vision/provider.ts` (interface), Gemini as first
  implementation. Model id, API key and prices come from env, never hardcoded.
- Vitest for unit tests
- Docker for deploy

## Data contract
Boxes are always stored as `{x, y, w, h}` normalised 0..1 relative to the
EXIF-corrected image. Convert the provider's native box format in the provider
adapter only.

Observation (model output):
- `scene`: `{ same_scene, usable, issues[], lighting_note, viewpoint_note }`
- `anchors[]`: fixed things (monitor, desk edge): `{ id, label }`
- `objects[]`: `{ id, label, description, match_confidence (0..1),
  position_before, position_after (text, relative to at least two anchors),
  position_changed: "yes" | "no" | "unclear",
  sightings[]: { set: "before" | "after", photo: number,
    status: "visible" | "location_empty" | "location_occluded" | "location_out_of_frame",
    box?, occluder? } }`

Verdict (code output), one per object:
`moved | added | removed | unchanged | not_verifiable | uncertain`
plus `reason`, `evidence: { before: {photo, box}, after: {photo, box} } | null`,
and `requested_angle` for not_verifiable and uncertain.

## Verdict rules
- scene.same_scene false or scene.usable false -> decline the whole report
- visible in both sets: confidence < 0.6 -> uncertain; position_changed
  yes -> moved, no -> unchanged, unclear -> uncertain
- visible only in BEFORE: any AFTER sighting location_empty -> removed,
  otherwise not_verifiable
- visible only in AFTER: any BEFORE sighting location_empty -> added,
  otherwise not_verifiable
- verify step says "not confirmed" -> downgrade to uncertain

## Measurement
Every run appends one JSON line to `runs/log.jsonl`: model id, per-call input and
output tokens, retries, wall time per stage, total cost computed from env prices.
Report real numbers only.

## Working style
- Small commits, one step at a time. Run `npm run test` and `npm run build` before
  saying a step is done.
- Check current provider docs before writing SDK code; do not guess API shapes.
- `testset/` holds photos and `changelog.json` (ground truth). Read them only in the
  eval script. Never tune prompts on `testset/s6_holdout`.
- Keep the UI plain: two screens, English only.
