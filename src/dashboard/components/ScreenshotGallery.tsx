import { useState } from "react";
import type { Artifact } from "../../../shared/api";
import { verifyAttrs } from "../../verify/core/contract";

export interface ScreenshotGalleryProps {
  artifacts: Artifact[];
  /** Initially selected screenshot. Selection is then owned by the gallery and reported via onSelect. */
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
}

export function ScreenshotGallery({ artifacts, selectedId = null, onSelect }: ScreenshotGalleryProps) {
  const shots = artifacts.filter((a) => a.kind === "screenshot");
  const [selected, setSelected] = useState<string | null>(selectedId);
  const current = shots.find((s) => s.id === selected) ?? null;

  function toggle(id: string) {
    const next = id === selected ? null : id;
    setSelected(next);
    onSelect?.(next);
  }

  return (
    <section className="gallery" {...verifyAttrs({ unit: "ScreenshotGallery", count: shots.length, selected: current?.id ?? "" })}>
      <h2>Screenshots ({shots.length})</h2>
      {shots.length === 0 ? (
        <p className="empty">No screenshots yet. The browser verifier adds them.</p>
      ) : (
        <>
          {current && (
            <figure className="gallery__preview">
              <img src={current.url} alt={current.label || current.path} />
              <figcaption>{current.label || current.path}</figcaption>
            </figure>
          )}
          <ul className="gallery__grid">
            {shots.map((s) => (
              <li key={s.id}>
                <button type="button" className="gallery__thumb" aria-pressed={s.id === current?.id} data-artifact-id={s.id} onClick={() => toggle(s.id)}>
                  <img src={s.url} alt={s.label || s.path} loading="lazy" />
                  <span>{s.label || s.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
