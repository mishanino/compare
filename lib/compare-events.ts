/**
 * Wire format of POST /api/compare: newline-delimited JSON events, so the UI can
 * show real progress while the pipeline runs. Shared by the route and the client;
 * keep it free of Node-only imports.
 */
import type { CompareResult, PipelineStage } from "./pipeline";

export const STAGES: { id: PipelineStage; label: string }[] = [
  { id: "prepare", label: "Preparing photos" },
  { id: "observe", label: "Observing scene" },
  { id: "check", label: "Checking evidence" },
];

export type ErrorCode = "bad_upload" | "bad_photo" | "provider_not_configured" | "vision_unavailable" | "internal";

export type CompareEvent =
  | { type: "stage"; stage: PipelineStage }
  | { type: "result"; result: CompareResult }
  | { type: "error"; status: number; code: ErrorCode; error: string };

export class CompareFailure extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode | "network",
    readonly status: number,
  ) {
    super(message);
    this.name = "CompareFailure";
  }
}

/**
 * Reads the compare response. Validation errors arrive as a plain JSON body with a
 * 4xx status; everything after that is an NDJSON stream of events.
 */
export async function readCompareResponse(
  res: Response,
  onStage: (stage: PipelineStage) => void,
): Promise<CompareResult> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("ndjson")) {
    let body: { error?: string; code?: ErrorCode } = {};
    try {
      body = await res.json();
    } catch {
      // Not JSON (for example a proxy error page).
    }
    throw new CompareFailure(body.error ?? `Server error (${res.status}).`, body.code ?? "internal", res.status);
  }
  if (!res.body) throw new CompareFailure("Empty response from the server.", "internal", res.status);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (line: string): CompareResult | undefined => {
    if (!line.trim()) return undefined;
    const ev = JSON.parse(line) as CompareEvent;
    if (ev.type === "stage") onStage(ev.stage);
    else if (ev.type === "error") throw new CompareFailure(ev.error, ev.code, ev.status);
    else return ev.result;
    return undefined;
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const result = handle(line);
      if (result) return result;
    }
    if (done) break;
  }
  const result = handle(buffer);
  if (result) return result;
  throw new CompareFailure("The connection closed before the comparison finished.", "network", 0);
}
