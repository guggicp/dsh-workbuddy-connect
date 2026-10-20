/**
 * Parse a reset TIME out of an upstream failure message, when the upstream stated
 * one.
 *
 * 参考：`dsh-connect-workbuddy` 的 `src/probe.ts`（`parseUpstreamResetAt`）。
 *   该实现在 WorkBuddy 上是实测出来的（其网关的 429 正文里带一句「将在 … 重置」
 *   与一句英文 `will reset at …`），本文件把同一套解析规则搬过来，并把「偏移量
 *   必须显式」这条硬约束原样保留。
 * 改动：诚实标注**证据状态**。Trae 目前被记录在案的限流/配额文案里**没有任何一条
 *   带时间**：
 *
 *   - `4011` → `We're sorry, your requests have exceeded the rate limit.
 *     Please wait and try again later.`（docs/ISSUE33_DIAGNOSIS.md:30，实测原文）
 *   - `4008` → `Your requests have exceeded the quota.`（同文档:55，实测原文）
 *
 *   所以本函数在 Trae 上大概率永远返回 `undefined`，而**这正是它应有的行为**：
 *   没有给出的时间不能变成插件自己编的倒计时（池会退回
 *   `POOL_UNKNOWN_COOLDOWN_MS` 的 30 分钟兜底并在卡片上如实显示「上游未给出
 *   何时恢复」）。它存在的理由只有一个：Trae 的中文网关将来若在正文里写了时间
 *   （与 WorkBuddy 中文网关同一族文案），不要把一个真实存在的时间当没有解析出来
 *   丢掉 —— 参考实现里那是一条实测的 bug（英文正文解析不到 → 账号比上游要求的
 *   早 ~18 小时回到池里，再花一次请求重新撞上同一个限制）。
 *
 * NEVER use it for a credit PACK's `endTimeMs`: that is when a balance STOPS
 * being usable, not when a new allowance ARRIVES. Attaching it as a retry time
 * would put an exhausted account back into rotation at the exact moment its
 * credit disappears.
 *
 * @module dsh-connect-trae/reset-time
 */

/**
 * The timestamp shape both spellings share: `YYYY-MM-DD HH:MM:SS` followed by an
 * EXPLICIT UTC offset.
 *
 * The offset is required, not optional. `2026-09-30 02:30:30` with no zone is a
 * moment the plugin would have to guess at, and `Date.parse` guesses LOCAL time —
 * right on a UTC+8 machine by accident, silently wrong everywhere else. A message
 * that names a time without a zone therefore yields no time, which is the honest
 * answer.
 */
const RESET_STAMP = '(\\d{4})-(\\d{2})-(\\d{2})\\s+(\\d{2}):(\\d{2}):(\\d{2})\\s*UTC\\s*([+-])(\\d{1,2})(?::?(\\d{2}))?'

/** Chinese spelling: the marker sits AFTER the timestamp (将在 … 重置). */
const UPSTREAM_RESET_PATTERN_ZH = new RegExp(`将在?\\s*${RESET_STAMP}[\\s\\S]*?重置`, 'u')

/**
 * English spelling: the marker sits BEFORE the timestamp (`reset at` /
 * `refresh on`). It needs its own pattern because the two languages put the
 * keyword on different sides of the time, so loosening the surrounding prose
 * alone cannot cover both.
 */
const UPSTREAM_RESET_PATTERN_EN
  = new RegExp(`(?:reset|resets|refresh|refreshes|renew|renews)\\s+(?:at|on)\\s+${RESET_STAMP}`, 'iu')

/**
 * Parse the reset time out of an upstream failure message.
 *
 * Returns epoch ms, or undefined when the message names no parsable time — the
 * caller must then say "the upstream gave no time", never invent one.
 *
 * THE OFFSET IS HONOURED, NOT ASSUMED. `2026-09-30 02:30:30 UTC+8` is 18:30:30 UTC
 * the previous day, so the components are assembled with `Date.UTC` and the stated
 * offset subtracted — correct on every host regardless of its own zone.
 *
 * A whole-second resolution is what the upstream prints; sub-second precision would
 * be fiction in the other direction.
 */
export function parseUpstreamResetAt(message: string): number | undefined {
  const match = UPSTREAM_RESET_PATTERN_ZH.exec(message)
    ?? UPSTREAM_RESET_PATTERN_EN.exec(message)
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = match
  const offsetTotalMinutes
    = (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes ?? '0'))
  const utcMs = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  )
  // `Date.UTC` normalizes overflow (month 13, day 32) instead of failing, so a
  // nonsense timestamp would silently become a real-but-wrong moment. Reject it.
  const parsed = new Date(utcMs)
  if (parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() !== Number(month) - 1
    || parsed.getUTCDate() !== Number(day)
    || parsed.getUTCHours() !== Number(hour)
    || parsed.getUTCMinutes() !== Number(minute)
    || parsed.getUTCSeconds() !== Number(second)) {
    return undefined
  }
  if (Math.abs(offsetTotalMinutes) > 14 * 60) return undefined
  return utcMs - offsetTotalMinutes * 60_000
}
