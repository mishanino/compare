/** Shared upload limits, used by both the UI and the API route. */
export const MAX_PHOTOS_PER_SET = 3;
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** Whole request body: both full sets plus multipart overhead. */
export const MAX_UPLOAD_BYTES = 2 * MAX_PHOTOS_PER_SET * MAX_FILE_BYTES + 1024 * 1024;
export const ACCEPT_ATTR = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,.jpg,.jpeg,.png,.webp";

export type PhotoSet = "before" | "after";

export interface UploadedPhoto {
  set: PhotoSet;
  /** 1-based index within its set, matches `photo` in the data contract. */
  photo: number;
  name: string;
  bytes: Buffer;
}

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

/** Validates the multipart form: fields `before` and `after`, 1..3 files each. */
export async function readCompareForm(form: FormData): Promise<Record<PhotoSet, UploadedPhoto[]>> {
  const out = { before: [] as UploadedPhoto[], after: [] as UploadedPhoto[] };
  for (const set of ["before", "after"] as const) {
    const entries = form.getAll(set);
    if (entries.length === 0) throw new UploadError(`Add at least one ${set.toUpperCase()} photo.`);
    if (entries.length > MAX_PHOTOS_PER_SET) {
      throw new UploadError(`At most ${MAX_PHOTOS_PER_SET} ${set.toUpperCase()} photos are allowed.`);
    }
    for (const [i, entry] of entries.entries()) {
      if (typeof entry === "string") throw new UploadError(`Field "${set}" must contain files.`);
      if (entry.size === 0) throw new UploadError(`${entry.name || "A file"} is empty.`);
      if (entry.size > MAX_FILE_BYTES) {
        throw new UploadError(`${entry.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      }
      out[set].push({ set, photo: i + 1, name: entry.name, bytes: Buffer.from(await entry.arrayBuffer()) });
    }
  }
  return out;
}
