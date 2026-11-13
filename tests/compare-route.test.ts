import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/compare/route";
import { makeImage } from "./helpers";

async function post(fields: [string, Blob, string][]) {
  const form = new FormData();
  for (const [k, v, name] of fields) form.append(k, v, name);
  return POST(new Request("http://localhost/api/compare", { method: "POST", body: form }));
}

const blob = (b: Buffer) => new Blob([new Uint8Array(b)]);

describe("POST /api/compare", () => {
  it("returns dimensions for every photo", async () => {
    const res = await post([
      ["before", blob(await makeImage(4000, 3000)), "b1.jpg"],
      // Orientation 8 swaps axes: stored 3000x4000, displayed 4000x3000.
      ["before", blob(await makeImage(3000, 4000, { orientation: 8 })), "b2.jpg"],
      ["after", blob(await makeImage(640, 480, { format: "png" })), "a1.png"],
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      before: [
        { photo: 1, name: "b1.jpg", sourceFormat: "jpeg", full: { width: 4000, height: 3000 }, model: { width: 1536, height: 1152 } },
        { photo: 2, name: "b2.jpg", sourceFormat: "jpeg", full: { width: 4000, height: 3000 }, model: { width: 1536, height: 1152 } },
      ],
      after: [
        { photo: 1, name: "a1.png", sourceFormat: "png", full: { width: 640, height: 480 }, model: { width: 640, height: 480 } },
      ],
    });
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
});
