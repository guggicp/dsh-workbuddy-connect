# Hermes 渠道中心

Stable plugin ID: `dsh-model-rates`. Version 0.2.0 adds a sidebar channel center and a Settings → Plugins page alongside live model multiplier badges.

The page shows per-provider credit balance/allowance, packages, sign-in and daily check-in status, authentication buttons, model visibility checklists, manual batch check-in, and optional auto-check-in when opening the center. Automatic check-in is off by default. Model filters and settings are isolated per active Hermes profile. GET routes never claim rewards.

Enable **both Agent and Desktop** switches in the plugin manager. After upgrading 0.1.x, restart Hermes once to load the added backend API routes. The settings model dropdown also needs the parent suite's generic `compat/hermes-model-select.patch` and a renderer build; chat model menus already expose the decoration seam.

WorkBuddy CN can only confirm today's sign-in reward from a claim response, so the default read-only view may say “签到状态待确认.” It does not query DSH's records or guess. Quota read failures show unavailable data rather than fabricated zero. See the parent README for upstream attribution, file paths and remaining limitations.
