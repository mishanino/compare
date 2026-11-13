import sharp from "sharp";
import type { ImageVariant } from "./preprocess";
import type { Evidence } from "./verdict";
import type { Box } from "./vision/observation";

/** Padding added on each side, as a fraction of the box width / height. */
export const CROP_PADDING = 0.15;
/** Crops are downscaled so the long side is at most this many pixels. */
export const CROP_LONG_SIDE = 768;
const CROP_JPEG_QUALITY = 85;

export interface Crop {
  jpeg: Buffer;
  width: number;
  height: number;
  /** The padded region actually cropped, normalised 0..1. */
  region: Box;
}

export interface CropPair {
  before: Crop;
  after: Crop;
}

/** Grows a box by `pad` of its size on every side and clamps it to the image. */
export function padBox(box: Box, pad = CROP_PADDING): Box {
  const x0 = Math.max(0, box.x - box.w * pad);
  const y0 = Math.max(0, box.y - box.h * pad);
  const x1 = Math.min(1, box.x + box.w * (1 + pad));
  const y1 = Math.min(1, box.y + box.h * (1 + pad));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Pixel rectangle for a normalised box; always at least 1x1 and inside the image. */
export function toPixels(box: Box, width: number, height: number) {
  const left = Math.min(width - 1, Math.max(0, Math.floor(box.x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.floor(box.y * height)));
  const right = Math.min(width, Math.max(left + 1, Math.ceil((box.x + box.w) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil((box.y + box.h) * height)));
  return { left, top, width: right - left, height: bottom - top };
}

/** Crops a padded region from an EXIF-corrected image. */
export async function cropRegion(image: ImageVariant, box: Box, pad = CROP_PADDING): Promise<Crop> {
  const region = padBox(box, pad);
  const { data, info } = await sharp(image.jpeg)
    .extract(toPixels(region, image.width, image.height))
    .resize({ width: CROP_LONG_SIDE, height: CROP_LONG_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: CROP_JPEG_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height, region };
}

/** Crops both sides of an evidence pair from the full-size images (photo numbers are 1-based). */
export async function cropEvidence(
  full: { before: ImageVariant[]; after: ImageVariant[] },
  evidence: Evidence,
): Promise<CropPair> {
  const pick = (set: "before" | "after", photo: number) => {
    const img = full[set][photo - 1];
    if (!img) throw new Error(`Evidence refers to ${set} photo ${photo}, which does not exist.`);
    return img;
  };
  const [before, after] = await Promise.all([
    cropRegion(pick("before", evidence.before.photo), evidence.before.box),
    cropRegion(pick("after", evidence.after.photo), evidence.after.box),
  ]);
  return { before, after };
}

export const toDataUrl = (jpeg: Buffer) => `data:image/jpeg;base64,${jpeg.toString("base64")}`;

/** Limits for comparing an object's box with the box of its empty place. */
export const EMPTY_REGION_LIMITS = { maxAreaRatio: 4, maxAspectRatio: 3 };

/**
 * For added / removed: the empty-place box must be roughly the size and shape of
 * the object's box, or the crop pair does not show the same place. Sizes are
 * measured in pixels relative to each photo's diagonal, so photos of different
 * resolution or orientation compare fairly. Returns a reason when they do not match.
 */
export function emptyRegionMismatch(
  object: { box: Box; width: number; height: number },
  empty: { box: Box; width: number; height: number },
): string | null {
  const size = (r: typeof object) => {
    const diag = Math.hypot(r.width, r.height);
    return { w: (r.box.w * r.width) / diag, h: (r.box.h * r.height) / diag };
  };
  const a = size(object);
  const b = size(empty);
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return "a region has no area";
  const ratio = (x: number, y: number) => Math.max(x / y, y / x);
  const area = ratio(a.w * a.h, b.w * b.h);
  const aspect = ratio(a.w / a.h, b.w / b.h);
  if (area > EMPTY_REGION_LIMITS.maxAreaRatio) return `the empty-place region is ${area.toFixed(1)}x off in size`;
  if (aspect > EMPTY_REGION_LIMITS.maxAspectRatio) return `the empty-place region has a different shape (${aspect.toFixed(1)}x)`;
  return null;
}
