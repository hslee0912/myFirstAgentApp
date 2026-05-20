'use strict';

/**
 * 결정론적 도메인 필드 validator (D88, 2026-05-20).
 *
 * rules/domain.md §2 카탈로그를 코드로 고정. BE Agent는 import만, 수정 X.
 * stack.config.json.BE.protectedConfigFiles 등록 → 응답에 포함 시 validatePaths가 차단.
 * 모든 endpoint(signup·check·login 등)는 동일 함수 호출 → endpoint 간 drift 차단.
 */

function validateUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_]{4,16}$/.test(u);
}

function validatePassword(p) {
  return typeof p === 'string' && /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/.test(p);
}

function validatePlayerName(n) {
  return typeof n === 'string' && n.length >= 2 && n.length <= 12;
}

function validatePlayerId(id) {
  return Number.isInteger(id) && id > 0;
}

function validateStage(s) {
  return Number.isInteger(s) && s >= 1 && s <= 5;
}

function validateNonNegativeInt(v) {
  return Number.isInteger(v) && v >= 0;
}

module.exports = {
  validateUsername,
  validatePassword,
  validatePlayerName,
  validatePlayerId,
  validateStage,
  validateNonNegativeInt,
};
