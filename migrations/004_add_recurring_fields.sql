-- Migration: Add recurring transaction fields
-- Created: 2026-04-02

-- Add is_recurring flag
ALTER TABLE transactions
ADD COLUMN is_recurring BOOLEAN DEFAULT 0;

-- Add periodicity field with constraint
ALTER TABLE transactions
ADD COLUMN periodicity TEXT CHECK(periodicity IN ('weekly', 'monthly', 'quarterly', 'halfyearly', 'yearly'));

-- Create index for faster recurring transaction queries
CREATE INDEX IF NOT EXISTS ix_transactions_is_recurring ON transactions(is_recurring);
CREATE INDEX IF NOT EXISTS ix_transactions_periodicity ON transactions(periodicity);

-- Update existing transactions that might be recurring (optional - based on patterns)
-- This is a placeholder for any data migration logic
