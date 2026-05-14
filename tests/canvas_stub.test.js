/**
 * Unit tests for D50 — jsdom canvas stub + rules/fe.md §4-quinque + protected
 * file 등록.
 *
 * 핵심: setup file이 *실제로* HTMLCanvasElement.prototype.getContext를 stub하는지
 * + rules가 가드 패턴을 안내하는지 + stack.config.json이 protected 등록했는지.
 *
 * Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ─────────── setupTests.js 본문 검증 ───────────

test('D50: setupTests.js에 canvas getContext stub + requestAnimationFrame mock 포함', () => {
  const p = path.resolve(__dirname, '..', 'lib', 'stack_templates', 'FE', 'src', 'setupTests.js');
  const src = fs.readFileSync(p, 'utf8');
  // canvas stub
  assert.match(src, /HTMLCanvasElement\.prototype\.getContext/);
  assert.match(src, /HTMLCanvasElement\.prototype\.toDataURL/);
  // 주요 2D context method들이 mock에 있는지 (game 코드가 자주 쓰는 것들)
  assert.match(src, /fillRect/);
  assert.match(src, /clearRect/);
  assert.match(src, /drawImage/);
  assert.match(src, /beginPath/);
  // requestAnimationFrame mock
  assert.match(src, /requestAnimationFrame/);
  assert.match(src, /cancelAnimationFrame/);
  // @testing-library/jest-dom 보존 (기존 placeholder 내용)
  assert.match(src, /@testing-library\/jest-dom/);
});

test('★ D50-fix: requestAnimationFrame mock이 *no-op* (콜백 호출 안 함, 무한 재귀 방지)', () => {
  // 사용자 보고 사고 (cycle 1 hang 2026-05-15): rAF가 setTimeout(cb, 16)로
  // 콜백 *실제 호출*하면 게임 루프 (gameLoop → rAF(gameLoop) → ...) 무한 재귀.
  // 정답: rAF mock이 콜백 호출 안 함 (no-op).
  const p = path.resolve(__dirname, '..', 'lib', 'stack_templates', 'FE', 'src', 'setupTests.js');
  const src = fs.readFileSync(p, 'utf8');
  // setTimeout으로 콜백 호출하는 *옛 흐름* 부재 확인
  assert.doesNotMatch(src, /requestAnimationFrame\s*=\s*\(cb\)\s*=>\s*setTimeout/);
  // no-op 형태 (콜백 인자 무시 또는 안 호출)
  assert.match(src, /requestAnimationFrame\s*=\s*\(\s*\)\s*=>/);
});

test('D50: stub의 getContext가 *함수 반환*이어야 (LLM 코드가 if typeof getContext check 통과)', () => {
  // 실제 setup file을 import해서 동작 검증은 jsdom 환경에서만 가능하지만,
  // 본 테스트는 *소스 내용*만 검증. getContext가 noopCtx 반환 코드 확인.
  const p = path.resolve(__dirname, '..', 'lib', 'stack_templates', 'FE', 'src', 'setupTests.js');
  const src = fs.readFileSync(p, 'utf8');
  // function () { return noopCtx; } 패턴 검증
  assert.match(src, /HTMLCanvasElement\.prototype\.getContext\s*=\s*function/);
  assert.match(src, /return noopCtx/);
});

// ─────────── stack.config.json 등록 검증 ───────────

test('D50: setupTests.js가 FE.protectedConfigFiles에 등록됨 (LLM 수정 차단)', () => {
  const p = path.resolve(__dirname, '..', 'lib', 'stack.config.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(Array.isArray(cfg.FE.protectedConfigFiles));
  assert.ok(
    cfg.FE.protectedConfigFiles.includes('FE/src/setupTests.js'),
    'FE/src/setupTests.js가 protectedConfigFiles에 없음'
  );
});

// ─────────── rules/fe.md §4-quinque 검증 ───────────

test('D50: rules/fe.md에 §4-quinque (canvas 가드 패턴) 포함', () => {
  const p = path.resolve(__dirname, '..', 'rules', 'fe.md');
  const md = fs.readFileSync(p, 'utf8');
  assert.match(md, /4-quinque/);
  assert.match(md, /canvas/i);
  assert.match(md, /getContext/);
  // 가드 패턴 코드 예시 포함
  assert.match(md, /typeof.*getContext.*function/);
  assert.match(md, /setupTests\.js/);
});

// ─────────── vite.config.js setupFiles 경로 정합 ───────────

test('D50: vite.config.js의 setupFiles가 setupTests.js 가리킴', () => {
  const p = path.resolve(__dirname, '..', 'lib', 'stack_templates', 'FE', 'vite.config.js');
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /setupFiles.*setupTests\.js/);
});
