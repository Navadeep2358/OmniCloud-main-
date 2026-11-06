ALTER TABLE cloud_connections
  ADD COLUMN azure_subscription_id CHAR(36) NULL,
  ADD COLUMN azure_tenant_id CHAR(36) NULL,
  ADD COLUMN azure_resource_group VARCHAR(90) NULL;

CREATE TABLE IF NOT EXISTS azure_terraform_deployments (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  connection_id CHAR(36) NOT NULL,
  template_id VARCHAR(64) NOT NULL,
  display_name VARCHAR(64) NOT NULL,
  vm_name VARCHAR(15) NOT NULL,
  location VARCHAR(32) NOT NULL,
  machine_size VARCHAR(32) NOT NULL,
  admin_username VARCHAR(64) NOT NULL,
  ssh_public_key LONGTEXT NOT NULL,
  status VARCHAR(24) NOT NULL,
  outputs_json LONGTEXT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE KEY uq_azure_vm_name (connection_id, vm_name),
  KEY idx_azure_terraform_deployments_owner (user_id, connection_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS azure_terraform_operations (
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
  KEY idx_azure_terraform_operations_owner (user_id, connection_id, status),
  KEY idx_azure_terraform_operations_deployment (deployment_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
