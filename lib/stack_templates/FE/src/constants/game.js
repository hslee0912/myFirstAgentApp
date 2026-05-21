/**
 * 결정론적 게임 상수 placeholder (D88·D94, 2026-05-20~21).
 *
 * 현재 게임: 판타지 종스크롤 슈팅 (tmp_big_prompt_run.txt 명세).
 *
 * `stack.config.json.FE.protectedConfigFiles`에 등록되어 있어 FE Agent가
 * 응답에 포함하면 validatePaths가 차단. 모든 GamePage.jsx 코드는 *반드시*
 * 이 파일을 import만 하고 *수정·재정의 금지*.
 *
 * ⚠️ 게임을 변경할 때 (예: 퍼즐 게임으로 전환) 이 파일과 명세서(§7-10)를
 *    *동시에 갱신*. 한쪽만 수정하면 cycle SpecSync 또는 시각 회귀.
 */

export const CANVAS = { width: 1000, height: 750 };

export const STAGES = [
  { stage: 1, theme: 'Magic Forest', bgColor: '#1B4D2E', scoreThreshold: 1000 },
  { stage: 2, theme: 'Cursed Swamp', bgColor: '#1A3D3A', scoreThreshold: 2000 },
  { stage: 3, theme: 'Lava Volcano', bgColor: '#5C1A0E', scoreThreshold: 3000 },
  { stage: 4, theme: 'Dark Castle',  bgColor: '#1E1A33', scoreThreshold: 4000 },
  { stage: 5, theme: 'Demon Tower',  bgColor: '#0A0A0A', scoreThreshold: null  },
];

// 무기 4종 — 표 순서가 ENEMY_SHAPE_BY_WEAPON 매핑 순서와 1:1 일치 (절대 순서 변경 금지).
//
// 🎮 플레이어 무기 선택 흐름 (cycle 무기 선택 버그 반복 사유 → 가드 강화):
//
//   1) SelectPage가 이 배열을 4개 카드로 렌더 (name·color·cost·pattern·fireDelayMs 표시).
//   2) 카드 클릭 시 *선택된 항목의 id 문자열* (`'holy_sword'` 등)을 부모로 콜백 전달.
//   3) 부모(App.jsx 등)가 그 id를 상태에 저장 후 GamePage에 prop으로 전달.
//   4) GamePage가 받은 id를 `hero.selectedWeapon`에 *문자열로* 저장.
//   5) 매 발사 직전 `WEAPONS.find(w => w.id === hero.selectedWeapon)`로 현재 무기 lookup.
//
// 🎮 슬롯 전환 (1·2·3·4 키):
//   - `hero.selectedWeapon = WEAPONS[키 숫자 − 1].id` (배열 0-indexed).
//   - 슬롯 전환은 항상 허용. MP·발사 가능 여부는 발사 시점에만 검사.
//   - 다음 발사부터 즉시 새 무기 적용 (캐싱하지 말 것 — id 문자열만 보관, lookup은 매번).
//
// 🚫 환각 금지 (모두 이번 cycle 무기 선택 버그 케이스):
//   - 객체 전체 전달: `<GamePage weapon={WEAPONS[0]} />` — 참조 갱신 시 stale. id 문자열만 전달.
//   - 인덱스(정수) 전달: `<GamePage weaponIdx={0} />` — 배열 순서 변경 시 깨짐. id 문자열만.
//   - 초기 무기 hardcode: `hero.selectedWeapon = 'holy_sword'` 항상 — 사용자 SelectPage 선택 무시.
//   - 슬롯 if/else hardcode: `if (key === '1') setWeapon('holy_sword')` — 동적 lookup `WEAPONS[키-1].id` 사용.
//   - SelectPage 자체 누락 — 게임에서 바로 진입, 무기 선택 화면 없음.
export const WEAPONS = [
  { id: 'holy_sword',    name: '성검',         color: '#FFD700', cost: 0, pattern: 'single', fireDelayMs: 100 },
  { id: 'thunder_lance', name: '번개 창',      color: '#A347FF', cost: 3, pattern: 'pierce', fireDelayMs: 300 },
  { id: 'fire_magic',    name: '불꽃 마법',    color: '#FF3B30', cost: 5, pattern: 'fan',    fireDelayMs: 200 },
  { id: 'holy_light',    name: '성스러운 빛',  color: '#33E0E0', cost: 8, pattern: 'omni',   fireDelayMs: 400 },
];

// 공격 패턴 정의 — *플레이어/적 공통*. WEAPONS[i].pattern을 키로 lookup.
//   bullets: *각도 offset의 단순 숫자 배열* (deg, 기준 방향에서 +/-).
//     - 플레이어: 기준 방향 = 위쪽 (0deg = up)
//     - 적: 기준 방향 = 발사 시점 player 위치 (aimed)
//     - omni만 예외 — fixedDirection:true 이면 *고정 8방향* (player 무관)
//   pierce: 탄환이 적·플레이어와 충돌 후에도 *유지* (관통)
//   speedMul: BULLET_SPEED에 곱할 배수 (pierce는 1.6배 고속)
//
// 🚫 LLM이 적별로 다른 공격 패턴 만들지 말 것. enemy.weapon.pattern → 이 객체 lookup만.
// ⚠️ bullets는 *숫자 배열* (degrees). 객체 배열로 바꾸지 말 것 — spawnBullets가 단순
//    `bullets.map(deg => baseAngle + deg*PI/180)` 패턴을 가정.
export const PATTERN_DEFINITIONS = {
  single: {
    description: '직선 단발',
    bullets: [0],
    pierce: false,
    speedMul: 1.0,
    fixedDirection: false,
  },
  fan: {
    description: '부채꼴 3발 ±20°',
    bullets: [-20, 0, 20],
    pierce: false,
    speedMul: 1.0,
    fixedDirection: false,
  },
  pierce: {
    description: '관통 고속 1발',
    bullets: [0],
    pierce: true,
    speedMul: 1.6,
    fixedDirection: false,
  },
  omni: {
    description: '360° 8방향 단발',
    bullets: [0, 45, 90, 135, 180, 225, 270, 315],
    pierce: false,
    speedMul: 1.0,
    fixedDirection: true,  // player 위치 무관 — 8방향 고정
  },
};

// 적 spawn 시 무기 → 모양 빠른 lookup.
//
// 값은 *문자열 4종* (`'triangle' | 'star' | 'square' | 'inverted_triangle'`).
// drawEnemy(ctx, enemy)는 enemy.shape *문자열 자체*로 switch해서 4가지 path 모두
// 그려야 함 (단일 path 하드코딩 금지 — 모두 같은 모양으로 나옴).
//
// 🚫 LLM이 흔히 하는 실수:
//   - 삼각형 path 하나만 그리고 enemy.shape를 안 읽음 → 모든 적 삼각형
//   - 'pentagon'/'circle' 같이 *없는 모양* 추가 — 무기 ID 매핑 깨짐
export const ENEMY_SHAPE_BY_WEAPON = {
  holy_sword:    'triangle',           // ▲ 정삼각형
  thunder_lance: 'star',               // ★ 5각 별
  fire_magic:    'square',             // ■ 정사각형
  holy_light:    'inverted_triangle',  // ▽ 역삼각형
};

// 적 무기 풀 — *stage 번호로 lookup* (이번 cycle 적 무기 선택 버그 핵심).
//
// ⚠️ **1-indexed 객체** — 키가 1, 2, 3, 4, 5. `ENEMY_POOLS[currentStage]`가 정답.
//    `ENEMY_POOLS[currentStage - 1]`처럼 0-indexed로 빼면 stage 1에서 undefined →
//    fallback으로 모든 적이 같은 무기 / 에러 / 빈 게임이 됨.
//
// 의도된 난이도 곡선:
//   - stage 1: holy_sword만 (1종)
//   - stage 2: holy_sword + thunder_lance (2종)
//   - stage 3: + fire_magic (3종)
//   - stage 4·5: 4종 모두
//
// 🚫 환각 금지 (모두 stage 진행 무의미화):
//   - `WEAPONS` 배열에서 직접 무작위 선택 — `ENEMY_POOLS` 우회. stage 1부터 4종 모두 등장.
//   - `ENEMY_POOLS[currentStage - 1]` 0-indexed lookup — 위 ⚠️ 참조.
//   - lookup 결과 undefined 시 hardcoded fallback (예: `'holy_sword'` 강제) — 모든 적 같은 무기.
//     올바른 대처는 lookup 자체가 실패 안 하도록 *currentStage 그대로 사용*.
//   - 고정 무기만 사용 (예: 항상 `WEAPONS[0]`) — 다양성 0.
//   - placeholder 풀 밖 무기 id (예: `'ice_bolt'`) 발명.
export const ENEMY_POOLS = {
  1: ['holy_sword'],
  2: ['holy_sword', 'thunder_lance'],
  3: ['holy_sword', 'thunder_lance', 'fire_magic'],
  4: ['holy_sword', 'thunder_lance', 'fire_magic', 'holy_light'],
  5: ['holy_sword', 'thunder_lance', 'fire_magic', 'holy_light'],
};

// 적이 자기 무기로 발사하는 주기 (주인공 fireDelayMs와 다른 개념)
export const ENEMY_FIRE_COOLDOWN_MS = {
  holy_sword:    1200,
  thunder_lance: 1500,
  fire_magic:    2000,
  holy_light:    3000,
};

// 스폰 빈도·상한 정의 (§9-2).
//
// 필드 (이름 정확히, LLM 환각 자주 일어나는 영역):
//   - minOnScreen:        화면에 *항상* 이만큼은 유지 (부족하면 추가 spawn)
//   - maxOnScreen:        동시 등장 상한 (이미 도달 시 spawn skip)
//   - firstSpawnDelayMs:  스테이지 시작 후 *첫* 스폰까지의 지연 (게임 시작 직후 평온)
//   - intervalByStage:    stage 번호(1~5) → 다음 스폰까지 ms. *stage별 다른 값*
//                         (stage 1: 느림, stage 5: 빠름). spawnTimer 비교 시 *현재
//                         stage의 값*을 lookup해야 stage 진행과 함께 난이도 상승.
//
// 🚫 LLM이 흔히 만드는 환각 필드 (절대 사용 금지):
//   - `intervalMs` (단일값)        ← intervalByStage[stage]로 lookup
//   - `maxEnemies` / `maxCount`    ← maxOnScreen 사용
//   - `baseSpeed` / `enemySpeed`   ← ENEMY_MOVEMENT[type].speed 사용
export const SPAWN_CONFIG = {
  minOnScreen: 5,
  maxOnScreen: 12,
  firstSpawnDelayMs: 500,
  intervalByStage: { 1: 1500, 2: 1300, 3: 1100, 4: 900, 5: 700 },
};

// 적 이동 패턴 정의 (§9-2) — *3종 모두 균등 확률*로 스폰 시 무작위 부여.
//
// 분기 키 = 객체의 *키 자체* (`'straight' | 'zigzag' | 'formation'`).
// 값 객체는 *패턴별로 다른 필드*를 가짐 (placeholder가 의도적으로 비대칭):
//   - straight:  { speed }                              직선 하강만, vy = speed
//   - zigzag:    { speed, amplitude, frequencyHz }      x는 sin파, y는 speed로 하강
//                  · amplitude: 좌우 진폭 (px)
//                  · frequencyHz: 초당 진동수 (1 = 1초에 1주기)
//                  · sin 인자: `2*PI*frequencyHz*t` (t는 spawn 후 경과 초)
//   - formation: { speed, groupSize }                   타원 편대 — *동시에 groupSize마리
//                  spawn하여 같은 궤적*. ellipse 중심·반지름은 코드 측이 자유 설계
//                  (예: 화면 좌우 중앙 진입 후 타원 그리며 하강).
//
// ⚠️ 분기 패턴 (반드시):
//   ```js
//   const key = Object.keys(ENEMY_MOVEMENT)[
//     Math.floor(Math.random() * Object.keys(ENEMY_MOVEMENT).length)
//   ];                                                  // 스폰 시 무작위 1개
//   enemy.movementType = key;                           // 문자열 키 저장
//   // 이동 update:
//   switch (enemy.movementType) {                       // 키로 분기
//     case 'straight':  …; break;
//     case 'zigzag':    …; break;
//     case 'formation': …; break;
//   }
//   ```
//
// 🚫 LLM이 흔히 하는 환각 (절대 금지):
//   - `movDef.type === 'zigzag'`로 분기 — *.type 필드는 존재 X* (NaN/undefined)
//   - 'orbit'/'linear'/'wave' 같이 *없는 키* 추가
//   - formation 누락 (3종 중 1종만 처리 → 나머지는 직선됨)
//   - frequencyHz를 `frequency`로 줄여 접근 (undefined → default fallback 무한반복)
export const ENEMY_MOVEMENT = {
  straight:  { speed: 80 },
  zigzag:    { speed: 70, amplitude: 80, frequencyHz: 1 },
  formation: { speed: 70, groupSize: 3 },
};

export const SCORE_PER_STAGE = { 1: 100, 2: 90, 3: 80, 4: 60, 5: 50 };

export const HERO_INITIAL = { hp: 100, mp: 100 };

export const DAMAGE = { bulletHit: 10, enemyCollide: 10 };

export const MP_REGEN = {
  amount: 2,
  intervalMs: 500,
  cooldownAfterFireMs: 300,
};

export const BULLET_SPEED = 250;  // px/s — 주인공/적 공통 직선 탄환 속도
