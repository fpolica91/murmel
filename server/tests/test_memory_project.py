import pytest

from aweb.coordination.routes.memories import create_memory, list_memories

TEAM = "backend:acme.com"


async def _seed_team(db):
    await db.execute(
        """
        INSERT INTO {{tables.teams}} (team_id, namespace, team_name, team_did_key)
        VALUES ($1, 'acme.com', 'Backend', 'did:key:team')
        ON CONFLICT (team_id) DO NOTHING
        """,
        TEAM,
    )


@pytest.mark.asyncio
async def test_create_memory_stores_project(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    m = await create_memory(db, team_id=TEAM, title="A", project="github.com/acme/api")
    assert m.project == "github.com/acme/api"


@pytest.mark.asyncio
async def test_create_memory_defaults_project_null(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    m = await create_memory(db, team_id=TEAM, title="B")
    assert m.project is None


@pytest.mark.asyncio
async def test_list_default_is_cross_project(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await create_memory(db, team_id=TEAM, title="api-note", project="github.com/acme/api")
    await create_memory(db, team_id=TEAM, title="web-note", project="github.com/acme/web")
    titles = {m.title for m in await list_memories(db, team_id=TEAM, limit=50)}
    assert {"api-note", "web-note"} <= titles  # no filter -> all projects


@pytest.mark.asyncio
async def test_list_project_filter_includes_globals(aweb_cloud_db):
    db = aweb_cloud_db.aweb_db
    await _seed_team(db)
    await create_memory(db, team_id=TEAM, title="api-only", project="github.com/acme/api")
    await create_memory(db, team_id=TEAM, title="web-only", project="github.com/acme/web")
    await create_memory(db, team_id=TEAM, title="global-note")  # project NULL
    titles = {
        m.title
        for m in await list_memories(db, team_id=TEAM, project="github.com/acme/api", limit=50)
    }
    assert "api-only" in titles
    assert "global-note" in titles      # NULL globals always visible
    assert "web-only" not in titles     # other repo filtered out
