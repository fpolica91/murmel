"""Team shared-memory endpoints + service.

A memory is a team-scoped, titled, markdown, taggable note. Agents read the
team's memories on session start (``memory_search``) and write what they learn
(``memory_save``) so knowledge carries across sessions. The pure service
functions here are the shared core called by BOTH the REST router (this file)
and the MCP tools (``aweb.mcp.tools.memory``) -- one place that enforces the
team-scope invariant: every query filters ``team_id`` and never trusts a
client-supplied team; ``created_by_alias`` is stamped server-side.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import List, Optional, Sequence

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pgdbm import AsyncDatabaseManager
from pydantic import BaseModel, Field

from aweb.deps import get_db
from aweb.team_auth_deps import TeamIdentity, get_team_identity

logger = logging.getLogger(__name__)

memories_router = APIRouter(prefix="/v1/memories", tags=["memories"])
router = memories_router

# Body cap matches TeamInstructionsDocument so one note can't pin a large blob.
_MAX_BODY = 262144
_MAX_TITLE = 256
_MAX_TAG = 64
_MAX_TAGS = 32

_COLUMNS = (
    "memory_id, team_id, title, body_md, tags, "
    "created_by_alias, assignee_alias, created_at, updated_at"
)


class MemoryView(BaseModel):
    memory_id: str
    team_id: str
    title: str
    body_md: str
    tags: List[str]
    created_by_alias: Optional[str] = None
    assignee_alias: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class CreateMemoryRequest(BaseModel):
    title: str = Field(min_length=1, max_length=_MAX_TITLE)
    body_md: str = Field(default="", max_length=_MAX_BODY)
    tags: List[str] = Field(default_factory=list)
    assignee_alias: Optional[str] = None


class UpdateMemoryRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=_MAX_TITLE)
    body_md: Optional[str] = Field(default=None, max_length=_MAX_BODY)
    tags: Optional[List[str]] = None
    assignee_alias: Optional[str] = None


class ListMemoriesResponse(BaseModel):
    memories: List[MemoryView]


def _clean_tags(tags: Optional[Sequence[str]]) -> List[str]:
    """Normalize free-form tags: strip, drop empties/'memory', dedupe (order-
    preserving), enforce per-tag length and a tag-count cap. Raises ValueError."""
    if not tags:
        return []
    out: List[str] = []
    seen = set()
    for raw in tags:
        tag = (raw or "").strip()
        if not tag:
            continue
        if len(tag) > _MAX_TAG:
            raise ValueError(f"tag exceeds {_MAX_TAG} characters: {tag[:16]}...")
        if tag in seen:
            continue
        seen.add(tag)
        out.append(tag)
    if len(out) > _MAX_TAGS:
        raise ValueError(f"too many tags (max {_MAX_TAGS})")
    return out


def _validate_title(title: str) -> str:
    title = (title or "").strip()
    if not title:
        raise ValueError("title is required")
    if len(title) > _MAX_TITLE:
        raise ValueError(f"title exceeds {_MAX_TITLE} characters")
    return title


def _row_to_view(row) -> MemoryView:
    return MemoryView(
        memory_id=str(row["memory_id"]),
        team_id=str(row["team_id"]),
        title=row["title"],
        body_md=row["body_md"],
        tags=list(row["tags"] or []),
        created_by_alias=row["created_by_alias"],
        assignee_alias=row["assignee_alias"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def list_memories(
    db: AsyncDatabaseManager,
    *,
    team_id: str,
    q: Optional[str] = None,
    tags: Optional[Sequence[str]] = None,
    assignee_alias: Optional[str] = None,
    limit: int = 50,
) -> List[MemoryView]:
    """Team-scoped search. ``q`` -> full-text rank order; empty -> most-recent
    first (the session-start reading order). ``tags`` -> overlap (OR) faceting."""
    limit = max(1, min(int(limit), 200))
    clauses = ["team_id = $1"]
    params: list = [team_id]
    q = (q or "").strip()
    q_idx = None
    if q:
        params.append(q)
        q_idx = len(params)
        clauses.append(
            f"search_tsv @@ websearch_to_tsquery('english', ${q_idx})"
        )
    tag_list = _clean_tags(tags)
    if tag_list:
        params.append(tag_list)
        clauses.append(f"tags && ${len(params)}::text[]")
    if assignee_alias:
        params.append(assignee_alias)
        clauses.append(f"assignee_alias = ${len(params)}")

    params.append(limit)
    limit_idx = len(params)

    if q_idx is not None:
        order = (
            f"ts_rank(search_tsv, websearch_to_tsquery('english', ${q_idx})) "
            "DESC, updated_at DESC"
        )
    else:
        order = "updated_at DESC"

    sql = (
        f"SELECT {_COLUMNS} FROM {{{{tables.memories}}}} "
        f"WHERE {' AND '.join(clauses)} "
        f"ORDER BY {order} LIMIT ${limit_idx}"
    )
    rows = await db.fetch_all(sql, *params)
    return [_row_to_view(r) for r in rows]


async def get_memory(
    db: AsyncDatabaseManager, *, team_id: str, memory_id: str
) -> Optional[MemoryView]:
    row = await db.fetch_one(
        f"SELECT {_COLUMNS} FROM {{{{tables.memories}}}} "
        "WHERE memory_id = $1 AND team_id = $2",
        memory_id,
        team_id,
    )
    return _row_to_view(row) if row else None


async def create_memory(
    db: AsyncDatabaseManager,
    *,
    team_id: str,
    title: str,
    body_md: str = "",
    tags: Optional[Sequence[str]] = None,
    assignee_alias: Optional[str] = None,
    created_by_alias: Optional[str] = None,
) -> MemoryView:
    title = _validate_title(title)
    body_md = body_md or ""
    if len(body_md) > _MAX_BODY:
        raise ValueError(f"body exceeds {_MAX_BODY} characters")
    tag_list = _clean_tags(tags)
    row = await db.fetch_one(
        f"INSERT INTO {{{{tables.memories}}}} "
        "(team_id, title, body_md, tags, created_by_alias, assignee_alias) "
        "VALUES ($1, $2, $3, $4, $5, $6) "
        f"RETURNING {_COLUMNS}",
        team_id,
        title,
        body_md,
        tag_list,
        created_by_alias,
        (assignee_alias or None),
    )
    return _row_to_view(row)


async def update_memory(
    db: AsyncDatabaseManager,
    *,
    team_id: str,
    memory_id: str,
    title: Optional[str] = None,
    body_md: Optional[str] = None,
    tags: Optional[Sequence[str]] = None,
    assignee_alias: Optional[str] = None,
    assignee_provided: bool = False,
) -> Optional[MemoryView]:
    """Partial update. Only the provided fields change. ``assignee_provided``
    distinguishes "clear the scope" (assignee_alias=None) from "leave it"."""
    sets: list = []
    params: list = []
    if title is not None:
        params.append(_validate_title(title))
        sets.append(f"title = ${len(params)}")
    if body_md is not None:
        if len(body_md) > _MAX_BODY:
            raise ValueError(f"body exceeds {_MAX_BODY} characters")
        params.append(body_md)
        sets.append(f"body_md = ${len(params)}")
    if tags is not None:
        params.append(_clean_tags(tags))
        sets.append(f"tags = ${len(params)}::text[]")
    if assignee_provided:
        params.append(assignee_alias or None)
        sets.append(f"assignee_alias = ${len(params)}")

    if not sets:
        # Nothing to change -- return the current row (still team-scoped).
        return await get_memory(db, team_id=team_id, memory_id=memory_id)

    sets.append("updated_at = NOW()")
    params.append(memory_id)
    id_idx = len(params)
    params.append(team_id)
    team_idx = len(params)

    row = await db.fetch_one(
        f"UPDATE {{{{tables.memories}}}} SET {', '.join(sets)} "
        f"WHERE memory_id = ${id_idx} AND team_id = ${team_idx} "
        f"RETURNING {_COLUMNS}",
        *params,
    )
    return _row_to_view(row) if row else None


async def delete_memory(
    db: AsyncDatabaseManager, *, team_id: str, memory_id: str
) -> bool:
    row = await db.fetch_one(
        f"DELETE FROM {{{{tables.memories}}}} "
        "WHERE memory_id = $1 AND team_id = $2 RETURNING memory_id",
        memory_id,
        team_id,
    )
    return row is not None


# --- REST endpoints (token-auth; team_id from the JWT via get_team_identity) ---


@memories_router.get("")
async def list_memories_endpoint(
    request: Request,
    q: Optional[str] = Query(None, description="Full-text search over title+body"),
    tag: Optional[str] = Query(None, description="Comma-separated tags; matches memories having ANY of them"),
    assignee_alias: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> ListMemoriesResponse:
    tags = [t.strip() for t in tag.split(",") if t.strip()] if tag else None
    try:
        memories = await list_memories(
            db.get_manager("aweb"),
            team_id=identity.team_id,
            q=q,
            tags=tags,
            assignee_alias=assignee_alias,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return ListMemoriesResponse(memories=memories)


@memories_router.post("", status_code=201)
async def create_memory_endpoint(
    request: Request,
    payload: CreateMemoryRequest,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> MemoryView:
    try:
        memory = await create_memory(
            db.get_manager("aweb"),
            team_id=identity.team_id,
            title=payload.title,
            body_md=payload.body_md,
            tags=payload.tags,
            assignee_alias=payload.assignee_alias,
            created_by_alias=identity.alias,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    logger.info("Memory created: team=%s id=%s", identity.team_id, memory.memory_id)
    return memory


@memories_router.get("/{memory_id}")
async def get_memory_endpoint(
    request: Request,
    memory_id: str,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> MemoryView:
    memory = await get_memory(
        db.get_manager("aweb"), team_id=identity.team_id, memory_id=memory_id
    )
    if memory is None:
        raise HTTPException(status_code=404, detail="Memory not found")
    return memory


@memories_router.patch("/{memory_id}")
async def update_memory_endpoint(
    request: Request,
    memory_id: str,
    payload: UpdateMemoryRequest,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> MemoryView:
    try:
        memory = await update_memory(
            db.get_manager("aweb"),
            team_id=identity.team_id,
            memory_id=memory_id,
            title=payload.title,
            body_md=payload.body_md,
            tags=payload.tags,
            assignee_alias=payload.assignee_alias,
            assignee_provided="assignee_alias" in payload.model_fields_set,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if memory is None:
        raise HTTPException(status_code=404, detail="Memory not found")
    return memory


@memories_router.delete("/{memory_id}", status_code=204)
async def delete_memory_endpoint(
    request: Request,
    memory_id: str,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> None:
    deleted = await delete_memory(
        db.get_manager("aweb"), team_id=identity.team_id, memory_id=memory_id
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Memory not found")
    return None
