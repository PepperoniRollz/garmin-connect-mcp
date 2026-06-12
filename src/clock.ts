/**
 * Timezone-aware "today". The process runs in UTC inside the container, so
 * Date#getDate() would roll the calendar day over at 00:00 UTC (e.g. an
 * 11pm America/New_York log would land on the next day). Resolving "today"
 * through a configured IANA zone fixes that. Entry points call
 * configureTimezone() at startup; tools call todayDateString().
 */
let timezone = 'UTC';

export function configureTimezone(tz: string): void {
  timezone = tz;
}

/** The current calendar day as YYYY-MM-DD in the configured timezone. */
export function todayDateString(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** True if `tz` is a valid IANA timezone the runtime accepts. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', {timeZone: tz});
    return true;
  } catch {
    return false;
  }
}
