"""REST CRUD + filtered list for the work hierarchy: Epic -> Story -> Issue.

Additive alongside the existing ``tasks`` endpoints (which stay for compat).
Thin HTTP layer over :mod:`aweb.coordination.hierarchy`; mirrors the router
style in :mod:`aweb.routes.agents` (team-scoped via ``get_team_identity``,
``db=Depends(get_db)``). Service-layer ``ServiceError`` subclasses are mapped
to ``HTTPException`` using their ``status_code``.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from aweb.coordination import hierarchy as hierarchy_service
from aweb.deps import get_db
from aweb.service_errors import ServiceError
from aweb.team_auth_deps import TeamIdentity, get_team_identity

router = APIRouter(prefix="/v1", tags=["hierarchy"])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class EpicView(BaseModel):
    epic_id: str
    team_id: str
    title: str
    status: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class CreateEpicRequest(BaseModel):
    model_config = {"extra": "forbid"}

    title: str = Field(..., min_length=1, max_length=512)
    status: str = Field("open", min_length=1, max_length=64)


class UpdateEpicRequest(BaseModel):
    model_config = {"extra": "forbid"}

    title: Optional[str] = Field(None, min_length=1, max_length=512)
    status: Optional[str] = Field(None, min_length=1, max_length=64)


class ListEpicsResponse(BaseModel):
    team_id: str
    epics: list[EpicView]


class StoryView(BaseModel):
    story_id: str
    epic_id: Optional[str] = None
    team_id: str
    title: str
    status: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class CreateStoryRequest(BaseModel):
    model_config = {"extra": "forbid"}

    title: str = Field(..., min_length=1, max_length=512)
    status: str = Field("open", min_length=1, max_length=64)
    epic_id: Optional[str] = Field(None, max_length=64)


class UpdateStoryRequest(BaseModel):
    model_config = {"extra": "forbid"}

    title: Optional[str] = Field(None, min_length=1, max_length=512)
    status: Optional[str] = Field(None, min_length=1, max_length=64)
    epic_id: Optional[str] = Field(None, max_length=64)


class ListStoriesResponse(BaseModel):
    team_id: str
    stories: list[StoryView]


class IssueView(BaseModel):
    issue_id: str
    team_id: str
    epic_id: Optional[str] = None
    story_id: Optional[str] = None
    title: str
    description: Optional[str] = None
    status: str
    assignee_type: Optional[str] = None
    assignee_id: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    comment_count: int = 0


class CreateIssueRequest(BaseModel):
    model_config = {"extra": "forbid"}

    title: str = Field(..., min_length=1, max_length=512)
    description: str = Field("", max_length=16384)
    status: str = Field("todo", min_length=1, max_length=32)
    epic_id: Optional[str] = Field(None, max_length=64)
    story_id: Optional[str] = Field(None, max_length=64)
    assignee_type: Optional[str] = Field(None, max_length=16)
    assignee_id: Optional[str] = Field(None, max_length=256)


class UpdateIssueRequest(BaseModel):
    model_config = {"extra": "forbid"}

    title: Optional[str] = Field(None, min_length=1, max_length=512)
    description: Optional[str] = Field(None, max_length=16384)
    status: Optional[str] = Field(None, min_length=1, max_length=32)
    epic_id: Optional[str] = Field(None, max_length=64)
    story_id: Optional[str] = Field(None, max_length=64)
    assignee_type: Optional[str] = Field(None, max_length=16)
    assignee_id: Optional[str] = Field(None, max_length=256)


class ClaimIssueRequest(BaseModel):
    model_config = {"extra": "forbid"}

    assignee_type: str = Field(..., min_length=1, max_length=16)
    assignee_id: str = Field(..., min_length=1, max_length=256)
    set_in_progress: bool = True


class UpdateIssueStatusRequest(BaseModel):
    model_config = {"extra": "forbid"}

    status: str = Field(..., min_length=1, max_length=32)


class ListIssuesResponse(BaseModel):
    team_id: str
    issues: list[IssueView]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _raise_http(exc: ServiceError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


# ---------------------------------------------------------------------------
# Epics
# ---------------------------------------------------------------------------


@router.post("/epics", response_model=EpicView, status_code=201)
async def create_epic(
    request: Request,
    payload: CreateEpicRequest,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> EpicView:
    """Create an epic in the current team."""
    try:
        epic = await hierarchy_service.create_epic(
            db,
            team_id=identity.team_id,
            title=payload.title,
            status=payload.status,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return EpicView(**epic)


@router.get("/epics", response_model=ListEpicsResponse)
async def list_epics(
    request: Request,
    status: Optional[str] = Query(None),
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> ListEpicsResponse:
    """List epics in the current team, optionally filtered by status."""
    try:
        epics = await hierarchy_service.list_epics(
            db,
            team_id=identity.team_id,
            status=status,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return ListEpicsResponse(
        team_id=identity.team_id,
        epics=[EpicView(**e) for e in epics],
    )


@router.get("/epics/{epic_id}", response_model=EpicView)
async def get_epic(
    request: Request,
    epic_id: str,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> EpicView:
    """Fetch a single epic by id."""
    try:
        epic = await hierarchy_service.get_epic(
            db,
            team_id=identity.team_id,
            epic_id=epic_id,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return EpicView(**epic)


@router.patch("/epics/{epic_id}", response_model=EpicView)
async def update_epic(
    request: Request,
    epic_id: str,
    payload: UpdateEpicRequest,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> EpicView:
    """Update an epic's title and/or status."""
    try:
        epic = await hierarchy_service.update_epic(
            db,
            team_id=identity.team_id,
            epic_id=epic_id,
            title=payload.title,
            status=payload.status,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return EpicView(**epic)


# ---------------------------------------------------------------------------
# Stories
# ---------------------------------------------------------------------------


@router.post("/stories", response_model=StoryView, status_code=201)
async def create_story(
    request: Request,
    payload: CreateStoryRequest,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> StoryView:
    """Create a story in the current team, optionally under an epic."""
    try:
        story = await hierarchy_service.create_story(
            db,
            team_id=identity.team_id,
            title=payload.title,
            epic_id=payload.epic_id,
            status=payload.status,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return StoryView(**story)


@router.get("/stories", response_model=ListStoriesResponse)
async def list_stories(
    request: Request,
    status: Optional[str] = Query(None),
    epic_id: Optional[str] = Query(None),
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> ListStoriesResponse:
    """List stories in the current team, filtered by status and/or epic_id."""
    try:
        stories = await hierarchy_service.list_stories(
            db,
            team_id=identity.team_id,
            status=status,
            epic_id=epic_id,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return ListStoriesResponse(
        team_id=identity.team_id,
        stories=[StoryView(**s) for s in stories],
    )


@router.get("/stories/{story_id}", response_model=StoryView)
async def get_story(
    request: Request,
    story_id: str,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> StoryView:
    """Fetch a single story by id."""
    try:
        story = await hierarchy_service.get_story(
            db,
            team_id=identity.team_id,
            story_id=story_id,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return StoryView(**story)


@router.patch("/stories/{story_id}", response_model=StoryView)
async def update_story(
    request: Request,
    story_id: str,
    payload: UpdateStoryRequest,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> StoryView:
    """Update a story's title, status, and/or parent epic."""
    fields = payload.model_dump(exclude_unset=True)
    kwargs = {}
    if "title" in fields:
        kwargs["title"] = payload.title
    if "status" in fields:
        kwargs["status"] = payload.status
    if "epic_id" in fields:
        kwargs["epic_id"] = payload.epic_id
    try:
        story = await hierarchy_service.update_story(
            db,
            team_id=identity.team_id,
            story_id=story_id,
            **kwargs,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return StoryView(**story)


# ---------------------------------------------------------------------------
# Issues (the floor)
# ---------------------------------------------------------------------------


@router.post("/issues", response_model=IssueView, status_code=201)
async def create_issue(
    request: Request,
    payload: CreateIssueRequest,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> IssueView:
    """Create an issue, optionally attached to an epic and/or story."""
    try:
        issue = await hierarchy_service.create_issue(
            db,
            team_id=identity.team_id,
            title=payload.title,
            description=payload.description,
            status=payload.status,
            epic_id=payload.epic_id,
            story_id=payload.story_id,
            assignee_type=payload.assignee_type,
            assignee_id=payload.assignee_id,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return IssueView(**issue)


@router.get("/issues", response_model=ListIssuesResponse)
async def list_issues(
    request: Request,
    status: Optional[str] = Query(None),
    assignee_type: Optional[str] = Query(None),
    assignee_id: Optional[str] = Query(None),
    epic_id: Optional[str] = Query(None),
    story_id: Optional[str] = Query(None),
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> ListIssuesResponse:
    """List issues filtered by status, assignee, epic_id, and/or story_id."""
    try:
        issues = await hierarchy_service.list_issues(
            db,
            team_id=identity.team_id,
            status=status,
            assignee_type=assignee_type,
            assignee_id=assignee_id,
            epic_id=epic_id,
            story_id=story_id,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return ListIssuesResponse(
        team_id=identity.team_id,
        issues=[IssueView(**i) for i in issues],
    )


@router.get("/issues/{issue_id}", response_model=IssueView)
async def get_issue(
    request: Request,
    issue_id: str,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> IssueView:
    """Fetch a single issue by id."""
    try:
        issue = await hierarchy_service.get_issue(
            db,
            team_id=identity.team_id,
            issue_id=issue_id,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return IssueView(**issue)


@router.patch("/issues/{issue_id}", response_model=IssueView)
async def update_issue(
    request: Request,
    issue_id: str,
    payload: UpdateIssueRequest,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> IssueView:
    """Update an issue's fields, parent links, and assignment."""
    fields = payload.model_dump(exclude_unset=True)
    kwargs = {}
    if "title" in fields:
        kwargs["title"] = payload.title
    if "description" in fields:
        kwargs["description"] = payload.description
    if "status" in fields:
        kwargs["status"] = payload.status
    if "epic_id" in fields:
        kwargs["epic_id"] = payload.epic_id
    if "story_id" in fields:
        kwargs["story_id"] = payload.story_id
    if "assignee_type" in fields:
        kwargs["assignee_type"] = payload.assignee_type
    if "assignee_id" in fields:
        kwargs["assignee_id"] = payload.assignee_id
    try:
        issue = await hierarchy_service.update_issue(
            db,
            team_id=identity.team_id,
            issue_id=issue_id,
            **kwargs,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return IssueView(**issue)


@router.patch("/issues/{issue_id}/status", response_model=IssueView)
async def update_issue_status(
    request: Request,
    issue_id: str,
    payload: UpdateIssueStatusRequest,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> IssueView:
    """Transition an issue to a new status."""
    try:
        issue = await hierarchy_service.update_issue(
            db,
            team_id=identity.team_id,
            issue_id=issue_id,
            status=payload.status,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return IssueView(**issue)


@router.post("/issues/{issue_id}/claim", response_model=IssueView)
async def claim_issue(
    request: Request,
    issue_id: str,
    payload: ClaimIssueRequest,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> IssueView:
    """Assign an issue to an actor and (by default) move it to in_progress."""
    try:
        issue = await hierarchy_service.claim_issue(
            db,
            team_id=identity.team_id,
            issue_id=issue_id,
            assignee_type=payload.assignee_type,
            assignee_id=payload.assignee_id,
            set_in_progress=payload.set_in_progress,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return IssueView(**issue)


# ---------------------------------------------------------------------------
# Comments (issue activity thread)
# ---------------------------------------------------------------------------


class CommentView(BaseModel):
    comment_id: str
    issue_id: str
    author: str
    body: str
    created_at: Optional[str] = None


class CreateCommentRequest(BaseModel):
    model_config = {"extra": "forbid"}

    body: str = Field(..., min_length=1, max_length=16384)


class ListCommentsResponse(BaseModel):
    issue_id: str
    comments: list[CommentView]


@router.post(
    "/issues/{issue_id}/comments",
    response_model=CommentView,
    status_code=201,
)
async def add_issue_comment(
    issue_id: str,
    payload: CreateCommentRequest,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> CommentView:
    """Post a comment to an issue's thread. The author is the authenticated
    actor (human or agent); this is the human<->agent discussion surface."""
    try:
        comment = await hierarchy_service.add_issue_comment(
            db,
            team_id=identity.team_id,
            issue_id=issue_id,
            author=identity.alias,
            body=payload.body,
        )
    except ServiceError as exc:
        _raise_http(exc)
    return CommentView(**comment)


@router.get(
    "/issues/{issue_id}/comments",
    response_model=ListCommentsResponse,
)
async def list_issue_comments(
    issue_id: str,
    db=Depends(get_db),
    identity: TeamIdentity = Depends(get_team_identity),
) -> ListCommentsResponse:
    """List an issue's comments, oldest first."""
    try:
        comments = await hierarchy_service.list_issue_comments(
            db, team_id=identity.team_id, issue_id=issue_id
        )
    except ServiceError as exc:
        _raise_http(exc)
    return ListCommentsResponse(
        issue_id=issue_id,
        comments=[CommentView(**c) for c in comments],
    )
