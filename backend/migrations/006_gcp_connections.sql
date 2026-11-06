ALTER TABLE cloud_connections
  MODIFY external_id VARCHAR(96) NULL,
  ADD COLUMN project_id VARCHAR(63) NULL AFTER role_arn,
  ADD COLUMN service_account_email VARCHAR(320) NULL AFTER project_id;
