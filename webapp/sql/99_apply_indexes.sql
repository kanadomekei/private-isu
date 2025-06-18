
-- Performance optimization indexes for Private ISU
-- Based on performance analysis conducted on 2025-06-18
-- These indexes address the most critical bottlenecks identified

USE isuconp;

-- Comments table indexes (highest priority)
-- Addresses 38.9% of total execution time bottleneck
ALTER TABLE comments ADD INDEX idx_post_id (post_id);
ALTER TABLE comments ADD INDEX idx_user_id (user_id);
ALTER TABLE comments ADD INDEX idx_post_id_created_at (post_id, created_at DESC);

-- Posts table indexes
-- Addresses 3.2% of total execution time bottleneck
ALTER TABLE posts ADD INDEX idx_created_at (created_at DESC);
ALTER TABLE posts ADD INDEX idx_user_id (user_id);
ALTER TABLE posts ADD INDEX idx_user_id_created_at (user_id, created_at DESC);

-- Users table indexes
-- Improves user lookup performance
ALTER TABLE users ADD INDEX idx_account_name (account_name);
ALTER TABLE users ADD INDEX idx_del_flg (del_flg);
ALTER TABLE users ADD INDEX idx_authority_del_flg (authority, del_flg);