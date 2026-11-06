UPDATE cloud_connections
SET status='disconnected', updated_at=UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000
WHERE provider='aws' AND status IN ('connected','setup');

ALTER TABLE cloud_connections
  DROP INDEX idx_cloud_connections_user_profile,
  DROP COLUMN profile_name;
