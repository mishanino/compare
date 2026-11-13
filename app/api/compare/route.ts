import { NextResponse } from "next/server";
import type { CompareEvent, ErrorCode } from "@/lib/compare-events";
import { runCompare, VisionCallError } from "@/lib/pipeline";
import { PreprocessError } from "@/lib/preprocess";
import { pricesFromEnv } from "@/lib/runlog";
import { readCompareForm, UploadError } from "@/lib/upload";
import { createVisionProvider, VisionConfigError } from "@/lib/vision/provider";

export const runtime = "nodejs";
// Two vision calls can take a couple of minutes on large photo sets.
export const maxDuration = 300;

function toErrorEvent(err: unknown): Extract<CompareEvent, { type: "error" }> {
  const ev = (status: number, code: ErrorCode, error: string) => ({ type: "error" as const, status, code, error });
  if (err instanceof PreprocessError) return ev(400, "bad_photo", err.message);
  if (err instanceof VisionConfigError) {
    console.error(err);
    return ev(500, "provider_not_configured", "The vision provider is not configured on the server.");
  }
  if (err instanceof VisionCallError) {
    console.error(err);
    return ev(502, "vision_unavailable", err.message);
  }
  console.error(err);
  return ev(500, "internal", "Internal error while processing photos.");
}

/**
 * Validates the upload, then streams NDJSON events: one per pipeline stage, then
 * either the result or an error.
 */
export async function POST(request: Request) {
  let photos: Awaited<ReturnType<typeof readCompareForm>>;
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new UploadError("Expected a multipart/form-data upload.");
    }
    photos = await readCompareForm(form);
  } catch (err) {
    if (err instanceof UploadError) {
      return NextResponse.json({ error: err.message, code: "bad_upload" }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal error while reading the upload.", code: "internal" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: CompareEvent) => controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      try {
        const result = await runCompare(photos, {
          getProvider: () => createVisionProvider(),
          prices: pricesFromEnv(),
          onStage: (stage) => send({ type: "stage", stage }),
        });
        send({ type: "result", result });
      } catch (err) {
        send(toErrorEvent(err));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
