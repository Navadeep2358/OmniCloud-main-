CREATE TABLE IF NOT EXISTS terraform_deployments (
 id CHAR(36) NOT NULL PRIMARY KEY,
 user_id BIGINT UNSIGNED NOT NULL,
 connection_id CHAR(36) NOT NULL,
 template_id VARCHAR(64) NOT NULL,
 display_name VARCHAR(64) NOT NULL,
 bucket_name VARCHAR(63) NOT NULL,
 region VARCHAR(32) NOT NULL,
 status VARCHAR(24) NOT NULL,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 UNIQUE KEY uq_terraform_bucket_name(bucket_name),
 KEY idx_terraform_deployments_owner(user_id,connection_id,status)
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
 KEY idx_terraform_operations_owner(user_id,connection_id,status),
 KEY idx_terraform_operations_deployment(deployment_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
