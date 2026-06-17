"""Admin REST endpoints for managing team memberships (simple-auth path).

This router lets an admin list, add, remove, and re-role members of a team.
A "member" is a row in the ``memberships`` table keyed by ``(subject, team_id)``
where ``subject`` is the JWT ``sub`` claim issued by Better Auth. The
``memberships`` table is the authoritative authorization source for the
token-auth path (see ``token_auth.py``); these endpoints are how that data is
administered.

It is ADDITIVE and does not touch the team-certificate auth path. Every
endpoint is protected by the token auth dependency from ``token_auth.py`` and
scoped to a single ``{team_id}`` path segment: the caller must hold an
``admin`` (or ``owner``) role in an active membership for that team.

Wiring (done in the integration step, NOT here)::

    from aweb.routes import members
    app.include_router(members.router)
"""

from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Path
from pydantic import BaseModel, Field, field_validator

from aweb.deps import get_db
from aweb.token_auth import (
    TokenAuthContext,
    get_token_auth,
    load_membership,
)

router = APIRouter(prefix="/v1/teams", tags=["members"])


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Roles allowed to administer memberships (add/remove/set-role/list).
ADMIN_ROLES = {"admin", "owner"}

# Allowed membership statuses (mirrors the CHECK constraint in 003_simple_auth).
VALID_STATUSES = {"active", "suspended"}

# Role string bounds. Roles are free-form labels (e.g. ``member``, ``admin``),
# kept short to match the TEXT column and avoid junk values.
ROLE_MAX_LENGTH = 64
SUBJECT_MAX_LENGTH = 256


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class MemberView(BaseModel):
    subject: str
    team_id: str
    role: str
    status: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class ListMembersResponse(BaseModel):
    team_id: str
    members: list[MemberView]


class AddMemberRequest(BaseModel):
    model_config = {"extra": "forbid"}

    subject: str = Field(..., min_length=1, max_length=SUBJECT_MAX_LENGTH)
    role: str = Field(default="member", min_length=1, max_length=ROLE_MAX_LENGTH)
    status: str = Field(default="active", min_length=1, max_length=32)

    @field_validator("subject", "role")
    @classmethod
    def _strip_nonempty(cls, value: str) -> str:
        value = (value or "").strip()
        if not value:
            raise ValueError("value must not be empty")
        return value

    @field_validator("status")
    @classmethod
    def _validate_status(cls, value: str) -> str:
        value = (value or "").strip().lower()
        if value not in VALID_STATUSES:
            raise ValueError(
                f"status must be one of {', '.join(sorted(VALID_STATUSES))}"
            )
        return value


class UpdateMemberRequest(BaseModel):
    model_config = {"extra": "forbid"}

    role: Optional[str] = Field(default=None, min_length=1, max_length=ROLE_MAX_LENGTH)
    status: Optional[str] = Field(default=None, min_length=1, max_length=32)

    @field_validator("role")
    @classmethod
    def _strip_role(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("role must not be empty")
        return value

    @field_validator("status")
    @classmethod
    def _validate_status(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip().lower()
        if value not in VALID_STATUSES:
            raise ValueError(
                f"status must be one of {', '.join(sorted(VALID_STATUSES))}"
            )
        return value


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _aweb_db(db: Any):
    """Normalize the request ``db`` handle into the aweb query manager."""
    return db.get_manager("aweb") if hasattr(db, "get_manager") else db


def _iso(value: Any) -> Optional[str]:
    """Render a timestamp column as ISO-8601, or None."""
    if value is None:
        return None
    isoformat = getattr(value, "isoformat", None)
    return isoformat() if callable(isoformat) else str(value)


def _member_view(row: Any) -> MemberView:
    return MemberView(
        subject=str(row["subject"]),
        team_id=str(row["team_id"]),
        role=str(row["role"]),
        status=str(row["status"]),
        created_at=_iso(row.get("created_at")),
        updated_at=_iso(row.get("updated_at")),
    )


async def _require_team_admin(
    db: Any,
    auth: TokenAuthContext,
    team_id: str,
) -> None:
    """Authorize the caller as an admin of ``team_id``.

    The token dependency already proved the caller's identity and loaded the
    authoritative active team set. Here we additionally require that the caller
    has an *active* membership in ``team_id`` whose role is an admin role. The
    membership row (source of truth) governs the role, not the JWT ``roles``
    claim.
    """
    if not auth.has_team(team_id):
        # Don't leak whether the team exists to a non-member.
        raise HTTPException(
            status_code=403,
            detail="Not authorized for this team",
        )
    membership = await load_membership(db, auth.subject, team_id)
    if membership is None:
        raise HTTPException(
            status_code=403,
            detail="Not authorized for this team",
        )
    role = str(membership.get("role") or "").strip().lower()
    if role not in ADMIN_ROLES:
        raise HTTPException(
            status_code=403,
            detail="Admin role required to manage members",
        )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/{team_id}/members", response_model=ListMembersResponse)
async def list_members(
    team_id: str = Path(..., min_length=1, max_length=128),
    db: Any = Depends(get_db),
    auth: TokenAuthContext = Depends(get_token_auth()),
) -> ListMembersResponse:
    """List all memberships for ``team_id`` (admin only)."""
    await _require_team_admin(db, auth, team_id)
    manager = _aweb_db(db)
    rows = await manager.fetch_all(
        """
        SELECT subject, team_id, role, status, created_at, updated_at
        FROM {{tables.memberships}}
        WHERE team_id = $1
        ORDER BY subject
        """,
        team_id,
    )
    return ListMembersResponse(
        team_id=team_id,
        members=[_member_view(r) for r in rows],
    )


@router.post("/{team_id}/members", response_model=MemberView, status_code=201)
async def add_member(
    payload: AddMemberRequest,
    team_id: str = Path(..., min_length=1, max_length=128),
    db: Any = Depends(get_db),
    auth: TokenAuthContext = Depends(get_token_auth()),
) -> MemberView:
    """Add (or re-activate / update) a membership in ``team_id`` (admin only).

    Idempotent on ``(subject, team_id)``: re-adding an existing member updates
    that member's role/status rather than failing.
    """
    await _require_team_admin(db, auth, team_id)
    manager = _aweb_db(db)
    try:
        row = await manager.fetch_one(
            """
            INSERT INTO {{tables.memberships}} (subject, team_id, role, status)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (subject, team_id) DO UPDATE SET
                role = EXCLUDED.role,
                status = EXCLUDED.status,
                updated_at = NOW()
            RETURNING subject, team_id, role, status, created_at, updated_at
            """,
            payload.subject,
            team_id,
            payload.role,
            payload.status,
        )
    except Exception as exc:  # FK violation -> team does not exist, etc.
        # The team_id has a FK to teams(team_id); a missing team surfaces as a
        # database error. Translate to a 404 rather than a 500.
        raise HTTPException(
            status_code=404,
            detail=f"Team not found or membership rejected: {team_id}",
        ) from exc
    if row is None:
        raise HTTPException(status_code=500, detail="Failed to add member")
    return _member_view(row)


@router.patch("/{team_id}/members/{subject}", response_model=MemberView)
async def update_member(
    payload: UpdateMemberRequest,
    team_id: str = Path(..., min_length=1, max_length=128),
    subject: str = Path(..., min_length=1, max_length=SUBJECT_MAX_LENGTH),
    db: Any = Depends(get_db),
    auth: TokenAuthContext = Depends(get_token_auth()),
) -> MemberView:
    """Update a member's role and/or status in ``team_id`` (admin only)."""
    await _require_team_admin(db, auth, team_id)
    if payload.role is None and payload.status is None:
        raise HTTPException(
            status_code=400,
            detail="At least one of 'role' or 'status' must be provided",
        )
    manager = _aweb_db(db)
    # COALESCE keeps the existing column value when the field is omitted, so a
    # partial PATCH never clobbers the untouched attribute.
    row = await manager.fetch_one(
        """
        UPDATE {{tables.memberships}}
        SET role = COALESCE($3, role),
            status = COALESCE($4, status),
            updated_at = NOW()
        WHERE subject = $1 AND team_id = $2
        RETURNING subject, team_id, role, status, created_at, updated_at
        """,
        subject,
        team_id,
        payload.role,
        payload.status,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Member not found")
    return _member_view(row)


@router.delete("/{team_id}/members/{subject}", status_code=204)
async def remove_member(
    team_id: str = Path(..., min_length=1, max_length=128),
    subject: str = Path(..., min_length=1, max_length=SUBJECT_MAX_LENGTH),
    db: Any = Depends(get_db),
    auth: TokenAuthContext = Depends(get_token_auth()),
) -> None:
    """Remove a membership from ``team_id`` (admin only).

    This hard-deletes the row. The subject loses authorization for the team on
    its next request because ``load_active_team_ids`` no longer returns it. To
    keep an existing token from acting in the interim, also revoke its ``jti``.
    """
    await _require_team_admin(db, auth, team_id)
    manager = _aweb_db(db)
    deleted = await manager.fetch_value(
        """
        DELETE FROM {{tables.memberships}}
        WHERE subject = $1 AND team_id = $2
        RETURNING 1
        """,
        subject,
        team_id,
    )
    if deleted is None:
        raise HTTPException(status_code=404, detail="Member not found")
    return None


class RenameTeamRequest(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=80)


@router.patch("/{team_id}")
async def rename_team(
    payload: RenameTeamRequest,
    team_id: str = Path(..., min_length=1, max_length=128),
    db: Any = Depends(get_db),
    auth: TokenAuthContext = Depends(get_token_auth()),
) -> dict:
    """Set a team's mutable ``display_name`` (admin/owner only).

    ``team_id`` is the immutable PK (foreign-keyed everywhere); renaming only
    edits the user-facing label.
    """
    await _require_team_admin(db, auth, team_id)
    manager = _aweb_db(db)
    row = await manager.fetch_one(
        """
        UPDATE {{tables.teams}}
        SET display_name = $2
        WHERE team_id = $1
        RETURNING team_id, display_name
        """,
        team_id,
        payload.display_name.strip(),
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Team not found")
    return {"team_id": str(row["team_id"]), "display_name": str(row["display_name"])}


# ---------------------------------------------------------------------------
# Membership hint endpoint (server-to-server; populates the UI team switcher)
# ---------------------------------------------------------------------------

# Separate router because the hint lives at /v1/memberships, not under
# /v1/teams. The memberships table stays the authoritative authorization source
# for every request; this endpoint only feeds the UI's switcher with a hint and
# is guarded by a shared secret so memberships cannot be enumerated publicly.
hint_router = APIRouter(prefix="/v1", tags=["memberships-hint"])


@hint_router.get("/memberships")
async def memberships_hint(
    subject: str,
    db: Any = Depends(get_db),
    x_aweb_internal_key: Optional[str] = Header(default=None, alias="X-AWEB-Internal-Key"),
) -> dict:
    """Return a subject's active teams + roles for the UI team switcher.

    The Next UI calls this server-side during SSR (it has no aweb user token at
    that point). Disabled unless ``AWEB_MEMBERSHIPS_HINT_KEY`` is set; when set,
    the caller must present the matching ``X-AWEB-Internal-Key`` header.
    """
    expected = (os.getenv("AWEB_MEMBERSHIPS_HINT_KEY") or "").strip()
    if not expected:
        raise HTTPException(status_code=404, detail="memberships hint endpoint disabled")
    if not x_aweb_internal_key or not hmac.compare_digest(
        x_aweb_internal_key, expected
    ):
        raise HTTPException(status_code=401, detail="invalid internal key")

    manager = _aweb_db(db)
    rows = await manager.fetch_all(
        """
        SELECT m.team_id, m.role, t.display_name, t.team_name
        FROM {{tables.memberships}} m
        JOIN {{tables.teams}} t ON t.team_id = m.team_id
        WHERE m.subject = $1 AND m.status = 'active'
        ORDER BY m.team_id
        """,
        subject,
    )
    return {
        "team_ids": [str(r["team_id"]) for r in rows],
        "roles": sorted({str(r["role"]) for r in rows if r["role"]}),
        # Per-team display name (mutable label; falls back to team_name/id) so the
        # UI team switcher can show a friendly name instead of the raw team_id.
        "teams": [
            {
                "team_id": str(r["team_id"]),
                "display_name": (r["display_name"] or r["team_name"] or str(r["team_id"])),
                "role": str(r["role"] or ""),
            }
            for r in rows
        ],
    }


class PersonalTeamRequest(BaseModel):
    subject: str = Field(..., min_length=1, max_length=SUBJECT_MAX_LENGTH)
    name: Optional[str] = Field(default=None, max_length=120)


@hint_router.post("/onboarding/personal-team")
async def create_personal_team(
    payload: PersonalTeamRequest,
    db: Any = Depends(get_db),
    x_aweb_internal_key: Optional[str] = Header(default=None, alias="X-AWEB-Internal-Key"),
) -> dict:
    """Idempotently provision a personal team + owner membership for a freshly
    signed-up subject, so a cold signup never hits the 'ask an owner' dead-end.

    Called server-to-server from the Better Auth signup hook; guarded by the
    shared internal key. No-op if the subject already has ANY active membership
    (e.g. they arrived via an invite) — invite-joiners keep just the team they
    joined. The team_id is derived deterministically from the subject so a
    double-fired hook converges on one team instead of creating duplicates.
    """
    expected = (os.getenv("AWEB_MEMBERSHIPS_HINT_KEY") or "").strip()
    if not expected:
        raise HTTPException(status_code=404, detail="onboarding endpoint disabled")
    if not x_aweb_internal_key or not hmac.compare_digest(x_aweb_internal_key, expected):
        raise HTTPException(status_code=401, detail="invalid internal key")

    manager = _aweb_db(db)
    existing = await manager.fetch_one(
        """
        SELECT team_id FROM {{tables.memberships}}
        WHERE subject = $1 AND status = 'active'
        LIMIT 1
        """,
        payload.subject,
    )
    if existing is not None:
        return {"team_id": str(existing["team_id"]), "created": False}

    slug = hashlib.sha256(payload.subject.encode("utf-8")).hexdigest()[:10]
    team_id = f"{slug}:personal"
    name = (payload.name or "").strip()
    display_name = f"{name}'s Team" if name else "My Team"
    # team_did_key is unused on the token-auth path; a placeholder satisfies NOT NULL.
    await manager.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key, display_name)
        VALUES ($1, 'personal', $2, $3, $4)
        ON CONFLICT (team_id) DO NOTHING
        """,
        team_id,
        slug,
        f"did:key:personal-{slug}",
        display_name,
    )
    await manager.execute(
        """
        INSERT INTO {{tables.memberships}} (subject, team_id, role, status)
        VALUES ($1, $2, 'owner', 'active')
        ON CONFLICT (subject, team_id) DO UPDATE SET status = 'active', role = 'owner'
        """,
        payload.subject,
        team_id,
    )
    return {"team_id": team_id, "display_name": display_name, "created": True}
