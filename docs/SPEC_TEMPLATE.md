# 게임 명세서 템플릿 (PoC 신규 게임 작성용)

> **사용법**: 본 파일을 copy → `tmp_big_prompt_run.txt`로 저장 → 빈 슬롯 채우기.
>
> **작성 원칙** (3개):
> 1. *모호 표현 금지* — `적당히/잘/필요시/가끔/보통` 같은 단어는 모두 수치·단위·조건으로 치환. 자세한 룰은 `docs/SPEC_WRITING.md`.
> 2. *허용·금지 모두 명시* — ❌ 나쁜 예 → ✅ 좋은 예 → 🚫 금지 패턴 3단 구조.
> 3. *도메인 카탈로그 준수* — username/password/player_name·HTTP status·error message는 `rules/domain.md §2~§3` 글자 그대로.

---

# <프로젝트 제목>

> **§0. 게임 메타 정보** (CodeChecker 의사결정 힌트 — 첫 줄에 짧게)
>
> - **장르**: <슈팅 / 퍼즐 / 플랫포머 / RPG / 캐주얼 / 리듬 / ...>
> - **best score 의미**: <Yes — `/api/v1/game/best` endpoint 사용 / No — 결과 저장만, 4종 endpoint로 충분>
> - **장기 상태 변수**: <HP, MP, 시간, 목숨, 코인, 진행도 등 — HUD에 표시할 항목>
> - **플레이 시간**: 약 <N>초 ~ <M>분
> - **저장 단위**: <한 판 끝나면 결과 저장 / 매 stage 끝마다 / ...>

## 1. 프로젝트 개요

- <게임 한 줄 소개>
- <레퍼런스·오마주 있으면 명시>
- <Demo는 React 캔버스 / DOM / 등 구현 방식>

---

## 2. 폴더 구조

```
myFirstAgentApp/
├── .env                       # DB·BE_PORT·FE_PORT 등 (이미 설정됨)
├── package.json
├── BE/
│   └── src/
│       ├── server.js          # Express 진입점 (placeholder)
│       ├── validators.js      # 🔒 결정론 placeholder (수정 금지 — rules/domain.md §2 카탈로그)
│       ├── db.js              # mysql2 연결
│       └── routes/
│             ├── auth.js      # signup / check / login
│             └── result.js    # game/result, game/best (선택)
└── FE/
    └── src/
        ├── App.jsx
        ├── constants/
        │   └── game.js        # 🔒 결정론 placeholder (게임별 enum/색/수치 — §7-10에서 정의)
        ├── pages/
        │   ├── LoginPage.jsx
        │   ├── MemberShipPage.jsx
        │   ├── <게임별 페이지>.jsx
        │   ├── GamePage.jsx
        │   └── ResultPage.jsx
        └── components/
```

> 🔒 표시 파일은 `stack.config.json.protectedConfigFiles` 등록 대상. Agent 응답에 포함 시 차단.

---

## 3. 환경 변수 (.env, 이미 설정됨)

`DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `BE_PORT` (3001 기본) / `FE_PORT` (5173 기본). placeholder가 `process.env.BE_PORT || 3001` 패턴 사용 — 변수명 유지.

⚠️ `JWT_SECRET`은 본 PoC *사용 안 함*. 로그인 응답은 `player_id` / `username` / `player_name`.

---

## 4. MySQL 스키마 (테이블 2개 + 시드)

`BE/db/migrations/<UTC ts>_<name>.sql` emit. orchestrator Phase 2.5가 자동 적용. **charset/collation은 `utf8mb4` / `utf8mb4_unicode_ci`** (한글 player_name).

### 4-1. `player_users` (모든 게임 완전 고정 — 수정 금지)

| 컬럼 | 타입 | 비고 |
|---|---|---|
| id | BIGINT PK AUTO_INCREMENT | |
| username | VARCHAR(32) UNIQUE NOT NULL | 영문/숫자/언더스코어, 4~16자 (rules/domain.md §2) |
| password_hash | CHAR(60) NOT NULL | bcrypt rounds=10 (60자) |
| player_name | VARCHAR(60) NOT NULL | 한글 허용, 2~12자 |
| created_at | DATETIME DEFAULT CURRENT_TIMESTAMP | |

### 4-2. `game_results` (고정 컬럼 + 게임별 컬럼 분리)

**모든 게임 고정** (game/result + game/best 표준 동작 보장):

| 컬럼 | 타입 | 비고 |
|---|---|---|
| id | BIGINT PK AUTO_INCREMENT | |
| player_id | BIGINT NOT NULL | FK → player_users(id) |
| score | INT NOT NULL | 점수 의미 없는 게임은 *완료 단계 수*·*경과 시간* 등으로 매핑 |
| play_time | DATETIME NOT NULL | MySQL `'YYYY-MM-DD HH:MM:SS'` 형식만. FE가 ISO 8601 보내면 BE에서 `new Date(s).toISOString().slice(0,19).replace('T',' ')`로 변환 |
| is_best | TINYINT(1) DEFAULT 0 | 개인 최고 (game/best 사용 안 해도 컬럼은 유지) |
| INDEX | (player_id, score DESC) | |

**게임별 자유 추가** (필요한 것만):

| 컬럼 예시 | 비고 |
|---|---|
| stage | 슈팅·플랫포머 (TINYINT 1~N) |
| weapon_used | 슈팅 (VARCHAR + enum 검증) |
| play_duration | 모든 액션 (INT, 초) |
| pattern_seed | 랜덤 generated 게임 (VARCHAR nullable) |
| difficulty / level / clear_time / hint_used / ... | 게임 맞춰 추가 |

### 4-3. 시드 (INSERT IGNORE 1건씩 — D69 시드 정합성 필수)

- `player_users`: `(username='demo_user', password_hash='$2b$10$fmKqy9chmRPcdIq6nEbRoeP7bNX7CPQmZ7felu0VOleDBqeUO96Aq', player_name='데모용사')`
  - ⚠️ password_hash는 위 60자 *그대로* (`bcrypt.compareSync('Pass1234', hash) === true` 검증된 실제 hash).
- `game_results`: <게임별 시드 row 1건. *모든 validator를 통과*해야 함. 게임별 컬럼은 각 game/result endpoint validator 룰에 맞춘 값 사용>

> ⚠️ **시드 정합성**: 시드 row가 BE 핸들러 validation을 *전부* 통과해야 함. signup의 username regex가 `demo_user` 통과 (underscore 허용 필수). 게임별 enum/range validator도 시드 row를 통과시킬 것.

---

## 5. 회원가입 / 로그인 규칙 (모든 게임 동일 규칙 — rules/domain.md §2 참조)

> 이 섹션은 게임 무관 표준. 게임별로 *내용 수정 금지*.

### 5-1. 입력 필드 (`MemberShipPage.jsx`)

| 필드 | FE 검증 (실시간) | BE 재검증 |
|---|---|---|
| ID (`username`) | `^[a-zA-Z0-9_]{4,16}$`, **/auth/check로 중복 확인 필수** | 정규식 + UNIQUE |
| Password | 8자 이상, 영문+숫자 혼합 (`^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$`) | 동일 정규식 |
| Confirm Password | Password와 완전 일치해야 가입 버튼 활성 | (FE only) |
| Player Name | 한글/영문/숫자, 2~12자 | 길이 검증 |

### 5-2. 가입 버튼 활성 조건 (FE, AND)

1. 모든 필드 클라이언트 검증 PASS
2. Confirm Password = Password
3. **`/auth/check` 응답 `exists:false`로 중복확인 통과**

ID 입력이 바뀌면 *중복확인 상태 reset* — 다시 누르기 전까진 가입 비활성.

### 5-3. 보안

- 평문 저장 금지. **`bcrypt`** (`bcryptjs` 아님) `bcrypt.hash(password, 10)`.
- 로그인 응답에 토큰 X. `player_id` / `username` / `player_name`만.

### 5-4. BE Endpoint 4종 (+ game/best 옵션)

| # | Endpoint | Method | 핵심 | 옵션 |
|---|---|---|---|---|
| 1 | `/api/v1/auth/signup` | POST | 회원가입 | 모든 게임 필수 |
| 2 | `/api/v1/auth/check` | GET | username 중복 확인 | 모든 게임 필수 |
| 3 | `/api/v1/auth/login` | POST | bcrypt.compare + 세션 정보 | 모든 게임 필수 |
| 4 | `/api/v1/game/result` | POST | 결과 저장 + is_best 계산 | 모든 게임 필수 |
| 5 | `/api/v1/game/best` | GET | 개인 최고 + 이력 없으면 default | **game/best 의미 있는 게임만** (§0 메타) |

`base_url` 반드시 `/api/v1` 고정 (Nginx reverse proxy 정책).

#### 5-5-1. `POST /api/v1/auth/signup` (반드시 이 순서)

1. body `{username, password, player_name}` 누락 → `400 {success:false, error:"Missing required fields"}`
2. **username**: `validateUsername(username)` (BE/src/validators.js) → 실패 `400 {error:"Invalid username format"}`
3. **password**: `validatePassword(password)` → 실패 `400 {error:"Password too short or invalid"}`
4. **player_name**: `validatePlayerName(player_name)` → 실패 `400 {error:"Invalid player name"}`
5. `SELECT id FROM player_users WHERE username=?` → 있으면 `409 {error:"Username already exists"}`
6. `bcrypt.hash(password, 10)`
7. `INSERT INTO player_users (username, password_hash, player_name) VALUES (?, ?, ?)`
8. `201 {success:true, data:{id:insertId, username, player_name}}`

#### 5-5-2. `GET /api/v1/auth/check?username=<string>`

1. query.username 누락/형식 위반 → `400 {error:"Invalid username"}`
2. `SELECT id FROM player_users WHERE username=?`
3. `200 {success:true, data:{exists:boolean}}`

#### 5-5-3. `POST /api/v1/auth/login`

1. body `{username, password}` 누락 → `400`
2. `SELECT id, username, password_hash, player_name FROM player_users WHERE username=?`
3. row 없으면 → `401 {error:"Invalid username or password"}` (계정 존재 누설 방지)
4. `bcrypt.compare(password, row.password_hash)` false → 같은 `401`
5. `200 {success:true, data:{player_id, username, player_name}}`

#### 5-5-4. `POST /api/v1/game/result` (⚠️ datetime 변환 필수)

1. body `{player_id, score, play_time, ...<게임별>}` 누락 → `400`
2. 게임별 컬럼 validation (validators.js의 validateStage/Weapon/NonNegativeInt 등 호출 — *모든 endpoint 동일 함수*)
3. **`play_time` 변환**: `new Date(play_time).toISOString().slice(0,19).replace('T',' ')` 안 하면 `ER_TRUNCATED_WRONG_VALUE` 500
4. `SELECT MAX(score) FROM game_results WHERE player_id=?` (없으면 0)
5. `score > currentBest`면 `is_best=1` + 기존 is_best=1 row를 `UPDATE ... SET is_best=0`
6. `INSERT INTO game_results (...) VALUES (...)`
7. `201 {success:true, data:{result_id:insertId, is_best}}`

#### 5-5-5. `GET /api/v1/game/best?player_id=<integer>` (옵션 — game/best 사용 시)

1. query.player_id 누락/숫자 아님 → `400`
2. `SELECT <필요 컬럼> FROM game_results WHERE player_id=? AND is_best=1 ORDER BY score DESC LIMIT 1`
3. row 없으면 → `200 {success:true, data:{<default 응답 — null 금지>}}`
4. row 있으면 → `200 {success:true, data:{<row 매핑>}}`

⚠️ **시나리오 안정성** — `game/result` 시나리오 score는 *시드 best 미만*. `game/best`는 시드 row 그대로 검증.

### 5-6. 중복확인 FE 흐름

1. ID 입력 → 클라이언트 검증 PASS → "중복확인" 버튼 enabled
2. 클릭 → `GET /api/v1/auth/check?username=<encoded>`
3. `exists:false` → 사용 가능 + `usernameAvailable=true`
4. `exists:true` → 이미 사용 중 + `usernameAvailable=false`
5. ID 변경 시 `usernameChecked=false` reset

---

## 6. 화면 / 그래픽 규격

### 6-1. 캔버스·기본 시각

- 캔버스: **<폭>×<높이> px 고정**
- 주인공: <색·형태>
- 적·장애물: <색·형태 — 게임별>
- 배경: <색·이미지>

### 6-2. HUD 게이지 (필수 — 누락 시 사용자 상태 인지 불가)

§0 메타의 *장기 상태 변수마다* 표 작성:

| 변수 | 위치 | 크기 | 채워진 색 | 빈 색 | 외곽선 | 채워진 폭 계산 | 텍스트 형식 |
|---|---|---|---|---|---|---|---|
| <ex: HP> | `top:16px; left:16px` | 200×16 | `#FF4D4D` | `#333333` | white 1px | `200*(hp/max)` | `"HP <현재>/<최대>"` 12px white |
| ... | ... | ... | ... | ... | ... | ... | ... |

표시 조건: <항상 / 특정 state 시>. 변화 시: <즉시 frame 반영 / Nms transition>.

### 6-3. 부가 시각 요소 (선택)

- <스테이지 제목 위치 (있을 경우)>
- <pause 화면·effects·애니메이션>

---

## 7. 게임 규칙 (가변 — 게임별 모두 다름)

> 11개 슬롯을 모두 채울 것. 빈 슬롯이 있으면 LLM이 임의 추론으로 채움.

### 7-1. 장르·분류

§0과 동일. 1줄 요약. CodeChecker 의사결정 힌트.

### 7-2. 시각 형태

캔버스 안의 객체 종류·색·크기 (주인공·적·장애물·아이템·UI 등 모두).

### 7-3. 초기 상태 변수

| 변수 | 초기값 | 범위 | 단위 | clamp 함수 |
|---|---|---|---|---|
| <ex: HP> | 100 | [0, 100] | 단위 없음 | `Math.min(hp+N, 100)` |
| ... | ... | ... | ... | ... |

### 7-4. 자원·점수 변화 룰

각 변수마다:

| 변수 | 증가 트리거 | 변화량 | 감소 트리거 | 감소량 | 주기 | cooldown / 예외 |
|---|---|---|---|---|---|---|
| <ex: MP> | 자동 회복 | +2 | 공격 | -<cost> | 500ms | 공격 직후 300ms 동안 회복 X |

### 7-5. 진행 단위

stage / level / wave 등 사용 시:

| Stage | 전환 조건 | 배경·테마 | 색 HEX |
|---|---|---|---|
| 1 | <누적 score N 또는 <시간 N초>> | <테마명> | `#xxxxxx` |
| ... | ... | ... | ... |

🚫 **금지 패턴**: 모든 stage threshold를 동일값으로 두면 1 frame 안에 stage++ 반복 → 점프. 누적값 기준 *단계적 증가*.

### 7-6. 게임오버 조건 (frame 단위 명시)

`<조건>`이 *그 frame*에:

1. 같은 frame 안에 `navigate('/result')` 호출. setTimeout 금지.
2. game loop 즉시 중단 (`cancelAnimationFrame` + state flag).
3. 진행 중인 spawn / 탄환 / 회복 모두 중단.
4. ResultPage에 마지막 state 전달.

🚫 **금지 패턴**: 게임오버 직후에도 spawn·탄환 update 한 frame 더 진행되어 score 추가 가산.

### 7-7. 승리 조건 (있을 경우)

<조건 + ResultPage 전환 + 승패 표시>. 없으면 "<승리 조건 없음, 게임오버만>".

### 7-8. 점수 계산식

| 이벤트 | 점수 | 식 |
|---|---|---|
| <ex: 적 격파> | <Stage별 50~100> | `SCORE_PER_STAGE[currentStage]` |
| ... | ... | ... |

### 7-9. 적·장애물 패턴 (있을 경우)

#### 종류와 등장
| Stage | 등장 pool | 새로 추가된 적 |
|---|---|---|
| 1 | <리스트> | <설명> |
| ... | ... | ... |

#### 이동·공격 패턴
| 적 | 이동 | 공격 주기(ms) | 조준 방식 | 탄환 속성 |
|---|---|---|---|---|
| ... | ... | ... | 발사 시점 직선 / ... | `pierce: true` 등 |

#### 피격·사망
- <한 발 즉사 / N발 누적 / etc.>
- 🚫 **금지**: HP/durability/무적시간 (한 발 즉사 룰일 경우).

#### 🚫 적 행동 금지 패턴 (필수 — LLM이 자주 어김)
- **유도탄 (homing)**: 매 frame `dx = player.x - bullet.x` 재계산. 금지.
- **추적 (tracking)**: setInterval로 주기적 vx/vy 갱신. 금지.
- **곡선 궤적**: 명세에 없으면 금지.
- **속도 임의 변형**: 표 외 속도 금지.

### 7-10. 결정론 placeholder 매핑 (`FE/src/constants/game.js`)

이 게임의 결정론 영역. Bootstrap이 깐 placeholder에 다음 상수를 export — Agent는 import만:

```js
// 예시 (게임별 채움)
export const CANVAS = { width: <W>, height: <H> };
export const STAGES = [
  { stage: 1, theme: '<테마>', bgColor: '#xxxxxx', scoreThreshold: <N> },
  // ...
];
export const ENUMS = {
  weapon: ['holy_sword', 'fire_magic', /* ... */],
  // 게임별 enum
};
export const HERO_INITIAL = { hp: 100, mp: 100 /* ... */ };
export const DAMAGE = { /* ... */ };
export const SCORE_PER_STAGE = { /* ... */ };
```

`stack.config.json.FE.protectedConfigFiles`에 `FE/src/constants/game.js` 등록 → BE/FE Agent 응답에 포함 시 차단. *수정 절대 금지*.

### 7-11. ❌→✅→🚫 자가체크 (응답 emit 전)

응답 emit 직전 다음 확인 (게임별로 추가):

- [ ] §6-2 HUD 게이지 표의 모든 변수가 화면에 그려지는가? (HP만 그리고 MP 빠뜨림 회귀 차단)
- [ ] §7-3 초기값이 코드에 *글자 그대로* 들어갔는가?
- [ ] §7-4 변화 룰의 변화량·주기·cooldown이 코드에 정확히 반영됐는가?
- [ ] §7-6 게임오버가 *같은 frame 안에* navigate하고 game loop 중단되는가?
- [ ] §7-9 적 공격이 발사 시점 dx/dy 계산 후 변경 안 되는가? (homing 금지)
- [ ] §7-10 placeholder를 import만 했는가? (인라인 hex/enum 재정의 X)

---

## 8. 키보드·입력 (필수 — 누락 시 조작 불가)

| 키 | 동작 |
|---|---|
| ← ↑ ↓ → | <이동 / 메뉴 선택 / ...> |
| Space | <발사 / 점프 / 확인 / ...> |
| 1 / 2 / 3 / 4 | <무기 슬롯 / 메뉴 / ...> |
| ESC | 일시정지 토글 |
| <게임별 추가 키> | ... |

마우스·터치 사용 시도 명시. 키 동작은 *눌린 동안 / 한 번 클릭* 구분.

---

## 9. 결과 화면 / 리포트 (`ResultPage.jsx`)

### 9-1. 표시 항목

- 최종 점수, 도달 단계, 플레이 시간
- 게임별 통계 (피탄 횟수·격파 적 수·hint 사용 횟수 등)
- **개인 최고와 비교** (game/best 옵션 사용 시 — `GET /api/v1/game/best?player_id=<id>` 호출 결과)

### 9-2. `report.html` 다운로드 (Blob + download attribute)

```jsx
const html = `<!DOCTYPE html><html><body><h1>Result</h1>...</body></html>`;
const blob = new Blob([html], { type: 'text/html' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url; a.download = 'report.html';
a.click();
URL.revokeObjectURL(url);
```

브라우저 다운로드 폴더에 저장. 외부 라이브러리 불필요.

---

## 10. 완료 조건 (체크리스트)

- [ ] 로컬에서 BE / FE 동시 실행 확인
- [ ] `POST /signup`, `POST /login` API 정상 응답 (200 / 400 / 409)
- [ ] 회원가입 시 한글 Player Name 저장 확인 (MySQL UTF-8)
- [ ] Confirm Password 불일치 시 가입 실패
- [ ] `player_users`, `game_results` 시드 1건 이상 삽입 확인
- [ ] 게임오버 시 `game_results`에 결과 적재 확인
- [ ] <게임별 항목 추가> — 적 행동 / 화면 전환 / HUD 표시 등
- [ ] HP 0 도달 시 ResultPage 전환 확인 (frame 지연 없음)
- [ ] 게임 종료 후 `report.html` 생성 확인
- [ ] PostTest 5/5 PASS (또는 4/4 — game/best 미사용 시)

---

## 부록: 작성 시 참조 문서

- `docs/SPEC_WRITING.md` — 모호 표현 anti-pattern·boundary 5종·frame 단위 정의 등 자세한 가이드
- `rules/domain.md` — username/password 카탈로그·HTTP status·error message·scenario 템플릿
- `rules/common.md` / `rules/be.md` / `rules/fe.md` / `rules/db.md` — Agent prompt에 매 호출 inject되는 코딩 룰
