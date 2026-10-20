"""Hermes model-provider suite for WorkBuddy, Trae, and Qoder.

Each profile starts a private, loopback-only Node shim on demand. The shim
imports the vendored protocol sources directly; no DSH process or DSH
installation is used.
"""

from __future__ import annotations

import json
import logging
import math
import os
import queue
import re
import shutil
import subprocess
import threading
from time import monotonic
from pathlib import Path
from typing import Any

from providers import register_provider
from providers.base import ProviderProfile
from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)
_PLUGIN_DIR = Path(__file__).resolve().parent
_BRIDGE = _PLUGIN_DIR / "bridge.mjs"

_PROVIDERS = {
    "workbuddy": ("workbuddy", "cn", "WorkBuddy"),
    "workbuddy-ai": ("workbuddy", "global", "WorkBuddy AI"),
    "trae": ("trae", "cn", "Trae CN"),
    "trae-ai": ("trae", "ai", "Trae International"),
    "qoder-cn": ("qoder", "qoder-cn", "Qoder CN"),
    "qoder": ("qoder", "qoder", "Qoder"),
}

_SAFE_ENV = {
    "HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "HERMES_HOME",
}
_NODE_VERSIONS: dict[str, tuple[int, int, int] | None] = {}
_STATUS_CACHE: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
_CATALOG_CACHE: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}
_CATALOG_LOCKS = {name: threading.Lock() for name in _PROVIDERS}
_STATUS_LOCK = threading.Lock()
_PREFERENCES_LOCK = threading.Lock()
_CHECKIN_LOCKS = {name: threading.Lock() for name in _PROVIDERS}
_CATALOG_TTL = 60.0


def _hermes_home() -> Path:
    return Path(get_hermes_home())


def _state_dir(provider: str) -> Path:
    path = _hermes_home() / "data" / "dsh-model-providers" / provider
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError:
        pass
    return path


def _node_candidates() -> list[str]:
    override = os.environ.get("HERMES_DSH_NODE", "").strip()
    if override:
        found = shutil.which(override) or (override if Path(override).is_file() else None)
        return [str(found)] if found else []

    system_node = shutil.which("node")
    candidates = [system_node] if system_node else []
    tools = _hermes_home() / "tools"
    for root in tools.glob("node-*"):
        for name in ("node", "node.exe"):
            for candidate in (root / "bin" / name, root / name):
                if candidate.is_file():
                    candidates.append(str(candidate))

    def version_key(path: str) -> tuple[int, int, int]:
        match = re.search(r"node-(\d+)\.(\d+)\.(\d+)", path)
        return tuple(int(part) for part in match.groups()) if match else (0, 0, 0)

    return sorted(dict.fromkeys(candidates), key=version_key, reverse=True)


def _node_command() -> str | None:
    return next(iter(_node_candidates()), None)


def _provider_env(engine: str, state: Path) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key in _SAFE_ENV}
    # Credential path overrides are intentionally the only provider-specific
    # values passed through. Tokens and unrelated *_KEY/*_TOKEN values are not.
    prefixes = ("WORKBUDDY_", "TRAE_", "QODER_")
    for key, value in os.environ.items():
        upper = key.upper()
        if not key.startswith(prefixes):
            continue
        if any(marker in upper for marker in ("API_KEY", "PERSONAL_ACCESS_TOKEN", "_PAT", "TOKEN", "SECRET", "PASSWORD", "COOKIE")):
            continue
        if "AUTH_FILE" in upper or "APP_DATA" in upper or "CLI_PATH" in upper:
            env[key] = value

    env["HERMES_HOME"] = str(_hermes_home())
    env["HERMES_DSH_STATE_DIR"] = str(state)
    # The vendored stores use this compatibility name for their private state;
    # it always resolves inside Hermes and never points at ~/.dsh.
    env["DSH_HOME"] = str(state)
    # This plugin is direct by default: inherited Hermes proxy variables,
    # NO_PROXY, and Node's proxy opt-in flag are excluded by _SAFE_ENV.
    # Set HERMES_DSH_PROXY_URL to opt this suite into an explicit proxy.
    proxy = os.environ.get("HERMES_DSH_PROXY_URL", "").strip()
    if proxy:
        env["HTTP_PROXY"] = env["http_proxy"] = proxy
        env["HTTPS_PROXY"] = env["https_proxy"] = proxy
        # Keep only loopback exclusions; inherited NO_PROXY must not bypass it.
        env["NO_PROXY"] = env["no_proxy"] = "localhost,127.0.0.1,::1"
        env["NODE_USE_ENV_PROXY"] = "1"
    return env


def _proxy_configured() -> bool:
    return bool(os.environ.get("HERMES_DSH_PROXY_URL", "").strip())


def _node_version(node: str) -> tuple[int, int, int] | None:
    if node in _NODE_VERSIONS:
        return _NODE_VERSIONS[node]
    try:
        result = subprocess.run(
            [node, "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=3.0,
            check=False,
            env={key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL") if key in os.environ},
        )
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)\s*", result.stdout)
        version = tuple(int(part) for part in match.groups()) if result.returncode == 0 and match else None
    except (OSError, subprocess.SubprocessError):
        version = None
    _NODE_VERSIONS[node] = version
    return version


def _node_usable(node: str | None) -> bool:
    if not node:
        return False
    version = _node_version(node)
    if version is None:
        return False
    major, minor, _patch = version
    base_supported = major >= 24 or (major == 22 and (minor, _patch) >= (19, 0))
    if not base_supported:
        return False
    if not _proxy_configured():
        return True
    return major >= 24 or (major == 22 and (minor, _patch) >= (21, 0))


def _node_requirement_error() -> str:
    if _proxy_configured():
        return "Node.js 22.21+ or 24+ is required when a proxy is configured; direct fallback is disabled"
    return "Node.js 22.19+ or 24+ is required for the Hermes local bridge"


def _run_bridge(
    provider: str,
    action: str,
    *,
    timeout: float = 45.0,
    node: str | None = None,
) -> dict[str, Any] | None:
    descriptor = _PROVIDERS.get(provider)
    command = node or _node_command()
    if not descriptor or not _node_usable(command):
        return None
    engine, region, _label = descriptor
    state = _state_dir(provider)
    try:
        result = subprocess.run(
            [command, str(_BRIDGE), action, engine, region],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
            env=_provider_env(engine, state),
        )
        if not result.stdout.strip():
            code = next((code for code in (
                "ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
                "ERR_UNKNOWN_FILE_EXTENSION", "SyntaxError",
            ) if code in result.stderr), "no_output")
            logger.warning("%s %s bridge returned no response: %s (exit %s)",
                           provider, action, code, result.returncode)
            return None
        payload = json.loads(result.stdout.splitlines()[-1])
        if result.returncode != 0 or not isinstance(payload, dict) or payload.get("error"):
            # Never log stdout/stderr or upstream exception text: those can
            # contain credentials. The bridge supplies only an allowlisted code.
            code = payload.get("error_code", "bridge_failed") if isinstance(payload, dict) else "invalid_response"
            if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,40}", code):
                code = "bridge_failed"
            logger.warning("%s %s failed: %s (exit %s)", provider, action, code, result.returncode)
            return None
        return payload
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        logger.warning("%s %s bridge failed (%s)", provider, action, type(exc).__name__)
        return None


def _status(provider: str, *, node: str | None = None) -> dict[str, Any]:
    command = node or _node_command()
    if not command:
        return {
            "available": False,
            "logged_in": False,
            "plan": "Hermes local provider",
            "detail": "Node.js 22.19+ or 24+ was not found. Set HERMES_DSH_NODE to its executable path.",
        }
    if not _node_usable(command):
        return {
            "available": False,
            "logged_in": False,
            "plan": "Hermes local provider",
            "detail": f"{_node_requirement_error()}. Set HERMES_DSH_NODE to a supported executable.",
        }
    result = _run_bridge(provider, "status", timeout=15.0, node=command)
    if result is None:
        return {
            "available": False,
            "logged_in": False,
            "plan": "Hermes local provider",
            "detail": "Credential bridge failed to load; login state is unknown. Check Hermes errors.log for the safe failure code.",
        }
    return result


def _auth_handler(provider: str, action: str, args: Any) -> bool:
    # argparse's args.command is the Hermes subcommand ("auth"), not a
    # Node executable. HERMES_DSH_NODE is resolved by _node_command instead.
    node = _node_command()
    label = _PROVIDERS[provider][2]
    with _STATUS_LOCK:
        _STATUS_CACHE.pop((str(_hermes_home()), provider), None)
    if action == "add":
        status = _status(provider, node=node)
        if status.get("logged_in"):
            print(f"{label}: desktop sign-in detected; Hermes will reuse it read-only.")
        else:
            print(f"{label}: {status.get('detail', 'Sign in through its desktop app first.')}")
            _open_sign_in_app(provider)
            print(f"After signing in, run: hermes auth status {provider}")
            raise SystemExit(1)
        return True
    if action == "status":
        status = _status(provider, node=node)
        state = "signed in" if status.get("logged_in") else "not signed in"
        print(f"{label}: {state}. {status.get('detail', '')}")
        if not status.get("logged_in"):
            raise SystemExit(1)
        return True
    if action == "logout":
        result = _run_bridge(provider, "logout", timeout=15.0, node=node)
        if result:
            print(result.get("detail", f"{label}: local Hermes state cleared."))
        else:
            print(f"{label}: no Hermes-owned credential copy was cleared.")
        return True
    if action == "refresh":
        status = _status(provider, node=node)
        print(status.get("detail", f"{label}: credentials are refreshed when a request needs them."))
        return True
    return False


def _open_sign_in_app(provider: str) -> None:
    """Open the matching installed macOS app on an explicit auth-add action."""
    if not Path("/usr/bin/open").is_file():
        return
    names = {
        "workbuddy": ("WorkBuddy",), "workbuddy-ai": ("WorkBuddy AI",),
        "trae": ("Trae CN", "TRAE SOLO CN"), "trae-ai": ("Trae", "TRAE SOLO"),
        "qoder-cn": ("Qoder CN",), "qoder": ("Qoder",),
    }
    for name in names[provider]:
        for root in (Path("/Applications"), Path.home() / "Applications"):
            candidate = root / f"{name}.app"
            if candidate.is_dir():
                try:
                    subprocess.run(["/usr/bin/open", "-a", str(candidate)],
                                   timeout=5, check=False, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
                except (OSError, subprocess.SubprocessError):
                    pass
                return


def _startup_payload(process: subprocess.Popen[str], timeout: float = 75.0) -> dict[str, Any]:
    if process.stdout is None:
        raise RuntimeError("bridge did not provide a startup channel")
    messages: queue.Queue[str] = queue.Queue(maxsize=1)

    def read_first_line() -> None:
        try:
            messages.put(process.stdout.readline())
        except Exception:
            messages.put("")

    threading.Thread(target=read_first_line, daemon=True).start()
    try:
        line = messages.get(timeout=timeout)
    except queue.Empty as exc:
        raise RuntimeError("local provider bridge did not start") from exc
    if not line:
        raise RuntimeError("local provider bridge exited before startup")
    try:
        payload = json.loads(line)
    except json.JSONDecodeError as exc:
        raise RuntimeError("local provider bridge returned an invalid startup response") from exc
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise RuntimeError("local provider bridge could not read a usable sign-in")
    return payload


def _stop_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=2.0)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2.0)
    except OSError:
        pass


def _collect_completion(stream: Any) -> Any:
    """Translate the upstream's forced SSE into an ordinary OpenAI completion."""
    from openai.types.chat import ChatCompletion

    result: dict[str, Any] = {"id": "", "object": "chat.completion", "created": 0,
                              "model": "", "choices": []}
    choices: dict[int, dict[str, Any]] = {}
    try:
        for chunk in stream:
            for field in ("id", "created", "model", "system_fingerprint", "service_tier"):
                value = getattr(chunk, field, None)
                if value is not None:
                    result[field] = value
            if chunk.usage is not None:
                result["usage"] = chunk.usage.model_dump(exclude_none=True)
            for part in chunk.choices:
                choice = choices.setdefault(part.index, {"index": part.index,
                    "message": {"role": "assistant", "content": None},
                    "finish_reason": None, "logprobs": None})
                message = choice["message"]
                delta = part.delta.model_dump(exclude_none=True)
                for field, value in delta.items():
                    if field == "role":
                        message[field] = value
                    elif field == "tool_calls":
                        calls = message.setdefault("tool_calls", [])
                        for call in value:
                            index = call["index"]
                            while len(calls) <= index:
                                calls.append({"id": "", "type": "function",
                                              "function": {"name": "", "arguments": ""}})
                            target = calls[index]
                            if call.get("id"): target["id"] = call["id"]
                            if call.get("type"): target["type"] = call["type"]
                            for key, text in call.get("function", {}).items():
                                if isinstance(text, str):
                                    target["function"][key] = target["function"].get(key, "") + text
                    elif isinstance(value, str):
                        message[field] = (message.get(field) or "") + value
                    elif field == "function_call" and isinstance(value, dict):
                        function = message.setdefault(field, {})
                        for key, text in value.items():
                            if isinstance(text, str): function[key] = function.get(key, "") + text
                    else:
                        message[field] = value
                if part.finish_reason is not None:
                    choice["finish_reason"] = part.finish_reason
        result["choices"] = [choices[index] for index in sorted(choices)]
        if not result["choices"]:
            raise RuntimeError("The provider returned no completion choices")
        return ChatCompletion.model_validate(result)
    finally:
        stream.close()


class HermesDSHProfile(ProviderProfile):
    """One desktop-signed-in provider exposed through an isolated local shim."""

    auth_disconnect_hint = "Managed by the desktop app; sign out in that app. Hermes only borrows its sign-in."

    def __init__(self, name: str, engine: str, region: str, label: str) -> None:
        node = _node_command()
        super().__init__(
            name=name,
            aliases=(),
            api_mode="chat_completions",
            display_name=label,
            description=f"{label} desktop models through a Hermes-owned local bridge",
            hidden=False,
            # Hermes' process-provider lifecycle owns this local bridge. Its
            # custom client speaks HTTP to the shim, and auth_handler/auth_status
            # own app sign-in. The bundled compatibility patch keeps the Desktop
            # auth surface from mistaking the Node launcher for a login CLI.
            auth_type="external_process",
            supports_health_check=False,
            supports_model_listing=True,
            supports_vision=False,
            base_url=f"acp://hermes-dsh/{name}",
            env_vars=(),
            process_command=node or "node",
            process_args=(),
            process_command_env_vars=("HERMES_DSH_NODE",),
            fallback_models=(),
        )
        self.engine = engine
        self.region = region
        self.auth_handler = lambda action, args: _auth_handler(self.name, action, args)
        self._node = node

    def setup_status(self, **kwargs: Any) -> dict[str, Any] | None:
        return _status(self.name, node=self._node)

    def auth_status(self) -> dict[str, Any]:
        """Desktop/CLI auth status, using app credentials rather than Node's existence.

        The small Hermes auth hook shipped with this package calls this method.
        Cache only in memory; no credential or token is returned to the UI.
        """
        key = (str(_hermes_home()), self.name)
        with _STATUS_LOCK:
            cached = _STATUS_CACHE.get(key)
            if cached and monotonic() - cached[0] < 15.0:
                return dict(cached[1])
        result = _status(self.name, node=self._node)
        with _STATUS_LOCK:
            _STATUS_CACHE[key] = (monotonic(), dict(result))
        return result

    def _selected_models(self) -> set[str] | None:
        path = _state_dir(self.name) / "model-visibility.json"
        try:
            data = json.loads(path.read_text())
        except FileNotFoundError:
            return None
        selected = data.get("selected")
        if selected is None:
            return None
        if not isinstance(selected, list) or any(not isinstance(item, str) for item in selected):
            raise ValueError("Invalid model visibility settings")
        return set(selected)

    def _visible_models(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        selected = self._selected_models()
        return rows if selected is None else [row for row in rows if row["id"] in selected]

    def channel_models(self, *, refresh: bool = False) -> dict[str, Any]:
        if refresh:
            with _CATALOG_LOCKS[self.name]:
                _CATALOG_CACHE.pop((str(_hermes_home()), self.name), None)
        rows = self._model_rows() or []
        selected = self._selected_models()
        return {"all_selected": selected is None, "models": [
            {"id": row["id"], "label": str(row.get("label") or row["id"]),
             "multiplier_label": self._multiplier_label(row),
             "selected": selected is None or row["id"] in selected} for row in rows]}

    def set_channel_models(self, selected: list[str] | None) -> dict[str, Any]:
        if selected is not None:
            if not selected or len(selected) > 1000 or any(not isinstance(item, str) or not item or len(item) > 300 for item in selected):
                raise ValueError("Invalid model selection")
            # Preserve ids absent from a transient catalog: a refresh must not
            # silently throw away a user's selection.
            selected = sorted(set(selected))
        path = _state_dir(self.name) / "model-visibility.json"
        with _PREFERENCES_LOCK:
            temporary = path.with_suffix(f".{os.getpid()}.tmp")
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as handle:
                json.dump({"selected": selected}, handle)
            os.replace(temporary, path)
        return {"saved": True}

    def channel_account(self) -> dict[str, Any]:
        result = _run_bridge(self.name, "account", timeout=65, node=self._node)
        return result if result is not None else {"logged_in": False, "unavailable": True,
            "error": "渠道状态读取失败，请刷新重试"}

    def channel_checkin(self) -> dict[str, Any]:
        # State changes only on an explicit endpoint call. GETs never claim.
        with _CHECKIN_LOCKS[self.name]:
            result = _run_bridge(self.name, "checkin", timeout=65, node=self._node)
        return result if result is not None else {"claimed": False, "error": "签到请求失败，请刷新状态确认后重试"}

    def channel_login(self) -> dict[str, Any]:
        if self.setup_status().get("logged_in"):
            return {"started": False, "message": "已复用对应桌面应用登录态；切换账号请在原应用中完成，再刷新。"}
        _open_sign_in_app(self.name)
        return {"started": True, "message": "已尝试打开对应桌面应用，请在那里完成登录，然后点击刷新。"}

    def _model_rows(self, timeout: float = 40.0) -> list[dict[str, Any]] | None:
        # Model pickers and multiplier badges share one catalog. A lock prevents
        # duplicate refreshes in a process; the cache contains public metadata only.
        with _CATALOG_LOCKS[self.name]:
            key = (str(_hermes_home()), self.name)
            cached = _CATALOG_CACHE.get(key)
            if cached and monotonic() - cached[0] < _CATALOG_TTL:
                return [dict(row) for row in cached[1]]
            models = self._fetch_model_rows(timeout)
            if models:
                _CATALOG_CACHE[key] = (monotonic(), models)
            return models

    def _fetch_model_rows(self, timeout: float) -> list[dict[str, Any]] | None:
        result = _run_bridge(self.name, "models", timeout=timeout, node=self._node)
        rows = result.get("models") if result else None
        if not isinstance(rows, list):
            return None
        capabilities: dict[str, dict[str, Any]] = {}
        models: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str):
                continue
            model_id = row["id"]
            capability: dict[str, Any] = {"supports_tools": True}
            if isinstance(row.get("supports_vision"), bool):
                capability["supports_vision"] = row["supports_vision"]
            if isinstance(row.get("context_window"), int) and row["context_window"] > 0:
                capability["context_window"] = row["context_window"]
            capabilities[model_id] = capability
            models.append(row)
        if capabilities:
            self.model_capabilities = capabilities
        return models or None

    @staticmethod
    def _multiplier_label(row: dict[str, Any]) -> str:
        if row.get("rate_unknown") is True:
            return "倍率未知"
        value = row.get("multiplier")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return "倍率未知"
        formatted = f"{value:.4f}".rstrip("0").rstrip(".")
        return f"×{formatted or '0'}"

    def discover_models(self, **kwargs: Any) -> list[dict[str, Any]] | None:
        """Expose the live account catalog and its credit multiplier to Hermes pickers."""
        rows = self._model_rows(timeout=float(kwargs.get("timeout", 40.0)))
        if not rows:
            return None
        discovered: list[dict[str, str]] = []
        for row in self._visible_models(rows):
            multiplier_label = self._multiplier_label(row)
            discovered.append({
                "id": row["id"],
                "label": str(row.get("label") or row["id"]),
                "note": multiplier_label,
                "multiplier_label": multiplier_label,
            })
        return discovered

    def fetch_models(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 40.0,
    ) -> list[str] | None:
        rows = self._model_rows(timeout=timeout)
        return [row["id"] for row in self._visible_models(rows)] if rows is not None else None

    def create_client(self, **client_kwargs: Any) -> Any:
        from openai import OpenAI

        node = client_kwargs.get("command") or self._node or _node_command()
        if not node:
            raise RuntimeError(_node_requirement_error())
        if not _node_usable(str(node)):
            raise RuntimeError(_node_requirement_error())
        state = _state_dir(self.name)
        process = subprocess.Popen(
            [str(node), str(_BRIDGE), "serve", self.engine, self.region],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=_provider_env(self.engine, state),
        )
        try:
            bridge = _startup_payload(process)
            kwargs = dict(client_kwargs)
            kwargs.pop("command", None)
            kwargs.pop("args", None)
            kwargs["api_key"] = bridge["api_key"]
            kwargs["base_url"] = bridge["base_url"]
            # The shim is always loopback; inherited application proxies must
            # never carry the private bridge bearer token to a proxy server.
            if "http_client" not in kwargs:
                import httpx
                kwargs["http_client"] = httpx.Client(trust_env=False)
            client = OpenAI(**kwargs)
            original_create = client.chat.completions.create

            def create(**request: Any) -> Any:
                if request.get("stream"):
                    return original_create(**request)
                request["stream"] = True
                return _collect_completion(original_create(**request))

            client.chat.completions.create = create
        except Exception:
            _stop_process(process)
            raise

        original_close = client.close
        closed = False

        def close() -> None:
            nonlocal closed
            if closed:
                return
            closed = True
            try:
                original_close()
            finally:
                _stop_process(process)

        client.close = close
        return client


for _name, (_engine, _region, _label) in _PROVIDERS.items():
    register_provider(HermesDSHProfile(_name, _engine, _region, _label))
