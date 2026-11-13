import { describe, expect, it } from "vitest";
import { ftyp } from "./helpers";
import { preprocessImage, PreprocessError } from "@/lib/preprocess";

// Uses the real heic-convert (no mock): a HEIC signature with no image data
// must surface as a PreprocessError, not a raw decoder exception.
describe("preprocessImage with a broken HEIC", () => {
  it("wraps decoder failures", async () => {
    const err = await preprocessImage(ftyp("heic", ["mif1", "heic"])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreprocessError);
    expect((err as Error).message).toMatch(/^Could not decode HEIC image/);
  });
});
