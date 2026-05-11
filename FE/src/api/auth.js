/**
 * 회원가입 API 호출
 * @param {Object} credentials - { email, password }
 * @returns {Promise<Object>} { success, data, error }
 */
export async function signup(credentials) {
  try {
    const response = await fetch('/api/v1/auth/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(credentials)
    });

    const data = await response.json();
    return data;
  } catch (error) {
    return {
      success: false,
      error: 'NETWORK_ERROR'
    };
  }
}
