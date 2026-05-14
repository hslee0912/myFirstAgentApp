# DB Migration Convention (Backend DB-Specific)

이 문서는 **BE Agent 전용**으로, 비즈니스 DB schema 변경(테이블 생성/수정/삭제)을 다룹니다. 공통 규칙은 `rules/common.md`, BE 일반 규칙은 `rules/be.md` 참조 — BE Agent의 system prompt에는 셋 다 합쳐 주입됩니다.

> 비즈니스 DB가 필요 없는 cycle(예: 이미 만든 테이블만 SELECT/INSERT)에선 이 문서를 따를 일이 없습니다. *새 테이블/컬럼/인덱스가 필요한 cycle만* 적용.

## 1. 두 schema의 *완전 분리* (위반 금지)

- **Agent 도구 schema**: `db/agent_schema.sql` — `log_agent_runs`, `log_agent_decisions`, `log_task_state`, `log_db_migrations`. **시스템이 관리**. 비즈니스 코드에서 SELECT/INSERT/UPDATE/DELETE/ALTER/DROP 절대 금지.
- **비즈니스 schema**: `BE/db/migrations/<UTC timestamp>_<snake_case>.sql` 파일에 사용자가 emit. **orchestrator Phase 2.5(Migration Agent)** 가 자동 적용 + `log_db_migrations`에 이력 기록.

**오해 금지**: `agent_schema.sql`을 *수정/덮어쓰기* 하려고 하지 말 것. 그 파일은 보호 영역.

## 2. Migration 파일명 (필수 규칙)

```
BE/db/migrations/<UTC YYYYMMDDHHmmss>_<snake_case_name>.sql
```

예시:
- `20260514120000_create_player_users.sql` — players 회원가입 테이블
- `20260514131500_add_score_index.sql` — score 컬럼에 인덱스 추가
- `20260515090000_alter_results_play_time_nullable.sql` — play_time NULL 허용

**규칙**:
- UTC timestamp 14자리(`YYYYMMDDHHmmss`) — *알파벳 순서 = 시간순 적용*을 보장. 같은 cycle 안에서도 timestamp가 1초씩 다르면 OK.
- `snake_case_name`은 *변경의 의미*를 짧게 표현. 한국어 X, ASCII만.
- 확장자는 반드시 `.sql`.

## 3. ⚠️ 적용된 migration 파일 수정 금지 — checksum 충돌 사고 방지

이게 가장 흔한 사고입니다. **한 번 적용에 성공한 migration 파일은 disk에서 절대 수정하지 마세요.**

### 시스템 동작
- `log_db_migrations` 테이블에 *각 파일의 SHA-256 checksum*이 기록됩니다.
- 다음 cycle에서 *같은 파일명*이 다시 보이는데 *disk의 checksum이 다르면* Migration Agent가 즉시 FAIL:
  ```
  Migration checksum 충돌 — 20260514120000_create_player_users.sql 외 N개. disk≠DB checksum.
  ```
- 이 FAIL은 retry로 풀리지 *않음*. 정상 경로는 *애초에 수정하지 않는 것*.

### LLM이 흔히 빠지는 사고 패턴

❌ **나쁨**: "users 테이블에 player_name 컬럼이 빠졌네 — 이전 migration 파일을 열어서 `CREATE TABLE` 정의에 컬럼 추가하자":
```sql
-- 20260514120000_create_player_users.sql (이미 적용된 파일)
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash CHAR(60) NOT NULL,
  player_name VARCHAR(50) NOT NULL    -- ← 이걸 *나중에* 끼워 넣으면 checksum 충돌
);
```

✅ **좋음**: *새 timestamp의 추가 migration 파일*로 ALTER 수행:
```sql
-- 20260514131500_add_player_name_to_users.sql (새 파일)
ALTER TABLE users ADD COLUMN IF NOT EXISTS player_name VARCHAR(50) NOT NULL DEFAULT '';
```

## 4. Idempotent하게 작성 (필수)

같은 migration이 *두 번 적용되어도 깨지지 않게* 작성하세요. MySQL 8 기준:

```sql
-- 좋음 — IF NOT EXISTS 사용
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS player_name VARCHAR(50);
```

```sql
-- 나쁨 — 재실행 시 "table already exists" 에러
CREATE TABLE users (...);
ALTER TABLE users ADD COLUMN player_name VARCHAR(50);
```

> 시스템이 checksum 체크로 중복 적용을 막아주긴 하지만, 사람이 reset 후 처음부터 재실행할 때 idempotent여야 안전합니다.

### 4-bis. ⚠️ 인덱스 (INDEX) — `IF NOT EXISTS` 미지원 (MySQL)

**MySQL은 `CREATE INDEX`에 `IF NOT EXISTS` 옵션을 *지원하지 않습니다* (5.x, 8.x 모두).** PostgreSQL과 다릅니다. 학습 데이터에서 본 `CREATE INDEX IF NOT EXISTS ...` 패턴은 *MySQL에서는 syntax error*. 다음 3가지 패턴 중 하나를 사용하세요:

**(1) 권장 — `CREATE TABLE` 정의 안에 INDEX 같이 명시**:
```sql
CREATE TABLE IF NOT EXISTS game_results (
  id INT AUTO_INCREMENT PRIMARY KEY,
  player_id INT NOT NULL,
  score INT NOT NULL,
  INDEX idx_player_score (player_id, score DESC),     -- 테이블 정의 안에 인덱스
  FOREIGN KEY (player_id) REFERENCES users(id)
);
```
→ `CREATE TABLE IF NOT EXISTS`가 idempotent를 보장. 인덱스는 테이블과 함께 만들어지므로 별도 안 다룸.

**(2) 새 migration 파일에서 ALTER로 인덱스 추가**:
```sql
-- 20260514130000_add_index_to_results.sql (별도 파일)
ALTER TABLE game_results ADD INDEX idx_player_score (player_id, score DESC);
```
→ migration 파일은 *한 번만 적용*되므로(`log_db_migrations` checksum) idempotent. 단, 이미 같은 인덱스 있으면 `Duplicate key name` 에러 → 그 파일은 *처음부터 한 번만* 적용되도록 보장.

**(3) ❌ 절대 금지 — `CREATE INDEX IF NOT EXISTS`**:
```sql
-- ❌ MySQL syntax error
CREATE INDEX IF NOT EXISTS idx_player_score ON game_results(player_id, score DESC);
```
이 패턴은 `lib/migration_sanity.js` 정적 grep이 *Lint Stage 1에서 즉시 잡아* retry를 강제합니다 (D48, 2026-05-14).

> 참고: MySQL 8.0.29+에는 `ALTER TABLE ... ADD INDEX` 자체에도 `IF NOT EXISTS` 옵션이 *없습니다*. `DROP INDEX IF EXISTS` (제거)는 있으나 `CREATE INDEX IF NOT EXISTS` (생성)는 PostgreSQL 전용 패턴입니다.

## 5. 한 cycle의 migration 개수

- **1~3개**가 적당. 관련된 변경(테이블 + 인덱스 + FK)은 *한 파일에 묶을 수 있음*.
- 7개씩 쪼개지 말 것 — orchestrator round loop이 매번 모두 적용·검증해야 해서 느려짐.
- 너무 큰 한 파일도 비추 — 100줄 넘어가면 가독성 ↓.

## 6. SQL 작성 룰

- `USE myfirstagentapp_db;` 문 **불필요** — orchestrator가 `database` 옵션으로 connection. 쓰면 syntax 노이즈만.
- 다중 statement는 `;`로 구분. mysql2의 `multipleStatements: true`로 connect됨.
- 주석은 `--` (line) 또는 `/* ... */` (block) 모두 OK.
- 외래키(FK)는 `REFERENCES <table>(<col>)` 정상 작동. 단, 참조되는 테이블이 *먼저* 만들어져야 함 → migration 순서 신경 쓸 것.

## 7. 적용 후 비즈니스 코드에서 사용

- migration이 만든 테이블만 BE 코드(`server.js` / `routes/*.js` / `services/*.js`)에서 SELECT/INSERT/UPDATE/DELETE 가능.
- 항상 `mysql2` prepared statement (`?` placeholder) — `rules/common.md` §2 참조.
- 비밀번호 컬럼은 항상 `CHAR(60)` 권장 (bcrypt 출력 길이).

## 8. 흔한 함정 모음

- **`CREATE DATABASE` 작성 금지** — DB는 시스템이 이미 만들어둠.
- **`DROP TABLE` / `TRUNCATE` 작성 금지** — 데이터 보호.
- **`agent_schema.sql`의 테이블(`log_*`)을 ALTER/DROP 시도 금지** — 시스템 도구 영역.
- **타임존 의존 코드 금지** — `CURRENT_TIMESTAMP` 만 사용. `TIMEZONE('Asia/Seoul', ...)` 같은 종속 X.
- **trigger / stored procedure 작성 비추** — 디버그 어렵고 PoC scope 밖.

---

**핵심 요약**: 한 cycle당 1~3개의 *새* `.sql` 파일을 `BE/db/migrations/<ts>_<name>.sql`에 emit. 이미 적용된 파일은 *절대 수정 금지* — 변경이 필요하면 *새 timestamp 파일*로 ALTER. Idempotent (`IF NOT EXISTS`)로 작성.

> ℹ️ D44 (2026-05-14): 매 BE Agent 호출의 user prompt에 `## 이미 적용된 migration`, `## 디스크의 migration 파일`, `## 현재 비즈니스 DB schema` 세 섹션이 *실제 상태로* 함께 inject된다. 그것들을 *반드시* 확인 — 같은 파일명을 재사용하거나 이미 있는 컬럼을 다시 CREATE 하지 말 것.
