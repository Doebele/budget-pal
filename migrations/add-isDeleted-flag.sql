-- Migration Script to Add isDeleted Flag to Accounts

ALTER TABLE accounts ADD COLUMN isDeleted BOOLEAN DEFAULT FALSE;
ALTER TABLE accounts ADD COLUMN deletedAt TIMESTAMP;
