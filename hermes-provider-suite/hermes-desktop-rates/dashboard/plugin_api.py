"""Serve non-secret model multiplier metadata to the Hermes Desktop row badge."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from threading import Lock
from time import monotonic
from typing import Any

from fastapi import APIRouter
from providers import get_provider_profile
from hermes_constants import get_hermes_home

router = APIRouter()

PROVIDER_IDS = ("workbuddy", "workbuddy-ai", "trae", "trae-ai", "qoder-cn", "qoder")
CACHE_TTL_SECONDS = 60
_CACHE_LOCK = Lock()
_CACHE: dict[str, tuple[float, dict[str, dict[str, str]]]] = {}
_REFRESHING: set[str] = set()
_REFRESHER = ThreadPoolExecutor(max_workers=1)


def _provider_rates(provider_id: str, profile: Any) -> tuple[str, dict[str, str]]:
    try:
        discover = getattr(profile, "discover_models", None)
        rows = discover() if callable(discover) else None
    except Exception:
        return provider_id, {}

    rates: dict[str, str] = {}
    if not isinstance(rows, list):
        return provider_id, rates
    for row in rows:
        if not isinstance(row, dict):
            continue
        model_id = row.get("id")
        label = row.get("multiplier_label")
        if isinstance(model_id, str) and isinstance(label, str) and label:
            rates[model_id] = label
    return provider_id, rates


def _refresh_rates(home: str) -> None:
    rates: dict[str, dict[str, str]] = {}
    try:
        profiles: dict[str, Any] = {}
        for provider_id in PROVIDER_IDS:
            try:
                profiles[provider_id] = get_provider_profile(provider_id)
            except Exception:
                profiles[provider_id] = None

        with ThreadPoolExecutor(max_workers=len(PROVIDER_IDS)) as pool:
            futures = [
                pool.submit(copy_context().run, _provider_rates, provider_id, profiles[provider_id])
                for provider_id in PROVIDER_IDS
            ]
            for future in futures:
                provider_id, provider_rates = future.result()
                rates[provider_id] = provider_rates
    except Exception:
        pass
    finally:
        with _CACHE_LOCK:
            _CACHE[home] = (monotonic(), rates)
            _REFRESHING.discard(home)


@router.get("/multipliers")
def model_multipliers() -> dict[str, Any]:
    """Return model IDs and display-only multiplier labels, never credentials."""
    home = str(get_hermes_home())
    with _CACHE_LOCK:
        now = monotonic()
        cached = _CACHE.get(home)
        if cached and now - cached[0] < CACHE_TTL_SECONDS:
            return {"rates": cached[1], "refreshing": home in _REFRESHING}

        if home not in _REFRESHING:
            _REFRESHING.add(home)
            _REFRESHER.submit(copy_context().run, _refresh_rates, home)
        # Expired promotions must not remain visible during a slow refresh.
        return {"rates": {}, "refreshing": True}


# Account/visibility administration is separate from multiplier decoration.
from pathlib import Path
import json
import os
from fastapi import HTTPException
from pydantic import BaseModel, Field

_SETTINGS_LOCK = Lock()
_LABELS = dict(zip(PROVIDER_IDS, ("WorkBuddy", "WorkBuddy AI", "Trae CN", "Trae International", "Qoder CN", "Qoder")))


def _profile(provider: str) -> Any:
    if provider not in PROVIDER_IDS:
        raise HTTPException(404, "Unknown provider")
    profile = get_provider_profile(provider)
    if profile is None or not callable(getattr(profile, "channel_account", None)):
        raise HTTPException(503, "Provider plugin needs updating")
    return profile


def _center_settings_path() -> Path:
    return Path(get_hermes_home()) / "data/dsh-model-providers/channel-center.json"


def _read_center_settings() -> dict[str, bool]:
    path = _center_settings_path()
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        value = {}
    except (ValueError, OSError):
        raise HTTPException(500, "Channel settings could not be read") from None
    if not isinstance(value, dict):
        raise HTTPException(500, "Invalid channel settings")
    return {"auto_checkin": value.get("auto_checkin") is True, "sidebar": value.get("sidebar", True) is True}


@router.get("/channels/settings")
def channel_settings() -> dict[str, bool]:
    return _read_center_settings()


class CenterSettings(BaseModel):
    auto_checkin: bool = False
    sidebar: bool = True


@router.put("/channels/settings")
def save_channel_settings(body: CenterSettings) -> dict[str, bool]:
    path = _center_settings_path()
    with _SETTINGS_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = path.with_suffix(f".{os.getpid()}.tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(body.model_dump(), handle)
        os.replace(temporary, path)
    return body.model_dump()


@router.get("/channels")
def channel_list() -> dict[str, Any]:
    def one(provider: str) -> dict[str, Any]:
        try:
            status = _profile(provider).setup_status()
            return {"id": provider, "label": _LABELS[provider], "logged_in": status.get("logged_in") is True,
                    "unavailable": status.get("available") is False}
        except Exception:
            return {"id": provider, "label": _LABELS[provider], "logged_in": False, "unavailable": True}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(copy_context().run, one, provider) for provider in PROVIDER_IDS]
        channels = [future.result() for future in futures]
    return {"channels": channels, "settings": _read_center_settings()}


@router.get("/channels/{provider}")
def channel_detail(provider: str, refresh: bool = False) -> dict[str, Any]:
    profile = _profile(provider)
    data = profile.channel_account()
    if data.get("logged_in"):
        try:
            data.update(profile.channel_models(refresh=refresh))
        except Exception:
            data.update(models=[], models_error="模型目录读取失败，请刷新重试")
    else:
        data["models"] = []
    return {"id": provider, "label": _LABELS[provider], **data}


class ModelSelection(BaseModel):
    selected: list[str] | None = Field(default=None, max_length=1000)


@router.put("/channels/{provider}/models")
def save_channel_models(provider: str, body: ModelSelection) -> dict[str, Any]:
    try:
        profile = _profile(provider)
        result = profile.set_channel_models(body.selected)
    except ValueError:
        raise HTTPException(400, "Invalid model selection") from None
    # Update just this provider's Hermes catalog cache: normal Desktop picker
    # opens read the disk cache and otherwise could keep old visibility for hours.
    from hermes_cli.models import update_provider_cache_entry
    visible = profile.fetch_models()
    if visible:
        update_provider_cache_entry(provider, visible)
    with _CACHE_LOCK:
        _CACHE.pop(str(get_hermes_home()), None)
    return result


@router.post("/channels/{provider}/login")
def channel_login(provider: str) -> dict[str, Any]:
    return _profile(provider).channel_login()


class ConfirmCheckin(BaseModel):
    confirm: bool = False


@router.post("/channels/{provider}/checkin")
def channel_checkin(provider: str, body: ConfirmCheckin) -> dict[str, Any]:
    if body.confirm is not True:
        raise HTTPException(400, "Check-in requires an explicit confirmed action")
    return _profile(provider).channel_checkin()
