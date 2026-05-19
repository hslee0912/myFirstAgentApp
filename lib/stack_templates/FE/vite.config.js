import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Nginx reverse proxy 환경: 외부 진입은 http://<host>/demo/.
  // base를 박아야 정적 자산 import URL이 '/demo/...'로 빌드되어
  // Nginx의 location /demo/와 1:1 일치한다 (strip 없는 forward).
  base: '/demo/',
  server: {
    // 컨테이너에서 0.0.0.0 listen — host:5173으로 들어오는 호스트
    // 인터페이스 매핑이 닿게 한다. Dockerfile CMD --host와 중복이지만 명시.
    host: '0.0.0.0',
    port: Number(process.env.FE_PORT) || 5173,
    // Vite 5+의 host check: default는 localhost만 허용. Nginx reverse proxy
    // 통해 prof23.p.ssafy.io 같은 외부 호스트네임으로 들어오면 403 "Blocked
    // request" 응답. dev server라 'true'로 모든 host 허용 (보안 영향 작음).
    allowedHosts: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.js',
  },
});
