/**
 * 회원가입 API 호출
 * @param {Object} data - 회원가입 데이터
 * @param {string} data.email - 이메일
 * @param {string} data.password - 비밀번호
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
export async function signup(data) {
  try {
    const response = await fetch('/auth/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: data.email,
        password: data.password
      })
    });

    const result = await response.json();

    if (response.ok) {
      return result;
    }

    return {
      success: false,
      error: result.error || 'Signup failed',
      details: result.details
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Network error'
    };
  }
}

/**
 * 로그인 API 호출
 * @param {Object} data - 로그인 데이터
 * @param {string} data.email - 이메일
 * @param {string} data.password - 비밀번호
 * @returns {Promise<{success: boolean, data?: {user_id: number}, error?: string}>}
 */
export async function login(data) {
  try {
    const response = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: data.email,
        password: data.password
      })
    });

    const result = await response.json();

    if (response.ok) {
      return result;
    }

    return {
      success: false,
      error: result.error || 'Login failed'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Network error'
    };
  }
}
