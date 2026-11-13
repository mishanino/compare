"use client";

import { useState } from "react";
import { DropZone, type Picked } from "@/components/DropZone";

interface Dims {
  width: number;
  height: number;
}
interface PhotoInfo {
  photo: number;
  name: string;
  sourceFormat: string;
  full: Dims;
  model: Dims;
}
type CompareResponse = { before: PhotoInfo[]; after: PhotoInfo[] } | { error: string };

export default function UploadPage() {
  const [before, setBefore] = useState<Picked[]>([]);
  const [after, setAfter] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CompareResponse | null>(null);

  const ready = before.length > 0 && after.length > 0 && !busy;

  async function compare() {
    setBusy(true);
    setResult(null);
    const form = new FormData();
    before.forEach((p) => form.append("before", p.file, p.file.name));
    after.forEach((p) => form.append("after", p.file, p.file.name));
    try {
      const res = await fetch("/api/compare", { method: "POST", body: form });
      const ct = res.headers.get("content-type") ?? "";
      setResult(ct.includes("json") ? await res.json() : { error: `Server error (${res.status}).` });
    } catch {
      setResult({ error: "Network error. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Room Change Evidence</h1>
      <p className="lead">Upload photos of the same desk or small room, taken before and after.</p>

      <div className="zones">
        <DropZone title="Before" photos={before} onChange={(p) => { setBefore(p); setResult(null); }} />
        <DropZone title="After" photos={after} onChange={(p) => { setAfter(p); setResult(null); }} />
      </div>

      <button type="button" className="compare" disabled={!ready} onClick={compare}>
        {busy ? "Processing…" : "Compare"}
      </button>

      {result && "error" in result && <p className="error" role="alert">{result.error}</p>}
      {result && !("error" in result) && (
        <div className="result">
          {(["before", "after"] as const).map((set) => (
            <div key={set}>
              <h3>{set === "before" ? "Before" : "After"}</h3>
              <ul>
                {result[set].map((p) => (
                  <li key={p.photo}>
                    Photo {p.photo} ({p.sourceFormat}): {p.full.width}×{p.full.height}, model copy{" "}
                    {p.model.width}×{p.model.height}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
