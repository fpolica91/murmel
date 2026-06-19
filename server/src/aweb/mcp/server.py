"""aweb MCP server factory.

Creates an MCP-over-Streamable-HTTP ASGI app that exposes aweb coordination
primitives as MCP tools. Designed to be mounted alongside the REST API::

    from aweb.mcp import create_mcp_app
    mcp_app = create_mcp_app(db_infra=infra, redis=redis)
    fastapi_app.mount("/mcp", mcp_app)
"""

from __future__ import annotations

import asyncio
import json as _json
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from redis.asyncio import Redis

from awid.registry import RegistryClient
from awid.ratelimit import (
    NoOpRateLimiter,
    RedisFixedWindowRateLimiter,
    _rate_config,
)

from aweb.config import get_awid_registry_url
from aweb.db import DatabaseInfra
from aweb.mcp.auth import MCPAuthMiddleware, get_auth
from aweb.mcp.signing import HostedMessageDecryptor, HostedMessageEncryptor, HostedMessageSigner
from aweb.mcp.tools.agents import heartbeat as _heartbeat_impl
from aweb.mcp.tools.agents import list_agents as _list_agents_impl
from aweb.mcp.tools.chat import chat_history as _chat_history_impl
from aweb.mcp.tools.chat import chat_pending as _chat_pending_impl
from aweb.mcp.tools.chat import chat_read as _chat_read_impl
from aweb.mcp.tools.chat import chat_send as _chat_send_impl
from aweb.mcp.tools.contacts import add_contact_by_email as _add_contact_by_email_impl
from aweb.mcp.tools.contacts import add_contact_by_handle as _add_contact_by_handle_impl
from aweb.mcp.tools.contacts import contacts_add as _contacts_add_impl
from aweb.mcp.tools.contacts import contacts_remove as _contacts_remove_impl
from aweb.mcp.tools.contacts import list_contacts_tool as _list_contacts_tool_impl
from aweb.mcp.tools.contacts import send_message_to_contact as _send_message_to_contact_impl
from aweb.mcp.tools.contacts import read_messages_from_contact as _read_messages_from_contact_impl
from aweb.mcp.tools.hierarchy import epics_create as _epics_create_impl
from aweb.mcp.tools.hierarchy import epics_list as _epics_list_impl
from aweb.mcp.tools.hierarchy import issues_claim as _issues_claim_impl
from aweb.mcp.tools.hierarchy import issues_comment_add as _issues_comment_add_impl
from aweb.mcp.tools.hierarchy import issues_comments_list as _issues_comments_list_impl
from aweb.mcp.tools.hierarchy import issues_add_dependency as _issues_add_dependency_impl
from aweb.mcp.tools.hierarchy import issues_remove_dependency as _issues_remove_dependency_impl
from aweb.mcp.tools.hierarchy import issues_create as _issues_create_impl
from aweb.mcp.tools.hierarchy import issues_dependencies as _issues_dependencies_impl
from aweb.mcp.tools.hierarchy import issues_get as _issues_get_impl
from aweb.mcp.tools.hierarchy import issues_list as _issues_list_impl
from aweb.mcp.tools.hierarchy import issues_update_status as _issues_update_status_impl
from aweb.mcp.tools.hierarchy import stories_create as _stories_create_impl
from aweb.mcp.tools.hierarchy import stories_list as _stories_list_impl
from aweb.mcp.tools.identity import whoami as _whoami_impl
from aweb.mcp.tools.mail import check_inbox as _check_inbox_impl
from aweb.mcp.tools.mail import send_mail as _send_mail_impl
from aweb.mcp.tools.team_instructions import instructions_history as _instructions_history_impl
from aweb.mcp.tools.team_instructions import instructions_show as _instructions_show_impl
from aweb.mcp.tools.team_roles import roles_show as _roles_show_impl
from aweb.mcp.tools.team_roles import roles_list as _roles_list_impl
from aweb.mcp.tools.work import work_active as _work_active_impl
from aweb.mcp.tools.work import work_blocked as _work_blocked_impl
from aweb.mcp.tools.work import work_ready as _work_ready_impl
from aweb.mcp.tools.workspace import workspace_status as _workspace_status_impl

class NormalizeMountedMCPPathMiddleware:
    """Rewrite exact /mcp requests to /mcp/ before FastAPI routing.

    Some browser MCP clients normalize the advertised resource URL by dropping
    the trailing slash, then send requests to ``/mcp``. FastAPI/Starlette will
    otherwise redirect or mount the sub-app with an empty inner path, which
    breaks FastMCP's expectation that the streamable endpoint lives at ``/``.
    """

    def __init__(self, app: Any, *, mount_path: str = "/mcp") -> None:
        self.app = app
        self.mount_path = mount_path.rstrip("/") or "/mcp"

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") == "http":
            path = scope.get("path") or ""
            if path == self.mount_path:
                scope = dict(scope)
                normalized = f"{self.mount_path}/"
                scope["path"] = normalized
                scope["raw_path"] = normalized.encode("utf-8")
        await self.app(scope, receive, send)


class ManagedMCPApp:
    """ASGI wrapper that lets a mounted FastMCP app manage its own lifecycle.

    Mounted ASGI sub-applications do not have their lifespan handlers invoked by
    the parent FastAPI app, but FastMCP's Streamable HTTP transport depends on
    its session manager running. The parent app must therefore call
    ``startup()`` and ``shutdown()`` explicitly.
    """

    def __init__(self, app: Any, session_manager: Any) -> None:
        self.app = app
        self._session_manager = session_manager
        self._runner_task: asyncio.Task[None] | None = None
        self._started = asyncio.Event()
        self._shutdown = asyncio.Event()

    async def startup(self) -> None:
        if self._runner_task is not None:
            return

        async def _runner() -> None:
            async with self._session_manager.run():
                self._started.set()
                await self._shutdown.wait()

        self._started.clear()
        self._shutdown.clear()
        self._runner_task = asyncio.create_task(_runner())
        while not self._started.is_set():
            if self._runner_task.done():
                await self._runner_task
            await asyncio.sleep(0)

    async def shutdown(self) -> None:
        if self._runner_task is None:
            return
        self._shutdown.set()
        await self._runner_task
        self._runner_task = None

    async def __call__(self, scope, receive, send) -> None:
        normalized_scope = scope
        path = scope.get("path")
        if not path:
            # When mounted at /mcp, some clients hit the exact mount path
            # (/mcp without a trailing slash). Starlette passes that through to
            # the mounted app with an empty inner path, but FastMCP expects the
            # streamable HTTP endpoint at "/". Normalize the empty inner path so
            # /mcp and /mcp/ behave identically.
            normalized_scope = dict(scope)
            normalized_scope["path"] = "/"
            normalized_scope["raw_path"] = b"/"
        await self.app(normalized_scope, receive, send)


async def _enforce_mcp_send_rate_limit(redis: Optional[Redis], bucket: str) -> str | None:
    """Apply the same per-identity send budget the REST routes enforce.

    The MCP send tools call the coordination layer directly, bypassing the
    FastAPI rate_limit_dep, so a token caller could otherwise flood mail/chat.
    Key on the authenticated subject (agent_id/DID), NOT IP — one human/agent
    shares an IP with the whole stack. Returns an error JSON string when the
    caller is over budget, else None.
    """
    limiter = RedisFixedWindowRateLimiter(redis=redis) if redis is not None else NoOpRateLimiter()
    try:
        auth = get_auth()
    except RuntimeError:
        # No auth context (MCPAuthMiddleware always sets one in production; this
        # guards direct/unit invocations). Nothing to key on, so don't block.
        return None
    key = (auth.agent_id or auth.did_key or auth.did_aw or "anonymous").strip() or "anonymous"
    limit, window = _rate_config(bucket)
    decision = await limiter.hit(bucket=bucket, key=key, limit=limit, window_seconds=window)
    if decision.allowed:
        return None
    return _json.dumps(
        {"error": "rate limit exceeded", "retry_after_seconds": decision.retry_after_seconds()}
    )


def register_tools(
    mcp: FastMCP,
    db_infra: DatabaseInfra,
    redis: Optional[Redis],
    registry_client: RegistryClient,
    hosted_signer: HostedMessageSigner | None = None,
    hosted_encryptor: HostedMessageEncryptor | None = None,
    hosted_decryptor: HostedMessageDecryptor | None = None,
    federation_mail_transport=None,
    federation_chat_transport=None,
    public_origin: str | None = None,
) -> None:
    """Register all aweb MCP tools on *mcp*.

    Call this on your own :class:`FastMCP` instance to compose aweb tools
    alongside additional tools.  Pass ``redis=None`` if Redis is unavailable;
    presence-related tools will degrade gracefully.
    """

    # -- Identity --

    @mcp.tool(
        name="whoami",
        description="Show the authenticated agent identity and team scope.",
    )
    async def whoami() -> str:
        return await _whoami_impl(db_infra)

    # -- Mail --

    @mcp.tool(
        name="send_mail",
        description=(
            "Send async mail with a required body by recipient, or continue an existing "
            "mail conversation by conversation_id. Hosted custodial sends encrypt by "
            "default when the recipient has an E2E key; set plaintext=true only for "
            "explicit server-readable mail."
        ),
    )
    async def send_mail(
        to: str = "",
        body: str = "",
        conversation_id: str = "",
        subject: str = "",
        priority: str = "normal",
        plaintext: bool = False,
    ) -> str:
        if (limited := await _enforce_mcp_send_rate_limit(redis, "mail_send")) is not None:
            return limited
        return await _send_mail_impl(
            db_infra,
            registry_client=registry_client,
            hosted_signer=hosted_signer,
            hosted_encryptor=hosted_encryptor,
            to=to,
            conversation_id=conversation_id,
            subject=subject,
            body=body,
            priority=priority,
            plaintext=plaintext,
            federation_transport=federation_mail_transport,
            public_origin=public_origin,
        )

    @mcp.tool(
        name="check_mail",
        description=(
            "Check hosted mail. Hosted custodial identities decrypt encrypted E2E "
            "mail for this MCP session; self-custodial encrypted content remains metadata-only."
        ),
    )
    async def check_mail(
        unread_only: bool = True, limit: int = 50, include_bodies: bool = True
    ) -> str:
        return await _check_inbox_impl(
            db_infra,
            hosted_decryptor=hosted_decryptor,
            unread_only=unread_only,
            limit=limit,
            include_bodies=include_bodies,
        )

    # -- Agents --

    @mcp.tool(
        name="list_agents",
        description="List all agents in the current team with online status.",
    )
    async def list_agents() -> str:
        return await _list_agents_impl(db_infra, redis)

    @mcp.tool(
        name="heartbeat",
        description="Send a heartbeat to maintain agent presence (online status).",
    )
    async def heartbeat() -> str:
        return await _heartbeat_impl(db_infra, redis)

    # -- Chat --

    @mcp.tool(
        name="send_chat",
        description=(
            "Send a real-time chat message. Provide to for a routable address, "
            "DID, hosted handle, or same-team local alias, or conversation_id "
            "to reply in an existing conversation. Set wait=true to block until "
            "the other agent replies (recommended for conversations). Hosted "
            "custodial sends encrypt by default; set plaintext=true only for "
            "explicit server-readable chat."
        ),
    )
    async def send_chat(
        to: str = "",
        message: str = "",
        conversation_id: str = "",
        wait: bool = False,
        wait_seconds: int = 120,
        leaving: bool = False,
        hang_on: bool = False,
        plaintext: bool = False,
    ) -> str:
        if (limited := await _enforce_mcp_send_rate_limit(redis, "chat_send")) is not None:
            return limited
        recipient_ref = to.strip()
        to_alias = ""
        to_did = ""
        to_address = ""
        if recipient_ref.startswith("did:aw:") or recipient_ref.startswith("did:key:"):
            to_did = recipient_ref
        elif "/" in recipient_ref or recipient_ref.startswith("@"):
            to_address = recipient_ref
        else:
            to_alias = recipient_ref
        return await _chat_send_impl(
            db_infra,
            redis,
            registry_client=registry_client,
            hosted_signer=hosted_signer,
            hosted_encryptor=hosted_encryptor,
            hosted_decryptor=hosted_decryptor,
            message=message,
            to_alias=to_alias,
            to_did=to_did,
            to_address=to_address,
            session_id=conversation_id,
            wait=wait,
            wait_seconds=wait_seconds,
            leaving=leaving,
            hang_on=hang_on,
            plaintext=plaintext,
            federation_transport=federation_chat_transport,
            public_origin=public_origin,
        )

    @mcp.tool(
        name="check_chats",
        description="List chat conversations with unread messages waiting for you.",
    )
    async def check_chats() -> str:
        return await _chat_pending_impl(db_infra, redis, hosted_decryptor=hosted_decryptor)

    @mcp.tool(
        name="read_chat",
        description="Get message history for a chat session.",
    )
    async def read_chat(
        conversation_id: str,
        unread_only: bool = False,
        limit: int = 50,
    ) -> str:
        return await _chat_history_impl(
            db_infra,
            session_id=conversation_id,
            unread_only=unread_only,
            limit=limit,
            hosted_decryptor=hosted_decryptor,
        )

    @mcp.tool(
        name="mark_chat_read",
        description="Mark chat messages as read up to a given message ID.",
    )
    async def mark_chat_read(conversation_id: str, up_to_message_id: str) -> str:
        return await _chat_read_impl(
            db_infra, session_id=conversation_id, up_to_message_id=up_to_message_id
        )

    # -- Hierarchy (Epic -> Story -> Issue) --

    @mcp.tool(
        name="issues_create",
        description="Create an issue in the current team, optionally under an epic and/or story.",
    )
    async def issues_create(
        title: str,
        description: str = "",
        status: str = "todo",
        epic_id: str = "",
        story_id: str = "",
        assignee_type: str = "",
        assignee_id: str = "",
    ) -> str:
        return await _issues_create_impl(
            db_infra,
            title=title,
            description=description,
            status=status,
            epic_id=epic_id,
            story_id=story_id,
            assignee_type=assignee_type,
            assignee_id=assignee_id,
        )

    @mcp.tool(
        name="issues_list",
        description="List issues in the current team, filtered by status, assignee, epic, and/or story.",
    )
    async def issues_list(
        status: str = "",
        assignee_type: str = "",
        assignee_id: str = "",
        epic_id: str = "",
        story_id: str = "",
    ) -> str:
        return await _issues_list_impl(
            db_infra,
            status=status,
            assignee_type=assignee_type,
            assignee_id=assignee_id,
            epic_id=epic_id,
            story_id=story_id,
        )

    @mcp.tool(
        name="issues_get",
        description="Get an issue by UUID in the current team.",
    )
    async def issues_get(issue_id: str) -> str:
        return await _issues_get_impl(db_infra, issue_id=issue_id)

    @mcp.tool(
        name="issues_dependencies",
        description="Get an issue's dependency neighbours (what blocks it and what it blocks).",
    )
    async def issues_dependencies(issue_id: str) -> str:
        return await _issues_dependencies_impl(db_infra, issue_id=issue_id)

    @mcp.tool(
        name="issues_claim",
        description="Claim an issue for the authenticated actor (defaults to the agent alias).",
    )
    async def issues_claim(
        issue_id: str,
        assignee_type: str = "agent",
        assignee_id: str = "",
    ) -> str:
        return await _issues_claim_impl(
            db_infra,
            issue_id=issue_id,
            assignee_type=assignee_type,
            assignee_id=assignee_id,
        )

    @mcp.tool(
        name="issues_update_status",
        description="Update the status of an issue in the current team.",
    )
    async def issues_update_status(issue_id: str, status: str) -> str:
        return await _issues_update_status_impl(
            db_infra,
            issue_id=issue_id,
            status=status,
        )

    @mcp.tool(
        name="issues_comment_add",
        description="Post a comment to an issue's thread (the human/agent discussion surface).",
    )
    async def issues_comment_add(issue_id: str, body: str) -> str:
        return await _issues_comment_add_impl(
            db_infra,
            issue_id=issue_id,
            body=body,
        )

    @mcp.tool(
        name="issues_comments_list",
        description="List an issue's comments, oldest first.",
    )
    async def issues_comments_list(issue_id: str) -> str:
        return await _issues_comments_list_impl(db_infra, issue_id=issue_id)

    @mcp.tool(name="epics_create", description="Create an epic (top of the work hierarchy).")
    async def epics_create(title: str, status: str = "open") -> str:
        return await _epics_create_impl(db_infra, title=title, status=status)

    @mcp.tool(name="epics_list", description="List epics in the current team.")
    async def epics_list(status: str = "") -> str:
        return await _epics_list_impl(db_infra, status=status)

    @mcp.tool(name="stories_create", description="Create a story, optionally under an epic.")
    async def stories_create(title: str, epic_id: str = "", status: str = "open") -> str:
        return await _stories_create_impl(db_infra, title=title, epic_id=epic_id, status=status)

    @mcp.tool(name="stories_list", description="List stories in the current team, optionally by epic.")
    async def stories_list(epic_id: str = "", status: str = "") -> str:
        return await _stories_list_impl(db_infra, epic_id=epic_id, status=status)

    # -- Roles --

    @mcp.tool(
        name="instructions_show",
        description="Show the active shared team instructions or a requested instructions version.",
    )
    async def instructions_show(team_instructions_id: str = "") -> str:
        return await _instructions_show_impl(
            db_infra, team_instructions_id=team_instructions_id
        )

    @mcp.tool(
        name="instructions_history",
        description="List recent shared team instructions versions.",
    )
    async def instructions_history(limit: int = 20) -> str:
        return await _instructions_history_impl(db_infra, limit=limit)

    @mcp.tool(
        name="roles_show",
        description="Show the active team roles bundle and the current agent's selected role.",
    )
    async def roles_show(only_selected: bool = False) -> str:
        return await _roles_show_impl(db_infra, only_selected=only_selected)

    @mcp.tool(
        name="roles_list",
        description="List available roles from the active team roles bundle.",
    )
    async def roles_list() -> str:
        return await _roles_list_impl(db_infra)

    # -- Work --

    @mcp.tool(
        name="work_ready",
        description="List ready issues (status=todo, unassigned, and not blocked by an incomplete dependency) for the current team.",
    )
    async def work_ready() -> str:
        return await _work_ready_impl(db_infra)

    @mcp.tool(
        name="work_active",
        description="List active in-progress issues across the team.",
    )
    async def work_active() -> str:
        return await _work_active_impl(db_infra)

    @mcp.tool(
        name="work_blocked",
        description="List issues blocked by an incomplete dependency (waiting on other issues to be done).",
    )
    async def work_blocked() -> str:
        return await _work_blocked_impl(db_infra)

    @mcp.tool(
        name="issues_add_dependency",
        description="Mark an issue as depending on (blocked by) another issue. Blocked issues are withheld from work_ready until every issue they depend on is done. Rejects self-dependencies and cycles.",
    )
    async def issues_add_dependency(issue_id: str, depends_on_id: str) -> str:
        return await _issues_add_dependency_impl(
            db_infra, issue_id=issue_id, depends_on_id=depends_on_id
        )

    @mcp.tool(
        name="issues_remove_dependency",
        description="Remove a dependency edge between two issues.",
    )
    async def issues_remove_dependency(issue_id: str, depends_on_id: str) -> str:
        return await _issues_remove_dependency_impl(
            db_infra, issue_id=issue_id, depends_on_id=depends_on_id
        )

    # -- Workspace --

    @mcp.tool(
        name="workspace_status",
        description="Show self/team coordination status for the current agent.",
    )
    async def workspace_status(limit: int = 15) -> str:
        return await _workspace_status_impl(db_infra, redis, limit=limit)

    # -- Contacts --

    @mcp.tool(
        name="list_contacts",
        description="List saved contacts for the authenticated identity.",
    )
    async def list_contacts() -> str:
        return await _list_contacts_tool_impl(db_infra)

    @mcp.tool(
        name="add_contact",
        description="Add a contact by routable address.",
    )
    async def add_contact(address: str, label: str = "") -> str:
        return await _contacts_add_impl(db_infra, contact_address=address, label=label)

    @mcp.tool(
        name="add_contact_by_handle",
        description="Add a pending contact by @handle or @handle/agent.",
    )
    async def add_contact_by_handle(handle: str, label: str = "") -> str:
        return await _add_contact_by_handle_impl(db_infra, handle=handle, label=label)

    @mcp.tool(
        name="remove_contact",
        description="Remove a saved contact.",
    )
    async def remove_contact(contact_id: str) -> str:
        return await _contacts_remove_impl(db_infra, contact_id=contact_id)

    @mcp.tool(
        name="read_contact_messages",
        description=(
            "Read hosted mail or chat messages exchanged with a saved contact. "
            "Encrypted E2E mail content is returned as metadata only; read it in a local aw client."
        ),
    )
    async def read_contact_messages(
        contact_id: str,
        channel: str = "mail",
        limit: int = 50,
    ) -> str:
        return await _read_messages_from_contact_impl(
            db_infra,
            registry_client=registry_client,
            contact_id=contact_id,
            channel=channel,
            limit=limit,
        )

    # -- Contact messaging (distinct ops — not channel send/check) --

    @mcp.tool(
        name="add_contact_by_email",
        description="Add a pending contact by email address.",
    )
    async def add_contact_by_email(email: str, label: str = "") -> str:
        return await _add_contact_by_email_impl(db_infra, email=email, label=label)

    @mcp.tool(
        name="send_message_to_contact",
        description=(
            "Send hosted server-readable mail or chat to a saved contact by contact_id. "
            "Not E2E; use a local aw client for E2E messaging."
        ),
    )
    async def send_message_to_contact(
        contact_id: str,
        message: str,
        subject: str = "",
        channel: str = "mail",
        priority: str = "normal",
        wait: bool = False,
        wait_seconds: int = 120,
    ) -> str:
        return await _send_message_to_contact_impl(
            db_infra,
            redis=redis,
            registry_client=registry_client,
            hosted_signer=hosted_signer,
            hosted_encryptor=hosted_encryptor,
            contact_id=contact_id,
            message=message,
            subject=subject,
            channel=channel,
            priority=priority,
            wait=wait,
            wait_seconds=wait_seconds,
            federation_mail_transport=federation_mail_transport,
            federation_chat_transport=federation_chat_transport,
            public_origin=public_origin,
        )



def create_mcp_app(
    *,
    db_infra: DatabaseInfra,
    redis: Optional[Redis] = None,
    registry_client: RegistryClient | None = None,
    hosted_signer: HostedMessageSigner | None = None,
    hosted_encryptor: HostedMessageEncryptor | None = None,
    hosted_decryptor: HostedMessageDecryptor | None = None,
    federation_mail_transport=None,
    federation_chat_transport=None,
    public_origin: str | None = None,
    streamable_http_path: str = "/",
) -> Any:
    """Create an MCP ASGI app for aweb tools.

    The returned app handles Streamable HTTP transport and can be mounted on
    any ASGI framework (FastAPI, Starlette, etc.)::

        fastapi_app.mount("/mcp", create_mcp_app(db_infra=infra))

    When mounted at ``/mcp`` with the default ``streamable_http_path="/"``,
    the external MCP endpoint is ``/mcp/``.
    """
    normalized_path = streamable_http_path.strip() or "/"
    if not normalized_path.startswith("/"):
        normalized_path = f"/{normalized_path}"
    if normalized_path != "/" and normalized_path.endswith("/"):
        normalized_path = normalized_path.rstrip("/")

    mcp = FastMCP(
        "aweb",
        stateless_http=True,
        json_response=True,
        streamable_http_path=normalized_path,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=False,
        ),
    )

    if registry_client is None:
        registry_client = RegistryClient(registry_url=get_awid_registry_url())

    register_tools(
        mcp,
        db_infra,
        redis,
        registry_client,
        hosted_signer=hosted_signer,
        hosted_encryptor=hosted_encryptor,
        hosted_decryptor=hosted_decryptor,
        federation_mail_transport=federation_mail_transport,
        federation_chat_transport=federation_chat_transport,
        public_origin=public_origin,
    )

    # streamable_http_app() returns a Starlette app with its own lifespan, but
    # mounted sub-applications do not receive lifespan events from FastAPI.
    # Wrap the app so the parent can start/stop the session manager explicitly.
    inner = mcp.streamable_http_app()
    return ManagedMCPApp(MCPAuthMiddleware(inner, db_infra), mcp.session_manager)
