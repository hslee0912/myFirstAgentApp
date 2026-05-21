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
 *
 * D97-bis-2 (2026-05-21) 강화: 주석 제거 후 검사 + 다음 REQUIRED_IMPORTS도 함께
 *   적용. 이전엔 LLM이 `// mirrors PATTERN_DEFINITIONS` 주석으로 token 검사 통과
 *   후 inline 복제 (`{ single: {bullets, speedMul, fixedDirection}, ... }`)로
 *   우회. 이제 *주석은 제거*하고 *PATTERN_DEFINITIONS는 import에 명시 필수*.
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
 * placeholder에서 *반드시 import*돼야 하는 export (inline 복제 차단).
 * 값은 fix 안내 메시지.
 */
const REQUIRED_IMPORTS = {
  PATTERN_DEFINITIONS:
    'placeholder `constants/game.js` 에서 *import*해야 함. inline 객체 복제 금지 — ' +
    'placeholder 변경 시 stale data가 됨.',
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
 *
 * 검사 단계:
 *   1) 주석을 *제거한* 코드 blob에서 REQUIRED_TOKENS 식별자 reference 확인.
 *      (주석에 token만 박아 우회하는 패턴 차단.)
 *   2) REQUIRED_IMPORTS 가 *실제 import*에 명시되었는지 검사.
 *      (inline 객체 복제로 placeholder 우회 차단.)
 */
function checkPlaceholderUsageInFiles(filesObj) {
  const sources = Object.entries(filesObj || {})
    .filter(([p]) => /\.(js|jsx)$/.test(p))
    .filter(([p]) => !p.endsWith('constants/game.js'));

  const blobRaw = sources.map(([, content]) => content || '').join('\n\n');
  const blob = stripComments(blobRaw);

  const missingTokens = [];
  for (const [token, reason] of Object.entries(REQUIRED_TOKENS)) {
    const re = new RegExp(`\\b${token}\\b`);
    if (!re.test(blob)) {
      missingTokens.push({ token, reason });
    }
  }

  const importedFromGame = extractGameImports(sources);
  const missingImports = [];
  for (const [name, reason] of Object.entries(REQUIRED_IMPORTS)) {
    if (!importedFromGame.has(name)) {
      missingImports.push({ token: name, reason });
    }
  }

  if (missingTokens.length === 0 && missingImports.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    missing: missingTokens,
    missingImports,
    scannedBytes: blob.length,
  };
}

/** 동일하지만 srcDir 기반 (CLI 디버그용). */
function checkPlaceholderUsage(feSrcDir) {
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
  return checkPlaceholderUsageInFiles(filesObj);
}

/**
 * `// line` 및 `/* block *\/` 주석을 모두 제거. 문자열 안 `//` 같은 false-positive를
 * 피하기 위해 문자열 상태도 추적.
 */
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
      // line comment — skip to newline (preserve the newline itself)
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      // block comment — skip to closing */
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
 * 모든 소스에서 `import { a, b, c } from '...constants/game...'` 형태의 named
 * import를 파싱해 import 이름 set 반환.
 */
function extractGameImports(sources) {
  const importedSet = new Set();
  const re = /import\s*\{([^}]+)\}\s*from\s*['"`][^'"`]*constants\/game(?:\.js)?['"`]/g;
  for (const [, content] of sources) {
    if (!content) continue;
    // strip comments first to avoid catching `// import { X } from ...`
    const clean = stripComments(content);
    let m;
    while ((m = re.exec(clean)) !== null) {
      m[1].split(',').forEach((s) => {
        const name = s.trim().split(/\s+as\s+/)[0].trim();
        if (name) importedSet.add(name);
      });
    }
  }
  return importedSet;
}

/**
 * fe_agent.js의 fix_instructions에 첨부할 사람·LLM 가독 문자열로 포맷.
 * checkPlaceholderUsageInFiles 결과 객체(`{missing, missingImports}`)를 받음.
 */
function formatMissingForFix(result) {
  // 하위호환: 배열만 받았던 옛 시그니처 지원
  const missing = Array.isArray(result) ? result : (result && result.missing) || [];
  const missingImports = (result && result.missingImports) || [];

  if (missing.length === 0 && missingImports.length === 0) return '';

  const lines = [
    '## ⚠️ 무기 동작 누락 — placeholder 필수 식별자 미참조 / inline 복제',
    '',
    'FE 산출물 (FE/src 아래 모든 .js/.jsx) 을 정적으로 스캔한 결과:',
    '',
  ];

  if (missing.length > 0) {
    lines.push('### 식별자 reference 누락 (주석 제거 후 코드에 등장 X)');
    for (const { token, reason } of missing) {
      lines.push(`- \`${token}\` — ${reason}`);
    }
    lines.push('');
  }

  if (missingImports.length > 0) {
    lines.push('### import 누락 (inline 객체로 복제하지 말고 placeholder를 import할 것)');
    for (const { token, reason } of missingImports) {
      lines.push(`- \`${token}\` — ${reason}`);
    }
    lines.push('');
  }

  lines.push('힌트: `import { PATTERN_DEFINITIONS, ... } from \'../constants/game\';` 으로');
  lines.push('명시 import 후 무기의 `pattern` 키로 lookup. inline 객체 복제(주석에');
  lines.push('"mirrors PATTERN_DEFINITIONS" 같은 표기 포함) 절대 금지 — placeholder가');
  lines.push('단일 진실 출처. (D97-bis 가이드)');
  return lines.join('\n');
}

module.exports = {
  REQUIRED_TOKENS,
  checkPlaceholderUsage,
  checkPlaceholderUsageInFiles,
  formatMissingForFix,
};
