export type RecordingTime = {
  effectiveStartAt: string
  provenance: 'embedded_metadata' | 'manual_override'
  embeddedStartAt?: string
  embeddedField?: 'mvhd_creation_time'
}

export type LocalTimeCandidate = { instant: number; iso: string; offsetMinutes: number }

const partsFormatters = new Map<string, Intl.DateTimeFormat>()
const displayFormatters = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string) {
  let formatter = partsFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
    partsFormatters.set(timeZone, formatter)
  }
  return formatter
}

function displayFormatter(timeZone: string) {
  let formatter = displayFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23',
    })
    displayFormatters.set(timeZone, formatter)
  }
  return formatter
}

function dateTimeParts(epochMs: number, timeZone: string) {
  const parts = partsFormatter(timeZone).formatToParts(new Date(epochMs))
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
}

function offsetMinutesAt(epochMs: number, timeZone: string): number {
  const parts = dateTimeParts(epochMs, timeZone)
  const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((representedAsUtc - epochMs) / 60_000)
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}

export function localDateTimeCandidates(localDateTime: string, timeZone: string): LocalTimeCandidate[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localDateTime)
  if (!match) return []
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00'] = match
  const year = Number(yearText), month = Number(monthText), day = Number(dayText), hour = Number(hourText), minute = Number(minuteText), second = Number(secondText)
  const wallClock = new Date(0)
  wallClock.setUTCFullYear(year, month - 1, day)
  wallClock.setUTCHours(hour, minute, second, 0)
  const wallClockMs = wallClock.getTime()
  if (wallClock.getUTCFullYear() !== year || wallClock.getUTCMonth() + 1 !== month || wallClock.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return []

  const offsets = new Set<number>()
  for (let hours = -48; hours <= 48; hours += 6) offsets.add(offsetMinutesAt(wallClockMs + hours * 3_600_000, timeZone))
  const candidates = new Map<number, LocalTimeCandidate>()
  for (const offsetMinutes of offsets) {
    const instant = wallClockMs - offsetMinutes * 60_000
    const actual = dateTimeParts(instant, timeZone)
    if (actual.year !== year || actual.month !== month || actual.day !== day || actual.hour !== hour || actual.minute !== minute || actual.second !== second) continue
    const actualOffset = offsetMinutesAt(instant, timeZone)
    candidates.set(instant, { instant, iso: `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${formatOffset(actualOffset)}`, offsetMinutes: actualOffset })
  }
  return [...candidates.values()].sort((a, b) => a.instant - b.instant)
}

export function formatVideoDateTime(recordingTime: RecordingTime | null | undefined, sourceTimeMs = 0, timeZone = 'Asia/Jerusalem'): string | null {
  if (!recordingTime?.effectiveStartAt || !Number.isFinite(sourceTimeMs)) return null
  const origin = Date.parse(recordingTime.effectiveStartAt)
  if (!Number.isFinite(origin)) return null
  return displayFormatter(timeZone).format(new Date(origin + sourceTimeMs))
}

export function formatVideoPosition(sourceTimeMs: number): string {
  if (!Number.isFinite(sourceTimeMs) || sourceTimeMs < 0) return '00:00.000'
  const minutes = Math.floor(sourceTimeMs / 60_000)
  const seconds = (sourceTimeMs % 60_000) / 1000
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(3).padStart(6, '0')}`
}

export function localDateTimeInput(timestamp: string | undefined, timeZone: string): string {
  if (!timestamp) return ''
  const instant = Date.parse(timestamp)
  if (!Number.isFinite(instant)) return ''
  const parts = dateTimeParts(instant, timeZone)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`
}

export function videoTimeExportFields(recordingTime: RecordingTime | null | undefined, sourceTimeMs: number, timeZone = 'Asia/Jerusalem') {
  const origin = recordingTime?.effectiveStartAt ? Date.parse(recordingTime.effectiveStartAt) : Number.NaN
  if (!Number.isFinite(origin) || !Number.isFinite(sourceTimeMs)) return { utc: '', local: '', timeZone: '', provenance: '', originUtc: '', originProvenance: '', originField: '' }
  const instant = origin + sourceTimeMs
  return {
    utc: new Date(instant).toISOString(),
    local: formatWithOffset(instant, timeZone),
    timeZone,
    provenance: recordingTime?.provenance ?? '',
    originUtc: recordingTime?.effectiveStartAt ? new Date(origin).toISOString() : '',
    originProvenance: recordingTime?.provenance ?? '',
    originField: recordingTime?.embeddedField ?? '',
  }
}

function formatWithOffset(epochMs: number, timeZone: string): string {
  const parts = dateTimeParts(epochMs, timeZone)
  const milliseconds = String(new Date(epochMs).getUTCMilliseconds()).padStart(3, '0')
  const local = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}.${milliseconds}`
  return `${local}${formatOffset(offsetMinutesAt(epochMs, timeZone))}`
}
