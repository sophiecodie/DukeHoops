"""Polite HTTP client shared by all ingestion scripts.

- On-disk cache (so re-runs don't re-hit sources): JSON responses as .json, HTML/text as .html
- Fixed delay between live requests (rate limiting)
- Retries with exponential backoff on network errors / 429 / 5xx (honoring Retry-After on 429)
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any, Callable, TypeVar

import requests

log = logging.getLogger("ingest.http")

CACHE_DIR = Path(__file__).parent / ".cache"
USER_AGENT = "duke-hoops-intel-ingest/0.1 (educational, non-commercial)"

T = TypeVar("T")


class _NotFound(Exception):
    """Internal signal: the source says this resource doesn't exist (don't retry, don't cache)."""


def _retry_after_s(resp: requests.Response) -> float | None:
    """Seconds from a Retry-After header (delta-seconds form only), if present."""
    v = resp.headers.get("Retry-After")
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None


class HttpClient:
    def __init__(self, delay_s: float = 0.35, max_retries: int = 4, cache_ttl_s: int | None = None):
        self.delay_s = delay_s
        self.max_retries = max_retries
        self.cache_ttl_s = cache_ttl_s  # None = cache forever
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self._last_request = 0.0
        self.live_requests = 0
        self.cache_hits = 0
        CACHE_DIR.mkdir(exist_ok=True)

    def _cache_path(self, url: str, ext: str = ".json") -> Path:
        return CACHE_DIR / (hashlib.sha1(url.encode()).hexdigest() + ext)

    def _fetch(
        self,
        url: str,
        *,
        ext: str,
        use_cache: bool,
        ttl_s: int | None,
        parse: Callable[[requests.Response], T],
        load: Callable[[str], T],
        dump: Callable[[T], str],
    ) -> T | None:
        """Shared cache → rate limit → retry loop. Returns None on a 404 or after exhausting retries."""
        ttl = self.cache_ttl_s if ttl_s == -1 else ttl_s
        url = url.replace("http://", "https://", 1)
        path = self._cache_path(url, ext)
        if use_cache and path.exists():
            age = time.time() - path.stat().st_mtime
            if ttl is None or age < ttl:
                self.cache_hits += 1
                return load(path.read_text(encoding="utf-8"))

        for attempt in range(self.max_retries + 1):
            wait = self.delay_s - (time.time() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            self._last_request = time.time()
            backoff = min(30, 1.5 * 2**attempt)
            try:
                resp = self.session.get(url, timeout=20)
                self.live_requests += 1
                if resp.status_code == 404:
                    return None
                if resp.status_code == 429:
                    retry_after = _retry_after_s(resp)
                    if retry_after is not None:
                        backoff = max(backoff, retry_after)
                    raise requests.HTTPError("HTTP 429")
                if resp.status_code >= 500:
                    raise requests.HTTPError(f"HTTP {resp.status_code}")
                resp.raise_for_status()
                data = parse(resp)
                path.write_text(dump(data), encoding="utf-8")
                return data
            except _NotFound:
                return None
            except (requests.RequestException, ValueError) as exc:
                log.warning("GET %s failed (%s); retry %d in %.1fs", url, exc, attempt + 1, backoff)
                time.sleep(backoff)
        log.error("Giving up on %s", url)
        return None

    def get_json(self, url: str, *, use_cache: bool = True, ttl_s: int | None = -1) -> Any | None:
        """GET a URL and parse JSON. Returns None on a 404 or after exhausting retries.

        ttl_s=-1 means "use the client default".
        """

        def parse(resp: requests.Response) -> Any:
            data = resp.json()
            if isinstance(data, dict) and data.get("error", {}).get("code") == 404:
                raise _NotFound
            return data

        return self._fetch(url, ext=".json", use_cache=use_cache, ttl_s=ttl_s,
                           parse=parse, load=json.loads, dump=json.dumps)

    def get_text(self, url: str, *, use_cache: bool = True, ttl_s: int | None = -1) -> str | None:
        """GET a URL and return the raw body (HTML pages). Same caching/retry rules as get_json."""
        return self._fetch(url, ext=".html", use_cache=use_cache, ttl_s=ttl_s,
                           parse=lambda r: r.text, load=lambda s: s, dump=lambda s: s)
