-- =============================================================
-- myfirstagentapp_db : Agent 도구 전용 schema (log_* tables only)
-- =============================================================
-- Run: mysql -u root -p < db/agent_schema.sql
-- (or use lib/init_db.js)
--
-- ⚠️ 이 파일은 *Agent 도구 테이블 전용*이다.
--    비즈니스 schema (`app_users`, 도메인 테이블 등)는 여기 추가 금지.
--    LLM이 비즈니스 SQL을 emit해도 *현재 시스템은 자동 적용하지 않는다*.
--    비즈니스 schema 적용 메커니즘은 향후 별도 작업 — rules/be.md §4 참조.
-- =============================================================

CREATE DATABASE IF NOT EXISTS myfirstagentapp_db
    DEFAULT CHARACTER SET utf8mb4
    DEFAULT COLLATE utf8mb4_unicode_ci;

USE myfirstagentapp_db;

-- ----------------------------
-- Agent execution log (per-agent run rows)
-- ----------------------------
CREATE TABLE IF NOT EXISTS log_agent_runs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id VARCHAR(64) NOT NULL,
    agent_name ENUM('Orchestrator','CodeChecker','FE','BE','Lint','Migration','Deploy','PostTest') NOT NULL,
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
    failed_stage ENUM('STAGE1','STAGE2','STAGE3','MIGRATION','AGENT_GUARD') NULL,
    fix_instructions TEXT NULL,
    stage_logs JSON NULL,
    result_text TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (decision_id) REFERENCES log_agent_decisions(id),
    UNIQUE KEY uk_decision_target (decision_id, target),
    INDEX idx_decision (decision_id)
);

-- ----------------------------
-- DB Migration 적용 이력 (D33, 2026-05-14) — Agent가 emit한 BE/db/migrations/*.sql 적용 추적
-- ----------------------------
CREATE TABLE IF NOT EXISTS log_db_migrations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(255) NOT NULL UNIQUE,        -- 예: '20260514120000_add_users.sql'
    task_id VARCHAR(64) NOT NULL,                 -- 어느 task가 만들었는지
    checksum CHAR(64) NOT NULL,                   -- SHA-256(file content) — 변경 감지
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status ENUM('SUCCESS','FAILED') NOT NULL,
    error_message TEXT NULL,
    INDEX idx_task (task_id),
    INDEX idx_applied_at (applied_at)
);
