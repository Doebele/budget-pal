-- Migration: Add soft delete fields for transactions
-- Created: 2026-04-02

-- Add soft delete fields
ALTER TABLE transactions
ADD COLUMN is_deleted BOOLEAN DEFAULT 0;

ALTER TABLE transactions
ADD COLUMN deleted_at DATETIME;

-- Create index for filtering deleted transactions
CREATE INDEX IF NOT EXISTS ix_transactions_is_deleted ON transactions(is_deleted);
CREATE INDEX IF NOT EXISTS ix_transactions_deleted_at ON transactions(deleted_at);

-- Update all queries to filter by is_deleted = 0 or is_deleted IS NULL
-- Note: Existing transactions should remain visible (is_deleted = 0 or NULL)
