import { GoogleGenAI, type GenerateContentParameters, type Part } from "@google/genai";
import { z } from "zod";
import { checkObservation, makeObservationSchema, type Box, type Observation } from "./observation";
import { buildObservePrompt } from "./observe-prompt";
import { VisionSchemaError, type CallUsage, type ModelImage, type ObserveInput, type ObserveResult, type VisionProvider } from "./provider";

/**
 * Gemini's native box: [ymin, xmin, ymax, xmax], integers normalised to 0..1000
 * relative to the image (https://ai.google.dev/gemini-api/docs/image-understanding).
 * It is only used on the wire; everything outside this file sees `Box`.
 */
export const GeminiBoxSchema = z.array(z.number().int().min(0).max(1000)).length(4);
export type GeminiBox = z.infer<typeof GeminiBoxSchema>;

export const GeminiObservationSchema = makeObservationSchema(GeminiBoxSchema);
type GeminiObservation = z.infer<typeof GeminiObservationSchema>;

export const GEMINI_BOX_FORMAT =
  "write each box as [ymin, xmin, ymax, xmax], integers from 0 to 1000 relative to the width and height of that photo.";

/** Converts a Gemini box to {x, y, w, h} in 0..1. Tolerates swapped corners. */
export function geminiBoxToBox([a, b, c, d]: GeminiBox): Box {
  const clamp = (v: number) => Math.min(1, Math.max(0, v / 1000));
  const y0 = clamp(Math.min(a, c));
  const y1 = clamp(Math.max(a, c));
  const x0 = clamp(Math.min(b, d));
  const x1 = clamp(Math.max(b, d));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function toObservation(raw: GeminiObservation): Observation {
  return {
    ...raw,
    objects: raw.objects.map((o) => ({
      ...o,
      sightings: o.sightings.map(({ box, ...s }) => (box ? { ...s, box: geminiBoxToBox(box) } : s)),
    })),
  };
}

/** JSON Schema for `responseJsonSchema`, derived from the Zod schema. */
export function geminiResponseJsonSchema(): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(GeminiObservationSchema) as Record<string, unknown>;
  return schema;
}

/** The subset of the SDK response this adapter reads. */
export interface GeminiResponseLike {
  text?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}
export type GenerateFn = (params: GenerateContentParameters) => Promise<GeminiResponseLike>;

type ParseResult = { ok: true; observation: Observation } | { ok: false; problems: string[] };

/** Parses model text into a contract Observation, or lists what is wrong with it. */
export function parseGeminiObservation(text: string | undefined, counts: { before: number; after: number }): ParseResult {
  if (!text) return { ok: false, problems: ["empty response"] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["response is not valid JSON"] };
  }
  const parsed = GeminiObservationSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const observation = toObservation(parsed.data);
  const problems = checkObservation(observation, counts);
  for (const o of observation.objects) {
    for (const s of o.sightings) {
      if (s.box && (s.box.w <= 0 || s.box.h <= 0)) {
        problems.push(`object "${o.id}": ${s.set} photo ${s.photo} has a zero-area box`);
      }
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, observation };
}

function imageParts(set: "BEFORE" | "AFTER", images: ModelImage[]): Part[] {
  return images.flatMap((img, i) => [
    { text: `${set} photo ${i + 1}` },
    { inlineData: { mimeType: "image/jpeg", data: img.jpeg.toString("base64") } },
  ]);
}

export class GeminiProvider implements VisionProvider {
  readonly name = "gemini";

  constructor(
    readonly modelId: string,
    private readonly generate: GenerateFn,
  ) {}

  static fromApiKey(apiKey: string, modelId: string): GeminiProvider {
    const ai = new GoogleGenAI({ apiKey });
    return new GeminiProvider(modelId, (params) => ai.models.generateContent(params));
  }

  async observe(input: ObserveInput): Promise<ObserveResult> {
    const counts = { before: input.before.length, after: input.after.length };
    const baseParts: Part[] = [...imageParts("BEFORE", input.before), ...imageParts("AFTER", input.after)];
    const config = {
      systemInstruction: buildObservePrompt({
        beforeCount: counts.before,
        afterCount: counts.after,
        boxFormat: GEMINI_BOX_FORMAT,
      }),
      responseMimeType: "application/json",
      responseJsonSchema: geminiResponseJsonSchema(),
    };

    const usage: CallUsage = { modelId: this.modelId, inputTokens: 0, outputTokens: 0, retries: 0, wallMs: 0 };
    const started = Date.now();
    let problems: string[] = [];

    // One retry on schema failure; the retry tells the model what was wrong.
    for (let attempt = 0; attempt < 2; attempt++) {
      const parts =
        attempt === 0
          ? baseParts
          : [
              ...baseParts,
              {
                text: `Your previous answer was rejected for these reasons:\n- ${problems.slice(0, 20).join("\n- ")}\nReturn a corrected answer that follows the schema and the rules.`,
              },
            ];
      const res = await this.generate({ model: this.modelId, contents: [{ role: "user", parts }], config });
      usage.inputTokens += res.usageMetadata?.promptTokenCount ?? 0;
      usage.outputTokens += (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0);
      usage.retries = attempt;

      const result = parseGeminiObservation(res.text, counts);
      if (result.ok) {
        usage.wallMs = Date.now() - started;
        return { observation: result.observation, usage };
      }
      problems = result.problems;
    }

    usage.wallMs = Date.now() - started;
    throw new VisionSchemaError(
      `The vision model returned an invalid observation twice: ${problems.slice(0, 5).join("; ")}`,
      usage,
    );
  }
}
