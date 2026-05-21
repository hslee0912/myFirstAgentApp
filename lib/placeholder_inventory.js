'use strict';

/**
 * placeholder_inventory.js — D97 (2026-05-21)
 *
 * FE Agent system prompt 최상단에 inject할 "필드 인벤토리"를 생성.
 *
 * 동기: LLM이 placeholder의 정확한 필드명을 *추측*하다가 환각하는 패턴이 반복됨
 *   (예: SPAWN_CONFIG.intervalMs ← 실제는 intervalByStage[stage],
 *        movDef.type === 'zigzag' ← .type 필드 없음,
 *        ENEMY_POOLS[stage-1] ← 1-indexed 객체임).
 * 자연어 명세·주석 가드는 *catch는 되지만 발생률은 그대로*. 본 모듈은
 * placeholder의 실제 export 객체를 dynamic require → 필드 목록을 시각화 →
 * Agent prompt에 직접 주입해 *환각 발생률 자체를 낮춤*.
 *
 * 출력 포맷 (사람·LLM 가독):
 *   CANVAS: { width, height }
 *   STAGES[*]: { stage, theme, bgColor, scoreThreshold }
 *   WEAPONS[*]: { id, name, color, cost, pattern, fireDelayMs }
 *   PATTERN_DEFINITIONS: { single, fan, pierce, omni }
 *     PATTERN_DEFINITIONS.single: { description, bullets, pierce, speedMul, fixedDirection }
 *     ...
 *
 * 정책:
 *   - 모든 export 객체의 *1-depth 키*는 무조건 표시.
 *   - 값이 객체이면서 *placeholder의 의도된 sub-key 셋이 명확*하면 2-depth까지 (예:
 *     PATTERN_DEFINITIONS의 각 패턴 정의).
 *   - 배열은 첫 element가 객체일 때 `[*]: { keys }` 형식으로 element shape 표시.
 *   - 단순값(number/string/boolean)은 `name: value` 형식 (LLM이 값 환각 안 하게).
 *   - require.cache 매번 무효화 → game.js가 갱신되면 즉시 반영.
 */

const path = require('path');

const MAX_DEPTH = 2;          // 1=top-level only, 2=nested 한 단계
const MAX_INLINE_ARRAY = 8;   // bullets:[0,45,...]처럼 짧은 숫자 배열은 값 그대로 표시

/**
 * placeholder 파일 경로를 받아 인벤토리 텍스트(문자열)를 반환.
 * 호출 시점마다 require.cache를 무효화해 *최신 game.js* 를 읽음.
 */
function buildPlaceholderInventory(placeholderPath) {
  const abs = path.resolve(placeholderPath);
  // node가 ESM이 아니라 CommonJS이므로 require로 로드 가능. placeholder는 ES Modules
  // 문법(`export const ...`)을 쓰지만 .js 확장자 + require로 읽으면 syntax error 위험.
  // → 안전하게 *파일을 raw로 읽어 정규식 파싱*. ESM/CJS 모두 호환 + Node 런타임 의존 X.
  const fs = require('fs');
  const src = fs.readFileSync(abs, 'utf8');

  const lines = [];
  lines.push('# placeholder 필드 인벤토리 (`FE/src/constants/game.js`)');
  lines.push('# 아래 *목록에 명시된 필드/키만* 사용 가능. 다른 이름은 환각으로 빌드/테스트 실패.');
  lines.push('');

  const exports = parseExports(src);
  for (const exp of exports) {
    renderExport(exp, lines, 0);
  }
  return lines.join('\n');
}

/**
 * 매우 단순한 ES Modules `export const NAME = <literal>;` 파서.
 *
 * 지원 패턴:
 *   export const NAME = { key1: val1, key2: { … } };
 *   export const NAME = [ {…}, {…}, … ];
 *   export const NAME = 250;
 *
 * 비지원: 표현식·함수 호출·동적 계산. (placeholder는 순수 데이터 리터럴 가정.)
 *
 * 알고리즘:
 *   1. `export const ([A-Z_][A-Z0-9_]*) = ` 패턴으로 export 시작점 찾기.
 *   2. RHS의 첫 글자(`{` / `[` / digit / quote)로 타입 판단.
 *   3. 객체·배열은 balanced bracket으로 끝점 찾기.
 *   4. JSON5 비슷한 형태이지만 trailing comma / unquoted key 지원해야 함 → 직접 토큰화.
 */
function parseExports(src) {
  const results = [];
  const re = /export\s+const\s+([A-Z_][A-Z0-9_]*)\s*=\s*/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const start = m.index + m[0].length;
    const ch = src[start];
    let endIdx;
    let kind;
    if (ch === '{') {
      endIdx = findMatchingBracket(src, start, '{', '}');
      kind = 'object';
    } else if (ch === '[') {
      endIdx = findMatchingBracket(src, start, '[', ']');
      kind = 'array';
    } else {
      // 단순 리터럴 — 다음 ; 까지
      endIdx = src.indexOf(';', start);
      if (endIdx < 0) endIdx = src.length;
      kind = 'literal';
    }
    const literal = src.slice(start, endIdx + (kind === 'literal' ? 0 : 1)).trim();
    results.push({ name, kind, literal });
  }
  return results;
}

/** balanced bracket 매칭 — 문자열 안의 bracket은 무시. */
function findMatchingBracket(src, startIdx, open, close) {
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (inString) { if (c === '\\') { i++; continue; } if (c === inString) inString = null; continue; }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length - 1;
}

/**
 * export 1개를 lines에 push.
 * - object: `NAME: { key1, key2, ... }` + nested 객체면 한 단계 더 들여쓰기.
 * - array: 첫 element가 객체면 `NAME[*]: { keys of element }`, 단순값이면 inline.
 * - literal: `NAME: value`.
 */
function renderExport(exp, lines, depth) {
  if (exp.kind === 'literal') {
    lines.push(`${exp.name}: ${exp.literal}`);
    return;
  }
  if (exp.kind === 'array') {
    const elementSummary = summarizeArrayLiteral(exp.literal);
    lines.push(`${exp.name}${elementSummary}`);
    return;
  }
  // object
  const topKeys = extractTopLevelKeys(exp.literal);
  lines.push(`${exp.name}: { ${topKeys.map(k => k.name).join(', ')} }`);
  if (depth + 1 < MAX_DEPTH) {
    for (const k of topKeys) {
      if (k.valueKind === 'object') {
        const subKeys = extractTopLevelKeys(k.valueLiteral);
        const subKeyNames = subKeys.map(sk => sk.name).join(', ');
        lines.push(`  ${exp.name}.${k.name}: { ${subKeyNames} }`);
      } else if (k.valueKind === 'array') {
        const elemSummary = summarizeArrayLiteral(k.valueLiteral);
        lines.push(`  ${exp.name}.${k.name}${elemSummary}`);
      } else if (k.valueKind === 'literal' && k.valueLiteral.length <= 60) {
        lines.push(`  ${exp.name}.${k.name}: ${k.valueLiteral}`);
      }
    }
  }
}

/** 배열 리터럴 요약. */
function summarizeArrayLiteral(literal) {
  // 첫 element가 객체이면 키 목록을, 단순값이면 짧으면 그대로.
  const inner = literal.slice(1, -1).trim();  // 양 끝 [ ]
  if (!inner) return ': []';
  // 짧은 숫자/문자열 배열 그대로 표시
  if (!/[{[]/.test(inner) && literal.length <= MAX_INLINE_ARRAY * 8) {
    return `: ${literal}`;
  }
  // 객체 배열인지 확인
  const firstNonSpace = inner.search(/\S/);
  if (inner[firstNonSpace] === '{') {
    const end = findMatchingBracket(inner, firstNonSpace, '{', '}');
    const firstObj = inner.slice(firstNonSpace, end + 1);
    const keys = extractTopLevelKeys(firstObj);
    return `[*]: { ${keys.map(k => k.name).join(', ')} }`;
  }
  return ': array';
}

/**
 * 객체 리터럴 `{ key1: …, key2: { … }, … }` 의 *최상위* 키와 값 종류를 추출.
 * 값은 그 자체로 다른 객체/배열/리터럴 중 어느 것인지 분류.
 */
function extractTopLevelKeys(objLiteral) {
  const inner = objLiteral.slice(1, -1);  // 양 끝 { }
  const results = [];
  let i = 0;
  while (i < inner.length) {
    // skip whitespace/comments
    while (i < inner.length && /\s/.test(inner[i])) i++;
    if (i >= inner.length) break;
    if (inner[i] === '/' && inner[i + 1] === '/') {
      while (i < inner.length && inner[i] !== '\n') i++;
      continue;
    }
    if (inner[i] === '/' && inner[i + 1] === '*') {
      const end = inner.indexOf('*/', i);
      i = end < 0 ? inner.length : end + 2;
      continue;
    }
    // key (unquoted identifier OR quoted string OR number)
    let key;
    if (inner[i] === '"' || inner[i] === "'") {
      const quote = inner[i];
      const end = inner.indexOf(quote, i + 1);
      key = inner.slice(i + 1, end);
      i = end + 1;
    } else {
      const keyMatch = /^[A-Za-z0-9_]+/.exec(inner.slice(i));
      if (!keyMatch) { i++; continue; }
      key = keyMatch[0];
      i += keyMatch[0].length;
    }
    while (i < inner.length && /\s/.test(inner[i])) i++;
    if (inner[i] !== ':') continue;
    i++;
    while (i < inner.length && /\s/.test(inner[i])) i++;
    // value
    let valueKind, valueLiteral;
    if (inner[i] === '{') {
      const end = findMatchingBracket(inner, i, '{', '}');
      valueKind = 'object';
      valueLiteral = inner.slice(i, end + 1);
      i = end + 1;
    } else if (inner[i] === '[') {
      const end = findMatchingBracket(inner, i, '[', ']');
      valueKind = 'array';
      valueLiteral = inner.slice(i, end + 1);
      i = end + 1;
    } else {
      // until comma or end (respecting strings)
      let depth = 0;
      let inStr = null;
      let valStart = i;
      while (i < inner.length) {
        const c = inner[i];
        if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; }
        else if (c === '"' || c === "'" || c === '`') inStr = c;
        else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) break;
        i++;
      }
      valueKind = 'literal';
      valueLiteral = inner.slice(valStart, i).trim();
    }
    while (i < inner.length && /\s/.test(inner[i])) i++;
    if (inner[i] === ',') i++;
    results.push({ name: key, valueKind, valueLiteral });
  }
  return results;
}

module.exports = { buildPlaceholderInventory };
