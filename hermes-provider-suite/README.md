# DSH Desktop Model Providers for Hermes

One Hermes model-provider plugin exposes six account/region profiles:

| Hermes provider | Desktop account |
| --- | --- |
| `workbuddy` | WorkBuddy CN |
| `workbuddy-ai` | WorkBuddy AI / international |
| `trae` | Trae CN |
| `trae-ai` | Trae international |
| `qoder-cn` | Qoder CN |
| `qoder` | Qoder international |

Hermes starts a provider-specific Node bridge only when it needs to read app sign-in state, list models, or make a request. The bridge binds to `127.0.0.1` on an ephemeral port for inference, uses a per-process random bearer secret, and exits when Hermes closes its client or its owning process exits. The profiles use Hermes' process-provider lifecycle with a custom OpenAI-compatible HTTP client. No DSH process, DSH installation, DSH packages, or DSH loopback server is used.

## Install / repair

The provider package is installed under `$HERMES_HOME/plugins/model-providers/dsh-local-model-providers/`. The companion's backend belongs under `$HERMES_HOME/plugins/dsh-model-rates/`, and its `desktop/plugin.js` under `$HERMES_HOME/desktop-plugins/dsh-model-rates/plugin.js`.

The installed Hermes backend also needs the generic hooks in [compat/hermes-auth-hooks.patch](compat/hermes-auth-hooks.patch). This is a separate, reviewable core source change for an operator to apply; plugin code never edits core source. The patch lets the Accounts page read the provider's actual `auth_status()`, keeps `hermes auth add <provider>` as its login command, and describes desktop-owned sign-out correctly. Other providers retain their existing auth behavior.

The operator script `scripts/install-hermes-provider-suite.py` lives outside the plugin package. It previews exact changes, backs up the previous source files with a SHA256 manifest under `~/.hermes/backups/dsh-local-model-providers/<timestamp>/`, and installs the reviewed source. It never executes Hermes/provider code or copies credential/config files. Restore an individual source file from the backup to undo its change.

From this repository root, preview and apply the source installation:

```sh
python3 scripts/install-hermes-provider-suite.py
python3 scripts/install-hermes-provider-suite.py --apply
```

The optional settings-dropdown core UI change requires a Desktop renderer build. Existing chat model menus already support row decoration.

Restart Hermes Desktop and its local backend after installation. A Hermes update can replace the compatibility hooks; review and reapply the core patch afterward. If the supported function shapes change, the local operator script stops for source review instead of overwriting unfamiliar code. The `dsh-model-rates` companion must be in `plugins.enabled`; the repair preserves that setting.

For the settings page's simple model dropdown, [compat/hermes-model-select.patch](compat/hermes-model-select.patch) connects the existing generic `modelMenu.row` decoration seam to `ModelSelect`. Rebuild the renderer after applying that optional core UI patch. Model IDs remain unchanged.

## Requirements

- Hermes with the model-provider plugin API and OpenAI-compatible provider client hook.
- Node.js 22.19+ (or 24+) for the vendored TypeScript protocol sources.
- If this plugin is explicitly configured to use a proxy, Node.js 22.21+ (or 24+) is required so `NODE_USE_ENV_PROXY=1` is honored.
- A signed-in desktop app for the edition being used.

The provider reads the desktop app's credential store. WorkBuddy and Trae may keep refreshed copies in Hermes-owned state under `$HERMES_HOME/data/dsh-model-providers/`; their desktop credential files are read-only. Qoder's desktop credential store is read-only. `hermes auth logout <provider>` clears only a Hermes-owned WorkBuddy/Trae copy; sign out of Qoder in its desktop app.

## Proxy

By default, the bridge strips inherited proxy variables and connects directly. This setting applies only to the WorkBuddy/Trae/Qoder suite; Hermes built-in providers continue to use Hermes' existing proxy environment. To route this suite through one explicit proxy, set `HERMES_DSH_PROXY_URL` in the environment used to launch Hermes:

```sh
export HERMES_DSH_PROXY_URL=http://127.0.0.1:7890
hermes
```

For Hermes Desktop, the app must inherit that variable from its launcher; setting it in a separate terminal does not change an already-running GUI app.

This explicit setting is passed only to the bridge process and takes precedence over inherited proxy variables. Confirm that the proxy is running and listening on that address. If this plugin proxy is configured but the selected Node version cannot honor environment proxies, the provider reports unavailable instead of silently trying a direct connection. A macOS system proxy setting alone is not forwarded automatically to Node.

## Use

Choose one of the provider IDs above in `hermes model`. If the model picker has cached its provider list, refresh it or restart Hermes. Use `hermes auth add qoder-cn` (or another provider ID) to reuse the matching desktop sign-in. If no usable sign-in is found, this command opens the matching installed macOS app and prints instructions; complete that app's sign-in and run `hermes auth status qoder-cn`. Authorization stays in the desktop app. Hermes does not ask for copied tokens. International providers require their own matching app/account; a CN sign-in does not authenticate an international provider.

Vision support is populated from each upstream model catalog where available; select a model Hermes reports as vision-capable for image tasks.

## State and boundaries

- Runtime state is isolated by provider below `$HERMES_HOME/data/dsh-model-providers/` and created with owner-only permissions.
- The bridge inherits only a small OS environment allowlist and explicit app-path overrides; generic API-key and token environment variables are not forwarded. Proxy variables are stripped unless `HERMES_DSH_PROXY_URL` is set.
- The temporary bearer secret is sent to Hermes over the bridge's private stdout pipe and is not written to disk or logged.
- The upstream protocol source snapshots and their license notices are listed in [UPSTREAMS.md](UPSTREAMS.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Verification status

Runtime acceptance on 2026-10-20 confirmed all three locally installed CN editions: WorkBuddy (20 models), Trae CN (33 models), and Qoder CN (14 models). All three CLI status commands exited 0/signed in; live catalog rows carried rates; both streaming and ordinary ChatCompletion calls returned text. The companion FastAPI multiplier route returned HTTP 200 with matching counts. Catalogs and rates can change upstream.

The source-only runtime expands TypeScript parameter properties into ordinary fields, injects WorkBuddy's upstream key-provider factory, and supports macOS Qoder Safe Storage alongside Windows DPAPI. The macOS Keychain may prompt when a new caller first reads the matching Qoder item's password. No password is logged, saved, or exported. A sandbox-denied Keychain read cannot establish that the desktop app is signed out.

The shim upstreams force SSE. The Python client preserves streaming requests and assembles ordinary completion responses for Hermes auxiliary callers. Its private loopback HTTP transport ignores inherited proxy variables.

## Hermes model picker multipliers

The six profiles are separate providers; they do not appear inside the Nous Portal model group. The current Hermes default provider/model is not changed by this adapter. To show live credit multipliers as trailing badges in Hermes Desktop's native model menu, install the companion package in [hermes-desktop-rates](hermes-desktop-rates/README.md) and enable `dsh-model-rates` in `plugins.enabled`. In the Desktop plugin manager, also enable this package's **Desktop** switch; the agent and desktop halves have separate switches.

The adapter uses the live WorkBuddy billing factor, Trae credit multiplier, or Qoder rate resolved for the current off-peak window. If the upstream does not publish a trustworthy value, the picker shows `倍率未知` rather than inferring one.

## Channel center (0.2.0)

Enable both the Agent and Desktop switches for the companion package (display name **Hermes 渠道中心**, stable package ID `dsh-model-rates`). Open **渠道中心** from the sidebar or Settings → Plugins → 渠道中心. Restart the Hermes backend after upgrading from 0.1.x, because the new API routes are mounted at backend startup; the Desktop plugin itself can reload live.

The channel center offers:

- Per-channel current credit balance, total allowance, package count and remaining-quota bar.
- Desktop sign-in reuse with an explicit **认证** button. Credentials stay in the desktop app/Hermes-owned refresh state, never in the UI or plugin settings.
- A searchable model checklist with live multiplier labels. Save a subset or choose all, including future additions. At least one model must remain selected. Hidden models disappear from the CLI/Desktop catalogs; an already-selected conversation model is not forcibly replaced.
- Per-channel check-in, **签到所有可签渠道**, and an optional auto-check-in-on-open setting. Automatic check-in is **off by default**. Only a confirmed POST/explicitly enabled auto action can claim; status/catalog/credits GETs never claim rewards.
- A sidebar-entry visibility setting and isolated preferences for each active Hermes profile.

WorkBuddy CN has no reliable read-only daily check-in verdict. Before this adapter receives a successful/idempotent claim answer for the current account and Beijing day, it honestly shows **签到状态待确认**, not “not checked in.” WorkBuddy international and Trae international have no matching CN check-in activity. Trae/Qoder status follows their actual campaign APIs; unavailable activities and failed reads remain distinct from zero credits or success.

Model choices live in `$HERMES_HOME/data/dsh-model-providers/<provider>/model-visibility.json`; center preferences in `$HERMES_HOME/data/dsh-model-providers/channel-center.json`. These files contain only model IDs and booleans. A WorkBuddy claim receipt stores a hashed account scope and Beijing day, not credentials. Removing a plugin does not log out the original desktop apps.

Read-only live acceptance on 2026-10-20 confirmed balances for the three CN providers and HTTP 200 channel routes. Isolated checks covered rendering, model selection → Hermes disk catalog cache, profile separation, no automatic claims by default and refusal of unconfirmed claim requests. Real reward-claim requests were deliberately not performed during validation. Balance values and model counts vary upstream.

## Remaining scope

This is still not full parity with every upstream DSH account panel: browser/device-login workflows, multi-account pooling, enterprise-account selection, and the full per-package transaction history are not exposed here. Authenticate or switch accounts in the matching desktop app, then refresh the channel center.
