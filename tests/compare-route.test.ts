import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CompareFailure, readCompareResponse } from "@/lib/compare-events";
import { FakeProvider, sceneObservation } from "./fake-provider";
import { makeImage, makeTexturedImage } from "./helpers";

const provider = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/vision/provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/vision/provider")>();
  return {
    ...real,
    createVisionProvider: async () => {
      if (!provider.current) throw new real.VisionConfigError("Environment variable GEMINI_API_KEY is not set.");
      return provider.current;
    },
  };
});

const { POST } = await import("@/app/api/compare/route");

async function post(fields: [string, Blob, string][]) {
  const form = new FormData();
  for (const [k, v, name] of fields) form.append(k, v, name);
  return POST(new Request("http://localhost/api/compare", { method: "POST", body: form }));
}

const blob = (b: Buffer) => new Blob([new Uint8Array(b)]);
async function failure(res: Response): Promise<CompareFailure> {
  try {
    await readCompareResponse(res, () => {});
  } catch (e) {
    return e as CompareFailure;
  }
  throw new Error("expected the compare request to fail");
}

beforeAll(async () => {
  process.env.RUN_LOG_PATH = path.join(await mkdtemp(path.join(os.tmpdir(), "rce-route-")), "log.jsonl");
});
beforeEach(() => {
  provider.current = new FakeProvider(sceneObservation());
});

describe("POST /api/compare", () => {
  it("streams the stages, then the report with crops and photo info", async () => {
    const res = await post([
      ["before", blob(await makeTexturedImage(2048, 1536)), "b1.jpg"],
      ["after", blob(await makeTexturedImage(640, 480, { format: "png" })), "a1.png"],
    ]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const stages: string[] = [];
    const body = await readCompareResponse(res, (s) => stages.push(s));
    expect(stages).toEqual(["prepare", "observe", "check"]);
    if (body.report.status !== "ok") throw new Error("expected ok");
    expect(body.report.changes.map((v) => v.verdict)).toEqual(["moved", "removed"]);
    expect(body.crops.o1.before).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.photos.before[0]).toEqual({
      photo: 1,
      name: "b1.jpg",
      sourceFormat: "jpeg",
      full: { width: 2048, height: 1536 },
      model: { width: 1536, height: 1152 },
    });
    expect(body.run).toMatchObject({ model_id: "fake-model" });
  });

  it("streams a bad_photo error with a readable message for an unreadable photo", async () => {
    const res = await post([
      ["before", new Blob(["not an image"]), "x.jpg"],
      ["after", blob(await makeTexturedImage(100, 100)), "a.jpg"],
    ]);
    const err = await failure(res);
    expect(err).toBeInstanceOf(CompareFailure);
    expect(err).toMatchObject({ code: "bad_photo", status: 400 });
    expect(err.message).toMatch(/BEFORE photo 1 \(x\.jpg\)/);
  });

  it("returns 400 JSON when a set is missing", async () => {
    const res = await post([["before", blob(await makeImage(100, 100)), "a.jpg"]]);
    expect(res.status).toBe(400);
    expect(await failure(res)).toMatchObject({ code: "bad_upload", status: 400 });
  });

  it("returns 400 JSON for a non-multipart body", async () => {
    const res = await POST(new Request("http://localhost/api/compare", { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
  });

  it("streams a config error without leaking details", async () => {
    provider.current = null;
    const res = await post([
      ["before", blob(await makeTexturedImage(100, 100)), "b.jpg"],
      ["after", blob(await makeTexturedImage(100, 100)), "a.jpg"],
    ]);
    expect(await failure(res)).toMatchObject({
      code: "provider_not_configured",
      status: 500,
      message: "The vision provider is not configured on the server.",
    });
  });

  it("streams a vision_unavailable error when the vision call fails", async () => {
    const fake = new FakeProvider(sceneObservation());
    fake.observe = async () => {
      throw new Error("503 model overloaded");
    };
    provider.current = fake;
    const res = await post([
      ["before", blob(await makeTexturedImage(100, 100)), "b.jpg"],
      ["after", blob(await makeTexturedImage(100, 100)), "a.jpg"],
    ]);
    const err = await failure(res);
    expect(err).toMatchObject({ code: "vision_unavailable", status: 502 });
    expect(err.message).toContain("model overloaded");
  });
});

describe("readCompareResponse", () => {
  const ndjson = (chunks: string[]) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
          c.close();
        },
      }),
      { headers: { "content-type": "application/x-ndjson" } },
    );

  it("handles events split across chunks", async () => {
    const result = { report: { status: "declined", reasons: [], notes: {} }, crops: {}, photos: {}, run: {} };
    const line = JSON.stringify({ type: "result", result });
    const stages: string[] = [];
    const out = await readCompareResponse(
      ndjson(['{"type":"stage","stage":"prep', 'are"}\n', line.slice(0, 10), line.slice(10)]),
      (s) => stages.push(s),
    );
    expect(stages).toEqual(["prepare"]);
    expect(out.report.status).toBe("declined");
  });

  it("fails clearly when the stream ends without a result", async () => {
    expect(await failure(ndjson(['{"type":"stage","stage":"observe"}\n']))).toMatchObject({ code: "network" });
  });
});
