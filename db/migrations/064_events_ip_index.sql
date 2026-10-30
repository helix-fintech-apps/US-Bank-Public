-- Index for counting recent audit rows by address. Safe to run twice.
CREATE INDEX IF NOT EXISTS audit_events_ip_at ON audit_events(ip, at DESC) WHERE ip IS NOT NULL;
