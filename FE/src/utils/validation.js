/**
 * 이메일 형식 검증
 * @param {string} email
 * @returns {string} 에러 메시지 (빈 문자열이면 유효)
 */
export function validateEmail(email) {
  if (!email) {
    return '이메일을 입력하세요';
  }
  const pattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!pattern.test(email)) {
    return '올바른 이메일 형식을 입력하세요';
  }
  return '';
}

/**
 * 비밀번호 길이 검증
 * @param {string} password
 * @returns {string} 에러 메시지 (빈 문자열이면 유효)
 */
export function validatePassword(password) {
  if (!password) {
    return '비밀번호를 입력하세요';
  }
  if (password.length < 8) {
    return '비밀번호는 8자 이상이어야 합니다';
  }
  return '';
}

/**
 * 비밀번호 일치 검증
 * @param {string} passwordConfirm
 * @param {string} password
 * @returns {string} 에러 메시지 (빈 문자열이면 유효)
 */
export function validatePasswordMatch(passwordConfirm, password) {
  if (!passwordConfirm) {
    return '비밀번호 확인을 입력하세요';
  }
  if (passwordConfirm !== password) {
    return '비밀번호가 일치하지 않습니다';
  }
  return '';
}
