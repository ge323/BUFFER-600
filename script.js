/* =========================================================
   BUFFER 600 — 해월호텔 야간 관제 기록
   - 게임 시각(g): 실제 지금 시각 (분 단위, 01:05 = 65)
   - 화면 내용 시각(c): g - 버퍼. 버퍼가 600초면 화면은 10분 전 모습
   - 화면 구석에 찍히는 시각은 항상 g (출력 시각) → 이게 함정
   ========================================================= */
(() => {
  "use strict";

  /* ---------------- 유틸 ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;
  const pad = (n) => String(n).padStart(2, "0");
  const T = (str) => {
    const [h, m] = str.split(":");
    return Number(h) * 60 + Number(m);
  };
  const fmtHM = (min) => {
    const t = Math.floor(Math.max(0, min));
    return pad(Math.floor(t / 60) % 24) + ":" + pad(t % 60);
  };
  const fmtHMS = (min) => {
    const s = Math.floor(Math.max(0, min) * 60);
    return `${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  };
  function rng(seed) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- 설정 ---------------- */
  const params = new URLSearchParams(location.search);
  const SPEED = clamp(parseFloat(params.get("speed")) || 1, 0.1, 120);
  const START = 65; // 01:05
  const END = 360; // 06:00
  const MIN_MS = 3000 / SPEED; // 게임 1분 = 실제 3초
  const PB_MIN_MS = 1200 / SPEED; // 다시 보기: 녹화 1분 = 실제 1.2초
  const W = 640,
    H = 360; // 카메라 캔버스 해상도

  const CAMS = [
    { id: "lobby", code: "CAM 01", name: "로비", en: "LOBBY" },
    { id: "elev", code: "CAM 02", name: "엘리베이터", en: "ELEVATOR" },
    { id: "corr", code: "CAM 03", name: "7층 복도", en: "7F CORRIDOR" },
    { id: "stair", code: "CAM 04", name: "비상계단", en: "STAIRWELL" },
    { id: "park", code: "CAM 05", name: "주차장", en: "PARKING", ir: true },
    { id: "kit", code: "CAM 06", name: "주방", en: "KITCHEN" },
    { id: "roof", code: "CAM 07", name: "옥상", en: "ROOFTOP", ir: true },
    { id: "ctrl", code: "CAM 08", name: "관제실", en: "CONTROL ROOM" },
  ];
  const CAM = Object.fromEntries(CAMS.map((c) => [c.id, c]));

  const state = {
    running: false,
    paused: false,
    ended: false,
    g: START,
    buf: 10, // 분 단위 (600초)
    bufHistory: [{ g: START, buf: 10 }],
    mon: ["lobby", null],
    sel: 1,
    monSwitch: [0, 0],
    captures: [],
    pb: {
      credits: 3,
      playing: false,
      paused: false,
      cam: "lobby",
      start: 0,
      pos: 0,
    },
    reportLeft: 3,
    sound: true,
    fx: true,
    kangGone: false,
    bufWarned: false,
    radioUnread: 0,
    evIdx: 0,
    logIdx: 0,
    queue: [],
  };
  if (params.get("t")) state.g = T(params.get("t"));

  const contentNow = () => state.g - state.buf;
  function labelFor(c) {
    // 녹화 타임스탬프 = 그 장면이 화면에 출력된 시각
    for (let i = state.bufHistory.length - 1; i >= 0; i--) {
      const h = state.bufHistory[i];
      if (c + h.buf >= h.g || i === 0) return c + h.buf;
    }
    return c + 10;
  }

  /* ---------------- 반응형 스테이지 ---------------- */
  const stage = $("#stage");
  let SCALE = 1;
  function fit() {
    const vv = window.visualViewport;
    const vw = vv ? vv.width : innerWidth;
    const vh = vv ? vv.height : innerHeight;
    SCALE = Math.min(vw / 1024, vh / 576);
    const tx = (vw - 1024 * SCALE) / 2,
      ty = (vh - 576 * SCALE) / 2;
    const tf = `translate(${tx}px, ${ty}px) scale(${SCALE})`;
    stage.style.transform = tf;
    stage.style.setProperty("--stage-tf", tf);
  }
  addEventListener("resize", fit);
  addEventListener("orientationchange", () => setTimeout(fit, 200));
  if (window.visualViewport) visualViewport.addEventListener("resize", fit);
  fit();

  /* ---------------- 소리 (WebAudio 합성) ---------------- */
  const Sfx = (() => {
    let ac = null,
      master = null;
    function init() {
      if (ac) return;
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        master = ac.createGain();
        master.gain.value = state.sound ? 1 : 0;
        master.connect(ac.destination);
        hum();
      } catch (e) {
        ac = null;
      }
    }
    function noise(sec, brown) {
      const b = ac.createBuffer(
        1,
        Math.floor(ac.sampleRate * sec),
        ac.sampleRate,
      );
      const d = b.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        if (brown) {
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.5;
        } else d[i] = w;
      }
      return b;
    }
    function src(buf, loop) {
      const s = ac.createBufferSource();
      s.buffer = buf;
      s.loop = !!loop;
      return s;
    }
    function env(g, t, a, peak, hold, rel) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + a);
      g.gain.setValueAtTime(peak, t + a + hold);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
    }
    function hum() {
      const s = src(noise(4, true), true);
      const lp = ac.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 220;
      const g = ac.createGain();
      g.gain.value = 0.09;
      s.connect(lp).connect(g).connect(master);
      s.start();
      const o = ac.createOscillator();
      o.frequency.value = 60;
      const og = ac.createGain();
      og.gain.value = 0.006;
      o.connect(og).connect(master);
      o.start();
    }
    function radio() {
      if (!ac) return;
      const t = ac.currentTime;
      const s = src(noise(0.25));
      const bp = ac.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1900;
      bp.Q.value = 0.7;
      const g = ac.createGain();
      env(g, t, 0.01, 0.22, 0.08, 0.08);
      s.connect(bp).connect(g).connect(master);
      s.start(t);
      const o = ac.createOscillator();
      o.frequency.value = 1450;
      o.type = "sine";
      const og = ac.createGain();
      env(og, t + 0.2, 0.005, 0.06, 0.05, 0.03);
      o.connect(og).connect(master);
      o.start(t + 0.2);
      o.stop(t + 0.4);
    }
    function phone() {
      if (!ac) return;
      const t0 = ac.currentTime;
      for (let r = 0; r < 3; r++) {
        const t = t0 + r * 1.6;
        [440, 480].forEach((f) => {
          const o = ac.createOscillator();
          o.frequency.value = f;
          const g = ac.createGain();
          env(g, t, 0.02, 0.035, 0.8, 0.1);
          o.connect(g).connect(master);
          o.start(t);
          o.stop(t + 1.1);
        });
      }
    }
    function alarm() {
      if (!ac) return;
      const t = ac.currentTime;
      const o = ac.createOscillator();
      o.type = "square";
      for (let i = 0; i < 16; i++)
        o.frequency.setValueAtTime(i % 2 ? 860 : 640, t + i * 0.32);
      const lp = ac.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 700;
      const g = ac.createGain();
      env(g, t, 0.4, 0.03, 4, 1.2);
      o.connect(lp).connect(g).connect(master);
      o.start(t);
      o.stop(t + 6);
    }
    function click() {
      if (!ac) return;
      const t = ac.currentTime;
      const s = src(noise(0.05));
      const hp = ac.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1800;
      const g = ac.createGain();
      env(g, t, 0.002, 0.35, 0.01, 0.03);
      s.connect(hp).connect(g).connect(master);
      s.start(t);
    }
    function breath() {
      if (!ac) return;
      const t = ac.currentTime;
      for (let i = 0; i < 2; i++) {
        const s = src(noise(1.6));
        const bp = ac.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 520;
        bp.Q.value = 0.6;
        const g = ac.createGain();
        env(g, t + i * 1.8, 0.6, 0.12, 0.2, 0.7);
        s.connect(bp).connect(g).connect(master);
        s.start(t + i * 1.8);
      }
    }
    function stat(d = 0.25) {
      if (!ac) return;
      const t = ac.currentTime;
      const s = src(noise(d));
      const hp = ac.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 900;
      const g = ac.createGain();
      env(g, t, 0.005, 0.05, d * 0.6, d * 0.3);
      s.connect(hp).connect(g).connect(master);
      s.start(t);
    }
    function sting() {
      if (!ac) return;
      const t = ac.currentTime;
      [55, 58.3].forEach((f) => {
        const o = ac.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        const lp = ac.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 240;
        const g = ac.createGain();
        env(g, t, 2.2, 0.09, 3, 3);
        o.connect(lp).connect(g).connect(master);
        o.start(t);
        o.stop(t + 9);
      });
    }
    function siren() {
      if (!ac) return;
      const t = ac.currentTime;
      const o = ac.createOscillator();
      o.type = "triangle";
      for (let i = 0; i < 10; i++) {
        o.frequency.setValueAtTime(620, t + i * 0.9);
        o.frequency.linearRampToValueAtTime(980, t + i * 0.9 + 0.45);
        o.frequency.linearRampToValueAtTime(620, t + i * 0.9 + 0.9);
      }
      const lp = ac.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1200;
      const g = ac.createGain();
      env(g, t, 2.5, 0.035, 4, 2.5);
      o.connect(lp).connect(g).connect(master);
      o.start(t);
      o.stop(t + 9.5);
    }
    return {
      init,
      radio,
      phone,
      alarm,
      click,
      breath,
      stat,
      sting,
      siren,
      setOn: (v) => {
        if (master) master.gain.value = v ? 1 : 0;
      },
      resume: () => {
        if (ac && ac.state === "suspended") ac.resume();
      },
    };
  })();

  /* ---------------- 그리기 도우미 ---------------- */
  let IR = false; // 적외선(흑백) 카메라 렌더링 중인가
  const toneCache = new Map();
  function tone(c) {
    if (!IR || !c) return c;
    const key = c;
    if (toneCache.has(key)) return toneCache.get(key);
    let r,
      g,
      b,
      a = 1;
    if (c[0] === "#") {
      const h =
        c.length === 4
          ? c
              .slice(1)
              .split("")
              .map((x) => x + x)
              .join("")
          : c.slice(1);
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    } else {
      const m = c.match(/[\d.]+/g);
      if (!m) return c;
      [r, g, b] = m.map(Number);
      a = m[3] != null ? Number(m[3]) : 1;
    }
    const l = Math.round(
      clamp((0.3 * r + 0.59 * g + 0.11 * b) * 1.18 + 10, 0, 255),
    );
    const out = `rgba(${l},${Math.min(255, l + 4)},${l},${a})`;
    toneCache.set(key, out);
    return out;
  }
  function poly(ctx, pts, fill, stroke, lw) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = typeof fill === "string" ? tone(fill) : fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = tone(stroke);
      ctx.lineWidth = lw || 1;
      ctx.stroke();
    }
  }
  function lg(ctx, x0, y0, x1, y1, stops) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([o, c]) => g.addColorStop(o, tone(c)));
    return g;
  }
  function rg(ctx, x, y, r0, r1, stops) {
    const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
    stops.forEach(([o, c]) => g.addColorStop(o, tone(c)));
    return g;
  }
  function rect(ctx, x, y, w, h, fill) {
    ctx.fillStyle = typeof fill === "string" ? tone(fill) : fill;
    ctx.fillRect(x, y, w, h);
  }
  function glow(ctx, x, y, r, color, alpha = 1) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rg(ctx, x, y, 0, r, [
      [0, color],
      [1, "rgba(0,0,0,0)"],
    ]);
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.restore();
  }
  function ell(ctx, x, y, rx, ry, fill, rot = 0) {
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, TAU);
    ctx.fillStyle = typeof fill === "string" ? tone(fill) : fill;
    ctx.fill();
  }
  function line(ctx, x0, y0, x1, y1, color, w = 1) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = tone(color);
    ctx.lineWidth = w;
    ctx.stroke();
  }
  function text(ctx, s, x, y, font, color, align = "left") {
    ctx.font = font;
    ctx.fillStyle = tone(color);
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillText(s, x, y);
  }

  /* ---------------- 등장인물 ---------------- */
  const LOOK = {
    K: {
      name: "강도현",
      skin: "#d6ab86",
      hair: "#8f8f8f",
      hairStyle: "slick",
      top: "#1f232a",
      top2: "#121419",
      bottom: "#16181c",
      shoes: "#080808",
      shirt: "#e9e9e6",
      tie: "#6e1c24",
      tag: true,
    },
    M: {
      name: "민세영",
      skin: "#ebc7a5",
      hair: "#1d1512",
      hairStyle: "long",
      top: "#bfa077",
      top2: "#8c7150",
      bottom: "#2b2b33",
      shoes: "#3c2a1e",
      shirt: "#f2eee6",
      coat: true,
      folder: true,
    },
    T: {
      name: "박태오",
      skin: "#d9ae88",
      hair: "#2b1d15",
      hairStyle: "short",
      top: "#e3b52a",
      top2: "#a3801a",
      bottom: "#33507c",
      shoes: "#ececec",
      hood: true,
      camera: true,
    },
    S: {
      name: "서미란",
      skin: "#e2bfa2",
      hair: "#e8e5de",
      hairStyle: "bun",
      top: "#6d4f8c",
      top2: "#4a3463",
      bottom: "#4c4553",
      legs: "#5b4b44",
      shoes: "#2a2420",
      shirt: "#dcd5c6",
      skirt: true,
      cardigan: true,
      slow: true,
    },
    O: {
      name: "오진수",
      skin: "#cfa27c",
      hair: "#141414",
      hairStyle: "short",
      top: "#5e646c",
      top2: "#43484f",
      bottom: "#4e535a",
      shoes: "#101010",
      shirt: "#dfe3e8",
      tie: "#2b3d6a",
      looseTie: true,
      bottle: true,
    },
    P: {
      name: "윤재",
      skin: "#dcb391",
      hair: "#111111",
      hairStyle: "short",
      top: "#3b4249",
      top2: "#272c31",
      bottom: "#202428",
      shoes: "#d8d8d8",
      hood: true,
    },
  };

  function armAngles(pose, side, sw, tm, who) {
    // [ [상완, 전완] 왼팔, [상완, 전완] 오른팔 ] — 양수는 +x 방향
    const j = Math.sin(tm / 90) * 0.12;
    if (side) {
      switch (pose) {
        case "walk":
          return [
            [-sw * 0.55, -sw * 0.55 + 0.3],
            [sw * 0.55, sw * 0.55 + 0.3],
          ];
        case "struggle":
          return who === "M"
            ? [
                [2.4 + j, 2.8 + j],
                [2.6 - j, 3.0 - j],
              ]
            : [
                [1.3 + j, 1.45 + j],
                [1.4 - j, 1.5 - j],
              ];
        case "argue":
          return [
            [0.05, 0.3],
            [0.9 + Math.sin(tm / 260) * 0.35, 1.5 + Math.sin(tm / 260) * 0.35],
          ];
        case "phone":
          return [
            [0.05, 0.3],
            [0.35, 2.7],
          ];
        case "knock":
          return [
            [0.05, 0.3],
            [0.9, 2.2 + Math.sin(tm / 110) * 0.3],
          ];
        case "film":
          return [
            [0.6, 1.9],
            [0.7, 2.0],
          ];
        default:
          return [
            [0.04, 0.25],
            [0.1, 0.35],
          ];
      }
    }
    switch (pose) {
      case "walk":
        return [
          [-0.1 + sw * 0.07, -0.05 + sw * 0.1],
          [0.1 + sw * 0.07, 0.05 + sw * 0.1],
        ];
      case "phone":
        return [
          [-0.1, -0.05],
          [-0.45, -2.6],
        ];
      case "argue": {
        const a = Math.sin(tm / 260) * 0.35;
        return [
          [-0.1, -0.05],
          [1.1 + a, 1.9 + a],
        ];
      }
      case "film":
        return [
          [0.4, 2.3],
          [-0.4, -2.3],
        ];
      case "gloves":
        return [
          [0.35, 1.25 + j],
          [-0.35, -1.25 - j],
        ];
      case "shred":
        return [
          [0.45, 1.5 + j * 2],
          [-0.45, -1.5 + j * 2],
        ];
      case "knock":
        return [
          [-0.1, -0.05],
          [0.9, 2.3 + Math.sin(tm / 110) * 0.3],
        ];
      case "smoke":
        return [
          [-0.1, -0.05],
          [-0.35, -2.85],
        ];
      case "pickup":
        return [
          [0.15, 0.1],
          [-0.15, -0.1],
        ];
      case "struggle":
        return [
          [0.5, 2.5 + j],
          [-0.5, -2.5 - j],
        ];
      default:
        return [
          [-0.1, -0.05],
          [0.1, 0.05],
        ];
    }
  }

  function drawPerson(ctx, who, x, y, s, o = {}) {
    const L = LOOK[who];
    const facing = o.facing || "front";
    const pose = o.pose || "stand";
    const tm = o.tm || 0;
    const side = facing === "left" || facing === "right";
    const back = facing === "back";
    const walking = pose === "walk";
    const ph = walking ? (tm / (L.slow ? 900 : 620)) % 1 : 0;
    const sw = walking ? Math.sin(ph * TAU) : 0;
    const crouch = pose === "pickup" ? 14 : 0;
    const c = (k) => tone(L[k]);

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    if (o.alpha != null) ctx.globalAlpha = o.alpha;
    ell(ctx, 0, 0, side ? 17 : 21, 5, "rgba(0,0,0,0.4)");
    if (facing === "left") ctx.scale(-1, 1);
    const bob = walking
      ? -Math.abs(Math.sin(ph * TAU)) * 2.2
      : Math.sin(tm / 900) * 0.4;
    ctx.translate(0, bob);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const hipY = -70 + crouch;
    const coatBottom = L.coat ? -34 : L.skirt ? -40 : -66;

    // ── 다리 ──
    const legCol = L.skirt ? c("legs") : c("bottom");
    if (!side) {
      [-1, 1].forEach((d) => {
        const lift = walking ? Math.max(0, sw * d) * 6 : 0;
        ctx.strokeStyle = legCol;
        ctx.lineWidth = L.skirt ? 7 : 11;
        ctx.beginPath();
        ctx.moveTo(d * 7, hipY);
        ctx.lineTo(d * 7, -3 - lift);
        ctx.stroke();
        ell(ctx, d * 7.5, -2 - lift, 6.5, 3.6, L.shoes);
      });
    } else {
      const a = sw * 0.5;
      [
        [-a, 0.72],
        [a, 1],
      ].forEach(([ang, shade]) => {
        const fx = Math.sin(ang) * (70 - crouch),
          fy = hipY + Math.cos(ang) * (70 - crouch);
        ctx.globalAlpha = (o.alpha ?? 1) * (shade < 1 ? 0.85 : 1);
        ctx.strokeStyle = legCol;
        ctx.lineWidth = L.skirt ? 7 : 11;
        ctx.beginPath();
        ctx.moveTo(0, hipY);
        ctx.lineTo(fx, fy - 2);
        ctx.stroke();
        ell(ctx, fx + 3, fy - 2, 7, 3.4, L.shoes);
      });
      ctx.globalAlpha = o.alpha ?? 1;
    }

    // ── 팔 계산 ──
    const [aL, aR] = armAngles(pose, side, sw, tm, who);
    const shY = -119 + crouch;
    const arm = (sx, a1, a2, dim) => {
      const ex = sx + Math.sin(a1) * 25,
        ey = shY + Math.cos(a1) * 25;
      const hx = ex + Math.sin(a2) * 23,
        hy = ey + Math.cos(a2) * 23;
      ctx.strokeStyle = dim ? c("top2") : c("top");
      ctx.lineWidth = 8.5;
      ctx.beginPath();
      ctx.moveTo(sx, shY);
      ctx.lineTo(ex, ey);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ell(ctx, hx, hy, 3.7, 3.7, L.skin);
      return [hx, hy];
    };
    let hands = [
      [0, 0],
      [0, 0],
    ];

    // 뒷모습이거나 옆모습이면 먼 팔을 먼저
    if (back)
      hands = [arm(-17, aL[0], aL[1], true), arm(17, aR[0], aR[1], true)];
    if (side) hands[0] = arm(0, aL[0], aL[1], true);

    // 후드(등 뒤)
    if (L.hood && !back && !side) ell(ctx, 0, -124 + crouch, 13, 6, L.top2);

    // ── 몸통 ──
    const tw = side ? 11 : 19,
      bw = side ? (L.coat ? 13 : 10) : L.coat ? 21 : 15;
    const top = -127 + crouch;
    ctx.beginPath();
    ctx.moveTo(-tw + 4, top);
    ctx.quadraticCurveTo(-tw, top + 1, -tw, top + 8);
    ctx.lineTo(-bw, coatBottom);
    ctx.lineTo(bw, coatBottom);
    ctx.lineTo(tw, top + 8);
    ctx.quadraticCurveTo(tw, top + 1, tw - 4, top);
    ctx.closePath();
    ctx.fillStyle = lg(ctx, -tw, 0, tw, 0, [
      [0, L.top],
      [0.6, L.top],
      [1, L.top2],
    ]);
    ctx.fill();
    // 림 라이트
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha *= 0.18;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-tw + 2, top + 1);
    ctx.lineTo(tw - 2, top + 1);
    ctx.stroke();
    ctx.restore();

    if (!back && !side) {
      if (L.shirt && !L.cardigan)
        poly(
          ctx,
          [
            [-6, top],
            [6, top],
            [0, top + 18],
          ],
          L.shirt,
        );
      if (L.cardigan) {
        rect(ctx, -4.5, top + 1, 9, coatBottom - top - 2, L.shirt);
        for (let i = 0; i < 4; i++)
          ell(ctx, 5.5, top + 10 + i * 11, 1, 1, "#d8c9a8");
      }
      if (L.tie) {
        const off = L.looseTie ? 2.5 : 0;
        poly(
          ctx,
          [
            [-1.8 + off, top + 4],
            [1.8 + off, top + 4],
            [2.6 + off, top + (L.looseTie ? 24 : 30)],
            [0 + off, top + (L.looseTie ? 27 : 33)],
            [-2.6 + off, top + (L.looseTie ? 24 : 30)],
          ],
          L.tie,
        );
      }
      if (L.tie || L.coat) {
        line(ctx, -6, top, -2, top + 22, "rgba(0,0,0,0.45)", 1.2);
        line(ctx, 6, top, 2, top + 22, "rgba(0,0,0,0.45)", 1.2);
      }
      if (L.coat) {
        rect(ctx, -bw + 3, -84, (bw - 3) * 2, 3.5, L.top2);
      }
      if (L.tag) {
        rect(ctx, 7, top + 14, 7, 2.6, "#d9b55c");
      }
      if (L.hood && !L.camera) {
        rect(ctx, -9, -88 + crouch, 18, 9, L.top2);
        line(ctx, -3, top + 2, -3, top + 16, "#cccccc", 0.8);
        line(ctx, 3, top + 2, 3, top + 16, "#cccccc", 0.8);
      }
      if (L.camera && pose !== "film") {
        line(ctx, -10, top + 1, 4, top + 20, "#111111", 1);
        rect(ctx, -2, top + 18, 11, 8, "#16161a");
        ell(ctx, 3.5, top + 22, 2.4, 2.4, "#3a4a5a");
      }
    } else if (back) {
      line(ctx, 0, top + 4, 0, coatBottom, "rgba(0,0,0,0.3)", 1);
      if (L.hood) ell(ctx, 0, top + 6, 11, 8, L.top2);
    }

    // ── 팔 (앞) ──
    if (!back && !side) hands = [arm(-17, aL[0], aL[1]), arm(17, aR[0], aR[1])];
    if (side) hands[1] = arm(0, aR[0], aR[1]);

    // ── 목 · 머리 ──
    const hy = -137 + crouch;
    rect(ctx, -3.5, hy + 5, 7, 8, L.skin);
    if (side) {
      ell(ctx, -2.5, hy - 1.5, 9.8, 9.8, L.hair);
      if (L.hairStyle === "long") rect(ctx, -11, hy - 2, 8, 26, L.hair);
      if (L.hairStyle === "bun") ell(ctx, -6, hy - 9, 5, 5, L.hair);
      ell(ctx, 2.5, hy + 1, 6.8, 8.8, L.skin);
      poly(
        ctx,
        [
          [8.5, hy - 1],
          [11, hy + 2],
          [8.5, hy + 3],
        ],
        L.skin,
      );
      ell(ctx, 1.5, hy - 6, 7.5, 4.5, L.hair);
      ell(ctx, 5.5, hy - 1, 1, 1, "#1a1a1a");
    } else if (back) {
      ell(ctx, 0, hy, 9.8, 10.8, L.hair);
      if (L.hairStyle === "long") {
        ctx.fillStyle = c("hair");
        ctx.beginPath();
        ctx.roundRect(-10, hy - 2, 20, 30, 5);
        ctx.fill();
      }
      if (L.hairStyle === "bun") ell(ctx, 0, hy - 11, 5.5, 5, L.hair);
      if (L.hairStyle === "slick" || L.hairStyle === "short")
        rect(ctx, -4, hy + 7, 8, 3, L.skin);
    } else {
      if (L.hairStyle === "long") rect(ctx, -11, hy - 3, 22, 28, L.hair);
      ell(ctx, 0, hy, 9.4, 10.6, L.skin);
      ctx.fillStyle = c("hair");
      ctx.beginPath();
      ctx.ellipse(0, hy - 2.5, 10.2, 9, 0, Math.PI, TAU);
      ctx.fill();
      if (L.hairStyle === "short") rect(ctx, -9, hy - 4, 18, 3, L.hair);
      if (L.hairStyle === "slick") {
        rect(ctx, -10, hy - 3, 2.5, 6, L.hair);
        rect(ctx, 7.5, hy - 3, 2.5, 6, L.hair);
      }
      if (L.hairStyle === "long") {
        rect(ctx, -10.5, hy - 3, 3.5, 20, L.hair);
        rect(ctx, 7, hy - 3, 3.5, 20, L.hair);
      }
      if (L.hairStyle === "bun") ell(ctx, 0, hy - 12, 5.5, 5, L.hair);
      if (o.eyesGlow) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ell(ctx, -3.4, hy + 0.5, 1.5, 1.2, "#ffffff");
        ell(ctx, 3.4, hy + 0.5, 1.5, 1.2, "#ffffff");
        ctx.restore();
      } else {
        ell(ctx, -3.4, hy + 0.5, 1.15, 1.05, "#1a1410");
        ell(ctx, 3.4, hy + 0.5, 1.15, 1.05, "#1a1410");
      }
      line(ctx, -2.2, hy + 5.6, 2.2, hy + 5.6, "rgba(90,40,40,0.6)", 0.9);
    }
    // 머리 림 라이트
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha *= 0.14;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(0, hy, 10, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    ctx.restore();

    // ── 소지품 ──
    const [hl, hr] = hands;
    if (L.folder && !o.noFolder) {
      ctx.save();
      ctx.translate(side ? hr[0] : hl[0], (side ? hr[1] : hl[1]) - 4);
      ctx.rotate(0.15);
      rect(ctx, -6, -8, 12, 16, "#9fb6cc");
      rect(ctx, -6, -8, 12, 2, "#7d93aa");
      rect(ctx, -4.5, -5, 9, 11, "#eef2f5");
      ctx.restore();
    }
    if (L.bottle) {
      rect(ctx, hr[0] - 2, hr[1] - 2, 4.5, 13, "#3d5a26");
      rect(ctx, hr[0] - 1, hr[1] - 6, 2.5, 5, "#2f4a1c");
    }
    if (pose === "film" && L.camera) {
      rect(ctx, -9, top + 10, 18, 11, "#121216");
      ell(ctx, 0, top + 15.5, 3.6, 3.6, "#2f3f52");
      if (Math.floor(tm / 500) % 2 === 0) {
        ell(ctx, 7, top + 12, 1.3, 1.3, "#ff2a2a");
        glow(ctx, 7, top + 12, 6, "rgba(255,40,40,0.8)", 0.8);
      }
    }
    if (pose === "phone") {
      rect(ctx, hr[0] - 2.5, hr[1] - 7, 5, 8, "#cfeaff");
      glow(ctx, hr[0], hr[1] - 3, 18, "rgba(150,210,255,0.6)", 0.6);
    }
    if (pose === "smoke") {
      ell(ctx, hr[0] + 2, hr[1] - 2, 1.3, 1.3, "#ffae3a");
      glow(
        ctx,
        hr[0] + 2,
        hr[1] - 2,
        7,
        "rgba(255,150,40,0.9)",
        0.8 + Math.sin(tm / 400) * 0.2,
      );
    }
    if (pose === "shred") {
      ctx.save();
      ctx.translate((hl[0] + hr[0]) / 2, (hl[1] + hr[1]) / 2);
      ctx.rotate(Math.sin(tm / 120) * 0.1);
      rect(ctx, -7, -5, 14, 10, "#eceff1");
      line(ctx, -5, -2, 5, -2, "#9aa", 0.6);
      line(ctx, -5, 1, 4, 1, "#9aa", 0.6);
      ctx.restore();
    }
    if (pose === "gloves") {
      ell(ctx, hl[0], hl[1], 4.2, 4.2, "#2a5f86");
      ell(ctx, hr[0], hr[1], 4.2, 4.2, "#2a5f86");
    }
    ctx.restore();
  }

  function drawSeated(ctx, x, y, s, tm, empty) {
    const L = LOOK.P;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ell(ctx, 0, 0, 26, 7, "rgba(0,0,0,0.45)");
    // 의자 다리
    ctx.strokeStyle = tone("#121417");
    ctx.lineWidth = 3;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.3;
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(Math.cos(a) * 20, -2 + Math.sin(a) * 4);
      ctx.stroke();
      ell(ctx, Math.cos(a) * 20, -1 + Math.sin(a) * 4, 2.5, 2, "#0a0a0a");
    }
    rect(ctx, -2, -30, 4, 26, "#1b1e22");
    ell(ctx, 0, -32, 22, 7, "#1e2226");
    if (!empty) {
      const sway = Math.sin(tm / 1700) * 1.2;
      ctx.save();
      ctx.translate(sway * 0.3, 0);
      // 몸통 (뒷모습)
      ctx.beginPath();
      ctx.moveTo(-15, -98);
      ctx.quadraticCurveTo(-20, -97, -20, -88);
      ctx.lineTo(-17, -40);
      ctx.lineTo(17, -40);
      ctx.lineTo(20, -88);
      ctx.quadraticCurveTo(20, -97, 15, -98);
      ctx.closePath();
      ctx.fillStyle = lg(ctx, -20, 0, 20, 0, [
        [0, L.top],
        [0.6, L.top],
        [1, L.top2],
      ]);
      ctx.fill();
      ell(ctx, 0, -92, 11, 7, L.top2);
      // 팔꿈치
      ell(ctx, -21, -62, 5, 8, L.top2);
      ell(ctx, 21, -62, 5, 8, L.top2);
      // 머리
      ctx.translate(sway, 0);
      rect(ctx, -3.5, -104, 7, 7, L.skin);
      ell(ctx, 0, -112, 9.8, 10.8, L.hair);
      rect(ctx, -4, -104, 8, 2.5, L.skin);
      ctx.restore();
    }
    // 등받이
    ctx.beginPath();
    ctx.roundRect(-17, -82, 34, 48, 6);
    ctx.fillStyle = lg(ctx, -17, 0, 17, 0, [
      [0, "#26292e"],
      [0.5, "#1a1d21"],
      [1, "#121417"],
    ]);
    ctx.fill();
    ctx.strokeStyle = tone("rgba(255,255,255,0.08)");
    ctx.lineWidth = 1;
    ctx.stroke();
    for (let i = 0; i < 5; i++)
      line(ctx, -12, -74 + i * 8, 12, -74 + i * 8, "rgba(0,0,0,0.35)", 1);
    ctx.restore();
  }

  /* ---------------- 동선 스케줄 (화면 내용 시각 기준) ---------------- */
  const SEG = [];
  const RIDES = [];
  function seg(who, cam, a, b, pts, o = {}) {
    SEG.push({ who, cam, t0: T(a), t1: T(b), pts, ...o });
  }
  function ride(who, a, b, from, to) {
    RIDES.push({ who, t0: T(a), t1: T(b), from, to });
  }

  // 장소 좌표
  const LB = {
    DESK: [452, 238],
    DESK_W: [332, 236],
    DESK_E: [572, 242],
    ELEV: [606, 228],
    STAFF: [222, 220],
    ENT: [66, 228],
    FL: [205, 294],
    FR: [470, 298],
  };
  const CR = {
    E: [1.0, 0.35],
    N701: [1.6, -0.82],
    N702: [1.6, 0.82],
    N703: [2.4, -0.82],
    N704: [2.4, 0.82],
    STAIR: [4.15, 0],
  };
  const ST = {
    DOOR: [100, 300],
    LAND: [372, 302],
    TOP: [585, 143],
    EXIT: [632, 134],
  };
  const KT = { DOOR: [62, 266], DRAWER: [300, 276], SINK: [486, 272] };
  const PK = { DOOR: [52, 336], CAR: [182, 268], SMOKE: [118, 300] };
  const RF = { DOOR: [96, 256], M: [390, 213], K: [336, 217] };
  const CT = { DOOR: [562, 250], CHAIR: [318, 304], BEHIND: [372, 340] };

  // 강도현 (지배인)
  seg("K", "lobby", "00:40", "01:20", [LB.DESK]);
  seg("K", "lobby", "01:20", "01:21", [LB.DESK, LB.DESK_W, LB.STAFF]);
  seg("K", "kit", "01:21", "01:22", [KT.DOOR, KT.DRAWER]);
  seg("K", "kit", "01:22", "01:37", [KT.DRAWER], { pose: "gloves" });
  seg("K", "kit", "01:37", "01:38", [KT.DRAWER, KT.DOOR]);
  seg("K", "lobby", "01:38", "01:39", [LB.STAFF, LB.DESK_W, LB.DESK]);
  seg("K", "lobby", "01:39", "02:28", [LB.DESK]);
  seg("K", "lobby", "02:28", "02:33", [LB.DESK], { pose: "phone" });
  seg("K", "lobby", "02:33", "02:34", [LB.DESK, LB.DESK_E, LB.ELEV]);
  ride("K", "02:34", "02:35", 1, 7);
  seg("K", "corr", "02:35", "02:36", [CR.E, [2.2, 0.05], CR.STAIR]);
  seg("K", "stair", "02:36", "02:37", [ST.DOOR, ST.LAND, ST.TOP, ST.EXIT]);
  seg("K", "roof", "02:37", "02:38", [RF.DOOR, [250, 234], RF.K]);
  seg("K", "roof", "02:38", "02:40", [RF.K], { facing: "right" });
  seg("K", "roof", "02:40", "02:41", [RF.K, [366, 213]], {
    pose: "struggle",
    facing: "right",
    still: true,
  });
  seg("K", "roof", "02:41", "02:43", [[366, 213]], {
    pose: "pickup",
    facing: "back",
  });
  seg("K", "roof", "02:43", "02:44", [[366, 213], [250, 234], RF.DOOR]);
  seg("K", "stair", "02:44", "02:45", [ST.EXIT, ST.TOP, ST.LAND, ST.DOOR]);
  seg("K", "corr", "02:45", "02:46", [CR.STAIR, [2.2, 0.05], CR.E]);
  ride("K", "02:46", "02:47", 7, 1);
  seg("K", "lobby", "02:47", "02:48", [LB.ELEV, LB.DESK_E, LB.DESK]);
  seg("K", "lobby", "02:48", "04:16", [LB.DESK]);
  seg("K", "lobby", "04:16", "04:17", [LB.DESK, LB.DESK_W, LB.STAFF]);
  seg("K", "kit", "04:17", "04:18", [KT.DOOR, KT.SINK]);
  seg("K", "kit", "04:18", "04:32", [KT.SINK], { pose: "shred" });
  seg("K", "kit", "04:32", "04:33", [KT.SINK, KT.DOOR]);
  seg("K", "lobby", "04:33", "04:34", [LB.STAFF, LB.DESK_W, LB.DESK]);
  seg("K", "lobby", "04:34", "05:24", [LB.DESK]);
  seg("K", "lobby", "05:24", "05:25", [LB.DESK, LB.DESK_W, LB.STAFF], {
    tag: "approach",
  });
  seg("K", "ctrl", "05:27", "05:29", [CT.DOOR, [486, 300], CT.BEHIND], {
    tag: "approach",
  });
  seg("K", "ctrl", "05:29", "05:41", [CT.BEHIND], {
    facing: "back",
    tag: "approach",
  });
  seg("K", "ctrl", "05:41", "07:00", [CT.BEHIND], {
    facing: "front",
    eyesGlow: true,
    tag: "approach",
  });

  // 민세영 (704)
  seg("M", "corr", "01:38", "01:39", [CR.N704, [2.1, 0.28]]);
  seg("M", "corr", "01:39", "01:46", [[2.1, 0.28]], {
    pose: "argue",
    facing: "left",
  });
  seg("M", "corr", "01:46", "01:47", [[2.1, 0.28], CR.N704]);
  seg("M", "corr", "02:31", "02:32", [CR.N704, [3.0, 0.1], CR.STAIR]);
  seg("M", "stair", "02:32", "02:33", [ST.DOOR, ST.LAND, ST.TOP, ST.EXIT]);
  seg("M", "roof", "02:33", "02:34", [RF.DOOR, [262, 232], RF.M]);
  seg("M", "roof", "02:34", "02:38", [RF.M], { facing: "back" });
  seg("M", "roof", "02:38", "02:40", [RF.M], { facing: "left" });
  seg("M", "roof", "02:40", "02:40.7", [RF.M, [398, 208]], {
    pose: "struggle",
    facing: "left",
    still: true,
    noFolder: true,
  });

  // 오진수 (702)
  seg("O", "corr", "01:39", "01:40", [CR.N702, [1.9, -0.05]]);
  seg("O", "corr", "01:40", "01:46", [[1.9, -0.05]], {
    pose: "argue",
    facing: "right",
  });
  seg("O", "corr", "01:46", "01:47", [[1.9, -0.05], CR.E]);
  ride("O", "01:47", "01:48", 7, 1);
  seg("O", "lobby", "01:48", "01:49", [LB.ELEV, LB.FR, LB.FL, LB.ENT]);
  seg("O", "park", "01:49", "01:50", [PK.DOOR, PK.SMOKE]);
  seg("O", "park", "01:50", "01:56", [PK.SMOKE], { pose: "smoke" });
  seg("O", "park", "01:56", "01:57", [PK.SMOKE, PK.DOOR]);
  seg("O", "lobby", "01:57", "01:58", [LB.ENT, LB.FL, LB.FR, LB.ELEV]);
  ride("O", "01:58", "01:59", 1, 7);
  seg("O", "corr", "01:59", "02:00", [CR.E, CR.N702]);

  // 박태오 (703)
  seg("T", "corr", "01:08", "01:09", [CR.N703, CR.E]);
  ride("T", "01:09", "01:10", 7, 1);
  seg("T", "lobby", "01:10", "01:11", [LB.ELEV, LB.FR, LB.FL, LB.ENT]);
  seg("T", "park", "01:11", "01:12", [PK.DOOR, PK.CAR]);
  seg("T", "park", "01:12", "01:15", [PK.CAR], { facing: "back" });
  seg("T", "park", "01:15", "01:16", [PK.CAR, PK.DOOR]);
  seg("T", "lobby", "01:16", "01:17", [LB.ENT, LB.FL, LB.FR, LB.ELEV]);
  ride("T", "01:17", "01:18", 1, 7);
  seg("T", "corr", "01:18", "01:19", [CR.E, CR.N703]);
  seg("T", "corr", "01:48", "01:49", [CR.N703, [3.0, -0.1], CR.STAIR]);
  seg("T", "stair", "01:49", "01:50", [ST.DOOR, ST.LAND, ST.TOP, ST.EXIT]);
  seg("T", "roof", "01:50", "01:51", [RF.DOOR, [205, 226]]);
  seg(
    "T",
    "roof",
    "01:51",
    "02:03",
    [
      [205, 226],
      [300, 215],
      [460, 215],
      [300, 215],
    ],
    { pose: "film", slowWalk: true },
  );
  seg("T", "roof", "02:03", "02:04", [[300, 215], [205, 234], RF.DOOR]);
  seg("T", "stair", "02:04", "02:05", [ST.EXIT, ST.TOP, ST.LAND, ST.DOOR]);
  seg("T", "corr", "02:05", "02:06", [CR.STAIR, [3.0, -0.1], CR.N703]);

  // 서미란 (701)
  seg("S", "corr", "02:10", "02:12", [CR.N701, [2.6, -0.35]]);
  seg("S", "corr", "02:12", "02:18", [[2.6, -0.35]], { facing: "back" });
  seg("S", "corr", "02:18", "02:20", [[2.6, -0.35], CR.N701]);
  seg("S", "corr", "04:50", "04:52", [CR.N701, [2.4, 0.62]]);
  seg("S", "corr", "04:52", "04:56", [[2.4, 0.62]], {
    pose: "knock",
    facing: "right",
  });
  seg("S", "corr", "04:56", "04:58", [[2.4, 0.62], CR.N701]);

  // 윤재 (나)
  seg("P", "ctrl", "01:05", "01:06", [CT.DOOR, [430, 300], CT.CHAIR]);

  /* ---------------- 카메라 장면 ---------------- */
  const SCENES = {};

  // ── CAM 01 로비 ──
  SCENES.lobby = {
    fgY: 252,
    proj: ([x, y]) => ({ x, y, s: 0.62 + (y - 218) * 0.0042 }),
    bg(ctx) {
      rect(
        ctx,
        0,
        0,
        W,
        44,
        lg(ctx, 0, 0, 0, 44, [
          [0, "#0f0a07"],
          [1, "#2b1d13"],
        ]),
      );
      for (let x = 0; x < W; x += 64)
        line(ctx, x, 0, x + 30, 44, "rgba(255,220,160,0.03)", 1);
      rect(ctx, 0, 40, W, 6, "#4a3524");
      rect(ctx, 0, 40, W, 1.5, "#7a5a3a");
      rect(
        ctx,
        0,
        46,
        W,
        172,
        lg(ctx, 0, 46, 0, 218, [
          [0, "#40301f"],
          [1, "#22170f"],
        ]),
      );
      for (let x = 6; x < W; x += 42) {
        ctx.strokeStyle = tone("rgba(255,200,140,0.07)");
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 5, 60, 31, 102);
        rect(ctx, x, 54, 1.5, 116, "rgba(0,0,0,0.25)");
      }
      rect(ctx, 0, 170, W, 48, "#1c120b");
      rect(ctx, 0, 170, W, 2, "#6a4b30");
      rect(ctx, 0, 214, W, 3, "#120b07");
      // 회전문 (정문)
      rect(ctx, 14, 82, 102, 136, "#5b4426");
      rect(
        ctx,
        18,
        86,
        94,
        132,
        lg(ctx, 18, 86, 18, 218, [
          [0, "#0a1626"],
          [1, "#05090f"],
        ]),
      );
      glow(ctx, 44, 120, 26, "rgba(255,200,120,0.5)", 0.6);
      for (let i = 0; i < 9; i++)
        line(
          ctx,
          20 + i * 11,
          88,
          20 + i * 11 - 4,
          216,
          "rgba(160,190,220,0.05)",
          1,
        );
      line(ctx, 65, 86, 65, 218, "#8a6a3a", 2.5);
      line(ctx, 18, 150, 112, 150, "#8a6a3a", 1.5);
      poly(
        ctx,
        [
          [22, 94],
          [60, 94],
          [30, 210],
          [22, 210],
        ],
        "rgba(255,255,255,0.05)",
      );
      rect(ctx, 10, 72, 110, 12, "#2c1e12");
      text(ctx, "ENTRANCE", 65, 78, "bold 8px sans-serif", "#c9a86a", "center");
      // 화분
      ell(ctx, 150, 220, 18, 4, "rgba(0,0,0,0.5)");
      poly(
        ctx,
        [
          [136, 192],
          [164, 192],
          [160, 220],
          [140, 220],
        ],
        "#2a2a2e",
      );
      rect(ctx, 134, 190, 32, 4, "#3a3a40");
      const rr = rng(7);
      for (let i = 0; i < 18; i++) {
        const a = -Math.PI / 2 + (rr() - 0.5) * 2.4,
          l = 16 + rr() * 22;
        ctx.save();
        ctx.translate(150, 192);
        ctx.rotate(a + Math.PI / 2);
        ell(
          ctx,
          0,
          -l / 2,
          4 + rr() * 2,
          l / 2,
          rr() > 0.5 ? "#1f3a22" : "#2c4f2c",
        );
        ctx.restore();
      }
      // STAFF ONLY 문
      rect(ctx, 196, 118, 54, 100, "#5a4330");
      rect(
        ctx,
        200,
        122,
        46,
        96,
        lg(ctx, 200, 0, 246, 0, [
          [0, "#4b3828"],
          [1, "#382a1e"],
        ]),
      );
      ctx.strokeStyle = tone("rgba(0,0,0,0.35)");
      ctx.strokeRect(205, 128, 36, 36);
      ctx.strokeRect(205, 170, 36, 42);
      rect(ctx, 208, 140, 30, 9, "#d8d0bc");
      text(
        ctx,
        "STAFF ONLY",
        223,
        144.5,
        "bold 5px sans-serif",
        "#222",
        "center",
      );
      ell(ctx, 240, 172, 2, 2, "#c9a560");
      // 벽시계 테두리
      ell(ctx, 296, 86, 22, 22, "#7a5a30");
      ell(ctx, 296, 86, 19, 19, "#ebe3cf");
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        line(
          ctx,
          296 + Math.sin(a) * 15.5,
          86 - Math.cos(a) * 15.5,
          296 + Math.sin(a) * 18,
          86 - Math.cos(a) * 18,
          "#333",
          i % 3 ? 1 : 2,
        );
      }
      // 데스크 뒤 열쇠함 + 간판
      rect(ctx, 372, 120, 176, 54, "#1b120b");
      for (let r = 0; r < 4; r++)
        for (let k = 0; k < 14; k++) {
          rect(ctx, 376 + k * 12.2, 124 + r * 12.5, 10, 10, "#2c2016");
          if ((r * 14 + k) % 5 === 1)
            rect(ctx, 380 + k * 12.2, 128 + r * 12.5, 2, 5, "#c9a560");
        }
      glow(ctx, 460, 104, 80, "rgba(255,190,110,0.5)", 0.35);
      ctx.save();
      ctx.shadowColor = tone("rgba(255,200,120,0.8)");
      ctx.shadowBlur = 8;
      text(
        ctx,
        "H A E W O L",
        460,
        98,
        "bold 15px Georgia, serif",
        "#e6c27a",
        "center",
      );
      ctx.restore();
      text(
        ctx,
        "HOTEL · 해월호텔",
        460,
        112,
        "7px sans-serif",
        "#a88a55",
        "center",
      );
      // 엘리베이터 (벽면 우측)
      rect(ctx, 580, 92, 60, 126, "#6d5a3c");
      rect(
        ctx,
        585,
        108,
        50,
        110,
        lg(ctx, 585, 0, 635, 0, [
          [0, "#8d949a"],
          [0.5, "#c2c8cc"],
          [1, "#7c8388"],
        ]),
      );
      line(ctx, 610, 108, 610, 218, "#454a4e", 1.2);
      for (let i = 0; i < 12; i++)
        line(
          ctx,
          587 + i * 4,
          110,
          587 + i * 4,
          216,
          "rgba(255,255,255,0.05)",
          1,
        );
      rect(ctx, 596, 95, 28, 10, "#0b0b0b");
      // 바닥 (대리석 체크)
      const VP = [320, 40];
      const xAt = (i, y) => VP[0] + i * 70 * ((y - VP[1]) / (360 - VP[1]));
      const ys = [218, 226, 237, 252, 272, 299, 334, 380];
      for (let r = 0; r < ys.length - 1; r++)
        for (let i = -14; i < 14; i++) {
          const y0 = ys[r],
            y1 = ys[r + 1];
          poly(
            ctx,
            [
              [xAt(i, y0), y0],
              [xAt(i + 1, y0), y0],
              [xAt(i + 1, y1), y1],
              [xAt(i, y1), y1],
            ],
            (r + i) % 2 ? "#6f604c" : "#2f251c",
          );
        }
      rect(
        ctx,
        0,
        218,
        W,
        142,
        lg(ctx, 0, 218, 0, 360, [
          [0, "rgba(0,0,0,0.35)"],
          [1, "rgba(0,0,0,0.05)"],
        ]),
      );
      glow(ctx, 330, 300, 170, "rgba(255,200,130,0.35)", 0.35);
      // 러그
      poly(
        ctx,
        [
          [300, 262],
          [590, 262],
          [630, 330],
          [262, 330],
        ],
        "#5b1717",
      );
      poly(
        ctx,
        [
          [300, 262],
          [590, 262],
          [630, 330],
          [262, 330],
        ],
        null,
        "#b48a3c",
        2,
      );
      poly(
        ctx,
        [
          [312, 268],
          [580, 268],
          [614, 324],
          [278, 324],
        ],
        null,
        "rgba(200,150,70,0.35)",
        1,
      );
      // 안락의자
      ell(ctx, 90, 300, 40, 8, "rgba(0,0,0,0.5)");
      ctx.fillStyle = tone("#3d2a24");
      ctx.beginPath();
      ctx.roundRect(56, 246, 70, 56, 10);
      ctx.fill();
      ctx.fillStyle = tone("#4f362e");
      ctx.beginPath();
      ctx.roundRect(62, 270, 58, 22, 6);
      ctx.fill();
      rect(ctx, 60, 300, 4, 8, "#1a110c");
      rect(ctx, 118, 300, 4, 8, "#1a110c");
      // 샹들리에
      line(ctx, 330, 0, 330, 18, "#6a5434", 1.2);
      ell(ctx, 330, 24, 26, 6, "#8a6c3a");
      for (let i = 0; i < 9; i++) {
        const xx = 306 + i * 6;
        line(ctx, xx, 26, xx, 34 + (i % 3) * 3, "#e5d6b0", 1);
        ell(ctx, xx, 35 + (i % 3) * 3, 1.4, 1.6, "#fff4d8");
      }
      glow(ctx, 330, 28, 90, "rgba(255,215,150,0.75)", 0.6);
      glow(ctx, 330, 28, 26, "rgba(255,245,220,0.9)", 0.8);
    },
    fg(ctx) {
      // 프런트 데스크 (사람 다리를 가림)
      rect(
        ctx,
        336,
        196,
        228,
        9,
        lg(ctx, 336, 196, 336, 205, [
          [0, "#ddd3c2"],
          [1, "#a99f8f"],
        ]),
      );
      for (let i = 0; i < 18; i++)
        line(
          ctx,
          338 + i * 13,
          197,
          345 + i * 13,
          204,
          "rgba(120,110,100,0.25)",
          1,
        );
      rect(
        ctx,
        338,
        205,
        224,
        48,
        lg(ctx, 0, 205, 0, 253, [
          [0, "#4a3220"],
          [1, "#2a1b10"],
        ]),
      );
      for (let x = 344; x < 560; x += 9) {
        rect(ctx, x, 208, 1.5, 42, "rgba(0,0,0,0.3)");
        rect(ctx, x + 1.5, 208, 1, 42, "rgba(255,200,140,0.06)");
      }
      rect(ctx, 338, 205, 224, 2, "#b8924a");
      rect(ctx, 338, 250, 224, 3, "#120b06");
      // 데스크 위 소품
      rect(ctx, 488, 176, 26, 18, "#0d0f12");
      rect(ctx, 490, 178, 22, 14, "#1d3a4a");
      rect(ctx, 499, 194, 4, 3, "#222");
      glow(ctx, 501, 185, 20, "rgba(90,170,220,0.6)", 0.5);
      ell(ctx, 380, 194, 6, 2, "#a08040");
      ell(ctx, 380, 191, 4, 3.5, "#c9a560");
      line(ctx, 420, 196, 420, 178, "#7a6a4a", 1.5);
      poly(
        ctx,
        [
          [412, 178],
          [428, 178],
          [424, 170],
          [416, 170],
        ],
        "#2f5a3a",
      );
      glow(ctx, 420, 182, 22, "rgba(255,210,130,0.8)", 0.6);
    },
    dyn(ctx, c, now) {
      // 벽시계: 화면 '내용' 시각을 가리킨다 (= 실제 시각)
      const sec = c * 60;
      const hA = (((c / 60) % 12) / 12) * TAU,
        mA = ((c % 60) / 60) * TAU,
        sA = ((sec % 60) / 60) * TAU;
      ctx.lineCap = "round";
      line(
        ctx,
        296,
        86,
        296 + Math.sin(hA) * 9,
        86 - Math.cos(hA) * 9,
        "#1a1a1a",
        2.6,
      );
      line(
        ctx,
        296,
        86,
        296 + Math.sin(mA) * 14.5,
        86 - Math.cos(mA) * 14.5,
        "#1a1a1a",
        1.7,
      );
      line(
        ctx,
        296,
        86,
        296 + Math.sin(sA) * 15.5,
        86 - Math.cos(sA) * 15.5,
        "#b01818",
        0.8,
      );
      ell(ctx, 296, 86, 1.6, 1.6, "#111");
      // 엘리베이터 층 표시
      const fl = floorAt(c);
      text(
        ctx,
        String(fl.floor) + (fl.dir ? (fl.dir > 0 ? "▲" : "▼") : ""),
        610,
        100.5,
        "bold 8px monospace",
        "#ff5a3a",
        "center",
      );
      glow(ctx, 610, 100, 12, "rgba(255,80,40,0.6)", 0.4);
      // 샹들리에 미세한 깜빡임
      glow(
        ctx,
        330,
        28,
        40,
        "rgba(255,220,170,0.5)",
        0.15 + Math.sin(now / 130) * 0.04,
      );
    },
  };

  // ── CAM 02 엘리베이터 ──
  SCENES.elev = {
    proj: ([x, y]) => ({ x, y, s: 0.95 + (y - 250) * 0.0045 }),
    bg(ctx) {
      rect(ctx, 0, 0, W, H, "#1a1d20");
      poly(
        ctx,
        [
          [0, 0],
          [160, 34],
          [160, 300],
          [0, 360],
        ],
        lg(ctx, 0, 0, 160, 0, [
          [0, "#7d858b"],
          [1, "#a2a9ae"],
        ]),
      );
      poly(
        ctx,
        [
          [640, 0],
          [480, 34],
          [480, 300],
          [640, 360],
        ],
        lg(ctx, 480, 0, 640, 0, [
          [0, "#9aa1a6"],
          [1, "#6c7378"],
        ]),
      );
      for (let i = 0; i < 30; i++) {
        const t = i / 30;
        line(
          ctx,
          lerp(0, 160, t),
          lerp(0, 34, t),
          lerp(0, 160, t),
          lerp(360, 300, t),
          "rgba(255,255,255,0.05)",
          1,
        );
        line(
          ctx,
          lerp(640, 480, t),
          lerp(0, 34, t),
          lerp(640, 480, t),
          lerp(360, 300, t),
          "rgba(0,0,0,0.06)",
          1,
        );
      }
      rect(
        ctx,
        160,
        34,
        320,
        266,
        lg(ctx, 160, 0, 480, 0, [
          [0, "#8f979c"],
          [0.5, "#b4bbbf"],
          [1, "#8a9196"],
        ]),
      );
      poly(
        ctx,
        [
          [0, 0],
          [640, 0],
          [480, 34],
          [160, 34],
        ],
        "#e7ecee",
      );
      for (let i = 0; i < 4; i++)
        rect(ctx, 210 + i * 60, 10, 40, 14, "#ffffff");
      glow(ctx, 320, 18, 160, "rgba(235,245,255,0.6)", 0.5);
      poly(
        ctx,
        [
          [0, 360],
          [160, 300],
          [480, 300],
          [640, 360],
        ],
        lg(ctx, 0, 300, 0, 360, [
          [0, "#2b2d30"],
          [1, "#1a1b1d"],
        ]),
      );
      for (let i = 0; i < 14; i++)
        line(
          ctx,
          160 + i * 23,
          300,
          -40 + i * 52,
          360,
          "rgba(255,255,255,0.03)",
          1,
        );
      // 손잡이
      line(ctx, 6, 238, 150, 206, "#d8dde0", 4);
      line(ctx, 634, 238, 490, 206, "#d8dde0", 4);
      // 버튼 패널
      poly(
        ctx,
        [
          [500, 120],
          [540, 112],
          [540, 230],
          [500, 226],
        ],
        "#3a3f43",
      );
      for (let r = 0; r < 5; r++)
        for (let k = 0; k < 2; k++) {
          const n = 9 - (r * 2 + k);
          ell(
            ctx,
            511 + k * 16,
            132 + r * 18,
            5,
            5,
            n === 7 ? "#ffd27a" : "#c8cdd0",
          );
          text(
            ctx,
            String(n),
            511 + k * 16,
            132 + r * 18,
            "5px sans-serif",
            "#333",
            "center",
          );
        }
      // 안내문
      poly(
        ctx,
        [
          [40, 110],
          [110, 124],
          [110, 170],
          [40, 160],
        ],
        "#e8e4da",
      );
      text(ctx, "정원 13인", 75, 132, "7px sans-serif", "#333", "center");
      text(ctx, "1000kg", 75, 144, "7px sans-serif", "#333", "center");
    },
    dyn(ctx, c) {
      const r = rideAt(c);
      const open = r ? r.open : 0;
      const fl = floorAt(c);
      // 문 바깥
      rect(ctx, 230, 70, 180, 230, fl.floor === 1 ? "#3a2a1c" : "#2b1a18");
      glow(
        ctx,
        320,
        180,
        90,
        fl.floor === 1 ? "rgba(255,200,130,0.6)" : "rgba(255,180,120,0.4)",
        0.5,
      );
      // 문짝
      const half = 90 * (1 - open);
      rect(
        ctx,
        230,
        70,
        half,
        230,
        lg(ctx, 230, 0, 320, 0, [
          [0, "#9ca3a8"],
          [1, "#c6ccd0"],
        ]),
      );
      rect(
        ctx,
        410 - half,
        70,
        half,
        230,
        lg(ctx, 320, 0, 410, 0, [
          [0, "#c6ccd0"],
          [1, "#9ca3a8"],
        ]),
      );
      for (let i = 0; i < 6; i++) {
        line(
          ctx,
          232 + i * 14 * (1 - open),
          72,
          232 + i * 14 * (1 - open),
          298,
          "rgba(255,255,255,0.06)",
        );
      }
      if (open < 0.02) line(ctx, 320, 70, 320, 300, "#565c60", 1.2);
      rect(ctx, 222, 62, 196, 8, "#6e767b");
      rect(ctx, 222, 62, 8, 240, "#6e767b");
      rect(ctx, 410, 62, 8, 240, "#6e767b");
      // 층 표시기
      rect(ctx, 290, 40, 60, 18, "#090909");
      text(
        ctx,
        (fl.dir ? (fl.dir > 0 ? "▲ " : "▼ ") : "") + fl.floor,
        320,
        49.5,
        "bold 12px monospace",
        "#ff4a2a",
        "center",
      );
      glow(ctx, 320, 49, 30, "rgba(255,70,30,0.7)", 0.45);
    },
  };
  function rideAt(c) {
    for (const r of RIDES) {
      if (c >= r.t0 && c < r.t1) {
        const u = (c - r.t0) / (r.t1 - r.t0);
        let open = 0,
          floor = r.from,
          dir = 0,
          pos = null;
        if (u < 0.12) open = u / 0.12;
        else if (u < 0.22) open = 1;
        else if (u < 0.3) open = 1 - (u - 0.22) / 0.08;
        else if (u < 0.74) {
          const k = (u - 0.3) / 0.44;
          floor = Math.round(lerp(r.from, r.to, k));
          dir = Math.sign(r.to - r.from);
        } else if (u < 0.82) {
          open = (u - 0.74) / 0.08;
          floor = r.to;
        } else if (u < 0.94) {
          open = 1;
          floor = r.to;
        } else {
          open = 1 - (u - 0.94) / 0.06;
          floor = r.to;
        }
        if (u >= 0.74) floor = r.to;
        // 사람 위치
        if (u >= 0.04 && u < 0.24)
          pos = {
            x: 320,
            y: lerp(268, 338, (u - 0.04) / 0.2),
            facing: "back",
            walk: true,
          };
        else if (u >= 0.24 && u < 0.84)
          pos = { x: 320, y: 338, facing: "back", walk: false };
        else if (u >= 0.84 && u < 0.97)
          pos = {
            x: 320,
            y: lerp(338, 262, (u - 0.84) / 0.13),
            facing: "back",
            walk: true,
          };
        return { r, u, open, floor, dir, pos };
      }
    }
    return null;
  }
  function floorAt(c) {
    const cur = rideAt(c);
    if (cur) return { floor: cur.floor, dir: cur.dir };
    let f = 7,
      best = -1;
    for (const r of RIDES)
      if (r.t1 <= c && r.t1 > best) {
        best = r.t1;
        f = r.to;
      }
    return { floor: f, dir: 0 };
  }

  // ── CAM 03 7층 복도 (1점 투시) ──
  const corrP = (z, lx) => ({
    x: 320 + (lx * 320) / z,
    y: 150 + 210 / z,
    s: 1.25 / z,
  });
  const ceilY = (z) => 150 - 170 / z;
  SCENES.corr = {
    metric: ([z, lx]) => [z * 3, lx * 1.2],
    proj: ([z, lx]) => corrP(z, lx),
    bg(ctx) {
      const zf = 4.3;
      const fx0 = 320 - 320 / zf,
        fx1 = 320 + 320 / zf,
        fy0 = ceilY(zf),
        fy1 = 150 + 210 / zf;
      // 천장
      poly(
        ctx,
        [
          [0, -20],
          [640, -20],
          [fx1, fy0],
          [fx0, fy0],
        ],
        lg(ctx, 0, 0, 0, fy0, [
          [0, "#2a221b"],
          [1, "#3a2f25"],
        ]),
      );
      for (let z = 1.4; z < 4.3; z += 0.9) {
        const a = corrP(z, -0.25),
          b = corrP(z, 0.25),
          y = ceilY(z);
        poly(
          ctx,
          [
            [a.x, y + 2],
            [b.x, y + 2],
            [b.x - 3 / z, y + 6 / z],
            [a.x + 3 / z, y + 6 / z],
          ],
          "#f5e8c8",
        );
        glow(ctx, 320, y + 4, (60 / z) * 1.4, "rgba(255,225,170,0.6)", 0.5);
      }
      // 바닥 (카펫)
      poly(
        ctx,
        [
          [0, 360],
          [640, 360],
          [fx1, fy1],
          [fx0, fy1],
        ],
        lg(ctx, 0, fy1, 0, 360, [
          [0, "#2a0f10"],
          [1, "#4a1a1b"],
        ]),
      );
      for (let z = 1.1; z < 4.3; z += 0.25) {
        const a = corrP(z, -1),
          b = corrP(z, 1);
        line(ctx, a.x, a.y, b.x, b.y, "rgba(0,0,0,0.22)", 1);
      }
      for (const lx of [-0.6, -0.3, 0, 0.3, 0.6]) {
        const a = corrP(1, lx),
          b = corrP(zf, lx);
        line(ctx, a.x, a.y, b.x, b.y, "rgba(200,140,80,0.08)", 1);
      }
      const r1 = corrP(1, -0.42),
        r2 = corrP(zf, -0.42),
        r3 = corrP(zf, 0.42),
        r4 = corrP(1, 0.42);
      poly(
        ctx,
        [
          [r1.x, r1.y],
          [r2.x, r2.y],
          [r3.x, r3.y],
          [r4.x, r4.y],
        ],
        null,
        "rgba(210,160,80,0.25)",
        1.2,
      );
      // 벽 (좌우)
      [-1, 1].forEach((sd) => {
        const n0 = corrP(1, sd),
          n1 = corrP(zf, sd);
        poly(
          ctx,
          [
            [n0.x, ceilY(1)],
            [n1.x, fy0],
            [n1.x, fy1],
            [n0.x, 360],
          ],
          lg(ctx, n0.x, 0, n1.x, 0, [
            [0, sd < 0 ? "#5b4a39" : "#4e3f31"],
            [1, "#2e251c"],
          ]),
        );
        // 걸레받이
        const b0 = corrP(1, sd),
          b1 = corrP(zf, sd);
        poly(
          ctx,
          [
            [b0.x, 360],
            [b1.x, fy1],
            [b1.x, fy1 - (4 / zf) * 1],
            [b0.x, 340],
          ],
          "#1b130d",
        );
        // 벽 몰딩
        const mh = (z) => lerp(ceilY(z), 150 + 210 / z, 0.55);
        line(ctx, b0.x, mh(1), b1.x, mh(zf), "rgba(255,220,170,0.12)", 1.5);
      });
      // 문 (701~706)
      const doors = [
        [1.6, -1, "701"],
        [1.6, 1, "702"],
        [2.4, -1, "703"],
        [2.4, 1, "704"],
        [3.3, -1, "705"],
        [3.3, 1, "706"],
      ];
      doors.forEach(([z, sd, num]) => {
        const z0 = z - 0.17,
          z1 = z + 0.17;
        const xA = 320 + (sd * 320) / z0,
          xB = 320 + (sd * 320) / z1;
        const top0 = lerp(ceilY(z0), 150 + 210 / z0, 0.2),
          top1 = lerp(ceilY(z1), 150 + 210 / z1, 0.2);
        const bot0 = 150 + 210 / z0,
          bot1 = 150 + 210 / z1;
        poly(
          ctx,
          [
            [xA, top0 - 4 / z0],
            [xB, top1 - 4 / z1],
            [xB, bot1],
            [xA, bot0],
          ],
          "#6a4c30",
        );
        poly(
          ctx,
          [
            [xA + (sd * -3) / z0, top0],
            [xB + (sd * -2) / z1, top1],
            [xB + (sd * -2) / z1, bot1],
            [xA + (sd * -3) / z0, bot0],
          ],
          lg(ctx, xA, 0, xB, 0, [
            [0, "#3b2516"],
            [1, "#2a1a10"],
          ]),
        );
        const hx = lerp(xA, xB, 0.8),
          hy = lerp(lerp(top0, bot0, 0.55), lerp(top1, bot1, 0.55), 0.8);
        ell(ctx, hx, hy, 2.2 / z, 2.2 / z, "#d4b060");
        rect(ctx, hx - 1.5 / z, hy + 6 / z, 3 / z, 5 / z, "#1a1a1a");
        const px = lerp(xA, xB, 0.5),
          py = lerp(top0, top1, 0.5) - 10 / z;
        rect(ctx, px - 9 / z, py - 4 / z, 18 / z, 8 / z, "#c9a560");
        text(
          ctx,
          num,
          px,
          py,
          `bold ${Math.max(4, 8 / z)}px sans-serif`,
          "#2a1a0a",
          "center",
        );
      });
      // 벽등
      [1.95, 2.85, 3.75].forEach((z) =>
        [-1, 1].forEach((sd) => {
          const p = {
            x: 320 + (sd * 318) / z,
            y: lerp(ceilY(z), 150 + 210 / z, 0.32),
          };
          ell(ctx, p.x, p.y, (3 / z) * 1.6, (6 / z) * 1.6, "#ffe2a8");
          glow(ctx, p.x, p.y, 70 / z, "rgba(255,200,120,0.7)", 0.55);
        }),
      );
      // 소화기함
      const fe = {
        x: 320 - 318 / 1.25,
        y: lerp(ceilY(1.25), 150 + 210 / 1.25, 0.6),
      };
      poly(
        ctx,
        [
          [fe.x, fe.y - 20],
          [fe.x + 12, fe.y - 17],
          [fe.x + 12, fe.y + 14],
          [fe.x, fe.y + 18],
        ],
        "#9a1d1d",
      );
      text(
        ctx,
        "소화기",
        fe.x + 6,
        fe.y - 2,
        "6px sans-serif",
        "#fff",
        "center",
      );
      // 끝 벽 + 비상구
      rect(
        ctx,
        fx0,
        fy0,
        fx1 - fx0,
        fy1 - fy0,
        lg(ctx, 0, fy0, 0, fy1, [
          [0, "#3a3026"],
          [1, "#2a221a"],
        ]),
      );
      rect(ctx, 304, 140, 32, 59, "#55606a");
      rect(
        ctx,
        306,
        142,
        28,
        57,
        lg(ctx, 306, 0, 334, 0, [
          [0, "#6d7983"],
          [1, "#4c5761"],
        ]),
      );
      rect(ctx, 308, 168, 24, 2.5, "#9aa4ad");
      rect(ctx, 304, 125, 32, 11, "#0f6a3a");
      text(
        ctx,
        "비상구 →",
        320,
        130.5,
        "bold 6px sans-serif",
        "#e9fff0",
        "center",
      );
      glow(ctx, 320, 130, 40, "rgba(60,255,140,0.6)", 0.5);
      // 룸서비스 트레이
      const tr = corrP(3.55, 0.7);
      rect(ctx, tr.x - 9, tr.y - 4, 18, 5, "#bfc4c6");
      ell(ctx, tr.x - 3, tr.y - 6, 4, 2, "#eeeeee");
      glow(ctx, 320, 360, 200, "rgba(255,200,130,0.3)", 0.25);
    },
    dyn(ctx, c, now) {
      // 벽등 하나가 가끔 깜빡임
      if (Math.sin(now / 77) > 0.96) rect(ctx, 0, 0, W, H, "rgba(0,0,0,0.08)");
    },
  };

  // ── CAM 04 비상계단 ──
  SCENES.stair = {
    proj: ([x, y]) => ({ x, y, s: 0.52 + (y - 130) * 0.0029 }),
    bg(ctx) {
      rect(
        ctx,
        0,
        0,
        W,
        H,
        lg(ctx, 0, 0, 0, H, [
          [0, "#4c5650"],
          [1, "#2e3531"],
        ]),
      );
      const r = rng(42);
      for (let i = 0; i < 60; i++)
        ell(
          ctx,
          r() * W,
          r() * 260,
          6 + r() * 30,
          4 + r() * 18,
          `rgba(0,0,0,${0.03 + r() * 0.05})`,
          r(),
        );
      rect(ctx, 0, 196, W, 10, "#7a2b26");
      // 7F 스텐실
      text(
        ctx,
        "7F",
        196,
        120,
        "bold 62px Impact, sans-serif",
        "rgba(230,230,210,0.55)",
        "center",
      );
      // 문
      rect(ctx, 50, 146, 100, 160, "#3c4247");
      rect(
        ctx,
        56,
        152,
        88,
        154,
        lg(ctx, 56, 0, 144, 0, [
          [0, "#6f777d"],
          [1, "#535a60"],
        ]),
      );
      rect(ctx, 80, 170, 26, 34, "#20262b");
      for (let i = 0; i < 5; i++) {
        line(ctx, 80, 170 + i * 7, 106, 170 + i * 7, "#3a444b");
        line(ctx, 80 + i * 6.5, 170, 80 + i * 6.5, 204, "#3a444b");
      }
      rect(ctx, 64, 236, 72, 6, "#a9b0b5");
      rect(ctx, 64, 241, 72, 2, "#3c4247");
      rect(ctx, 92, 158, 22, 8, "#e0e0d0");
      text(ctx, "7F", 103, 162, "bold 6px sans-serif", "#222", "center");
      // 아래 층계참
      poly(
        ctx,
        [
          [0, 300],
          [380, 300],
          [420, 360],
          [0, 360],
        ],
        lg(ctx, 0, 300, 0, 360, [
          [0, "#5a615c"],
          [1, "#3f4541"],
        ]),
      );
      line(ctx, 0, 300, 380, 300, "#d8c23a", 3);
      // 계단 (위로)
      const N = 15;
      for (let i = N - 1; i >= 0; i--) {
        const t0 = i / N,
          t1 = (i + 1) / N;
        const lx0 = lerp(300, 520, t0),
          ly0 = lerp(305, 145, t0);
        const lx1 = lerp(300, 520, t1),
          ly1 = lerp(305, 145, t1);
        const w = lerp(150, 110, t0);
        poly(
          ctx,
          [
            [lx0, ly0],
            [lx0 + w, ly0],
            [lx0 + w + (lx1 - lx0), ly1],
            [lx1, ly1],
          ],
          i % 2 ? "#6a716c" : "#646b66",
        );
        poly(
          ctx,
          [
            [lx1, ly1],
            [lx1 + w, ly1],
            [lx1 + w, ly1 + 3],
            [lx1, ly1 + 3],
          ],
          "#3c423e",
        );
        line(ctx, lx1, ly1, lx1 + w, ly1, "#c9b234", 1.2);
      }
      // 위 층계참
      poly(
        ctx,
        [
          [520, 145],
          [640, 145],
          [640, 128],
          [540, 128],
        ],
        "#5b625d",
      );
      // 난간
      line(ctx, 290, 262, 512, 102, "#2e2e2e", 4);
      line(ctx, 290, 262, 512, 102, "rgba(255,255,255,0.12)", 1);
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        line(
          ctx,
          lerp(292, 512, t),
          lerp(262, 102, t),
          lerp(300, 520, t),
          lerp(305, 145, t),
          "#2a2a2a",
          2,
        );
      }
      // 아래로 가는 계단 난간
      line(ctx, 440, 300, 640, 360, "#2e2e2e", 4);
      poly(
        ctx,
        [
          [420, 300],
          [640, 300],
          [640, 360],
          [470, 360],
        ],
        "rgba(0,0,0,0.35)",
      );
      // 비상 유도등 + 표지
      rect(ctx, 552, 70, 50, 20, "#0f7a3f");
      text(
        ctx,
        "R 옥상 ↑",
        577,
        80.5,
        "bold 8px sans-serif",
        "#eafff0",
        "center",
      );
      glow(ctx, 577, 80, 60, "rgba(60,255,140,0.6)", 0.5);
      // 형광등
      rect(ctx, 250, 18, 140, 8, "#e8f4ee");
      glow(ctx, 320, 22, 200, "rgba(220,255,235,0.5)", 0.45);
      // 배관
      line(ctx, 620, 0, 620, 128, "#6a3a2a", 6);
      line(ctx, 632, 0, 632, 128, "#444", 4);
    },
    dyn(ctx, c, now) {
      const f = Math.sin(now / 53) + Math.sin(now / 31);
      if (f > 1.85) rect(ctx, 0, 0, W, H, "rgba(0,0,0,0.25)");
    },
  };

  // ── CAM 05 주차장 (적외선) ──
  SCENES.park = {
    proj: ([x, y]) => ({ x, y, s: 0.48 + (y - 200) * 0.0036 }),
    bg(ctx) {
      rect(
        ctx,
        0,
        0,
        W,
        70,
        lg(ctx, 0, 0, 0, 70, [
          [0, "#0b0e12"],
          [1, "#1b2128"],
        ]),
      );
      const r = rng(3);
      for (let i = 0; i < 22; i++)
        ell(
          ctx,
          120 + i * 24 + r() * 10,
          70 - r() * 6,
          18 + r() * 10,
          16 + r() * 14,
          "#0d140f",
        );
      rect(ctx, 0, 66, W, 16, "#3d4044");
      rect(ctx, 0, 66, W, 2, "#666a70");
      rect(
        ctx,
        0,
        82,
        W,
        278,
        lg(ctx, 0, 82, 0, 360, [
          [0, "#2a2d31"],
          [1, "#3b3f44"],
        ]),
      );
      for (let i = 0; i < 500; i++)
        rect(
          ctx,
          r() * W,
          82 + r() * 278,
          1.2,
          1.2,
          `rgba(255,255,255,${r() * 0.05})`,
        );
      // 주차선
      for (let i = -2; i < 8; i++) {
        const x0 = 120 + i * 120,
          x1 = 200 + i * 80;
        line(ctx, x0, 340, x1, 150, "rgba(230,230,220,0.55)", 2);
      }
      line(ctx, 60, 150, 640, 150, "rgba(230,230,220,0.45)", 2);
      // 물웅덩이
      [
        [260, 300, 60, 10],
        [470, 320, 80, 12],
        [120, 210, 40, 6],
      ].forEach(([x, y, a, b]) => {
        ell(ctx, x, y, a, b, "rgba(160,170,180,0.18)");
        glow(ctx, x, y, a, "rgba(255,255,255,0.15)", 0.4);
      });
      // 가로등
      line(ctx, 540, 120, 540, 20, "#2c2f33", 3);
      line(ctx, 540, 22, 520, 22, "#2c2f33", 3);
      ell(ctx, 516, 26, 7, 3, "#fff7d0");
      glow(ctx, 516, 30, 120, "rgba(255,240,200,0.7)", 0.55);
      // 호텔 외벽
      poly(
        ctx,
        [
          [0, 0],
          [44, 0],
          [44, 360],
          [0, 360],
        ],
        "#22262a",
      );
      for (let k = 0; k < 6; k++) {
        rect(ctx, 10, 12 + k * 48, 22, 28, k === 2 ? "#c9b98a" : "#141719");
      }
      rect(ctx, 0, 300, 60, 60, "#2e3236");
      rect(ctx, 8, 306, 44, 54, "#cfc6a0");
      glow(ctx, 30, 330, 50, "rgba(255,240,190,0.8)", 0.6);
      // 차
      const car = (x, y, w, h, col) => {
        ell(ctx, x, y + h * 0.45, w * 0.55, h * 0.18, "rgba(0,0,0,0.5)");
        ctx.fillStyle = lg(ctx, x - w / 2, 0, x + w / 2, 0, [
          [0, col],
          [0.5, "#9aa1a8"],
          [1, col],
        ]);
        ctx.beginPath();
        ctx.roundRect(x - w / 2, y - h / 2, w, h, 10);
        ctx.fill();
        ctx.fillStyle = tone("#1a1e22");
        ctx.beginPath();
        ctx.roundRect(x - w * 0.36, y - h * 0.32, w * 0.72, h * 0.26, 6);
        ctx.fill();
        ctx.fillStyle = tone("#5d646b");
        ctx.beginPath();
        ctx.roundRect(x - w * 0.34, y - h * 0.04, w * 0.68, h * 0.3, 5);
        ctx.fill();
        rect(ctx, x - w * 0.3, y + h * 0.3, w * 0.6, 3, "#1a1e22");
        ell(ctx, x - w * 0.36, y + h * 0.42, 6, 3, "#d8d8d8");
        ell(ctx, x + w * 0.36, y + h * 0.42, 6, 3, "#d8d8d8");
        line(
          ctx,
          x - w * 0.42,
          y - h * 0.3,
          x + w * 0.1,
          y - h * 0.3,
          "rgba(255,255,255,0.25)",
          1,
        );
      };
      car(182, 232, 86, 74, "#5a6068");
      car(310, 220, 80, 66, "#3a3f44");
      car(436, 212, 74, 60, "#70767c");
      car(556, 204, 68, 56, "#2e3236");
    },
    dyn(ctx, c, now) {
      // 02:41 — 무언가 떨어진다 (차 3 뒤)
      if (c >= 160.98 && c < 161.06) {
        const u = (c - 160.98) / 0.08;
        ctx.save();
        ctx.globalAlpha = 0.65;
        rect(ctx, 446, -40 + u * 220, 14, 46, "rgba(20,20,20,0.9)");
        ctx.restore();
      }
      // 경보 깜빡임 02:41~02:46
      if (c >= 161 && c < 166 && Math.floor(now / 380) % 2 === 0) {
        [
          [408, 236],
          [464, 236],
          [408, 188],
          [464, 188],
        ].forEach(([x, y]) =>
          glow(ctx, x, y, 26, "rgba(255,255,255,0.95)", 0.9),
        );
      }
      // 종이 한 장
      if (c >= 161.4 && c < 175)
        ell(ctx, 492, 252, 6, 3, "rgba(240,240,240,0.7)", 0.4);
    },
  };

  // ── CAM 06 주방 ──
  SCENES.kit = {
    fgY: 290,
    proj: ([x, y]) => ({ x, y, s: 0.66 + (y - 250) * 0.004 }),
    bg(ctx) {
      rect(ctx, 0, 0, W, 28, "#1d2226");
      rect(ctx, 0, 28, W, 206, "#c9d2d4");
      for (let y = 28; y < 234; y += 15)
        line(ctx, 0, y, W, y, "rgba(90,100,105,0.5)", 1);
      for (let y = 28, k = 0; y < 234; y += 15, k++)
        for (let x = (k % 2) * 7; x < W; x += 15)
          line(ctx, x, y, x, y + 15, "rgba(90,100,105,0.4)", 1);
      rect(
        ctx,
        0,
        28,
        W,
        206,
        lg(ctx, 0, 28, 0, 234, [
          [0, "rgba(0,0,0,0.45)"],
          [1, "rgba(0,0,0,0.15)"],
        ]),
      );
      // 후드
      poly(
        ctx,
        [
          [320, 30],
          [530, 30],
          [510, 92],
          [340, 92],
        ],
        lg(ctx, 320, 0, 530, 0, [
          [0, "#8f989c"],
          [0.5, "#c8cfd2"],
          [1, "#868f93"],
        ]),
      );
      for (let i = 0; i < 10; i++)
        line(ctx, 348 + i * 17, 84, 352 + i * 17, 92, "#555", 1);
      // 레인지
      rect(ctx, 340, 186, 170, 50, "#2b2f33");
      rect(ctx, 340, 186, 170, 6, "#9aa3a7");
      [370, 420, 470].forEach((x) => {
        ell(ctx, x, 189, 14, 3.5, "#111");
        ell(ctx, x, 189, 8, 2, "#333");
      });
      for (let i = 0; i < 6; i++) ell(ctx, 360 + i * 26, 214, 3, 3, "#888");
      // 선반 + 통
      rect(ctx, 110, 76, 150, 5, "#8a9296");
      rect(ctx, 110, 118, 150, 5, "#8a9296");
      const cols = ["#c2462f", "#e0c060", "#4f7a9a", "#d8d8d8", "#7a9a50"];
      for (let i = 0; i < 9; i++)
        rect(
          ctx,
          114 + i * 16,
          56 + (i % 2) * 4,
          12,
          20 - (i % 2) * 4,
          cols[i % 5],
        );
      for (let i = 0; i < 7; i++)
        rect(ctx, 116 + i * 20, 100, 16, 18, i % 2 ? "#b8bfc2" : "#d0d6d8");
      // 걸린 국자·팬
      line(ctx, 120, 140, 300, 140, "#6a7276", 2);
      [130, 158, 190, 222, 258, 286].forEach((x, i) => {
        line(ctx, x, 140, x, 150 + (i % 3) * 4, "#8a9296", 1.5);
        if (i % 2) ell(ctx, x, 168 + (i % 3) * 4, 10, 10, "#3b3f43");
        else {
          line(ctx, x, 150, x, 176, "#9aa", 2);
          ell(ctx, x, 178, 5, 3, "#9aa");
        }
      });
      // 싱크대
      rect(ctx, 440, 198, 130, 40, "#9aa3a7");
      rect(ctx, 452, 202, 106, 10, "#3a4044");
      line(ctx, 505, 202, 505, 172, "#c0c7ca", 3);
      line(ctx, 505, 172, 520, 172, "#c0c7ca", 3);
      // 쓰레기통
      rect(ctx, 580, 220, 40, 50, "#2a2f33");
      rect(ctx, 576, 216, 48, 6, "#3a4044");
      // 스윙 도어
      rect(ctx, 22, 100, 80, 176, "#5c666c");
      rect(
        ctx,
        28,
        106,
        68,
        170,
        lg(ctx, 28, 0, 96, 0, [
          [0, "#8b969c"],
          [1, "#6c767c"],
        ]),
      );
      ell(ctx, 62, 150, 16, 16, "#30383d");
      ell(ctx, 62, 150, 13, 13, "#d8c49a");
      glow(ctx, 62, 150, 30, "rgba(255,220,160,0.7)", 0.5);
      rect(ctx, 34, 230, 56, 8, "#4a5258");
      // 바닥 타일
      rect(ctx, 0, 234, W, 126, "#5a3a30");
      for (let y = 234, k = 0; y < 360; y += 10 + k * 3, k++)
        line(ctx, 0, y, W, y, "rgba(0,0,0,0.3)", 1);
      for (let i = -10; i < 20; i++)
        line(ctx, 320 + i * 22, 234, 320 + i * 60, 360, "rgba(0,0,0,0.25)", 1);
      // 형광등
      rect(ctx, 150, 6, 340, 8, "#f0fbff");
      glow(ctx, 320, 12, 260, "rgba(225,245,255,0.55)", 0.5);
    },
    fg(ctx) {
      // 아일랜드 조리대
      rect(
        ctx,
        140,
        284,
        400,
        12,
        lg(ctx, 0, 284, 0, 296, [
          [0, "#dfe5e7"],
          [1, "#98a1a5"],
        ]),
      );
      rect(
        ctx,
        146,
        296,
        388,
        64,
        lg(ctx, 146, 0, 534, 0, [
          [0, "#7a8387"],
          [0.5, "#a4acb0"],
          [1, "#737c80"],
        ]),
      );
      for (let i = 0; i < 4; i++) {
        ctx.strokeStyle = tone("rgba(0,0,0,0.35)");
        ctx.strokeRect(152 + i * 96, 302, 88, 54);
        rect(ctx, 180 + i * 96, 312, 32, 3, "#d0d6d8");
      }
      // 조리대 위 소품
      rect(ctx, 200, 270, 40, 14, "#d8c6a4");
      ell(ctx, 300, 280, 14, 4, "#c4ccd0");
      rect(ctx, 400, 266, 10, 18, "#a33");
    },
    dyn(ctx, c, now) {
      if (Math.sin(now / 41) * Math.sin(now / 97) > 0.93)
        rect(ctx, 0, 0, W, H, "rgba(0,0,0,0.3)");
    },
  };

  // ── CAM 07 옥상 (적외선) ──
  SCENES.roof = {
    proj: ([x, y]) => ({ x, y, s: 0.66 + (y - 205) * 0.005 }),
    bg(ctx) {
      rect(
        ctx,
        0,
        0,
        W,
        210,
        lg(ctx, 0, 0, 0, 210, [
          [0, "#05070a"],
          [1, "#1a2230"],
        ]),
      );
      const r = rng(11);
      for (let i = 0; i < 6; i++)
        ell(
          ctx,
          r() * W,
          30 + r() * 60,
          80 + r() * 80,
          14 + r() * 12,
          "rgba(60,70,90,0.18)",
        );
      // 도시 스카이라인
      let x = 0;
      while (x < W) {
        const w = 18 + r() * 40,
          h = 30 + r() * 90;
        rect(ctx, x, 200 - h, w, h, r() > 0.5 ? "#0e1218" : "#131820");
        for (let wy = 200 - h + 5; wy < 196; wy += 7)
          for (let wx = x + 3; wx < x + w - 3; wx += 6) {
            if (r() > 0.72)
              rect(ctx, wx, wy, 2.5, 3, r() > 0.3 ? "#d8c890" : "#9ab8d8");
          }
        if (r() > 0.8) {
          line(ctx, x + w / 2, 200 - h, x + w / 2, 186 - h, "#333", 1);
          ell(ctx, x + w / 2, 186 - h, 1.5, 1.5, "#ff4040");
        }
        x += w + 2;
      }
      // 간판 (뒤에서 본 HAEWOL)
      for (let i = 0; i < 7; i++)
        line(ctx, 470 + i * 25, 54, 470 + i * 25, 128, "#2a2d33", 2);
      line(ctx, 466, 62, 624, 62, "#2a2d33", 2);
      line(ctx, 466, 122, 624, 122, "#2a2d33", 2);
      ctx.save();
      ctx.translate(546, 92);
      ctx.scale(-1, 1);
      ctx.shadowColor = tone("rgba(255,90,90,0.9)");
      ctx.shadowBlur = 14;
      text(
        ctx,
        "HAEWOL",
        0,
        0,
        "bold 36px Georgia, serif",
        "#ff8a7a",
        "center",
      );
      ctx.restore();
      glow(ctx, 546, 92, 120, "rgba(255,120,110,0.6)", 0.4);
      // 옥상 바닥
      rect(
        ctx,
        0,
        204,
        W,
        156,
        lg(ctx, 0, 204, 0, 360, [
          [0, "#2a2e33"],
          [1, "#3e4349"],
        ]),
      );
      for (let i = 0; i < 900; i++)
        rect(
          ctx,
          r() * W,
          206 + r() * 154,
          1.5,
          1.5,
          `rgba(${r() > 0.5 ? "255,255,255" : "0,0,0"},${r() * 0.12})`,
        );
      [
        [300, 300, 70, 10],
        [500, 270, 50, 7],
        [180, 330, 50, 8],
      ].forEach(([px, py, a, b]) => {
        ell(ctx, px, py, a, b, "rgba(140,150,170,0.2)");
        glow(ctx, px, py - 2, a * 0.7, "rgba(255,140,130,0.25)", 0.35);
      });
      // 난간 (끝)
      line(ctx, 150, 186, 640, 186, "#8a9096", 3);
      line(ctx, 150, 197, 640, 197, "#6a7076", 2);
      for (let px = 150; px <= 640; px += 34)
        line(ctx, px, 186, px, 207, "#6a7076", 2.5);
      line(ctx, 150, 186, 150, 207, "#8a9096", 3);
      rect(ctx, 150, 205, 490, 4, "#55595e");
      // 출입문 구조물
      poly(
        ctx,
        [
          [22, 108],
          [158, 108],
          [158, 262],
          [22, 262],
        ],
        "#3a3f45",
      );
      poly(
        ctx,
        [
          [16, 100],
          [166, 100],
          [158, 112],
          [22, 112],
        ],
        "#2a2e33",
      );
      rect(
        ctx,
        70,
        168,
        52,
        94,
        lg(ctx, 70, 0, 122, 0, [
          [0, "#6a7279"],
          [1, "#4c535a"],
        ]),
      );
      rect(ctx, 110, 212, 8, 3, "#c0c6ca");
      ell(ctx, 96, 154, 8, 4, "#fff2c8");
      glow(ctx, 96, 158, 60, "rgba(255,240,200,0.8)", 0.55);
      rect(ctx, 38, 130, 22, 14, "#d8d0b0");
      text(ctx, "흡연", 49, 137, "bold 6px sans-serif", "#222", "center");
      // 물탱크
      line(ctx, 538, 250, 538, 300, "#3a3e42", 4);
      line(ctx, 606, 250, 606, 300, "#3a3e42", 4);
      ctx.fillStyle = lg(ctx, 524, 0, 620, 0, [
        [0, "#4a4f55"],
        [0.4, "#8a9096"],
        [1, "#3e4348"],
      ]);
      ctx.beginPath();
      ctx.roundRect(524, 160, 96, 96, 8);
      ctx.fill();
      for (let i = 0; i < 5; i++)
        line(ctx, 524, 176 + i * 18, 620, 176 + i * 18, "rgba(0,0,0,0.3)", 1.5);
      ell(ctx, 572, 160, 48, 8, "#6a7076");
      // 실외기
      rect(ctx, 176, 292, 92, 58, "#565b61");
      ell(ctx, 222, 321, 22, 22, "#2a2e33");
      for (let i = 0; i < 8; i++)
        line(ctx, 202 + i * 5.5, 301, 202 + i * 5.5, 341, "#3e4348", 1);
      // 배관
      line(ctx, 0, 280, 170, 280, "#4a4f55", 5);
      line(ctx, 0, 288, 170, 288, "#3a3e42", 3);
    },
    dyn(ctx, c, now) {
      // 떨어진 서류 (02:41~02:42.4)
      if (c >= 160.9 && c < 162.4) {
        [
          [372, 214, 0.3],
          [392, 220, -0.4],
          [355, 222, 0.8],
        ].forEach(([x, y, a]) => {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(a);
          rect(ctx, -5, -3.5, 10, 7, "#e8e8e8");
          ctx.restore();
        });
      }
      if (c >= 160.9 && c < 161.6) {
        ctx.save();
        ctx.translate(400 + (c - 160.9) * 60, 200 - (c - 160.9) * 30);
        ctx.rotate(now / 200);
        rect(ctx, -5, -3.5, 10, 7, "#f0f0f0");
        ctx.restore();
      }
    },
    post(ctx, c, now) {
      // 비
      ctx.save();
      ctx.strokeStyle = "rgba(220,225,230,0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 90; i++) {
        const x = (i * 97 + now * 0.25) % W,
          y = (i * 53 + now * 0.9) % H;
        ctx.moveTo(x, y);
        ctx.lineTo(x - 3, y + 12);
      }
      ctx.stroke();
      ctx.restore();
    },
  };
  SCENES.park.post = SCENES.roof.post;

  // ── CAM 08 관제실 ──
  SCENES.ctrl = {
    proj: ([x, y]) => ({ x, y, s: 0.76 + (y - 250) * 0.0046 }),
    bg(ctx) {
      rect(ctx, 0, 0, W, H, "#0a0e13");
      poly(
        ctx,
        [
          [0, 0],
          [500, 0],
          [500, 236],
          [0, 250],
        ],
        lg(ctx, 0, 0, 0, 250, [
          [0, "#101820"],
          [1, "#18222b"],
        ]),
      );
      poly(
        ctx,
        [
          [500, 0],
          [640, 0],
          [640, 300],
          [500, 236],
        ],
        lg(ctx, 500, 0, 640, 0, [
          [0, "#141d25"],
          [1, "#0c1218"],
        ]),
      );
      poly(
        ctx,
        [
          [0, 250],
          [500, 236],
          [640, 300],
          [640, 360],
          [0, 360],
        ],
        lg(ctx, 0, 240, 0, 360, [
          [0, "#1b2026"],
          [1, "#262c33"],
        ]),
      );
      const r = rng(5);
      for (let i = 0; i < 300; i++)
        rect(ctx, r() * W, 250 + r() * 110, 1.2, 1.2, "rgba(255,255,255,0.03)");
      // 사물함
      for (let i = 0; i < 3; i++) {
        rect(ctx, 24 + i * 40, 86, 38, 162, "#2b333b");
        rect(
          ctx,
          26 + i * 40,
          88,
          34,
          158,
          lg(ctx, 0, 88, 0, 246, [
            [0, "#3a434c"],
            [1, "#2a3138"],
          ]),
        );
        for (let v = 0; v < 4; v++)
          line(
            ctx,
            32 + i * 40,
            100 + v * 4,
            54 + i * 40,
            100 + v * 4,
            "#1a1f24",
            1.2,
          );
        rect(ctx, 52 + i * 40, 160, 3, 12, "#8a939b");
      }
      // 게시물
      rect(ctx, 170, 70, 52, 66, "#d8d4c8");
      text(
        ctx,
        "비상 연락망",
        196,
        80,
        "bold 6px sans-serif",
        "#a22",
        "center",
      );
      for (let i = 0; i < 7; i++)
        line(ctx, 176, 90 + i * 6, 216, 90 + i * 6, "rgba(60,60,60,0.6)", 1);
      rect(ctx, 232, 82, 40, 30, "#c8c2b0");
      text(ctx, "근무 수칙", 252, 92, "5px sans-serif", "#333", "center");
      // 벽시계 테두리
      ell(ctx, 318, 70, 18, 18, "#3a3a3a");
      ell(ctx, 318, 70, 15, 15, "#dedad0");
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        line(
          ctx,
          318 + Math.sin(a) * 12,
          70 - Math.cos(a) * 12,
          318 + Math.sin(a) * 14,
          70 - Math.cos(a) * 14,
          "#333",
          1,
        );
      }
      // 책상
      poly(
        ctx,
        [
          [150, 214],
          [470, 208],
          [492, 236],
          [140, 244],
        ],
        lg(ctx, 0, 208, 0, 244, [
          [0, "#3a3f46"],
          [1, "#2a2e34"],
        ]),
      );
      poly(
        ctx,
        [
          [140, 244],
          [492, 236],
          [492, 270],
          [140, 280],
        ],
        "#1b1f24",
      );
      // 모니터 3대
      [
        [176, 136, 92],
        [276, 128, 104],
        [388, 134, 92],
      ].forEach(([x, y, w], i) => {
        rect(ctx, x, y, w, 66, "#0b0d10");
        rect(ctx, x + 4, y + 4, w - 8, 58, "#0f2a2c");
        for (let gx = 0; gx < 3; gx++)
          for (let gy = 0; gy < 2; gy++)
            rect(
              ctx,
              x + 6 + (gx * (w - 12)) / 3,
              y + 6 + gy * 28,
              (w - 12) / 3 - 2,
              26,
              `rgba(${80 + gx * 20},${140 + gy * 20},${130},0.35)`,
            );
        rect(ctx, x + w / 2 - 4, y + 66, 8, 12, "#111");
        rect(ctx, x + w / 2 - 14, y + 76, 28, 3, "#111");
      });
      // 키보드, 컵, 무전기
      poly(
        ctx,
        [
          [262, 220],
          [372, 218],
          [376, 228],
          [258, 231],
        ],
        "#14171b",
      );
      rect(ctx, 420, 210, 12, 14, "#e9e4dc");
      ell(ctx, 426, 210, 6, 2, "#3a2a1a");
      rect(ctx, 190, 214, 18, 24, "#1e2227");
      line(ctx, 194, 214, 194, 196, "#111", 2);
      // 문 (오른쪽 벽)
      poly(
        ctx,
        [
          [520, 70],
          [600, 62],
          [600, 276],
          [520, 248],
        ],
        "#2e363e",
      );
      poly(
        ctx,
        [
          [526, 76],
          [594, 70],
          [594, 272],
          [526, 246],
        ],
        lg(ctx, 526, 0, 594, 0, [
          [0, "#4a535c"],
          [1, "#353c43"],
        ]),
      );
      poly(
        ctx,
        [
          [546, 96],
          [576, 93],
          [576, 130],
          [546, 132],
        ],
        "#0d1216",
      );
      ell(ctx, 584, 168, 3, 3, "#a9b2ba");
    },
    dyn(ctx, c, now, o) {
      // 모니터 화면 빛
      glow(
        ctx,
        330,
        170,
        200,
        "rgba(70,200,190,0.5)",
        0.32 + Math.sin(now / 400) * 0.03,
      );
      // 벽시계 (내용 시각)
      const hA = (((c / 60) % 12) / 12) * TAU,
        mA = ((c % 60) / 60) * TAU,
        sA = (((c * 60) % 60) / 60) * TAU;
      ctx.lineCap = "round";
      line(
        ctx,
        318,
        70,
        318 + Math.sin(hA) * 7,
        70 - Math.cos(hA) * 7,
        "#111",
        2.2,
      );
      line(
        ctx,
        318,
        70,
        318 + Math.sin(mA) * 11,
        70 - Math.cos(mA) * 11,
        "#111",
        1.4,
      );
      line(
        ctx,
        318,
        70,
        318 + Math.sin(sA) * 12,
        70 - Math.cos(sA) * 12,
        "#a11",
        0.7,
      );
      // 무전기 LED
      if (Math.floor(now / 700) % 2) ell(ctx, 199, 220, 1.6, 1.6, "#3dff9d");
      // 문이 열림 (01:05, 05:27)
      const opening =
        (c >= 65 && c < 65.6) ||
        (!state.kangGone && !o.noKang && c >= 327 && c < 327.8) ||
        (o.forceKang && false);
      if (opening) {
        poly(
          ctx,
          [
            [526, 76],
            [594, 70],
            [594, 272],
            [526, 246],
          ],
          "#d8c49a",
        );
        glow(ctx, 560, 170, 90, "rgba(255,220,160,0.8)", 0.6);
        poly(
          ctx,
          [
            [526, 246],
            [594, 272],
            [460, 330],
            [380, 300],
          ],
          "rgba(255,220,160,0.12)",
        );
        poly(
          ctx,
          [
            [526, 76],
            [560, 60],
            [560, 290],
            [526, 246],
          ],
          "#3d454d",
        );
      }
      if (o.police) {
        const k = Math.floor(now / 260) % 2;
        glow(
          ctx,
          561,
          112,
          70,
          k ? "rgba(255,40,40,0.9)" : "rgba(40,90,255,0.9)",
          0.8,
        );
        glow(
          ctx,
          330,
          120,
          260,
          k ? "rgba(255,40,40,0.4)" : "rgba(40,90,255,0.4)",
          0.25,
        );
      }
    },
  };

  /* ---------------- 장면 합성 ---------------- */
  const bgCache = {},
    fgCache = {};
  function getLayer(cache, id, fn) {
    if (cache[id]) return cache[id];
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");
    IR = !!CAM[id].ir;
    fn(ctx);
    IR = false;
    cache[id] = cv;
    return cv;
  }

  function samplePath(sc, pts, u) {
    if (pts.length === 1) return { pt: pts[0], dir: null };
    const m = sc.metric || ((p) => p);
    const lens = [];
    let tot = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = m(pts[i]),
        b = m(pts[i + 1]);
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 0.0001;
      lens.push(l);
      tot += l;
    }
    let d = clamp(u, 0, 1) * tot;
    for (let i = 0; i < lens.length; i++) {
      if (d <= lens[i] || i === lens.length - 1) {
        const t = clamp(d / lens[i], 0, 1);
        const a = pts[i],
          b = pts[i + 1];
        return { pt: [lerp(a[0], b[0], t), lerp(a[1], b[1], t)], dir: [a, b] };
      }
      d -= lens[i];
    }
    return { pt: pts[pts.length - 1], dir: null };
  }

  function collectPersons(camId, c, o) {
    const sc = SCENES[camId];
    const out = [];
    for (const s of SEG) {
      if (s.cam !== camId || c < s.t0 || c >= s.t1) continue;
      if (s.tag === "approach" && (state.kangGone || o.noKang)) continue;
      if (s.who === "K" && o.forceKang && camId === "ctrl") continue;
      if (s.who === "P" && camId === "ctrl") continue; // 의자 앉은 모습은 따로
      const u = (c - s.t0) / (s.t1 - s.t0);
      const { pt, dir } = samplePath(sc, s.pts, u);
      const p = sc.proj(pt);
      let facing = s.facing || "front";
      let moving = !!dir && !s.still;
      if (dir && !s.facing) {
        const a = sc.proj(dir[0]),
          b = sc.proj(dir[1]);
        const dx = b.x - a.x,
          dy = b.y - a.y;
        if (Math.abs(dx) > Math.abs(dy) * 1.3)
          facing = dx > 0 ? "right" : "left";
        else facing = dy < 0 ? "back" : "front";
      }
      out.push({
        who: s.who,
        x: p.x,
        y: p.y,
        s: p.s,
        facing,
        pose:
          moving && !s.pose
            ? "walk"
            : s.pose === "film" && moving
              ? "film"
              : s.pose || "stand",
        noFolder: s.noFolder,
        eyesGlow: s.eyesGlow,
      });
    }
    if (camId === "elev") {
      const r = rideAt(c);
      if (r && r.pos) {
        const p = sc.proj([r.pos.x, r.pos.y]);
        out.push({
          who: r.r.who,
          x: p.x,
          y: p.y,
          s: p.s,
          facing: r.pos.facing,
          pose: r.pos.walk ? "walk" : "stand",
        });
      }
    }
    if (camId === "ctrl" && o.forceKang) {
      const p = sc.proj(CT.BEHIND);
      out.push({
        who: "K",
        x: p.x,
        y: p.y,
        s: p.s,
        facing: "front",
        pose: "stand",
        eyesGlow: true,
      });
    }
    return out;
  }

  // 화면 효과용 리소스
  const FX = (() => {
    const noises = [];
    for (let k = 0; k < 4; k++) {
      const cv = document.createElement("canvas");
      cv.width = 320;
      cv.height = 180;
      const cx = cv.getContext("2d");
      const id = cx.createImageData(320, 180);
      for (let i = 0; i < id.data.length; i += 4) {
        const v = Math.random() * 255;
        id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
        id.data[i + 3] = 255;
      }
      cx.putImageData(id, 0, 0);
      noises.push(cv);
    }
    const sl = document.createElement("canvas");
    sl.width = 2;
    sl.height = 3;
    const sx = sl.getContext("2d");
    sx.fillStyle = "rgba(0,0,0,0.55)";
    sx.fillRect(0, 2, 2, 1);
    const vig = document.createElement("canvas");
    vig.width = W;
    vig.height = H;
    const vx = vig.getContext("2d");
    const g = vx.createRadialGradient(
      W / 2,
      H / 2,
      H * 0.35,
      W / 2,
      H / 2,
      H * 0.95,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.75)");
    vx.fillStyle = g;
    vx.fillRect(0, 0, W, H);
    return { noises, scan: sl, vig };
  })();
  let scanPattern = null;

  function renderCam(ctx, camId, c, label, o = {}) {
    const sc = SCENES[camId],
      cam = CAM[camId];
    const now = performance.now();
    ctx.save();
    ctx.drawImage(getLayer(bgCache, camId, sc.bg.bind(sc)), 0, 0);
    IR = !!cam.ir;
    if (sc.dyn) sc.dyn(ctx, c, now, o);
    const ps = collectPersons(camId, c, o).sort((a, b) => a.y - b.y);
    let fgDone = !sc.fg;
    const fgImg = sc.fg ? getLayer(fgCache, camId, sc.fg.bind(sc)) : null;
    IR = !!cam.ir;
    // 관제실: 의자/나
    const seated = camId === "ctrl" ? { y: CT.CHAIR[1], seat: true } : null;
    const drawSeat = () => {
      const p = sc.proj(CT.CHAIR);
      if (c >= 65 && c < 66) {
        drawSeated(ctx, p.x, p.y, p.s, now, true);
        const s0 = SEG.find((s) => s.who === "P");
        const { pt, dir } = samplePath(
          sc,
          s0.pts,
          (c - s0.t0) / (s0.t1 - s0.t0),
        );
        const q = sc.proj(pt);
        const a = sc.proj(dir[0]),
          b = sc.proj(dir[1]);
        drawPerson(ctx, "P", q.x, q.y, q.s, {
          facing:
            Math.abs(b.x - a.x) > Math.abs(b.y - a.y)
              ? b.x > a.x
                ? "right"
                : "left"
              : "back",
          pose: "walk",
          tm: now,
        });
      } else drawSeated(ctx, p.x, p.y, p.s, now, c < 65);
    };
    let seatDone = !seated;
    for (const p of ps) {
      if (!seatDone && p.y >= seated.y) {
        drawSeat();
        seatDone = true;
      }
      if (!fgDone && p.y >= sc.fgY) {
        ctx.drawImage(fgImg, 0, 0);
        fgDone = true;
      }
      drawPerson(ctx, p.who, p.x, p.y, p.s, {
        facing: p.facing,
        pose: p.pose,
        tm: now + p.who.charCodeAt(0) * 137,
        noFolder: p.noFolder,
        eyesGlow: p.eyesGlow,
      });
    }
    if (!seatDone) drawSeat();
    if (!fgDone) ctx.drawImage(fgImg, 0, 0);
    if (sc.post) sc.post(ctx, c, now, o);
    IR = false;

    // ── 카메라 효과 ──
    if (cam.ir) {
      ctx.globalCompositeOperation = "soft-light";
      rect(ctx, 0, 0, W, H, "rgba(120,140,120,0.25)");
      ctx.globalCompositeOperation = "source-over";
    }
    if (state.fx || o.forceFx) {
      ctx.globalAlpha = cam.ir ? 0.13 : 0.08;
      ctx.drawImage(FX.noises[Math.floor(now / 50) % 4], 0, 0, W, H);
      ctx.globalAlpha = 1;
      if (!scanPattern) scanPattern = ctx.createPattern(FX.scan, "repeat");
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = scanPattern;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      // 가끔 가로 찢김
      if (Math.random() < 0.012) {
        const y = Math.random() * H,
          h = 4 + Math.random() * 14;
        ctx.drawImage(
          ctx.canvas,
          0,
          y,
          W,
          h,
          (Math.random() - 0.5) * 24,
          y,
          W,
          h,
        );
      }
    }
    ctx.drawImage(FX.vig, 0, 0);

    // 옥상 신호 끊김 (02:40:36 ~ 02:41:12)
    if (camId === "roof" && c >= 160.6 && c < 161.2) signalLost(ctx, now);
    else if (camId === "roof" && c >= 160.45 && c < 160.6) {
      for (let i = 0; i < 6; i++) {
        const y = Math.random() * H,
          h = 6 + Math.random() * 20;
        ctx.drawImage(
          ctx.canvas,
          0,
          y,
          W,
          h,
          (Math.random() - 0.5) * 70,
          y,
          W,
          h,
        );
      }
    }

    // ── 오버레이 글자 ──
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 3;
    ctx.font = 'bold 15px "JetBrains Mono", Consolas, monospace';
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillStyle = "#f2f5f2";
    ctx.fillText(`2026-11-25  ${fmtHMS(label)}`, 14, 12);
    ctx.textAlign = "right";
    if (o.playback) {
      ctx.fillStyle = "#ffcf5a";
      ctx.fillText("▶ PLAYBACK", W - 14, 12);
    } else if (Math.floor(now / 600) % 2 === 0) {
      ctx.fillStyle = "#ff3b3b";
      ctx.fillText("● REC", W - 14, 12);
    }
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    ctx.fillStyle = "#f2f5f2";
    ctx.fillText(`${cam.code}  ${cam.en}`, 14, H - 10);
    ctx.textAlign = "right";
    ctx.font = '13px "JetBrains Mono", Consolas, monospace';
    ctx.fillStyle = "#cfd8d6";
    ctx.fillText(cam.ir ? "IR  NIGHT" : "COLOR", W - 14, H - 10);
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  function signalLost(ctx, now) {
    ctx.drawImage(FX.noises[Math.floor(now / 40) % 4], 0, 0, W, H);
    rect(ctx, 0, 0, W, H, "rgba(0,0,0,0.35)");
    for (let i = 0; i < 5; i++)
      rect(
        ctx,
        0,
        Math.random() * H,
        W,
        2 + Math.random() * 6,
        "rgba(255,255,255,0.25)",
      );
    ctx.font = 'bold 22px "JetBrains Mono", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.fillText("SIGNAL LOST", W / 2, H / 2);
  }
  function noSignal(ctx, now, label) {
    rect(ctx, 0, 0, W, H, "#05070a");
    ctx.globalAlpha = 0.18;
    ctx.drawImage(FX.noises[Math.floor(now / 60) % 4], 0, 0, W, H);
    ctx.globalAlpha = 1;
    const bars = ["#555", "#664", "#466", "#464", "#646", "#644", "#446"];
    bars.forEach((b, i) => rect(ctx, 120 + i * 57, 110, 57, 90, b));
    ctx.globalAlpha = 0.5;
    rect(ctx, 0, 0, W, H, "#000");
    ctx.globalAlpha = 1;
    ctx.font = 'bold 20px "JetBrains Mono", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#d8dedd";
    ctx.fillText("NO SIGNAL", W / 2, H / 2 + 60);
    ctx.font = '13px "JetBrains Mono", monospace';
    ctx.fillStyle = "#7d8a8a";
    ctx.fillText(label || "카메라를 선택하세요", W / 2, H / 2 + 86);
  }
  function switching(ctx, now) {
    ctx.drawImage(FX.noises[Math.floor(now / 30) % 4], 0, 0, W, H);
    rect(ctx, 0, 0, W, H, "rgba(10,20,20,0.4)");
  }

  /* ---------------- 사건 · 무전 · 출입 기록 ---------------- */
  const alive = () => !state.kangGone;
  const EVENTS = [
    {
      t: "01:05",
      k: "sys",
      who: "NIGHTWATCH",
      text: "근무 시작. 모니터 A에는 CAM 01 로비가 연결되어 있습니다. 왼쪽 목록에서 모니터 B에 띄울 카메라를 고르세요.",
    },
    {
      t: "01:06",
      k: "radio",
      who: "강도현 지배인",
      text: "윤재 씨, 첫날이죠? 화면 여덟 개 다 볼 생각 하지 마요. 두 개만 골라서 봐요. 이상한 거 보이면 나한테 바로 무전하고.",
    },
    {
      t: "01:09",
      k: "sys",
      who: "NIGHTWATCH",
      text: "팁: 📷 캡처한 장면은 타임라인 보드에 쌓입니다. 녹화 다시 보기는 3회까지만 쓸 수 있습니다.",
    },
    {
      t: "01:20",
      k: "radio",
      who: "강도현 지배인",
      text: "나 지금 로비에서 주방 쪽으로 갑니다. 잠깐 로비 비어요.",
    },
    {
      t: "01:40",
      k: "radio",
      who: "강도현 지배인",
      text: "다시 로비 데스크 왔어요.",
    },
    {
      t: "02:00",
      k: "sys",
      who: "ACS",
      text: "옥상 흡연구역 운영 종료 — 옥상 출입문이 자동으로 잠겼습니다.",
    },
    {
      t: "02:41",
      k: "amb",
      text: "멀리서 자동차 경보음이 울린다.",
      snd: "alarm",
    },
    {
      t: "02:42",
      k: "radio",
      who: "강도현 지배인",
      text: "윤재 씨, 나 아직 로비 데스크예요. 화면에 나 보이죠? 7층은 조용하죠?",
    },
    {
      t: "02:52",
      k: "radio",
      who: "강도현 지배인",
      text: "아까 그 경보는 주차장 고양이예요. 차 위로 자주 뛰어올라요. 신경 쓰지 마요.",
    },
    {
      t: "03:30",
      k: "phone",
      who: "내선 701 · 서미란",
      text: "관제실이죠? 아까… 두 시 사십 분쯤이었나, 위에서 뭐가 쿵 하는 소리가 났어요. 옆 704호 아가씨도 아직 안 들어온 것 같고.",
      snd: "phone",
    },
    {
      t: "03:34",
      k: "radio",
      who: "강도현 지배인",
      text: "701호 할머니 원래 잠 못 주무세요. 매일 밤 전화하세요. 괜찮아요.",
    },
    {
      t: "04:16",
      k: "radio",
      who: "강도현 지배인",
      text: "주방 정리 좀 하고 올게요.",
    },
    {
      t: "04:40",
      k: "sys",
      who: "NIGHTWATCH",
      text: "보고서 제출 마감까지 1시간 20분 남았습니다.",
    },
    {
      t: "05:00",
      k: "radio",
      who: "강도현 지배인",
      text: "보고서는 여섯 시 전에 나한테 올리면 돼요. 수신처는 건드리지 말고.",
    },
    {
      t: "05:24",
      k: "radio",
      who: "강도현 지배인",
      text: "순찰 한 바퀴 돌고 올게요. 무전 잠깐 꺼 둡니다.",
      cond: alive,
    },
    {
      t: "05:27",
      k: "amb",
      text: "등 뒤에서 아주 작은 '딸깍' 소리가 났다.",
      snd: "click",
      cond: alive,
    },
    {
      t: "05:30",
      k: "sys",
      who: "NIGHTWATCH",
      text: "보고서 제출 마감까지 30분 남았습니다.",
    },
    {
      t: "05:45",
      k: "amb",
      text: "누군가 숨 쉬는 소리가 들린 것 같다.",
      snd: "breath",
      cond: alive,
    },
    {
      t: "05:55",
      k: "amb",
      text: "목덜미가 서늘하다. 뒤를 돌아볼 용기가 나지 않는다.",
      cond: alive,
    },
  ].map((e) => ({ ...e, tm: T(e.t) }));

  const LOGS = [
    ["01:05", "관제실 출입문", "YOON_J (근무자) 입실"],
    ["01:08", "703호", "내부에서 열림"],
    ["01:09", "엘리베이터", "703호 카드 · 7F → 1F"],
    ["01:11", "1층 정문", "703호 카드 · 나감"],
    ["01:16", "1층 정문", "703호 카드 · 들어옴"],
    ["01:17", "엘리베이터", "703호 카드 · 1F → 7F"],
    ["01:19", "703호", "카드 · 열림"],
    ["01:21", "주방 출입문", "KANG_DH (마스터)"],
    ["01:38", "704호", "내부에서 열림"],
    ["01:39", "702호", "내부에서 열림"],
    ["01:46", "704호", "카드 · 열림"],
    ["01:47", "엘리베이터", "702호 카드 · 7F → 1F"],
    ["01:48", "703호", "내부에서 열림"],
    ["01:49", "1층 정문", "702호 카드 · 나감"],
    ["01:50", "옥상 출입문", "열림 (흡연구역 운영 중)"],
    ["01:57", "1층 정문", "702호 카드 · 들어옴"],
    ["01:58", "엘리베이터", "702호 카드 · 1F → 7F"],
    ["02:00", "702호", "카드 · 열림"],
    ["02:00", "옥상 출입문", "자동 잠금 (흡연구역 운영 종료)"],
    ["02:04", "옥상 출입문", "내부에서 열림"],
    ["02:06", "703호", "카드 · 열림"],
    ["02:10", "701호", "내부에서 열림"],
    ["02:20", "701호", "카드 · 열림"],
    ["02:31", "704호", "내부에서 열림"],
    ["02:33", "옥상 출입문", "원격 잠금 해제 · 관리자 계정 kang_dh"],
    ["02:34", "엘리베이터", "KANG_DH (마스터) · 1F → 7F"],
    ["02:46", "옥상 출입문", "원격 잠금 · 관리자 계정 kang_dh"],
    ["02:46", "엘리베이터", "KANG_DH (마스터) · 7F → 1F"],
    ["04:17", "주방 출입문", "KANG_DH (마스터)"],
    ["04:50", "701호", "내부에서 열림"],
    ["04:58", "701호", "카드 · 열림"],
    ["05:27", "관제실 출입문", "KANG_DH (마스터)", true],
  ].map(([t, loc, txt, alert]) => ({ tm: T(t), t, loc, txt, alert }));

  const GUESTS = [
    {
      id: "S",
      room: "701",
      desc: "74세 · 장기 투숙 3년째. 밤잠이 없어 복도를 자주 산책함.",
    },
    {
      id: "O",
      room: "702",
      desc: "46세 · 호텔 매수 측(해담개발) 협상 대리인.",
    },
    {
      id: "T",
      room: "703",
      desc: '27세 · 유튜버. "폐업 직전 호텔" 촬영 허가 (옥상 촬영은 불가).',
    },
    {
      id: "M",
      room: "704",
      desc: "34세 · 감정평가사. 매각 전 시설 실사 중. 11/25 체크아웃 예정.",
    },
    {
      id: "K",
      room: "직원",
      desc: "52세 · 지배인. 야간 책임자. 마스터카드와 관리자 계정 kang_dh 보유.",
    },
    {
      id: "P",
      room: "관제",
      desc: "23세 · 야간 관제 아르바이트. 오늘이 근무 1일 차.",
    },
  ];

  const JOURNAL = `[11/15] 한기수: 인수인계 받음. 모니터 두 대, 카메라 여덟 대.
         다 못 보는 게 정상이라고 함.
[11/16] 한기수: 704호 손님(평가사)이 소방 설비 점검 기록을 달라고 함.
         지배인님이 주지 말라고 하심.
[11/17] 한기수: 지배인님이 밤늦게 시스템 설정을 바꾸심. "끊김 방지"라고.
[11/18] 한기수: 화면이 좀 늦는 것 같다. 로비 벽시계랑 화면 시계가 안 맞음.
         말씀드렸더니 원래 그렇다고.
[11/19] 한기수: 그만둡니다.
         다음 사람에게 — 이상하면 지배인 말고 바로 112로.`;

  /* ---------------- UI ---------------- */
  const monEls = [$("#mon-0"), $("#mon-1")];
  const monCtx = monEls.map((m) => $("canvas", m).getContext("2d"));
  const pbCanvas = $("#pb-canvas"),
    pbCtx = pbCanvas.getContext("2d");
  let zTop = 10;

  // 입력칸 포커스·키보드 때문에 overflow:hidden 영역이 몰래 스크롤되는 것 막기
  ["#viewport", "#stage", "#desktop"].forEach((sel) => {
    const el = $(sel);
    el.addEventListener("scroll", () => {
      if (el.scrollTop || el.scrollLeft) {
        el.scrollTop = 0;
        el.scrollLeft = 0;
      }
    });
  });
  addEventListener("scroll", () => {
    if (scrollX || scrollY) scrollTo(0, 0);
  });

  // 창이 데스크톱(864×508) 밖으로 나가지 않게: 제목 표시줄은 항상 보이도록
  function fitWin(win) {
    if (!win || win.classList.contains("hidden")) return;
    const h = win.offsetHeight,
      w = win.offsetWidth;
    let top = win.offsetTop,
      left = win.offsetLeft;
    if (top + h > 508) top = Math.max(0, 508 - h);
    if (left + w > 864) left = Math.max(0, 864 - w);
    win.style.top = top + "px";
    win.style.left = left + "px";
  }

  function focusWin(win) {
    $$(".win.focus").forEach((w) => w.classList.remove("focus"));
    win.classList.add("focus");
    win.style.zIndex = ++zTop;
    if (win.classList.contains("monitor"))
      selectMonitor(Number(win.id.slice(-1)));
  }
  function makeDraggable(win) {
    const bar = $(".win-title", win);
    bar.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      focusWin(win);
      const sx = e.clientX,
        sy = e.clientY,
        ox = win.offsetLeft,
        oy = win.offsetTop;
      try {
        bar.setPointerCapture(e.pointerId);
      } catch (_) {}
      const mv = (ev) => {
        const dx = (ev.clientX - sx) / SCALE,
          dy = (ev.clientY - sy) / SCALE;
        win.style.left = clamp(ox + dx, -win.offsetWidth + 90, 864 - 90) + "px";
        win.style.top = clamp(oy + dy, 0, 508 - 24) + "px";
      };
      const up = () => {
        bar.removeEventListener("pointermove", mv);
        bar.removeEventListener("pointerup", up);
        bar.removeEventListener("pointercancel", up);
      };
      bar.addEventListener("pointermove", mv);
      bar.addEventListener("pointerup", up);
      bar.addEventListener("pointercancel", up);
    });
    win.addEventListener("pointerdown", () => {
      if (!win.classList.contains("focus")) focusWin(win);
    });
  }
  $$(".win").forEach(makeDraggable);

  function openApp(name, toggle) {
    const win = $(`[data-win="${name}"]`);
    if (!win) return;
    const btn = $(`[data-open="${name}"]`);
    if (
      toggle &&
      !win.classList.contains("hidden") &&
      win.classList.contains("focus")
    ) {
      closeApp(name);
      return;
    }
    win.classList.remove("hidden");
    if (btn) btn.classList.add("open");
    focusWin(win);
    if (name === "radio") {
      state.radioUnread = 0;
      updateBadge();
    }
    if (name === "playback") updatePbRange(true);
    fitWin(win);
  }
  function closeApp(name) {
    const win = $(`[data-win="${name}"]`);
    win.classList.add("hidden");
    win.classList.remove("focus");
    const btn = $(`[data-open="${name}"]`);
    if (btn) btn.classList.remove("open");
    if (name === "playback") stopPlayback("재생 대기");
  }
  $$("[data-open]").forEach((b) =>
    b.addEventListener("click", () => openApp(b.dataset.open, true)),
  );
  $$(".win-close").forEach((b) =>
    b.addEventListener("click", () => closeApp(b.closest(".win").dataset.win)),
  );

  // 카메라 목록
  const camList = $("#cam-list");
  CAMS.forEach((cam) => {
    const li = document.createElement("li");
    li.dataset.cam = cam.id;
    li.innerHTML = `<div class="thumb"></div><div class="cname"><b>${cam.code}${cam.ir ? " · IR" : ""}</b><span>${cam.name}</span></div><span class="ctag">-</span>`;
    li.addEventListener("click", () => assignCam(cam.id));
    camList.appendChild(li);
  });
  function selectMonitor(i) {
    state.sel = i;
    $$(".mon-pick").forEach((b) =>
      b.classList.toggle("active", Number(b.dataset.mon) === i),
    );
  }
  $$(".mon-pick").forEach((b) =>
    b.addEventListener("click", () => {
      selectMonitor(Number(b.dataset.mon));
      focusWin(monEls[state.sel]);
    }),
  );
  function assignCam(id) {
    if (state.ended) return;
    const other = state.mon.indexOf(id);
    if (other !== -1) {
      selectMonitor(other);
      focusWin(monEls[other]);
      return;
    }
    state.mon[state.sel] = id;
    state.monSwitch[state.sel] = performance.now();
    Sfx.stat(0.2);
    refreshMonitors();
  }
  function refreshMonitors() {
    state.mon.forEach((id, i) => {
      $(".mon-cam", monEls[i]).textContent = id
        ? `${CAM[id].code} ${CAM[id].name}`
        : "신호 없음";
      monEls[i].classList.toggle("noise", !id);
      monEls[i].classList.toggle("live0", state.buf === 0);
    });
    $$("#cam-list li").forEach((li) => {
      const i = state.mon.indexOf(li.dataset.cam);
      li.classList.toggle("on-0", i === 0);
      li.classList.toggle("on-1", i === 1);
      $(".ctag", li).textContent = i === -1 ? "-" : i === 0 ? "A" : "B";
    });
  }

  // 캡처
  function makeThumb(src) {
    const cv = document.createElement("canvas");
    cv.width = 224;
    cv.height = 126;
    cv.getContext("2d").drawImage(src, 0, 0, 224, 126);
    return cv.toDataURL("image/jpeg", 0.7);
  }
  function capture(src, camId, label, fromPb) {
    state.captures.push({
      img: makeThumb(src),
      cam: camId,
      label,
      pb: fromPb,
      note: "",
    });
    Sfx.click();
    toast(
      "sys",
      "NIGHTWATCH",
      `${CAM[camId].code} ${fmtHMS(label)} 장면을 타임라인 보드에 저장했습니다.`,
      2600,
    );
    renderTimeline();
  }
  $$(".mt-cap").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.mon),
        id = state.mon[i];
      if (!id) {
        toast(
          "sys",
          "NIGHTWATCH",
          "신호가 없는 모니터는 캡처할 수 없습니다.",
          2400,
        );
        return;
      }
      capture($("canvas", monEls[i]), id, state.g, false);
    }),
  );
  $$(".mt-play").forEach((b) =>
    b.addEventListener("click", () => {
      const id = state.mon[Number(b.dataset.mon)];
      if (!id) {
        toast("sys", "NIGHTWATCH", "먼저 카메라를 연결하세요.", 2400);
        return;
      }
      openApp("playback");
      $("#pb-cam").value = id;
      const slider = $("#pb-time");
      slider.value = clamp(
        Math.floor(contentNow()) - 10,
        Number(slider.min),
        Number(slider.max),
      );
      updatePbLabel();
    }),
  );

  function renderTimeline() {
    const board = $("#tl-board");
    if (!state.captures.length) {
      board.innerHTML = '<p class="empty">아직 캡처한 장면이 없습니다.</p>';
      return;
    }
    board.innerHTML = "";
    [...state.captures]
      .map((cpt, idx) => ({ cpt, idx }))
      .sort((a, b) => a.cpt.label - b.cpt.label)
      .forEach(({ cpt, idx }) => {
        const d = document.createElement("div");
        d.className = "tl-card" + (cpt.pb ? " pb-src" : "");
        d.innerHTML = `<img src="${cpt.img}" alt=""><div class="tl-meta"><b>${fmtHMS(cpt.label)}</b><span>${CAM[cpt.cam].code}</span></div><div class="tl-note"></div>`;
        $(".tl-note", d).textContent = cpt.note;
        d.addEventListener("click", (e) => {
          if (e.target.tagName === "INPUT") return;
          const note = $(".tl-note", d);
          const inp = document.createElement("input");
          inp.value = cpt.note;
          inp.placeholder = "메모 입력 후 Enter";
          Object.assign(inp.style, {
            width: "100%",
            background: "#081013",
            border: "1px solid #2b3e47",
            color: "#ffb547",
            fontSize: "11px",
            padding: "2px 4px",
          });
          note.innerHTML = "";
          note.appendChild(inp);
          inp.focus({ preventScroll: true });
          const save = () => {
            state.captures[idx].note = inp.value.trim();
            renderTimeline();
          };
          inp.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") save();
          });
          inp.addEventListener("blur", save);
        });
        board.appendChild(d);
      });
    fitWin($("#win-timeline"));
  }

  // 다시 보기
  const pbSel = $("#pb-cam");
  CAMS.forEach((cam) => {
    const op = document.createElement("option");
    op.value = cam.id;
    op.textContent = `${cam.code} ${cam.name}`;
    pbSel.appendChild(op);
  });
  const pbSlider = $("#pb-time");
  function updatePbRange(resetValue) {
    const minC = START - 10,
      maxC = Math.max(minC, Math.floor(contentNow()) - 1);
    pbSlider.min = minC;
    pbSlider.max = maxC;
    if (resetValue) pbSlider.value = clamp(maxC - 10, minC, maxC);
    updatePbLabel();
  }
  function updatePbLabel() {
    $("#pb-time-label").textContent = fmtHM(labelFor(Number(pbSlider.value)));
  }
  pbSlider.addEventListener("input", updatePbLabel);
  function updatePbButtons() {
    $("#pb-credits").textContent = state.pb.credits;
    const play = $("#pb-play");
    play.disabled = state.pb.credits <= 0 || state.pb.playing;
    play.textContent =
      state.pb.credits <= 0 ? "재생 횟수 소진" : "▶ 재생 (1회 사용)";
    $("#pb-pause").disabled = !state.pb.playing;
    $("#pb-cap").disabled = !state.pb.playing;
    $("#pb-pause").textContent = state.pb.paused ? "▶" : "❚❚";
  }
  $("#pb-play").addEventListener("click", () => {
    if (state.pb.credits <= 0 || state.pb.playing) return;
    state.pb.credits--;
    state.pb.playing = true;
    state.pb.paused = false;
    state.pb.cam = pbSel.value;
    state.pb.start = state.pb.pos = Number(pbSlider.value);
    $("#pb-overlay").classList.add("hidden");
    pbSel.disabled = true;
    pbSlider.disabled = true;
    Sfx.stat(0.3);
    updatePbButtons();
  });
  $("#pb-pause").addEventListener("click", () => {
    state.pb.paused = !state.pb.paused;
    updatePbButtons();
  });
  $("#pb-cap").addEventListener("click", () =>
    capture(pbCanvas, state.pb.cam, labelFor(state.pb.pos), true),
  );
  function stopPlayback(msg) {
    if (state.pb.playing) state.pb.playing = false;
    state.pb.paused = false;
    const ov = $("#pb-overlay");
    ov.textContent = msg;
    ov.classList.remove("hidden");
    pbSel.disabled = false;
    pbSlider.disabled = false;
    updatePbButtons();
  }
  function updatePlayback(dt) {
    if (!state.pb.playing || state.pb.paused) return;
    state.pb.pos += dt / PB_MIN_MS;
    if (state.pb.pos >= state.pb.start + 10 || state.pb.pos >= contentNow())
      stopPlayback("재생 종료 — 10분 분량을 모두 봤습니다");
  }

  // 출입 기록
  function pushLog(l) {
    const tb = $("#access-body");
    const tr = document.createElement("tr");
    tr.className = "new" + (l.alert ? " alert" : "");
    tr.innerHTML = `<td>${l.t}</td><td></td><td></td>`;
    tr.children[1].textContent = l.loc;
    tr.children[2].textContent = l.txt;
    tb.prepend(tr);
  }

  // 무전 · 토스트
  function updateBadge() {
    const b = $("#radio-badge");
    b.textContent = state.radioUnread;
    b.classList.toggle("hidden", state.radioUnread === 0);
  }
  function addRadio(kind, who, txt) {
    const li = document.createElement("li");
    li.className = kind === "phone" ? "phone" : kind === "amb" ? "amb" : "";
    li.innerHTML = `<span class="r-head"></span><span class="r-text"></span>`;
    li.firstChild.textContent = `${fmtHM(state.g)} · ${who || "…"}`;
    li.lastChild.textContent = txt;
    $("#radio-log").prepend(li);
    if ($("#win-radio").classList.contains("hidden")) {
      state.radioUnread++;
      updateBadge();
    }
  }
  function toast(kind, who, txt, ms = 7000) {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.innerHTML = `<span class="t-head"></span><span></span>`;
    el.firstChild.textContent =
      (kind === "radio"
        ? "⌁ 무전 · "
        : kind === "phone"
          ? "☎ 내선 · "
          : kind === "amb"
            ? ""
            : "ⓘ ") + (who || "");
    if (kind === "amb") el.firstChild.remove();
    el.lastChild.textContent = txt;
    el.addEventListener("click", () => {
      if (kind !== "sys") openApp("radio");
      dismiss();
    });
    const box = $("#toasts");
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    let gone = false;
    function dismiss() {
      if (gone) return;
      gone = true;
      el.classList.add("out");
      setTimeout(() => el.remove(), 400);
    }
    setTimeout(dismiss, ms);
  }
  function fireEvent(e) {
    if (e.cond && !e.cond()) return;
    if (e.k !== "sys") addRadio(e.k, e.who, e.text);
    toast(e.k, e.who, e.text, e.k === "phone" ? 11000 : 8000);
    if (e.k === "radio") {
      Sfx.radio();
      flashLed();
    }
    if (e.snd && Sfx[e.snd]) Sfx[e.snd]();
    if (e.k === "amb" && e.snd === "click") {
      stage.classList.add("shake");
      setTimeout(() => stage.classList.remove("shake"), 450);
    }
  }
  function flashLed() {
    const l = $("#tk-radio-led");
    l.classList.add("on");
    setTimeout(() => l.classList.remove("on"), 1800);
  }
  function processEvents() {
    while (state.evIdx < EVENTS.length && state.g >= EVENTS[state.evIdx].tm)
      fireEvent(EVENTS[state.evIdx++]);
    while (state.logIdx < LOGS.length && state.g >= LOGS[state.logIdx].tm) {
      const l = LOGS[state.logIdx++];
      if (l.alert && state.kangGone) continue;
      pushLog(l);
    }
    for (let i = state.queue.length - 1; i >= 0; i--) {
      if (state.g >= state.queue[i].tm) {
        const q = state.queue.splice(i, 1)[0];
        fireEvent(q);
      }
    }
  }

  // 명부
  (() => {
    const grid = $("#guest-grid");
    GUESTS.forEach((gst) => {
      const d = document.createElement("div");
      d.className = "guest";
      const cv = document.createElement("canvas");
      cv.width = 108;
      cv.height = 144;
      const cx = cv.getContext("2d");
      cx.fillStyle = lg(cx, 0, 0, 0, 144, [
        [0, "#1a262b"],
        [1, "#0b1215"],
      ]);
      cx.fillRect(0, 0, 108, 144);
      drawPerson(cx, gst.id, 54, 290, 1.65, {
        facing: "front",
        pose: "stand",
        tm: 0,
      });
      cx.fillStyle = "rgba(0,0,0,0.15)";
      for (let y = 0; y < 144; y += 3) cx.fillRect(0, y, 108, 1);
      d.appendChild(cv);
      const info = document.createElement("div");
      info.innerHTML = `<div class="g-room">${gst.room}</div><div class="g-name">${LOOK[gst.id].name}</div><div class="g-desc">${gst.desc}</div>`;
      d.appendChild(info);
      grid.appendChild(d);
    });
  })();
  $("#journal-old").textContent = JOURNAL;

  // 설정
  function setBuffer(sec) {
    const b = sec / 60;
    if (b === state.buf) return;
    state.buf = b;
    state.bufHistory.push({ g: state.g, buf: b });
    $$("#seg-buffer button").forEach((x) =>
      x.classList.toggle("active", Number(x.dataset.buf) === sec),
    );
    const tb = $("#tb-buffer");
    tb.textContent = `OUTPUT BUFFER ${sec}s`;
    tb.classList.toggle("live", sec === 0);
    state.monSwitch = [performance.now(), performance.now()];
    Sfx.stat(0.4);
    refreshMonitors();
    updatePbRange(false);
    if (sec === 0)
      toast(
        "sys",
        "NIGHTWATCH",
        "출력 버퍼 0초 — 화면이 실시간으로 전환되었습니다. 건너뛴 10분은 녹화 다시 보기로 확인할 수 있습니다.",
        6000,
      );
    if (sec === 0 && !state.bufWarned && !state.kangGone) {
      state.bufWarned = true;
      state.queue.push({
        tm: state.g + 0.6,
        k: "radio",
        who: "강도현 지배인",
        text: "윤재 씨, 방금 설정 건드렸어요? 버퍼 원래대로 해 놔요. 그거 화면 끊김 방지용이에요.",
      });
    }
  }
  $$("#seg-buffer button").forEach((b) =>
    b.addEventListener("click", () => setBuffer(Number(b.dataset.buf))),
  );
  $$("#seg-sound button").forEach((b) =>
    b.addEventListener("click", () => {
      state.sound = b.dataset.snd === "1";
      Sfx.setOn(state.sound);
      $$("#seg-sound button").forEach((x) =>
        x.classList.toggle("active", x === b),
      );
    }),
  );
  $$("#seg-fx button").forEach((b) =>
    b.addEventListener("click", () => {
      state.fx = b.dataset.fx === "1";
      $$("#seg-fx button").forEach((x) =>
        x.classList.toggle("active", x === b),
      );
    }),
  );

  // 보고서
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/[\s_\-.·()]/g, "")
      .replace(/(님|씨|본인)$/g, "");
  function checkWho(s) {
    const n = norm(s);
    return /강도현|도현|지배인|kangdh|kang/.test(n);
  }
  function checkWhere(s) {
    const n = norm(s);
    return /옥상|rooftop|roof|cam07|캠07/.test(n);
  }
  function parseTime(s) {
    const t = s.trim();
    let m = t.match(/(\d{1,2})\s*시\s*(\d{1,2})/);
    if (!m) m = t.match(/^(\d{1,2})\s*[:;.\s]\s*(\d{1,2})/);
    if (!m) m = t.match(/^(\d{1,2})(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  function checkWhen(s) {
    const v = parseTime(s);
    return v != null && v >= 160 && v <= 162;
  }

  $("#rp-submit").addEventListener("click", () => {
    if (state.ended || state.reportLeft <= 0) return;
    const to = $("#rp-to").value;
    const who = $("#rp-who").value,
      where = $("#rp-where").value,
      when = $("#rp-when").value;
    const msg = $("#rp-msg");
    if (!who.trim() || !where.trim() || !when.trim()) {
      msg.textContent =
        "누가 · 어디서 · 언제를 모두 적어야 제출할 수 있습니다.";
      return;
    }
    const ok = checkWho(who) && checkWhere(where) && checkWhen(when);
    if (ok) {
      triggerEnding(to === "police" ? "live" : "delivered");
      return;
    }
    state.reportLeft--;
    $("#rp-left").textContent = state.reportLeft;
    msg.textContent = "반려되었습니다. 어딘가 맞지 않습니다.";
    Sfx.stat(0.25);
    if (to === "police") {
      const v = parseTime(when);
      const nudge =
        checkWho(who) && checkWhere(where) && v != null && v >= 169 && v <= 172;
      setTimeout(
        () =>
          fireEvent({
            k: "phone",
            who: "해월경찰서 112 상황실",
            text: nudge
              ? "접수 내용의 시각이 출입 기록과 맞지 않습니다. 다시 확인해서 보내 주세요."
              : "접수 내용이 확인되지 않습니다. 다시 확인해서 보내 주세요.",
            snd: "phone",
          }),
        900,
      );
    } else if (!state.kangGone) {
      const accused = checkWho(who);
      setTimeout(
        () =>
          fireEvent({
            k: "radio",
            who: "강도현 지배인",
            text: accused
              ? "…재밌는 보고서네요, 윤재 씨. 다시 써요."
              : "이게 뭐예요. 별일 없었잖아요. 다시 써요.",
          }),
        900,
      );
    }
    if (state.reportLeft <= 0)
      setTimeout(() => triggerEnding("ago", "rejected"), 2600);
  });

  // 일시정지
  function setPause(v) {
    if (!state.running || state.ended) return;
    state.paused = v;
    $("#pause").classList.toggle("hidden", !v);
  }
  $("#btn-pause").addEventListener("click", () => setPause(true));
  $("#btn-resume").addEventListener("click", () => {
    Sfx.resume();
    setPause(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setPause(true);
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.running && !state.ended)
      setPause(!state.paused);
  });

  /* ---------------- 엔딩 ---------------- */
  let endingMode = null;
  function triggerEnding(kind, reason) {
    if (state.ended) return;
    state.ended = true;
    state.running = false;
    stopPlayback("—");
    const endEl = $("#ending"),
      txt = $("#ending-text");
    const camEl = $("#ending-cam");
    txt.innerHTML = "";
    endEl.classList.remove("hidden");
    const lines = [];
    const now = fmtHM(state.g);
    let name = "";
    if (kind === "live") {
      state.kangGone = true;
      const behind = state.g >= 327;
      endingMode = { police: true, noKang: true, buf0: true };
      name = "ENDING · LIVE";
      lines.push([
        "sys",
        `${now} — 보고서 전송 완료 · 수신: 해월경찰서 112 상황실`,
      ]);
      lines.push([
        "",
        '"접수했습니다. 바로 출동합니다. 관제실 문을 잠그고 계세요."',
      ]);
      lines.push([
        "",
        "영상 출력 버퍼를 0초로 바꿨다. 화면 속 시계와 벽시계가 처음으로 같은 시각을 가리켰다.",
        "cam",
      ]);
      lines.push([
        "",
        behind
          ? "그제야 알았다. 내 등 뒤에 서 있던 사람이 천천히 문밖으로 걸어 나가고 있었다는 걸."
          : "CAM 01. 지배인이 데스크에 무전기를 내려놓고, 정문 쪽으로 걸어 나갔다.",
      ]);
      lines.push([
        "",
        `${fmtHM(state.g + 9)}, 해월호텔 앞에 경광등이 번쩍였다.`,
        "siren",
      ]);
      lines.push(["", "그날 밤 처음으로, 화면은 지금을 보여주고 있었다."]);
    } else if (kind === "delivered") {
      endingMode = { forceKang: true };
      name = "ENDING · DELIVERED";
      lines.push(["sys", `${now} — 보고서 전송 완료 · 수신: 지배인 강도현`]);
      lines.push(["", '"…잘 썼네요, 윤재 씨. 너무 잘 썼어."']);
      lines.push(["", "무전이 끊기고, CAM 08 화면이 저절로 떠올랐다.", "cam"]);
      lines.push([
        "",
        "화면 속, 내 의자 바로 뒤에 누군가 서 있다. 카메라를 보고 있다.",
      ]);
      lines.push(["sys", "화면 상단: OUTPUT BUFFER 600s"]);
      lines.push(["bad", "이건 10분 전 화면이다."]);
      lines.push(["sys", "[11/25] 윤재 — 근무 1일 차 · 자진 퇴사 처리"]);
    } else {
      endingMode = { forceKang: true };
      name = "ENDING · TEN MINUTES AGO";
      lines.push([
        "sys",
        reason === "rejected"
          ? `${now} — 보고서 3회 반려 · 제출 권한이 만료되었습니다`
          : "06:00 — 근무 종료 · 보고서 미제출",
      ]);
      lines.push(["", '"첫날 치고는 괜찮았어요, 윤재 씨."']);
      lines.push([
        "bad",
        "그 목소리는 무전기가 아니라, 바로 뒤에서 들렸다.",
        "cam",
      ]);
      lines.push(["", "근무일지에 한 줄이 저절로 추가되었다."]);
      lines.push(["sys", "[11/24] 윤재: 화면이 좀 늦는 것 같다."]);
      $("#journal-old").textContent =
        JOURNAL + "\n[11/24] 윤재: 화면이 좀 늦는 것 같다.";
    }
    Sfx.sting();
    let delay = 600;
    lines.forEach(([cls, s, act]) => {
      const p = document.createElement("p");
      if (cls) p.className = cls;
      p.textContent = s;
      txt.appendChild(p);
      setTimeout(() => {
        p.classList.add("show");
        if (act === "cam") {
          camEl.classList.add("show");
          Sfx.stat(0.5);
        }
        if (act === "siren") Sfx.siren();
      }, delay);
      delay += 2300;
    });
    setTimeout(() => {
      $("#ending-name").textContent = name;
      $("#ending-foot").classList.remove("hidden");
    }, delay + 400);
  }
  $("#btn-restart").addEventListener("click", () => location.reload());
  function renderEnding() {
    if (!endingMode) return;
    const ctx = $("#ending-cam").getContext("2d");
    const c = endingMode.buf0 ? state.g : state.g - 10;
    renderCam(ctx, "ctrl", c, state.g, { ...endingMode, forceFx: true });
  }

  /* ---------------- 타이틀 배경 ---------------- */
  const bootCtx = $("#boot-bg").getContext("2d");
  const bootBuf = document.createElement("canvas");
  bootBuf.width = W;
  bootBuf.height = H;
  function renderBoot() {
    renderCam(
      bootBuf.getContext("2d"),
      "corr",
      52 + performance.now() / 60000,
      62 + performance.now() / 60000,
      { forceFx: true },
    );
    bootCtx.drawImage(bootBuf, 0, 0, 1024, 576);
  }

  /* ---------------- 시작 ---------------- */
  $("#btn-start").addEventListener("click", () => {
    Sfx.init();
    Sfx.resume();
    Sfx.stat(0.6);
    $("#boot").classList.add("hidden");
    state.running = true;
    refreshMonitors();
    selectMonitor(1);
    focusWin(monEls[1]);
    // 시작 시각 이전 기록은 조용히 채워 넣기
    while (state.logIdx < LOGS.length && LOGS[state.logIdx].tm < state.g)
      pushLog(LOGS[state.logIdx++]);
    while (state.evIdx < EVENTS.length && EVENTS[state.evIdx].tm < state.g - 1)
      state.evIdx++;
  });

  /* ---------------- 메인 루프 ---------------- */
  let last = performance.now(),
    lastDraw = 0,
    lastSlider = 0;
  function frame(now) {
    const dt = Math.min(120, now - last);
    last = now;
    if (state.running && !state.paused && !state.ended) {
      state.g += dt / MIN_MS;
      processEvents();
      if (state.g >= END) {
        state.g = END;
        triggerEnding("ago", "timeout");
      }
    }
    if (!state.paused) updatePlayback(dt);

    if (now - lastDraw > 33) {
      lastDraw = now;
      if (!$("#boot").classList.contains("hidden")) renderBoot();
      else if (!state.ended) {
        const c = contentNow();
        state.mon.forEach((id, i) => {
          const ctx = monCtx[i];
          if (!id) noSignal(ctx, now);
          else if (now - state.monSwitch[i] < 320) switching(ctx, now);
          else renderCam(ctx, id, c, state.g);
        });
        if (state.pb.playing)
          renderCam(pbCtx, state.pb.cam, state.pb.pos, labelFor(state.pb.pos), {
            playback: true,
          });
        $("#tb-clock").textContent = fmtHMS(state.g);
        $("#tk-clock").textContent = fmtHM(state.g);
        if (now - lastSlider > 1000) {
          lastSlider = now;
          if (!state.pb.playing) updatePbRange(false);
        }
      } else renderEnding();
    }
    requestAnimationFrame(frame);
  }
  updatePbButtons();
  renderTimeline();
  requestAnimationFrame(frame);

  // 테스트용 훅
  window.__B6 = {
    state,
    renderCam,
    triggerEnding,
    setBuffer,
    assignCam,
    openApp,
    CAMS,
  };
})();
