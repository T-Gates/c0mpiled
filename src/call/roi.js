// Human Check 통화 — 얼굴 ROI 평균 RGB (순수 함수, DOM 금지, node import 가능)
// src/app.js의 faceCircles/faceMean과 같은 규칙을 RGBA 버퍼 위에서 다시 구현한다.

export const FACE_ROI_IDX = [50, 280, 151];
export const FACE_ROI_RADIUS = 0.06;

// 원 3개: 중심 = landmarks[50|280|151] × (width, height)
// 반지름 = (랜드마크 전체 x의 max−min) × width × FACE_ROI_RADIUS
export function faceCircles(landmarks, width, height) {
  let minX = Infinity, maxX = -Infinity;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  const r = (maxX - minX) * width * FACE_ROI_RADIUS;
  return FACE_ROI_IDX.map((i) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height, r }));
}

// frame: { data: Uint8ClampedArray(RGBA), width, height }, landmarks: [{x,y}] 정규화 좌표
// 세 원 중 하나라도 안에 드는 픽셀(픽셀 중심 x+0.5, y+0.5, 경계 포함)의 평균 [r,g,b]. 픽셀 0개면 null.
export function faceMeanRgb(frame, landmarks) {
  if (!frame || !frame.data || !landmarks) return null;
  const W = frame.width;
  const H = frame.height;
  if (!(W > 0) || !(H > 0)) return null;
  for (const i of FACE_ROI_IDX) if (!landmarks[i]) return null;
  const circles = faceCircles(landmarks, W, H);
  const rad = circles[0].r;
  if (!(rad > 0)) return null;
  const x0 = Math.max(0, Math.floor(Math.min(...circles.map((c) => c.x - c.r))));
  const y0 = Math.max(0, Math.floor(Math.min(...circles.map((c) => c.y - c.r))));
  const x1 = Math.min(W, Math.ceil(Math.max(...circles.map((c) => c.x + c.r))));
  const y1 = Math.min(H, Math.ceil(Math.max(...circles.map((c) => c.y + c.r))));
  if (x1 <= x0 || y1 <= y0) return null;
  const r2 = rad * rad;
  const data = frame.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x < x1; x++) {
      const px = x + 0.5;
      let inside = false;
      for (const c of circles) {
        const dx = px - c.x, dy = py - c.y;
        if (dx * dx + dy * dy <= r2) { inside = true; break; }
      }
      if (!inside) continue;
      const o = (y * W + x) * 4;
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
      n++;
    }
  }
  return n > 0 ? [r / n, g / n, b / n] : null;
}
