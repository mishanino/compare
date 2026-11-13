import { NextResponse } from "next/server";
import type { CompareEvent, ErrorCode } from "@/lib/compare-events";
import { CancelledError, runCompare, VisionCallError } from "@/lib/pipeline";
import { PreprocessError } from "@/lib/preprocess";
import { pricesFromEnv } from "@/lib/runlog";
import { MAX_UPLOAD_BYTES, readCompareForm, UploadError } from "@/lib/upload";
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
    // Refuse an oversized body before buffering it; per-file limits are checked after parsing.
    if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES) {
      throw new UploadError("The upload is too large.");
    }
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

  // The user pressed Cancel or closed the tab: stop the run so no further
  // (paid) model call starts. Either signal can arrive first, depending on the server.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (ev: CompareEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
        } catch {
          open = false;
          abort.abort();
        }
      };
      try {
        const result = await runCompare(photos, {
          getProvider: () => createVisionProvider(),
          prices: pricesFromEnv(),
          onStage: (stage) => send({ type: "stage", stage }),
          signal: abort.signal,
        });
        send({ type: "result", result });
      } catch (err) {
        // Nobody is listening to a cancelled run; the pipeline has already logged it.
        if (!(err instanceof CancelledError)) send(toErrorEvent(err));
      } finally {
        if (open) {
          try {
            controller.close();
          } catch {
            // Already closed by a cancel from the client.
          }
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
