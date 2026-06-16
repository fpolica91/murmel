"""Shared MCP helpers for federated mail/chat delivery."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from aweb.config import get_settings
from aweb.identity_auth_deps import MessagingAuth
from aweb.mcp.auth import AuthContext


def mcp_messaging_auth(auth: AuthContext) -> MessagingAuth:
    return MessagingAuth(
        did_key=(auth.did_key or "").strip(),
        did_aw=(auth.did_aw or "").strip() or None,
        address=(auth.address or "").strip() or None,
        team_id=auth.team_id,
        alias=auth.alias,
        agent_id=auth.agent_id,
    )


async def mcp_federation_server_key(db_infra):
    """Resolve this server's federation signing key for MCP-initiated sends.

    Idempotent: reads the cached single-row key (or generates it once) so the
    outbound MCP path can sign the Option A.2 server delivery assertion. Returns
    None only if the DB is unavailable — callers fail closed with 424.
    """
    from aweb.federation.server_key import ensure_server_key

    try:
        return await ensure_server_key(db_infra)
    except Exception:
        return None


def mcp_federation_request(
    *,
    public_origin: str | None = None,
    mail_transport: Any = None,
    chat_transport: Any = None,
    federation_server_key: Any = None,
):
    origin = (public_origin or "").strip() or get_settings().public_origin
    # Load the SAME peer allowlist the REST path uses, so MCP-initiated federated
    # sends honor the Option A.2 "allowlist configured => fail closed for unpinned
    # domains" rule instead of falling back to an unpinned recipient origin.
    import os

    from aweb.federation.server_key import PEERS_ENV, load_federation_peers

    by_domain, by_origin = load_federation_peers(os.getenv(PEERS_ENV))
    state = SimpleNamespace(
        public_origin=origin,
        federation_mail_transport=mail_transport,
        federation_chat_transport=chat_transport,
        federation_message_transport=chat_transport,
        federation_server_key=federation_server_key,
        federation_peers_by_domain=by_domain,
        federation_peers_by_origin=by_origin,
    )
    app = SimpleNamespace(state=state)
    return SimpleNamespace(app=app, headers={})


def registry_delivery_origin(resolution) -> str:
    delivery = getattr(resolution, "delivery", None)
    return str(getattr(delivery, "origin", "") or "").strip()
