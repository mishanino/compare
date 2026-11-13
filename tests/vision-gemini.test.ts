import { describe, expect, it, vi } from "vitest";
import {
  GeminiProvider,
  geminiBoxToBox,
  geminiResponseJsonSchema,
  parseGeminiObservation,
  type GenerateFn,
} from "@/lib/vision/gemini";
import { ObservationSchema } from "@/lib/vision/observation";
import { buildObservePrompt } from "@/lib/vision/observe-prompt";
import { VisionSchemaError, createVisionProvider, VisionConfigError } from "@/lib/vision/provider";

const counts = { before: 1, after: 2 };

/** A valid raw Gemini answer for 1 BEFORE + 2 AFTER photos. */
function rawObservation() {
  return {
    scene: { same_scene: true, usable: true, issues: [], lighting_note: "warmer in AFTER", viewpoint_note: "similar" },
    anchors: [
      { id: "a1", label: "monitor" },
      { id: "a2", label: "front desk edge" },
    ],
    objects: [
      {
        id: "o1",
        label: "blue mug",
        description: "blue ceramic mug with white handle",
        match_confidence: 0.9,
        position_before: "right of the monitor, near the front desk edge",
        position_after: "not visible",
        position_changed: "unclear",
        sightings: [
          { set: "before", photo: 1, status: "visible", box: [100, 200, 300, 500] },
          { set: "after", photo: 1, status: "location_empty", box: [110, 210, 310, 490] },
          { set: "after", photo: 2, status: "location_occluded", occluder: "laptop lid" },
        ],
      },
    ],
  };
}

const img = { jpeg: Buffer.from("x"), width: 10, height: 10 };
const input = { before: [img], after: [img, img] };

describe("geminiBoxToBox", () => {
  it("converts [ymin, xmin, ymax, xmax] 0..1000 to {x, y, w, h} 0..1", () => {
    const b = geminiBoxToBox([100, 200, 300, 500]);
    expect(b.x).toBeCloseTo(0.2);
    expect(b.y).toBeCloseTo(0.1);
    expect(b.w).toBeCloseTo(0.3);
    expect(b.h).toBeCloseTo(0.2);
  });

  it("tolerates swapped corners", () => {
    expect(geminiBoxToBox([300, 500, 100, 200])).toEqual(geminiBoxToBox([100, 200, 300, 500]));
  });

  it("covers the full image", () => {
    expect(geminiBoxToBox([0, 0, 1000, 1000])).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("parseGeminiObservation", () => {
  it("returns a contract Observation with converted boxes", () => {
    const r = parseGeminiObservation(JSON.stringify(rawObservation()), counts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ObservationSchema.parse(r.observation)).toEqual(r.observation);
    const s = r.observation.objects[0].sightings;
    expect(s[0].box?.x).toBeCloseTo(0.2);
    expect(s[2].box).toBeUndefined();
    expect(s[2].occluder).toBe("laptop lid");
  });

  it("rejects non-JSON and empty text", () => {
    expect(parseGeminiObservation("nope", counts)).toMatchObject({ ok: false });
    expect(parseGeminiObservation(undefined, counts)).toMatchObject({ ok: false });
  });

  it("rejects schema violations", () => {
    const raw = rawObservation();
    (raw.objects[0] as { match_confidence: number }).match_confidence = 1.5;
    expect(parseGeminiObservation(JSON.stringify(raw), counts)).toMatchObject({ ok: false });
  });

  it("rejects an object without a sighting for every photo", () => {
    const raw = rawObservation();
    raw.objects[0].sightings.pop();
    const r = parseGeminiObservation(JSON.stringify(raw), counts);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.problems.join()).toContain("no sighting for after photo 2");
  });

  it("rejects a visible or location_empty sighting without a box", () => {
    const raw = rawObservation();
    delete (raw.objects[0].sightings[1] as { box?: unknown }).box;
    expect(parseGeminiObservation(JSON.stringify(raw), counts)).toMatchObject({ ok: false });
  });

  it("rejects photo numbers outside the input", () => {
    const raw = rawObservation();
    raw.objects[0].sightings[0].photo = 2;
    expect(parseGeminiObservation(JSON.stringify(raw), counts)).toMatchObject({ ok: false });
  });

  it("rejects zero-area boxes", () => {
    const raw = rawObservation();
    raw.objects[0].sightings[0].box = [100, 200, 100, 500];
    expect(parseGeminiObservation(JSON.stringify(raw), counts)).toMatchObject({ ok: false });
  });
});

describe("geminiResponseJsonSchema", () => {
  it("is a plain JSON schema with the native box format and no $schema key", () => {
    const s = geminiResponseJsonSchema() as any;
    expect(s.$schema).toBeUndefined();
    expect(s.required).toEqual(["scene", "anchors", "objects"]);
    const box = s.properties.objects.items.properties.sightings.items.properties.box;
    expect(box).toMatchObject({ type: "array", minItems: 4, maxItems: 4 });
    expect(s.properties.objects.maxItems).toBe(5);
  });
});

describe("GeminiProvider.observe", () => {
  const ok = { text: JSON.stringify(rawObservation()), usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 50 } };
  const bad = { text: "{}", usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 10 } };

  it("sends labelled images, the prompt and the JSON schema", async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue(ok);
    const r = await new GeminiProvider("test-model", generate).observe(input);
    expect(r.usage).toMatchObject({ modelId: "test-model", inputTokens: 1000, outputTokens: 250, retries: 0 });
    const params = generate.mock.calls[0][0];
    expect(params.model).toBe("test-model");
    const parts = (params.contents as any)[0].parts;
    expect(parts.map((p: any) => p.text ?? p.inlineData.mimeType)).toEqual([
      "BEFORE photo 1", "image/jpeg", "AFTER photo 1", "image/jpeg", "AFTER photo 2", "image/jpeg",
    ]);
    expect(params.config?.responseMimeType).toBe("application/json");
    expect(params.config?.responseJsonSchema).toBeDefined();
  });

  it("retries once on schema failure and tells the model why", async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValueOnce(bad).mockResolvedValueOnce(ok);
    const r = await new GeminiProvider("m", generate).observe(input);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(r.usage).toMatchObject({ inputTokens: 1900, outputTokens: 260, retries: 1 });
    const retryParts = (generate.mock.calls[1][0].contents as any)[0].parts;
    expect(retryParts.at(-1).text).toContain("previous answer was rejected");
  });

  it("throws VisionSchemaError after the second failure", async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue(bad);
    const err = await new GeminiProvider("m", generate).observe(input).catch((e) => e);
    expect(err).toBeInstanceOf(VisionSchemaError);
    expect(err.usage.retries).toBe(1);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not retry API errors", async () => {
    const generate = vi.fn<GenerateFn>().mockRejectedValue(new Error("quota"));
    await expect(new GeminiProvider("m", generate).observe(input)).rejects.toThrow("quota");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe("createVisionProvider", () => {
  it("reads model id from env", async () => {
    const p = await createVisionProvider({ GEMINI_API_KEY: "k", GEMINI_MODEL_ID: "some-model" });
    expect(p).toMatchObject({ name: "gemini", modelId: "some-model" });
  });

  it("fails clearly when config is missing or unknown", async () => {
    await expect(createVisionProvider({ GEMINI_API_KEY: "k" })).rejects.toThrow(VisionConfigError);
    await expect(createVisionProvider({ VISION_PROVIDER: "x" })).rejects.toThrow(/Unknown/);
  });
});

describe("buildObservePrompt", () => {
  const p = buildObservePrompt({ beforeCount: 2, afterCount: 3, boxFormat: "BOXFMT" });
  it("contains the required rules", () => {
    for (const needle of [
      "same scene", "up to 5 salient movable objects", "anchors", "EVERY photo in BOTH sets", "2 BEFORE + 3 AFTER = 5",
      "location_empty", "at least two anchors", "Ignore differences in lighting, shadows", "look alike",
      "Never guess what is behind an occluder", "same_scene: set to false", "usable: set to false", "BOXFMT",
    ]) {
      expect(p).toContain(needle);
    }
  });
});

describe("GeminiProvider.verify", () => {
  const claim = (id: string, kind: "moved" | "added" | "removed") => ({
    id,
    kind,
    label: `thing ${id}`,
    description: "red",
    before: Buffer.from("b"),
    after: Buffer.from("a"),
  });
  const answer = (results: unknown) => ({ text: JSON.stringify({ results }), usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40 } });

  it("sends a header and both crops per claim and returns the results", async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue(
      answer([
        { id: "o1", confirmed: true, reason: "same mug" },
        { id: "o2", confirmed: false, reason: "only a shadow" },
      ]),
    );
    const r = await new GeminiProvider("m", generate).verify([claim("o1", "moved"), claim("o2", "removed")]);
    expect(r.results.map((x) => x.confirmed)).toEqual([true, false]);
    expect(r.usage).toMatchObject({ inputTokens: 300, outputTokens: 40, retries: 0 });
    const params = generate.mock.calls[0][0];
    const parts = (params.contents as any)[0].parts;
    expect(parts).toHaveLength(10);
    expect(parts[0].text).toContain("Claim o1");
    expect(parts[0].text).toContain("MOVED");
    expect(parts[2].inlineData.mimeType).toBe("image/jpeg");
    expect(String(params.config?.systemInstruction)).toContain("lighting, shadow");
    expect((params.config?.responseJsonSchema as any).properties.results.items.required).toEqual(["id", "confirmed", "reason"]);
  });

  it("retries once when a claim is missing from the answer", async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(answer([{ id: "o1", confirmed: true, reason: "ok" }]))
      .mockResolvedValueOnce(answer([{ id: "o1", confirmed: true, reason: "ok" }, { id: "o2", confirmed: true, reason: "ok" }]));
    const r = await new GeminiProvider("m", generate).verify([claim("o1", "moved"), claim("o2", "added")]);
    expect(r.usage.retries).toBe(1);
    const retryParts = (generate.mock.calls[1][0].contents as any)[0].parts;
    expect(retryParts.at(-1).text).toContain('no answer for claim "o2"');
  });

  it("throws VisionSchemaError after two bad answers and makes no call for zero claims", async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue(answer([{ id: "zzz", confirmed: true, reason: "?" }]));
    await expect(new GeminiProvider("m", generate).verify([claim("o1", "moved")])).rejects.toThrow(VisionSchemaError);
    expect(generate).toHaveBeenCalledTimes(2);
    const none = vi.fn<GenerateFn>();
    expect((await new GeminiProvider("m", none).verify([])).results).toEqual([]);
    expect(none).not.toHaveBeenCalled();
  });
});
