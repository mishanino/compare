/**
 * Verdict: turns an Observation into a Report. Pure code, no AI calls.
 * The rules follow "Verdict rules" in CLAUDE.md exactly; the model only observes.
 *
 * There is deliberately no "appearance changed" verdict: lighting, shadow,
 * colour and exposure never produce a change.
 */
import type { Box, Observation, ObservedObject, Sighting } from "./vision/observation";

/** Below this match_confidence an object seen in both sets is "uncertain". */
export const MIN_MATCH_CONFIDENCE = 0.6;

/** The verdicts that are reported as a change. */
export const CHANGE_KINDS = ["moved", "added", "removed"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export type VerdictKind = ChangeKind | "unchanged" | "not_verifiable" | "uncertain";

export const isChangeKind = (v: VerdictKind): v is ChangeKind => (CHANGE_KINDS as readonly VerdictKind[]).includes(v);

export interface EvidenceCrop {
  /** 1-based photo index within its set. */
  photo: number;
  box: Box;
}

export interface Evidence {
  before: EvidenceCrop;
  after: EvidenceCrop;
}

export interface ObjectVerdict {
  object_id: string;
  label: string;
  verdict: VerdictKind;
  reason: string;
  evidence: Evidence | null;
  /** Set for not_verifiable and uncertain, null otherwise. */
  requested_angle: string | null;
  /** Which set the requested photo belongs to; null when no photo is requested. */
  requested_set: "before" | "after" | null;
  /** For not_verifiable: where the object was last seen, as a single crop. */
  last_seen: (EvidenceCrop & { set: "before" | "after" }) | null;
}

type CoreVerdict = Omit<ObjectVerdict, "requested_set" | "last_seen">;

export interface SceneNotes {
  lighting_note: string;
  viewpoint_note: string;
}

export type Report =
  | { status: "declined"; reasons: string[]; notes: SceneNotes }
  | {
      status: "ok";
      /** Supported changes: moved, added, removed. */
      changes: ObjectVerdict[];
      uncertain: ObjectVerdict[];
      not_verifiable: ObjectVerdict[];
      unchanged: ObjectVerdict[];
      notes: SceneNotes;
    };

/** Every verdict of a report in display order; empty for a declined report. */
export function allVerdicts(report: Report): ObjectVerdict[] {
  return report.status === "ok" ? [...report.changes, ...report.uncertain, ...report.not_verifiable, ...report.unchanged] : [];
}

type WithBox = Sighting & { box: Box };
type SetName = Sighting["set"];

const hasBox = (s: Sighting): s is WithBox => s.box !== undefined;
const area = (b: Box) => b.w * b.h;
const has = (o: ObservedObject, set: SetName, status: Sighting["status"]) =>
  o.sightings.some((s) => s.set === set && s.status === status);

/** Largest box wins (more pixels for the crop); ties go to the lower photo number. */
function bestSighting(sightings: Sighting[], set: Sighting["set"], status: Sighting["status"]): WithBox | undefined {
  return sightings
    .filter((s): s is WithBox => s.set === set && s.status === status && hasBox(s))
    .sort((a, b) => area(b.box) - area(a.box) || a.photo - b.photo)[0];
}

function pair(before: WithBox | undefined, after: WithBox | undefined): Evidence | null {
  if (!before || !after) return null;
  return { before: { photo: before.photo, box: before.box }, after: { photo: after.photo, box: after.box } };
}

/** Anchor labels mentioned in a position text, falling back to the first two anchors. */
function anchorsFor(obs: Observation, position: string): string[] {
  const text = position.toLowerCase();
  const named = obs.anchors.map((a) => a.label).filter((l) => l && text.includes(l.toLowerCase()));
  const labels = named.length >= 2 ? named : obs.anchors.map((a) => a.label);
  return labels.slice(0, 2);
}

function withAnchors(anchors: string[]): string {
  if (anchors.length === 0) return "";
  return ` with the ${anchors.join(" and the ")} in view`;
}

/** Explains why a one-sided object cannot be checked in the other set, and which photo would settle it. */
function missingSideAngle(obs: Observation, o: ObservedObject, missingSet: Sighting["set"]): string {
  const blocked = o.sightings.filter((s) => s.set === missingSet);
  const occluders = [...new Set(blocked.filter((s) => s.status === "location_occluded" && s.occluder).map((s) => s.occluder!))];
  const where = missingSet === "after" ? o.position_before : o.position_after;
  const spot = `the spot of the ${o.label} in the ${missingSet === "after" ? "BEFORE" : "AFTER"} photos (${where})`;
  const anchors = withAnchors(anchorsFor(obs, where));
  const view = occluders.length
    ? `from an angle that sees past the ${occluders.join(" and the ")}`
    : "with that spot fully inside the frame";
  if (missingSet === "after") return `Take an AFTER photo of ${spot} ${view}${anchors}.`;
  return `If you have one, add a BEFORE photo that shows ${spot} ${view}${anchors}.`;
}

function blockedReason(o: ObservedObject, missingSet: Sighting["set"]): string {
  const blocked = o.sightings.filter((s) => s.set === missingSet);
  const parts = blocked.map((s) => {
    const name = `${missingSet.toUpperCase()} photo ${s.photo}`;
    if (s.status === "location_occluded") return `${name}: hidden${s.occluder ? ` by the ${s.occluder}` : ""}`;
    if (s.status === "location_out_of_frame") return `${name}: outside the frame`;
    return `${name}: ${s.status}`;
  });
  const seenIn = missingSet === "after" ? "BEFORE" : "AFTER";
  return `Seen in ${seenIn} photos, but its location is not visible in any ${missingSet.toUpperCase()} photo (${parts.join("; ")}).`;
}

/** Adds the photo request target and, for not_verifiable, the last-seen crop. */
export function judgeObject(obs: Observation, o: ObservedObject): ObjectVerdict {
  const core = judgeCore(obs, o);
  const visibleBefore = has(o, "before", "visible");
  const visibleAfter = has(o, "after", "visible");
  if (core.verdict === "uncertain") return { ...core, requested_set: "after", last_seen: null };
  if (core.verdict !== "not_verifiable") return { ...core, requested_set: null, last_seen: null };
  const seenSet = visibleBefore && !visibleAfter ? "before" : visibleAfter && !visibleBefore ? "after" : null;
  const seen = seenSet ? bestSighting(o.sightings, seenSet, "visible") : undefined;
  return {
    ...core,
    requested_set: seenSet === "after" ? "before" : "after",
    last_seen: seen && seenSet ? { set: seenSet, photo: seen.photo, box: seen.box } : null,
  };
}

/**
 * Seen in one set only. A change needs the place to be visible and empty in the
 * other set: seen BEFORE -> removed, seen AFTER -> added. Otherwise not_verifiable.
 */
function judgeOneSided(obs: Observation, o: ObservedObject, seenSet: SetName): CoreVerdict {
  const base = { object_id: o.id, label: o.label };
  const missingSet: SetName = seenSet === "before" ? "after" : "before";
  if (!has(o, missingSet, "location_empty")) {
    return {
      ...base,
      verdict: "not_verifiable",
      reason: blockedReason(o, missingSet),
      evidence: null,
      requested_angle: missingSideAngle(obs, o, missingSet),
    };
  }
  const seen = bestSighting(o.sightings, seenSet, "visible");
  const empty = bestSighting(o.sightings, missingSet, "location_empty");
  const emptyPhoto = `${missingSet.toUpperCase()} photo ${empty?.photo ?? "?"}`;
  if (seenSet === "before") {
    return {
      ...base,
      verdict: "removed",
      reason: `Before: ${o.position_before}. In ${emptyPhoto} that place is visible and empty.`,
      evidence: pair(seen, empty),
      requested_angle: null,
    };
  }
  return {
    ...base,
    verdict: "added",
    reason: `After: ${o.position_after}. In ${emptyPhoto} that place is visible and empty.`,
    evidence: pair(empty, seen),
    requested_angle: null,
  };
}

function judgeCore(obs: Observation, o: ObservedObject): CoreVerdict {
  const base = { object_id: o.id, label: o.label };
  const visibleBefore = has(o, "before", "visible");
  const visibleAfter = has(o, "after", "visible");
  const vb = bestSighting(o.sightings, "before", "visible");
  const va = bestSighting(o.sightings, "after", "visible");

  if (visibleBefore && visibleAfter) {
    const evidence = pair(vb, va);
    const sameAngle = vb ? `from the same angle as BEFORE photo ${vb.photo}` : "from the same angle as a BEFORE photo";
    if (o.match_confidence < MIN_MATCH_CONFIDENCE) {
      return {
        ...base,
        verdict: "uncertain",
        reason: `Seen in both sets, but it is not clear that it is the same object (match confidence ${o.match_confidence.toFixed(2)}).`,
        evidence,
        requested_angle: `Take a close-up AFTER photo of the ${o.label} (${o.position_after}) ${sameAngle}, so it can be told apart from similar objects.`,
      };
    }
    if (o.position_changed === "yes") {
      return {
        ...base,
        verdict: "moved",
        reason: `Before: ${o.position_before}. After: ${o.position_after}.`,
        evidence,
        requested_angle: null,
      };
    }
    if (o.position_changed === "no") {
      return { ...base, verdict: "unchanged", reason: `Same place in both sets: ${o.position_after}.`, evidence, requested_angle: null };
    }
    const anchors = withAnchors(anchorsFor(obs, `${o.position_before} ${o.position_after}`));
    return {
      ...base,
      verdict: "uncertain",
      reason: "Seen in both sets, but the photos do not show clearly whether its position changed.",
      evidence,
      requested_angle: `Take an AFTER photo ${sameAngle} that shows the ${o.label}${anchors}.`,
    };
  }

  if (visibleBefore) return judgeOneSided(obs, o, "before");
  if (visibleAfter) return judgeOneSided(obs, o, "after");

  // Not covered by the rules: listed but never seen. Never treat as a change.
  return {
    ...base,
    verdict: "not_verifiable",
    reason: "The object is not clearly visible in any photo.",
    evidence: null,
    requested_angle: `Take an AFTER photo that clearly shows the ${o.label}${withAnchors(anchorsFor(obs, o.position_after))}.`,
  };
}

function declineReasons(scene: Observation["scene"]): string[] {
  const reasons: string[] = [];
  if (!scene.same_scene) reasons.push("The BEFORE and AFTER photos appear to show different scenes.");
  if (!scene.usable) reasons.push("Some photos are not usable (for example too dark, blurred or badly cropped).");
  return [...reasons, ...scene.issues];
}

function group(verdicts: ObjectVerdict[], notes: SceneNotes): Report {
  const of = (...kinds: VerdictKind[]) => verdicts.filter((v) => kinds.includes(v.verdict));
  return {
    status: "ok",
    changes: of(...CHANGE_KINDS),
    uncertain: of("uncertain"),
    not_verifiable: of("not_verifiable"),
    unchanged: of("unchanged"),
    notes,
  };
}

/** Declines the whole report because of photo problems found in code, before any model call. */
export function declineForPhotos(problems: string[]): Report {
  return {
    status: "declined",
    reasons: ["Some photos are not usable.", ...problems],
    notes: { lighting_note: "", viewpoint_note: "" },
  };
}

export function computeReport(obs: Observation): Report {
  const notes: SceneNotes = { lighting_note: obs.scene.lighting_note, viewpoint_note: obs.scene.viewpoint_note };
  if (!obs.scene.same_scene || !obs.scene.usable) {
    return { status: "declined", reasons: declineReasons(obs.scene), notes };
  }
  return group(
    obs.objects.map((o) => judgeObject(obs, o)),
    notes,
  );
}

export interface VerificationResult {
  object_id: string;
  confirmed: boolean;
  /** Why the verify step did not confirm the change. */
  note?: string;
  /** False when the check could not run at all (no crops, failed call). Defaults to true. */
  checked?: boolean;
}

/** Verify step said "not confirmed" -> downgrade that change to uncertain. */
export function applyVerification(report: Report, results: VerificationResult[]): Report {
  if (report.status !== "ok") return report;
  const rejected = new Map(results.filter((r) => !r.confirmed).map((r) => [r.object_id, r]));
  const updated = allVerdicts(report).map((v): ObjectVerdict => {
    const r = rejected.get(v.object_id);
    if (!r || !isChangeKind(v.verdict)) return v;
    const ref = v.evidence ? ` from the same angle as BEFORE photo ${v.evidence.before.photo}` : "";
    return {
      ...v,
      verdict: "uncertain",
      reason:
        r.checked === false
          ? `Looked ${v.verdict}, but this could not be double-checked${r.note ? ` (${r.note})` : ""}, so it is not reported as a change.`
          : `Looked ${v.verdict}, but a closer check of the crops did not confirm it${r.note ? `: ${r.note}` : "."}`,
      requested_angle: `Take a closer AFTER photo of the ${v.label}${ref}.`,
      requested_set: "after",
      last_seen: null,
    };
  });
  return group(updated, report.notes);
}
