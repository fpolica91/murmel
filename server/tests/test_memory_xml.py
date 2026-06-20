"""Unit tests for the Claude Code XML memory rendering (MCP output format)."""

from __future__ import annotations

from datetime import datetime, timezone

from aweb.coordination.routes.memories import MemoryView
from aweb.mcp.tools.memory import memories_to_xml, memory_to_xml


def _mem(**over) -> MemoryView:
    base = dict(
        memory_id="cc8029a6-0000-0000-0000-000000000001",
        team_id="default:local",
        title="Deploy runbook",
        body_md="On deploy, run `make ship` then push the tag.",
        tags=["ops", "runbook"],
        created_by_alias="Founder",
        assignee_alias=None,
        created_at=datetime(2026, 6, 19, 12, 0, tzinfo=timezone.utc),
        updated_at=datetime(2026, 6, 19, 12, 0, tzinfo=timezone.utc),
    )
    base.update(over)
    return MemoryView(**base)


def test_memory_to_xml_attributes_and_body():
    xml = memory_to_xml(_mem())
    assert xml.startswith("<memory ")
    assert xml.endswith("</memory>")
    assert 'id="cc8029a6-0000-0000-0000-000000000001"' in xml
    assert 'title="Deploy runbook"' in xml
    assert 'author="Founder"' in xml
    assert 'tags="ops,runbook"' in xml
    assert 'updated="2026-06-19"' in xml
    # markdown body is the element content, verbatim
    assert "On deploy, run `make ship` then push the tag." in xml
    # team-general note has no private attr
    assert "private=" not in xml


def test_memory_to_xml_private_scope():
    xml = memory_to_xml(_mem(assignee_alias="Ada"))
    assert 'private="Ada"' in xml


def test_memory_to_xml_escapes_attributes_and_body():
    xml = memory_to_xml(
        _mem(
            title='Tom & "Jerry" <tag>',
            body_md="if a < b && c > d: emit(<x>)",
            tags=["a&b"],
        )
    )
    # attribute values are escaped + quoted (saxutils picks a safe quote char)
    assert "&amp;" in xml
    assert "&lt;tag&gt;" in xml or "&lt;tag>" in xml
    # raw, unescaped angle brackets/ampersands must NOT leak into the body
    assert "a < b" not in xml
    assert "a &lt; b" in xml
    assert "&amp;&amp;" in xml  # the && in the body
    # the document stays well-formed: a real XML parser can read it
    import xml.etree.ElementTree as ET

    ET.fromstring(xml)


def test_memories_to_xml_empty_and_populated():
    assert memories_to_xml([]) == '<memories count="0"></memories>'

    block = memories_to_xml([_mem(), _mem(memory_id="id-2", title="Second")])
    assert block.startswith('<memories count="2">')
    assert block.rstrip().endswith("</memories>")
    assert block.count("<memory ") == 2
    assert 'title="Second"' in block

    # the whole envelope parses as valid XML
    import xml.etree.ElementTree as ET

    root = ET.fromstring(block)
    assert root.tag == "memories"
    assert root.attrib["count"] == "2"
    assert len(root) == 2
