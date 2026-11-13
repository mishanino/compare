import { describe, expect, it, vi, beforeEach } from "vitest";
import sharp from "sharp";
import { makeImage, ftyp, pixel } from "./helpers";

const heicMock = vi.hoisted(() => vi.fn());
vi.mock("heic-convert", () => ({ default: heicMock }));

import { preprocessImage, isHeic, MODEL_LONG_SIDE, PreprocessError } from "@/lib/preprocess";

const isRed = ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60;

describe("isHeic", () => {
  it("detects HEVC HEIF brands", () => {
    expect(isHeic(ftyp("heic", ["mif1", "heic"]))).toBe(true);
    expect(isHeic(ftyp("heix"))).toBe(true);
    expect(isHeic(ftyp("mif1", ["heic"]))).toBe(true);
  });
  it("leaves AVIF to sharp", () => {
    expect(isHeic(ftyp("avif", ["mif1", "avif"]))).toBe(false);
    expect(isHeic(ftyp("mif1", ["avif"]))).toBe(false);
  });
  it("rejects non-ISO-BMFF data", async () => {
    expect(isHeic(await makeImage(10, 10))).toBe(false);
    expect(isHeic(Buffer.from("short"))).toBe(false);
  });
});

describe("preprocessImage", () => {
  beforeEach(() => heicMock.mockClear());

  it("keeps full resolution and makes a 1536px model copy", async () => {
    const out = await preprocessImage(await makeImage(4000, 3000));
    expect(out.sourceFormat).toBe("jpeg");
    expect([out.full.width, out.full.height]).toEqual([4000, 3000]);
    expect([out.model.width, out.model.height]).toEqual([MODEL_LONG_SIDE, 1152]);
    const meta = await sharp(out.model.jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([MODEL_LONG_SIDE, 1152]);
  });

  it("applies EXIF rotation and strips the orientation tag", async () => {
    // Orientation 6 = rotate 90° clockwise to display. Stored 4000x3000, displayed 3000x4000.
    const out = await preprocessImage(await makeImage(4000, 3000, { orientation: 6 }));
    expect([out.full.width, out.full.height]).toEqual([3000, 4000]);
    expect([out.model.width, out.model.height]).toEqual([1152, MODEL_LONG_SIDE]);
    expect((await sharp(out.full.jpeg).metadata()).orientation).toBeUndefined();
    // Red marker stored top-left ends up top-right after a 90° CW rotation.
    expect(isRed(await pixel(out.full.jpeg, 3000 - 20, 20))).toBe(true);
    expect(isRed(await pixel(out.full.jpeg, 20, 20))).toBe(false);
  });

  it("does not upscale small images", async () => {
    const out = await preprocessImage(await makeImage(800, 600, { format: "png" }));
    expect(out.sourceFormat).toBe("png");
    expect([out.model.width, out.model.height]).toEqual([800, 600]);
    expect((await sharp(out.full.jpeg).metadata()).format).toBe("jpeg");
  });

  it("routes HEIC through heic-convert", async () => {
    const decoded = await makeImage(2000, 1500);
    heicMock.mockResolvedValue(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength));
    const out = await preprocessImage(ftyp("heic", ["mif1", "heic"]));
    expect(heicMock).toHaveBeenCalledOnce();
    expect(heicMock.mock.calls[0][0]).toMatchObject({ format: "JPEG" });
    expect(out.sourceFormat).toBe("heic");
    expect([out.full.width, out.full.height]).toEqual([2000, 1500]);
    expect([out.model.width, out.model.height]).toEqual([MODEL_LONG_SIDE, 1152]);
  });

  it("rejects non-images", async () => {
    await expect(preprocessImage(Buffer.from("definitely not an image"))).rejects.toThrow(PreprocessError);
    expect(heicMock).not.toHaveBeenCalled();
  });
});
