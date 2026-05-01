// Quiet-hours + timestamp helpers.

/**
 * Return the hour-of-day (0-23) in the requested IANA tz. Falls back to the
 * runtime default zone if Intl can't resolve `tz` (extremely rare; the test
 * harness covers this).
 */
export function hourInZone(tz: string, now: Date = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(now);
    const hour = parts.find((p) => p.type === "hour");
    return hour ? parseInt(hour.value, 10) : now.getHours();
  } catch {
    return now.getHours();
  }
}

/**
 * True when `hour` falls inside the [start, end) window expressed in 24h.
 * Wraps around midnight when end < start (e.g. 23 → 8 means 23:00–08:00).
 */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  // Wrap window (e.g. 23 → 8): match late-night OR early-morning.
  return hour >= start || hour < end;
}

export function isQuietHoursNow(
  config: { quietHoursStart: number; quietHoursEnd: number; quietHoursTimezone: string },
  now: Date = new Date(),
): boolean {
  const h = hourInZone(config.quietHoursTimezone, now);
  return isQuietHour(h, config.quietHoursStart, config.quietHoursEnd);
}

export function todayYmd(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
