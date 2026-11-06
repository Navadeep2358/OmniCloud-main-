-- Complete OmniCloud schema for a fresh MySQL database.
-- For an existing installation, do not use this as an upgrade script;
-- apply the numbered migrations instead, especially 006_gcp_connections.sql.

CREATE DATABASE IF NOT EXISTS omnicloud_auth
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE omnicloud_auth;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  mobile_number VARCHAR(20) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  verified_at BIGINT UNSIGNED NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY users_email_unique (email),
  UNIQUE KEY users_mobile_number_unique (mobile_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS verification_codes (
  email VARCHAR(254) NOT NULL,
  purpose ENUM('verify', 'reset') NOT NULL,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_sent_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (email, purpose),
  CONSTRAINT verification_codes_email_fk
    FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (token_hash),
  KEY sessions_user_id_idx (user_id),
  KEY sessions_expires_at_idx (expires_at),
  CONSTRAINT sessions_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_settings (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  preferences JSON NOT NULL,
  notifications JSON NOT NULL,
  cloud_preferences JSON NOT NULL,
  updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cloud_connections (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(24) NOT NULL,
  account_id VARCHAR(32) NULL,
  role_arn VARCHAR(512) NULL,
  aws_profile VARCHAR(64) NULL,
  aws_role_name VARCHAR(128) NULL,
  external_id VARCHAR(96) NULL,
  project_id VARCHAR(63) NULL,
  service_account_email VARCHAR(320) NULL,
  azure_subscription_id CHAR(36) NULL,
  azure_tenant_id CHAR(36) NULL,
  azure_resource_group VARCHAR(90) NULL,
  status VARCHAR(24) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  KEY idx_cloud_connections_user_provider (user_id, provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS terraform_deployments (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  connection_id CHAR(36) NOT NULL,
  template_id VARCHAR(64) NOT NULL,
  display_name VARCHAR(64) NOT NULL,
  bucket_name VARCHAR(63) NOT NULL,
  region VARCHAR(32) NOT NULL,
    resource_id VARCHAR(128) NULL,
    config_json LONGTEXT NULL,
    outputs_json LONGTEXT NULL,
  status VARCHAR(24) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE KEY uq_terraform_bucket_name (bucket_name),
  KEY idx_terraform_deployments_owner (user_id, connection_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS terraform_operations (
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
  KEY idx_terraform_operations_owner (user_id, connection_id, status),
  KEY idx_terraform_operations_deployment (deployment_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
