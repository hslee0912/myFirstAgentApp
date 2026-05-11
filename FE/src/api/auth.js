export async function signup({ email, password }) {
  try {
    const response = await fetch('/api/v1/auth/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (response.status === 201) {
      return { success: true, data: data.data };
    }

    if (response.status === 409) {
      return { success: false, error: '이미 가입된 이메일입니다' };
    }

    if (response.status === 400) {
      return { success: false, error: data.error || '입력값이 유효하지 않습니다' };
    }

    return { success: false, error: data.error || '회원가입에 실패했습니다' };
  } catch (error) {
    return { success: false, error: '네트워크 오류가 발생했습니다' };
  }
}
