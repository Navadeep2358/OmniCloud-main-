CREATE TABLE IF NOT EXISTS user_settings (
 user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
 preferences JSON NOT NULL,
 notifications JSON NOT NULL,
 cloud_preferences JSON NOT NULL,
 updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;