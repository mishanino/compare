"use client";

import { useEffect, useState } from "react";
import { STAGES } from "@/lib/compare-events";
import type { PipelineStage } from "@/lib/pipeline";
import { Spinner } from "./ui";

/** Seconds since mount, updated once a second. */
function useElapsed(): number {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return Math.floor((now - started) / 1000);
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Three blocks with the status written out, so it does not rely on colour. */
export function StageIndicator({ current }: { current: PipelineStage | null }) {
  const at = current ? STAGES.findIndex((s) => s.id === current) : -1;
  const elapsed = useElapsed();
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label="Progress" aria-live="polite" className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-1 p-0">
        {STAGES.map((s, i) => {
          const state = i < at ? "Done" : i === at ? "Running" : "Waiting";
          const style =
            state === "Done" ? "bg-soft text-ink" : state === "Running" ? "bg-primary text-white font-extrabold" : "bg-surface text-muted opacity-60";
          return (
            <li key={s.id} className={`flex flex-col gap-1 p-4 transition-[background-color,color,opacity] duration-300 ${style}`}>
              <span className="flex items-center gap-2 font-mono text-label font-normal tracking-label">
                {state === "Running" && <Spinner />}
                0{i + 1} · {state}
              </span>
              <span className="text-body">{s.label}</span>
            </li>
          );
        })}
      </ol>
      {/* Not live: a screen reader would announce it every second. */}
      <span className="font-mono text-label tracking-label text-muted">Elapsed {clock(elapsed)}</span>
    </div>
  );
}
