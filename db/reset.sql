-- =============================================================
-- Wipe every table in myfirstagentapp_db (FK-safe one-shot).
-- =============================================================
-- Use: mysql -u root -p < db/reset.sql
-- Or via npm:  npm run reset-db
--
-- `log_task_state.decision_id` references `log_agent_decisions(id)`, so a
-- plain TRUNCATE on either table is blocked by the FK constraint. Disabling
-- FOREIGN_KEY_CHECKS for the duration of this script is the standard MySQL
-- escape — TRUNCATE also resets AUTO_INCREMENT, which DELETE FROM does not.
-- =============================================================

USE myfirstagentapp_db;

SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE log_task_state;
TRUNCATE TABLE log_agent_decisions;
TRUNCATE TABLE log_agent_runs;
TRUNCATE TABLE app_users;

SET FOREIGN_KEY_CHECKS = 1;
