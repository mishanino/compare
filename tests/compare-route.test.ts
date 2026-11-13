import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeProvider, sceneObservation } from "./fake-provider";
import { makeImage } from "./helpers";

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

beforeAll(async () => {
  process.env.RUN_LOG_PATH = path.join(await mkdtemp(path.join(os.tmpdir(), "rce-route-")), "log.jsonl");
});
beforeEach(() => {
  provider.current = new FakeProvider(sceneObservation());
});

describe("POST /api/compare", () => {
  it("returns the report with crops and photo info", async () => {
    const res = await post([
      ["before", blob(await makeImage(4000, 3000)), "b1.jpg"],
      ["after", blob(await makeImage(640, 480, { format: "png" })), "a1.png"],
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.status).toBe("ok");
    expect(body.report.changes.map((v: { verdict: string }) => v.verdict)).toEqual(["moved", "removed"]);
    expect(body.crops.o1.before).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.photos.before[0]).toEqual({
      photo: 1,
      name: "b1.jpg",
      sourceFormat: "jpeg",
      full: { width: 4000, height: 3000 },
      model: { width: 1536, height: 1152 },
    });
    expect(body.run).toMatchObject({ model_id: "fake-model" });
  });

  it("returns 400 with a readable message for bad input", async () => {
    const res = await post([
      ["before", new Blob(["not an image"]), "x.jpg"],
      ["after", blob(await makeImage(100, 100)), "a.jpg"],
    ]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/BEFORE photo 1 \(x\.jpg\)/);
  });

  it("returns 400 when a set is missing", async () => {
    const res = await post([["before", blob(await makeImage(100, 100)), "a.jpg"]]);
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-multipart body", async () => {
    const res = await POST(new Request("http://localhost/api/compare", { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
  });

  it("returns 500 without leaking config details when the provider is not configured", async () => {
    provider.current = null;
    const res = await post([
      ["before", blob(await makeImage(100, 100)), "b.jpg"],
      ["after", blob(await makeImage(100, 100)), "a.jpg"],
    ]);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("The vision provider is not configured on the server.");
  });

  it("returns 502 when the vision call fails", async () => {
    const fake = new FakeProvider(sceneObservation());
    fake.observe = async () => {
      throw new Error("503 model overloaded");
    };
    provider.current = fake;
    const res = await post([
      ["before", blob(await makeImage(100, 100)), "b.jpg"],
      ["after", blob(await makeImage(100, 100)), "a.jpg"],
    ]);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("model overloaded");
  });
});
