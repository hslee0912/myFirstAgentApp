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

// 무기 4종 — 표 순서가 ENEMY_SHAPE_BY_WEAPON 매핑 순서와 1:1 일치 (절대 순서 변경 금지)
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

// 적 spawn 시 무기 → 모양 빠른 lookup
export const ENEMY_SHAPE_BY_WEAPON = {
  holy_sword:    'triangle',           // ▲ 정삼각형
  thunder_lance: 'star',               // ★ 5각 별
  fire_magic:    'square',             // ■ 정사각형
  holy_light:    'inverted_triangle',  // ▽ 역삼각형
};

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

// spawn 보충 룰 (§7-9-2)
export const SPAWN_CONFIG = {
  minOnScreen: 5,
  maxOnScreen: 12,
  firstSpawnDelayMs: 500,
  intervalByStage: { 1: 1500, 2: 1300, 3: 1100, 4: 900, 5: 700 },
};

// 적 이동 속도 (§7-9-3)
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
