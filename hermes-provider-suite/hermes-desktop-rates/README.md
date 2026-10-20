# Hermes model multiplier badges

This companion layer keeps the model provider implementation separate from Hermes Desktop presentation:

- The provider profiles expose the six WorkBuddy, Trae, and Qoder channels in Hermes model configuration.
- `dashboard/plugin_api.py` asks those profiles for current model metadata and returns display-only multiplier labels.
- `desktop/plugin.js` adds the label as a trailing badge in Hermes' native model menu.

The badge uses the upstream's current credit multiplier where it is published. Unknown rates are shown as `倍率未知`; no value is inferred from another model. Qoder's effective rate is resolved against its current off-peak window, and WorkBuddy's current promotion is reflected by its catalog.

The backend route is intentionally read-only and never returns credentials. Hermes gates it through the ordinary `plugins.enabled` allow-list.

The package has separate Agent and Desktop switches in the plugin manager. Enable both. The settings model dropdown also needs the generic `compat/hermes-model-select.patch` in the parent provider suite and a renderer build; chat menus already expose the decoration seam.
