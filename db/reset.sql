-- =============================================================
-- Drop + recreate every Agent 도구 테이블 in myfirstagentapp_db.
-- =============================================================
-- Use: mysql -u root -p < db/reset.sql
-- Or via npm:  npm run reset-db
--
-- "재실행" 시맨틱(D31=a, 2026-05-13):
--   - DROP TABLE log_*  (FK 의존 순서: state → decisions → runs)
--   - agent_schema.sql 실행 (모든 테이블 fresh CREATE)
--   완전 reset이 목적이라 TRUNCATE보단 DROP+CREATE를 선호.
--   테이블 정의 변경 시(컬럼 추가 등) 별도 마이그레이션 없이 reset만으로 반영됨.
-- =============================================================

USE myfirstagentapp_db;

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS log_task_state;
DROP TABLE IF EXISTS log_agent_decisions;
DROP TABLE IF EXISTS log_agent_runs;

SET FOREIGN_KEY_CHECKS = 1;

-- agent_schema.sql 실행은 lib/reset_db.js / ui/routes/init.js에서 이 파일을 실행한 뒤
-- 별도로 처리한다 (mysql CLI multi-file source는 환경 차이가 커서 application code에서 함).
