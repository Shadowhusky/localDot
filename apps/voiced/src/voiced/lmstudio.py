"""The user's swap-crash rule: no voice model loads beside a huge LM Studio model."""

import http.client
import json
import urllib.request
from collections.abc import Callable
from typing import IO

LIMIT_BYTES = 30_000_000_000

Opener = Callable[[str, float], IO[bytes]]


def _open(url: str, timeout: float) -> IO[bytes]:
    return urllib.request.urlopen(url, timeout=timeout)


def lm_studio_refusal(base_url: str, opener: Opener = _open, timeout: float = 0.5) -> str | None:
    """A reason to refuse when LM Studio reports a loaded model over 30 GB, else None.

    LM Studio not running, unreachable at a broken URL, or answering oddly is not a reason to refuse.
    """
    try:
        with opener(f"{base_url}/api/v1/models", timeout) as response:
            listing = json.load(response)
    except (OSError, ValueError, http.client.HTTPException):
        return None
    models = listing.get("models") if isinstance(listing, dict) else None
    for model in models if isinstance(models, list) else []:
        if not isinstance(model, dict) or not model.get("loaded_instances"):
            continue
        size = model.get("size_bytes")
        if isinstance(size, (int, float)) and size > LIMIT_BYTES:
            return f"LM Studio has {model.get('key', 'a model')} loaded ({size / 1e9:.1f} GB)"
    return None
