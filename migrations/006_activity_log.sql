-- Audit trail for transaction deletes / bulk archive
CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT (datetime('now')),
    action VARCHAR(64) NOT NULL,
    method VARCHAR(16) NOT NULL,
    affected_rows INTEGER NOT NULL DEFAULT 0,
    detail TEXT
);

CREATE INDEX IF NOT EXISTS ix_activity_log_user_created ON activity_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_activity_log_user_id ON activity_log(user_id);
