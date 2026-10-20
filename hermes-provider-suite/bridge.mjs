import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { createWorkBuddyShim } from "./vendor/workbuddy/src/shim.ts";
import { atRestKeyProviderFor } from "./vendor/workbuddy/src/desktop-credential-protection.ts";
import { WorkBuddyCredentialStore } from "./vendor/workbuddy/src/auth.ts";
import { CN_VARIANT, AI_VARIANT } from "./vendor/workbuddy/src/variants.ts";
import { WorkBuddyUpstreamClient } from "./vendor/workbuddy/src/upstream.ts";
import { WorkBuddyCatalog, FALLBACK_WORKBUDDY_MODELS, FALLBACK_WORKBUDDY_AI_MODELS } from "./vendor/workbuddy/src/catalog.ts";
import { createTraeShim } from "./vendor/trae/src/shim.ts";
import { TraeUsageClient } from "./vendor/trae/src/usage.ts";
import { TraeCredentialStore } from "./vendor/trae/src/auth.ts";
import { traeStorageCandidates } from "./vendor/trae/src/paths.ts";
import { regionOfEdition } from "./vendor/trae/src/region.ts";
import { resolveTraeIdentity } from "./vendor/trae/src/identity.ts";
import { refreshTraeCredential } from "./vendor/trae/src/refresh.ts";
import { TraeSoloUpstreamClient } from "./vendor/trae/src/solo.ts";
import { TraeSoloBridge } from "./vendor/trae/src/solo-bridge.ts";
import { TraeSoloRemoteCatalogClient } from "./vendor/trae/src/solo-remote.ts";
import { TraeCatalog, mergeTraeModelSources, fallbackModelsFor } from "./vendor/trae/src/catalog.ts";
import { REGIONS, appDataRootFor, loadCredentialAsync, isCredentialUsable } from "./vendor/qoder/src/host/credentials.ts";
import { fetchUsage as fetchQoderUsage } from "./vendor/qoder/src/host/upstream/fetch-usage.ts";
import { readCampaigns, claimCampaign } from "./vendor/qoder/src/host/upstream/api-calls.ts";
import { checkinStateFrom, claimableCampaignOf, normalizeClaimResult } from "./vendor/qoder/src/host/claim.ts";
import { fetchModels as fetchQoderModels } from "./vendor/qoder/src/host/upstream/api-calls.ts";
import { normalizeEntry } from "./vendor/qoder/src/host/catalog-entry.ts";
import { rateNow as qoderRateNow } from "./vendor/qoder/src/host/offpeak.ts";
import { createQoderShim } from "./vendor/qoder/src/host/shim.ts";

console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.warn = (...args) => console.error(...args);

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const VARIANTS = {
  workbuddy: { engine: "workbuddy", region: "cn", label: "WorkBuddy" },
  "workbuddy-ai": { engine: "workbuddy", region: "global", label: "WorkBuddy AI" },
  trae: { engine: "trae", region: "cn", label: "Trae CN" },
  "trae-ai": { engine: "trae", region: "ai", label: "Trae International" },
  "qoder-cn": { engine: "qoder", region: "qoder-cn", label: "Qoder CN" },
  qoder: { engine: "qoder", region: "qoder", label: "Qoder" },
};

function output(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function workBuddyRate(model) {
  const billing = model.billing || {};
  if (billing.rateUnknown === true) return { rate_unknown: true };
  const match = typeof billing.credits === "string"
    ? billing.credits.trim().match(/^x\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/i)
    : null;
  const multiplier = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(multiplier) ? { multiplier } : { rate_unknown: true };
}

function stateRoot() {
  const configured = process.env.HERMES_DSH_STATE_DIR?.trim();
  const root = configured || join(process.env.HERMES_HOME || join(homedir(), ".hermes"), "data", "dsh-model-providers");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function stateFile(name) {
  return join(stateRoot(), name);
}

function variantFor(name) {
  const item = VARIANTS[name];
  if (!item) throw new Error("unknown provider");
  return item;
}

function workbuddyRuntime(region) {
  const variant = region === "global" ? AI_VARIANT : CN_VARIANT;
  const client = new WorkBuddyUpstreamClient();
  const store = new WorkBuddyCredentialStore({
    variant,
    keyProvider: atRestKeyProviderFor(variant),
    ownPath: stateFile(variant.ownFilename),
    refresh: (credential) => client.refreshToken(credential),
  });
  const catalog = new WorkBuddyCatalog(region === "global" ? FALLBACK_WORKBUDDY_AI_MODELS : FALLBACK_WORKBUDDY_MODELS);
  return { variant, client, store, catalog };
}

function traeRuntime(region) {
  const candidates = traeStorageCandidates().filter((candidate) =>
    candidate.source === "desktop" && regionOfEdition(candidate.edition) === region);
  let store;
  const preferredEdition = region === "ai" ? "sg" : "cn";
  const identity = async () => {
    let hint;
    try { hint = (await store.current())?.edition; } catch {}
    const selected = candidates.filter((candidate) => hint === undefined || candidate.edition === hint);
    return resolveTraeIdentity(selected, hint || preferredEdition);
  };
  store = new TraeCredentialStore({
    region,
    refresh: async (credential) => {
      const selected = candidates.filter((candidate) => candidate.edition === credential.edition);
      const device = await identityFor(selected, credential.edition);
      return refreshTraeCredential(credential, undefined, device);
    },
  });
  const upstream = new TraeSoloUpstreamClient({ credential: () => store.resolve(), identity, log: () => {} });
  const remote = new TraeSoloRemoteCatalogClient({ credential: () => store.resolve() });
  const catalog = new TraeCatalog(region);
  return { candidates, store, identity, upstream, remote, catalog };
}

async function identityFor(candidates, edition) {
  return resolveTraeIdentity(candidates, edition);
}

function qoderRegion(regionId) {
  const region = REGIONS.find((item) => item.id === regionId);
  if (!region) throw new Error("unknown Qoder region");
  return region;
}

async function readCredential(engine, region) {
  if (engine === "workbuddy") {
    const { store } = workbuddyRuntime(region);
    try { return await store.current(); } catch { return undefined; }
  }
  if (engine === "trae") {
    const { store } = traeRuntime(region);
    try { return await store.current(); } catch { return undefined; }
  }
  const credential = await loadCredentialAsync(qoderRegion(region), appDataRootFor()).catch(() => undefined);
  return credential && isCredentialUsable(credential) ? credential : undefined;
}

async function reportStatus(engine, region) {
  const credential = await readCredential(engine, region);
  return {
    available: true,
    logged_in: Boolean(credential),
    plan: variantFor(engine === "workbuddy" ? (region === "global" ? "workbuddy-ai" : "workbuddy")
      : engine === "trae" ? (region === "ai" ? "trae-ai" : "trae")
      : region).label,
    detail: credential
      ? "A matching desktop sign-in was detected; the app credential is read-only."
      : "No usable sign-in was found for this edition. Sign in through its desktop app first.",
  };
}

async function listWorkBuddyModels(region) {
  const { client, store, catalog } = workbuddyRuntime(region);
  const credential = await store.resolve();
  let live = false;
  try {
    const models = await client.fetchModels(credential, AbortSignal.timeout(20_000));
    if (models?.length) {
      catalog.set(models);
      live = true;
    }
  } catch {}
  return catalog.current().map((model) => ({
    id: model.id,
    label: model.name || model.id,
    supports_vision: model.supportsImages === true,
    context_window: model.contextWindow || undefined,
    ...(live ? workBuddyRate(model) : { rate_unknown: true }),
  }));
}

async function refreshTraeCatalog(runtime) {
  await runtime.store.resolve();
  const [wireResult, remoteResult] = await Promise.allSettled([
    runtime.upstream.fetchModels(AbortSignal.timeout(25_000)),
    runtime.remote.fetchModels(AbortSignal.timeout(25_000)),
  ]);
  const wire = wireResult.status === "fulfilled" ? wireResult.value : [];
  const remote = remoteResult.status === "fulfilled" ? remoteResult.value : [];
  let models = [];
  if (remote.length) models = mergeTraeModelSources(remote, wire);
  else if (wire.length) {
    models = wire.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      input: ["text"],
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      ...(model.function ? { wireFunction: model.function } : {}),
    }));
  }
  if (models.length) runtime.catalog.set(models);
  return models;
}

async function listTraeModels(region) {
  const runtime = traeRuntime(region);
  await refreshTraeCatalog(runtime).catch(() => []);
  return runtime.catalog.current().map((model) => ({
    id: model.id,
    label: model.name || model.id,
    supports_vision: model.multimodal === true || model.input?.includes("image") === true,
    context_window: model.contextWindow || undefined,
    ...(Number.isFinite(model.creditMultiplier)
      ? { multiplier: model.creditMultiplier }
      : { rate_unknown: true }),
  }));
}

async function listQoderModels(regionId) {
  const region = qoderRegion(regionId);
  const credential = await loadCredentialAsync(region, appDataRootFor()).catch(() => undefined);
  if (!credential || !isCredentialUsable(credential)) return [];
  const rows = await fetchQoderModels(region, credential, AbortSignal.timeout(25_000));
  return rows.map((row) => normalizeEntry(row)).map((model) => {
    const multiplier = qoderRateNow(model, new Date());
    return {
      id: model.id,
      label: model.name || model.id,
      supports_vision: model.isVL === true,
      context_window: model.defaultContextWindow || model.maxInputTokens || undefined,
      ...(Number.isFinite(multiplier) ? { multiplier } : { rate_unknown: true }),
    };
  });
}

async function listModels(engine, region) {
  if (engine === "workbuddy") return listWorkBuddyModels(region);
  if (engine === "trae") return listTraeModels(region);
  return listQoderModels(region);
}

async function logout(engine, region) {
  if (engine === "workbuddy") {
    const { store } = workbuddyRuntime(region);
    await store.logout();
    return { ok: true, detail: "Hermes-owned refreshed-token copy cleared; the desktop app remains signed in." };
  }
  if (engine === "trae") {
    const { store } = traeRuntime(region);
    await store.logout();
    return { ok: true, detail: "Hermes-owned refreshed-token copy cleared; the desktop app remains signed in." };
  }
  return { ok: true, detail: "Qoder desktop credentials are read-only. Sign out in the Qoder app to revoke that session." };
}

async function startShim(engine, region) {
  let shim;
  if (engine === "workbuddy") {
    const runtime = workbuddyRuntime(region);
    const credential = await runtime.store.resolve();
    try {
      const models = await runtime.client.fetchModels(credential, AbortSignal.timeout(20_000));
      if (models?.length) runtime.catalog.set(models);
    } catch {}
    shim = createWorkBuddyShim({ ...runtime, logger: silent });
  } else if (engine === "trae") {
    const runtime = traeRuntime(region);
    await runtime.store.resolve();
    await refreshTraeCatalog(runtime).catch(() => []);
    const wireResolver = (id) => {
      const model = runtime.catalog.current().find((item) => item.id === id
        || item.name?.trim().toLowerCase() === String(id).trim().toLowerCase());
      if (!model) return undefined;
      return { configName: model.wireConfigName || model.id, ...(model.wireFunction ? { function: model.wireFunction } : {}) };
    };
    const bridge = new TraeSoloBridge(runtime.upstream, runtime.catalog, wireResolver);
    shim = createTraeShim({ client: bridge, catalog: runtime.catalog, logger: silent });
  } else {
    const qoder = qoderRegion(region);
    const current = async () => {
      const credential = await loadCredentialAsync(qoder, appDataRootFor()).catch(() => undefined);
      return credential && isCredentialUsable(credential) ? credential : undefined;
    };
    const credential = await current();
    if (!credential) throw new Error("sign-in required");
    const rows = await fetchQoderModels(qoder, credential, AbortSignal.timeout(25_000));
    const models = rows.map((row) => normalizeEntry(row));
    const byId = new Map(models.map((model) => [model.id, model]));
    shim = createQoderShim({
      region: qoder,
      resolveCredential: current,
      resolveModels: () => models,
      resolveUpstreamKey: (id) => byId.get(id)?.key,
      resolveAlwaysThinking: (id) => byId.get(id)?.alwaysThinking,
      resolveEnabledIds: () => models.map((model) => model.id),
      logger: silent,
    });
  }
  await shim.ready;
  const baseUrl = (typeof shim.baseUrl === "function" ? shim.baseUrl() : shim.baseUrl) + "/v1";
  const key = engine === "trae"
    ? (typeof shim.tokenOf === "function" ? shim.tokenOf() : shim.token())
    : shim.token();
  output({ ok: true, base_url: baseUrl, api_key: key });
  const parentPid = process.ppid;
  const stop = async () => {
    clearInterval(parentWatch);
    try { await shim.close(); } catch {}
    process.exit(0);
  };
  // A forcibly closed Hermes process cannot call client.close(). Do not leave
  // an orphan local bridge running after the owning Hermes process exits.
  const parentWatch = setInterval(() => {
    if (process.ppid !== parentPid || process.ppid === 1) void stop();
  }, 2000);
  parentWatch.unref();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

function beijingDay() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}
function accountHash(credential) {
  return createHash("sha256").update(JSON.stringify([credential.uid || credential.userId || credential.userID, credential.domain || credential.host || "", credential.enterpriseId || credential.tenantId || ""])).digest("hex");
}
function checkinReceipt(credential) {
  try {
    const data = JSON.parse(readFileSync(stateFile("checkin-receipt.json"), "utf8"));
    return data.day === beijingDay() && data.account === accountHash(credential) ? data : null;
  } catch { return null; }
}
function saveCheckinReceipt(credential, result) {
  if (!result.claimed) return;
  const file = stateFile("checkin-receipt.json");
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ day: beijingDay(), account: accountHash(credential), claimed: true }), { mode: 0o600 });
  renameSync(temporary, file);
}
function maskedName(value) {
  return typeof value === "string" && value ? `${value.slice(0, 2)}***` : "已登录账号";
}
function quota(remaining, total, packages = 0, unit = "积分") {
  return { remaining, total, packages, unit };
}
function unknownCheckin(reason) {
  return { state: "unknown", can_claim: false, reason };
}
function traeUsage(runtime) {
  return new TraeUsageClient({ credential: () => runtime.store.resolve(),
    deviceId: async () => (await runtime.identity()).deviceId, timeoutMs: 20000 });
}
async function accountData(engine, region) {
  const current = await readCredential(engine, region);
  if (!current) return { logged_in: false, checkin: unknownCheckin("请先登录对应桌面应用") };
  const result = { logged_in: true, account: maskedName(current.nickname || current.accountName || current.name),
    checkin: unknownCheckin("状态读取失败"), quota: null };
  if (engine === "workbuddy") {
    const runtime = workbuddyRuntime(region);
    const credential = await runtime.store.resolve();
    try {
      const credits = await runtime.client.fetchCredits(credential);
      result.quota = { ...quota(credits.total, credits.accounts.reduce((n, p) => n + p.size, 0), credits.accounts.length), unlimited: credits.unlimited === true };
    } catch { result.usage_error = "积分查询失败，请刷新重试"; }
    const checked = Boolean(checkinReceipt(credential));
    result.checkin = region === "global" ? { state: "not_applicable", can_claim: false }
      : { state: checked ? "checked" : "unknown", can_claim: !checked,
          reason: checked ? "本插件已确认今日签到" : "上游无可靠只读签到状态；点击签到确认，不会在刷新时领取" };
  } else if (engine === "trae") {
    const runtime = traeRuntime(region), usage = traeUsage(runtime);
    const outcomes = await Promise.allSettled([usage.snapshot(AbortSignal.timeout(25000)),
      region === "cn" ? usage.checkinStatus(AbortSignal.timeout(25000)) : Promise.resolve(null)]);
    if (outcomes[0].status === "fulfilled") {
      const snapshot = outcomes[0].value;
      const packs = snapshot.packs.filter(p => Number.isFinite(p.creditsLimit));
      const hasSummary = snapshot.isCreditsBilling && snapshot.summary.totalAmount > 0;
      const total = hasSummary ? snapshot.summary.totalAmount : packs.reduce((n, p) => n + p.creditsLimit, 0);
      const used = hasSummary ? snapshot.summary.consumedAmount : packs.reduce((n, p) => n + (p.consumedCredits || 0), 0);
      if (hasSummary || packs.length) result.quota = quota(Math.max(0, total - used), total, packs.length);
      else result.usage_error = "上游未提供积分套餐数据";
    } else result.usage_error = "积分查询失败，请刷新重试";
    if (region !== "cn") result.checkin = { state: "not_applicable", can_claim: false };
    else if (outcomes[1].status === "fulfilled") {
      const check = outcomes[1].value, checked = check.checkedIn === true;
      result.checkin = { state: checked ? "checked" : check.enabled ? "available" : "not_applicable",
        can_claim: check.enabled && !checked, reward: check.credits };
    }
  } else {
    const area = qoderRegion(region), credential = current;
    try {
      const usage = await fetchQoderUsage(area, credential, AbortSignal.timeout(25000));
      if (usage) {
        const buckets = [usage.userQuota, usage.addOnQuota].filter(Boolean);
        if (buckets.length) result.quota = quota(buckets.reduce((n, p) => n + p.remaining, 0), buckets.reduce((n, p) => n + p.total, 0), usage.dedicatedPackages?.length || 0);
      }
    } catch { result.usage_error = "积分查询失败，请刷新重试"; }
    try {
      const check = checkinStateFrom(await readCampaigns(area, credential, AbortSignal.timeout(20000)));
      result.checkin = { state: check.todayCheckedIn ? "checked" : check.active ? "available" : "not_applicable",
        can_claim: check.active && !check.todayCheckedIn, reward: check.amount };
    } catch { result.checkin = unknownCheckin("签到状态查询失败"); }
  }
  return result;
}
async function performCheckin(engine, region) {
  let result, credential;
  if (engine === "workbuddy") {
    if (region !== "cn") return { claimed: false, state: "not_applicable" };
    credential = await workbuddyRuntime(region).store.resolve();
    if (checkinReceipt(credential)) return { claimed: true, replayed: true };
    // Protocol transcribed from corrinehu/dsh-buddy-checkin (MIT), check().
    const response = await fetch(`https://${credential.domain}/v2/billing/meter/daily-checkin`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential.accessToken}`,
        "x-user-id": credential.uid, "x-domain": credential.domain,
        ...(credential.enterpriseId ? { "x-enterprise-id": credential.enterpriseId, "x-tenant-id": credential.enterpriseId } : {}) },
      body: "{}", signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    const already = typeof data.msg === "string" && /已.*签到/.test(data.msg);
    result = { claimed: already || (response.ok && data.code === 0), replayed: already,
      ...(typeof data.data?.credit === "number" && !already ? { amount: data.data.credit } : {}) };
  } else if (engine === "trae") {
    if (region !== "cn") return { claimed: false, state: "not_applicable" };
    const runtime = traeRuntime(region), usage = traeUsage(runtime);
    credential = await runtime.store.resolve();
    const check = await usage.checkinStatus(AbortSignal.timeout(20000));
    if (check.checkedIn) return { claimed: true, replayed: true };
    if (!check.enabled) return { claimed: false, state: "not_applicable" };
    const outcome = await usage.claimCheckin(AbortSignal.timeout(20000));
    result = { claimed: outcome.claimed, code: outcome.code };
  } else {
    const area = qoderRegion(region);
    credential = await loadCredentialAsync(area, appDataRootFor());
    if (!credential || !isCredentialUsable(credential)) throw new Error("not signed in");
    const campaigns = await readCampaigns(area, credential, AbortSignal.timeout(20000));
    const check = checkinStateFrom(campaigns);
    if (check.todayCheckedIn) return { claimed: true, replayed: true };
    const campaign = claimableCampaignOf(campaigns);
    if (!campaign || !check.active) return { claimed: false, state: "not_applicable" };
    const outcome = normalizeClaimResult(await claimCampaign(area, credential, campaign.campaignId, AbortSignal.timeout(20000)), campaign);
    result = { claimed: outcome.claimed, replayed: outcome.replayed, amount: outcome.amount };
  }
  saveCheckinReceipt(credential, result);
  return result;
}

async function main() {
  const [, , action, engine, region] = process.argv;
  variantFor(engine === "workbuddy" && region === "global" ? "workbuddy-ai"
    : engine === "workbuddy" ? "workbuddy"
    : engine === "trae" && region === "ai" ? "trae-ai"
    : engine === "trae" ? "trae"
    : region);
  if (action === "account") { output(await accountData(engine, region)); return; }
  if (action === "checkin") { output(await performCheckin(engine, region)); return; }
  if (action === "status") {
    output(await reportStatus(engine, region));
    return;
  }
  if (action === "models") {
    const models = await listModels(engine, region);
    output({ models });
    return;
  }
  if (action === "logout") {
    output(await logout(engine, region));
    return;
  }
  if (action === "serve") {
    await startShim(engine, region);
    return;
  }
  throw new Error("unknown bridge action");
}

main().catch((error) => {
  // Only fixed codes cross the pipe. Upstream errors and response bodies may
  // contain private data, so never serialize their messages or stack traces.
  const errorCode = error?.name === "TimeoutError" || error?.name === "AbortError"
    ? "upstream_timeout"
    : error?.code === "ENOTFOUND" || error?.code === "ECONNREFUSED"
      ? "upstream_unreachable"
      : "bridge_failed";
  output({ error: "bridge operation failed", error_code: errorCode });
  process.exitCode = 1;
});
