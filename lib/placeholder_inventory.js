'use strict';

/**
 * placeholder_inventory.js — D97 (2026-05-21)
 *
 * FE Agent system prompt 최상단에 inject할 "placeholder 인벤토리"를 생성.
 * placeholder의 *키*뿐 아니라 *값*까지 전부 LLM에 노출 — 무기 동작(bullets·
 * speedMul·pierce·fixedDirection 등)을 LLM이 보기 전부터 정확히 알도록.
 *
 * 동기:
 *   D97 1차 (키만 노출) — 환각 필드명은 차단됐지만 *값을 모르는* LLM이 무기
 *   패턴별 동작(부채꼴 ±20°, 관통 1.6배, omni 8방향 등)을 임의 구현 또는
 *   완전 누락. 본 모듈을 *값까지* 노출하도록 강화.
 *
 * 구현 방식:
 *   game.js source를 ES Modules → CommonJS로 변환 (`export const` → `module.exports.`)
 *   후 `new Function` 평가. 모든 export 객체를 메모리에 받아 JSON 형식으로 dump.
 *   - 단순 객체/배열: 한 줄 JSON
 *   - 객체 배열 (예: WEAPONS): element별로 줄 분리
 *   - 객체 안에 객체 (예: PATTERN_DEFINITIONS): sub-key별로 줄 분리
 *
 * 가정:
 *   placeholder는 *순수 데이터 리터럴*만 포함 (함수·계산식·외부 import 금지).
 *   Function 평가가 안전한 이유 — placeholder는 protected file이라 LLM이 손댈 수 없음.
 */

const fs = require('fs');
const path = require('path');

/** placeholder 파일 경로 → 인벤토리 텍스트. require.cache 무관 (매번 fresh read). */
function buildPlaceholderInventory(placeholderPath) {
  const src = fs.readFileSync(path.resolve(placeholderPath), 'utf8');

  // ES Modules → CommonJS 변환
  //   `export const NAME = X;` → `module.exports.NAME = X;`
  //   주석은 그대로 보존 (Function 평가에 무해).
  const transformed = src.replace(/export\s+const\s+/g, 'module.exports.');

  // 격리된 scope에서 평가. placeholder는 순수 데이터라 외부 의존성 없음.
  const moduleObj = { exports: {} };
  const evaluator = new Function('module', transformed + '\nreturn module.exports;');
  const exports = evaluator(moduleObj);

  const lines = [];
  lines.push('# placeholder 인벤토리 (`FE/src/constants/game.js`) — 이름·값 정확히');
  lines.push('# 다른 이름 발명 또는 값 변경 금지. 모든 무기 동작(bullets·speedMul·');
  lines.push('# pierce·fixedDirection)·이동 패턴·스폰 룰은 *아래 값 그대로* 사용.');
  lines.push('');

  for (const [name, value] of Object.entries(exports)) {
    formatExport(name, value, lines);
  }
  return lines.join('\n');
}

/** 한 export를 lines에 push (값 종류에 따라 다른 포맷). */
function formatExport(name, value, lines) {
  if (value === null || typeof value !== 'object') {
    // 단순값
    lines.push(`${name}: ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    formatArrayExport(name, value, lines);
    return;
  }
  formatObjectExport(name, value, lines);
}

function formatArrayExport(name, arr, lines) {
  if (arr.length === 0) {
    lines.push(`${name}: []`);
    return;
  }
  // 객체 배열이면 element별 줄 (LLM이 각 무기·스테이지 spec 한눈에)
  if (typeof arr[0] === 'object' && arr[0] !== null) {
    lines.push(`${name}: [`);
    arr.forEach((item, idx) => {
      lines.push(`  [${idx}]: ${JSON.stringify(item)}`);
    });
    lines.push(`]`);
    return;
  }
  // 단순 배열은 한 줄
  lines.push(`${name}: ${JSON.stringify(arr)}`);
}

function formatObjectExport(name, obj, lines) {
  const entries = Object.entries(obj);
  // sub-value가 모두 primitive면 한 줄 (compact)
  const allPrimitive = entries.every(([, v]) => v === null || typeof v !== 'object');
  if (allPrimitive) {
    lines.push(`${name}: ${JSON.stringify(obj)}`);
    return;
  }
  // sub-value에 객체/배열 있으면 sub-key별 줄
  lines.push(`${name}: {`);
  for (const [k, v] of entries) {
    lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  }
  lines.push(`}`);
}

module.exports = { buildPlaceholderInventory };
