import { NextResponse } from "next/server";
import { runCompare, VisionCallError } from "@/lib/pipeline";
import { PreprocessError } from "@/lib/preprocess";
import { pricesFromEnv } from "@/lib/runlog";
import { readCompareForm, UploadError } from "@/lib/upload";
import { createVisionProvider, VisionConfigError } from "@/lib/vision/provider";

export const runtime = "nodejs";
// Two vision calls can take a couple of minutes on large photo sets.
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new UploadError("Expected a multipart/form-data upload.");
    }
    const photos = await readCompareForm(form);
    const result = await runCompare(photos, { getProvider: () => createVisionProvider(), prices: pricesFromEnv() });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof UploadError || err instanceof PreprocessError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof VisionConfigError) {
      console.error(err);
      return NextResponse.json({ error: "The vision provider is not configured on the server." }, { status: 500 });
    }
    if (err instanceof VisionCallError) {
      console.error(err);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error(err);
    return NextResponse.json({ error: "Internal error while processing photos." }, { status: 500 });
  }
}
