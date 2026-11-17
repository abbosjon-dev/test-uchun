/* Yo'l yordamchisi v2 — lane, sign, vehicle detection in the browser.
   Learning prototype. Not a safety system. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const view = $('view'), ctx = view.getContext('2d');
const bev = $('bev'), bctx = bev.getContext('2d');

// ===================================================================
// Settings
// ===================================================================
const P = {
  get region(){ return $('region').value }, get fov(){ return +$('fov').value * Math.PI / 180 },
  get auto(){ return $('auto').checked }, get ai(){ return $('ai').checked },
  get hor(){ return +$('hor').value / 100 }, get camH(){ return +$('camH').value / 10 },
  get bot(){ return +$('bot').value / 100 }, get lthr(){ return +$('lthr').value },
  get dep(){ return +$('dep').value / 100 }, get camOff(){ return +$('off').value / 100 },
  get ttc(){ return +$('ttc').value / 10 },
  get snd(){ return $('snd').checked }, get voice(){ return $('voice').checked },
  get gps(){ return $('gps').checked }, get dbg(){ return $('dbg').checked }
};
const US = () => P.region === 'us';
const LANE_W = () => US() ? 3.66 : 3.5;            // standard lane width, metres
const fmtDist = m => US() ? Math.round(m * 3.281) + ' fut' : (m < 10 ? m.toFixed(1) : Math.round(m)) + ' m';
const fmtSpeed = kmh => US() ? Math.round(kmh / 1.609) + ' mil/soat' : Math.round(kmh) + ' km/soat';
const SPEED_UNIT = () => US() ? 'mil/soat' : 'km/soat';

const labels = { fov: ['vFov', v => v + '°'], hor: ['vHor', v => v + '%'], camH: ['vCamH', v => (v / 10).toFixed(1) + ' m'],
  bot: ['vBot', v => v + '%'], lthr: ['vLthr', v => v], dep: ['vDep', v => v + '%'], off: ['vOff', v => (v * 0.02).toFixed(2) + ' m'], ttc: ['vTtc', v => (v / 10).toFixed(1) + ' s'] };
for (const k in labels) { const [id, f] = labels[k]; const upd = () => $(id).textContent = f($(k).value); $(k).addEventListener('input', upd); upd(); }
const SKEY = 'yy2-settings';
try {
  const saved = JSON.parse(localStorage.getItem(SKEY) || '{}');
  for (const k in saved) { const el = $(k); if (!el) continue; if (el.type === 'checkbox') el.checked = saved[k]; else { el.value = saved[k]; el.dispatchEvent(new Event('input')); } }
} catch (e) {}
document.querySelectorAll('.controls input, .controls select').forEach(el => el.addEventListener('change', () => {
  try { const o = {}; document.querySelectorAll('.controls input, .controls select').forEach(i => o[i.id] = i.type === 'checkbox' ? i.checked : i.value); localStorage.setItem(SKEY, JSON.stringify(o)); } catch (e) {}
}));
$('region').addEventListener('change', () => { curLimit = null; signTracks = []; updateLimitStat(); if (mode === 'demo') demo.reset(); });
$('btnRecal').addEventListener('click', () => resetCalibration());
$('ai').addEventListener('change', () => { if (P.ai && mode && mode !== 'demo') loadModel(); });

function showMsg(t){ const m = $('msg'); m.innerHTML = t || ''; m.style.display = t ? 'block' : 'none'; }

// ===================================================================
// Audio, voice, alerts
// ===================================================================
let actx = null;
function initAudio(){
  try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) {}
  try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch (e) {}
}
function tone(freq, t0, dur, type, vol){
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type || 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol || 0.25, t0 + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + dur + 0.02);
}
function beep(kind){
  if (!P.snd || !actx) return;
  try {
    const t = actx.currentTime;
    if (kind === 'crit') { for (let i = 0; i < 4; i++) tone(1200, t + i * 0.11, 0.08, 'square', 0.3); }
    else if (kind === 'bad') { tone(880, t, 0.13, 'square', 0.22); tone(880, t + 0.18, 0.13, 'square', 0.22); }
    else if (kind === 'chime') { tone(660, t, 0.18, 'sine', 0.25); tone(990, t + 0.14, 0.25, 'sine', 0.25); }
    else tone(720, t, 0.15, 'sine', 0.22);
  } catch (e) {}
}
let voices = [];
function loadVoices(){ try { voices = speechSynthesis.getVoices(); } catch (e) {} }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function speak(text){
  if (!P.voice || !('speechSynthesis' in window) || !text) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    const v = voices.find(v => /^uz/i.test(v.lang)) || voices.find(v => /^tr/i.test(v.lang));
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'uz-UZ';
    u.rate = 1.08; speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch (e) {}
}
const lastAlert = {}, pending = [];
let bannerTimer = null, bannerPrio = 0;
const PRIO = { crit: 3, bad: 2, info: 1, chime: 1 };
function alertUser(key, text, level, cooldownMs, spoken){
  const now = performance.now();
  if (lastAlert[key] && now - lastAlert[key] < cooldownMs) return false;
  const pr = PRIO[level] || 1;
  if (bannerPrio > pr && $('banner').classList.contains('show')) {   // don't cover a more important alert: queue it
    if (/^(speed-|sign-|light-)/.test(key) && !pending.some(p => p.key === key)) pending.push({ key, text, level, cooldownMs, spoken, at: now });
    return false;
  }
  lastAlert[key] = now;
  const b = $('banner'); b.textContent = text; b.className = 'banner show' + (level === 'info' || level === 'chime' ? ' info' : '');
  bannerPrio = pr; clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    b.className = 'banner'; bannerPrio = 0;
    const t = performance.now();
    while (pending.length) { const p = pending.shift(); if (t - p.at < 5000) { setTimeout(() => alertUser(p.key, p.text, p.level, p.cooldownMs, p.spoken), 250); break; } }
  }, level === 'crit' ? 1800 : 2600);
  beep(level); speak(spoken === undefined ? text.replace(/[^\p{L}\p{N}\s'’.,-]/gu, '') : spoken);
  const row = document.createElement('div');
  row.innerHTML = `<span>${new Date().toLocaleTimeString().slice(0, 8)}</span>`; row.appendChild(document.createTextNode(text));
  const log = $('log'); log.prepend(row); while (log.children.length > 50) log.lastChild.remove();
  (window.__alerts = window.__alerts || []).push(key);
  return true;
}

// ===================================================================
// Sources: camera, video file, demo
// ===================================================================
const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.setAttribute('playsinline', '');
let mode = null, paused = false, running = false, stream = null, srcW = 960, srcH = 540, wakeLock = null;

function setSource(w, h){
  srcW = w; srcH = h;
  const s = Math.min(1, 1280 / w);
  view.width = Math.round(w * s); view.height = Math.round(h * s);
  LH = Math.round(LW * h / w); lc.width = LW; lc.height = LH; G = new Float32Array(LW * LH);
  SH = Math.round(SW * h / w); sc.width = SW; sc.height = SH;
  redM = new Uint8Array(SW * SH); whM = new Uint8Array(SW * SH); yeM = new Uint8Array(SW * SH); darkM = new Uint8Array(SW * SH);
  tmpM = new Uint8Array(SW * SH); labA = new Int32Array(SW * SH);
  resetState(); resetCalibration();
  $('empty').style.display = 'none';
}
function stopAll(){
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  video.pause(); video.srcObject = null;
  if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); }
}
$('btnCam').addEventListener('click', async () => {
  initAudio(); stopAll(); showMsg('');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showMsg("Bu brauzerda kamera ishlamaydi. Sahifani <b>https://</b> manzil orqali Chrome yoki Safari'da oching.");
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    video.srcObject = stream; await video.play();
    setSource(video.videoWidth || 1280, video.videoHeight || 720); mode = 'camera'; paused = false; start();
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    startGps(); if (P.ai) loadModel();
  } catch (e) {
    showMsg("Kamera ochilmadi (" + (e.name || 'xato') + "). Brauzer sozlamalarida kameraga ruxsat bering. Agar sahifa Claude ichida ochilgan bo'lsa, u yerda kamera bloklangan, uni alohida https havola orqali oching.");
  }
});
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && stream && 'wakeLock' in navigator) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }
});
$('file').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  initAudio(); stopAll(); showMsg('');
  video.src = URL.createObjectURL(f); video.loop = true;
  video.onloadedmetadata = () => { setSource(video.videoWidth || 960, video.videoHeight || 540); mode = 'video'; paused = false; video.play().catch(() => {}); start(); if (P.ai) loadModel(); };
  video.onerror = () => showMsg("Videoni ochib bo'lmadi. MP4 (H.264) yoki WebM formatini sinab ko'ring.");
  e.target.value = '';
});
$('btnDemo').addEventListener('click', () => { initAudio(); stopAll(); showMsg(''); demo.reset(); setSource(960, 540); mode = 'demo'; paused = false; start(); });
$('btnPause').addEventListener('click', () => {
  paused = !paused; $('btnPause').textContent = paused ? '▶' : '⏸';
  if (mode === 'video') paused ? video.pause() : video.play().catch(() => {});
});
$('btnFull').addEventListener('click', () => {
  const el = $('main');
  try { if (document.fullscreenElement) document.exitFullscreen(); else (el.requestFullscreen || el.webkitRequestFullscreen).call(el); } catch (e) {}
  try { screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}); } catch (e) {}
});

// ===================================================================
// GPS speed
// ===================================================================
let gpsWatch = null, gpsKmh = null, gpsTime = 0;
function startGps(){
  if (gpsWatch !== null || !P.gps || !navigator.geolocation) return;
  try {
    gpsWatch = navigator.geolocation.watchPosition(p => {
      if (p.coords.speed != null && !isNaN(p.coords.speed)) { gpsKmh = Math.max(0, p.coords.speed * 3.6); gpsTime = performance.now(); }
    }, () => { $('sSpeed').textContent = "ruxsat yo'q"; }, { enableHighAccuracy: true, maximumAge: 1000 });
  } catch (e) {}
}
function egoKmh(){
  if (mode === 'demo') return demo.speedKmh;
  return gpsKmh != null && performance.now() - gpsTime < 5000 ? gpsKmh : null;
}

// ===================================================================
// Calibration (vanishing point + camera height)
// ===================================================================
const LW = 320; let LH = 180;
const cal = { vpx: LW / 2, vpy: 90, camH: 1.3, conf: 0, n: 0 };
function resetCalibration(){
  cal.vpx = LW / 2; cal.vpy = LH * P.hor; cal.camH = P.camH; cal.conf = 0; cal.n = 0;
}
const fpx = () => (LW / 2) / Math.tan(P.fov / 2);    // focal length in lane-buffer pixels
function groundToImage(X, Z){ const f = fpx(); return [cal.vpx + f * X / Z, cal.vpy + f * cal.camH / Z]; }

// ===================================================================
// Lane detection
// ===================================================================
const lc = document.createElement('canvas'); const lctx = lc.getContext('2d', { willReadFrequently: true });
let G = null, feats = [];
const PHIS = []; for (let a = 8; a <= 78; a += 2) PHIS.push(Math.tan(a * Math.PI / 180));
const BIN = 3, XMIN = -LW * 0.8, NB = Math.ceil(LW * 2.6 / BIN);
const accL = new Float32Array(PHIS.length * NB), accR = new Float32Array(PHIS.length * NB);
const HB = 0.15, HX0 = -16, HN = Math.round(32 / HB);
const hist = new Float32Array(HN);
const lane = { L: null, R: null, width: null, depFrames: 0, offset: null, marks: [], egoL: null, egoR: null, nLanes: null, egoIdx: null, laneHist: [] };
const mkSide = () => ({ line: null, cand: null, lost: 99, jump: 0 });
lane.L = mkSide(); lane.R = mkSide();
let roi = { yT: 0, yB: 0 };

function detectLanes(src){
  lctx.drawImage(src, 0, 0, LW, LH);
  const d = lctx.getImageData(0, 0, LW, LH).data;
  const yB = Math.min(LH - 2, Math.round(LH * P.bot) - 1);
  const yT = Math.max(2, Math.round(cal.vpy + (yB - cal.vpy) * 0.1));
  roi = { yT, yB };
  if (yB - yT < 12) return;
  for (let y = yT; y <= yB; y++) for (let x = 0; x < LW; x++) {
    const i = y * LW + x, r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    let v = 0.299 * r + 0.587 * g + 0.114 * b;
    if (r > 120 && g > 90 && b < g * 0.78 && r - b > 45) v = Math.max(v, 215);  // yellow paint
    G[i] = v;
  }
  feats = [];
  const thr = P.lthr;
  for (let y = yT; y <= yB; y++) {
    // expected paint width (≈15 cm) in pixels at this row, from the ground model
    const pxPerM = Math.max(0.5, (y - cal.vpy) / cal.camH);
    const k = Math.max(2, Math.min(14, Math.round(0.15 * pxPerM * 1.3 + 1)));
    const row = y * LW;
    let rowMean = 0; for (let x = 0; x < LW; x += 4) rowMean += G[row + x]; rowMean /= LW / 4;
    for (let x = k; x < LW - k; x++) {
      const c = G[row + x], l = G[row + x - k], r = G[row + x + k];
      const v = 2 * c - l - r - Math.abs(l - r);
      if (v > thr && c > rowMean + 12 && c > 80) feats.push(x, y, Math.min(v, 200));
    }
  }
  // --- Hough for the two ego lines (independent of calibration) ---
  accL.fill(0); accR.fill(0);
  for (let i = 0; i < feats.length; i += 3) {
    const x = feats[i], dy = yB - feats[i + 1], w = feats[i + 2];
    for (let p = 0; p < PHIS.length; p++) {
      const o = dy * PHIS[p];
      const bl = Math.round((x - o - XMIN) / BIN), br = Math.round((x + o - XMIN) / BIN);
      if (bl >= 0 && bl < NB) accL[p * NB + bl] += w;
      if (br >= 0 && br < NB) accR[p * NB + br] += w;
    }
  }
  const rows = Math.max(1, yB - yT);
  const cx = cal.vpx;
  const peak = (acc, lo, hi, sign) => {
    let best = 0, bp = -1, bb = -1;
    const b0 = Math.max(1, Math.round((lo - XMIN) / BIN)), b1 = Math.min(NB - 2, Math.round((hi - XMIN) / BIN));
    for (let p = 0; p < PHIS.length; p++) for (let b = b0; b <= b1; b++) {
      const v = acc[p * NB + b] + 0.5 * (acc[p * NB + b - 1] + acc[p * NB + b + 1]);
      if (v > best) { best = v; bp = p; bb = b; }
    }
    const score = best / rows / 160;
    if (bp < 0 || score < 0.3) return null;
    return { xb: bb * BIN + XMIN, t: sign * PHIS[bp], score };
  };
  let detL = peak(accL, -LW * 0.7, cx, 1);
  let detR = peak(accR, cx, LW * 1.7, -1);
  if (detL && detR) {
    const xTopL = detL.xb + detL.t * rows, xTopR = detR.xb + detR.t * rows;
    if (xTopL > xTopR + LW * 0.04) { if (detL.score < detR.score) detL = null; else detR = null; }
  }
  track(lane.L, detL); track(lane.R, detR);
  calibrate(yB);
  multiLane(yB);
}
function track(s, det){
  const close = (a, b) => Math.abs(a.xb - b.xb) < LW * 0.1 && Math.abs(Math.atan(a.t) - Math.atan(b.t)) < 0.18;
  if (det) {
    if (!s.line) {
      s.cand = s.cand && close(s.cand, det) ? { ...det, n: s.cand.n + 1 } : { ...det, n: 1 };
      s.lost = 0;
      if (s.cand.n >= 3) s.line = { xb: det.xb, t: det.t };
    } else if (close(s.line, det)) {
      s.line.xb += (det.xb - s.line.xb) * 0.35; s.line.t += (det.t - s.line.t) * 0.35; s.lost = 0; s.jump = 0;
    } else if (++s.jump >= 4) { s.line = { xb: det.xb, t: det.t }; s.jump = 0; s.lost = 0; }
    else s.lost++;
  } else s.lost++;
  if (s.lost > 12) { s.line = null; s.cand = null; }
}
function calibrate(yB){
  const L = lane.L.line, R = lane.R.line;
  if (!L || !R || !P.auto) return;
  const dd = L.t - R.t; if (dd < 0.05) return;
  const d = (R.xb - L.xb) / dd;                 // distance above yB where the lines meet
  const vy = yB - d, vx = L.xb + L.t * d;
  if (vy < LH * 0.15 || vy > LH * 0.85 || vx < -LW * 0.2 || vx > LW * 1.2) return;
  const a = cal.n < 60 ? 0.12 : 0.02;          // fast at first, then slow and steady
  cal.vpy += (vy - cal.vpy) * a; cal.vpx += (vx - cal.vpx) * a;
  // camera height from the known lane width
  const wPx = R.xb - L.xb, dyB = yB - cal.vpy;
  if (dyB > 5 && wPx > 10) {
    const h = LANE_W() * dyB / wPx;
    if (h > 0.4 && h < 3) cal.camH += (h - cal.camH) * (cal.n < 60 ? 0.1 : 0.015);
  }
  cal.n++; cal.conf = Math.min(1, cal.n / 90);
}
function multiLane(yB){
  // project every paint pixel onto the road plane (lateral X, metres) and build a histogram
  hist.forEach((v, i) => hist[i] = v * 0.88);
  const f = fpx(), h = cal.camH;
  for (let i = 0; i < feats.length; i += 3) {
    const dy = feats[i + 1] - cal.vpy; if (dy < 2) continue;
    const Z = f * h / dy; if (Z > 28) continue;
    const X = (feats[i] - cal.vpx) * h / dy;
    const b = Math.round((X - HX0) / HB); if (b >= 0 && b < HN) hist[b] += feats[i + 2];
  }
  let mx = 0; for (let i = 0; i < HN; i++) if (hist[i] > mx) mx = hist[i];
  const marks = [];
  if (mx > 1500) {
    for (let i = 2; i < HN - 2; i++) {
      const v = hist[i] + 0.6 * (hist[i - 1] + hist[i + 1]);
      if (v < mx * 0.22) continue;
      let isMax = true; for (let j = -6; j <= 6; j++) if (j && i + j >= 0 && i + j < HN && hist[i + j] > hist[i]) { isMax = false; break; }
      if (isMax) marks.push(HX0 + i * HB);
    }
  }
  // ego boundaries from the Hough lines (more reliable), converted to metres
  const toX = ln => ln ? (ln.xb - cal.vpx) * h / Math.max(1, yB - cal.vpy) : null;
  const xl = toX(lane.L.line), xr = toX(lane.R.line), lw = LANE_W();
  let egoL = xl, egoR = xr;
  if (egoL === null && egoR !== null) egoL = egoR - lw;
  if (egoR === null && egoL !== null) egoR = egoL + lw;
  lane.egoL = egoL; lane.egoR = egoR;
  // chain markings outward from the ego lane at lane-width spacing
  let nl = 0, nr = 0;
  if (egoL !== null) {
    const sorted = marks.slice().sort((a, b) => a - b);
    let cur = egoL;
    while (true) { const nx = sorted.filter(m => m < cur - lw * 0.7 && m > cur - lw * 1.35).pop(); if (nx === undefined) break; nl++; cur = nx; if (nl > 4) break; }
    cur = egoR;
    while (true) { const nx = sorted.find(m => m > cur + lw * 0.7 && m < cur + lw * 1.35); if (nx === undefined) break; nr++; cur = nx; if (nr > 4) break; }
  }
  lane.marks = marks;
  // smooth the lane count over time (majority of last ~1.5 s)
  if (egoL !== null) { lane.laneHist.push(nl * 10 + nr); if (lane.laneHist.length > 45) lane.laneHist.shift(); }
  if (lane.laneHist.length > 10) {
    const cnt = {}; let best = null, bc = 0;
    for (const v of lane.laneHist) { cnt[v] = (cnt[v] || 0) + 1; if (cnt[v] > bc) { bc = cnt[v]; best = v; } }
    const l = Math.floor(best / 10), r = best % 10;
    lane.nLeft = l; lane.nRight = r; lane.nLanes = 1 + l + r; lane.egoIdx = l + 1;
  }
  if (egoL === null && lane.laneHist.length) lane.laneHist.shift();
  if (!lane.laneHist.length) { lane.nLanes = null; lane.egoIdx = null; }
}
function laneLogic(){
  const L = lane.L.line, R = lane.R.line;
  let off = null;
  if (lane.egoL !== null && lane.egoR !== null) {
    const w = lane.egoR - lane.egoL;
    const carX = -P.camOff * 2;   // vehicle centre relative to the phone (setting)
    if (w > 1.5 && w < 7) { lane.width = lane.width ? lane.width * 0.95 + w * 0.05 : w; off = (carX - (lane.egoL + lane.egoR) / 2) / w; }
  }
  lane.offset = off;
  if (off !== null && Math.abs(off) > P.dep) lane.depFrames++; else lane.depFrames = Math.max(0, lane.depFrames - 2);
  if (lane.depFrames >= 6) {
    const side = off < 0 ? 'L' : 'R';
    const busy = vtracks.some(t => t.ok && t.lane === (side === 'L' ? -1 : 1) && t.Z < 14);
    if (busy) alertUser('lane-busy-' + side, side === 'L' ? '🚨 Chapda mashina bor!' : "🚨 O'ngda mashina bor!", 'crit', 2500, side === 'L' ? 'Chapda mashina' : "O'ngda mashina");
    else if (side === 'L') alertUser('lane-left', '⚠️ Chap chiziqqa yaqinlashdingiz', 'bad', 3500, 'Chap chiziq');
    else alertUser('lane-right', "⚠️ O'ng chiziqqa yaqinlashdingiz", 'bad', 3500, "O'ng chiziq");
  }
  $('sOff').textContent = off === null ? '—' : (Math.abs(off) > P.dep ? (off < 0 ? '← chapda' : "o'ngda →") : 'markazda ✓');
  $('sLanes').textContent = lane.nLanes ? `${lane.nLanes} ta · siz ${lane.egoIdx}-da` : (L || R ? 'aniqlanmoqda…' : '—');
  $('sCal').textContent = P.auto ? (cal.conf >= 1 ? `✓ h=${cal.camH.toFixed(2)} m` : `${Math.round(cal.conf * 100)}%`) : "qo'lda";
}

// ===================================================================
// Vehicle detection (COCO-SSD, bundled locally) + tracking + distance
// ===================================================================
let model = null, modelState = 'off', detBusy = false, detMs = 0, detCount = 0, lastDetStart = 0;
function loadScript(src){ return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); }); }
async function loadModel(){
  if (model || modelState === 'loading') return;
  modelState = 'loading';
  try {
    if (!window.tf) await loadScript('lib/tf.min.js');
    if (!window.cocoSsd) await loadScript('lib/coco-ssd.min.js');
    try { await tf.setBackend('webgl'); } catch (e) { await tf.setBackend('cpu'); }
    await tf.ready();
    model = await cocoSsd.load({ base: 'mobilenet_v2', modelUrl: 'models/coco-ssd/model.json' });
    modelState = 'ready';
  } catch (e) { modelState = 'error'; console.error(e); showMsg("AI modelini yuklab bo'lmadi: mashinalarni aniqlash o'chirildi. Chiziq va belgilar ishlayveradi."); }
}
function runDetector(src){
  if (!model || detBusy || !P.ai) return;
  const t0 = performance.now();
  // leave time for lane/sign processing on slower phones
  if (t0 - lastDetStart < Math.max(90, detMs * 1.6)) return;
  lastDetStart = t0; detBusy = true;
  model.detect(src, 20, 0.38).then(r => {
    detMs = detMs ? detMs * 0.8 + (performance.now() - t0) * 0.2 : performance.now() - t0; detBusy = false; detCount++;
    onDetections(r.map(o => ({ cls: o.class, x: o.bbox[0], y: o.bbox[1], w: o.bbox[2], h: o.bbox[3], score: o.score })), performance.now(), src);
  }).catch(() => { detBusy = false; });
}
const VEH = { car: 1.8, truck: 2.5, bus: 2.55, motorcycle: 0.8, bicycle: 0.6, person: 0.5 };
const VLEN = { car: 4.6, truck: 9, bus: 12, motorcycle: 2.1, bicycle: 1.8, person: 0.6 };
const VNAME = { car: 'mashina', truck: 'yuk mashinasi', bus: 'avtobus', motorcycle: 'mototsikl', bicycle: 'velosiped', person: 'piyoda' };
let vtracks = [], vid = 1, lights = [];
function geom(d){
  const f = fpx();
  const xc = (d.x + d.w / 2) * LW / srcW, yb = (d.y + d.h) * LH / srcH, wpx = d.w * LW / srcW;
  let Zg = null, Zw = null;
  const dy = yb - cal.vpy;
  if (dy > 1.5 && (d.y + d.h) < srcH * 0.985) Zg = f * cal.camH / dy;
  if (VEH[d.cls] && wpx > 2 && d.x > 2 && d.x + d.w < srcW - 2) Zw = f * VEH[d.cls] / wpx;  // width only if not cut by the frame edge
  let Z = Zg && Zw ? (Zg * 0.55 + Zw * 0.45) : (Zg || Zw);
  if (!Z) return null;
  Z = Math.min(150, Math.max(1.5, Z));
  const X = (xc - cal.vpx) * Z / f;
  return { X, Z };
}
function iou(a, b){
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (a.w * a.h + b.w * b.h - i + 1e-6);
}
function laneOfX(X){
  const lw = lane.width || LANE_W();
  const L = lane.egoL !== null ? lane.egoL : -lw / 2, R = lane.egoR !== null ? lane.egoR : lw / 2;
  if (X >= L - 0.15 && X <= R + 0.15) return 0;
  return X < L ? -Math.ceil((L - X) / lw) : Math.ceil((X - R) / lw);
}
function onDetections(dets, now, src){
  const veh = dets.filter(d => VEH[d.cls] && d.w > 6 && d.h > 6);
  // traffic lights and stop signs feed the other subsystems
  lights = dets.filter(d => d.cls === 'traffic light' && d.h > 10).map(d => ({ ...d, state: lightState(src, d) }));
  for (const d of dets) if (d.cls === 'stop sign') signCandsExtra.push({ kind: 'stop', cx: (d.x + d.w / 2) / srcW, cy: (d.y + d.h / 2) / srcH, w: d.w / srcW, h: d.h / srcH });
  const used = new Set();
  const pairs = [];
  vtracks.forEach((t, i) => veh.forEach((d, j) => { const v = iou(t.box, d); if (v > 0.2) pairs.push([v, i, j]); }));
  pairs.sort((a, b) => b[0] - a[0]);
  const tUsed = new Set();
  for (const [, i, j] of pairs) {
    if (tUsed.has(i) || used.has(j)) continue; tUsed.add(i); used.add(j);
    const t = vtracks[i], d = veh[j];
    for (const k of ['x', 'y', 'w', 'h']) t.box[k] += (d[k] - t.box[k]) * 0.6;
    t.cls = d.cls; t.hits++; t.miss = 0;
    const g = geom(t.box);
    if (g) {
      const dt = Math.max(0.03, (now - t.t) / 1000);
      const Znew = t.Z ? t.Z + (g.Z - t.Z) * 0.45 : g.Z;
      const vz = (Znew - t.Z) / dt;
      if (t.Z) t.vz = t.vz === null ? vz : t.vz * 0.75 + vz * 0.25;
      t.Z = Znew; t.X = t.X === null ? g.X : t.X + (g.X - t.X) * 0.5; t.t = now;
    }
  }
  vtracks.forEach((t, i) => { if (!tUsed.has(i)) t.miss++; });
  vtracks = vtracks.filter(t => t.miss <= 4);
  veh.forEach((d, j) => {
    if (used.has(j)) return;
    const g = geom(d);
    vtracks.push({ id: vid++, cls: d.cls, box: { x: d.x, y: d.y, w: d.w, h: d.h }, Z: g ? g.Z : null, X: g ? g.X : null, vz: null, t: now, hits: 1, miss: 0 });
  });
  for (const t of vtracks) { t.ok = t.hits >= 2 && t.Z !== null; t.lane = t.X !== null ? laneOfX(t.X) : null; }
  vehicleLogic();
}
function lightState(src, d){
  try {
    cctx.drawImage(src, d.x, d.y, d.w, d.h, 0, 0, 24, 48);
    const p = cctx.getImageData(0, 0, 24, 48).data; let r = 0, g = 0, y = 0;
    for (let i = 0; i < p.length; i += 4) {
      const R = p[i], Gg = p[i + 1], B = p[i + 2], mx = Math.max(R, Gg, B);
      if (mx < 140) continue;
      if (R > 150 && R > Gg * 1.6 && R > B * 1.6) r++;
      else if (R > 150 && Gg > 110 && B < Gg * 0.6 && R >= Gg) y++;
      else if (Gg > 140 && Gg > R * 1.25 && B > R) g++;
    }
    const n = 24 * 48 * 0.03;
    if (r > n && r >= g && r >= y) return 'red'; if (g > n && g > y) return 'green'; if (y > n) return 'yellow';
  } catch (e) {}
  return null;
}
let lead = null, lastLightState = null, lightStable = 0;
function vehicleLogic(){
  const ok = vtracks.filter(t => t.ok);
  lead = ok.filter(t => t.lane === 0 && VEH[t.cls] && t.cls !== 'person').sort((a, b) => a.Z - b.Z)[0] || null;
  const ego = egoKmh();
  if (lead) {
    const closing = lead.vz !== null && lead.vz < -0.4 ? -lead.vz : 0;
    const ttc = closing > 0 ? lead.Z / closing : null;
    lead.ttc = ttc;
    $('sLead').textContent = fmtDist(lead.Z) + (ttc && ttc < 9 ? ` · ${ttc.toFixed(1)} s` : '');
    if (ttc && ttc < P.ttc && lead.Z < 50) alertUser('fcw', '🛑 OLDINDA MASHINA — TORMOZ!', 'crit', 2500, 'Tormoz');
    else if (ego && ego > 25 && lead.Z / (ego / 3.6) < 0.9) alertUser('tailgate', '⚠️ Masofa juda yaqin', 'bad', 7000, 'Masofani saqlang');
  } else $('sLead').textContent = '—';
  const nearL = ok.filter(t => t.lane === -1 && t.Z < 25).length, nearR = ok.filter(t => t.lane === 1 && t.Z < 25).length;
  $('sSide').textContent = `← ${nearL}  ·  ${nearR} →`;
  const ped = ok.find(t => t.cls === 'person' && t.lane === 0 && t.Z < 25);
  if (ped) alertUser('ped', '🚶 Oldinda piyoda!', 'crit', 4000, 'Diqqat, piyoda');
  // traffic light: biggest one in view
  const L = lights.slice().sort((a, b) => b.h - a.h)[0];
  const st = L ? L.state : null;
  if (st === lastLightState) lightStable++; else { lightStable = 0; }
  if (lightStable === 3 && st) {
    if (st === 'red') alertUser('light-red', '🔴 Qizil chiroq', 'bad', 8000, 'Qizil chiroq');
    if (st === 'green' && prevStableLight === 'red') alertUser('light-green', '🟢 Yashil chiroq — yuring', 'chime', 5000, 'Yashil');
    prevStableLight = st;
  }
  lastLightState = st;
}
let prevStableLight = null;

// ===================================================================
// Sign detection (colour + shape + digit templates)
// ===================================================================
const SW = 640; let SH = 360;
const sc = document.createElement('canvas'); const sctx = sc.getContext('2d', { willReadFrequently: true });
let redM, whM, yeM, darkM, tmpM, labA;
const crop = document.createElement('canvas'); crop.width = 96; crop.height = 120;
const cctx = crop.getContext('2d', { willReadFrequently: true });
let signTracks = [], frameNo = 0, curLimit = null, signCandsExtra = [];

function dilate(src, dst, w, h){
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let dy = -1; dy <= 1 && !v; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && src[yy * w + xx]) { v = 1; break; } } }
    dst[y * w + x] = v;
  }
}
function blobs(mask, w, h, yMax){
  labA.fill(0); const out = [], st = []; let L = 0;
  for (let i = 0; i < w * yMax; i++) {
    if (!mask[i] || labA[i]) continue;
    L++; let n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0; st.push(i); labA[i] = L;
    while (st.length) {
      const j = st.pop(), x = j % w, y = (j / w) | 0; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[j - 1] && !labA[j - 1]) { labA[j - 1] = L; st.push(j - 1); }
      if (x < w - 1 && mask[j + 1] && !labA[j + 1]) { labA[j + 1] = L; st.push(j + 1); }
      if (y > 0 && mask[j - w] && !labA[j - w]) { labA[j - w] = L; st.push(j - w); }
      if (y < h - 1 && mask[j + w] && !labA[j + w]) { labA[j + w] = L; st.push(j + w); }
    }
    out.push({ x0, y0, x1, y1, n, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return out;
}
function frac(m, b, fx0, fy0, fx1, fy1){
  const X0 = Math.floor(b.x0 + fx0 * b.w), X1 = Math.max(X0 + 1, Math.ceil(b.x0 + fx1 * b.w));
  const Y0 = Math.floor(b.y0 + fy0 * b.h), Y1 = Math.max(Y0 + 1, Math.ceil(b.y0 + fy1 * b.h));
  let s = 0, n = 0;
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { s += m[y * SW + x]; n++; }
  return n ? s / n : 0;
}
function classifyRed(m, raw, b){
  const ar = b.w / b.h;
  if (ar < 0.6 || ar > 1.6) return null;
  const c = 0.16;
  const TL = frac(m, b, 0, 0, c, c), TR = frac(m, b, 1 - c, 0, 1, c), BL = frac(m, b, 0, 1 - c, c, 1), BR = frac(m, b, 1 - c, 1 - c, 1, 1);
  const fill = frac(m, b, 0, 0, 1, 1);
  const topMid = frac(m, b, 0.4, 0, 0.6, 0.18), botMid = frac(m, b, 0.4, 0.82, 0.6, 1);
  const ringEdge = (frac(m, b, 0, 0.4, 0.12, 0.6) + frac(m, b, 0.88, 0.4, 1, 0.6) + topMid + botMid) / 4;
  const center = frac(raw, b, 0.36, 0.36, 0.64, 0.64);
  const band = frac(raw, b, 0.28, 0.45, 0.72, 0.55);
  const above = frac(raw, b, 0.35, 0.2, 0.65, 0.32), below = frac(raw, b, 0.35, 0.68, 0.65, 0.8);
  const cornersEmpty = TL < 0.22 && TR < 0.22 && BL < 0.22 && BR < 0.22;
  if (cornersEmpty && ringEdge > 0.55) {
    if (center < 0.15 && above < 0.5 && below < 0.5) return US() ? null : 'ring';
    if (band < 0.35 && above > 0.6 && below > 0.6) return 'noentry';
    if (fill > 0.6 && center > 0.3) return 'stop';
    return null;
  }
  if (fill > 0.8) return null;
  if (!US() && TL < 0.15 && TR < 0.15 && BL > 0.35 && BR > 0.35 && topMid > 0.25 && botMid > 0.5) return 'warn';
  if (BL < 0.15 && BR < 0.15 && TL > 0.35 && TR > 0.35 && botMid > 0.25 && topMid > 0.5) return 'yield';
  return null;
}
function classifyDiamond(m, b){
  const ar = b.w / b.h; if (ar < 0.75 || ar > 1.35) return false;
  const c = 0.18;
  const corners = [frac(m, b, 0, 0, c, c), frac(m, b, 1 - c, 0, 1, c), frac(m, b, 0, 1 - c, c, 1), frac(m, b, 1 - c, 1 - c, 1, 1)];
  const mids = [frac(m, b, 0, 0.42, 0.12, 0.58), frac(m, b, 0.88, 0.42, 1, 0.58), frac(m, b, 0.42, 0, 0.58, 0.12), frac(m, b, 0.42, 0.88, 0.58, 1)];
  const fill = frac(m, b, 0, 0, 1, 1);
  return corners.every(v => v < 0.2) && mids.every(v => v > 0.4) && fill > 0.3 && fill < 0.75;
}
function classifyUsLimit(b){
  // white portrait rectangle with dark text
  const ar = b.w / b.h; if (ar < 0.6 || ar > 0.95) return false;
  const fillW = frac(whM, b, 0, 0, 1, 1), dark = frac(darkM, b, 0.08, 0.08, 0.92, 0.92);
  const corners = Math.min(frac(whM, b, 0, 0, 0.12, 0.12), frac(whM, b, 0.88, 0, 1, 0.12), frac(whM, b, 0, 0.88, 0.12, 1), frac(whM, b, 0.88, 0.88, 1, 1));
  const lower = frac(darkM, b, 0.1, 0.5, 0.9, 0.92);
  return fillW > 0.5 && dark > 0.05 && dark < 0.45 && corners > 0.3 && lower > 0.08;
}
function detectSigns(src){
  sctx.drawImage(src, 0, 0, SW, SH);
  const d = sctx.getImageData(0, 0, SW, SH).data;
  const yMax = Math.round(SH * Math.min(0.85, cal.vpy / LH + 0.15));
  const us = US();
  for (let i = 0; i < SW * SH; i++) {
    if (i >= SW * yMax) { redM[i] = whM[i] = yeM[i] = darkM[i] = 0; continue; }
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    redM[i] = (r > 70 && r - Math.max(g, b) > 0.38 * r) ? 1 : 0;
    if (us) {
      whM[i] = (mn > 160 && mx - mn < 32) ? 1 : 0;
      yeM[i] = (r > 150 && g > 120 && b < 0.55 * g && r - b > 90) ? 1 : 0;
      darkM[i] = mx < 85 ? 1 : 0;
    }
  }
  const cands = [];
  const push = (kind, b, val) => cands.push({ kind, val: val || null, cx: (b.x0 + b.w / 2) / SW, cy: (b.y0 + b.h / 2) / SH, w: b.w / SW, h: b.h / SH });
  dilate(redM, tmpM, SW, SH);
  for (const b of blobs(tmpM, SW, SH, yMax)) {
    if (b.w < 10 || b.h < 10 || b.w > SW * 0.3 || b.h > SH * 0.4 || b.n < 30) continue;
    const kind = classifyRed(tmpM, redM, b); if (!kind) continue;
    if (kind === 'ring') { const c = { cx: (b.x0 + b.w / 2) / SW, cy: (b.y0 + b.h / 2) / SH, w: b.w / SW, h: b.h / SH }; const v = readEuNumber(src, c); push(v ? 'speed' : 'ring', b, v); }
    else push(kind, b);
  }
  if (us) {
    for (const b of blobs(whM, SW, SH, yMax)) {
      if (b.w < 9 || b.h < 12 || b.w > SW * 0.25 || b.h > SH * 0.4 || b.n < 40) continue;
      if (!classifyUsLimit(b)) continue;
      const c = { cx: (b.x0 + b.w / 2) / SW, cy: (b.y0 + b.h / 2) / SH, w: b.w / SW, h: b.h / SH };
      const v = readUsNumber(src, c); if (v) push('speed', b, v);
    }
    dilate(yeM, tmpM, SW, SH);
    for (const b of blobs(tmpM, SW, SH, yMax)) {
      if (b.w < 12 || b.h < 12 || b.w > SW * 0.3 || b.n < 40) continue;
      if (classifyDiamond(tmpM, b)) push('warn', b);
    }
  }
  return cands.concat(signCandsExtra.splice(0));
}

// digit templates rendered at runtime
const TW = 10, TH = 16; let TPL = null;
function norm(grid){ let m = 0; for (const v of grid) m += v; m /= grid.length; let s = 0; const o = grid.map(v => { const z = v - m; s += z * z; return z; }); s = Math.sqrt(s) || 1; return o.map(v => v / s); }
function sample(mask, w, x0, y0, x1, y1){
  const g = new Array(TW * TH), bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  for (let ty = 0; ty < TH; ty++) for (let tx = 0; tx < TW; tx++) {
    const sx0 = x0 + Math.floor(tx * bw / TW), sx1 = x0 + Math.max(Math.floor(tx * bw / TW) + 1, Math.floor((tx + 1) * bw / TW));
    const sy0 = y0 + Math.floor(ty * bh / TH), sy1 = y0 + Math.max(Math.floor(ty * bh / TH) + 1, Math.floor((ty + 1) * bh / TH));
    let s = 0, n = 0; for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) { s += mask[y * w + x]; n++; }
    g[ty * TW + tx] = n ? s / n : 0;
  }
  return norm(g);
}
function buildTemplates(){
  const c = document.createElement('canvas'); c.width = 90; c.height = 120; const x = c.getContext('2d', { willReadFrequently: true });
  TPL = [];
  const fonts = ['bold 100px Arial, Helvetica, sans-serif', 'bold 100px "Arial Narrow", "Roboto Condensed", sans-serif', 'bold 100px "DejaVu Sans", Verdana, sans-serif', '500 100px "Roboto Condensed", "Arial Narrow", sans-serif'];
  for (const font of fonts) for (let dg = 0; dg <= 9; dg++) {
    x.fillStyle = '#fff'; x.fillRect(0, 0, 90, 120); x.fillStyle = '#000'; x.font = font; x.textBaseline = 'middle'; x.textAlign = 'center';
    x.fillText(String(dg), 45, 62);
    const dd = x.getImageData(0, 0, 90, 120).data, m = new Uint8Array(90 * 120);
    let x0 = 90, y0 = 120, x1 = 0, y1 = 0;
    for (let i = 0; i < m.length; i++) if (dd[i * 4] < 128) { m[i] = 1; const px = i % 90, py = (i / 90) | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    TPL.push({ d: dg, g: sample(m, 90, x0, y0, x1, y1), ar: (x1 - x0 + 1) / (y1 - y0 + 1) });
  }
}
// generic digit reader on the crop canvas; inside(x,y) limits the area, hMin/hMax relative to crop height
function readDigits(CW, CH, inside, hMin, hMax, valid){
  const d = cctx.getImageData(0, 0, CW, CH).data;
  const g = new Float32Array(CW * CH); let mn = 255, mx = 0;
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const i = y * CW + x, v = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114; g[i] = v;
    if (inside(x, y)) { if (v < mn) mn = v; if (v > mx) mx = v; }
  }
  if (mx - mn < 55) return null;
  const th = (mn + mx) / 2, m = new Uint8Array(CW * CH);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) { const i = y * CW + x; m[i] = (inside(x, y) && g[i] < th && d[i * 4] - Math.max(d[i * 4 + 1], d[i * 4 + 2]) < 60) ? 1 : 0; }
  const L = new Int32Array(CW * CH), st = []; let comps = [], n = 0;
  for (let i = 0; i < CW * CH; i++) {
    if (!m[i] || L[i]) continue; n++; let x0 = CW, y0 = CH, x1 = 0, y1 = 0, cnt = 0; st.push(i); L[i] = n;
    while (st.length) { const j = st.pop(), x = j % CW, y = (j / CW) | 0; cnt++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && m[j - 1] && !L[j - 1]) { L[j - 1] = n; st.push(j - 1); }
      if (x < CW - 1 && m[j + 1] && !L[j + 1]) { L[j + 1] = n; st.push(j + 1); }
      if (y > 0 && m[j - CW] && !L[j - CW]) { L[j - CW] = n; st.push(j - CW); }
      if (y < CH - 1 && m[j + CW] && !L[j + CW]) { L[j + CW] = n; st.push(j + CW); } }
    const h = y1 - y0 + 1, w = x1 - x0 + 1;
    if (h > CH * hMin && h < CH * hMax && w < CW * 0.5 && cnt > 10) comps.push({ x0, y0, x1, y1, h, w });
  }
  // split touching digits at the thinnest column
  for (let i = comps.length - 1; i >= 0; i--) {
    const cp = comps[i]; if (cp.w / cp.h < 0.8) continue;
    let bx = -1, bs = 1e9;
    for (let x = cp.x0 + Math.round(cp.w * 0.3); x <= cp.x0 + Math.round(cp.w * 0.7); x++) { let s = 0; for (let y = cp.y0; y <= cp.y1; y++) s += m[y * CW + x]; if (s < bs) { bs = s; bx = x; } }
    const part = (x0, x1) => { let y0 = CH, y1 = 0; for (let y = cp.y0; y <= cp.y1; y++) for (let x = x0; x <= x1; x++) if (m[y * CW + x]) { if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 }; };
    comps.splice(i, 1, part(cp.x0, bx - 1), part(bx + 1, cp.x1));
  }
  if (comps.length < 1) return null;
  // keep the tallest group of similar-height components (the number)
  const hMax2 = Math.max(...comps.map(c => c.h));
  comps = comps.filter(c => c.h > hMax2 * 0.7);
  if (comps.length > 3) return null;
  comps.sort((a, b) => a.x0 - b.x0);
  let str = '', total = 0;
  for (const cp of comps) {
    const gr = sample(m, CW, cp.x0, cp.y0, cp.x1, cp.y1), ar = cp.w / cp.h;
    let best = -2, bd = null;
    for (const t of TPL) { let s = 0; for (let i = 0; i < gr.length; i++) s += gr[i] * t.g[i]; s -= Math.abs(ar - t.ar) * 0.6; if (s > best) { best = s; bd = t.d; } }
    if (ar < 0.36) { bd = 1; best = Math.max(best, 0.7); }
    str += bd; total += best;
  }
  const val = parseInt(str, 10);
  if (total / comps.length < 0.55 || !valid.has(val)) return null;
  return val;
}
const VALID_EU = new Set([5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130]);
const VALID_US = new Set([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85]);
function readEuNumber(src, c){
  const sw = c.w * srcW; if (sw < 22) return null;
  cctx.drawImage(src, (c.cx - c.w / 2) * srcW, (c.cy - c.h / 2) * srcH, sw, c.h * srcH, 0, 0, 96, 96);
  const R2 = (96 * 0.37) ** 2;
  return readDigits(96, 96, (x, y) => (x - 48) ** 2 + (y - 48) ** 2 < R2, 0.22, 0.7, VALID_EU);
}
function readUsNumber(src, c){
  const sw = c.w * srcW; if (sw < 18) return null;
  // number occupies the lower ~half of a US SPEED LIMIT sign
  cctx.drawImage(src, (c.cx - c.w / 2) * srcW, (c.cy - c.h / 2) * srcH, sw, c.h * srcH, 0, 0, 80, 100);
  return readDigits(80, 100, (x, y) => x > 6 && x < 74 && y > 44 && y < 94, 0.2, 0.52, VALID_US);
}

const NAMES = { stop: 'STOP — to\'xtang', yield: "Yo'l bering", noentry: 'Kirish taqiqlangan', warn: 'Ogohlantiruvchi belgi', ring: 'Taqiqlovchi belgi' };
const SPOKEN = { stop: "To'xtang. Stop belgisi", yield: "Yo'l bering", noentry: 'Kirish taqiqlangan', warn: 'Diqqat. Ogohlantiruvchi belgi' };
function updateLimitStat(){ $('sLimit').textContent = curLimit ? curLimit + ' ' + SPEED_UNIT() : '—'; }
function updateSignTracks(cands){
  frameNo++;
  for (const c of cands) {
    let best = null, bd = 1e9;
    for (const t of signTracks) {
      const fam = k => (k === 'ring' || k === 'speed') ? 'num' : k;
      if (fam(t.kind) !== fam(c.kind)) continue;
      const dd = Math.hypot(c.cx - t.cx, c.cy - t.cy);
      if (dd < 0.06 + t.w * 1.5 && dd < bd) { bd = dd; best = t; }
    }
    if (!best) { best = { kind: c.kind, cx: c.cx, cy: c.cy, w: c.w, h: c.h, seen: 0, votes: {}, announced: false, last: frameNo }; signTracks.push(best); }
    Object.assign(best, { cx: c.cx, cy: c.cy, w: c.w, h: c.h, last: frameNo }); best.seen++;
    if (c.kind === 'speed') { best.votes[c.val] = (best.votes[c.val] || 0) + 1; best.kind = 'speed'; }
  }
  signTracks = signTracks.filter(t => frameNo - t.last < 10);
  for (const t of signTracks) {
    if (t.announced || t.seen < 3) continue;
    if (t.kind === 'speed' || t.kind === 'ring') {
      let bv = null, bc = 0; for (const v in t.votes) if (t.votes[v] > bc) { bc = t.votes[v]; bv = +v; }
      if (bv && bc >= 2) {
        t.val = bv; t.announced = true; curLimit = bv; updateLimitStat(); (window.__limits = window.__limits || []).push(bv);
        alertUser('speed-' + bv, `🚫 Tezlik cheklovi: ${bv} ${SPEED_UNIT()}`, 'info', 8000, `Tezlik cheklovi ${bv}`);
      }
    } else if (SPOKEN[t.kind]) {
      t.announced = true;
      alertUser('sign-' + t.kind, (t.kind === 'warn' ? '⚠️ ' : '🛑 ') + NAMES[t.kind], t.kind === 'warn' ? 'info' : 'bad', 6000, SPOKEN[t.kind]);
    }
  }
  const ego = egoKmh();
  if (curLimit && ego != null) {
    const v = US() ? ego / 1.609 : ego;
    if (v > curLimit + (US() ? 5 : 8)) alertUser('overspeed', `🐢 Tezlikni kamaytiring: ${Math.round(v)} > ${curLimit}`, 'bad', 10000, 'Tezlikni kamaytiring');
  }
}

// ===================================================================
// Demo road (synthetic): 3 lanes, traffic, signs; camera mounted LOW and tilted
// ===================================================================
const demoCan = document.createElement('canvas'); demoCan.width = 960; demoCan.height = 540;
const demo = (() => {
  let c = demoCan.getContext('2d');
  const W = 960, H = 540, f = (W / 2) / Math.tan(35 * Math.PI / 180), camH = 0.95, yh = H * 0.6;  // low, tilted-down phone
  let t = 0, travel = 0, carX = 0, signs = [], nextSign = 0, seq = 0, cars = [], speed = 22;
  const KINDS_US = [['us45', 45], ['stop'], ['diamond'], ['us65', 65], ['yield'], ['noentry'], ['us35', 35], ['us55', 55]];
  const KINDS_EU = [['speed', 60], ['stop'], ['warn'], ['speed', 90], ['yield'], ['noentry'], ['speed', 40], ['speed', 110]];
  const lw = () => LANE_W();
  function proj(X, Z, Y){ return [W / 2 + f * X / Z, yh + f * (camH - (Y || 0)) / Z]; }
  function curve(Z){ return 0.0006 * Math.sin(t * 0.12) * Z * Z; }
  function reset(){
    t = 0; travel = 0; carX = 0; signs = []; nextSign = 1.2; seq = 0;
    cars = [ { lane: 0, Z: 32, vrel: 0, kind: 'car', col: '#2b4c7e', brake: 0 }, { lane: -1, Z: 14, vrel: 1.5, kind: 'car', col: '#7a2b2b' },
             { lane: 1, Z: 22, vrel: -0.8, kind: 'truck', col: '#d9d9d9' }, { lane: 1, Z: 55, vrel: 0.3, kind: 'car', col: '#2e2e2e' } ];
  }
  function drawSign(s, x, y, r){
    c.fillStyle = '#777'; c.fillRect(x - r * 0.07, y, r * 0.14, f * 2.2 / s.Z);
    c.save(); c.translate(x, y);
    if (s.kind === 'speed' || s.kind === 'noentry') {
      c.fillStyle = s.kind === 'noentry' ? '#d0151b' : '#fff';
      c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill();
      c.lineWidth = r * 0.22; c.strokeStyle = '#d0151b'; c.beginPath(); c.arc(0, 0, r * 0.89, 0, Math.PI * 2); c.stroke();
      if (s.kind === 'speed') {
        const txt = String(s.val); c.fillStyle = '#111'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.font = `bold ${r * 0.95}px Arial, Helvetica, sans-serif`;
        c.save(); if (txt.length === 3) c.scale(0.78, 1); c.fillText(txt, 0, r * 0.05); c.restore();
      } else { c.fillStyle = '#fff'; c.fillRect(-r * 0.62, -r * 0.16, r * 1.24, r * 0.32); }
    } else if (s.kind.startsWith('us')) {
      const w = r * 1.6, h = r * 2.0;
      c.fillStyle = '#fff'; c.fillRect(-w / 2, -h / 2, w, h);
      c.strokeStyle = '#111'; c.lineWidth = r * 0.06; c.strokeRect(-w / 2 + r * 0.08, -h / 2 + r * 0.08, w - r * 0.16, h - r * 0.16);
      c.fillStyle = '#111'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = `bold ${r * 0.34}px Arial`; c.fillText('SPEED', 0, -h * 0.3); c.fillText('LIMIT', 0, -h * 0.13);
      c.font = `bold ${r * 0.88}px Arial`; c.save(); c.scale(0.85, 1); c.fillText(String(s.val), 0, h * 0.22); c.restore();
    } else if (s.kind === 'diamond') {
      c.rotate(Math.PI / 4); const a = r * 1.25;
      c.fillStyle = '#f4c20d'; c.fillRect(-a / 2, -a / 2, a, a);
      c.strokeStyle = '#111'; c.lineWidth = r * 0.07; c.strokeRect(-a / 2 + r * 0.08, -a / 2 + r * 0.08, a - r * 0.16, a - r * 0.16);
      c.rotate(-Math.PI / 4); c.fillStyle = '#111'; c.fillRect(-r * 0.08, -r * 0.45, r * 0.16, r * 0.9); c.beginPath(); c.moveTo(-r * 0.3, -r * 0.2); c.lineTo(0, -r * 0.55); c.lineTo(r * 0.3, -r * 0.2); c.fill();
    } else if (s.kind === 'stop') {
      c.fillStyle = '#d0151b'; c.beginPath();
      for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + i * Math.PI / 4; c.lineTo(Math.cos(a) * r, Math.sin(a) * r); } c.fill();
      c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `bold ${r * 0.52}px Arial`; c.fillText('STOP', 0, r * 0.03);
    } else if (s.kind === 'warn' || s.kind === 'yield') {
      const up = s.kind === 'warn' ? 1 : -1, h = r * 1.73;
      const tri = k => { c.beginPath(); c.moveTo(0, -up * h * 0.6 * k); c.lineTo(r * k, up * h * 0.4 * k); c.lineTo(-r * k, up * h * 0.4 * k); c.closePath(); };
      c.fillStyle = '#d0151b'; tri(1); c.fill(); c.fillStyle = '#fff'; tri(0.62); c.fill();
      if (s.kind === 'warn') { c.fillStyle = '#111'; c.fillRect(-r * 0.07, -r * 0.35, r * 0.14, r * 0.5); c.fillRect(-r * 0.07, r * 0.25, r * 0.14, r * 0.13); }
    }
    c.restore();
  }
  function drawCar(k, X, Z){
    const wM = k.kind === 'truck' ? 2.5 : 1.8, hM = k.kind === 'truck' ? 3.2 : 1.45;
    const [x, yb] = proj(X - wM / 2, Z), [x2] = proj(X + wM / 2, Z), [, yt] = proj(X, Z, hM);
    const w = x2 - x, h = yb - yt;
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(x - w * 0.05, yb - h * 0.04, w * 1.1, h * 0.08);
    c.fillStyle = k.col; c.fillRect(x, yt + h * (k.kind === 'truck' ? 0 : 0.12), w, h * (k.kind === 'truck' ? 0.92 : 0.8));
    if (k.kind !== 'truck') { c.fillStyle = '#1b2633'; c.fillRect(x + w * 0.12, yt + h * 0.16, w * 0.76, h * 0.26); }
    else { c.fillStyle = '#9a9a9a'; c.fillRect(x + w * 0.48, yt, w * 0.04, h * 0.9); }
    const brake = k.brake > 0;
    c.fillStyle = brake ? '#ff2a2a' : '#8a1c1c'; c.fillRect(x + w * 0.04, yt + h * 0.5, w * 0.16, h * 0.1); c.fillRect(x + w * 0.8, yt + h * 0.5, w * 0.16, h * 0.1);
    c.fillStyle = '#111'; c.fillRect(x + w * 0.08, yb - h * 0.1, w * 0.18, h * 0.1); c.fillRect(x + w * 0.74, yb - h * 0.1, w * 0.18, h * 0.1);
    return { x, y: yt, w, h };
  }
  function frame(){
    t += 1 / 30; travel += speed / 30;
    carX = 0.95 * Math.sin(t * 0.3) + 0.5 * Math.sin(t * 0.1 + 1);
    const LWm = lw();
    const sky = c.createLinearGradient(0, 0, 0, yh); sky.addColorStop(0, '#7fb2e0'); sky.addColorStop(1, '#d7e6f0');
    c.fillStyle = sky; c.fillRect(0, 0, W, yh);
    c.fillStyle = '#6f8a55'; c.fillRect(0, yh, W, H - yh);
    c.fillStyle = '#4f6a3c'; for (let i = 0; i < 14; i++) { const x = (i * 97 + 30) % W; c.beginPath(); c.arc(x, yh - 6, 18 + (i % 3) * 8, Math.PI, 0); c.fill(); }
    const Zs = []; for (let Z = 2.0; Z < 160; Z *= 1.04) Zs.push(Z);
    const edge = X => Zs.map(Z => proj(X + curve(Z) - carX, Z));
    const Ledge = edge(-1.5 * LWm - 1.2), Redge = edge(1.5 * LWm + 1.2);
    c.fillStyle = '#4a4c50'; c.beginPath(); Ledge.forEach(p => c.lineTo(p[0], p[1])); Redge.slice().reverse().forEach(p => c.lineTo(p[0], p[1])); c.fill();
    const paint = (X, dashed, col) => {
      c.fillStyle = col;
      for (let i = 0; i < Zs.length - 1; i++) {
        const Z0 = Zs[i], Z1 = Zs[i + 1];
        if (dashed && Math.floor((Z0 + travel) / 4.5) % 2) continue;
        const a = proj(X - 0.07 + curve(Z0) - carX, Z0), b = proj(X + 0.07 + curve(Z0) - carX, Z0);
        const cc = proj(X + 0.07 + curve(Z1) - carX, Z1), d = proj(X - 0.07 + curve(Z1) - carX, Z1);
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.lineTo(cc[0], cc[1]); c.lineTo(d[0], d[1]); c.fill();
      }
    };
    const us = US();
    paint(-1.5 * LWm, false, us ? '#e9c84a' : '#ececec'); paint(-0.5 * LWm, true, '#f0f0f0'); paint(0.5 * LWm, true, '#f0f0f0'); paint(1.5 * LWm, false, '#ececec');
    // traffic
    const dets = [];
    for (const k of cars) {
      if (k.lane === 0) {   // lead car: cycles between cruising and braking
        const ph = (t % 22);
        k.brake = ph > 12 && ph < 16 ? 1 : 0;
        k.vrel = ph < 12 ? (32 - k.Z) * 0.25 : ph < 16 ? -7 : (30 - k.Z) * 0.35;
      }
      k.Z += k.vrel / 30;
      if (k.Z > 90) k.Z = 6; if (k.Z < 5.5 && k.lane !== 0) k.Z = 80;
      k.Z = Math.max(5.2, k.Z);
    }
    for (const k of cars.slice().sort((a, b) => b.Z - a.Z)) {
      const X = k.lane * LWm + curve(k.Z) - carX;
      const bb = drawCar(k, X, k.Z);
      if (bb.x + bb.w > 0 && bb.x < W && bb.y < H) dets.push({ cls: k.kind, x: bb.x, y: bb.y, w: bb.w, h: bb.h, score: 0.9, trueZ: k.Z });
    }
    // signs
    if (t > nextSign) { const ks = us ? KINDS_US : KINDS_EU; const k = ks[seq++ % ks.length]; signs.push({ kind: k[0], val: k[1], Z: 80, X: 1.5 * LWm + 1.4 }); nextSign = t + 4.2; }
    for (const s of signs) s.Z -= speed / 30;
    signs = signs.filter(s => s.Z > 3);
    for (const s of signs.slice().sort((a, b) => b.Z - a.Z)) {
      const [x, y] = proj(s.X + curve(s.Z) - carX, s.Z, 2.3); drawSign(s, x, y, f * 0.36 / s.Z);
    }
    c.fillStyle = '#1d2329'; c.beginPath(); c.moveTo(0, H); c.lineTo(0, H * 0.965); c.quadraticCurveTo(W / 2, H * 0.93, W, H * 0.965); c.lineTo(W, H); c.fill();
    return dets;
  }
  return { reset, frame, drawOn(cv, s, x, y, r){ const o = c; c = cv.getContext('2d'); drawSign(s, x, y, r); c = o; }, get speedKmh(){ return speed * 3.6; }, truth: { camH, yh: yh / H } };
})();

// ===================================================================
// Rendering: camera view overlays
// ===================================================================
function drawLimitIcon(g, x, y, r, v){
  if (US()) {
    const w = r * 1.5, h = r * 1.9;
    g.fillStyle = '#fff'; g.fillRect(x - w / 2, y - h / 2, w, h); g.strokeStyle = '#111'; g.lineWidth = Math.max(1.5, r * 0.06); g.strokeRect(x - w / 2 + r * 0.08, y - h / 2 + r * 0.08, w - r * 0.16, h - r * 0.16);
    g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 ${r * 0.3}px Arial`; g.fillText('SPEED', x, y - h * 0.3); g.fillText('LIMIT', x, y - h * 0.13);
    g.font = `700 ${r * 0.85}px Arial`; g.fillText(v, x, y + h * 0.22);
  } else {
    g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.lineWidth = r * 0.2; g.strokeStyle = '#d0151b'; g.beginPath(); g.arc(x, y, r * 0.88, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#111'; g.font = `bold ${r * (String(v).length > 2 ? 0.72 : 0.9)}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(v, x, y + 1);
  }
  g.textAlign = 'start'; g.textBaseline = 'alphabetic';
}
function render(src){
  const W = view.width, H = view.height, kx = W / LW, ky = H / LH;
  ctx.drawImage(src, 0, 0, W, H);
  const { yT, yB } = roi;
  if (P.dbg) {
    ctx.fillStyle = 'rgba(0,255,200,.75)';
    for (let i = 0; i < feats.length; i += 3) ctx.fillRect(feats[i] * kx, feats[i + 1] * ky, kx, ky);
    ctx.strokeStyle = 'rgba(255,255,0,.8)'; ctx.setLineDash([8, 6]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, cal.vpy * ky); ctx.lineTo(W, cal.vpy * ky); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(cal.vpx * kx, cal.vpy * ky, 6, 0, Math.PI * 2); ctx.stroke();
  }
  // lane markings from the multi-lane model (thin), ego lane (filled)
  const lineAt = (X, Z) => groundToImage(X, Z);
  if (lane.egoL !== null && cal.conf > 0.3) {
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.setLineDash([10, 10]);
    for (const m of lane.marks) {
      if (Math.abs(m - lane.egoL) < 0.6 || Math.abs(m - lane.egoR) < 0.6) continue;
      const a = lineAt(m, 4), b = lineAt(m, 30);
      ctx.beginPath(); ctx.moveTo(a[0] * kx, Math.min(yB, a[1]) * ky); ctx.lineTo(b[0] * kx, b[1] * ky); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  const L = lane.L.line, R = lane.R.line, rows = yB - yT;
  const xAt = (ln, y) => (ln.xb + ln.t * (yB - y)) * kx;
  const warn = lane.depFrames >= 6;
  const yTop = yT + rows * 0.15;
  if (L && R) {
    const g = ctx.createLinearGradient(0, yB * ky, 0, yTop * ky);
    g.addColorStop(0, warn ? 'rgba(255,77,77,.35)' : 'rgba(61,170,255,.32)'); g.addColorStop(1, 'rgba(61,170,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(xAt(L, yB), yB * ky); ctx.lineTo(xAt(L, yTop), yTop * ky); ctx.lineTo(xAt(R, yTop), yTop * ky); ctx.lineTo(xAt(R, yB), yB * ky); ctx.fill();
  }
  ctx.lineWidth = Math.max(4, W / 170); ctx.lineCap = 'round';
  for (const ln of [L, R]) if (ln) {
    ctx.strokeStyle = warn ? '#ff4d4d' : '#3ddc97';
    ctx.beginPath(); ctx.moveTo(xAt(ln, yB), yB * ky); ctx.lineTo(xAt(ln, yTop), yTop * ky); ctx.stroke();
  }
  // vehicles
  const sx = W / srcW, sy = H / srcH;
  ctx.font = `600 ${Math.max(11, W / 75)}px system-ui`;
  for (const t of vtracks) {
    if (!t.ok) continue;
    const b = t.box, isLead = t === lead;
    const danger = isLead && t.ttc && t.ttc < P.ttc;
    ctx.strokeStyle = danger ? '#ff4d4d' : isLead ? '#ffb020' : (t.lane === 0 ? '#ffffff' : 'rgba(120,190,255,.9)');
    ctx.lineWidth = isLead ? 3 : 2;
    ctx.strokeRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    const label = `${fmtDist(t.Z)}${isLead && t.ttc && t.ttc < 9 ? ' · ' + t.ttc.toFixed(1) + 's' : ''}`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(b.x * sx, b.y * sy - 20, tw + 10, 19);
    ctx.fillStyle = ctx.strokeStyle; ctx.fillText(label, b.x * sx + 5, b.y * sy - 6);
  }
  for (const l of lights) if (l.state) {
    ctx.strokeStyle = l.state === 'red' ? '#ff4d4d' : l.state === 'green' ? '#3ddc97' : '#ffb020'; ctx.lineWidth = 2;
    ctx.strokeRect(l.x * sx, l.y * sy, l.w * sx, l.h * sy);
  }
  // signs
  for (const t of signTracks) {
    if (t.seen < 2) continue;
    const x = (t.cx - t.w / 2) * W, y = (t.cy - t.h / 2) * H, w = t.w * W, h = t.h * H;
    ctx.strokeStyle = t.announced ? '#ffb020' : 'rgba(255,255,255,.7)'; ctx.lineWidth = 2; ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
    const label = t.kind === 'speed' && t.val ? t.val + ' ' + SPEED_UNIT() : (NAMES[t.kind] || '');
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(x - 3, y - 24, tw + 10, 19); ctx.fillStyle = '#fff'; ctx.fillText(label, x + 2, y - 10);
  }
  // HUD
  if (curLimit) drawLimitIcon(ctx, W * 0.06, H * 0.14, Math.max(22, W * 0.04), curLimit);
  const ego = egoKmh();
  if (ego != null) {
    const v = US() ? ego / 1.609 : ego, over = curLimit && v > curLimit + (US() ? 5 : 8);
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(W - W * 0.15, H * 0.04, W * 0.13, H * 0.14);
    ctx.fillStyle = over ? '#ff4d4d' : '#fff'; ctx.textAlign = 'center';
    ctx.font = `700 ${W * 0.042}px system-ui`; ctx.fillText(Math.round(v), W - W * 0.085, H * 0.125);
    ctx.font = `500 ${W * 0.014}px system-ui`; ctx.fillText(US() ? 'mph' : 'km/h', W - W * 0.085, H * 0.16); ctx.textAlign = 'start';
  }
  if (mode === 'demo') { ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(8, H - 26, 290, 20); ctx.fillStyle = '#ffd38a'; ctx.font = '600 12px system-ui'; ctx.fillText('DEMO: mashinalar sun\'iy (AI o\'rniga)', 14, H - 12); }
}

// ===================================================================
// Rendering: bird's-eye view (Tesla-style)
// ===================================================================
function fitBev(){
  const box = bev.parentElement, r = box.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(200, Math.round(r.width)), h = Math.max(220, Math.round(Math.min(r.height || 400, 700)));
  if (bev.width !== Math.round(w * dpr) || bev.height !== Math.round(h * dpr)) { bev.width = Math.round(w * dpr); bev.height = Math.round(h * dpr); }
}
function renderBev(){
  const W = bev.width, H = bev.height, g = bctx;
  g.fillStyle = '#0f1318'; g.fillRect(0, 0, W, H);
  // lateral scale is fixed; distance is compressed so far cars still fit (like a car's dashboard view)
  const Zmax = 80, K = 18, egoY = H * 0.84, top = H * 0.07, pxm = W / 13;
  const zy = Z => egoY - (egoY - top) * (Z / (Z + K)) / (Zmax / (Zmax + K));
  const toS = (X, Z) => [W / 2 + X * pxm, zy(Z)];
  const lw = lane.width || LANE_W();
  const egoL = lane.egoL !== null ? lane.egoL : -lw / 2, egoR = lane.egoR !== null ? lane.egoR : lw / 2;
  const nl = lane.nLanes ? lane.nLeft : 1, nr = lane.nLanes ? lane.nRight : 1;
  const left = egoL - nl * lw, right = egoR + nr * lw;
  // road surface
  const gr = g.createLinearGradient(0, egoY, 0, 0); gr.addColorStop(0, '#2a3038'); gr.addColorStop(1, 'rgba(42,48,56,0)');
  g.fillStyle = gr; const [a0] = toS(left, 0), [a1] = toS(right, 0); g.fillRect(a0, 0, a1 - a0, H);
  // lane lines
  const bounds = []; for (let i = 0; i <= nl; i++) bounds.push(egoL - i * lw); for (let i = 0; i <= nr; i++) bounds.push(egoR + i * lw);
  for (const X of bounds) {
    const edge = Math.abs(X - left) < 0.01 || Math.abs(X - right) < 0.01;
    const ego = Math.abs(X - egoL) < 0.01 || Math.abs(X - egoR) < 0.01;
    g.strokeStyle = ego ? (lane.depFrames >= 6 ? '#ff4d4d' : '#3ddc97') : edge ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.5)';
    g.lineWidth = ego ? 3 : 2; g.setLineDash(edge || ego ? [] : [14, 14]);
    const [x0, y0] = toS(X, -3), [x1, y1] = toS(X, Zmax);
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  }
  g.setLineDash([]);
  // distance rings
  g.fillStyle = 'rgba(255,255,255,.35)'; g.font = `${Math.round(11 * (W / 360))}px system-ui`;
  g.textAlign = 'right';
  for (const z of [10, 20, 40, 60]) { const y = zy(z); g.fillRect(W - 8, y, 6, 1); g.fillText(US() ? Math.round(z * 3.281) + ' ft' : z + ' m', W - 12, y + 4); }
  g.textAlign = 'start';
  // vehicles
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.fill(); };
  for (const t of vtracks) {
    if (!t.ok || t.Z > Zmax + 5) continue;
    const wM = VEH[t.cls] || 1.8, lM = VLEN[t.cls] || 4.5;
    const [x, y] = toS(t.X, t.Z); const yTop = zy(t.Z + lM), hpx = Math.max(6, y - yTop);
    const isLead = t === lead, danger = isLead && t.ttc && t.ttc < P.ttc;
    g.fillStyle = danger ? '#ff4d4d' : isLead ? '#ffb020' : t.cls === 'person' ? '#c77dff' : '#9aa6b5';
    rr(x - wM * pxm / 2, y - hpx, wM * pxm, hpx, Math.min(6, wM * pxm * 0.25));
    g.fillStyle = 'rgba(255,255,255,.85)'; g.font = `600 ${Math.round(11 * (W / 360))}px system-ui`; g.textAlign = 'center';
    if (isLead || t.Z < 30) g.fillText(fmtDist(t.Z), x, y - hpx - 5); g.textAlign = 'start';
  }
  // ego car
  const [ex, ey] = toS(-(lane.offset || 0) * 0, 0);
  const ew = 1.85 * pxm, el = Math.min(H - ey - 4, 4.7 * pxm * 0.55);
  g.fillStyle = '#e8ebef'; rr(ex - ew / 2, ey, ew, el, Math.min(8, ew * 0.3));
  g.fillStyle = '#4da3ff'; rr(ex - ew * 0.35, ey + el * 0.18, ew * 0.7, el * 0.22, 3);
  // headline
  g.fillStyle = 'rgba(255,255,255,.85)'; g.font = `600 ${Math.round(13 * (W / 360))}px system-ui`;
  g.fillText(lane.nLanes ? `${lane.nLanes} polosa · siz ${lane.egoIdx}-da` : 'Polosalar aniqlanmoqda…', 10, 20 * (W / 360));
}

// ===================================================================
// Main loop
// ===================================================================
function resetState(){
  lane.L = mkSide(); lane.R = mkSide(); lane.width = null; lane.depFrames = 0; lane.laneHist = []; lane.nLanes = null; lane.marks = []; lane.egoL = lane.egoR = null;
  hist.fill(0); signTracks = []; curLimit = null; updateLimitStat(); vtracks = []; lead = null; lights = [];
}
let lastT = 0, fpsAcc = 0, fpsN = 0, tick = 0;
function loop(now){
  if (!running) return;
  requestAnimationFrame(loop);
  if (paused) { lastT = now; return; }
  const dt = now - lastT; lastT = now; fpsAcc += dt; fpsN++;
  if (fpsAcc > 700) {
    const fps = Math.round(1000 * fpsN / fpsAcc); fpsAcc = 0; fpsN = 0;
    const ai = mode === 'demo' ? 'demo' : !P.ai ? "o'chiq" : modelState === 'ready' ? Math.round(1000 / Math.max(1, detMs)) + ' Hz' : modelState === 'loading' ? 'yuklanmoqda' : modelState === 'error' ? 'xato' : '—';
    $('sFps').textContent = `${ai} · ${fps}`;
    const ego = egoKmh(); $('sSpeed').textContent = ego != null ? fmtSpeed(ego) : '—';
  }
  let src, demoDets = null;
  if (mode === 'demo') { demoDets = demo.frame(); src = demoCan; }
  else if (video.readyState >= 2) src = video; else return;
  detectLanes(src); laneLogic();
  if (++tick % 2 === 0) updateSignTracks(detectSigns(src));
  if (demoDets) { if (tick % 3 === 0) onDetections(demoDets.map(d => ({ ...d, x: d.x + (Math.random() - .5) * 2, w: d.w * (1 + (Math.random() - .5) * 0.04) })), now, src); }
  else runDetector(src);
  if (!model && mode !== 'demo') vehicleLogic();
  render(src); fitBev(); renderBev();
}
function start(){
  if (!TPL) buildTemplates();
  $('btnPause').textContent = '⏸';
  if (!running) { running = true; lastT = performance.now(); requestAnimationFrame(loop); }
}
window.addEventListener('resize', fitBev);
fitBev(); renderBev();
if (!window.isSecureContext) showMsg('Kamera ishlashi uchun sahifa <b>https://</b> orqali ochilishi kerak.');
window.__app = { cal, lane, demo, detectSigns, setSource, buildTemplates, setRegionHook: () => {}, get vtracks(){ return vtracks; }, get lead(){ return lead; } };
})();
