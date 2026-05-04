"""
Budget-Pal Backend — Authentication Tests

Tests for:
- POST /auth/register
- POST /auth/login
- GET /auth/me
- PUT /auth/me
"""

from unittest.mock import AsyncMock, patch

import pytest

# ── Register Tests ─────────────────────────────────────────────


class TestRegister:
    """Tests for the register endpoint."""

    def test_register_success(self, client):
        """Test successful user registration."""
        response = client.post(
            "/api/auth/register",
            json={
                "email": "newuser@example.com",
                "password": "securepassword123",
                "name": "New User",
            },
        )

        assert response.status_code == 201
        data = response.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert data["name"] == "New User"
        assert data["email"] == "newuser@example.com"
        assert "user_id" in data

    def test_register_duplicate_email(self, client, test_user):
        """Test registration with existing email fails."""
        response = client.post(
            "/api/auth/register",
            json={
                "email": "test@example.com",  # Already exists
                "password": "anotherpassword123",
                "name": "Duplicate User",
            },
        )

        assert response.status_code == 400
        assert "already exists" in response.json()["detail"].lower()

    def test_register_short_password(self, client):
        """Test registration with password shorter than 8 characters."""
        response = client.post(
            "/api/auth/register",
            json={
                "email": "shortpass@example.com",
                "password": "1234567",  # Only 7 characters
                "name": "Short Pass User",
            },
        )

        assert response.status_code == 422  # Validation error

    def test_register_invalid_email(self, client):
        """Test registration with invalid email format."""
        response = client.post(
            "/api/auth/register",
            json={
                "email": "not-an-email",
                "password": "securepassword123",
                "name": "Invalid Email User",
            },
        )

        assert response.status_code == 422  # Validation error

    def test_register_missing_fields(self, client):
        """Test registration with missing required fields."""
        response = client.post(
            "/api/auth/register",
            json={
                "email": "partial@example.com",
                # Missing password and name
            },
        )

        assert response.status_code == 422  # Validation error


# ── Login Tests ────────────────────────────────────────────────


class TestLogin:
    """Tests for the login endpoint."""

    def test_login_success(self, client, test_user):
        """Test successful login."""
        response = client.post(
            "/api/auth/login",
            json={
                "email": "test@example.com",
                "password": "testpassword123",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert data["name"] == "Test User"
        assert data["email"] == "test@example.com"
        assert "user_id" in data

    def test_login_wrong_password(self, client, test_user):
        """Test login with wrong password."""
        response = client.post(
            "/api/auth/login",
            json={
                "email": "test@example.com",
                "password": "wrongpassword",
            },
        )

        assert response.status_code == 401
        assert (
            "invalid" in response.json()["detail"].lower()
            or "password" in response.json()["detail"].lower()
        )

    def test_login_nonexistent_user(self, client):
        """Test login with non-existent email."""
        response = client.post(
            "/api/auth/login",
            json={
                "email": "nonexistent@example.com",
                "password": "anypassword",
            },
        )

        assert response.status_code == 401
        assert (
            "invalid" in response.json()["detail"].lower()
            or "email" in response.json()["detail"].lower()
        )

    def test_login_missing_fields(self, client):
        """Test login with missing fields."""
        response = client.post(
            "/api/auth/login",
            json={
                "email": "test@example.com",
                # Missing password
            },
        )

        assert response.status_code == 422  # Validation error


# ── Get Me Tests ───────────────────────────────────────────────


class TestGetMe:
    """Tests for the GET /auth/me endpoint."""

    def test_get_me_success(self, client, test_user):
        """Test successful get profile."""
        response = client.get("/api/auth/me")

        assert response.status_code == 200
        data = response.json()
        assert data["email"] == "test@example.com"
        assert data["name"] == "Test User"
        assert data["is_active"] is True
        assert data["currency"] == "CHF"
        assert data["locale"] == "de-CH"
        assert "id" in data
        assert "created_at" in data
        assert data["birthdate"] == "1985-01-01"
        assert data["retirement_age"] == 65

    def test_get_me_unauthenticated(self, app):
        """Test get profile without authentication."""
        from fastapi.testclient import TestClient

        with TestClient(app, raise_server_exceptions=False) as test_client:
            # No Authorization header
            response = test_client.get("/api/auth/me")

            assert response.status_code == 401


# ── Update Me Tests ────────────────────────────────────────────


class TestUpdateMe:
    """Tests for the PUT /auth/me endpoint."""

    def test_update_profile_success(self, client, test_user):
        """Test successful profile update."""
        response = client.put(
            "/api/auth/me",
            json={
                "name": "Updated Name",
                "retirement_age": 67,
                "currency": "EUR",
                "locale": "de-DE",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Updated Name"
        assert data["retirement_age"] == 67
        assert data["currency"] == "EUR"
        assert data["locale"] == "de-DE"

    def test_update_birthdate_string(self, client, test_user):
        """Test updating birthdate via ISO string."""
        response = client.put(
            "/api/auth/me",
            json={
                "birthdate": "1990-05-20",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["birthdate"] == "1990-05-20"

    def test_update_birthdate_empty(self, client, test_user):
        """Test clearing birthdate."""
        response = client.put(
            "/api/auth/me",
            json={
                "birthdate": "",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["birthdate"] is None

    def test_update_password_success(self, client, test_user):
        """Test successful password change."""
        # First update password
        response = client.put(
            "/api/auth/me",
            json={
                "current_password": "testpassword123",
                "new_password": "newsecurepassword123",
            },
        )

        assert response.status_code == 200

        # Verify login with new password works
        response = client.post(
            "/api/auth/login",
            json={
                "email": "test@example.com",
                "password": "newsecurepassword123",
            },
        )

        assert response.status_code == 200
        assert "access_token" in response.json()

    def test_update_password_wrong_current(self, client, test_user):
        """Test password change with wrong current password."""
        response = client.put(
            "/api/auth/me",
            json={
                "current_password": "wrongpassword",
                "new_password": "newsecurepassword123",
            },
        )

        assert response.status_code == 400
        assert "incorrect" in response.json()["detail"].lower()

    def test_update_password_missing_current(self, client, test_user):
        """Test password change without current password."""
        response = client.put(
            "/api/auth/me",
            json={
                "new_password": "newsecurepassword123",
                # Missing current_password
            },
        )

        assert response.status_code == 400
        assert "required" in response.json()["detail"].lower()

    def test_update_password_new_too_short(self, client, test_user):
        """Test password change with new password too short."""
        response = client.put(
            "/api/auth/me",
            json={
                "current_password": "testpassword123",
                "new_password": "1234567",  # Only 7 characters
            },
        )

        assert response.status_code == 422  # Validation error

    def test_update_partial_fields(self, client, test_user):
        """Test updating only some fields."""
        response = client.put(
            "/api/auth/me",
            json={
                "name": "Only Name Changed",
                # Other fields not sent
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Only Name Changed"
        assert data["currency"] == "CHF"  # Unchanged
        assert data["retirement_age"] == 65  # Unchanged

    def test_update_unauthenticated(self, app):
        """Test update profile without authentication."""
        from fastapi.testclient import TestClient

        with TestClient(app, raise_server_exceptions=False) as test_client:
            response = test_client.put(
                "/api/auth/me",
                json={"name": "Hacker"},
            )

            assert response.status_code == 401


# ── Edge Cases ─────────────────────────────────────────────────


class TestAuthEdgeCases:
    """Tests for edge cases and error handling."""

    def test_register_email_case_insensitive(self, client, test_user):
        """Test that email comparison is case-insensitive."""
        response = client.post(
            "/api/auth/register",
            json={
                "email": "TEST@EXAMPLE.COM",  # Same email, different case
                "password": "anotherpassword123",
                "name": "Case Test User",
            },
        )

        # Should fail because email already exists
        assert response.status_code == 400

    def test_login_case_insensitive(self, client, test_user):
        """Test that login email is case-insensitive."""
        response = client.post(
            "/api/auth/login",
            json={
                "email": "TEST@EXAMPLE.COM",
                "password": "testpassword123",
            },
        )

        # Should succeed (SQLAlchemy by default is case-insensitive for text)
        assert response.status_code == 200
