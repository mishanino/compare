"use client";

import { useEffect, useRef, useState } from "react";
import { DropZone, isImageFile, toPicked, type Picked } from "@/components/DropZone";
import { DeclinedView, ErrorView, ReportView } from "@/components/Report";
import { StageIndicator } from "@/components/StageIndicator";
import { PrimaryButton } from "@/components/ui";
import { CompareFailure, readCompareResponse } from "@/lib/compare-events";
import type { CompareResult, PipelineStage } from "@/lib/pipeline";
import { ACCEPT_ATTR, MAX_PHOTOS_PER_SET, type PhotoSet } from "@/lib/upload";
import type { ObjectVerdict } from "@/lib/verdict";

type Status = "idle" | "processing" | "report" | "declined" | "error";
interface Failure {
  code: string;
  status: number;
  message: string;
}

const SET_NAME: Record<PhotoSet, string> = { before: "Before", after: "After" };

export default function Home() {
  const [before, setBefore] = useState<Picked[]>([]);
  const [after, setAfter] = useState<Picked[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [stage, setStage] = useState<PipelineStage | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const extraInput = useRef<HTMLInputElement>(null);
  const extraTarget = useRef<PhotoSet>("after");

  const processing = status === "processing";
  const ready = before.length > 0 && after.length > 0;

  useEffect(() => {
    if (status !== "processing") window.scrollTo({ top: 0 });
  }, [status]);

  async function run(b: Picked[], a: Picked[]) {
    setStatus("processing");
    setStage(null);
    setFailure(null);
    setNotice(null);
    const form = new FormData();
    b.forEach((p) => form.append("before", p.file, p.file.name));
    a.forEach((p) => form.append("after", p.file, p.file.name));
    try {
      const res = await fetch("/api/compare", { method: "POST", body: form });
      const out = await readCompareResponse(res, setStage);
      setResult(out);
      setStatus(out.report.status === "declined" ? "declined" : "report");
    } catch (err) {
      setFailure(
        err instanceof CompareFailure
          ? { code: err.code, status: err.status, message: err.message }
          : { code: "network", status: 0, message: "Network error. Check the connection." },
      );
      setStatus("error");
    }
  }

  function startOver() {
    [...before, ...after].forEach((p) => URL.revokeObjectURL(p.url));
    setBefore([]);
    setAfter([]);
    setResult(null);
    setFailure(null);
    setNotice(null);
    setStatus("idle");
  }

  /** Opens the file picker for the set the requested angle belongs to, then re-runs. */
  function addPhotoFor(v: ObjectVerdict) {
    const set = v.requested_set ?? "after";
    const current = set === "before" ? before : after;
    if (current.length >= MAX_PHOTOS_PER_SET) {
      setNotice(`${SET_NAME[set]} already has ${MAX_PHOTOS_PER_SET} photos. Remove one to add the requested angle, then compare again.`);
      setStatus("idle");
      return;
    }
    extraTarget.current = set;
    extraInput.current?.click();
  }

  function onExtraPhoto(file: File | undefined) {
    if (!file) return;
    if (!isImageFile(file)) {
      setNotice("That file is not an image.");
      return;
    }
    const picked = toPicked(file);
    const b = extraTarget.current === "before" ? [...before, picked] : before;
    const a = extraTarget.current === "after" ? [...after, picked] : after;
    setBefore(b);
    setAfter(a);
    void run(b, a);
  }

  const hint = processing
    ? "Photos are locked while we compare."
    : ready
      ? "Ready. More angles give stronger evidence."
      : "Add at least one photo to each side.";

  return (
    <main className="flex max-w-[1040px] flex-col gap-12 px-6 pt-12 pb-20">
      <header className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-4">
        <span aria-hidden="true" className="mt-1 h-10 w-10 bg-accent" />
        <div className="flex flex-col gap-2">
          <h1 className="text-display tracking-display">Room Change Evidence</h1>
          <p className="m-0 max-w-[58ch] text-body text-muted">
            Upload before and after photos of a desk or small room. We report what physically changed, with evidence.
          </p>
        </div>
      </header>

      {(status === "idle" || processing) && (
        <section aria-label="Upload" className="flex flex-col gap-6">
          {notice && (
            <p role="status" className="m-0 bg-soft px-6 py-4 text-small">
              {notice}
            </p>
          )}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-4">
            <DropZone label="Before" photos={before} onChange={setBefore} locked={processing} />
            <DropZone label="After" photos={after} onChange={setAfter} locked={processing} />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <PrimaryButton disabled={!ready || processing} onClick={() => run(before, after)}>
              {processing ? "Comparing…" : "Compare"}
            </PrimaryButton>
            <span className="text-hint text-muted">{hint}</span>
          </div>
          {processing && <StageIndicator current={stage ?? "prepare"} />}
        </section>
      )}

      {status === "report" && result && (
        <ReportView
          result={result}
          onStartOver={startOver}
          onAddPhoto={addPhotoFor}
          addLabel={(v) => `+ Add one more ${SET_NAME[v.requested_set ?? "after"]} photo`}
        />
      )}
      {status === "declined" && result && <DeclinedView result={result} onStartOver={startOver} />}
      {status === "error" && failure && (
        <ErrorView {...failure} onRetry={() => run(before, after)} onBack={() => setStatus("idle")} />
      )}

      <input
        ref={extraInput}
        type="file"
        accept={ACCEPT_ATTR}
        hidden
        onChange={(e) => {
          onExtraPhoto(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </main>
  );
}
