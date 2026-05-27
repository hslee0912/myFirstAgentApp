'use strict';

/**
 * game_init_check.js — D98 (2026-05-27)
 *
 * FE Agent emit 직전에 호출되는 *정적 검사*. 게임 *초기 상태*가 잘못된 값으로
 * 박혀있는 경우 catch.
 *
 * 사용자 보고 (2026-05-27, 10회 cycle 후 직접 플레이 검증):
 *   - 버그 #1: 게임 시작 시 currentStage가 5인 경우 발견 (명세는 "무조건 1부터")
 *   - 버그 #2: 적 hp가 1이 아니어서 한 방에 안 죽는 경우 발견 (명세 §9-1 룰 추가됨)
 *
 * 두 버그 모두 *초기값 hardcode*에서 catch 가능. 정규식 패턴으로 검출.
 *
 * 검사 항목 (REGEX 매칭, 주석 제거 후 코드만):
 *   1. STAGE_INIT_NOT_ONE
 *      - `currentStage:\s*[2-9]` — 초기 stage 2~9 (반드시 1)
 *      - `stage:\s*[2-9]` — 같은 의도
 *      - `STAGES\.length` — 마지막 stage로 잘못 시작하는 패턴
 *      - `STAGES\[STAGES\.length\s*-\s*1\]` — 마지막 STAGES 항목으로 시작
 *
 *   2. ENEMY_HP_NOT_ONE
 *      - enemy 객체 정의에서 `hp:\s*[2-9]` 또는 `hp:\s*\d{2,}` — 한 방 사망 위배
 *      - `hp:\s*[A-Za-z]` 변수 참조 (`hp: weapon.cost`, `hp: stage` 같은 변동 HP)
 *
 * 정책:
 *   - 주석/문자열 제거 후 검사 (false positive 방지)
 *   - HERO_INITIAL.hp (placeholder, 100)는 *주인공*이라 검사 제외
 *   - context-aware: hero/player의 hp는 무시, enemy 컨텍스트의 hp만 catch
 */

const fs = require('fs');
const path = require('path');

const RULES = {
  STAGE_INIT_NOT_ONE: {
    description:
      '게임 시작 시 currentStage가 1이 아닌 값으로 초기화됨. 명세 §8: "무조건 1부터 시작".',
    patterns: [
      // currentStage: 5  (또는 다른 정수 2-9)
      { re: /\bcurrentStage\s*[:=]\s*[2-9]\b/, why: 'currentStage 초기값이 2~9. 반드시 1.' },
      { re: /\bstate\.currentStage\s*=\s*[2-9]\b/, why: 'state.currentStage 할당 초기값 2~9.' },
      // stage: 5  (state 객체 안)
      { re: /\bstage\s*:\s*[2-9]\b/, why: 'stage: [2-9] 초기값. 반드시 1.' },
      // STAGES.length 또는 STAGES[STAGES.length-1]로 초기화
      { re: /currentStage[^=\n]*=\s*STAGES\.length\b/, why: 'currentStage = STAGES.length (마지막 stage로 시작).' },
      { re: /STAGES\[\s*STAGES\.length\s*-\s*1\s*\]/, why: 'STAGES 마지막 항목 인덱싱 — 시작 stage 결정에 사용 X.' },
    ],
    hint:
      '게임 상태 초기화에서 currentStage = 1 (또는 stage: 1) 로 hardcode. ' +
      '배열 인덱스는 STAGES[0] 사용. score threshold 도달 시에만 증가.',
  },

  ENEMY_HP_NOT_ONE: {
    description:
      '적 HP가 1로 초기화되지 않음 (한 방 사망 위배). 명세 §9-1 룰.',
    patterns: [
      // enemy 객체 literal 안에 hp: 2~9 또는 두 자리 이상
      { re: /\benemy[^{]*\{[^}]*\bhp\s*:\s*[2-9]\b/, why: 'enemy 객체 literal에 hp: 2~9.' },
      { re: /\benemy[^{]*\{[^}]*\bhp\s*:\s*\d{2,}\b/, why: 'enemy 객체 literal에 hp 두 자리 이상.' },
      // spawnEnemy / createEnemy / makeEnemy 함수 안에 hp: variable (변동 HP)
      // 의도된 spawn 함수의 단순 패턴
      { re: /(spawnEnemy|createEnemy|makeEnemy|spawn|push)\s*[\(\{][^)]*\bhp\s*:\s*(stage|weapon|currentStage|level|difficulty|\d{2,}|[2-9])\b/i, why: 'spawn 시 hp가 1이 아닌 변동값/상수.' },
    ],
    // 자주 false positive 가능 케이스: hero/player의 hp는 OK (대부분 HERO_INITIAL.hp).
    // 따라서 hero/player 컨텍스트는 검사 안 함 — regex가 enemy/spawn/Enemy/createEnemy 키워드 근처만 매칭.
    hint:
      '스폰 시 enemy.hp = 1 (또는 객체 literal `{ ..., hp: 1, ... }`) 로 hardcode. ' +
      '플레이어 탄환과 충돌 시 hp -= 1 후 hp <= 0 검사하여 즉시 제거.',
  },

  HERO_SHAPE_NOT_CIRCLE: {
    description:
      '주인공이 *원*이 아닌 다른 모양으로 그려짐 (세모/다각형/스프라이트 등). 명세 §6 룰.',
    patternsCustom: 'arcAbsent',  // 단순 정규식 대신 커스텀 검사 (전체 코드에 ctx.arc 호출 0개)
    hint:
      '주인공은 흰색 *원*. drawHero 함수에서 `ctx.beginPath()`, `ctx.arc(x, y, r, 0, Math.PI*2)`, ' +
      '`ctx.fill()` 패턴 사용. `moveTo`/`lineTo` 다각형 path 또는 `drawImage` 스프라이트 사용 금지.',
  },
};

/** 주석/문자열 제거 (placeholder_usage_check.js와 동일 stripComments). */
function stripComments(src) {
  let out = '';
  let i = 0;
  let inString = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; out += c; i++; continue; }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * files dict 검사. placeholder game.js 제외.
 * 결과: { ok: true } 또는 { ok: false, violations: [{rule, file, snippet, why}, ...] }
 */
function checkGameInitInFiles(filesObj) {
  const sources = Object.entries(filesObj || {})
    .filter(([p]) => /\.(js|jsx)$/.test(p))
    .filter(([p]) => !p.endsWith('constants/game.js'));

  const violations = [];

  // 1) 파일별 regex 매칭 (STAGE_INIT_NOT_ONE / ENEMY_HP_NOT_ONE)
  for (const [filePath, content] of sources) {
    const clean = stripComments(content || '');
    for (const [ruleId, rule] of Object.entries(RULES)) {
      if (!rule.patterns) continue;
      for (const { re, why } of rule.patterns) {
        const match = clean.match(re);
        if (match) {
          const idx = clean.indexOf(match[0]);
          const start = Math.max(0, idx - 30);
          const end = Math.min(clean.length, idx + match[0].length + 30);
          const snippet = clean.slice(start, end).replace(/\n/g, ' ').trim();
          violations.push({ rule: ruleId, file: filePath, snippet: `…${snippet}…`, why });
        }
      }
    }
  }

  // 2) 커스텀 cross-file 검사 (HERO_SHAPE_NOT_CIRCLE — 전체 코드에 ctx.arc 호출 0개)
  const fullBlob = sources.map(([, c]) => stripComments(c || '')).join('\n');
  if (RULES.HERO_SHAPE_NOT_CIRCLE.patternsCustom === 'arcAbsent') {
    // ctx.arc, this.ctx.arc, contextVar.arc 등 모든 `.arc(` 호출 카운트
    const arcMatches = fullBlob.match(/\.arc\s*\(/g) || [];
    if (arcMatches.length === 0) {
      violations.push({
        rule: 'HERO_SHAPE_NOT_CIRCLE',
        file: '(전체 FE 산출물)',
        snippet: 'ctx.arc(...) 호출 0개 — hero를 다각형/스프라이트로 그렸을 가능성 매우 큼',
        why: 'arc() 호출이 코드 전체에 없음. hero는 반드시 원 (canvas arc).',
      });
    }
  }

  if (violations.length === 0) return { ok: true };
  return { ok: false, violations };
}

/** srcDir 기반 (CLI 디버그용). */
function checkGameInit(feSrcDir) {
  const excludeSuffix = path.join('constants', 'game.js');
  const filesObj = {};
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|jsx)$/.test(entry.name)) continue;
      if (full.endsWith(excludeSuffix)) continue;
      try { filesObj[full] = fs.readFileSync(full, 'utf8'); } catch (_) { /* ignore */ }
    }
  }
  walk(feSrcDir);
  return checkGameInitInFiles(filesObj);
}

/** fix_instructions에 첨부할 메시지. */
function formatViolationsForFix(result) {
  const violations = (result && result.violations) || [];
  if (violations.length === 0) return '';

  const lines = [
    '## ⚠️ 게임 초기 상태 버그 감지 (사용자 직접 플레이 보고)',
    '',
    'FE 산출물을 정적 스캔한 결과, 아래 버그 패턴이 감지됨:',
    '',
  ];

  const byRule = {};
  for (const v of violations) {
    if (!byRule[v.rule]) byRule[v.rule] = [];
    byRule[v.rule].push(v);
  }

  for (const [ruleId, items] of Object.entries(byRule)) {
    const rule = RULES[ruleId];
    lines.push(`### ${ruleId}`);
    lines.push(`**문제**: ${rule.description}`);
    lines.push('');
    for (const v of items) {
      lines.push(`- \`${v.file}\` → \`${v.snippet}\` (${v.why})`);
    }
    lines.push('');
    lines.push(`**수정**: ${rule.hint}`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  RULES,
  checkGameInit,
  checkGameInitInFiles,
  formatViolationsForFix,
};
