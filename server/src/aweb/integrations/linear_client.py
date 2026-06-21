"""Minimal async client for Linear's GraphQL API (read-only).

Endpoint: https://api.linear.app/graphql. A **personal API key** is sent as the
RAW value of the ``Authorization`` header (NOT ``Bearer <key>`` — that form is
for OAuth access tokens). If a live pull 401s, that header is the first thing to
check; ``_auth_header`` isolates it so flipping to Bearer is a one-line change.

``transport`` is injectable so tests can drive the client against a mock
httpx transport with canned Linear responses — no network, no key.
"""

from __future__ import annotations

from typing import Any, Optional

import httpx

LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"

# Issues query: paginated, with just the fields the importer maps.
_ISSUES_QUERY = """
query Issues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter) {
    nodes {
      id
      identifier
      title
      description
      updatedAt
      state { name type }
      assignee { email name }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""


class LinearError(RuntimeError):
    """A Linear API error (transport failure or GraphQL ``errors``)."""


def _auth_header(api_key: str) -> dict[str, str]:
    # Personal API keys: raw key in Authorization. (OAuth would use Bearer.)
    return {"Authorization": api_key}


class LinearClient:
    def __init__(
        self,
        api_key: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._api_key = api_key
        self._transport = transport
        self._timeout = timeout

    async def _post(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        headers = {"Content-Type": "application/json", **_auth_header(self._api_key)}
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=self._timeout
            ) as client:
                resp = await client.post(
                    LINEAR_GRAPHQL_URL,
                    json={"query": query, "variables": variables},
                    headers=headers,
                )
        except httpx.RequestError as exc:
            raise LinearError(f"Linear request failed: {exc}") from exc
        if resp.status_code == 401:
            raise LinearError("Linear auth failed (401) — check LINEAR_API_KEY.")
        if resp.status_code >= 400:
            raise LinearError(f"Linear HTTP {resp.status_code}: {resp.text[:300]}")
        body = resp.json()
        if body.get("errors"):
            raise LinearError(f"Linear GraphQL errors: {body['errors']}")
        return body.get("data") or {}

    async def fetch_all_issues(
        self, *, team_key: Optional[str] = None, page_size: int = 50, max_pages: int = 40
    ) -> list[dict[str, Any]]:
        """All issues (paginated), optionally filtered to one Linear team by its
        key (e.g. "ENG"). ``max_pages`` bounds a runaway import."""
        filt: Optional[dict[str, Any]] = (
            {"team": {"key": {"eq": team_key}}} if team_key else None
        )
        out: list[dict[str, Any]] = []
        after: Optional[str] = None
        for _ in range(max_pages):
            data = await self._post(
                _ISSUES_QUERY,
                {"first": page_size, "after": after, "filter": filt},
            )
            block = (data or {}).get("issues") or {}
            out.extend(block.get("nodes") or [])
            page = block.get("pageInfo") or {}
            if not page.get("hasNextPage"):
                break
            after = page.get("endCursor")
        return out
