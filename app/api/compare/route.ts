import { NextResponse } from "next/server";
import { preprocessImage, PreprocessError } from "@/lib/preprocess";
import { readCompareForm, UploadError, type UploadedPhoto } from "@/lib/upload";

export const runtime = "nodejs";

async function describe(p: UploadedPhoto) {
  try {
    const img = await preprocessImage(p.bytes);
    return {
      photo: p.photo,
      name: p.name,
      sourceFormat: img.sourceFormat,
      full: { width: img.full.width, height: img.full.height },
      model: { width: img.model.width, height: img.model.height },
    };
  } catch (err) {
    if (err instanceof PreprocessError) {
      throw new PreprocessError(`${p.set.toUpperCase()} photo ${p.photo} (${p.name}): ${err.message}`);
    }
    throw err;
  }
}

export async function POST(request: Request) {
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new UploadError("Expected a multipart/form-data upload.");
    }
    const photos = await readCompareForm(form);
    const [before, after] = await Promise.all([
      Promise.all(photos.before.map(describe)),
      Promise.all(photos.after.map(describe)),
    ]);
    return NextResponse.json({ before, after });
  } catch (err) {
    if (err instanceof UploadError || err instanceof PreprocessError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(err);
    return NextResponse.json({ error: "Internal error while processing photos." }, { status: 500 });
  }
}
