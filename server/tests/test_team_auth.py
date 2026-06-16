"""Tests for dashboard JWT auth."""

from __future__ import annotations

import time

import jwt
import pytest


# ---------------------------------------------------------------------------
# Dashboard JWT auth
# ---------------------------------------------------------------------------

_JWT_SECRET = "test-dashboard-secret-at-least-32bytes!"


class TestDashboardJWT:
    def test_valid_jwt(self):
        from aweb.team_auth import verify_dashboard_token

        payload = {
            "user_id": "user-123",
            "team_ids": ["backend:acme.com", "frontend:acme.com"],
            "exp": int(time.time()) + 3600,
        }
        token = jwt.encode(payload, _JWT_SECRET, algorithm="HS256")

        result = verify_dashboard_token(token, _JWT_SECRET)
        assert result["user_id"] == "user-123"
        assert "backend:acme.com" in result["team_ids"]

    def test_expired_jwt_rejected(self):
        from aweb.team_auth import verify_dashboard_token

        payload = {
            "user_id": "user-123",
            "team_ids": ["backend:acme.com"],
            "exp": int(time.time()) - 3600,
        }
        token = jwt.encode(payload, _JWT_SECRET, algorithm="HS256")

        with pytest.raises(ValueError, match="expired"):
            verify_dashboard_token(token, _JWT_SECRET)

    def test_missing_exp_rejected(self):
        # A token minted without exp must fail closed (never-expiring otherwise).
        from aweb.team_auth import verify_dashboard_token

        payload = {"user_id": "user-123", "team_ids": ["backend:acme.com"]}
        token = jwt.encode(payload, _JWT_SECRET, algorithm="HS256")

        with pytest.raises(ValueError, match="invalid"):
            verify_dashboard_token(token, _JWT_SECRET)

    def test_invalid_secret_rejected(self):
        from aweb.team_auth import verify_dashboard_token

        payload = {
            "user_id": "user-123",
            "team_ids": ["backend:acme.com"],
            "exp": int(time.time()) + 3600,
        }
        token = jwt.encode(payload, "real-secret-at-least-thirty-two-bytes!", algorithm="HS256")

        with pytest.raises(ValueError, match="invalid"):
            verify_dashboard_token(token, "wrong-secret-at-least-thirty-two-bytes!")

    def test_team_id_authorization(self):
        from aweb.team_auth import verify_dashboard_token

        payload = {
            "user_id": "user-123",
            "team_ids": ["backend:acme.com"],
            "exp": int(time.time()) + 3600,
        }
        token = jwt.encode(payload, _JWT_SECRET, algorithm="HS256")

        result = verify_dashboard_token(token, _JWT_SECRET, required_team="backend:acme.com")
        assert result["user_id"] == "user-123"

    def test_team_id_unauthorized(self):
        from aweb.team_auth import verify_dashboard_token

        payload = {
            "user_id": "user-123",
            "team_ids": ["backend:acme.com"],
            "exp": int(time.time()) + 3600,
        }
        token = jwt.encode(payload, _JWT_SECRET, algorithm="HS256")

        with pytest.raises(ValueError, match="not authorized"):
            verify_dashboard_token(token, _JWT_SECRET, required_team="frontend:acme.com")

    def test_empty_secret_rejected(self):
        import warnings

        from aweb.team_auth import verify_dashboard_token

        payload = {
            "user_id": "user-123",
            "team_ids": ["backend:acme.com"],
            "exp": int(time.time()) + 3600,
        }
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            token = jwt.encode(payload, "", algorithm="HS256")

        with pytest.raises(ValueError, match="not configured"):
            verify_dashboard_token(token, "")
