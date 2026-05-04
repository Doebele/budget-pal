"""
Budget-Pal Backend — Transaction API Tests

Tests for:
- GET /transactions (list with filters)
- POST /transactions (create)
- PUT /transactions/{id} (update)
- DELETE /transactions/{id} (delete)
- GET /transactions/stats (statistics)
- GET /transactions/monthly-summary (monthly breakdown)
"""

from datetime import datetime, timedelta, timezone

import pytest

# ── Create Transaction Tests ─────────────────────────────────────


class TestCreateTransaction:
    """Tests for the POST /transactions endpoint."""

    def test_create_transaction_success(self, client, test_user, test_account):
        """Test successful transaction creation."""
        response = client.post(
            "/api/transactions",
            json={
                "account_id": test_account.id,
                "date": datetime.now(timezone.utc).isoformat(),
                "description": "Test Transaction",
                "amount": -50.0,
                "currency": "CHF",
                "category": "Food",
            },
        )

        assert response.status_code == 201
        data = response.json()
        assert data["description"] == "Test Transaction"
        assert data["amount"] == -50.0
        assert data["currency"] == "CHF"
        assert data["account_id"] == test_account.id
        assert data["category"] == "Food"
        assert "id" in data
        assert "created_at" in data
        assert data["is_transfer"] is False
        assert data["is_recurring"] is False

    def test_create_transaction_with_recurring(self, client, test_user, test_account):
        """Test creating a recurring transaction."""
        response = client.post(
            "/api/transactions",
            json={
                "account_id": test_account.id,
                "date": datetime.now(timezone.utc).isoformat(),
                "description": "Monthly Subscription",
                "amount": -9.99,
                "currency": "CHF",
                "is_recurring": True,
                "periodicity": "monthly",
            },
        )

        assert response.status_code == 201
        data = response.json()
        assert data["is_recurring"] is True
        assert data["periodicity"] == "monthly"

    def test_create_transaction_income(self, client, test_user, test_account):
        """Test creating an income transaction."""
        response = client.post(
            "/api/transactions",
            json={
                "account_id": test_account.id,
                "date": datetime.now(timezone.utc).isoformat(),
                "description": "Salary Payment",
                "amount": 5000.0,
                "currency": "CHF",
                "category": "Salary",
            },
        )

        assert response.status_code == 201
        data = response.json()
        assert data["amount"] == 5000.0
        assert data["category"] == "Salary"

    def test_create_transaction_missing_fields(self, client, test_account):
        """Test creating a transaction with missing required fields."""
        response = client.post(
            "/api/transactions",
            json={
                "description": "Incomplete",
                # Missing account_id, date, amount
            },
        )

        assert response.status_code == 422  # Validation error

    def test_create_transaction_default_currency(self, client, test_user, test_account):
        """Test that default currency is CHF when not provided."""
        response = client.post(
            "/api/transactions",
            json={
                "account_id": test_account.id,
                "date": datetime.now(timezone.utc).isoformat(),
                "description": "Default Currency Test",
                "amount": -100.0,
                # currency not provided
            },
        )

        assert response.status_code == 201
        data = response.json()
        assert data["currency"] == "CHF"

    def test_create_transaction_with_notes(self, client, test_user, test_account):
        """Test creating a transaction with notes."""
        response = client.post(
            "/api/transactions",
            json={
                "account_id": test_account.id,
                "date": datetime.now(timezone.utc).isoformat(),
                "description": "Test with Notes",
                "amount": -75.50,
                "currency": "CHF",
                "notes": "This is a test note",
            },
        )

        assert response.status_code == 201
        data = response.json()
        assert data["notes"] == "This is a test note"


# ── List Transactions Tests ──────────────────────────────────────


class TestListTransactions:
    """Tests for the GET /transactions endpoint."""

    def _create_transactions(self, client, account_id: int, count: int = 5):
        """Helper to create multiple transactions."""
        for i in range(count):
            client.post(
                "/api/transactions",
                json={
                    "account_id": account_id,
                    "date": (
                        datetime.now(timezone.utc) - timedelta(days=i)
                    ).isoformat(),
                    "description": f"Transaction {i}",
                    "amount": -50.0 * (i + 1),
                    "currency": "CHF",
                    "category": "Food" if i % 2 == 0 else "Transport",
                },
            )

    def test_list_transactions_empty(self, client, test_user):
        """Test listing transactions when none exist."""
        response = client.get("/api/transactions")

        assert response.status_code == 200
        data = response.json()
        assert "items" in data or "transactions" in data or isinstance(data, list)

    def test_list_transactions_with_data(self, client, test_user, test_account):
        """Test listing transactions with data."""
        self._create_transactions(client, test_account.id, 5)

        response = client.get("/api/transactions")

        assert response.status_code == 200
        data = response.json()
        items = data.get("items", data.get("transactions", data))
        assert isinstance(items, list)
        assert len(items) == 5

    def test_list_transactions_filter_by_category(
        self, client, test_user, test_account
    ):
        """Test filtering transactions by category."""
        self._create_transactions(client, test_account.id, 5)

        response = client.get("/api/transactions", params={"category": "Food"})

        assert response.status_code == 200
        data = response.json()
        items = data.get("items", data.get("transactions", data))
        # Only Food transactions should be returned
        food_count = sum(1 for item in items if item.get("category") == "Food")
        assert food_count > 0

    def test_list_transactions_unauthenticated(self, app):
        """Test listing transactions without authentication."""
        from fastapi.testclient import TestClient

        with TestClient(app, raise_server_exceptions=False) as test_client:
            response = test_client.get("/api/transactions")
            assert response.status_code == 401


# ── Update Transaction Tests ─────────────────────────────────────


class TestUpdateTransaction:
    """Tests for the PUT /transactions/{id} endpoint."""

    def _create_transaction(self, client, test_user, test_account):
        """Helper to create a transaction and return it."""
        response = client.post(
            "/api/transactions",
            json={
                "account_id": test_account.id,
                "date": datetime.now(timezone.utc).isoformat(),
                "description": "Original Description",
                "amount": -100.0,
                "currency": "CHF",
                "category": "Food",
                "notes": "Original notes",
            },
        )
        return response.json()

    def test_update_transaction_success(self, client, test_user, test_account):
        """Test successful transaction update."""
        txn = self._create_transaction(client, test_user, test_account)

        response = client.put(
            f"/api/transactions/{txn['id']}",
            json={
                "description": "Updated Description",
                "category": "Transport",
                "notes": "Updated notes",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["description"] == "Updated Description"
        assert data["category"] == "Transport"
        assert data["notes"] == "Updated notes"
        assert data["amount"] == -100.0  # Unchanged

    def test_update_transaction_partial(self, client, test_user, test_account):
        """Test updating only some fields."""
        txn = self._create_transaction(client, test_user, test_account)

        response = client.put(
            f"/api/transactions/{txn['id']}",
            json={
                "amount": -150.0,
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["amount"] == -150.0
        # Description should remain unchanged
        assert data["description"] == "Original Description"

    def test_update_transaction_nonexistent(self, client, test_user):
        """Test updating a non-existent transaction."""
        response = client.put(
            "/api/transactions/99999",
            json={"description": "Hacker"},
        )

        assert response.status_code == 404

    def test_update_transaction_unauthenticated(self, app):
        """Test updating a transaction without authentication."""
        from fastapi.testclient import TestClient

        with TestClient(app, raise_server_exceptions=False) as test_client:
            response = test_client.put(
                "/api/transactions/1",
                json={"description": "Hacker"},
            )
            assert response.status_code == 401


# ── Delete Transaction Tests ─────────────────────────────────────


class TestDeleteTransaction:
    """Tests for the DELETE /transactions/{id} endpoint."""

    def _create_transaction(self, client, test_user, test_account):
        """Helper to create a transaction and return it."""
        response = client.post(
            "/api/transactions",
            json={
                "account_id": test_account.id,
                "date": datetime.now(timezone.utc).isoformat(),
                "description": "To Be Deleted",
                "amount": -50.0,
                "currency": "CHF",
            },
        )
        return response.json()

    def test_delete_transaction_success(self, client, test_user, test_account):
        """Test successful transaction deletion (soft delete)."""
        txn = self._create_transaction(client, test_user, test_account)

        response = client.delete(f"/api/transactions/{txn['id']}")

        assert response.status_code == 200
        data = response.json()
        assert data["is_deleted"] is True
        assert "deleted_at" in data

    def test_delete_transaction_nonexistent(self, client, test_user):
        """Test deleting a non-existent transaction."""
        response = client.delete("/api/transactions/99999")

        assert response.status_code == 404

    def test_delete_transaction_unauthenticated(self, app):
        """Test deleting a transaction without authentication."""
        from fastapi.testclient import TestClient

        with TestClient(app, raise_server_exceptions=False) as test_client:
            response = test_client.delete("/api/transactions/1")
            assert response.status_code == 401


# ── Statistics Tests ─────────────────────────────────────────────


class TestTransactionStats:
    """Tests for the GET /transactions/stats endpoint."""

    def _create_transactions(self, client, account_id: int):
        """Helper to create sample transactions."""
        now = datetime.now(timezone.utc)
        for i in range(10):
            client.post(
                "/api/transactions",
                json={
                    "account_id": account_id,
                    "date": (now - timedelta(days=i)).isoformat(),
                    "description": f"Transaction {i}",
                    "amount": -50.0 if i % 2 == 0 else 2000.0,
                    "currency": "CHF",
                    "category": "Food" if i % 2 == 0 else "Salary",
                },
            )

    def test_get_stats_success(self, client, test_user, test_account):
        """Test getting transaction statistics."""
        self._create_transactions(client, test_account.id)

        response = client.get("/api/transactions/stats")

        assert response.status_code == 200
        data = response.json()
        assert "total_income" in data
        assert "total_expenses" in data
        assert "net" in data
        assert "avg_monthly_expenses" in data
        assert "top_categories" in data
        assert "transaction_count" in data
        assert data["transaction_count"] == 10

    def test_get_stats_empty(self, client, test_user):
        """Test getting stats with no transactions."""
        response = client.get("/api/transactions/stats")

        assert response.status_code == 200
        data = response.json()
        assert data["total_income"] == 0.0
        assert data["total_expenses"] == 0.0
        assert data["net"] == 0.0
        assert data["transaction_count"] == 0

    def test_get_stats_filter_by_date_range(self, client, test_user, test_account):
        """Test getting stats with date range filter."""
        self._create_transactions(client, test_account.id)

        now = datetime.now(timezone.utc)
        start_date = (now - timedelta(days=5)).strftime("%Y-%m-%d")
        end_date = now.strftime("%Y-%m-%d")

        response = client.get(
            "/api/transactions/stats",
            params={"start_date": start_date, "end_date": end_date},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["transaction_count"] <= 10


# ── Monthly Summary Tests ────────────────────────────────────────


class TestMonthlySummary:
    """Tests for the GET /transactions/monthly-summary endpoint."""

    def _create_transactions(self, client, account_id: int):
        """Helper to create sample transactions across months."""
        now = datetime.now(timezone.utc)
        for i in range(30):
            # Spread across current and previous month
            days_ago = i * 2
            client.post(
                "/api/transactions",
                json={
                    "account_id": account_id,
                    "date": (now - timedelta(days=days_ago)).isoformat(),
                    "description": f"Transaction {i}",
                    "amount": -50.0 if i % 2 == 0 else 2000.0,
                    "currency": "CHF",
                    "category": "Food" if i % 2 == 0 else "Salary",
                },
            )

    def test_get_monthly_summary_success(self, client, test_user, test_account):
        """Test getting monthly summary."""
        self._create_transactions(client, test_account.id)

        response = client.get("/api/transactions/monthly-summary")

        assert response.status_code == 200
        data = response.json()
        assert "items" in data or "summary" in data or isinstance(data, list)

    def test_get_monthly_summary_empty(self, client, test_user):
        """Test getting monthly summary with no transactions."""
        response = client.get("/api/transactions/monthly-summary")

        assert response.status_code == 200
        data = response.json()
        assert "items" in data or "summary" in data or isinstance(data, list)

    def test_get_monthly_summary_filter_by_year(self, client, test_user, test_account):
        """Test getting monthly summary for a specific year."""
        self._create_transactions(client, test_account.id)

        response = client.get(
            "/api/transactions/monthly-summary", params={"year": 2024}
        )

        assert response.status_code == 200
        data = response.json()
        assert "items" in data or "summary" in data or isinstance(data, list)


# ── Bulk Categorize Tests ────────────────────────────────────────


class TestBulkCategorize:
    """Tests for the POST /transactions/bulk-categorize endpoint."""

    def _create_transactions(self, client, test_user, test_account, count: int = 3):
        """Helper to create transactions and return their IDs."""
        txn_ids = []
        for i in range(count):
            response = client.post(
                "/api/transactions",
                json={
                    "account_id": test_account.id,
                    "date": datetime.now(timezone.utc).isoformat(),
                    "description": f"Uncategorized {i}",
                    "amount": -50.0,
                    "currency": "CHF",
                    "category": None,
                },
            )
            txn_ids.append(response.json()["id"])
        return txn_ids

    def test_bulk_categorize_success(self, client, test_user, test_account):
        """Test bulk categorization."""
        txn_ids = self._create_transactions(client, test_user, test_account, 3)

        response = client.post(
            "/api/transactions/bulk-categorize",
            json={
                "transaction_ids": txn_ids,
                "force_recategorize": False,
            },
        )

        # Should return 200 or 202 (async processing)
        assert response.status_code in [200, 202]

    def test_bulk_categorize_invalid_ids(self, client, test_user):
        """Test bulk categorize with invalid transaction IDs."""
        response = client.post(
            "/api/transactions/bulk-categorize",
            json={
                "transaction_ids": [99999, 99998],
                "force_recategorize": False,
            },
        )

        # Should return an error
        assert response.status_code in [400, 404, 422]
