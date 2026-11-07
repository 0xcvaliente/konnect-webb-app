/**
 * Working days for the promises Konnected makes ("profile review within 2 working days").
 *
 * A working day is Monday to Friday, without Norwegian public holidays, counted in the
 * Europe/Oslo time zone (konnected-product-rules, team workspace). The moving holidays come from
 * the Easter date, so no list is kept per year. This is the one place that counts working days;
 * tests cover Easter and 17 May.
 *
 * Days are plain `YYYY-MM-DD` strings in Oslo time. Nothing here imports server code.
 */

const TIME_ZONE = 'Europe/Oslo'

/** The calendar day in Oslo for a moment, as `YYYY-MM-DD`. */
export function osloDay(moment: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(moment)
}

/** A day string as a UTC date at noon, so adding days never crosses a daylight-saving edge. */
const toDate = (day: string): Date => new Date(`${day}T12:00:00.000Z`)
const fromDate = (date: Date): string => date.toISOString().slice(0, 10)

export function addDays(day: string, days: number): string {
  const date = toDate(day)
  date.setUTCDate(date.getUTCDate() + days)
  return fromDate(date)
}

/** Easter Sunday (Gregorian calendar), by the anonymous Gregorian algorithm. */
export function easterSunday(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const holidayCache = new Map<number, Set<string>>()

/**
 * Norwegian public holidays in a year: 1 January, Maundy Thursday, Good Friday, Easter Monday,
 * 1 May, 17 May, Ascension Day, Whit Monday, 25 and 26 December. Easter Sunday and Whit Sunday
 * fall on Sundays anyway.
 */
export function norwegianHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year)
  if (cached) return cached
  const easter = easterSunday(year)
  const days = new Set([
    `${year}-01-01`,
    addDays(easter, -3), // Maundy Thursday
    addDays(easter, -2), // Good Friday
    addDays(easter, 1), // Easter Monday
    `${year}-05-01`,
    `${year}-05-17`,
    addDays(easter, 39), // Ascension Day
    addDays(easter, 50), // Whit Monday
    `${year}-12-25`,
    `${year}-12-26`,
  ])
  holidayCache.set(year, days)
  return days
}

export function isWorkingDay(day: string): boolean {
  const weekday = toDate(day).getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  return !norwegianHolidays(Number(day.slice(0, 4))).has(day)
}

/** The day `count` working days after `day` (the day itself does not count). */
export function addWorkingDays(day: string, count: number): string {
  let current = day
  let left = count
  while (left > 0) {
    current = addDays(current, 1)
    if (isWorkingDay(current)) left -= 1
  }
  return current
}

/**
 * Working days from `from` to `to`: how many working days come after `from` up to and including
 * `to`. Negative when `to` is before `from`.
 */
export function workingDaysBetween(from: string, to: string): number {
  if (from === to) return 0
  const sign = to > from ? 1 : -1
  let count = 0
  let current = from
  while (current !== to) {
    current = addDays(current, sign)
    if (isWorkingDay(current)) count += sign
  }
  return count
}

/** Whole calendar days in Oslo between two moments (0 on the same day). */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = toDate(osloDay(from)).getTime()
  const b = toDate(osloDay(to)).getTime()
  return Math.round((b - a) / 86_400_000)
}

export type PromiseState = {
  /** The last day the promise is kept on, in Oslo. */
  dueDay: string
  /** Working days left until the due day; 0 on the due day; negative when late. */
  left: number
  /** ok: 2 or more working days left; soon: due today or tomorrow; late: past the due day. */
  tone: 'ok' | 'soon' | 'late'
}

/**
 * Where a "within N working days" promise stands. The clock starts on the day of `start`; the
 * promise is kept until the end of the N-th working day after it.
 */
export function promiseState(start: Date, limit: number, now: Date = new Date()): PromiseState {
  const dueDay = addWorkingDays(osloDay(start), limit)
  const today = osloDay(now)
  // Late counts working days past the due day, and at least one once the due day has passed.
  const left =
    today <= dueDay
      ? workingDaysBetween(today, dueDay)
      : -Math.max(1, workingDaysBetween(dueDay, today))
  return { dueDay, left, tone: left < 0 ? 'late' : left <= 1 ? 'soon' : 'ok' }
}

/**
 * Where a fixed due day stands today: working days left (0 on the day, negative when late, at
 * least one late working day once it has passed). The same tones as promiseState.
 */
export function countdownTo(dueDay: string, now: Date = new Date()): PromiseState {
  const today = osloDay(now)
  const left =
    today <= dueDay
      ? workingDaysBetween(today, dueDay)
      : -Math.max(1, workingDaysBetween(dueDay, today))
  return { dueDay, left, tone: left < 0 ? 'late' : left <= 1 ? 'soon' : 'ok' }
}
