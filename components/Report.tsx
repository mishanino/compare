import type { CompareResult } from "@/lib/pipeline";
import {
  conditionsText,
  errorTag,
  footerParts,
  headline,
  lastSeenCaption,
  pairCaptions,
  runMeta,
  tally,
} from "@/lib/report-view";
import type { ObjectVerdict } from "@/lib/verdict";
import { displayName, Mono, PrimaryButton, SecondaryButton, VerdictBadge, verdictText, type BadgeKind } from "./ui";

type Crops = CompareResult["crops"];

/** One crop in a 4:3 frame. object-contain so no part of the evidence is cut off. */
function Crop({ src, alt, caption, plainCaption = false }: { src?: string; alt: string; caption: string; plainCaption?: boolean }) {
  return (
    <figure className="m-0 flex flex-col">
      {/* The image is absolutely positioned so it can never stretch the 4:3 frame. */}
      <div className="relative aspect-[4/3] overflow-hidden bg-soft">
        {src && (
          // eslint-disable-next-line @next/next/no-img-element -- data URL crop
          <img src={src} alt={alt} className="absolute inset-0 block h-full w-full object-contain" />
        )}
      </div>
      <figcaption className={`m-0 font-mono text-label tracking-label ${plainCaption ? "py-[6px] text-muted" : "bg-bg px-[10px] py-[6px] text-ink"}`}>
        {caption}
      </figcaption>
    </figure>
  );
}

/** Before always first; stacks on narrow screens. */
function EvidencePair({ v, crops, minWidth = 300, plainCaption = false }: { v: ObjectVerdict; crops: Crops; minWidth?: number; plainCaption?: boolean }) {
  const caps = pairCaptions(v);
  const c = crops[v.object_id];
  if (!caps || !c) return null;
  const name = displayName(v.label);
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minWidth}px), 1fr))` }}>
      <Crop src={c.before} alt={`${name}, ${caps.before}`} caption={caps.before} plainCaption={plainCaption} />
      <Crop src={c.after} alt={`${name}, ${caps.after}`} caption={caps.after} plainCaption={plainCaption} />
    </div>
  );
}

export function ConditionsStrip({ text }: { text: string }) {
  return (
    <div role="note" aria-label="Capture conditions" className="flex flex-wrap items-center gap-x-4 gap-y-3 bg-soft px-6 py-4">
      <span className="inline-flex min-h-7 items-center bg-bg px-[10px] font-mono text-label font-medium tracking-badge">
        CONDITIONS · NOT A CHANGE
      </span>
      <p className="m-0 text-small">{text}</p>
    </div>
  );
}

function ChangeCard({ v, crops }: { v: ObjectVerdict; crops: Crops }) {
  const kind = v.verdict as BadgeKind;
  const name = displayName(v.label);
  return (
    <article aria-label={`${verdictText(kind)}: ${name}`} className="flex flex-col gap-4 bg-surface p-6">
      <div className="flex flex-wrap items-center gap-3">
        <VerdictBadge kind={kind} />
        <h4 className="text-card">{name}</h4>
        <Mono className="text-muted">{v.object_id}</Mono>
      </div>
      <p className="m-0 max-w-[62ch] text-body">{v.reason}</p>
      <EvidencePair v={v} crops={crops} />
    </article>
  );
}

function UncertainCard({ v, crops, onAddPhoto, addLabel }: { v: ObjectVerdict; crops: Crops; onAddPhoto: (v: ObjectVerdict) => void; addLabel: string }) {
  const kind = v.verdict as BadgeKind;
  const name = displayName(v.label);
  const seenCaption = lastSeenCaption(v);
  const seenSrc = v.last_seen ? crops[v.object_id]?.[v.last_seen.set] : undefined;
  return (
    <article
      aria-label={`${verdictText(kind)}: ${name}`}
      className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-6 border border-dashed border-divider p-6"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <VerdictBadge kind={kind} />
          <h4 className="text-section">{name}</h4>
          <Mono className="text-muted">{v.object_id}</Mono>
        </div>
        <p className="m-0 text-small">
          <Mono className="text-muted">WHY&nbsp;&nbsp;</Mono>
          {v.reason}
        </p>
        {v.requested_angle && (
          <p className="m-0 text-small">
            <Mono className="text-muted">HELPS&nbsp;</Mono>
            {v.requested_angle}
          </p>
        )}
        {v.requested_set && (
          <SecondaryButton className="mt-2 self-start" onClick={() => onAddPhoto(v)}>
            {addLabel}
          </SecondaryButton>
        )}
      </div>
      {seenCaption ? (
        <div className="max-w-[300px]">
          <Crop src={seenSrc} alt={`${name}, ${seenCaption}`} caption={seenCaption} plainCaption />
        </div>
      ) : (
        <EvidencePair v={v} crops={crops} minWidth={140} plainCaption />
      )}
    </article>
  );
}

function UnchangedList({ items }: { items: ObjectVerdict[] }) {
  return (
    <details className="bg-surface">
      <summary className="flex min-h-14 flex-wrap items-center gap-3 px-6 text-small hover:bg-soft">
        <span className="font-mono text-label font-medium tracking-badge text-muted">= UNCHANGED · {items.length}</span>
        <span>{items.map((v) => displayName(v.label)).join(", ")}</span>
        <Mono className="ml-auto" >
          <span aria-hidden="true">+</span>
        </Mono>
      </summary>
      <ul className="m-0 pt-0 pr-6 pb-4 pl-10 font-mono text-label tracking-label text-muted">
        {items.map((v) => (
          <li key={v.object_id}>
            {v.object_id}&nbsp;&nbsp;{displayName(v.label)} · same position in both sets
          </li>
        ))}
      </ul>
    </details>
  );
}

export function RunFooter({ result }: { result: CompareResult }) {
  const [time, cost, model] = footerParts(result);
  return (
    <footer className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-label tracking-label text-muted">
      <span>{time}</span>
      <span>· {cost}</span>
      <span>· {model}</span>
    </footer>
  );
}

export function ReportView(props: {
  result: CompareResult;
  onStartOver: () => void;
  onAddPhoto: (v: ObjectVerdict) => void;
  addLabel: (v: ObjectVerdict) => string;
}) {
  const { result, onStartOver, onAddPhoto, addLabel } = props;
  const r = result.report;
  if (r.status !== "ok") return null;
  const pending = [...r.not_verifiable, ...r.uncertain];
  const conditions = conditionsText(r);

  return (
    <section aria-label="Report" className="flex flex-col gap-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Mono className="text-muted">{runMeta(result)}</Mono>
          <h2 className="text-title">{headline(r)}</h2>
          <Mono>{tally(r)}</Mono>
        </div>
        <SecondaryButton onClick={onStartOver}>Start over</SecondaryButton>
      </div>

      {conditions && <ConditionsStrip text={conditions} />}

      {r.changes.length > 0 && (
        <div className="flex flex-col gap-4">
          <h3 className="mb-2 text-section">
            Supported changes <Mono className="font-normal text-muted">· {r.changes.length}</Mono>
          </h3>
          {r.changes.map((v) => (
            <ChangeCard key={v.object_id} v={v} crops={result.crops} />
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div className="flex flex-col gap-4">
          <h3 className="text-section text-muted">
            Not verifiable / Uncertain <Mono className="font-normal">· {pending.length}</Mono>
          </h3>
          {pending.map((v) => (
            <UncertainCard key={v.object_id} v={v} crops={result.crops} onAddPhoto={onAddPhoto} addLabel={addLabel(v)} />
          ))}
        </div>
      )}

      {r.unchanged.length > 0 && <UnchangedList items={r.unchanged} />}

      <RunFooter result={result} />
    </section>
  );
}

export function DeclinedView({ result, onStartOver }: { result: CompareResult; onStartOver: () => void }) {
  const r = result.report;
  if (r.status !== "declined") return null;
  return (
    <section aria-label="Declined" className="flex max-w-[720px] flex-col gap-4 bg-surface px-8 py-10">
      <VerdictBadge kind="declined" />
      <h2 className="text-title">Can&apos;t compare these photos</h2>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-body">
        {r.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <p className="m-0 text-small text-muted">Retake both sets of the same desk or room, in similar light.</p>
      <PrimaryButton className="mt-2 self-start" onClick={onStartOver}>
        Start over
      </PrimaryButton>
      <RunFooter result={result} />
    </section>
  );
}

export function ErrorView(props: { code: string; status: number; message: string; onRetry: () => void; onBack: () => void }) {
  const { code, status, message, onRetry, onBack } = props;
  return (
    <section role="alert" aria-label="Error" className="flex max-w-[720px] flex-col gap-4 bg-error-bg px-8 py-10">
      <VerdictBadge kind="error" suffix={errorTag(code, status)} />
      <h2 className="text-title">The comparison didn&apos;t finish</h2>
      <p className="m-0 text-body">{message}</p>
      <p className="m-0 text-body">Your photos are still here. Try again.</p>
      <div className="mt-2 flex flex-wrap gap-4">
        <PrimaryButton glyph="↻" onClick={onRetry}>
          Retry
        </PrimaryButton>
        <SecondaryButton onClick={onBack}>Back to photos</SecondaryButton>
      </div>
    </section>
  );
}
