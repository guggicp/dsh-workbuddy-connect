/**
 * The retry policy this plugin hands the host for every region route.
 *
 * The host runs its own retry loop on top of a provider failure
 * (`@deepseek-ai/dsh-llm-retry`, composed unconditionally by
 * `@deepseek-ai/dsh-base`). Until docs/issues/24 this route took the host
 * defaults, `RATE_LIMIT` and `SERVER` included — and those retries were useless
 * at best, expensive at worst, because by the time the host sees a failure from
 * this route it is one of:
 *
 *   - a queue wait this plugin already drained — `QUEUE_WAIT_BUDGET_MS`
 *     (`upstream/retry.ts`) spends 120 s and the shim then answers
 *     `503 rate_limit`; a host retry restarts that same budget, up to
 *     `maxRetries` more times (worst case ~12 min of "retrying" for one
 *     request);
 *   - a terminal verdict that asking again cannot change — protocol shape
 *     drift ("this plugin needs an update"), a first-frame sign-in expiry, an
 *     upstream rejection. All three leave the shim as `502 upstream_error`,
 *     which the host reads as `SERVER` and retried five times before the user
 *     saw the message that said there was nothing to wait for.
 *
 * The plugin's own ladder is the layer that understands Qoder: it knows the
 * queue markers, it honours `retryAfterSeconds`, and it is the one that can be
 * corrected from here. So it stays the ONLY retry source for this route, and
 * what stays retryable for the host is what happens *along* the loopback hop,
 * which this plugin never sees and therefore cannot retry itself: an empty
 * provider response, a stream idle past `streamIdleTimeoutMs`, and a transport
 * failure between host and shim.
 *
 * `maxRetries` and `backoff` are deliberately NOT set: the host owns its budget
 * and its delays, and narrowing the SET is the only decision that is ours.
 *
 * The cost, recorded in docs/issues/24 §3: a transport failure between plugin
 * and upstream leaves as the same `503 rate_limit` as a spent queue budget, so
 * it loses the host's safety net along with it. Splitting those two exits
 * (so the host could keep retrying only the network one) is a separate change
 * about status codes, not a reason to widen this set again.
 *
 * No type annotation from the peer: `types/dsh-peer-modules.d.ts` declares the
 * host modules bare, so there is no shape for tsc to check here. The shape is
 * pinned where it can be — `probe/host-retry-classification-probe.mjs` resolves
 * this exact object with the installed host's own `resolveRetryPolicy` and
 * asserts the resulting set, and `test/route-retry-policy.test.js` pins the
 * literal against an accidental widening.
 */
export const ROUTE_RETRY_POLICY = {
  mode: 'normal' as const,
  retryableCodes: ['EMPTY_RESPONSE', 'TIMEOUT', 'TRANSPORT'],
}
