import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CROP_LONG_SIDE, cropEvidence, cropRegion, padBox, toDataUrl, toPixels } from "@/lib/evidence";
import { preprocessImage } from "@/lib/preprocess";
import { makeImage } from "./helpers";

describe("padBox", () => {
  it("adds 15% of the box size on every side", () => {
    const b = padBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.1 });
    expect(b.x).toBeCloseTo(0.37);
    expect(b.y).toBeCloseTo(0.385);
    expect(b.w).toBeCloseTo(0.26);
    expect(b.h).toBeCloseTo(0.13);
  });

  it("clamps to the image", () => {
    expect(padBox({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const b = padBox({ x: 0.9, y: 0, w: 0.1, h: 0.2 });
    expect(b.x + b.w).toBeCloseTo(1);
    expect(b.y).toBe(0);
  });
});

describe("toPixels", () => {
  it("is always at least 1x1 and inside the image", () => {
    expect(toPixels({ x: 1, y: 1, w: 0, h: 0 }, 100, 50)).toEqual({ left: 99, top: 49, width: 1, height: 1 });
    expect(toPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, 100, 50)).toEqual({ left: 25, top: 25, width: 50, height: 25 });
  });
});

describe("cropRegion", () => {
  it("crops the padded region from the EXIF-corrected image", async () => {
    // Stored 300x400 with orientation 8 (90° counter-clockwise to display) -> upright
    // 400x300. The red marker stored top-left ends up bottom-left (x 0..0.25, y 0.75..1).
    const img = await preprocessImage(await makeImage(300, 400, { orientation: 8 }));
    expect([img.full.width, img.full.height]).toEqual([400, 300]);
    const red = await cropRegion(img.full, { x: 0.05, y: 0.82, w: 0.1, h: 0.1 });
    expect(red.width).toBe(Math.round(400 * 0.13));
    const r = (await sharp(red.jpeg).stats()).dominant;
    expect(r.r).toBeGreaterThan(200);
    expect(r.b).toBeLessThan(80);
    // Top-left of the upright image is background (blue), not the marker.
    const blue = (await sharp((await cropRegion(img.full, { x: 0.05, y: 0.05, w: 0.1, h: 0.1 })).jpeg).stats()).dominant;
    expect(blue.b).toBeGreaterThan(150);
    expect(blue.r).toBeLessThan(80);
  });

  it("downscales large crops to CROP_LONG_SIDE", async () => {
    const img = await preprocessImage(await makeImage(4000, 3000));
    const crop = await cropRegion(img.full, { x: 0, y: 0, w: 1, h: 1 });
    expect(Math.max(crop.width, crop.height)).toBe(CROP_LONG_SIDE);
  });
});

describe("cropEvidence", () => {
  it("crops both sides by 1-based photo number and rejects missing photos", async () => {
    const a = await preprocessImage(await makeImage(200, 100));
    const b = await preprocessImage(await makeImage(100, 200));
    const full = { before: [a.full], after: [a.full, b.full] };
    const box = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };
    const pair = await cropEvidence(full, { before: { photo: 1, box }, after: { photo: 2, box } });
    expect(pair.before.width).toBeGreaterThan(pair.before.height);
    expect(pair.after.height).toBeGreaterThan(pair.after.width);
    await expect(cropEvidence(full, { before: { photo: 2, box }, after: { photo: 1, box } })).rejects.toThrow(/before photo 2/);
    expect(toDataUrl(pair.before.jpeg)).toMatch(/^data:image\/jpeg;base64,/);
  });
});
