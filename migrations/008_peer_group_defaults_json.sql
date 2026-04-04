-- Optional JSON snapshot of user-adjusted BFS peer defaults from wizard step 3.
-- PostgreSQL / generic SQL (run manually if not using app startup ALTER).

ALTER TABLE user_wizard_config
    ADD COLUMN IF NOT EXISTS peer_group_defaults_json TEXT;
