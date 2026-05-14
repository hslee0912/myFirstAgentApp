import '@testing-library/jest-dom';

/**
 * D50 (2026-05-14): jsdom canvas stub — *시스템 자동 제공*.
 *
 * 사용자 보고 사고 (big-cycle 6): GamePage가 React canvas 사용 →
 * smoke test render(<GamePage />) → useEffect에서 getContext('2d') 호출
 * → jsdom이 HTMLCanvasElement.getContext를 native 구현 안 함 → throw →
 * Stage 3 FAIL. 같은 사고가 모든 canvas-using 컴포넌트에서 발생.
 *
 * 해결: vitest setup file에서 jsdom의 canvas API를 *no-op 객체*로 stub.
 * 컴포넌트 코드는 정상 emit 가능, smoke test는 mount + useEffect 안전 통과.
 *
 * 실제 게임 동작은 *브라우저 환경*에서만 검증됨 (Docker 컨테이너 / Phase 9
 * PostTest 또는 사람의 UI 확인). 단위 테스트는 *non-null DOM rendering*만 보장.
 *
 * 본 파일은 lib/stack.config.json의 FE.protectedConfigFiles에 등록되어 LLM이
 * 수정·덮어쓰기 못함. bootstrap이 매 cycle 시작 시 disk에 자동 깔림.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  const noopCtx = {
    canvas: null,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillRect: () => {},
    strokeRect: () => {},
    clearRect: () => {},
    fillText: () => {},
    strokeText: () => {},
    measureText: () => ({ width: 0 }),
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    arcTo: () => {},
    bezierCurveTo: () => {},
    quadraticCurveTo: () => {},
    rect: () => {},
    fill: () => {},
    stroke: () => {},
    clip: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    transform: () => {},
    setTransform: () => {},
    resetTransform: () => {},
    drawImage: () => {},
    createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    putImageData: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createPattern: () => null,
  };
  HTMLCanvasElement.prototype.getContext = function () { return noopCtx; };
  HTMLCanvasElement.prototype.toDataURL = function () { return 'data:,'; };
}

// jsdom의 requestAnimationFrame은 일부 환경에서 미구현 — 게임 루프 사용 시
// 안전. 16ms 후 콜백 (60fps mock). cancelAnimationFrame도 짝.
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
}
if (typeof globalThis.cancelAnimationFrame !== 'function') {
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}
