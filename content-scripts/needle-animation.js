/**
 * content-scripts/needle-animation.js
 * 
 * Temporary Judgement Needle Animation for PRIVISION (SIH26171).
 * Replaces the legacy persistent dark redaction overlays with a lightweight,
 * non-destructive visual confirmation:
 * 
 *   DETECT -> JUDGEMENT -> STITCH -> CONFIRM -> DISAPPEAR (~1600 ms)
 * 
 * Core Guarantees:
 * 1. VISUAL FEEDBACK ONLY: Does NOT modify, blur, cover, or replace the page text/DOM.
 * 2. NO LEAKS: pointer-events: none, aria-hidden="true". User interaction is unaffected.
 * 3. NO SCROLL BUGS: Uses position: fixed with getBoundingClientRect() & live rAF tracking.
 * 4. CLEANUP IS MANDATORY: 100% of animation DOM, SVG, and listeners removed on completion.
 * 5. CAPPED CONCURRENCY: Maximum 2 concurrent instances, gracefully queued.
 */

// Active state registry
const activeAnimations = new Set();
const animationQueue = [];
let isProcessingQueue = false;
const MAX_CONCURRENT_ANIMATIONS = 2;

/**
 * Resolves screen-relative viewport rectangles for Range, HTMLElement, or Rect.
 * Preserves ACTUAL target dimensions without arbitrary shrinking or double-offsetting.
 * 
 * @param {Range|HTMLElement|DOMRect|{x:number, y:number, width:number, height:number}} target 
 * @returns {Array<{ left: number, top: number, width: number, height: number, right: number, bottom: number }>}
 */
function resolveTargetRects(target) {
  if (!target) return [];

  try {
    // 1. DOM Range
    if (typeof Range !== 'undefined' && target instanceof Range) {
      const clientRects = Array.from(target.getClientRects());
      if (clientRects.length > 0) {
        return clientRects.map(r => {
          const w = r.width > 0 ? r.width : 28;
          const h = r.height > 0 ? r.height : 20;
          return {
            left: r.left,
            top: r.top,
            width: w,
            height: h,
            right: r.left + w,
            bottom: r.top + h
          };
        });
      }
      const bRect = target.getBoundingClientRect();
      if (bRect && (bRect.width > 0 || bRect.height > 0)) {
        const w = bRect.width > 0 ? bRect.width : 28;
        const h = bRect.height > 0 ? bRect.height : 20;
        return [{
          left: bRect.left,
          top: bRect.top,
          width: w,
          height: h,
          right: bRect.left + w,
          bottom: bRect.top + h
        }];
      }
    }

    // 2. HTMLElement (e.g. input fields, avatar wrap, text elements)
    if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement) {
      if (!target.isConnected) return [];
      const r = target.getBoundingClientRect();
      const w = r.width > 0 ? r.width : 28;
      const h = r.height > 0 ? r.height : 20;
      return [{
        left: r.left,
        top: r.top,
        width: w,
        height: h,
        right: r.left + w,
        bottom: r.top + h
      }];
    }

    // 3. Viewport Geometry object / DOMRect with left/top
    if (typeof target.left === 'number' && typeof target.top === 'number') {
      const w = (typeof target.width === 'number' && target.width > 0) ? target.width : 28;
      const h = (typeof target.height === 'number' && target.height > 0) ? target.height : 20;
      return [{
        left: target.left,
        top: target.top,
        width: w,
        height: h,
        right: target.left + w,
        bottom: target.top + h
      }];
    }

    // 4. Geometry object with clientX/clientY or x/y
    if (typeof target.x === 'number' && typeof target.y === 'number') {
      const left = target.clientX !== undefined ? target.clientX : target.x;
      const top = target.clientY !== undefined ? target.clientY : target.y;
      const w = (typeof target.width === 'number' && target.width > 0) ? target.width : 28;
      const h = (typeof target.height === 'number' && target.height > 0) ? target.height : 20;
      return [{
        left,
        top,
        width: w,
        height: h,
        right: left + w,
        bottom: top + h
      }];
    }
  } catch (err) {
    console.warn('[PRIVISION Needle] Target resolution warning:', err);
  }

  return [];
}

/**
 * Creates the dominant SVG needle element.
 * Dimensions: 48x48 px with fine surgical steel body, sharp tapered tip at (4, 44),
 * eye slot at (38, 10), and a vivid crimson thread accent trailing from the eye.
 * 
 * transformOrigin is pinned precisely to the needle's tip at (4px 44px) so all
 * rotations pivot exactly at the contact point with zero drift.
 */
function createNeedleSVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('width', '48');
  svg.setAttribute('height', '48');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.pointerEvents = 'none';
  svg.style.zIndex = '2147483647';
  svg.style.overflow = 'visible';
  svg.style.filter = 'drop-shadow(0 2px 5px rgba(0,0,0,0.65)) drop-shadow(0 0 1px rgba(255,255,255,0.7))';
  svg.style.transformOrigin = '4px 44px';

  svg.innerHTML = `
    <!-- Needle Body: Surgical Polished Steel (Sharp Tip at 4,44; Eye at 38,10) -->
    <path d="M4 44 L37 10 C38.5 8.5, 41 10.5, 39.5 12 L6 46 Z" fill="#F1F5F9" stroke="#334155" stroke-width="0.8" />
    
    <!-- Fine Tip Highlight & Longitudinal Edge Bevel -->
    <path d="M3 45 L8 40 L6 46 Z" fill="#FFFFFF" />
    <line x1="6" y1="44" x2="37" y2="12" stroke="#FFFFFF" stroke-width="0.8" stroke-linecap="round" />
    
    <!-- Needle Eye Slot -->
    <ellipse cx="37.5" cy="10.5" rx="2.2" ry="0.9" transform="rotate(-45 37.5 10.5)" fill="#0F172A" />
    
    <!-- Glowing Crimson Thread Accent at the Eye -->
    <path d="M38 10 Q42 6 45 8" fill="none" stroke="#EF4444" stroke-width="1.8" stroke-linecap="round" filter="drop-shadow(0 0 2px rgba(239, 68, 68, 0.9))" />
  `;

  return svg;
}

/**
 * Generates an interlocking dual-diagonal surgical criss-cross path (X pattern)
 * from startX up to currentX across vertical bounds [yTop, yBottom].
 * 
 * Thread A: (x0, yTop) -> (x1, yBottom) -> (x2, yTop) -> ...
 * Thread B: (x0, yBottom) -> (x1, yTop) -> (x2, yBottom) -> ...
 * Both threads cross at the centerline (yMid) in every segment.
 * 
 * @param {number} startX 
 * @param {number} endX 
 * @param {number} yMid 
 * @param {number} stitchHeight 
 * @param {number} stitchPitch 
 * @param {number} currentX 
 * @returns {string} SVG path data
 */
function buildCrissCrossPath(startX, endX, yMid, stitchHeight, stitchPitch, currentX) {
  if (currentX <= startX) return '';

  const halfH = stitchHeight / 2;
  const yTop = yMid - halfH;
  const yBottom = yMid + halfH;
  const width = Math.max(1, endX - startX);

  // Derive integer segments so crosses neatly fit target width
  const rawSegments = Math.max(1, Math.round(width / stitchPitch));
  const segmentWidth = width / rawSegments;

  let pathA = `M ${startX.toFixed(1)} ${yTop.toFixed(1)}`;
  let pathB = `M ${startX.toFixed(1)} ${yBottom.toFixed(1)}`;

  for (let i = 0; i < rawSegments; i++) {
    const x0 = startX + i * segmentWidth;
    const x1 = startX + (i + 1) * segmentWidth;

    if (currentX <= x0) break;

    const isEven = (i % 2 === 0);
    const targetYA = isEven ? yBottom : yTop;
    const targetYB = isEven ? yTop : yBottom;
    const fromYA = isEven ? yTop : yBottom;
    const fromYB = isEven ? yBottom : yTop;

    if (currentX >= x1) {
      pathA += ` L ${x1.toFixed(1)} ${targetYA.toFixed(1)}`;
      pathB += ` L ${x1.toFixed(1)} ${targetYB.toFixed(1)}`;
    } else {
      // Interpolate partial progress in active segment
      const t = Math.max(0, Math.min(1, (currentX - x0) / segmentWidth));
      const curYA = fromYA + (targetYA - fromYA) * t;
      const curYB = fromYB + (targetYB - fromYB) * t;
      pathA += ` L ${currentX.toFixed(1)} ${curYA.toFixed(1)}`;
      pathB += ` L ${currentX.toFixed(1)} ${curYB.toFixed(1)}`;
      break;
    }
  }

  return `${pathA} ${pathB}`;
}

/**
 * Executes the 5-stage Judgement Needle animation on a single rectangle:
 *   DETECT    (0–150 ms)    : Smooth entrance, mechanical settling at start of detected text
 *   JUDGEMENT (150–350 ms)  : Deliberate pause, smooth 35° tilt indicating detection
 *   STITCH    (350–1200 ms) : Dynamic surgical criss-cross (X-suture) with needle puncture kinematics
 *   CONFIRM   (1200–1450 ms): Needle straightens, subtle circular confirmation pulse
 *   DISAPPEAR (1450–1600 ms): Smooth fade out, complete DOM/listener cleanup at 1600 ms
 */
function animateSingleRect(initialRect, sourceTarget, options = {}) {
  return new Promise((resolve) => {
    // Top-level fixed overlay container (overflow: visible ensures needle & glow are never clipped)
    const container = document.createElement('div');
    container.className = 'privision-judgement-animation';
    container.setAttribute('aria-hidden', 'true');
    container.style.cssText = `
      position: fixed;
      left: 0;
      top: 0;
      width: 100vw;
      height: 100vh;
      pointer-events: none;
      z-index: 2147483646;
      overflow: visible;
      margin: 0;
      padding: 0;
    `;

    // Full-viewport SVG canvas for stitch trail
    const stitchSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    stitchSvg.setAttribute('aria-hidden', 'true');
    stitchSvg.setAttribute('width', '100%');
    stitchSvg.setAttribute('height', '100%');
    stitchSvg.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: visible;
    `;

    // 1. Subtle cyan glow trail behind the needle
    const stitchGlow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stitchGlow.setAttribute('fill', 'none');
    stitchGlow.setAttribute('stroke', '#38BDF8');
    stitchGlow.setAttribute('stroke-width', '3');
    stitchGlow.setAttribute('stroke-linecap', 'round');
    stitchGlow.setAttribute('stroke-linejoin', 'round');
    stitchGlow.style.opacity = '0';
    stitchGlow.style.filter = 'blur(1.5px)';
    stitchSvg.appendChild(stitchGlow);

    // 2. High-contrast surgical silver criss-cross stitch path
    const stitchPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stitchPath.setAttribute('fill', 'none');
    stitchPath.setAttribute('stroke', '#F1F5F9');
    stitchPath.setAttribute('stroke-width', '1.8');
    stitchPath.setAttribute('stroke-linecap', 'round');
    stitchPath.setAttribute('stroke-linejoin', 'round');
    stitchPath.style.opacity = '0';
    stitchPath.style.filter = 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.65))';
    stitchSvg.appendChild(stitchPath);

    // 3. Start detection beacon (crimson glowing point at text start)
    const startBeacon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    startBeacon.setAttribute('viewBox', '0 0 16 16');
    startBeacon.setAttribute('width', '16');
    startBeacon.setAttribute('height', '16');
    startBeacon.setAttribute('aria-hidden', 'true');
    startBeacon.style.cssText = `
      position: absolute;
      pointer-events: none;
      opacity: 0;
      transform-origin: center center;
      filter: drop-shadow(0 0 4px rgba(239, 68, 68, 0.85));
    `;
    startBeacon.innerHTML = `
      <circle cx="8" cy="8" r="6" fill="rgba(239, 68, 68, 0.25)" stroke="#EF4444" stroke-width="1.2" />
      <circle cx="8" cy="8" r="2.5" fill="#EF4444" />
    `;

    // 4. Needle element (48px surgical steel)
    const needle = createNeedleSVG();

    // 5. Confirmation mark (radiating circular ring with checkmark at text finish)
    const confirmMark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    confirmMark.setAttribute('viewBox', '0 0 24 24');
    confirmMark.setAttribute('width', '22');
    confirmMark.setAttribute('height', '22');
    confirmMark.setAttribute('aria-hidden', 'true');
    confirmMark.style.cssText = `
      position: absolute;
      pointer-events: none;
      opacity: 0;
      transform-origin: center center;
      filter: drop-shadow(0 0 5px rgba(56, 189, 248, 0.6)) drop-shadow(0 1px 2px rgba(0,0,0,0.5));
    `;
    confirmMark.innerHTML = `
      <circle cx="12" cy="12" r="9" fill="rgba(15, 23, 42, 0.85)" stroke="#38BDF8" stroke-width="1.5" />
      <path d="M7.5 12.2 L10.5 15.2 L16.5 9" fill="none" stroke="#F1F5F9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    `;

    container.appendChild(stitchSvg);
    container.appendChild(startBeacon);
    container.appendChild(needle);
    container.appendChild(confirmMark);
    document.body.appendChild(container);

    let currentTargetRect = { ...initialRect };
    let isCancelled = false;
    let rAFHandle = null;

    const cleanup = () => {
      if (rAFHandle) {
        cancelAnimationFrame(rAFHandle);
        rAFHandle = null;
      }
      if (container.parentNode) {
        container.remove();
      }
      activeAnimations.delete(handle);
      resolve();
    };

    const handle = {
      cancel: () => {
        isCancelled = true;
        cleanup();
      }
    };
    activeAnimations.add(handle);

    // Live position tracking on scroll/resize during active animation
    const updateTargetPosition = () => {
      if (sourceTarget) {
        const freshRects = resolveTargetRects(sourceTarget);
        if (freshRects.length > 0) {
          currentTargetRect = freshRects[0];
        }
      }
    };

    // Timeline configuration (default 1600ms)
    const totalDuration = options.duration || 1600;
    const tDetect = Math.round(totalDuration * (150 / 1600));   // 0 - 150 ms
    const tJudge = Math.round(totalDuration * (350 / 1600));    // 150 - 350 ms
    const tStitch = Math.round(totalDuration * (1200 / 1600));  // 350 - 1200 ms
    const tConfirm = Math.round(totalDuration * (1450 / 1600)); // 1200 - 1450 ms
    const startTime = performance.now();

    function frame(now) {
      if (isCancelled) return;

      const elapsed = now - startTime;
      updateTargetPosition();

      const r = currentTargetRect;
      const startX = r.left;
      const endX = r.right;
      const width = Math.max(1, endX - startX);
      // Vertically center directly through detected text region
      const yMid = r.top + (r.height / 2);

      // Criss-cross stitch vertical bounds and pitch
      const stitchHeight = Math.min(14, Math.max(8, r.height * 0.7));
      const halfH = stitchHeight / 2;
      const yTop = yMid - halfH;
      const yBottom = yMid + halfH;
      const stitchPitch = 12; // 10px-14px pitch per cross 'X'
      const rawSegments = Math.max(1, Math.round(width / stitchPitch));
      const segmentWidth = width / rawSegments;

      if (elapsed < tDetect) {
        // 1. DETECT (0–150 ms): Smooth entrance, opacity 0->1, scale 0.85->1.0, mechanical settling
        const p = Math.min(1, elapsed / tDetect);
        const easeOut = 1 - Math.pow(1 - p, 2);

        const opacity = easeOut;
        const scale = 0.85 + (0.15 * easeOut);
        const settleOffset = 4 * (1 - easeOut);
        const currentX = startX - settleOffset;

        // Needle tip at (currentX, yMid), upright natural angle (-45° base)
        needle.style.opacity = `${opacity}`;
        needle.style.transform = `translate3d(${currentX - 4}px, ${yMid - 44}px, 0) scale(${scale})`;

        // Start beacon glows at initial insertion point
        startBeacon.style.left = `${startX - 8}px`;
        startBeacon.style.top = `${yMid - 8}px`;
        startBeacon.style.opacity = `${opacity * 0.9}`;
        startBeacon.style.transform = `scale(${0.8 + 0.2 * easeOut})`;

        stitchPath.style.opacity = '0';
        stitchGlow.style.opacity = '0';

        rAFHandle = requestAnimationFrame(frame);

      } else if (elapsed < tJudge) {
        // 2. JUDGEMENT (150–350 ms): Deliberate pause at start; needle tilts smoothly by 15° (~35° to horizontal)
        const p = Math.min(1, (elapsed - tDetect) / (tJudge - tDetect));
        const easeInOut = 0.5 - 0.5 * Math.cos(p * Math.PI);
        const tiltAngle = 15 * easeInOut;

        needle.style.opacity = '1';
        needle.style.transform = `translate3d(${startX - 4}px, ${yMid - 44}px, 0) rotate(${tiltAngle}deg)`;

        startBeacon.style.left = `${startX - 8}px`;
        startBeacon.style.top = `${yMid - 8}px`;
        startBeacon.style.opacity = '0.9';

        stitchPath.style.opacity = '0';
        stitchGlow.style.opacity = '0';

        rAFHandle = requestAnimationFrame(frame);

      } else if (elapsed < tStitch) {
        // 3. STITCH (350–1200 ms): Dynamic surgical criss-cross (cross-stitch / "X" pattern)
        const p = Math.min(1, (elapsed - tJudge) / (tStitch - tJudge));
        const easeInOut = 0.5 - 0.5 * Math.cos(p * Math.PI);
        const currentX = startX + (endX - startX) * easeInOut;

        // Needle kinematics: dynamically follow Thread A puncture path & tilt angle
        const dist = Math.max(0, currentX - startX);
        const segIndex = Math.min(rawSegments - 1, Math.floor(dist / segmentWidth));
        const segT = Math.min(1, Math.max(0, (dist - (segIndex * segmentWidth)) / segmentWidth));
        const isEven = (segIndex % 2 === 0);

        const fromYA = isEven ? yTop : yBottom;
        const targetYA = isEven ? yBottom : yTop;
        const needleY = fromYA + (targetYA - fromYA) * segT;

        // Dynamic penetration angle:
        // Downward stroke: tilts forward up to +28° to penetrate downward
        // Upward stroke: tilts back to -12° to pull upward
        const strokeAngle = isEven
          ? 12 + 16 * Math.sin(segT * Math.PI)
          : 2 - 14 * Math.sin(segT * Math.PI);

        // Smooth blend from the JUDGEMENT exit angle (15°) into the stitch cycle
        const entryBlend = Math.min(1, p * 8);
        const finalAngle = 15 * (1 - entryBlend) + strokeAngle * entryBlend;

        needle.style.opacity = '1';
        needle.style.transform = `translate3d(${currentX - 4}px, ${needleY - 44}px, 0) rotate(${finalAngle.toFixed(1)}deg)`;

        // Update interlocking criss-cross SVG stitch path
        const pathData = buildCrissCrossPath(startX, endX, yMid, stitchHeight, stitchPitch, currentX);
        stitchPath.setAttribute('d', pathData);
        stitchPath.style.opacity = '0.95';

        stitchGlow.setAttribute('d', pathData);
        stitchGlow.style.opacity = '0.45';

        // Start beacon gently fades as stitch proceeds
        startBeacon.style.opacity = `${Math.max(0, 0.9 - p * 2)}`;

        rAFHandle = requestAnimationFrame(frame);

      } else if (elapsed < tConfirm) {
        // 4. CONFIRM (1200–1450 ms): Needle straightens upright (-15°); subtle confirmation pulse
        const p = Math.min(1, (elapsed - tStitch) / (tConfirm - tStitch));

        // Needle returns to upright posture (-15°) and centers to yMid
        const straightenP = Math.min(1, p * 2.0);
        const straightenEase = 0.5 - 0.5 * Math.cos(straightenP * Math.PI);
        const lastNeedleY = (rawSegments % 2 === 1) ? yBottom : yTop;
        const curNeedleY = lastNeedleY + (yMid - lastNeedleY) * straightenEase;
        const exitStitchAngle = (rawSegments % 2 === 1) ? 12 : 2;
        const angle = exitStitchAngle * (1 - straightenEase) - (15 * straightenEase);

        needle.style.opacity = '1';
        needle.style.transform = `translate3d(${endX - 4}px, ${curNeedleY - 44}px, 0) rotate(${angle.toFixed(1)}deg)`;

        // Full criss-cross stitch line remains visible through text
        const fullPath = buildCrissCrossPath(startX, endX, yMid, stitchHeight, stitchPitch, endX);
        stitchPath.setAttribute('d', fullPath);
        stitchPath.style.opacity = '0.95';

        stitchGlow.setAttribute('d', fullPath);
        stitchGlow.style.opacity = '0.45';

        // Radiating confirmation mark at text finish
        confirmMark.style.left = `${endX + 6}px`;
        confirmMark.style.top = `${yMid - 11}px`;
        confirmMark.style.opacity = `${Math.min(1, p * 3)}`;

        const pulseScale = p < 0.55
          ? 0.75 + 0.40 * (p / 0.55)
          : 1.15 - 0.15 * ((p - 0.55) / 0.45);
        confirmMark.style.transform = `scale(${pulseScale})`;

        rAFHandle = requestAnimationFrame(frame);

      } else if (elapsed < totalDuration) {
        // 5. DISAPPEAR (1450–1600 ms): Smooth quadratic fade-out of all temporary visual elements
        const p = Math.min(1, (elapsed - tConfirm) / (totalDuration - tConfirm));
        const fadeEase = p * p;
        const remainingOpacity = Math.max(0, 1 - fadeEase);

        container.style.opacity = `${remainingOpacity}`;
        needle.style.transform = `translate3d(${endX - 4}px, ${yMid - 44}px, 0) rotate(-15deg) scale(${1 - 0.08 * p})`;
        confirmMark.style.transform = `scale(${1 - 0.08 * p})`;

        // Completed criss-cross path stays rendered while container fades
        const fullPath = buildCrissCrossPath(startX, endX, yMid, stitchHeight, stitchPitch, endX);
        stitchPath.setAttribute('d', fullPath);
        stitchGlow.setAttribute('d', fullPath);

        rAFHandle = requestAnimationFrame(frame);

      } else {
        // Complete cleanup at ~1600 ms
        cleanup();
      }
    }

    rAFHandle = requestAnimationFrame(frame);
  });
}

/**
 * Public Animation API: Plays the Judgement Needle animation on target.
 * Target can be: Range, HTMLElement, or Rect geometry.
 * 
 * @param {Range|HTMLElement|Object} target 
 * @param {Object} [options]
 * @returns {Promise<void>}
 */
export async function playJudgementAnimation(target, options = {}) {
  const rects = resolveTargetRects(target);
  if (rects.length === 0) return;

  return new Promise((resolve) => {
    animationQueue.push({
      target,
      rects,
      options,
      resolve
    });

    drainQueue();
  });
}

/**
 * Robust async queue processor enforcing max 2 simultaneous active animation instances.
 * Guarantees zero queue loss, avoids microtask races, and promptly re-drains as slots free up.
 */
async function drainQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    while (animationQueue.length > 0) {
      if (activeAnimations.size >= MAX_CONCURRENT_ANIMATIONS) {
        // Wait for an active animation slot to free up
        await new Promise(r => setTimeout(r, 40));
        continue;
      }

      const item = animationQueue.shift();
      if (!item) break;

      // Synchronously reserve a concurrency slot handle before yielding
      const slotHandle = Symbol('needleAnimSlot');
      activeAnimations.add(slotHandle);

      (async () => {
        try {
          const lineCount = item.rects.length;
          // Coherent sequentially paced timeline for multiline targets
          const perLineDuration = lineCount > 1
            ? Math.max(900, Math.round(1600 / lineCount))
            : (item.options?.duration || 1600);

          for (const rect of item.rects) {
            await animateSingleRect(rect, item.target, { ...item.options, duration: perLineDuration });
          }
        } catch (err) {
          console.warn('[PRIVISION Needle] Animation execution error:', err);
        } finally {
          activeAnimations.delete(slotHandle);
          item.resolve();
          // Promptly drain remaining queued items as soon as a slot opens
          drainQueue();
        }
      })();

      // Brief stagger before allocating the next slot
      if (animationQueue.length > 0) {
        await new Promise(r => setTimeout(r, 60));
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

/**
 * Public Cancellation API: Immediately cancels running animations and purges queue.
 */
export function cancelJudgementAnimation() {
  animationQueue.length = 0;
  for (const active of Array.from(activeAnimations)) {
    if (active && typeof active.cancel === 'function') {
      active.cancel();
    }
  }
  activeAnimations.clear();

  if (typeof document !== 'undefined') {
    document.querySelectorAll('.privision-judgement-animation').forEach(el => el.remove());
  }
}

