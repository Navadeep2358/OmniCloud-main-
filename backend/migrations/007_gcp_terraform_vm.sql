-- Adds isolated Terraform metadata tables for Google Compute Engine VMs.
-- Existing AWS deployment and operation tables are unchanged.

CREATE TABLE IF NOT EXISTS gcp_terraform_deployments (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  connection_id CHAR(36) NOT NULL,
  template_id VARCHAR(64) NOT NULL,
  display_name VARCHAR(64) NOT NULL,
  instance_name VARCHAR(63) NOT NULL,
  zone VARCHAR(32) NOT NULL,
  machine_type VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL,
  outputs_json LONGTEXT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE KEY uq_gcp_terraform_instance (connection_id, instance_name),
  KEY idx_gcp_terraform_deployments_owner (user_id, connection_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gcp_terraform_operations (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  connection_id CHAR(36) NOT NULL,
  deployment_id CHAR(36) NOT NULL,
  action VARCHAR(16) NOT NULL,
  status VARCHAR(24) NOT NULL,
  plan_summary LONGTEXT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  KEY idx_gcp_terraform_operations_owner (user_id, connection_id, status),
  KEY idx_gcp_terraform_operations_deployment (deployment_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
