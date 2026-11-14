/**
 * Times and durations for the dashboard, with Temporal. The API sends the database's local timestamps without a
 * zone ("2026-11-14T15:02:45", sometimes with a space and fractions), so they are plain date-times, compared with
 * the plain date-time now.
 */

/** A timestamp from the API, or null when it does not parse. */
export function parseTimestamp(ts: string): Temporal.PlainDateTime | null {
  try {
    return Temporal.PlainDateTime.from(ts.trim().replace(" ", "T"));
  } catch {
    return null;
  }
}

const two = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "15:02" today, "14 Nov 15:02" this year, "2025-11-14" before that. Unparseable text comes back as it is. */
export function formatWhen(ts: string, now: Temporal.PlainDateTime = Temporal.Now.plainDateTimeISO()): string {
  const t = parseTimestamp(ts);
  if (!t) return ts;
  const time = `${two(t.hour)}:${two(t.minute)}`;
  if (t.toPlainDate().equals(now.toPlainDate())) return time;
  if (t.year === now.year) return `${t.day} ${MONTHS[t.month - 1]} ${time}`;
  return t.toPlainDate().toString();
}

/** The full timestamp, for a tooltip: "2026-11-14 15:02:45". */
export function formatFull(ts: string): string {
  const t = parseTimestamp(ts);
  return t ? t.toString({ smallestUnit: "second" }).replace("T", " ") : ts;
}

/** 45 s, 12 min, 1 h 05 min, 2 d 3 h: the two largest units, rounded down. "-" when unknown. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "-";
  const d = Temporal.Duration.from({ seconds: Math.floor(seconds) }).round({ largestUnit: "day", smallestUnit: "second" });
  if (d.days > 0) return `${d.days} d ${d.hours} h`;
  if (d.hours > 0) return `${d.hours} h ${two(d.minutes)} min`;
  if (d.minutes > 0) return `${d.minutes} min`;
  return `${d.seconds} s`;
}
