"""Thin, dependency-free request telemetry.

In-process counters + latency accumulators keyed by (method, route-template,
status-class), a timing middleware that records them and logs slow/failed
requests, and a Prometheus-text ``/metrics`` endpoint. Deliberately minimal: no
OpenTelemetry/Prometheus client dependency, and the exported series carry only
aggregate request shape — never team ids, user ids, or any payload — so the
endpoint is safe to expose without auth.

Cardinality is bounded by using the matched ROUTE TEMPLATE (``/v1/issues/{id}``)
rather than the concrete path, so per-id traffic doesn't explode the series.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from typing import Callable

from fastapi import Request, Response
from fastapi.responses import PlainTextResponse

logger = logging.getLogger("aweb.metrics")

# Requests slower than this get a structured WARNING so latency outliers surface
# in the logs even without a metrics scraper.
SLOW_REQUEST_S = 2.0

# (method, route, status_class) -> count ; and -> summed seconds
_counts: dict[tuple[str, str, str], int] = defaultdict(int)
_duration_sum: dict[tuple[str, str, str], float] = defaultdict(float)
_inflight = 0


def _route_template(request: Request) -> str:
    """Matched route template, or a bounded fallback. Concrete ids never leak in."""
    route = request.scope.get("route")
    path = getattr(route, "path", None) or getattr(route, "path_format", None)
    if path:
        return str(path)
    # Unmatched (404) — bucket without echoing the raw path.
    return "<unmatched>"


def record(method: str, route: str, status: int, duration_s: float) -> None:
    cls = f"{status // 100}xx"
    key = (method, route, cls)
    _counts[key] += 1
    _duration_sum[key] += duration_s


async def metrics_middleware(request: Request, call_next: Callable) -> Response:
    """Time each request, record aggregate metrics, log slow/errored ones."""
    global _inflight
    _inflight += 1
    start = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        _inflight -= 1
        dur = time.perf_counter() - start
        route = _route_template(request)
        record(request.method, route, status, dur)
        if status >= 500:
            logger.error(
                "request_error",
                extra={"method": request.method, "route": route, "status": status, "duration_ms": round(dur * 1000)},
            )
        elif dur >= SLOW_REQUEST_S:
            logger.warning(
                "request_slow",
                extra={"method": request.method, "route": route, "status": status, "duration_ms": round(dur * 1000)},
            )


def render_prometheus() -> str:
    """Aggregate counters + latency in Prometheus text format. No labels beyond
    method/route/status_class; no team/user/payload data."""
    lines: list[str] = []
    lines.append("# HELP aweb_requests_total Total HTTP requests.")
    lines.append("# TYPE aweb_requests_total counter")
    for (method, route, cls), n in sorted(_counts.items()):
        lines.append(
            f'aweb_requests_total{{method="{method}",route="{_esc(route)}",status="{cls}"}} {n}'
        )
    lines.append("# HELP aweb_request_duration_seconds_sum Summed request latency.")
    lines.append("# TYPE aweb_request_duration_seconds_sum counter")
    for (method, route, cls), total in sorted(_duration_sum.items()):
        lines.append(
            f'aweb_request_duration_seconds_sum{{method="{method}",route="{_esc(route)}",status="{cls}"}} {total:.6f}'
        )
    lines.append("# HELP aweb_requests_inflight In-flight requests right now.")
    lines.append("# TYPE aweb_requests_inflight gauge")
    lines.append(f"aweb_requests_inflight {_inflight}")
    return "\n".join(lines) + "\n"


def _esc(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


async def metrics_endpoint() -> PlainTextResponse:
    return PlainTextResponse(render_prometheus(), media_type="text/plain; version=0.0.4")
