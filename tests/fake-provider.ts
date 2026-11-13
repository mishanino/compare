import type { Observation, ObservedObject, Sighting } from "@/lib/vision/observation";
import type { CallOptions, CallUsage, ObserveInput, ObserveResult, VisionProvider } from "@/lib/vision/provider";
import type { Claim, ClaimCheck } from "@/lib/vision/verification";

export const usage = (inputTokens: number, outputTokens: number): CallUsage => ({
  modelId: "fake-model",
  inputTokens,
  outputTokens,
  retries: 0,
  wallMs: 1,
});

const box = { x: 0.2, y: 0.2, w: 0.2, h: 0.2 };
const s = (set: Sighting["set"], status: Sighting["status"], extra: Partial<Sighting> = {}): Sighting => ({
  set,
  photo: 1,
  status,
  ...(status === "visible" || status === "location_empty" ? { box } : {}),
  ...extra,
});

function obj(id: string, label: string, sightings: Sighting[], extra: Partial<ObservedObject> = {}): ObservedObject {
  return {
    id,
    label,
    description: `${label} desc`,
    match_confidence: 0.9,
    position_before: "left of the monitor",
    position_after: "left of the monitor",
    position_changed: "no",
    sightings,
    ...extra,
  };
}

/** 1 BEFORE + 1 AFTER photo: o1 moved, o2 removed, o3 unchanged, o4 occluded. */
export function sceneObservation(scene: Partial<Observation["scene"]> = {}): Observation {
  return {
    scene: { same_scene: true, usable: true, issues: [], lighting_note: "", viewpoint_note: "", ...scene },
    anchors: [
      { id: "a1", label: "monitor" },
      { id: "a2", label: "desk edge" },
    ],
    objects: [
      obj("o1", "mug", [s("before", "visible"), s("after", "visible")], { position_changed: "yes" }),
      obj("o2", "phone", [s("before", "visible"), s("after", "location_empty")]),
      obj("o3", "book", [s("before", "visible"), s("after", "visible")]),
      obj("o4", "keys", [s("before", "visible"), s("after", "location_occluded", { occluder: "bag" })]),
    ],
  };
}

export class FakeProvider implements VisionProvider {
  readonly name = "fake";
  readonly modelId = "fake-model";
  observeCalls = 0;
  verifyCalls: Claim[][] = [];

  constructor(
    private readonly observation: Observation,
    private readonly answer: (claims: Claim[]) => ClaimCheck[] | Promise<ClaimCheck[]> = (claims) =>
      claims.map((c) => ({ id: c.id, confirmed: true, reason: "looks right" })),
  ) {}

  async observe(_input?: ObserveInput, _options?: CallOptions): Promise<ObserveResult> {
    this.observeCalls++;
    return { observation: this.observation, usage: usage(10_000, 2_000) };
  }

  async verify(claims: Claim[], _options?: CallOptions) {
    this.verifyCalls.push(claims);
    return { results: await this.answer(claims), usage: usage(1_000, 500) };
  }
}
