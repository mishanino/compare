import { STAGES } from "@/lib/compare-events";
import type { PipelineStage } from "@/lib/pipeline";

/** Three blocks with the status written out, so it does not rely on colour. */
export function StageIndicator({ current }: { current: PipelineStage | null }) {
  const at = current ? STAGES.findIndex((s) => s.id === current) : -1;
  return (
    <ol
      aria-label="Progress"
      aria-live="polite"
      className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-1 p-0"
    >
      {STAGES.map((s, i) => {
        const state = i < at ? "Done" : i === at ? "Running" : "Waiting";
        const style =
          state === "Done" ? "bg-soft text-ink" : state === "Running" ? "bg-primary text-white font-extrabold" : "bg-surface text-muted opacity-60";
        return (
          <li key={s.id} className={`flex flex-col gap-1 p-4 transition-[background-color,color,opacity] duration-300 ${style}`}>
            <span className="font-mono text-label font-normal tracking-label">
              0{i + 1} · {state}
            </span>
            <span className="text-body">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
