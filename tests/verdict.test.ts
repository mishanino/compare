import { describe, expect, it } from "vitest";
import { applyVerification, computeReport, type ObjectVerdict, type Report } from "@/lib/verdict";
import { ObservationSchema, type Observation, type ObservedObject, type Sighting } from "@/lib/vision/observation";

// Hand-made fixtures: 2 BEFORE and 2 AFTER photos of a desk.

const box = (x: number, y: number, w = 0.1, h = 0.1) => ({ x, y, w, h });
const BIG = box(0.1, 0.1, 0.3, 0.3);
const SMALL = box(0.5, 0.5, 0.05, 0.05);

function sighting(set: Sighting["set"], photo: number, status: Sighting["status"], extra: Partial<Sighting> = {}): Sighting {
  const needsBox = status === "visible" || status === "location_empty";
  return { set, photo, status, ...(needsBox ? { box: box(0.2, 0.2) } : {}), ...extra };
}

function object(id: string, label: string, sightings: Sighting[], extra: Partial<ObservedObject> = {}): ObservedObject {
  return {
    id,
    label,
    description: `${label} on the desk`,
    match_confidence: 0.9,
    position_before: "left of the monitor, near the front desk edge",
    position_after: "left of the monitor, near the front desk edge",
    position_changed: "no",
    sightings,
    ...extra,
  };
}

function observation(objects: ObservedObject[], scene: Partial<Observation["scene"]> = {}): Observation {
  // Parse so every fixture is guaranteed to match the data contract.
  return ObservationSchema.parse({
    scene: {
      same_scene: true,
      usable: true,
      issues: [],
      lighting_note: "Similar lighting.",
      viewpoint_note: "Similar viewpoints.",
      ...scene,
    },
    anchors: [
      { id: "a1", label: "monitor" },
      { id: "a2", label: "front desk edge" },
      { id: "a3", label: "lamp" },
    ],
    objects,
  });
}

const visibleEverywhere = [
  sighting("before", 1, "visible"),
  sighting("before", 2, "visible"),
  sighting("after", 1, "visible"),
  sighting("after", 2, "visible"),
];

function ok(report: Report) {
  if (report.status !== "ok") throw new Error(`expected ok report, got ${report.status}`);
  return report;
}

function only(report: Report): ObjectVerdict {
  const r = ok(report);
  const all = [...r.changes, ...r.uncertain, ...r.not_verifiable, ...r.unchanged];
  expect(all).toHaveLength(1);
  return all[0];
}

describe("computeReport", () => {
  it("moved: visible in both sets, confident, position changed", () => {
    const obs = observation([
      object(
        "o1",
        "blue mug",
        [
          sighting("before", 1, "visible", { box: SMALL }),
          sighting("before", 2, "visible", { box: BIG }),
          sighting("after", 1, "visible", { box: BIG }),
          sighting("after", 2, "visible", { box: SMALL }),
        ],
        { position_after: "right of the monitor, near the lamp", position_changed: "yes" },
      ),
    ]);
    const r = ok(computeReport(obs));
    expect(r.changes).toHaveLength(1);
    const v = r.changes[0];
    expect(v.verdict).toBe("moved");
    expect(v.requested_angle).toBeNull();
    // Evidence uses the largest box from each set.
    expect(v.evidence).toEqual({ before: { photo: 2, box: BIG }, after: { photo: 1, box: BIG } });
    expect(v.reason).toContain("right of the monitor");
  });

  it("added: visible only in AFTER and its location is empty in a BEFORE photo", () => {
    const obs = observation([
      object(
        "o1",
        "stapler",
        [
          sighting("before", 1, "location_empty", { box: BIG }),
          sighting("before", 2, "location_occluded", { occluder: "laptop" }),
          sighting("after", 1, "visible", { box: SMALL }),
          sighting("after", 2, "visible", { box: BIG }),
        ],
        { position_before: "not visible", position_changed: "unclear" },
      ),
    ]);
    const r = ok(computeReport(obs));
    expect(r.changes.map((v) => v.verdict)).toEqual(["added"]);
    expect(r.changes[0].evidence).toEqual({ before: { photo: 1, box: BIG }, after: { photo: 2, box: BIG } });
    expect(r.changes[0].requested_angle).toBeNull();
  });

  it("removed: visible only in BEFORE and its location is empty in an AFTER photo", () => {
    const obs = observation([
      object(
        "o1",
        "phone",
        [
          sighting("before", 1, "visible", { box: BIG }),
          sighting("before", 2, "visible", { box: SMALL }),
          sighting("after", 1, "location_occluded", { occluder: "chair" }),
          sighting("after", 2, "location_empty", { box: SMALL }),
        ],
        { position_after: "not visible", position_changed: "unclear" },
      ),
    ]);
    const r = ok(computeReport(obs));
    expect(r.changes.map((v) => v.verdict)).toEqual(["removed"]);
    expect(r.changes[0].evidence).toEqual({ before: { photo: 1, box: BIG }, after: { photo: 2, box: SMALL } });
    expect(r.changes[0].reason).toContain("AFTER photo 2");
  });

  it("unchanged: visible in both sets, confident, same position", () => {
    const v = only(computeReport(observation([object("o1", "notebook", visibleEverywhere)])));
    expect(v.verdict).toBe("unchanged");
    expect(v.evidence).not.toBeNull();
    expect(v.requested_angle).toBeNull();
  });

  it("occluded in every AFTER photo -> not_verifiable, never removed", () => {
    const obs = observation([
      object(
        "o1",
        "keys",
        [
          sighting("before", 1, "visible"),
          sighting("before", 2, "visible"),
          sighting("after", 1, "location_occluded", { occluder: "backpack" }),
          sighting("after", 2, "location_occluded", { occluder: "backpack" }),
        ],
        { position_after: "not visible", position_changed: "unclear" },
      ),
    ]);
    const r = ok(computeReport(obs));
    expect(r.changes).toHaveLength(0);
    const v = r.not_verifiable[0];
    expect(v.verdict).toBe("not_verifiable");
    expect(v.evidence).toBeNull();
    expect(v.reason).toContain("hidden by the backpack");
    expect(v.requested_angle).toMatch(/^Take an AFTER photo of the spot of the keys in the BEFORE photos/);
    expect(v.requested_angle).toContain("sees past the backpack");
    expect(v.requested_angle).toContain("monitor");
    expect(v.requested_angle).toContain("front desk edge");
  });

  it("out of frame in every AFTER photo -> not_verifiable, never removed", () => {
    const obs = observation([
      object(
        "o1",
        "glasses",
        [
          sighting("before", 1, "visible"),
          sighting("before", 2, "visible"),
          sighting("after", 1, "location_out_of_frame"),
          sighting("after", 2, "location_out_of_frame"),
        ],
        { position_after: "not visible", position_changed: "unclear" },
      ),
    ]);
    const v = only(computeReport(obs));
    expect(v.verdict).toBe("not_verifiable");
    expect(v.reason).toContain("outside the frame");
    expect(v.requested_angle).toContain("fully inside the frame");
  });

  it("visible only in AFTER with BEFORE location hidden -> not_verifiable, never added", () => {
    const obs = observation([
      object(
        "o1",
        "plant",
        [
          sighting("before", 1, "location_out_of_frame"),
          sighting("before", 2, "location_occluded", { occluder: "monitor" }),
          sighting("after", 1, "visible"),
          sighting("after", 2, "visible"),
        ],
        { position_before: "not visible", position_changed: "unclear" },
      ),
    ]);
    const v = only(computeReport(obs));
    expect(v.verdict).toBe("not_verifiable");
    expect(v.requested_angle).toMatch(/BEFORE photo/);
  });

  it("low match confidence -> uncertain, even if position changed", () => {
    const obs = observation([
      object("o1", "black pen", visibleEverywhere, { match_confidence: 0.45, position_changed: "yes" }),
    ]);
    const r = ok(computeReport(obs));
    expect(r.changes).toHaveLength(0);
    const v = r.uncertain[0];
    expect(v.verdict).toBe("uncertain");
    expect(v.reason).toContain("0.45");
    expect(v.evidence).not.toBeNull();
    expect(v.requested_angle).toContain("close-up AFTER photo of the black pen");
  });

  it("confidence exactly at the threshold is not uncertain", () => {
    const v = only(computeReport(observation([object("o1", "pen", visibleEverywhere, { match_confidence: 0.6 })])));
    expect(v.verdict).toBe("unchanged");
  });

  it("position unclear -> uncertain with a requested angle naming the anchors", () => {
    const obs = observation([object("o1", "cup", visibleEverywhere, { position_changed: "unclear" })]);
    const v = only(computeReport(obs));
    expect(v.verdict).toBe("uncertain");
    expect(v.requested_angle).toContain("same angle as BEFORE photo");
    expect(v.requested_angle).toContain("monitor");
    expect(v.requested_angle).toContain("front desk edge");
  });

  it("different scene -> declines the whole report", () => {
    const obs = observation(
      [object("o1", "mug", visibleEverywhere, { position_changed: "yes" })],
      { same_scene: false, issues: ["AFTER photos show a kitchen, BEFORE photos a desk"] },
    );
    const r = computeReport(obs);
    expect(r.status).toBe("declined");
    if (r.status !== "declined") return;
    expect(r.reasons[0]).toContain("different scenes");
    expect(r.reasons).toContain("AFTER photos show a kitchen, BEFORE photos a desk");
    expect(r).not.toHaveProperty("changes");
  });

  it("unusable photos -> declines the whole report", () => {
    const obs = observation([object("o1", "mug", visibleEverywhere)], {
      usable: false,
      issues: ["AFTER photo 1 is too dark"],
    });
    const r = computeReport(obs);
    expect(r.status).toBe("declined");
    if (r.status !== "declined") return;
    expect(r.reasons.join(" ")).toContain("not usable");
    expect(r.reasons).toContain("AFTER photo 1 is too dark");
  });

  it("lighting-only difference -> zero changes", () => {
    const obs = observation(
      [
        object("o1", "mug", visibleEverywhere),
        object("o2", "lamp shade", visibleEverywhere, { description: "looks yellow in AFTER because of warm light" }),
        object("o3", "book", visibleEverywhere),
      ],
      { lighting_note: "AFTER photos are much darker and warmer, with long shadows from the window." },
    );
    const r = ok(computeReport(obs));
    expect(r.changes).toHaveLength(0);
    expect(r.uncertain).toHaveLength(0);
    expect(r.not_verifiable).toHaveLength(0);
    expect(r.unchanged.map((v) => v.verdict)).toEqual(["unchanged", "unchanged", "unchanged"]);
    // The note is passed through as context only.
    expect(r.notes.lighting_note).toContain("darker");
  });

  it("an object never seen in any photo is not_verifiable, not a change", () => {
    const obs = observation([
      object("o1", "remote", [
        sighting("before", 1, "location_occluded", { occluder: "cushion" }),
        sighting("before", 2, "location_out_of_frame"),
        sighting("after", 1, "location_empty"),
        sighting("after", 2, "location_out_of_frame"),
      ]),
    ]);
    expect(only(computeReport(obs)).verdict).toBe("not_verifiable");
  });

  it("sorts a mixed scene into the right lists", () => {
    const obs = observation([
      object("o1", "mug", visibleEverywhere, { position_changed: "yes" }),
      object("o2", "pen", visibleEverywhere, { match_confidence: 0.3 }),
      object("o3", "book", visibleEverywhere),
      object("o4", "keys", [
        sighting("before", 1, "visible"),
        sighting("before", 2, "visible"),
        sighting("after", 1, "location_occluded", { occluder: "bag" }),
        sighting("after", 2, "location_out_of_frame"),
      ]),
    ]);
    const r = ok(computeReport(obs));
    expect(r.changes.map((v) => v.object_id)).toEqual(["o1"]);
    expect(r.uncertain.map((v) => v.object_id)).toEqual(["o2"]);
    expect(r.unchanged.map((v) => v.object_id)).toEqual(["o3"]);
    expect(r.not_verifiable.map((v) => v.object_id)).toEqual(["o4"]);
    for (const v of [...r.uncertain, ...r.not_verifiable]) expect(v.requested_angle).toBeTruthy();
    for (const v of [...r.changes, ...r.unchanged]) expect(v.requested_angle).toBeNull();
  });

  it("only uses the six verdict kinds", () => {
    const obs = observation([object("o1", "mug", visibleEverywhere, { position_changed: "yes" })]);
    const r = ok(computeReport(obs));
    const kinds = new Set(["moved", "added", "removed", "unchanged", "not_verifiable", "uncertain"]);
    for (const v of [...r.changes, ...r.uncertain, ...r.not_verifiable, ...r.unchanged]) expect(kinds.has(v.verdict)).toBe(true);
  });
});

describe("applyVerification", () => {
  const obs = observation([
    object("o1", "mug", visibleEverywhere, { position_changed: "yes" }),
    object("o2", "book", visibleEverywhere, { position_changed: "yes" }),
    object("o3", "pen", visibleEverywhere),
  ]);

  it("downgrades a change the verify step did not confirm to uncertain", () => {
    const r = ok(
      applyVerification(computeReport(obs), [
        { object_id: "o1", confirmed: false, note: "the mug in AFTER is a different mug" },
        { object_id: "o2", confirmed: true },
      ]),
    );
    expect(r.changes.map((v) => v.object_id)).toEqual(["o2"]);
    expect(r.uncertain.map((v) => v.object_id)).toEqual(["o1"]);
    expect(r.uncertain[0].reason).toContain("different mug");
    expect(r.uncertain[0].requested_angle).toBeTruthy();
    expect(r.uncertain[0].evidence).not.toBeNull();
  });

  it("never touches non-change verdicts or declined reports", () => {
    const r = ok(applyVerification(computeReport(obs), [{ object_id: "o3", confirmed: false }]));
    expect(r.unchanged.map((v) => v.object_id)).toEqual(["o3"]);
    const declined = computeReport(observation([], { same_scene: false }));
    expect(applyVerification(declined, [{ object_id: "o1", confirmed: false }])).toBe(declined);
  });
});
