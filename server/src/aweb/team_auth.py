"""Dashboard JWT verification.

Dashboard tokens are short-lived JWTs containing allowed team_ids,
issued by the hosted dashboard for human dashboard access.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import jwt as pyjwt

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Dashboard JWT verification
# ---------------------------------------------------------------------------


def verify_dashboard_token(
    token: str,
    secret: str,
    *,
    required_team: Optional[str] = None,
) -> dict[str, Any]:
    """Verify a dashboard JWT and optionally check team authorization.

    Args:
        token: The JWT string from X-Dashboard-Token header.
        secret: The shared secret (AWEB_DASHBOARD_JWT_SECRET).
        required_team: If provided, verify the token grants access to this team.

    Returns:
        Dict with user_id, team_ids.

    Raises:
        ValueError: If the token is invalid, expired, or unauthorized.
    """
    if not secret:
        raise ValueError("Dashboard JWT secret not configured")

    try:
        # require exp so a token minted without expiry fails closed — these are
        # documented as short-lived and have no jti/revocation path.
        payload = pyjwt.decode(
            token, secret, algorithms=["HS256"], options={"require": ["exp"]},
        )
    except pyjwt.ExpiredSignatureError:
        raise ValueError("Dashboard token expired")
    except pyjwt.InvalidTokenError:
        raise ValueError("Dashboard token invalid")

    user_id = payload.get("user_id")
    team_ids = payload.get("team_ids", [])

    if not user_id:
        raise ValueError("Dashboard token missing user_id")

    if required_team and required_team not in team_ids:
        raise ValueError(f"User not authorized for team {required_team}")

    return {
        "user_id": user_id,
        "team_ids": team_ids,
    }
