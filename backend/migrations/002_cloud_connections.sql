CREATE TABLE IF NOT EXISTS cloud_connections (
 id CHAR(36) NOT NULL PRIMARY KEY,
 user_id BIGINT UNSIGNED NOT NULL,
 provider VARCHAR(24) NOT NULL,
 account_id VARCHAR(32) NULL,
 role_arn VARCHAR(512) NULL,
 external_id VARCHAR(96) NOT NULL,
 status VARCHAR(24) NOT NULL,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 KEY idx_cloud_connections_user_provider(user_id,provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;