/**
 * D64 (2026-05-15) — LLM 산출물의 *흔한 함정 의존성*을 deterministic auto-fix.
 *
 * rules/*.md에 아무리 명시해도 LLM이 자주 어기는 패턴이 있다. 가장 흔한 사례는
 * `require('bcryptjs')` — `bcrypt`와 이름이 비슷하고 IDE 자동완성에 자주 잡힘.
 * 두 패키지는 *API signature가 동일*하므로 require 한 줄만 치환하면 코드 무수정.
 *
 * 이 모듈은 *안전하게 자동 치환 가능한 alias*만 다룬다 (API 호환 보장 케이스만).
 * 의미가 다른 패키지(joi, axios 등)는 *치환하지 않고* validateAllowedDeps가 throw
 * 하도록 둔다 — LLM이 다음 retry에서 hint 받아 직접 fix.
 *
 * 흐름:
 *   LLM 응답 → autoFixDependencyAliases() → validateAllowedDeps() → 디스크 write
 *
 * Mapping table 추가 기준:
 *   - 두 패키지의 export·API signature가 *완전히* 호환
 *   - require 한 줄만 바꿔도 다른 코드 무수정으로 동작 보장
 *   - 추가 시 본 파일 주석에 호환성 근거 명시
 */
'use strict';

/**
 * key = 금지 패키지명, value = 호환 대체 패키지명
 *
 * 호환성 근거:
 *   - bcryptjs vs bcrypt: 둘 다 `bcrypt.hash(plain, rounds)`, `bcrypt.compare(plain, hashed)`
 *     같은 signature. bcryptjs는 pure JS, bcrypt는 native. 본 PoC는 native bcrypt만
 *     allowedDeps. 호출 코드는 동일.
 */
const ALIAS_REPLACEMENTS = {
  bcryptjs: 'bcrypt',
};

/**
 * 응답 files에서 ALIAS_REPLACEMENTS 매치되는 require/import 라인을 자동 치환.
 *
 * @param {Object<string,string>} files - {filePath: content}
 * @returns {{files: Object, replacements: Array<{path, from, to, lineSnippet}>}}
 */
function autoFixDependencyAliases(files) {
  const out = {};
  const replacements = [];

  for (const [filePath, content] of Object.entries(files || {})) {
    if (!/\.(js|jsx)$/.test(filePath) || typeof content !== 'string') {
      out[filePath] = content;
      continue;
    }

    let fixed = content;
    for (const [from, to] of Object.entries(ALIAS_REPLACEMENTS)) {
      // require('bcryptjs') / require("bcryptjs") — 단순 따옴표 모두
      const reqRe = new RegExp(`require\\(\\s*(['"])${escapeReg(from)}\\1\\s*\\)`, 'g');
      // import ... from 'bcryptjs' (default/named import 모두 cover)
      const impRe = new RegExp(`(from\\s+)(['"])${escapeReg(from)}\\2`, 'g');

      let changed = false;
      const newFixed = fixed
        .replace(reqRe, (match, q) => {
          changed = true;
          return `require(${q}${to}${q})`;
        })
        .replace(impRe, (match, prefix, q) => {
          changed = true;
          return `${prefix}${q}${to}${q}`;
        });
      if (changed) {
        replacements.push({ path: filePath, from, to });
        fixed = newFixed;
      }
    }
    out[filePath] = fixed;
  }

  return { files: out, replacements };
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { autoFixDependencyAliases, ALIAS_REPLACEMENTS };
