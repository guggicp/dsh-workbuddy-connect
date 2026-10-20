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
