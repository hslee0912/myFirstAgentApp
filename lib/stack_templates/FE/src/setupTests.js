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

// D50-fix (2026-05-15): requestAnimationFrame mock은 *반드시 no-op*.
//   사용자 보고 사고 (cycle 1 hang): rAF가 setTimeout(cb, 16)로 콜백을 *실제로
//   호출*하면 LLM이 emit한 게임 루프 (function gameLoop() { ...;
//   requestAnimationFrame(gameLoop); }) 가 *무한 재귀* → vitest 영원히 안 끝남
//   → orchestrator 20분 이상 hang.
//   smoke test 목적은 *render 자체*가 throw 안 하는지만 검증 — 게임 루프는 *한
//   번도 실행될 필요 없음*. unmount cleanup만 정상 동작하면 OK.
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// D78 (2026-05-18): React "Maximum update depth exceeded" 무한 setState 가드.
//   사용자 보고 사고 (cycle b0izkrd5s, GamePage 매 round 5분 timeout 반복):
//   props default가 inline (`onNavigate = () => {}` / `gameData = {...}`) 일 때
//   매 render마다 새 reference → useEffect dep array의 diff가 매번 변화 인식 →
//   cleanup + re-run → effect 안 setState → re-render → 무한.
//   React가 "Maximum update depth exceeded"를 console.error로 발화하지만 throw 안 해
//   vitest worker가 idle 안 됨 → lint stage timeout 5분 발동까지 stuck.
//   이 가드가 그 메시지를 잡아 *즉시 throw* → vitest test FAIL로 빠르게 종료.
//   해결 패턴은 rules/fe.md §4-ter-α 참조 (모듈 상수 default / useRef / dep []).
const __origConsoleError = console.error;
console.error = function patched(...args) {
  const msg = args[0] && String(args[0]);
  if (msg && msg.includes('Maximum update depth exceeded')) {
    throw new Error(
      '[setupTests] Maximum update depth exceeded — inline default in useEffect dep 의심. ' +
      'rules/fe.md §4-ter-α 참조 (모듈 상수 default / useRef / dep []).'
    );
  }
  return __origConsoleError.apply(this, args);
};
