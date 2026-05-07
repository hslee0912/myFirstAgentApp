# Backend Authentication Service

## 개요
이메일/비밀번호 기반 회원가입 API를 제공하는 Express 백엔드 서비스입니다.

## 기술 스택
- Node.js + Express
- MySQL2 (Prepared Statements)
- bcrypt (비밀번호 해싱)
- Jest + Supertest (테스트)

## 설치 및 실행

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경 변수 설정
`.env.example`을 `.env`로 복사 후 DB 정보 입력:
```
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=authdb
DB_PORT=3306
```

### 3. 데이터베이스 초기화
MySQL에서 `src/db/init.sql` 실행:
```bash
mysql -u root -p < src/db/init.sql
```

### 4. 서버 실행
```bash
npm start
# 또는 개발 모드
npm run dev
```

### 5. 테스트 실행
```bash
npm test
```

## API 엔드포인트

### POST /api/auth/signup
신규 사용자 등록

**요청:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123"
}
```

**성공 응답 (201):**
```json
{
  "success": true,
  "data": {
    "userId": 42,
    "email": "user@example.com"
  }
}
```

**에러 응답:**
- 400: 잘못된 입력
- 409: 이메일 중복
- 500: 서버 오류

## 보안 특징
- bcrypt로 비밀번호 해시 (saltRounds=10)
- Prepared Statements로 SQL Injection 방지
- 이메일 RFC 5322 형식 검증
- 비밀번호 최소 8자 이상 강제

## 프로젝트 구조
```
BE/
├── src/
│   ├── config/
│   │   └── db.js              # MySQL 연결 풀
│   ├── routes/
│   │   ├── auth_router.js     # 인증 라우터
│   │   └── auth_router.test.js
│   ├── services/
│   │   ├── user_service.js    # 사용자 비즈니스 로직
│   │   └── user_service.test.js
│   ├── utils/
│   │   ├── validation.js      # 입력값 검증
│   │   └── validation.test.js
│   ├── db/
│   │   └── init.sql           # DB 초기화 스크립트
│   └── server.js              # Express 앱 진입점
├── .env.example
├── package.json
└── README.md
```

## 테스트 커버리지
모든 핵심 함수는 단위 테스트를 포함합니다:
- 입력값 검증 (이메일/비밀번호)
- 비밀번호 해싱
- API 엔드포인트 (성공/실패 케이스)

테스트 실행 시 커버리지 리포트가 자동 생성됩니다.