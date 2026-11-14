import { describe, expect, it } from "vitest";
import { formatDuration, formatFull, formatWhen, parseTimestamp } from "./time";

const now = Temporal.PlainDateTime.from("2026-11-14T16:30:00");

describe("dashboard times", () => {
  it("formats durations with the two largest units", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(12 * 60 + 59)).toBe("12 min");
    expect(formatDuration(3600 + 5 * 60 + 9)).toBe("1 h 05 min");
    expect(formatDuration(2 * 86400 + 3 * 3600 + 59)).toBe("2 d 3 h");
    expect(formatDuration(undefined)).toBe("-");
    expect(formatDuration(Number.NaN)).toBe("-");
  });

  it("shows today's times as a time of day, and older ones with a date", () => {
    expect(formatWhen("2026-11-14T15:02:45", now)).toBe("15:02");
    expect(formatWhen("2026-11-13 09:05:01.215178", now)).toBe("13 Nov 09:05");
    expect(formatWhen("2025-11-14T15:02:45", now)).toBe("2025-11-14");
    expect(formatWhen("not a time", now)).toBe("not a time");
  });

  it("reads the API's timestamps, with a space or fractions", () => {
    expect(parseTimestamp("2026-11-14 14:44:09.215178")?.second).toBe(9);
    expect(formatFull("2026-11-14T15:02:45.5")).toBe("2026-11-14 15:02:45");
  });
});
