# Domain Field Catalog (CodeChecker + BE/FE Agent 공통)

이 문서는 **CodeChecker, BE Agent, FE Agent** 모두 매 LLM 호출 시 system prompt에 자동 inject된다. 도메인 필드의 validation 규칙·예시·표준 HTTP status·error message·test scenario 템플릿을 한 곳에 정의해 **endpoint 간 일관성**을 결정론적으로 보장한다.

근거: 2026-05-20 1회 cycle에서 BE Agent가 `signup`은 `newplayer1`(10자, 정상)을 통과시키고 `check`는 `totally_new_user99`(18자, 16자 max 초과)를 "available_username" PASS scenario로 만들어 endpoint 간 validator/scenarios가 어긋남 → PostTest FAIL. 이 카탈로그는 그 drift를 차단하기 위한 single source of truth다.

## 1. 핵심 원칙 (위반 시 PostTest FAIL 거의 확실)

- **같은 field 이름은 모든 endpoint에서 같은 규칙**. signup·login·check 등 endpoint마다 다른 validator 금지.
- spec(`router_details.request.schema.properties[].pattern/minLength/maxLength`)의 값은 §2 카탈로그를 **글자 그대로** 사용.
- BE production code의 validator는 §2 regex/조건을 **글자 그대로** 사용. 모든 endpoint가 **같은 함수**(예: `validateUsername()`)를 호출. endpoint별 inline 분기 금지.
- `test_scenarios[].request_body`의 valid 입력은 §2 "PASS 예" 중에서만 선택. invalid 입력은 §2 "FAIL 예" 중에서만 선택. 임의 값 금지.
- error message는 §3 정확 문자열을 사용.

## 2. 도메인 필드 카탈로그

### username
- regex: `^[a-zA-Z0-9_]{4,16}$`
- minLength: 4, maxLength: 16
- PASS 예: `newplayer1`, `demo_user`, `valid_user`, `player_99`, `test_user`
- FAIL 예:
  - 너무 짧음: `ab`, `joe`
  - 너무 김: `totally_new_user99` (18자), `superlongusername123`
  - 허용 안 된 문자: `with space`, `한글이름`, `dash-name`, `dot.user`

### password
- 조건: minLength 8, 알파벳·숫자 각각 1개 이상 포함
- regex: `^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$`
- PASS 예: `Pass1234`, `secure99x`, `userpass1`
- FAIL 예:
  - 너무 짧음: `abc`, `7chars1`
  - 숫자 누락 (`weak_password` scenario 표준): `password`, `Onlyalpha`
  - 알파벳 누락: `12345678`
- 보안: 평문 저장 X, 반드시 `bcrypt.hash(password, 10)` (`rules/common.md §2`).

### player_name
- regex: `^.{2,12}$` (한글·영문·숫자 모두 허용, 2~12자)
- PASS 예: `용사`, `테스트유저`, `새용사`, `Hero99`, `중복테스트`
- FAIL 예: `김`(1자), `이ABCDEFGHIJKLMN`(13자 이상)

### player_id
- type: integer, > 0
- PASS 예: `1`, `2`, `100`
- FAIL 예: `0`, `-1`, `"abc"`, `null`

### weapon_used (게임 도메인 — 다른 도메인 시 be_spec.notes에 추가 정의)
- enum: `holy_sword` | `fire_magic` | `ice_arrow` | `shadow_dagger`
- PASS 예: `holy_sword`, `fire_magic`
- FAIL 예: `unknown_weapon`, `sword`, `""`

### stage (게임 도메인)
- type: integer, 1 ≤ stage ≤ 5
- PASS 예: `1`, `3`, `5`
- FAIL 예: `0`, `6`, `-1`

### score / play_duration (게임 도메인)
- type: integer ≥ 0
- PASS 예: `0`, `100`, `500`, `999`
- FAIL 예: `-1`, `"abc"`

### pattern_seed (게임 도메인)
- type: string|null, nullable
- PASS 예: `seed_test`, `null`
- FAIL 예: (적용 시점 정의)

다른 도메인 (전자상거래·SNS 등) 필드는 본 PoC 스코프 밖. 필요 시 be_spec.notes에 카탈로그 형식 그대로 추가 정의.

## 3. 표준 HTTP status & error message

| 상황 | status | error message 정확 문자열 |
|---|---|---|
| 필수 필드 누락 | 400 | `Missing required fields` |
| 형식 위반 (regex/range 불일치) | 400 | `Invalid {field}` 또는 `Invalid {field} format` (예: `Invalid username`, `Invalid stage value`, `Invalid weapon_used value`) |
| 인증 실패 (login 비밀번호 틀림 등) | 401 | `Invalid username or password` |
| 권한 없음 | 403 | `Forbidden` |
| 리소스 없음 (조회 endpoint, GET) | 200 (default 응답) 또는 404 | endpoint 의도에 따라. 명세 결정. |
| 중복 (signup username 등) | 409 | `{Resource} already exists` (예: `Username already exists`) |
| 서버 에러 | 500 | `Internal server error` |

응답 형식 (`rules/common.md §3`):
```json
{ "success": false, "error": "위 표 정확 문자열" }
```

## 4. 표준 test scenario 템플릿

각 endpoint마다 다음 시나리오 중 적용 가능한 것을 *모두* 정의:

| 시나리오 이름 | 입력 패턴 | expect_status |
|---|---|---|
| `valid_*` (예: `valid_signup`, `valid_login`, `valid_result`) | 모든 필드 §2 PASS 예 사용 | 200 또는 201 |
| `missing_field` 또는 `missing_required_field` 또는 `missing_field_<name>` | required 필드 1개 누락 | 400 |
| `invalid_<field>` 또는 `invalid_<field>_format` (예: `invalid_username_format`, `invalid_weapon`, `invalid_stage`, `non_numeric_player_id`) | §2 FAIL 예 사용 | 400 |
| `weak_password` | §2 password FAIL 예 (`password`) | 400 |
| `duplicate_<resource>` (예: `duplicate_username`) | 시드값 사용 (CodeChecker spec §4-3) | 409 |
| `nonexistent_<resource>` (예: `no_results_player`, `ghost_user`) | 존재하지 않는 식별자 | endpoint 정책 |
| `invalid_credentials` | 비밀번호 틀린 시드 사용자 | 401 |
| `existing_<resource>` (조회) | 시드값 사용 | 200 |
| `available_<resource>` (중복 체크 등) | **§2 PASS 예 사용** (시드 외) | 200, `{exists: false}` |

⚠️ `available_username` 같은 "사용 가능 확인" 시나리오는 **PASS 예** 중에서 시드에 없는 값을 골라야 한다 (예: `valid_user`, `player_99`). FAIL 예(`totally_new_user99` 등)를 쓰면 BE validator가 거부해 400을 반환 → scenario FAIL.

### 4-bis. cross-endpoint 격리 (PostTest 직렬 실행 사이드 이펙트 차단 — D90)

PostTest는 endpoint × scenario를 **동일 컨테이너·동일 DB에 직렬 실행**한다. 따라서 한 endpoint의 시나리오가 INSERT한 row가 다음 endpoint의 검증을 *오염*시킬 수 있다. 다음 룰을 *반드시* 따른다:

- **`POST .../signup` (또는 register)의 `valid_*` scenario에서 사용한 `username`** 은 **같은 task의 `GET .../check` (또는 비슷한 "존재 여부 확인") endpoint의 `available_*` scenario에서 *재사용 금지***.
  - 이유: signup이 INSERT한 row를 check가 그대로 발견 → `available_*` 가 `exists:false`를 기대하는데 `exists:true` 받음 → scenario FAIL.
- §2 카탈로그 username PASS 예 5개(`newplayer1`, `demo_user`, `valid_user`, `player_99`, `test_user`)를 **겹치지 않게 배분**:
  - `demo_user` → 시드(존재). `existing_username`, `duplicate_username`, `valid_credentials` 시나리오.
  - signup `valid_*` → 5개 중 1개 골라 사용 (예: `newplayer1`).
  - check `available_*` → 위 두 곳에서 안 쓴 다른 값 (예: `player_99` 또는 `test_user`).
- 같은 원칙이 다른 unique 필드(이메일·전화번호 등)에도 적용된다. POST가 만든 row의 unique 키를 *그 뒤 endpoint의 "존재 안 함" 시나리오*에 쓰지 않는다.

❌ **나쁜 예** (이번 cycle FAIL 사례):
```json
"auth_signup": { "test_scenarios": [{ "name": "valid_signup", "request_body": { "username": "valid_user", ... }}] }
"auth_check":  { "test_scenarios": [{ "name": "available_username", "request_query": { "username": "valid_user" }}] }
//                                                                                                  ↑ 같은 값 → signup이 INSERT한 row가 check 시점에 존재 → FAIL
```

✅ **좋은 예**:
```json
"auth_signup": { "test_scenarios": [{ "name": "valid_signup", "request_body": { "username": "newplayer1", ... }}] }
"auth_check":  { "test_scenarios": [{ "name": "available_username", "request_query": { "username": "player_99" }}] }
//                                                                                                  ↑ signup이 안 쓴 값 → check 시점에 미존재 → PASS
```

`expect_response_subset`은 `{ success: <bool> }`만 강하게 검증 권장. 동적 값(id, timestamp)·가변 필드는 안 적는 게 안전 (D69).

## 5. BE Agent용 — `BE/src/validators.js` placeholder 강제 사용

`BE/src/validators.js`는 **bootstrap이 자동으로 깔아두는 결정론적 placeholder**다 (D88, 2026-05-20). `stack.config.json.BE.protectedConfigFiles`에 등록되어 있어 BE Agent가 응답에 포함하면 `validatePaths` 차단. **수정·재정의·재작성 금지**. 모든 endpoint(`signup`·`check`·`login` 등)는 다음 패턴으로 placeholder의 함수를 **import만**:

```js
const {
  validateUsername,
  validatePassword,
  validatePlayerName,
  validatePlayerId,
  validateStage,
  validateNonNegativeInt,
} = require('../validators');  // routes/*.js에서 상대경로

// signup, check, login 등 모든 route가 같은 함수 호출:
if (!validateUsername(username)) {
  return res.status(400).json({ success: false, error: 'Invalid username' });
}
```

placeholder가 제공하는 함수: `validateUsername`, `validatePassword`, `validatePlayerName`, `validatePlayerId`, `validateStage`, `validateNonNegativeInt`. enum 검증(`validateWeapon` 등 task별 가변값)은 placeholder에 없으므로 BE Agent가 routes 내부에 작성하되 router_details의 enum과 정확 일치.

endpoint별 inline regex/조건 분기 금지. placeholder 함수만 호출.

## 6. 응답 emit 전 자가 체크 (CodeChecker + BE Agent 공통)

응답 emit 직전 다음 5개 확인:

- [ ] router_details의 모든 `pattern`/`minLength`/`maxLength`는 §2 카탈로그와 **글자 그대로 일치**.
- [ ] `test_scenarios[].request_body`의 모든 valid 입력은 §2 "PASS 예" 중에서 선택.
- [ ] invalid 입력은 §2 "FAIL 예" 중에서 선택.
- [ ] BE production code의 validator는 §2 regex/조건을 그대로 사용 + 모든 endpoint에서 동일 함수 호출.
- [ ] error message는 §3 정확 문자열 사용.

위 5개 중 하나라도 어기면 endpoint 간 일관성이 깨져 PostTest FAIL을 유발한다.
