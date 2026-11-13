"use client";

import { useState } from "react";
import { DropZone, type Picked } from "@/components/DropZone";
import type { CompareResult } from "@/lib/pipeline";
import type { ObjectVerdict } from "@/lib/verdict";

type CompareResponse = CompareResult | { error: string };

const SECTIONS = [
  { key: "changes", title: "Changes" },
  { key: "uncertain", title: "Uncertain" },
  { key: "not_verifiable", title: "Not verifiable" },
  { key: "unchanged", title: "Unchanged" },
] as const;

function VerdictItem({ v, crops }: { v: ObjectVerdict; crops: CompareResult["crops"] }) {
  const c = crops[v.object_id];
  return (
    <li className="verdict">
      <p>
        <strong>{v.label}</strong>: {v.verdict.replace("_", " ")}. {v.reason}
      </p>
      {v.requested_angle && <p className="angle">Please add: {v.requested_angle}</p>}
      {c && v.evidence && (
        <div className="crops">
          <figure>
            <img src={c.before} alt={`${v.label}, BEFORE photo ${v.evidence.before.photo}`} />
            <figcaption>Before, photo {v.evidence.before.photo}</figcaption>
          </figure>
          <figure>
            <img src={c.after} alt={`${v.label}, AFTER photo ${v.evidence.after.photo}`} />
            <figcaption>After, photo {v.evidence.after.photo}</figcaption>
          </figure>
        </div>
      )}
    </li>
  );
}

function ReportView({ result }: { result: CompareResult }) {
  const { report } = result;
  if (report.status === "declined") {
    return (
      <div className="report">
        <h2>No conclusion</h2>
        <ul>{report.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      </div>
    );
  }
  return (
    <div className="report">
      {report.changes.length === 0 && <p>No supported changes found.</p>}
      {SECTIONS.map(({ key, title }) =>
        report[key].length > 0 ? (
          <section key={key}>
            <h2>{title}</h2>
            <ul>{report[key].map((v) => <VerdictItem key={v.object_id} v={v} crops={result.crops} />)}</ul>
          </section>
        ) : null,
      )}
    </div>
  );
}

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
        {busy ? "Processing… (this can take a minute or two)" : "Compare"}
      </button>

      {result && "error" in result && <p className="error" role="alert">{result.error}</p>}
      {result && !("error" in result) && <ReportView result={result} />}
    </main>
  );
}
