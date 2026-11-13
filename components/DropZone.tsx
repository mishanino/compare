"use client";

import { useEffect, useRef, useState } from "react";
import { ACCEPT_ATTR, MAX_PHOTOS_PER_SET } from "@/lib/upload";

export interface Picked {
  id: string;
  file: File;
  url: string;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;

function isImage(f: File) {
  return f.type.startsWith("image/") || IMAGE_EXT.test(f.name);
}

export function DropZone(props: {
  title: string;
  photos: Picked[];
  onChange: (photos: Picked[]) => void;
}) {
  const { title, photos, onChange } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const full = photos.length >= MAX_PHOTOS_PER_SET;

  function add(files: FileList | File[]) {
    const list = Array.from(files);
    const images = list.filter(isImage);
    const room = MAX_PHOTOS_PER_SET - photos.length;
    const taken = images.slice(0, room);
    const msgs: string[] = [];
    if (images.length < list.length) msgs.push("Non-image files were ignored.");
    if (images.length > room) msgs.push(`Only ${MAX_PHOTOS_PER_SET} photos per set.`);
    setNotice(msgs.length ? msgs.join(" ") : null);
    if (taken.length === 0) return;
    onChange([
      ...photos,
      ...taken.map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) })),
    ]);
  }

  function remove(id: string) {
    const p = photos.find((x) => x.id === id);
    if (p) URL.revokeObjectURL(p.url);
    setNotice(null);
    onChange(photos.filter((x) => x.id !== id));
  }

  return (
    <section className="zone-wrap">
      <h2>
        {title} <span className="count">{photos.length}/{MAX_PHOTOS_PER_SET}</span>
      </h2>
      <div
        className={`zone${over ? " over" : ""}${full ? " full" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={`Add ${title} photos`}
        onClick={() => !full && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !full) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!full) add(e.dataTransfer.files);
        }}
      >
        {photos.length === 0 ? (
          <p className="hint">Drop up to {MAX_PHOTOS_PER_SET} photos here, or click to choose</p>
        ) : (
          <ul className="thumbs">
            {photos.map((p, i) => (
              <li key={p.id} className="thumb">
                <Thumb picked={p} />
                <span className="idx">{i + 1}</span>
                <button
                  type="button"
                  className="remove"
                  aria-label={`Remove ${p.file.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(p.id);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
            {!full && <li className="thumb add">+</li>}
          </ul>
        )}
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
      {notice && <p className="notice">{notice}</p>}
    </section>
  );
}

/** Most browsers cannot render HEIC, so fall back to a labelled tile. */
function Thumb({ picked }: { picked: Picked }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [picked.url]);
  if (broken) {
    return (
      <div className="noprev" title={picked.file.name}>
        <strong>{picked.file.name.split(".").pop()?.toUpperCase()}</strong>
        <span>{picked.file.name}</span>
      </div>
    );
  }
  return <img src={picked.url} alt={picked.file.name} onError={() => setBroken(true)} />;
}
