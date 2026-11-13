"use client";

import { useEffect, useRef, useState } from "react";
import { ACCEPT_ATTR, MAX_PHOTOS_PER_SET } from "@/lib/upload";

export interface Picked {
  id: string;
  file: File;
  url: string;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;

export function isImageFile(f: File) {
  return f.type.startsWith("image/") || IMAGE_EXT.test(f.name);
}

export function toPicked(file: File): Picked {
  return { id: crypto.randomUUID(), file, url: URL.createObjectURL(file) };
}

export function DropZone(props: {
  label: "Before" | "After";
  photos: Picked[];
  onChange: (photos: Picked[]) => void;
  locked?: boolean;
}) {
  const { label, photos, onChange, locked = false } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const full = photos.length >= MAX_PHOTOS_PER_SET;

  function add(files: FileList | File[]) {
    const list = Array.from(files);
    const images = list.filter(isImageFile);
    const room = MAX_PHOTOS_PER_SET - photos.length;
    const taken = images.slice(0, room);
    const msgs: string[] = [];
    if (images.length < list.length) msgs.push("Non-image files were ignored.");
    if (images.length > room) msgs.push(`Only ${MAX_PHOTOS_PER_SET} photos per side.`);
    setNotice(msgs.length ? msgs.join(" ") : null);
    if (taken.length > 0) onChange([...photos, ...taken.map(toPicked)]);
  }

  function remove(id: string) {
    const p = photos.find((x) => x.id === id);
    if (p) URL.revokeObjectURL(p.url);
    setNotice(null);
    onChange(photos.filter((x) => x.id !== id));
  }

  return (
    <div
      aria-label={`${label} photos`}
      className={`flex min-h-[280px] flex-col gap-4 p-6 transition-[background-color,opacity] duration-150 ${
        over ? "bg-soft" : "bg-surface"
      } ${locked ? "opacity-60" : ""}`}
      onDragOver={(e) => {
        if (locked || full) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!locked && !full) add(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-card">{label}</h2>
        <span aria-live="polite" className="bg-bg px-[10px] py-1 font-mono text-label tracking-label">
          {photos.length} of {MAX_PHOTOS_PER_SET}
        </span>
      </div>

      {photos.length > 0 && (
        <ul className="m-0 grid list-none grid-cols-3 gap-2 p-0">
          {photos.map((p, i) => (
            <Thumbnail key={p.id} picked={p} index={i + 1} side={label} locked={locked} onRemove={() => remove(p.id)} />
          ))}
        </ul>
      )}

      {!locked && !full && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-auto flex min-h-tap items-center justify-start gap-2 border border-divider bg-transparent px-4 text-left text-hint font-extrabold text-ink transition-colors duration-150 hover:border-muted hover:bg-soft"
        >
          + Drop photos or choose files
        </button>
      )}
      {!locked && full && <span className="mt-auto text-hint text-muted">Limit reached. Remove one to replace it.</span>}
      {notice && !locked && <p className="m-0 text-hint text-muted">{notice}</p>}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) add(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function Thumbnail(props: { picked: Picked; index: number; side: string; locked: boolean; onRemove: () => void }) {
  const { picked, index, side, locked, onRemove } = props;
  // Most browsers cannot render HEIC, so fall back to a labelled tile.
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [picked.url]);
  const ext = picked.file.name.split(".").pop()?.toUpperCase();

  return (
    <li className="relative aspect-square overflow-hidden bg-soft">
      {broken ? (
        <div className="flex h-full flex-col items-center justify-center p-2 text-center font-mono text-tiny break-all text-muted" title={picked.file.name}>
          <strong className="text-label text-ink">{ext}</strong>
          {picked.file.name}
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
        <img src={picked.url} alt={`${side} photo ${index}`} className="block h-full w-full object-cover" onError={() => setBroken(true)} />
      )}
      <span className="absolute bottom-0 left-0 bg-soft px-[6px] py-[2px] font-mono text-tiny tracking-label text-ink">photo {index}</span>
      {!locked && (
        <button
          type="button"
          aria-label={`Remove ${side} photo ${index}`}
          onClick={onRemove}
          className="absolute top-0 right-0 grid h-tap w-tap place-items-center border-0 bg-white/90 font-mono text-[18px] text-ink transition-colors duration-150 hover:bg-soft"
        >
          ×
        </button>
      )}
    </li>
  );
}
