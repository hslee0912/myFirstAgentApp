'use strict';

/**
 * placeholder_usage_check.js — D97-bis (2026-05-21)
 *
 * FE Agent emit 직전에 호출되는 *정적 검사*. LLM이 placeholder를 import만 하고
 * 실제로는 *사용 안 함* 패턴을 catch.
 *
 * 대표 케이스 (이번 cycle): GamePage.jsx가 PATTERN_DEFINITIONS를 import 자체 안 함
 * → 무기 4종이 모두 단발 직선 동일 동작. 사용자가 "무기 동작 미구현" 보고.
 *
 * 검사 항목 (REQUIRED_TOKENS) — FE 산출물 (FE/src 아래의 .js / .jsx 전체)의
 *   *모든 텍스트*에서 아래 token이 *각각 적어도 1번* 등장해야 함:
 *
 *   - `PATTERN_DEFINITIONS`  → 무기 패턴 lookup
 *   - `bullets`              → bullets 배열 순회
 *   - `speedMul`             → 속도 배수 (pierce 1.6배 등)
 *   - `fixedDirection`       → omni 8방향 절대각도
 *
 * 누락 시 → `MISSING_WEAPON_BEHAVIOR` ERROR + 누락 token 목록 반환.
 * fe_agent.js가 이 결과로 fix_instructions를 만들어 round retry 유발.
 *
 * 정책:
 *   - false positive < false negative — placeholder 일부 export를 *의도적으로*
 *     안 쓰는 케이스가 있을 수 있어 *required token*만 좁게 정의. 점진 확장.
 *   - 검사는 정규식 *whole-word* 매치. 문자열 안 token도 카운트 (`"speedMul"`로 쓰는
 *     케이스도 의도된 사용).
 *   - 주석에 등장하는 token도 일단 카운트 (LLM이 "TODO: speedMul" 식으로 적어두고
 *     실제 안 쓰는 경우는 드물고, 그건 다음 단계 lint·test에서 잡힘).
 */

const fs = require('fs');
const path = require('path');

/**
 * placeholder의 어떤 *식별자/필드*가 FE 산출물에 반드시 등장해야 하는지.
 * 키는 token 문자열, 값은 "왜 필요한가" 설명 (fix_instructions에 노출).
 */
const REQUIRED_TOKENS = {
  PATTERN_DEFINITIONS:
    '무기 패턴(single/fan/pierce/omni) lookup의 단일 진실 출처. 누락 시 모든 무기 동일 동작.',
  bullets:
    'PATTERN_DEFINITIONS의 각 패턴이 가진 각도 offset 배열. 순회해서 탄환 생성.',
  speedMul:
    'BULLET_SPEED에 곱할 속도 배수 (pierce는 1.6배). 무시 시 pierce가 일반 탄환 속도.',
  fixedDirection:
    'omni 8방향 절대각도 처리 flag. 무시 시 omni 패턴이 적/주인공 위치 따라 움직임.',
};

/**
 * srcDir 아래의 `.js`/`.jsx` 파일을 *재귀적으로* 읽어 모든 텍스트를 합침.
 * placeholder 파일(`constants/game.js`)은 *자기 자신을 정의*하므로 제외해야
 * "import해 놓고 안 씀" 케이스를 정확히 catch.
 */
function collectFeSource(srcDir, excludePathSuffix) {
  const acc = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.(js|jsx)$/.test(entry.name)) {
        if (excludePathSuffix && full.endsWith(excludePathSuffix)) continue;
        try {
          acc.push(fs.readFileSync(full, 'utf8'));
        } catch (_) { /* ignore */ }
      }
    }
  }
  walk(srcDir);
  return acc.join('\n\n');
}

/**
 * 체크 실행. 결과 객체:
 *   { ok: true } | { ok: false, missing: [{token, reason}, ...], scannedFiles: N }
 */
function checkPlaceholderUsage(feSrcDir) {
  const excludeSuffix = path.join('constants', 'game.js');
  const blob = collectFeSource(feSrcDir, excludeSuffix);
  return checkBlob(blob);
}

/**
 * fe_agent.js가 emit 직전에 호출. files dict는 `{ "FE/src/foo.jsx": "<source>", ... }`.
 * placeholder 본인(`FE/src/constants/game.js`) 은 자동 제외.
 */
function checkPlaceholderUsageInFiles(filesObj) {
  const blob = Object.entries(filesObj || {})
    .filter(([p]) => /\.(js|jsx)$/.test(p))
    .filter(([p]) => !p.endsWith('constants/game.js'))
    .map(([, content]) => content || '')
    .join('\n\n');
  return checkBlob(blob);
}

function checkBlob(blob) {
  const missing = [];
  for (const [token, reason] of Object.entries(REQUIRED_TOKENS)) {
    // whole-word 매치: 식별자 token이 *식별자 경계* 안에 있어야 함
    const re = new RegExp(`\\b${token}\\b`);
    if (!re.test(blob)) {
      missing.push({ token, reason });
    }
  }
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing, scannedBytes: blob.length };
}

/**
 * fe_agent.js의 fix_instructions에 첨부할 사람·LLM 가독 문자열로 포맷.
 */
function formatMissingForFix(missing) {
  if (!missing || missing.length === 0) return '';
  const lines = [
    '## ⚠️ 무기 동작 누락 — placeholder 필수 식별자 미참조',
    '',
    'FE 산출물 (FE/src 아래 모든 .js/.jsx) 을 정적으로 스캔한 결과, 아래 식별자가',
    '*전혀 사용되지 않음*. 무기 4종의 발사 동작이 placeholder 정의대로 구현되지',
    '않은 것으로 추정됨. 다시 emit하기 전 *모두 사용*해야 함:',
    '',
  ];
  for (const { token, reason } of missing) {
    lines.push(`- \`${token}\` — ${reason}`);
  }
  lines.push('');
  lines.push('힌트: `constants/game.js`의 `PATTERN_DEFINITIONS`을 import해서 무기의');
  lines.push('`pattern` 키로 lookup, 반환된 객체의 `bullets`/`speedMul`/`pierce`/');
  lines.push('`fixedDirection` 4 필드를 모두 발사 로직에 사용. (D97 가이드)');
  return lines.join('\n');
}

module.exports = {
  REQUIRED_TOKENS,
  checkPlaceholderUsage,
  checkPlaceholderUsageInFiles,
  formatMissingForFix,
};
