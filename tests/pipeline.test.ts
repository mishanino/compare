import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runCompare, VisionCallError } from "@/lib/pipeline";
import { PreprocessError } from "@/lib/preprocess";
import type { RunLogEntry } from "@/lib/runlog";
import type { UploadedPhoto } from "@/lib/upload";
import { VisionSchemaError, type VisionProvider } from "@/lib/vision/provider";
import { FakeProvider, sceneObservation, usage } from "./fake-provider";
import { makeImage } from "./helpers";

const prices = { inputPerMTokUsd: 1, outputPerMTokUsd: 10 };
let logPath: string;

beforeEach(async () => {
  logPath = path.join(await mkdtemp(path.join(os.tmpdir(), "rce-")), "log.jsonl");
});

async function photos() {
  const bytes = await makeImage(400, 300);
  const p = (set: "before" | "after"): UploadedPhoto => ({ set, photo: 1, name: `${set}.jpg`, bytes });
  return { before: [p("before")], after: [p("after")] };
}

async function lastLog(): Promise<RunLogEntry> {
  const lines = (await readFile(logPath, "utf8")).trim().split("\n");
  return JSON.parse(lines.at(-1)!);
}

const run = async (provider: VisionProvider) =>
  runCompare(await photos(), { getProvider: async () => provider, prices, logPath });

describe("runCompare", () => {
  it("verifies only the claimed changes and returns the report with crops", async () => {
    const fake = new FakeProvider(sceneObservation());
    const r = await run(fake);
    expect(fake.observeCalls).toBe(1);
    expect(fake.verifyCalls).toHaveLength(1);
    expect(fake.verifyCalls[0].map((c) => [c.id, c.kind])).toEqual([
      ["o1", "moved"],
      ["o2", "removed"],
    ]);
    expect(fake.verifyCalls[0][0].before.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG

    if (r.report.status !== "ok") throw new Error("expected ok");
    expect(r.report.changes.map((v) => v.object_id)).toEqual(["o1", "o2"]);
    expect(r.report.unchanged.map((v) => v.object_id)).toEqual(["o3"]);
    expect(r.report.not_verifiable.map((v) => v.object_id)).toEqual(["o4"]);
    // Crops for every verdict with evidence; none for not_verifiable.
    expect(Object.keys(r.crops).sort()).toEqual(["o1", "o2", "o3"]);
    expect(r.crops.o1.before).toMatch(/^data:image\/jpeg;base64,/);
    expect(r.photos.before[0]).toMatchObject({ photo: 1, name: "before.jpg", full: { width: 400, height: 300 } });
    // 11000 input tokens * $1/M + 2500 output tokens * $10/M
    expect(r.run.cost_usd).toBeCloseTo(0.011 + 0.025);
  });

  it("downgrades claims the verify step does not confirm", async () => {
    const fake = new FakeProvider(sceneObservation(), (claims) =>
      claims.map((c) => ({ id: c.id, confirmed: c.id !== "o2", reason: c.id === "o2" ? "the phone is in shadow, not gone" : "ok" })),
    );
    const r = await run(fake);
    if (r.report.status !== "ok") throw new Error("expected ok");
    expect(r.report.changes.map((v) => v.object_id)).toEqual(["o1"]);
    expect(r.report.uncertain.map((v) => v.object_id)).toEqual(["o2"]);
    expect(r.report.uncertain[0].reason).toContain("in shadow");
    expect(r.crops.o2).toBeDefined();
  });

  it("treats a failed verify call as not confirmed and logs the error", async () => {
    const fake = new FakeProvider(sceneObservation(), () => {
      throw new VisionSchemaError("bad twice", usage(1_000, 100));
    });
    const r = await run(fake);
    if (r.report.status !== "ok") throw new Error("expected ok");
    expect(r.report.changes).toHaveLength(0);
    expect(r.report.uncertain.map((v) => v.object_id)).toEqual(["o1", "o2"]);
    expect(r.report.uncertain[0].reason).toContain("could not be double-checked");
    expect(r.report.uncertain[0].reason).not.toContain("did not confirm");
    const log = await lastLog();
    expect(log.outcome).toBe("ok");
    expect(log.calls.map((c) => c.stage)).toEqual(["observe", "verify"]);
    expect(log.calls[1].error).toContain("bad twice");
  });

  it("skips verify when there are no claims", async () => {
    const obs = sceneObservation();
    obs.objects = obs.objects.filter((o) => o.id === "o3");
    const fake = new FakeProvider(obs);
    const r = await run(fake);
    expect(fake.verifyCalls).toHaveLength(0);
    expect(r.report.status).toBe("ok");
    expect((await lastLog()).calls.map((c) => c.stage)).toEqual(["observe"]);
  });

  it("declines without crops or a verify call for a different scene", async () => {
    const fake = new FakeProvider(sceneObservation({ same_scene: false }));
    const r = await run(fake);
    expect(r.report.status).toBe("declined");
    expect(r.crops).toEqual({});
    expect(fake.verifyCalls).toHaveLength(0);
    expect((await lastLog()).outcome).toBe("declined");
  });

  it("appends one log line with tokens, stage times and cost", async () => {
    await run(new FakeProvider(sceneObservation()));
    await run(new FakeProvider(sceneObservation()));
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const log = await lastLog();
    expect(log).toMatchObject({
      provider: "fake",
      model_id: "fake-model",
      outcome: "ok",
      photos: { before: 1, after: 1 },
      prices,
      counts: { changes: 2, uncertain: 0, not_verifiable: 1, unchanged: 1 },
    });
    expect(log.calls).toEqual([
      { stage: "observe", model_id: "fake-model", input_tokens: 10_000, output_tokens: 2_000, retries: 0, wall_ms: 1 },
      { stage: "verify", model_id: "fake-model", input_tokens: 1_000, output_tokens: 500, retries: 0, wall_ms: 1 },
    ]);
    expect(Object.keys(log.stage_ms)).toEqual(["preprocess", "observe", "verdict", "evidence", "verify"]);
    expect(log.cost_usd).toBeCloseTo(0.036);
  });

  it("logs a null cost when prices are not configured", async () => {
    await runCompare(await photos(), { getProvider: async () => new FakeProvider(sceneObservation()), prices: null, logPath });
    expect((await lastLog()).cost_usd).toBeNull();
  });

  it("wraps observe failures in VisionCallError and logs them", async () => {
    const fake = new FakeProvider(sceneObservation());
    fake.observe = async () => {
      throw new Error("quota exceeded");
    };
    await expect(run(fake)).rejects.toThrow(VisionCallError);
    const log = await lastLog();
    expect(log.outcome).toBe("error");
    expect(log.error).toContain("quota exceeded");
  });

  it("does not create the provider when a photo is unreadable", async () => {
    let created = false;
    const p = await photos();
    p.after[0].bytes = Buffer.from("not an image");
    await expect(
      runCompare(p, { getProvider: async () => ((created = true), new FakeProvider(sceneObservation())), prices, logPath }),
    ).rejects.toThrow(PreprocessError);
    expect(created).toBe(false);
  });
});

describe("readableError", () => {
  it("extracts the message from a provider JSON error body", async () => {
    const { readableError } = await import("@/lib/pipeline");
    const body = JSON.stringify({ error: { code: 503, message: "Model is overloaded.", status: "UNAVAILABLE" } });
    expect(readableError(new Error(body))).toBe("Model is overloaded. (503)");
    expect(readableError(new Error("plain"))).toBe("plain");
  });
});
