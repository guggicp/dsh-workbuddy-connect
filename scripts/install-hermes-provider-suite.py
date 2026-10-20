"""Operator repair for the local Hermes source and the source-only provider suite.

This is a maintenance script outside the plugin package; plugins never edit core.
It never imports or runs provider code.

Default: preview exact changed paths. --apply backs up each changed source file
before installing. No auth.json, .env, config, desktop app data, or DSH files
are read or copied. Re-run after a Hermes update to restore the compatibility
hooks, provided that update still has the supported function shapes below.
"""

from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import difflib
import hashlib
import json
from pathlib import Path
import shutil

SOURCE = Path(__file__).resolve().parents[1] / "hermes-provider-suite"


def replace_once(text: str, old: str, new: str, marker: str) -> str:
    if marker in text:
        return text
    if text.count(old) != 1:
        raise ValueError(f"Hermes source changed; review required for {marker}")
    return text.replace(old, new, 1)


def core_hooks(repo: Path) -> dict[Path, bytes]:
    auth = repo / "hermes_cli/auth.py"
    old = '''    return {
        "configured": available, "provider": provider_id, "name": pconfig.name, "command": command,
        "args": args, "resolved_command": resolved_command, "base_url": base_url,
        "logged_in": available, "auth_verified": auth_verified, "auth_source": auth_source}
'''
    new = '''    status = {
        "configured": available, "provider": provider_id, "name": pconfig.name, "command": command,
        "args": args, "resolved_command": resolved_command, "base_url": base_url,
        "logged_in": available, "auth_verified": auth_verified, "auth_source": auth_source}
    # HERMES_DESKTOP_APP_AUTH_STATUS: plugin behavior lives in the sibling.
    from hermes_cli.auth_plugin_providers import plugin_external_auth_status
    status.update(plugin_external_auth_status(provider_id, available))
    return status
'''
    auth_text = replace_once(auth.read_text(), old, new, "HERMES_DESKTOP_APP_AUTH_STATUS")
    auth_text = auth_text.replace('''    """Status snapshot for providers that run a local subprocess.

    ``configured``/``logged_in`` are structural (executable resolves or TCP endpoint set): the
    subprocess owns real auth. ``auth_verified``/``auth_source`` carry positive evidence only."""''',
        '''    """Subprocess status, including optional plugin-owned sign-in evidence."""''', 1)

    oauth = repo / "hermes_cli/web_server_oauth.py"
    old = '''        if not pconfig or pconfig.auth_type != "external_process":
            return default
        status = get_external_process_provider_status(provider_id) or {}
'''
    new = '''        if not pconfig or pconfig.auth_type != "external_process":
            return default
        # HERMES_PLUGIN_OWNED_AUTH_COMMAND: synthetic account cards use the
        # Hermes auth handler, not the inference runtime's executable.
        if default.startswith("hermes auth "):
            from hermes_cli.auth_plugin_providers import plugin_auth_handler
            if callable(plugin_auth_handler(provider_id)):
                return default
        status = get_external_process_provider_status(provider_id) or {}
'''
    oauth_text = replace_once(oauth.read_text(), old, new, "HERMES_PLUGIN_OWNED_AUTH_COMMAND")

    routes = repo / "hermes_cli/web_routers/oauth.py"
    old = '''    if provider.get("flow") == "external" and provider.get("id") != "anthropic":
        if _oauth_provider_disconnect_command(provider):
'''
    new = '''    if provider.get("flow") == "external" and provider.get("id") != "anthropic":
        # HERMES_PLUGIN_DISCONNECT_HINT: borrowed desktop app credentials stay
        # owned by that app; a plugin may describe that boundary explicitly.
        from providers import get_provider_profile
        profile = get_provider_profile(str(provider.get("id") or ""))
        hint = getattr(profile, "auth_disconnect_hint", None)
        if isinstance(hint, str) and hint.strip():
            return hint
        if _oauth_provider_disconnect_command(provider):
'''
    routes_text = replace_once(routes.read_text(), old, new, "HERMES_PLUGIN_DISCONNECT_HINT")
    hooks = repo / "hermes_cli/auth_plugin_providers.py"
    hooks_text = hooks.read_text()
    if "def plugin_external_auth_status(" not in hooks_text:
        hooks_text += '''


def plugin_external_auth_status(provider: str, available: bool) -> dict[str, Any]:
    """Optional non-secret status for a process provider borrowing app sign-in.

    Providers without this hook retain structural CLI evidence. Hook failures
    cannot produce a signed-in badge. The hook owns cheap local checks/caching.
    """
    hook = _profile_hook(provider, "auth_status")
    if hook is None:
        return {}
    try:
        observed = hook()
    except Exception:
        observed = {"available": False, "logged_in": False,
                    "detail": "Could not read the desktop app sign-in state."}
    if not isinstance(observed, dict):
        observed = {"available": False, "logged_in": False}
    usable = available and observed.get("available", True) is True
    signed_in = usable and observed.get("logged_in") is True
    return {"configured": usable, "logged_in": signed_in, "auth_verified": signed_in,
            "auth_source": "desktop_app" if signed_in else None,
            "source_label": str(observed.get("detail") or "Desktop app sign-in")}
'''
    result = {auth: auth_text.encode(), oauth: oauth_text.encode(),
              routes: routes_text.encode(), hooks: hooks_text.encode()}
    model_select = repo / "apps/desktop/src/app/settings/model-select.tsx"
    model_text = model_select.read_text()
    model_text = replace_once(model_text,
        "import { CONTROL_TEXT } from './constants'",
        "import { useModelMenuRowDecoration } from '../shell/model-menu-row-decorations'\n\nimport { CONTROL_TEXT } from './constants'",
        "import { useModelMenuRowDecoration }")
    model_text = replace_once(model_text,
        "            {model}\n          </SelectItem>",
        "            <ModelSelectLabel model={model} provider={providerSlug} />\n          </SelectItem>",
        "<ModelSelectLabel model={model}")
    if "function ModelSelectLabel(" not in model_text:
        model_text += """

/** HERMES_SETTINGS_MODEL_DECORATION: use the same display-only plugin seam as chat. */
function ModelSelectLabel({ model, provider }: { model: string; provider: string }) {
  const { badge } = useModelMenuRowDecoration({ label: model, model, provider })

  return (
    <span className="inline-flex items-center gap-2">
      <span>{model}</span>
      {badge && <span className="text-xs text-muted-foreground">{badge}</span>}
    </span>
  )
}
"""
    result[model_select] = model_text.encode()
    for path, content in result.items():
        if path.suffix == ".py":
            ast.parse(content, filename=str(path))
    return result


def plan(home: Path) -> dict[Path, bytes]:
    changes = core_hooks(home / "hermes-agent")
    provider = home / "plugins/model-providers/dsh-local-model-providers"
    for name in ("__init__.py", "bridge.mjs", "plugin.yaml", "README.md",
                 "THIRD_PARTY_NOTICES.md", "UPSTREAMS.md", "compat/hermes-auth-hooks.patch",
                 "compat/hermes-model-select.patch"):
        changes[provider / name] = (SOURCE / name).read_bytes()
    for path in sorted((SOURCE / "vendor").rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            changes[provider / path.relative_to(SOURCE)] = path.read_bytes()
    rates = SOURCE / "hermes-desktop-rates"
    for path in sorted(rates.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            changes[home / "plugins/dsh-model-rates" / path.relative_to(rates)] = path.read_bytes()
    changes[home / "desktop-plugins/dsh-model-rates/plugin.js"] = (rates / "desktop/plugin.js").read_bytes()
    for path, content in changes.items():
        if path.suffix == ".py":
            ast.parse(content, filename=str(path))
    return {path: content for path, content in changes.items()
            if not path.exists() or path.read_bytes() != content}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-home", type=Path, default=Path.home() / ".hermes")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--diff", action="store_true", help="Show the small Hermes core compatibility diff")
    parser.add_argument("--export-core-patch", type=Path)
    args = parser.parse_args()
    home = args.hermes_home.expanduser().resolve()
    if args.export_core_patch:
        repo = home / "hermes-agent"
        patch = "".join("".join(difflib.unified_diff(
            path.read_text().splitlines(True), content.decode().splitlines(True),
            fromfile="a/" + str(path.relative_to(repo)),
            tofile="b/" + str(path.relative_to(repo)),
        )) for path, content in core_hooks(repo).items())
        args.export_core_patch.parent.mkdir(parents=True, exist_ok=True)
        args.export_core_patch.write_text(patch)
        print(f"Core source patch exported: {args.export_core_patch}")
        return
    changes = plan(home)
    for path in changes:
        print(path.relative_to(home))
        if args.diff and "hermes-agent" in path.parts:
            print("".join(difflib.unified_diff(
                path.read_text().splitlines(True), changes[path].decode().splitlines(True),
                fromfile=str(path), tofile=str(path) + " (patched)")))
    print(f"{len(changes)} source files {'to install' if not args.apply else 'selected'}")
    if not args.apply or not changes:
        return
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = home / "backups/dsh-local-model-providers" / stamp
    records = []
    # Back up every existing source before the first installation write.
    for path, content in changes.items():
        relative = path.relative_to(home)
        existed = path.exists()
        if existed:
            target = backup / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
        records.append({"path": str(relative), "existed": existed,
                        "installed_sha256": hashlib.sha256(content).hexdigest()})
    backup.mkdir(parents=True, exist_ok=True)
    (backup / "manifest.json").write_text(json.dumps(records, indent=2) + "\n")
    for path, content in changes.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".dsh-install-tmp")
        temporary.write_bytes(content)
        if path.exists():
            shutil.copymode(path, temporary)
        temporary.replace(path)
    print(f"Source installation complete. Backup: {backup}")
    print("No provider process, inference call, test, build, or credential read was performed.")


if __name__ == "__main__":
    main()
