-- =============================================================
-- myfirstagentapp_db : single DB for business + agent logs
-- =============================================================
-- Run: mysql -u root -p < db/schema.sql
-- (or use lib/init_db.js)
-- =============================================================

CREATE DATABASE IF NOT EXISTS myfirstagentapp_db
    DEFAULT CHARACTER SET utf8mb4
    DEFAULT COLLATE utf8mb4_unicode_ci;

USE myfirstagentapp_db;

-- ----------------------------
-- Business table
-- ----------------------------
CREATE TABLE IF NOT EXISTS app_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ----------------------------
-- Agent execution log (per-agent run rows)
-- ----------------------------
CREATE TABLE IF NOT EXISTS log_agent_runs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id VARCHAR(64) NOT NULL,
    agent_name ENUM('Orchestrator','CodeChecker','FE','BE','Lint') NOT NULL,
    target ENUM('FE','BE') NULL,
    input_json JSON,
    output_json JSON,
    status ENUM('RUNNING','SUCCESS','FAILED') NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP NULL,
    INDEX idx_task (task_id),
    INDEX idx_agent_status (agent_name, status)
);

-- ----------------------------
-- Per-task final decision (1 row per task_id, owned by CodeChecker INSERT, Orchestrator UPDATE)
-- ----------------------------
CREATE TABLE IF NOT EXISTS log_agent_decisions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id VARCHAR(64) NOT NULL UNIQUE,
    final_verdict ENUM('IN_PROGRESS','PASS','FAIL','ERROR') NOT NULL DEFAULT 'IN_PROGRESS',
    final_result_text TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_task (task_id)
);

-- ----------------------------
-- Per-area state (1~2 rows per decision, owned by CodeChecker INSERT, Lint UPDATE)
-- ----------------------------
CREATE TABLE IF NOT EXISTS log_task_state (
    id INT AUTO_INCREMENT PRIMARY KEY,
    decision_id INT NOT NULL,
    target ENUM('FE','BE') NOT NULL,
    status ENUM('PENDING','SUCCESS','FAILED') NOT NULL DEFAULT 'PENDING',
    retry_count INT NOT NULL DEFAULT 0,
    failed_stage ENUM('STAGE1','STAGE2','STAGE3') NULL,
    fix_instructions TEXT NULL,
    stage_logs JSON NULL,
    result_text TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES log_agent_decisions(id),
    UNIQUE KEY uk_decision_target (decision_id, target),
    INDEX idx_decision (decision_id)
);
