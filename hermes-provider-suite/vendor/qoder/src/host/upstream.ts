/**
 * The Qoder wire protocol — facade.
 *
 * 2026-10-17 拆分：本文件原 2,335 行按职责拆为 upstream/ 下的 11 个叶模块
 * （docs/issues/22-upstream-split.md）。门面逐名 re-export 现名导出，
 * 下游 12 个测试 + 5 个 probe + 3 个 src importer 一行不改；用逐名
 * re-export 而非 `export *`，删除一个导出时门面必须显式表态（TS 当场报错）。
 *
 * 协议事实的原文注释（COSY 签名头 / 置换字母表 base64 / 双层 SSE）随代码
 * 迁往 upstream/crypto.ts 头部，见该文件。
 *
 * @module dsh-connect-qoder/upstream
 */

export { MACHINE_OS } from './upstream/client-constants.ts'
export { CUSTOM_ALPHABET, STD_ALPHABET, encodeBody } from './upstream/crypto.ts'
export { signaturePath } from './upstream/sign.ts'
export { authHeaders } from './upstream/cosy-sign.ts'
export { openApiHeaders, __dshQoderUmidCacheReset, __dshQoderUmidState, umidRootsFor } from './upstream/headers.ts'
export { modelListUrl, chatUrl, exchangeUrl, userInfoUrl, usageUrl, usagePresentationUrl, campaignsUrl, claimCampaignUrl } from './upstream/endpoints.ts'
export { QUEUE_WAIT_BUDGET_MS, QUEUE_WAIT_MAX_SLEEP_MS, QUEUE_WAIT_MIN_SLEEP_MS, queueWaitFor } from './upstream/retry.ts'
export { streamChat } from './upstream/sse.ts'
export { toQoderMessages, toQoderTools } from './upstream/messages.ts'
export { projectCampaignRows, normalizePromotion, fetchUsage } from './upstream/fetch-usage.ts'
export type { UsageSnapshot } from './upstream/fetch-usage.ts'
export { readCampaigns, claimCampaign, readModelCatalogShape, fetchModels, exchangePat, fetchUserInfo } from './upstream/api-calls.ts'
