import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import { emptyRegionMismatch } from "@/lib/evidence";
import { measureQuality, qualityProblem } from "@/lib/quality";
import { makeTexturedImage } from "./helpers";

// Synthetic textured image and degraded copies (testset/ is for the eval script only).
async function variant(fn: (s: Sharp) => Sharp) {
  const jpeg = await fn(sharp(await makeTexturedImage(1200, 900))).jpeg().toBuffer();
  return measureQuality({ jpeg, width: 1200, height: 900 });
}

describe("photo quality gate", () => {
  it("passes a detailed, normally exposed photo", async () => {
    const q = await variant((s) => s);
    expect(qualityProblem(q, "BEFORE photo 1")).toBeNull();
  });

  it("flags a photo darkened to 4% as too dark", async () => {
    const q = await variant((s) => s.modulate({ brightness: 0.04 }));
    expect(qualityProblem(q, "AFTER photo 2")).toMatch(/^AFTER photo 2 is too dark/);
  });

  it("flags a blurred photo", async () => {
    const q = await variant((s) => s.blur(4));
    expect(qualityProblem(q, "AFTER photo 1")).toBe("AFTER photo 1 is too blurred to read.");
  });

  it("flags an overexposed photo", async () => {
    const q = await variant((s) => s.modulate({ brightness: 6 }));
    expect(qualityProblem(q, "BEFORE photo 3")).toMatch(/overexposed/);
  });

  it("does not upscale small photos, which would make them read as blurred", async () => {
    const jpeg = await makeTexturedImage(120, 90);
    const q = await measureQuality({ jpeg, width: 120, height: 90 });
    expect(qualityProblem(q, "x")).toBeNull();
  });
});

describe("emptyRegionMismatch", () => {
  const photo = { width: 4000, height: 3000 };
  const book = { ...photo, box: { x: 0.6, y: 0.7, w: 0.3, h: 0.17 } };

  it("accepts an empty place of similar size and shape", () => {
    expect(emptyRegionMismatch(book, { ...photo, box: { x: 0.58, y: 0.68, w: 0.33, h: 0.2 } })).toBeNull();
  });

  it("rejects a thin strip in place of a book", () => {
    expect(emptyRegionMismatch(book, { ...photo, box: { x: 0.6, y: 0.75, w: 0.3, h: 0.04 } })).toMatch(/size|shape/);
  });

  it("rejects a region of a very different size", () => {
    expect(emptyRegionMismatch(book, { ...photo, box: { x: 0.1, y: 0.1, w: 0.8, h: 0.6 } })).toMatch(/size/);
  });

  it("compares in pixels, so portrait and landscape photos of one place match", () => {
    const landscape = { width: 4000, height: 3000, box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } };
    // Same 800x600 px region in a 3000x4000 portrait photo.
    const portrait = { width: 3000, height: 4000, box: { x: 0.4, y: 0.4, w: 800 / 3000, h: 600 / 4000 } };
    expect(emptyRegionMismatch(landscape, portrait)).toBeNull();
  });
});
