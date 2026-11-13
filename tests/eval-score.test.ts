import { describe, expect, it } from "vitest";
import { matchLabel, median, scoreRun, type PairSpec } from "@/lib/eval/score";
import type { ObjectVerdict, Report } from "@/lib/verdict";

// Synthetic ground truth and reports only; tests never read testset/.

const v = (label: string, verdict: ObjectVerdict["verdict"]): ObjectVerdict => ({
  object_id: label,
  label,
  verdict,
  reason: "",
  evidence: null,
  requested_angle: null,
  requested_set: null,
  last_seen: null,
});

function report(...vs: ObjectVerdict[]): Report {
  const of = (...k: ObjectVerdict["verdict"][]) => vs.filter((x) => k.includes(x.verdict));
  return {
    status: "ok",
    changes: of("moved", "added", "removed"),
    uncertain: of("uncertain"),
    not_verifiable: of("not_verifiable"),
    unchanged: of("unchanged"),
    notes: { lighting_note: "", viewpoint_note: "" },
  };
}

const declined: Report = { status: "declined", reasons: ["different scenes"], notes: { lighting_note: "", viewpoint_note: "" } };

describe("matchLabel", () => {
  it("maps model labels to ground-truth names", () => {
    expect(matchLabel("white ceramic mug")).toBe("cup");
    expect(matchLabel("Pink number 14")).toBe("14");
    expect(matchLabel("roll of masking tape")).toBe("tape");
    expect(matchLabel("black headphones")).toBe("headphones");
    expect(matchLabel("Children's book")).toBe("book");
    expect(matchLabel("lime green cube")).toBe("lime cube");
    expect(matchLabel("grey-green cube")).toBe("gray-green cube");
  });

  it("uses whole words and leaves unknown labels unmatched", () => {
    expect(matchLabel("number 140")).toBeNull();
    expect(matchLabel("green cube")).toBeNull();
    expect(matchLabel("stapler")).toBeNull();
  });
});

describe("scoreRun", () => {
  const pair: PairSpec = {
    id: "X",
    expected: [
      { object: "cup", verdict: "moved" },
      { object: "tape", verdict: "removed" },
      { object: "14", allowed: ["uncertain", "moved"], forbidden: ["removed", "unchanged"] },
      { object: "scissors", verdict: "unchanged" },
    ],
  };

  it("counts true positives, allowed claims and misses", () => {
    const s = scoreRun(pair, report(v("mug", "moved"), v("tape roll", "uncertain"), v("pink 14", "moved"), v("scissors", "unchanged")));
    expect(s).toMatchObject({ tp: 2, fp: 0, miss: 1, hedged: 1, forbidden: 0, declineCorrect: true });
  });

  it("counts wrong-kind, unknown and duplicate claims as false positives", () => {
    const s = scoreRun(pair, report(v("mug", "removed"), v("stapler", "added"), v("scissors", "moved"), v("green scissors", "moved")));
    expect(s.fp).toBe(4);
    expect(s.miss).toBe(2);
    expect(s.unmatched).toEqual(["stapler", "green scissors (second match for scissors)"]);
  });

  it("flags forbidden verdicts even when they are not change claims", () => {
    const s = scoreRun(pair, report(v("number 14", "unchanged")));
    expect(s.forbidden).toBe(1);
    expect(s.fp).toBe(0);
  });

  it("any change on a no-change pair is a false positive", () => {
    const quiet: PairSpec = { id: "Q", expected: [] };
    expect(scoreRun(quiet, report(v("mug", "moved"), v("tape", "unchanged")))).toMatchObject({ fp: 1, tp: 0, miss: 0 });
  });

  it("scores decline correctness both ways", () => {
    const mustDecline: PairSpec = { id: "D", expected: [], decline: true };
    expect(scoreRun(mustDecline, declined)).toMatchObject({ declined: true, declineCorrect: true });
    expect(scoreRun(mustDecline, report(v("mug", "moved")))).toMatchObject({ declineCorrect: false, fp: 1 });
    expect(scoreRun(pair, declined)).toMatchObject({ declineCorrect: false, miss: 2 });
  });
});

describe("median", () => {
  it("handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});
