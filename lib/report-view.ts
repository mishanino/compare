/** Pure text helpers for the report screen. No React, so they are unit-tested. */
import type { CompareResult } from "./pipeline";
import type { ObjectVerdict, Report } from "./verdict";

type OkReport = Extract<Report, { status: "ok" }>;

export function headline(r: OkReport): string {
  const n = r.changes.length;
  if (n === 1) return "1 change found";
  if (n > 1) return `${n} changes found`;
  return r.uncertain.length + r.not_verifiable.length > 0 ? "No supported changes found" : "No physical changes found";
}

export function tally(r: OkReport): string {
  const parts = [`${r.changes.length} changed`, `${r.not_verifiable.length} not verifiable`];
  if (r.uncertain.length > 0) parts.push(`${r.uncertain.length} uncertain`);
  parts.push(`${r.unchanged.length} unchanged`);
  return parts.join(" · ");
}

export function runMeta(result: CompareResult): string {
  const id = result.run.id.replace(/-/g, "").slice(0, 6);
  return `REPORT · run_${id} · ${result.photos.before.length} before / ${result.photos.after.length} after`;
}

/** Lighting and viewpoint notes, shown as conditions, never as changes. */
export function conditionsText(r: Report): string {
  return [r.notes.lighting_note, r.notes.viewpoint_note]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

export function pairCaptions(v: ObjectVerdict): { before: string; after: string } | null {
  if (!v.evidence) return null;
  const before = `Before, photo ${v.evidence.before.photo}${v.verdict === "added" ? " · empty" : ""}`;
  const after = `After, photo ${v.evidence.after.photo}${v.verdict === "removed" ? " · empty location" : ""}`;
  return { before, after };
}

export function lastSeenCaption(v: ObjectVerdict): string | null {
  if (!v.last_seen) return null;
  return `${v.last_seen.set === "before" ? "Before" : "After"}, photo ${v.last_seen.photo} · last seen`;
}

export function formatCost(usd: number | null): string {
  if (usd === null) return "cost not configured";
  if (usd > 0 && usd < 0.001) return "estimated cost <$0.001";
  return `estimated cost $${usd.toFixed(3)}`;
}

export function footerParts(result: CompareResult): string[] {
  return [
    `Processed in ${(result.run.wall_ms / 1000).toFixed(1)} s`,
    formatCost(result.run.cost_usd),
    result.run.model_id ?? "no model call",
  ];
}

export function errorTag(code: string, status: number): string {
  return status > 0 ? `${code}_${status}` : code;
}
