import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev 환경에서 FE(5173)와 BE(3001)가 다른 port라 상대 경로 fetch가 cross-origin
// 이슈로 깨진다. Vite dev server가 /api/* 요청을 받으면 BE로 forward.
//
// target은 환경에 따라 다르다:
//   - docker compose: FE 컨테이너가 BE 컨테이너에 접근 → service name 'be' 사용
//     (docker-compose.yml에서 VITE_BE_PROXY_TARGET=http://be:3001 주입)
//   - native dev (cd FE && npm run dev): host의 localhost:3001 (BE_PORT)
//
// 이 파일은 protected — LLM agent가 수정 못 함. 인프라 결정은 사람이.
const proxyTarget =
  process.env.VITE_BE_PROXY_TARGET ||
  `http://localhost:${process.env.BE_PORT || 3001}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.FE_PORT) || 5173,
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.js',
  },
});
