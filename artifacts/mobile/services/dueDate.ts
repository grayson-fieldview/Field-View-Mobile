/**
 * Client-side due-date bucketing + formatting for the Tasks UI.
 *
 * All comparisons are by LOCAL calendar day. A task with no dueDate is
 * bucket "none" and must NEVER fall into today / week / past — it only
 * appears under the "All" filter. "This Week" runs from today through the
 * end of the current calendar week (Saturday), inclusive of today, so
 * Today ⊂ This Week.
 */

export type DueBucket = "past" | "today" | "week" | "future" | "none";

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Parse a wire dueDate into a local Date. Handles both date-only
 * ("YYYY-MM-DD") and full ISO datetimes. Date-only is intentionally
 * parsed in LOCAL time (not UTC) so "due today" matches the user's day.
 */
export function parseDueDate(dueDate?: string | null): Date | null {
  if (!dueDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueDate);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const d = new Date(dueDate);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** End of the current calendar week (Saturday), at start-of-day. */
function endOfWeek(today: Date): Date {
  const eow = new Date(today);
  eow.setDate(today.getDate() + (6 - today.getDay())); // 0=Sun .. 6=Sat
  return eow;
}

export function dueBucketOf(
  dueDate: string | null | undefined,
  now: Date = new Date(),
): DueBucket {
  const due = parseDueDate(dueDate);
  if (!due) return "none";
  const today = startOfDay(now);
  const dueDay = startOfDay(due);
  if (dueDay.getTime() < today.getTime()) return "past";
  if (dueDay.getTime() === today.getTime()) return "today";
  if (dueDay.getTime() <= endOfWeek(today).getTime()) return "week";
  return "future";
}

export type DueFilter = "all" | "today" | "week" | "past";

/**
 * Does a task's dueDate satisfy the active due filter? "week" is
 * inclusive of today (Today ⊂ This Week). "all" matches everything,
 * including null-dated tasks.
 */
export function matchesDueFilter(
  dueDate: string | null | undefined,
  filter: DueFilter,
  now: Date = new Date(),
): boolean {
  if (filter === "all") return true;
  const bucket = dueBucketOf(dueDate, now);
  if (filter === "today") return bucket === "today";
  if (filter === "past") return bucket === "past";
  // "week": today through end of week.
  return bucket === "today" || bucket === "week";
}

/** Format a wire dueDate for compact display on a task row. */
export function formatDueLabel(
  dueDate: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const due = parseDueDate(dueDate);
  if (!due) return null;
  const today = startOfDay(now);
  const dueDay = startOfDay(due);
  const diffDays = Math.round(
    (dueDay.getTime() - today.getTime()) / 86_400_000,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  const sameYear = dueDay.getFullYear() === today.getFullYear();
  return dueDay.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Local YYYY-MM-DD string for a Date (date-only wire format). */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type DuePreset = { key: string; label: string; value: string | null };

/** Quick-pick presets for the create-task due-date field (no native picker). */
export function buildDuePresets(now: Date = new Date()): DuePreset[] {
  const today = startOfDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const eow = endOfWeek(today);
  const nextWeek = new Date(today);
  nextWeek.setDate(today.getDate() + 7);
  return [
    { key: "none", label: "None", value: null },
    { key: "today", label: "Today", value: toISODate(today) },
    { key: "tomorrow", label: "Tomorrow", value: toISODate(tomorrow) },
    { key: "eow", label: "End of week", value: toISODate(eow) },
    { key: "plus7", label: "+1 week", value: toISODate(nextWeek) },
  ];
}
