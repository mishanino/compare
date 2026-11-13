import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { glyph?: string };

/** Primary: accent fill, label left, glyph right. */
export function PrimaryButton({ children, glyph = "→", className = "", ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`flex min-h-tap min-w-[220px] items-center justify-between gap-6 border-0 bg-primary px-4 text-[15px] font-extrabold text-white transition-colors duration-150 hover:enabled:bg-primary-hover disabled:opacity-45 ${className}`}
    >
      <span>{children}</span>
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}

/** Secondary: 1px divider outline, surface fill and darker border on hover. */
export function SecondaryButton({ children, className = "", ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`flex min-h-tap items-center justify-start gap-2 border border-divider bg-transparent px-4 text-left text-hint font-extrabold text-ink transition-colors duration-150 hover:enabled:border-muted hover:enabled:bg-surface disabled:opacity-45 ${className}`}
    >
      {children}
    </button>
  );
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-label tracking-label ${className}`}>{children}</span>;
}

export type BadgeKind = "moved" | "added" | "removed" | "not_verifiable" | "uncertain" | "declined" | "error";

/** Text plus shape, never colour alone. Glyphs are decorative. */
const BADGES: Record<BadgeKind, { glyph: string; text: string; style: string }> = {
  moved: { glyph: "■", text: "Moved", style: "bg-soft text-ink" },
  added: { glyph: "●", text: "Added", style: "bg-primary text-white" },
  removed: { glyph: "▲", text: "Removed", style: "text-ink shadow-[inset_0_0_0_1px_var(--color-muted)]" },
  not_verifiable: { glyph: "?", text: "Not verifiable", style: "border border-dashed border-muted text-ink" },
  uncertain: { glyph: "~", text: "Uncertain", style: "border border-dashed border-muted text-ink" },
  declined: { glyph: "✕", text: "Declined", style: "bg-soft text-ink" },
  error: { glyph: "!", text: "Error", style: "bg-primary text-white" },
};

export function VerdictBadge({ kind, suffix }: { kind: BadgeKind; suffix?: string }) {
  const b = BADGES[kind];
  return (
    <span
      className={`inline-flex min-h-8 items-center gap-2 self-start px-3 font-mono text-label font-medium uppercase tracking-badge ${b.style}`}
    >
      <span aria-hidden="true">{b.glyph}</span>
      {b.text}
      {suffix ? ` · ${suffix}` : ""}
    </span>
  );
}

export const verdictText = (kind: BadgeKind) => BADGES[kind].text;

/** Model labels are lower case ("blue mug"); show them as names. */
export const displayName = (label: string) => (label ? label[0].toUpperCase() + label.slice(1) : label);
