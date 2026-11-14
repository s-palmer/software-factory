import { useState } from "react";
import type { Artifact } from "../../../shared/api";
import { pairScreenshots } from "../../../shared/evidence";
import { verifyAttrs } from "../../verify/core/contract";

export interface BeforeAfterProps {
  artifacts: Artifact[];
  /** Removes a screenshot from the task. */
  onRemove: (id: string) => Promise<void> | void;
  /** Puts an image on the clipboard. Default: the browser clipboard, as a PNG. */
  copyImage?: (url: string) => Promise<void>;
}

/** Copies a PNG to the clipboard, so it can be pasted into a GitHub comment, where GitHub uploads it. */
export async function copyImageToClipboard(url: string): Promise<void> {
  const blob = await (await fetch(url)).blob();
  await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
}

/**
 * The browser check's screenshots side by side: one row per acceptance criterion, the merge base on the left and
 * the change on the right. Each picture can be copied (to paste into a pull request) or removed.
 */
export function BeforeAfter({ artifacts, onRemove, copyImage = copyImageToClipboard }: BeforeAfterProps) {
  const rows = pairScreenshots(artifacts);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function copy(a: Artifact) {
    try {
      await copyImage(a.url);
      setNote({ ok: true, text: "Copied. Paste it into the pull request." });
    } catch (err) {
      setNote({ ok: false, text: `Could not copy the image: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const picture = (a: Artifact) => (
    <figure key={a.id} className="evidence__shot" data-artifact-id={a.id}>
      <a href={a.url} target="_blank" rel="noreferrer">
        <img src={a.url} alt={a.label} loading="lazy" />
      </a>
      <figcaption>
        <button type="button" className="evidence__copy" onClick={() => copy(a)}>
          Copy
        </button>
        <button type="button" className="evidence__remove" onClick={() => onRemove(a.id)}>
          Remove
        </button>
      </figcaption>
    </figure>
  );

  return (
    <section className="evidence" {...verifyAttrs({ unit: "BeforeAfter", rows: rows.length, before: rows.filter((r) => r.before.length).length, failed: rows.filter((r) => r.pass === false).length })}>
      <h2>Before and after</h2>
      {rows.length === 0 ? (
        <p className="hint">No browser check screenshots yet.</p>
      ) : (
        <ol className="evidence__rows">
          {rows.map((r) => (
            <li key={r.criterion} className="evidence__row" data-pass={r.pass === null ? "unknown" : String(r.pass)}>
              <p className="evidence__criterion">
                {r.pass !== null && <span className="evidence__verdict">{r.pass ? "Pass" : "Fail"}</span>} {r.criterion}
              </p>
              <div className="evidence__sides">
                <div className="evidence__side" data-side="before">
                  <h3>Before</h3>
                  {r.before.length ? r.before.map(picture) : <p className="hint">No picture of the base.</p>}
                </div>
                <div className="evidence__side" data-side="after">
                  <h3>After</h3>
                  {r.after.length ? r.after.map(picture) : <p className="hint">No picture.</p>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "evidence__note" : "evidence__note error"}>
          {note.text}
        </p>
      )}
    </section>
  );
}
