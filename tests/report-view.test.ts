import { describe, expect, it } from "vitest";
import type { CompareResult } from "@/lib/pipeline";
import {
  conditionsText,
  errorTag,
  footerParts,
  formatCost,
  headline,
  lastSeenCaption,
  pairCaptions,
  runMeta,
  tally,
} from "@/lib/report-view";
import type { ObjectVerdict, Report } from "@/lib/verdict";

const box = { x: 0, y: 0, w: 0.1, h: 0.1 };
const v = (verdict: ObjectVerdict["verdict"], extra: Partial<ObjectVerdict> = {}): ObjectVerdict => ({
  object_id: "o1",
  label: "mug",
  verdict,
  reason: "",
  evidence: { before: { photo: 2, box }, after: { photo: 1, box } },
  requested_angle: null,
  requested_set: null,
  last_seen: null,
  ...extra,
});

const ok = (lists: Partial<Record<"changes" | "uncertain" | "not_verifiable" | "unchanged", ObjectVerdict[]>>) =>
  ({
    status: "ok",
    changes: [],
    uncertain: [],
    not_verifiable: [],
    unchanged: [],
    notes: { lighting_note: "", viewpoint_note: "" },
    ...lists,
  }) as Extract<Report, { status: "ok" }>;

describe("headline and tally", () => {
  it("counts changes", () => {
    expect(headline(ok({ changes: [v("moved")] }))).toBe("1 change found");
    expect(headline(ok({ changes: [v("moved"), v("added")] }))).toBe("2 changes found");
  });

  it("says no physical changes only when nothing is pending", () => {
    expect(headline(ok({ unchanged: [v("unchanged")] }))).toBe("No physical changes found");
    expect(headline(ok({ not_verifiable: [v("not_verifiable")] }))).toBe("No supported changes found");
  });

  it("lists uncertain only when there are any", () => {
    expect(tally(ok({ changes: [v("moved")], unchanged: [v("unchanged"), v("unchanged")] }))).toBe(
      "1 changed · 0 not verifiable · 2 unchanged",
    );
    expect(tally(ok({ uncertain: [v("uncertain")] }))).toBe("0 changed · 0 not verifiable · 1 uncertain · 0 unchanged");
  });
});

describe("captions", () => {
  it("marks the empty side for added and removed", () => {
    expect(pairCaptions(v("moved"))).toEqual({ before: "Before, photo 2", after: "After, photo 1" });
    expect(pairCaptions(v("added"))).toEqual({ before: "Before, photo 2 · empty", after: "After, photo 1" });
    expect(pairCaptions(v("removed"))).toEqual({ before: "Before, photo 2", after: "After, photo 1 · empty location" });
    expect(pairCaptions(v("not_verifiable", { evidence: null }))).toBeNull();
  });

  it("captions the last-seen crop", () => {
    expect(lastSeenCaption(v("not_verifiable", { evidence: null, last_seen: { set: "before", photo: 3, box } }))).toBe(
      "Before, photo 3 · last seen",
    );
    expect(lastSeenCaption(v("uncertain"))).toBeNull();
  });
});

describe("conditions, footer and meta", () => {
  it("joins lighting and viewpoint notes and skips empty ones", () => {
    const r = ok({});
    r.notes = { lighting_note: "Warmer light in AFTER.", viewpoint_note: " " };
    expect(conditionsText(r)).toBe("Warmer light in AFTER.");
  });

  it("formats cost honestly", () => {
    expect(formatCost(null)).toBe("cost not configured");
    expect(formatCost(0.0004)).toBe("estimated cost <$0.001");
    expect(formatCost(0.0364)).toBe("estimated cost $0.036");
  });

  const result = {
    report: ok({}),
    crops: {},
    photos: { before: [{}, {}, {}], after: [{}] },
    run: { id: "7f3a2c11-0000-0000-0000-000000000000", model_id: "gemini-x", wall_ms: 18_400, cost_usd: 0.03 },
  } as unknown as CompareResult;

  it("builds the meta line and footer", () => {
    expect(runMeta(result)).toBe("REPORT · run_7f3a2c · 3 before / 1 after");
    expect(footerParts(result)).toEqual(["Processed in 18.4 s", "estimated cost $0.030", "gemini-x"]);
    expect(errorTag("vision_unavailable", 502)).toBe("vision_unavailable_502");
    expect(errorTag("network", 0)).toBe("network");
  });
});
