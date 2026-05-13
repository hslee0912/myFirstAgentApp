/**
 * Static checks for ui/public/index.html — D37 (2026-05-14).
 *
 * 두 가지 보장:
 *   (1) ⚙ Advanced env modal이 HTML에 존재 + open 버튼 존재 (토글 외 키 분리).
 *   (2) toolbar 9개 버튼이 *모두* click handler 안에서 UI refresh를 트리거함
 *       (refreshAll / location.reload / selectTask 중 하나).
 *
 * 정적 정규식 grep — DOM 동작 검증이 아닌 *소스 명세 검증*. 진짜 DOM 동작은 e2e에서.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML_PATH = path.resolve(__dirname, '..', 'ui', 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// ─────────── helpers ───────────

/**
 * 특정 버튼의 `addEventListener('click', ...)` 핸들러 segment를 추출.
 * 정확한 brace counting 대신 *다음 click handler*까지의 영역을 잡아 거기서
 * refresh 키워드 grep — 충분히 robust.
 */
function clickHandlerSegment(htmlText, btnId) {
  // 두 가지 selector 스타일 지원 — $('#id') 또는 document.getElementById('id')
  const heads = [
    `$('#${btnId}').addEventListener('click'`,
    `document.getElementById('${btnId}').addEventListener('click'`,
  ];
  let startIdx = -1;
  let headLen = 0;
  for (const head of heads) {
    const idx = htmlText.indexOf(head);
    if (idx >= 0) {
      startIdx = idx;
      headLen = head.length;
      break;
    }
  }
  if (startIdx < 0) return null;
  const after = startIdx + headLen;
  // 다음 click handler 또는 5000자 한도
  const nextIdx = htmlText.indexOf(`addEventListener('click'`, after);
  const endIdx = nextIdx >= 0 ? nextIdx : Math.min(after + 5000, htmlText.length);
  return htmlText.slice(startIdx, endIdx);
}

/**
 * Segment 안에 UI refresh를 일으키는 호출이 하나라도 있는가?
 *   - refreshAll(            — D37 통합 헬퍼
 *   - location.reload(       — 강제 페이지 새로고침
 *   - selectTask(            — detail panel re-render
 *   - Promise.all([loadEnv() — rollback 등 부분 갱신
 */
function hasRefreshCall(segment) {
  if (!segment) return false;
  return /\brefreshAll\s*\(|\blocation\.reload\s*\(|\bselectTask\s*\(|loadEnv\s*\(\s*\)\s*,\s*loadTasks\s*\(\s*\)/.test(segment);
}

// ─────────── (1) Advanced env modal 존재 ───────────

test('UI: ⚙ Advanced env 버튼 + modal dialog가 HTML에 존재', () => {
  // open 버튼
  assert.match(html, /id=["']envAdvancedOpenBtn["']/);
  // <dialog>
  assert.match(html, /<dialog\s+id=["']envAdvancedDialog["']/);
  // body / close / done 핸들러 대상
  assert.match(html, /id=["']envAdvancedBody["']/);
  assert.match(html, /id=["']envAdvancedCloseBtn["']/);
  assert.match(html, /id=["']envAdvancedDoneBtn["']/);
});

test('UI: <dialog>가 <script>보다 먼저 등장 (parse 순서 — 사후 회귀 방지)', () => {
  // script 안의 document.getElementById('envAdvancedOpenBtn') 등이
  // parse 순서상 먼저 실행되는데, dialog가 그 뒤에 있으면 null 반환 →
  // 핸들러 등록 throw → main() 중단 → loadEnv 호출 실패 → 토글 빈 상태
  // (실제 발생한 회귀의 정확한 재현).
  //
  // 주의: 주석 안에 '<script>' 같은 글자가 있으면 그게 먼저 잡혀 false-positive.
  //       주석을 *제거*하고 비교 — 실제 parser가 보는 것과 동일.
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  const dialogIdx = stripped.indexOf('<dialog id="envAdvancedDialog"');
  const scriptIdx = stripped.indexOf('<script>');
  assert.ok(dialogIdx >= 0, '<dialog> 누락');
  assert.ok(scriptIdx >= 0, '<script> 누락');
  assert.ok(
    dialogIdx < scriptIdx,
    `<dialog>(${dialogIdx})는 <script>(${scriptIdx})보다 *앞*에 와야 함 — ` +
    'getElementById null 회피'
  );
});

test('UI: loadEnvAdvanced 함수가 정의되어 있음 (modal 채우기)', () => {
  // 함수 정의는 async function loadEnvAdvanced() 또는 function loadEnvAdvanced
  assert.match(html, /(?:async\s+)?function\s+loadEnvAdvanced\s*\(/);
});

test('UI: envAdvancedOpenBtn 클릭 시 dialog.showModal + loadEnvAdvanced 호출', () => {
  const seg = clickHandlerSegment(html, 'envAdvancedOpenBtn');
  assert.ok(seg, 'envAdvancedOpenBtn click handler 누락');
  assert.match(seg, /showModal\s*\(/);
  assert.match(seg, /loadEnvAdvanced\s*\(/);
});

// ─────────── (2) toolbar 버튼이 모두 UI refresh를 트리거 ───────────

// D38 (2026-05-14): resetDbBtn(Init project로 통합) + cleanupMergedBtn(test/main만
// 쓰는 워크플로우라 죽은 기능)을 제거. 9 → 7 버튼.
const TOOLBAR_BUTTONS = [
  'runBtn',
  'redeployBtn',
  'initBtn',
  'restartUiBtn',
  'resumeLastBtn',
  'rollbackBtn',
  'mergeBtn',
];

for (const btn of TOOLBAR_BUTTONS) {
  test(`UI: ${btn} click handler가 UI refresh를 트리거 (refreshAll / location.reload / selectTask 중 하나)`, () => {
    const seg = clickHandlerSegment(html, btn);
    assert.ok(seg, `${btn} click handler를 HTML에서 찾을 수 없음`);
    assert.ok(
      hasRefreshCall(seg),
      `${btn} click handler 안에 refreshAll() / location.reload() / selectTask() / Promise.all([loadEnv(), loadTasks()]) 중 하나도 없음`
    );
  });
}

// ─────────── refreshAll 헬퍼 정의 자체 ───────────

test('UI: refreshAll 헬퍼 함수가 정의되어 있음', () => {
  assert.match(html, /(?:async\s+)?function\s+refreshAll\s*\(/);
});

test('UI: refreshAll가 loadEnv + loadTasks + loadDetail을 모두 호출', () => {
  // 헬퍼 본문에 세 호출이 모두 등장하는지 — 본문 segment 추출 후 grep
  const m = html.match(/(?:async\s+)?function\s+refreshAll\s*\([\s\S]*?\n\}/);
  assert.ok(m, 'refreshAll 본문 매칭 실패');
  const body = m[0];
  assert.match(body, /loadEnv\s*\(/);
  assert.match(body, /loadTasks\s*\(/);
  assert.match(body, /loadDetail\s*\(/);
});

// ─────────── 4개 토글 키는 inline UI에 그대로 노출 ───────────

test('UI: 4개 토글 키가 TOGGLE_KEYS 객체에 정의됨 (COMMIT_MODE 등)', () => {
  // TOGGLE_KEYS = { COMMIT_MODE: ..., ... } 형태로 4개 모두 등장해야 함
  assert.match(html, /COMMIT_MODE:\s*\{\s*on:\s*['"]auto['"]/);
  assert.match(html, /VALIDATION_MODE:\s*\{\s*on:\s*['"]on['"]/);
  assert.match(html, /DEPLOY_MODE:\s*\{\s*on:\s*['"]on['"]/);
  assert.match(html, /DEPLOY_TEARDOWN_ON_PASS:\s*\{\s*on:\s*['"]on['"]/);
});

// D38 (2026-05-14): 제거된 버튼이 *정말로* 없는지 회귀 방지.
test('UI: resetDbBtn 제거됨 (Init project로 통합) — HTML / JS 모두 없음', () => {
  assert.doesNotMatch(html, /id=["']resetDbBtn["']/);
  assert.doesNotMatch(html, /\$\(['"]#resetDbBtn['"]\)/);
});

test('UI: cleanupMergedBtn 제거됨 (test/main만 사용하는 워크플로우) — HTML / JS 모두 없음', () => {
  assert.doesNotMatch(html, /id=["']cleanupMergedBtn["']/);
  assert.doesNotMatch(html, /\$\(['"]#cleanupMergedBtn['"]\)/);
});

test('UI: Restart 버튼 텍스트가 "Restart Server"로 변경됨', () => {
  assert.match(html, />🔄 Restart Server</);
  // 옛 "Restart UI" 텍스트는 표시 영역에 남아있으면 안 됨
  assert.doesNotMatch(html, />🔄 Restart UI</);
});

// D40 (2026-05-14): detail-panel Resume/Prompt 카드 제거 + textarea height 확대

test('UI: renderResumeCard 함수 제거됨 (상단 🔁 Resume last failed 버튼으로 대체)', () => {
  assert.doesNotMatch(html, /function\s+renderResumeCard\s*\(/);
  // 호출도 남아있으면 ReferenceError → 호출 라인도 없어야 함
  assert.doesNotMatch(html, /renderResumeCard\s*\(/);
});

test('UI: detail-panel용 resumeBtn / fillPromptBtn DOM id 제거됨 (상단 resumeLastBtn은 유지)', () => {
  // 카드가 동적으로 생성하던 두 ID는 정적 HTML에도 없어야 함
  assert.doesNotMatch(html, /id=["']resumeBtn["']/);
  assert.doesNotMatch(html, /id=["']fillPromptBtn["']/);
  // 상단 단축 버튼 resumeLastBtn은 그대로 존재해야 함
  assert.match(html, /id=["']resumeLastBtn["']/);
});

test('UI: textarea min-height 확대 (작업 prompt 입력창 더 넓게)', () => {
  // 80px → 280px (사용자 요청 +200px). 정확한 값을 확인 — 회귀 시 잡힘.
  assert.match(html, /textarea\s*\{\s*resize:\s*vertical;\s*min-height:\s*280px;\s*\}/);
  // 옛 80px 값은 남아있으면 안 됨 (회귀 방지)
  assert.doesNotMatch(html, /textarea\s*\{\s*resize:\s*vertical;\s*min-height:\s*80px;\s*\}/);
});
