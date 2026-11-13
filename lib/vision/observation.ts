import { z } from "zod";
import { MAX_PHOTOS_PER_SET } from "../upload";

/**
 * Observation: what the vision model saw. Mirrors the data contract in CLAUDE.md.
 * The schema is built by a factory so a provider adapter can request the same
 * structure with its own native box format, then convert boxes to `Box`.
 */

/** Box normalised 0..1 relative to the EXIF-corrected image. */
export const BoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
export type Box = z.infer<typeof BoxSchema>;

export const PHOTO_SETS = ["before", "after"] as const;
export const SIGHTING_STATUSES = [
  "visible",
  "location_empty",
  "location_occluded",
  "location_out_of_frame",
] as const;
export const POSITION_CHANGED = ["yes", "no", "unclear"] as const;
export const MAX_OBJECTS = 5;

export function makeObservationSchema<B extends z.ZodType>(box: B) {
  const scene = z.object({
    same_scene: z.boolean(),
    usable: z.boolean(),
    issues: z.array(z.string()),
    lighting_note: z.string(),
    viewpoint_note: z.string(),
  });

  const anchor = z.object({
    id: z.string(),
    label: z.string(),
  });

  const sighting = z.object({
    set: z.enum(PHOTO_SETS),
    /** 1-based photo index within its set. */
    photo: z.number().int().min(1).max(MAX_PHOTOS_PER_SET),
    status: z.enum(SIGHTING_STATUSES),
    box: box.optional(),
    occluder: z.string().optional(),
  });

  const object = z.object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    match_confidence: z.number().min(0).max(1),
    position_before: z.string(),
    position_after: z.string(),
    position_changed: z.enum(POSITION_CHANGED),
    sightings: z.array(sighting),
  });

  return z.object({
    scene,
    anchors: z.array(anchor),
    objects: z.array(object).max(MAX_OBJECTS),
  });
}

export const ObservationSchema = makeObservationSchema(BoxSchema);
export type Observation = z.infer<typeof ObservationSchema>;
export type ObservedObject = Observation["objects"][number];
export type Sighting = ObservedObject["sightings"][number];

/**
 * Checks that a schema-valid observation is also consistent with the input:
 * photo indices exist, every object has exactly one sighting per photo, ids are
 * unique, visible / location_empty sightings carry a box, and no box is empty.
 * Returns a list of problems (empty when fine).
 */
export function checkObservation(obs: Observation, counts: { before: number; after: number }): string[] {
  const problems: string[] = [];
  const anchorIds = new Set<string>();
  for (const a of obs.anchors) {
    if (anchorIds.has(a.id)) problems.push(`duplicate anchor id "${a.id}"`);
    anchorIds.add(a.id);
  }
  const objectIds = new Set<string>();
  for (const o of obs.objects) {
    if (objectIds.has(o.id)) problems.push(`duplicate object id "${o.id}"`);
    objectIds.add(o.id);
    const seen = new Set<string>();
    for (const s of o.sightings) {
      const key = `${s.set}:${s.photo}`;
      if (s.photo > counts[s.set]) {
        problems.push(`object "${o.id}": ${s.set} photo ${s.photo} does not exist (only ${counts[s.set]})`);
        continue;
      }
      if (seen.has(key)) problems.push(`object "${o.id}": more than one sighting for ${s.set} photo ${s.photo}`);
      seen.add(key);
      if ((s.status === "visible" || s.status === "location_empty") && !s.box) {
        problems.push(`object "${o.id}": ${s.set} photo ${s.photo} is "${s.status}" but has no box`);
      }
      if (s.box && (s.box.w <= 0 || s.box.h <= 0)) {
        problems.push(`object "${o.id}": ${s.set} photo ${s.photo} has a zero-area box`);
      }
    }
    for (const set of PHOTO_SETS) {
      for (let p = 1; p <= counts[set]; p++) {
        if (!seen.has(`${set}:${p}`)) problems.push(`object "${o.id}": no sighting for ${set} photo ${p}`);
      }
    }
  }
  return problems;
}
