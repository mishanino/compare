import { describe, expect, it } from "vitest";
import { readCompareForm, UploadError, MAX_FILE_BYTES } from "@/lib/upload";

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: "image/jpeg" });

function form(before: (File | string)[], after: (File | string)[]) {
  const f = new FormData();
  before.forEach((x) => f.append("before", x));
  after.forEach((x) => f.append("after", x));
  return f;
}

describe("readCompareForm", () => {
  it("numbers photos from 1 within each set", async () => {
    const out = await readCompareForm(form([file("a.jpg"), file("b.jpg")], [file("c.jpg")]));
    expect(out.before.map((p) => [p.photo, p.name])).toEqual([[1, "a.jpg"], [2, "b.jpg"]]);
    expect(out.after.map((p) => [p.set, p.photo])).toEqual([["after", 1]]);
    expect(out.before[0].bytes.length).toBe(10);
  });

  it("requires at least one photo per set", async () => {
    await expect(readCompareForm(form([file("a.jpg")], []))).rejects.toThrow(/AFTER/);
    await expect(readCompareForm(form([], [file("a.jpg")]))).rejects.toThrow(/BEFORE/);
  });

  it("allows at most three photos per set", async () => {
    const four = [1, 2, 3, 4].map((i) => file(`${i}.jpg`));
    await expect(readCompareForm(form(four, [file("a.jpg")]))).rejects.toThrow(UploadError);
  });

  it("rejects text fields, empty and oversized files", async () => {
    await expect(readCompareForm(form(["hello"], [file("a.jpg")]))).rejects.toThrow(UploadError);
    await expect(readCompareForm(form([file("a.jpg", 0)], [file("b.jpg")]))).rejects.toThrow(/empty/);
    await expect(readCompareForm(form([file("a.jpg", MAX_FILE_BYTES + 1)], [file("b.jpg")]))).rejects.toThrow(/larger/);
  });
});
