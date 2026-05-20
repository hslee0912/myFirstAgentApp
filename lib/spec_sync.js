'use strict';

/**
 * SpecSync — 결정론적 정적 검증 (D89, 2026-05-20).
 *
 * rules/domain.md §2 카탈로그(field별 regex + PASS/FAIL 예)와
 * shared/router/<name>.json의 (a) request.schema.properties[].pattern,
 * (b) test_scenarios[].request_body 값을 비교해 drift를 잡는다.
 *
 * 1~3(prompt 강제)은 LLM이 따라야 작동. SpecSync는 LLM 결과를 정적으로 검증
 * → 어긋나면 round loop 안에서 BE/CodeChecker 재진입. PostTest까지 안 가고 잡음.
 *
 * Always ON — VALIDATION_MODE 무관 (D36 ContractSync와 동일 safety guard 등급).
 */

const fs = require('fs');
const path = require('path');

/**
 * rules/domain.md §2 마크다운을 파싱해 field별 카탈로그 추출.
 *
 * 형식 가정 (예: ### username 다음 블록):
 *   - regex: `<regex>`
 *   - PASS 예: `a`, `b`, `c`
 *   - FAIL 예: 다음 라인(들여쓰기 `- <category>: `a`, `b`` 형태 또는 단일 `- FAIL 예: `a`, `b``)
 *
 * 파싱 실패한 field는 검증 대상에서 제외 (false positive 회피).
 *
 * @param {string} md
 * @returns {{fields: Record<string, {regex: string|null, passExamples: string[], failExamples: string[]}>}}
 */
function parseDomainCatalog(md) {
  const fields = {};
  const lines = md.split('\n');

  let inSection2 = false;
  let currentField = null;
  let collectingFail = false;
  for (const line of lines) {
    if (/^##\s+2\./.test(line)) { inSection2 = true; continue; }
    if (/^##\s+3\./.test(line)) { break; }
    if (!inSection2) continue;

    const headerMatch = line.match(/^###\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (headerMatch) {
      currentField = headerMatch[1];
      fields[currentField] = { regex: null, passExamples: [], failExamples: [] };
      collectingFail = false;
      continue;
    }
    if (!currentField) continue;

    const regexLine = line.match(/^-\s+regex:\s*`(.+?)`/);
    if (regexLine) {
      fields[currentField].regex = regexLine[1];
      collectingFail = false;
      continue;
    }

    if (/^-\s+PASS 예:/.test(line)) {
      const examples = extractBackticked(line);
      fields[currentField].passExamples.push(...examples);
      collectingFail = false;
      continue;
    }

    if (/^-\s+FAIL 예:/.test(line)) {
      const sameLine = extractBackticked(line);
      if (sameLine.length > 0) fields[currentField].failExamples.push(...sameLine);
      collectingFail = true;
      continue;
    }

    if (collectingFail && /^\s+-/.test(line)) {
      const examples = extractBackticked(line);
      fields[currentField].failExamples.push(...examples);
      continue;
    }

    if (collectingFail && /^-\s+/.test(line)) {
      collectingFail = false;
    }
  }

  return { fields };
}

function extractBackticked(line) {
  const out = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * 시나리오 이름에서 의도 추출.
 *   valid_*, existing_*, available_*, no_results_* → 'PASS_*'  (모든 카탈로그 field가 PASS 예 사용)
 *   invalid_<field> / weak_password → 'INVALID' (target field 1개만 FAIL 예 사용, 나머지 field는 PASS 예 가능)
 *   missing_*, duplicate_*, nonexistent_*, ghost_* → null (검증 skip — 임의값/시드)
 *
 * INVALID 시나리오는 *특정 field 1개만* FAIL이고 나머지 field는 PASS여야 의도된 검증이 됨
 * (예: weak_password는 username/player_name이 PASS여야 비로소 password 실패를 정확히 검증).
 * 그래서 targetField가 식별 가능한 경우만 INVALID 검증, 그 외엔 skip.
 */
function classifyScenario(name) {
  if (!name || typeof name !== 'string') return null;
  if (/^valid(_|$)/.test(name)) return 'PASS_VALID';
  if (/^existing(_|$)/.test(name)) return 'PASS_EXISTING_SEED';
  if (/^available(_|$)/.test(name)) return 'PASS_AVAILABLE';
  if (/^no_results(_|$)/.test(name)) return 'PASS_NO_RESULTS';
  if (/^invalid/.test(name)) return 'INVALID';
  if (/^weak_password/.test(name)) return 'INVALID_PASSWORD';
  if (/^missing/.test(name)) return null;
  if (/^duplicate/.test(name)) return null;
  if (/^nonexistent/.test(name)) return null;
  if (/^ghost/.test(name)) return null;
  return null;
}

/**
 * INVALID 시나리오의 target field 추출.
 *   weak_password → 'password'
 *   invalid_username_format / invalid_username → 'username'
 *   invalid_weapon → 'weapon_used' (별칭은 카탈로그 fields 안에서 매칭)
 *   non_numeric_player_id → 'player_id'
 * 추출 실패 시 null → 그 시나리오는 검증 skip (false positive 회피).
 *
 * @param {string} name
 * @param {string[]} catalogFields  rules/domain.md §2에 정의된 field 이름 list
 * @returns {string|null}
 */
function inferInvalidTargetField(name, catalogFields) {
  if (!name || typeof name !== 'string') return null;
  if (/^weak_password/.test(name)) return 'password';
  // invalid_<field_or_alias>_*  — 정확 매칭 시도
  const invMatch = name.match(/^invalid_([a-zA-Z0-9_]+?)(?:_format|_credentials)?$/);
  if (invMatch && catalogFields.includes(invMatch[1])) return invMatch[1];
  // 그 외 ad-hoc 패턴 (target 모호 → skip)
  return null;
}

/**
 * 메인 검증.
 *
 * @param {{catalogPath: string, routerDir: string}} params
 * @returns {{
 *   pass: boolean,
 *   skipped?: string,
 *   error?: string,
 *   drifts: Array<{router: string, scenario?: string, field: string, issue: string, expected: any, actual: any}>,
 *   fix_instructions?: string,
 *   field_count?: number,
 *   router_count?: number,
 * }}
 */
function checkSpecSync({ catalogPath, routerDir }) {
  if (!fs.existsSync(catalogPath)) {
    return { pass: true, skipped: 'no-catalog', drifts: [] };
  }
  if (!fs.existsSync(routerDir)) {
    return { pass: true, skipped: 'no-router-dir', drifts: [] };
  }

  let catalog;
  try {
    const md = fs.readFileSync(catalogPath, 'utf8');
    catalog = parseDomainCatalog(md);
  } catch (e) {
    return { pass: true, skipped: 'catalog-parse-error', error: e.message, drifts: [] };
  }

  const drifts = [];
  const routerFiles = fs.readdirSync(routerDir).filter((f) => f.endsWith('.json'));
  if (routerFiles.length === 0) {
    return { pass: true, skipped: 'no-router-files', drifts: [] };
  }

  for (const rf of routerFiles) {
    let detail;
    try {
      detail = JSON.parse(fs.readFileSync(path.join(routerDir, rf), 'utf8'));
    } catch (_) {
      continue;
    }

    const props = (detail.request && detail.request.schema && detail.request.schema.properties) || {};
    for (const [field, def] of Object.entries(props)) {
      const cat = catalog.fields[field];
      if (!cat || !cat.regex) continue;
      if (def.pattern && def.pattern !== cat.regex) {
        drifts.push({
          router: rf,
          field,
          issue: 'pattern_mismatch',
          expected: cat.regex,
          actual: def.pattern,
        });
      }
    }

    const catalogFieldNames = Object.keys(catalog.fields);
    const scenarios = Array.isArray(detail.test_scenarios) ? detail.test_scenarios : [];
    for (const sc of scenarios) {
      const kind = classifyScenario(sc.name);
      if (!kind) continue;

      const body = sc.request_body || sc.request_query || {};

      // PASS 시나리오 — 모든 카탈로그 field의 값이 PASS 예에 있어야 함
      if (kind === 'PASS_VALID' || kind === 'PASS_AVAILABLE') {
        for (const [field, value] of Object.entries(body)) {
          const cat = catalog.fields[field];
          if (!cat) continue;
          if (typeof value !== 'string' && typeof value !== 'number') continue;
          const valueStr = String(value);
          if (cat.passExamples.length > 0 && !cat.passExamples.includes(valueStr)) {
            if (cat.failExamples.includes(valueStr)) {
              drifts.push({
                router: rf,
                scenario: sc.name,
                field,
                issue: 'pass_scenario_uses_fail_example',
                expected: `one of [${cat.passExamples.slice(0, 5).join(', ')}]`,
                actual: valueStr,
              });
            }
          }
        }
        continue;
      }

      // INVALID 시나리오 — target field 1개만 FAIL 예 사용 강제 (나머지 field는 PASS 예 OK)
      if (kind === 'INVALID' || kind === 'INVALID_PASSWORD') {
        const target = inferInvalidTargetField(sc.name, catalogFieldNames);
        if (!target) continue; // target 모호 → 검증 skip (false positive 회피)
        const cat = catalog.fields[target];
        if (!cat) continue;
        const value = body[target];
        if (value == null) continue;
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        const valueStr = String(value);
        if (cat.failExamples.length > 0 && !cat.failExamples.includes(valueStr)) {
          if (cat.passExamples.includes(valueStr)) {
            drifts.push({
              router: rf,
              scenario: sc.name,
              field: target,
              issue: 'invalid_scenario_uses_pass_example',
              expected: `one of [${cat.failExamples.slice(0, 5).join(', ')}]`,
              actual: valueStr,
            });
          }
        }
      }
    }
  }

  // Cross-endpoint 충돌 검사 (D90, 2026-05-20): PostTest는 endpoint × scenarios를
  //   동일 DB에 직렬 실행. signup의 valid_* scenario가 INSERT한 username을 check의
  //   available_* scenario가 다시 쓰면 `exists:false` 기대인데 `exists:true` 받아 FAIL.
  //   카탈로그 PASS 예 5개 풀에서 배분이 어긋난 경우 정적으로 잡음.
  const allDetails = {};
  for (const rf of routerFiles) {
    try {
      allDetails[rf] = JSON.parse(fs.readFileSync(path.join(routerDir, rf), 'utf8'));
    } catch (_) { /* skip */ }
  }
  const signupInsertedUsernames = new Set();
  for (const [, detail] of Object.entries(allDetails)) {
    if ((detail.method || '').toUpperCase() !== 'POST') continue;
    if (!/\b(signup|register)\b/i.test(detail.path || '')) continue;
    const scenarios = Array.isArray(detail.test_scenarios) ? detail.test_scenarios : [];
    for (const sc of scenarios) {
      if (!sc.name || !/^valid(_|$)/.test(sc.name)) continue;
      const u = sc.request_body && sc.request_body.username;
      if (typeof u === 'string' && u.length > 0) signupInsertedUsernames.add(u);
    }
  }
  for (const [rf, detail] of Object.entries(allDetails)) {
    if ((detail.method || '').toUpperCase() !== 'GET') continue;
    if (!/\bcheck\b/i.test(detail.path || '')) continue;
    const scenarios = Array.isArray(detail.test_scenarios) ? detail.test_scenarios : [];
    for (const sc of scenarios) {
      if (!sc.name || !/^available(_|$)/.test(sc.name)) continue;
      const u =
        (sc.request_query && sc.request_query.username) ||
        (sc.request_body && sc.request_body.username);
      if (typeof u === 'string' && signupInsertedUsernames.has(u)) {
        drifts.push({
          router: rf,
          scenario: sc.name,
          field: 'username',
          issue: 'cross_endpoint_username_collision',
          expected: 'signup valid_* 시나리오와 겹치지 않는 username (카탈로그 PASS 예 중 다른 값 선택)',
          actual: u,
        });
      }
    }
  }

  if (drifts.length === 0) {
    return {
      pass: true,
      drifts: [],
      field_count: Object.keys(catalog.fields).length,
      router_count: routerFiles.length,
    };
  }

  const fix_instructions = buildFixInstructions(drifts);
  return {
    pass: false,
    drifts,
    fix_instructions,
    field_count: Object.keys(catalog.fields).length,
    router_count: routerFiles.length,
  };
}

function buildFixInstructions(drifts) {
  const lines = [
    '[SPEC_SYNC] spec과 rules/domain.md §2 카탈로그가 어긋났다. 다음 drift를 모두 수정해야 PostTest까지 도달할 수 있다:',
    '',
  ];
  for (const d of drifts) {
    if (d.issue === 'pattern_mismatch') {
      lines.push(`- ${d.router}: properties.${d.field}.pattern = ${JSON.stringify(d.actual)} → 카탈로그 값 ${JSON.stringify(d.expected)} 로 교체`);
    } else if (d.issue === 'pass_scenario_uses_fail_example') {
      lines.push(`- ${d.router}: test_scenarios[name="${d.scenario}"].${d.field} = ${JSON.stringify(d.actual)} 는 카탈로그 FAIL 예. PASS 의도 시나리오이므로 ${d.expected} 중에서 선택`);
    } else if (d.issue === 'invalid_scenario_uses_pass_example') {
      lines.push(`- ${d.router}: test_scenarios[name="${d.scenario}"].${d.field} = ${JSON.stringify(d.actual)} 는 카탈로그 PASS 예. INVALID 의도 시나리오이므로 ${d.expected} 중에서 선택`);
    } else if (d.issue === 'cross_endpoint_username_collision') {
      lines.push(`- ${d.router}: test_scenarios[name="${d.scenario}"].username = ${JSON.stringify(d.actual)} 는 같은 task의 POST signup valid_* 시나리오가 이미 INSERT한 값. PostTest 직렬 실행 시 exists=true가 돌아와 FAIL. ${d.expected}`);
    }
  }
  lines.push('');
  lines.push('수정 후 router_details 전체를 다시 emit.');
  return lines.join('\n');
}

module.exports = { parseDomainCatalog, classifyScenario, checkSpecSync };
