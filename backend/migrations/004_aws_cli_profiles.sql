ALTER TABLE cloud_connections
  MODIFY COLUMN role_arn VARCHAR(512) NULL,
  MODIFY COLUMN external_id VARCHAR(96) NULL,
  ADD COLUMN profile_name VARCHAR(64) NULL AFTER external_id;

CREATE INDEX idx_cloud_connections_user_profile
  ON cloud_connections(user_id, provider, profile_name);

UPDATE cloud_connections
SET status='disconnected', updated_at=UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000
WHERE provider='aws' AND profile_name IS NULL AND status='connected';
