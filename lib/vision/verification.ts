import { z } from "zod";

/** One verdict per claim, as returned by the verify call. */
export const ClaimCheckSchema = z.object({
  id: z.string(),
  confirmed: z.boolean(),
  reason: z.string(),
});
export type ClaimCheck = z.infer<typeof ClaimCheckSchema>;

/** The response root is an object because a bare array is less reliable in structured output. */
export const VerificationSchema = z.object({ results: z.array(ClaimCheckSchema) });
export type Verification = z.infer<typeof VerificationSchema>;

export type ClaimKind = "moved" | "added" | "removed";

export interface Claim {
  /** Object id from the observation. */
  id: string;
  kind: ClaimKind;
  label: string;
  description: string;
  /** Crop around the object (moved, removed) or the empty place (added) in a BEFORE photo. */
  before: Buffer;
  /** Crop around the object (moved, added) or the empty place (removed) in an AFTER photo. */
  after: Buffer;
}

/** Every claim must be answered exactly once, and nothing else. */
export function checkVerification(v: Verification, claimIds: string[]): string[] {
  const problems: string[] = [];
  const expected = new Set(claimIds);
  const seen = new Set<string>();
  for (const r of v.results) {
    if (!expected.has(r.id)) problems.push(`unknown claim id "${r.id}"`);
    else if (seen.has(r.id)) problems.push(`claim "${r.id}" answered more than once`);
    seen.add(r.id);
  }
  for (const id of claimIds) if (!seen.has(id)) problems.push(`no answer for claim "${id}"`);
  return problems;
}

const WHAT_CROPS_SHOW: Record<ClaimKind, string> = {
  moved:
    "The move itself was already established from the full photos. BEFORE crop is cut at the old place and AFTER crop at the new place, so the crops cannot show the movement; only check that they show the same object.",
  removed: "BEFORE crop shows the object; AFTER crop shows the same place, which should now be empty.",
  added: "BEFORE crop shows a place that should be empty; AFTER crop shows the object there.",
};

export function claimHeader(c: Claim): string {
  return `Claim ${c.id}: "${c.label}" (${c.description}) was ${c.kind.toUpperCase()}. ${WHAT_CROPS_SHOW[c.kind]}`;
}

export function buildVerifyPrompt(count: number): string {
  return `You check claims about changes between BEFORE and AFTER photos of one small scene. You get ${count} claim(s). Each claim has a text header, then a BEFORE crop, then an AFTER crop. The crops are cut from the full photos with a margin around the region.

For each claim decide whether the two crops really support it:
- MOVED: the change of position was already established from the full photos, and each crop is cut around the object at one of its two places. The crops therefore cannot show the movement, and the object may look unmoved inside its own crop. Never reject a MOVED claim for "not showing movement" or because the object looks the same. Confirm if both crops show the same physical object (same shape, colour, markings). Do not confirm if they show different objects that only look alike, or if one crop does not show the object at all.
- REMOVED: confirm only if the BEFORE crop shows the object and the AFTER crop shows its place clearly empty. The empty crop must cover the whole spot where the object stood: if it shows only a sliver of that spot, a different spot, or the object itself or part of it, do not confirm. If the place is hidden, cut off, too dark or blurred to tell, do not confirm.
- ADDED: confirm only if the BEFORE crop shows the place clearly empty and the AFTER crop shows the object there. Same caveats as REMOVED.
- If the only difference between the crops is lighting, shadow, reflection, colour cast or exposure, do not confirm. A shadow or a reflection is not an object.
- Do not guess about anything outside the crops.

Return one result per claim with its id, confirmed (true or false) and a short reason in plain English (one sentence) that says what you saw.

Answer only with JSON that follows the given schema.`;
}
