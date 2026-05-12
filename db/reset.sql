-- =============================================================
-- myfirstagentapp_db : 모든 테이블 동적 DROP (D32, 2026-05-14)
-- =============================================================
-- Use: mysql -u root -p < db/reset.sql
-- Or via npm:  npm run reset-db
--
-- "재실행" 시맨틱:
--   - information_schema에서 myfirstagentapp_db 안의 *모든 테이블* 조회
--   - 단일 DROP 문으로 일괄 삭제 (PREPARE + EXECUTE)
--   - 빈 DB이거나 테이블이 0개일 때 NULL 안전 처리 (IFNULL → SELECT 1)
--
-- 후속:
--   호출자(lib/reset_db.js, ui/routes/init.js, ui/routes/git.js#resetDatabase)
--   가 이 파일 실행 후 db/*.sql(reset.sql 자기 자신 제외)을 알파벳 순서로
--   순회 실행한다. 미래에 비즈니스 schema(db/business_schema.sql 등)가
--   추가되면 자동으로 함께 적용됨.
-- =============================================================

USE myfirstagentapp_db;

SET FOREIGN_KEY_CHECKS = 0;
SET GROUP_CONCAT_MAX_LEN = 100000;

SET @tables = (
  SELECT GROUP_CONCAT('`', table_name, '`')
  FROM information_schema.tables
  WHERE table_schema = 'myfirstagentapp_db'
);

-- 빈 DB이면 @tables가 NULL — IFNULL로 no-op SQL로 대체해 PREPARE 실패 방지.
SET @sql = IFNULL(CONCAT('DROP TABLE IF EXISTS ', @tables), 'SELECT 1');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET FOREIGN_KEY_CHECKS = 1;
