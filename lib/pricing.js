/**
 * DeepSeek spend estimate in CNY, mirroring the price book and peak/off-peak
 * rule used by `@linxin666/dsh-usage`, so a cost shown here matches the entry
 * that plugin writes to its own ledger for the same call.
 *
 * Prices are CNY per million tokens. Peak windows are Beijing weekday
 * 09:00-12:00 and 14:00-18:00; everything else bills off-peak at half price.
 * @module dsh-session-usage/pricing
 */
import { CHINESE_PUBLIC_HOLIDAYS, HOLIDAY_TABLE_LAST_YEAR } from './holidays.js'

/** The published peak windows. */
const PEAK_WINDOWS = [
  { from: 9 * 60, to: 12 * 60 },
  { from: 14 * 60, to: 18 * 60 },
]

/** Beijing is UTC+8 year-round, so a fixed shift is exact. */
const BEIJING_UTC_OFFSET_MS = 8 * 3_600_000

/** deepseek-flash price row (CNY per million tokens). */
const FLASH_PRICE = {
  cacheHit: { offPeak: 0.02, peak: 0.04 },
  inputMiss: { offPeak: 1.0, peak: 2.0 },
  output: { offPeak: 4.0, peak: 8.0 },
}

/** deepseek-v4-pro price row, retired into the flash row below. */
const PRO_PRICE = {
  cacheHit: { offPeak: 0.15, peak: 0.3 },
  inputMiss: { offPeak: 4.5, peak: 9.0 },
  output: { offPeak: 13.5, peak: 27.0 },
}

/** The instant v4-pro requests start billing the flash row: 2026-09-14 12:00 Beijing. */
const V4_PRO_FOLDED_INTO_FLASH_AT_MS = Date.UTC(2026, 8, 14, 4, 0)

/** Beijing-time `YYYY-MM-DD` of `ms`. */
function beijingDate(ms) {
  const shifted = new Date(ms + BEIJING_UTC_OFFSET_MS)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return shifted.getUTCFullYear() + '-' + month + '-' + day
}

/** Whether `ms` falls on a peak-eligible Beijing day (Mon-Fri, not a public holiday). */
function isPeakDay(ms) {
  const shifted = new Date(ms + BEIJING_UTC_OFFSET_MS)
  const weekday = shifted.getUTCDay()
  if (weekday < 1 || weekday > 5) return false
  const year = String(shifted.getUTCFullYear())
  if (Number(year) > HOLIDAY_TABLE_LAST_YEAR) return true
  const dates = CHINESE_PUBLIC_HOLIDAYS[year]
  return !(dates && dates.indexOf(beijingDate(ms)) >= 0)
}

/** Whether `ms` bills at the peak rate. */
export function isPeakAt(ms) {
  if (!isPeakDay(ms)) return false
  const shifted = new Date(ms + BEIJING_UTC_OFFSET_MS)
  const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return PEAK_WINDOWS.some((window) => minuteOfDay >= window.from && minuteOfDay < window.to)
}

/** The price row for a model id at `atMs`; unknown ids take the flash row. */
function priceFor(model, atMs) {
  const proPriced = String(model || '').includes('v4-pro') && atMs < V4_PRO_FOLDED_INTO_FLASH_AT_MS
  return proPriced ? PRO_PRICE : FLASH_PRICE
}

/**
 * Estimate one assistant call's spend in CNY.
 * @param {string} model model id recorded on the message
 * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number}} usage token counts
 * @param {number} atMs call time in epoch milliseconds
 * @returns {number} CNY, rounded to micro-CNY
 */
export function deepseekSpendCny(model, usage, atMs) {
  const price = priceFor(model, atMs)
  const column = isPeakAt(atMs) ? 'peak' : 'offPeak'
  const cacheRead = Number(usage.cacheReadTokens) || 0
  const input = (Number(usage.inputTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
  const output = Number(usage.outputTokens) || 0
  const spend = (cacheRead * price.cacheHit[column] + input * price.inputMiss[column] + output * price.output[column]) / 1_000_000
  return Math.round(spend * 1e6) / 1e6
}
