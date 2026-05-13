/**
 * Unit tests for lib/resume_helper.js (D35, 2026-05-14, 옵션 C).
 *
 * db.query를 monkey-patch해서 *DB 환경 없이* eligibility 로직만 검증.
 * 실제 DB 통합 검증은 별도 e2e 스크립트에서.
 *
 * Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { checkResumeEligibility } = require('../lib/resume_helper');

// ─────────── 헬퍼: db.query mock ───────────

const originalQuery = db.query;
let mockResponses = {};   // sql substring → rows
function setMock(responses) {
  mockResponses = responses;
}
function installMock() {
  db.query = async (sql, params) => {
    for (const key of Object.keys(mockResponses)) {
      if (sql.includes(key)) {
        const r = mockResponses[key];
        return typeof r === 'function' ? r(params) : r;
      }
    }
    throw new Error('Unexpected query in test: ' + sql.slice(0, 80));
  };
}
function restoreMock() {
  db.query = originalQuery;
  mockResponses = {};
}

// ─────────── eligibility branches ───────────

test('eligibility — task_id가 비어있으면 false', async () => {
  installMock();
  try {
    const r = await checkResumeEligibility('');
    assert.equal(r.eligible, false);
    assert.match(r.reason, /task_id/);
    const r2 = await checkResumeEligibility(null);
    assert.equal(r2.eligible, false);
  } finally { restoreMock(); }
});

test('eligibility — decision row 없으면 false', async () => {
  setMock({ 'FROM log_agent_decisions WHERE task_id': [] });
  installMock();
  try {
    const r = await checkResumeEligibility('task_xxx');
    assert.equal(r.eligible, false);
    assert.match(r.reason, /decision row 없음/);
  } finally { restoreMock(); }
});

test('eligibility — verdict가 PASS면 false (이미 성공한 task)', async () => {
  setMock({
    'FROM log_agent_decisions WHERE task_id': [{ id: 10, final_verdict: 'PASS' }],
  });
  installMock();
  try {
    const r = await checkResumeEligibility('task_yyy');
    assert.equal(r.eligible, false);
    assert.match(r.reason, /verdict=PASS/);
  } finally { restoreMock(); }
});

test('eligibility — CodeChecker run 없으면 false', async () => {
  setMock({
    'FROM log_agent_decisions WHERE task_id': [{ id: 11, final_verdict: 'ERROR' }],
    "agent_name = 'CodeChecker'": [],
  });
  installMock();
  try {
    const r = await checkResumeEligibility('task_zzz');
    assert.equal(r.eligible, false);
    assert.match(r.reason, /CodeChecker run row 없음/);
  } finally { restoreMock(); }
});

test('eligibility — CodeChecker status가 FAILED면 false', async () => {
  setMock({
    'FROM log_agent_decisions WHERE task_id': [{ id: 12, final_verdict: 'ERROR' }],
    "agent_name = 'CodeChecker'": [{
      input_json: { user_request: 'foo' },
      output_json: { error: 'LLM failed' },
      status: 'FAILED',
    }],
  });
  installMock();
  try {
    const r = await checkResumeEligibility('task_aaa');
    assert.equal(r.eligible, false);
    assert.match(r.reason, /CodeChecker status=FAILED/);
  } finally { restoreMock(); }
});

test('eligibility — be_spec/fe_spec 둘 다 없으면 false', async () => {
  setMock({
    'FROM log_agent_decisions WHERE task_id': [{ id: 13, final_verdict: 'FAIL' }],
    "agent_name = 'CodeChecker'": [{
      input_json: { user_request: 'foo' },
      output_json: { targets: 'BOTH' },   // spec 누락
      status: 'SUCCESS',
    }],
  });
  installMock();
  try {
    const r = await checkResumeEligibility('task_bbb');
    assert.equal(r.eligible, false);
    assert.match(r.reason, /be_spec\/fe_spec 모두 없음/);
  } finally { restoreMock(); }
});

test('eligibility — verdict=ERROR + CodeChecker SUCCESS + spec OK → eligible=true', async () => {
  setMock({
    'FROM log_agent_decisions WHERE task_id': [{ id: 14, final_verdict: 'ERROR' }],
    "agent_name = 'CodeChecker'": [{
      input_json: { user_request: '회원가입 만들어줘' },
      output_json: {
        targets: 'BOTH',
        be_spec: { endpoints: ['POST /signup'] },
        fe_spec: { pages: ['SignupForm'] },
        api_contract: { endpoints: [] },
        decision_id: 14,
      },
      status: 'SUCCESS',
    }],
    'FROM log_task_state WHERE decision_id': [
      { id: 100, target: 'BE', status: 'FAILED', retry_count: 2, failed_stage: 'STAGE3', fix_instructions: 'fix x' },
      { id: 101, target: 'FE', status: 'SUCCESS', retry_count: 0, failed_stage: null, fix_instructions: null },
    ],
  });
  installMock();
  try {
    const r = await checkResumeEligibility('task_ccc');
    assert.equal(r.eligible, true);
    assert.equal(r.decision_id, 14);
    assert.equal(r.user_request, '회원가입 만들어줘');
    assert.equal(r.codechecker_output.targets, 'BOTH');
    assert.ok(r.codechecker_output.be_spec);
    assert.equal(r.task_states.length, 2);
    assert.equal(r.task_states[0].target, 'BE');
  } finally { restoreMock(); }
});

test('eligibility — verdict=FAIL도 eligible (verdict=ERROR/FAIL 둘 다 OK)', async () => {
  setMock({
    'FROM log_agent_decisions WHERE task_id': [{ id: 15, final_verdict: 'FAIL' }],
    "agent_name = 'CodeChecker'": [{
      input_json: { user_request: 'foo' },
      output_json: { be_spec: {}, fe_spec: {}, decision_id: 15 },
      status: 'SUCCESS',
    }],
    'FROM log_task_state WHERE decision_id': [],
  });
  installMock();
  try {
    const r = await checkResumeEligibility('task_ddd');
    assert.equal(r.eligible, true);
  } finally { restoreMock(); }
});

// ─────────── user_request fallback (Orchestrator argv) ───────────

test('user_request fallback — CodeChecker input_json에 없으면 Orchestrator argv에서', async () => {
  setMock({
    'FROM log_agent_decisions WHERE task_id': [{ id: 16, final_verdict: 'ERROR' }],
    "agent_name = 'CodeChecker'": [{
      input_json: null,   // user_request 없음
      output_json: { be_spec: {}, fe_spec: {}, decision_id: 16 },
      status: 'SUCCESS',
    }],
    'FROM log_task_state WHERE decision_id': [],
    "agent_name = 'Orchestrator'": [{
      input_json: { argv: ['프롬프트 텍스트', '--other'] },
    }],
  });
  installMock();
  try {
    const r = await checkResumeEligibility('task_eee');
    assert.equal(r.eligible, true);
    assert.equal(r.user_request, '프롬프트 텍스트');
  } finally { restoreMock(); }
});

test('user_request fallback — argv가 --옵션만 있으면 빈 문자열 (default scenario)', async () => {
  setMock({
    'FROM log_agent_decisions WHERE task_id': [{ id: 17, final_verdict: 'ERROR' }],
    "agent_name = 'CodeChecker'": [{
      input_json: {},
      output_json: { be_spec: {}, fe_spec: {}, decision_id: 17 },
      status: 'SUCCESS',
    }],
    'FROM log_task_state WHERE decision_id': [],
    "agent_name = 'Orchestrator'": [{
      input_json: { argv: ['--resume', 'task_xyz'] },
    }],
  });
  installMock();
  try {
    const r = await checkResumeEligibility('task_fff');
    assert.equal(r.eligible, true);
    assert.equal(r.user_request, '');   // default scenario로 fallback
  } finally { restoreMock(); }
});
