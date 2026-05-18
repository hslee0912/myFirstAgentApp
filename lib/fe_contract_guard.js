/**
 * FE Contract Guard — static analysis: FE의 fetch literal URL이 contract에 선언된
 * endpoint와 일치하는지 검증 (D66, 2026-05-18).
 *
 * 동기:
 *   기존 lib/contract_sync.js (D36)는 contract → BE code 한 방향만 검증.
 *   FE가 contract에 *없는* endpoint를 fetch하는 drift는 통과시킴 (예: FE Agent가
 *   "중복확인 API" 같은 UX 도우미를 자체 발명 → BE 코드에 없는 endpoint를 호출
 *   → 런타임 404 → UI 동작 안 함). 이 가드가 그 drift를 정적으로 catch.
 *
 * 검증 범위 (PoC scope):
 *   - fetch('literal') 만. template literal(`/api/${kind}`) / 변수 fetch(url)는 skip.
 *   - Literal 패턴이 압도적으로 흔하므로 false negative는 적음.
 *   - method 추출: 두번째 인자 객체의 `method: 'POST'` 추출. 명시 안 되면 GET.
 *   - query string은 비교 전 strip (path만 비교).
 *
 * 흐름:
 *   FE Agent 응답 → autoFixDependencyAliases → validateAllowedDeps
 *     → validateFEContract (이 모듈) → drift 발견 시 throw with code='FE_CONTRACT_DRIFT'
 *     → agent inline retry (D64 패턴) → 실패 시 round retry로 escalate
 */
'use strict';

// fetch('url') 첫 인자만 매치 — closing paren·options 같은 동적 부분은 skip하고
// 매치 위치 이후 짧은 윈도우에서 method 별도 탐색 (concatenation 케이스 cover).
const FETCH_URL_RE = /fetch\s*\(\s*(['"])([^'"\n]+?)\1/g;
const METHOD_LOOKUP_RE =
  /method\s*:\s*['"](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)['"]/i;

/**
 * FE 산출물 files에서 fetch literal URL 추출.
 * @param {Object<string,string>} files
 * @returns {Array<{method:string, path:string, file:string, url:string}>}
 */
function extractFeFetches(files) {
  const out = [];
  for (const [filePath, content] of Object.entries(files || {})) {
    if (!/\.(js|jsx)$/.test(filePath) || typeof content !== 'string') continue;
    // 주석 strip — 주석 안 fetch는 무시
    const code = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');
    let m;
    FETCH_URL_RE.lastIndex = 0;
    while ((m = FETCH_URL_RE.exec(code)) !== null) {
      const url = m[2];
      // skip external URLs (http://, https://, //cdn) — backend hardcode 등은 별도 rules에서 차단됨
      if (/^(?:https?:)?\/\//.test(url)) continue;
      // method는 매치 끝 위치 이후 200자 윈도우에서 탐색 (fetch options 일반 위치).
      const after = code.slice(FETCH_URL_RE.lastIndex, FETCH_URL_RE.lastIndex + 200);
      const methodMatch = after.match(METHOD_LOOKUP_RE);
      const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';
      const pathOnly = url.split('?')[0];
      out.push({ method, path: pathOnly, file: filePath, url });
    }
  }
  return out;
}

function normalizePath(p) {
  let s = String(p);
  s = s.replace(/\{[^}]+\}/g, ':_p');
  s = s.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':_p');
  s = s.replace(/\/+$/, '');
  if (s === '') s = '/';
  return s;
}

function tupleKey(method, p) {
  return `${String(method).toUpperCase()} ${normalizePath(p)}`;
}

/**
 * FE fetch URL이 contract endpoints에 모두 매핑되는지 diff.
 *
 * @param {Object<string,string>} files - FE 응답의 files
 * @param {Array<{method:string, path:string}>} contractEndpoints
 * @param {string} [baseUrl] - contract의 base_url. fetch URL과 매칭 시 prefix로 합성
 * @returns {{pass:boolean, fetches:Array, extra:Array, fix_instructions:string}}
 */
function validateFEContract(files, contractEndpoints, baseUrl = '') {
  const fetches = extractFeFetches(files);
  if (fetches.length === 0) {
    return { pass: true, fetches: [], extra: [], fix_instructions: '' };
  }

  // contract endpoints의 *가능한 두 path 형태* (base_url 결합 + 원본) 모두 set에 등록
  const contractSet = new Set();
  for (const ep of contractEndpoints || []) {
    if (!ep || !ep.path || !ep.method) continue;
    const full = ((baseUrl || '').replace(/\/+$/, '') + '/' + String(ep.path).replace(/^\/+/, ''))
      .replace(/\/+/g, '/');
    contractSet.add(tupleKey(ep.method, full));
    contractSet.add(tupleKey(ep.method, ep.path));
  }

  const extra = [];
  for (const f of fetches) {
    if (!contractSet.has(tupleKey(f.method, f.path))) {
      extra.push(f);
    }
  }

  if (extra.length === 0) {
    return { pass: true, fetches, extra: [], fix_instructions: '' };
  }

  return {
    pass: false,
    fetches,
    extra,
    fix_instructions: buildFixHint(extra, contractEndpoints, baseUrl),
  };
}

function buildFixHint(extra, contractEndpoints, baseUrl) {
  const lines = [];
  lines.push('FE 코드가 *contract에 없는* endpoint를 fetch — round FAIL 원인. 즉시 fix:');
  lines.push('');
  for (const e of extra) {
    lines.push(`  ❌ ${e.file}: fetch('${e.url}') method=${e.method}`);
  }
  lines.push('');
  lines.push('현재 contract에 선언된 endpoint:');
  for (const ep of contractEndpoints || []) {
    if (!ep || !ep.path || !ep.method) continue;
    const full = ((baseUrl || '').replace(/\/+$/, '') + '/' + String(ep.path).replace(/^\/+/, ''))
      .replace(/\/+/g, '/');
    lines.push(`  ✅ ${ep.method} ${full}`);
  }
  lines.push('');
  lines.push('해결 옵션 (순서대로 검토):');
  lines.push('  1. 해당 fetch 호출 *제거*: contract 외 endpoint는 BE에 없으므로 호출 자체 불가능.');
  lines.push('     예) "중복확인" UX → signup 시도 후 409 응답으로 "이미 사용중" 메시지 표시 (extra fetch 없이 동등 UX).');
  lines.push('  2. contract에 *있는* endpoint로 교체: 위 ✅ list 중 가까운 endpoint로 변경.');
  lines.push('  3. 정말 새 endpoint가 필요하면 notes에만 사유 기록 — Agent가 contract를 임의 확장하지 말 것.');
  return lines.join('\n');
}

/**
 * Throwable variant — agent inline retry 통합용. mismatch 발견 시 throw.
 *
 * @throws {Error} code='FE_CONTRACT_DRIFT', err.extra = mismatch list
 */
function assertFEContract(files, contractEndpoints, baseUrl = '') {
  const r = validateFEContract(files, contractEndpoints, baseUrl);
  if (!r.pass) {
    const err = new Error(
      `[FE Agent] Contract drift detected: ${r.extra.length} fetch URL(s) not in contract.\n${r.fix_instructions}`
    );
    err.code = 'FE_CONTRACT_DRIFT';
    err.extra = r.extra;
    throw err;
  }
  return r;
}

module.exports = { validateFEContract, assertFEContract, extractFeFetches };
