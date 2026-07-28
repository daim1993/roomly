'use strict';

/**
 * Roomly FX engine — the eye-candy layer.
 *
 * Everything here is decorative and defensive: canvases render at low
 * resolution behind a GPU blur, loops pause when the tab is hidden or the
 * host section is not on screen, and every effect becomes a no-op when the
 * user prefers reduced motion. Nothing in here may ever throw into the app.
 */

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

function motionOk() {
  return !reduced.matches;
}

const PALETTE = [
  [125, 57, 235],   // violet
  [198, 255, 51],   // lime
  [76, 201, 255],   // blue
  [255, 122, 200],  // pink
  [155, 92, 255]    // bright violet
];

// ------------------------------------------------------------------- aurora

const auroras = [];

class Aurora {
  constructor(host, { intensity = 1, blobs = 5 } = {}) {
    this.host = host;
    this.intensity = intensity;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fx-aurora';
    host.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.last = 0;
    this.t = Math.random() * 1000;
    this.blobs = Array.from({ length: blobs }, (_, index) => ({
      color: PALETTE[index % PALETTE.length],
      bx: Math.random(),
      by: Math.random(),
      radius: 0.35 + Math.random() * 0.35,
      sx: 0.12 + Math.random() * 0.2,
      sy: 0.1 + Math.random() * 0.18,
      px: Math.random() * Math.PI * 2,
      py: Math.random() * Math.PI * 2
    }));
  }

  visible() {
    if (document.hidden || this.host.hidden) {
      return false;
    }
    const rect = this.host.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  frame(now) {
    if (!this.visible()) {
      return;
    }
    if (now - this.last < 33) { // ~30fps is plenty behind a 40px blur
      return;
    }
    this.last = now;
    this.t += 0.016;

    const rect = this.host.getBoundingClientRect();
    const width = Math.max(2, Math.floor(rect.width / 4));
    const height = Math.max(2, Math.floor(rect.height / 4));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';

    for (const blob of this.blobs) {
      const x = (blob.bx + 0.22 * Math.sin(this.t * blob.sx + blob.px)) * width;
      const y = (blob.by + 0.2 * Math.cos(this.t * blob.sy + blob.py)) * height;
      const radius = blob.radius * Math.min(width, height) * (1 + 0.12 * Math.sin(this.t * 0.3 + blob.px));
      const [r, g, b] = blob.color;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, Math.max(4, radius));
      gradient.addColorStop(0, `rgba(${r},${g},${b},${0.34 * this.intensity})`);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(4, radius), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawOnce() {
    this.frame(performance.now() + 100);
  }
}

let auroraLoop = null;

function runAuroraLoop() {
  if (auroraLoop) {
    return;
  }
  const tick = (now) => {
    auroraLoop = requestAnimationFrame(tick);
    if (!motionOk()) {
      return;
    }
    for (const aurora of auroras) {
      try {
        aurora.frame(now);
      } catch {}
    }
  };
  auroraLoop = requestAnimationFrame(tick);
}

export function aurora(host, options) {
  if (!host || host.querySelector(':scope > .fx-aurora')) {
    return;
  }
  try {
    const instance = new Aurora(host, options);
    auroras.push(instance);
    instance.drawOnce(); // static frame even for reduced-motion users
    runAuroraLoop();
  } catch {}
}

// ------------------------------------------------------------ shape scatter

const SHAPE_KINDS = ['ring', 'cross', 'dot', 'squircle'];

export function shapes(host, count = 6) {
  if (!host || host.querySelector(':scope > .fx-shapes')) {
    return;
  }
  try {
    const layer = document.createElement('div');
    layer.className = 'fx-shapes';
    for (let index = 0; index < count; index += 1) {
      const shape = document.createElement('span');
      shape.className = `fx-shape fx-${SHAPE_KINDS[index % SHAPE_KINDS.length]}`;
      const size = 14 + Math.random() * 42;
      shape.style.width = `${size}px`;
      shape.style.height = `${size}px`;
      shape.style.left = `${4 + Math.random() * 92}%`;
      shape.style.top = `${4 + Math.random() * 88}%`;
      shape.style.animationDuration = `${7 + Math.random() * 9}s`;
      shape.style.animationDelay = `${-Math.random() * 9}s`;
      shape.style.opacity = String(0.14 + Math.random() * 0.3);
      layer.append(shape);
    }
    host.prepend(layer);
  } catch {}
}

// ---------------------------------------------------------------- confetti

export function confetti() {
  if (!motionOk()) {
    return;
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.className = 'fx-confetti';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');

    const particles = Array.from({ length: 130 }, () => {
      const fromLeft = Math.random() < 0.5;
      return {
        x: fromLeft ? -12 : canvas.width + 12,
        y: canvas.height * (0.25 + Math.random() * 0.4),
        vx: (fromLeft ? 1 : -1) * (5 + Math.random() * 9),
        vy: -(6 + Math.random() * 7),
        w: 5 + Math.random() * 7,
        h: 8 + Math.random() * 8,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.35,
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        circle: Math.random() < 0.3
      };
    });

    const started = performance.now();
    const life = 1700;

    const tick = (now) => {
      const age = now - started;
      if (age > life) {
        canvas.remove();
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const fade = age > life - 400 ? (life - age) / 400 : 1;
      for (const p of particles) {
        p.vy += 0.28;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        const [r, g, b] = p.color;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = `rgba(${r},${g},${b},${fade})`;
        if (p.circle) {
          ctx.beginPath();
          ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }
        ctx.restore();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch {}
}

// -------------------------------------------------------------- emoji burst

export function emojiBurst(x, y, emoji) {
  if (!motionOk()) {
    return;
  }
  try {
    for (let index = 0; index < 7; index += 1) {
      const span = document.createElement('span');
      span.className = 'fx-emoji';
      span.textContent = emoji;
      span.style.left = `${x}px`;
      span.style.top = `${y}px`;
      span.style.setProperty('--dx', `${(Math.random() - 0.5) * 150}px`);
      span.style.setProperty('--dy', `${-(70 + Math.random() * 120)}px`);
      span.style.setProperty('--rot', `${(Math.random() - 0.5) * 160}deg`);
      span.style.animationDelay = `${index * 28}ms`;
      span.addEventListener('animationend', () => span.remove());
      document.body.append(span);
    }
  } catch {}
}

// ---------------------------------------------------------------- ping ring

export function ping(el) {
  if (!motionOk() || !el) {
    return;
  }
  try {
    const rect = el.getBoundingClientRect();
    const ring = document.createElement('span');
    ring.className = 'fx-ping';
    ring.style.left = `${rect.left + rect.width / 2}px`;
    ring.style.top = `${rect.top + rect.height / 2}px`;
    ring.addEventListener('animationend', () => ring.remove());
    document.body.append(ring);
  } catch {}
}

// -------------------------------------------------------------- card tilt

export function tilt(container, selector) {
  if (!container) {
    return;
  }
  let raf = 0;
  container.addEventListener('pointermove', (event) => {
    if (!motionOk() || event.pointerType === 'touch') {
      return;
    }
    const card = event.target.closest(selector);
    if (!card || !container.contains(card)) {
      return;
    }
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const rect = card.getBoundingClientRect();
      const px = (event.clientX - rect.left) / rect.width - 0.5;
      const py = (event.clientY - rect.top) / rect.height - 0.5;
      card.style.transform =
        `perspective(700px) rotateX(${(-py * 8).toFixed(2)}deg) rotateY(${(px * 10).toFixed(2)}deg) translateY(-4px) scale(1.015)`;
    });
  });
  container.addEventListener('pointerout', (event) => {
    const card = event.target.closest(selector);
    if (card) {
      card.style.transform = '';
    }
  }, true);
}

// --------------------------------------------- audio-reactive speaking glow

export function speakingGlow({ getAnalysers, getTarget }) {
  const levels = new Map();
  setInterval(() => {
    if (!motionOk() || document.hidden) {
      return;
    }
    try {
      for (const [key, entry] of getAnalysers()) {
        entry.analyser.getByteTimeDomainData(entry.data);
        let sum = 0;
        for (let index = 0; index < entry.data.length; index += 1) {
          const deviation = entry.data[index] - 128;
          sum += deviation * deviation;
        }
        const rms = Math.sqrt(sum / entry.data.length);
        const raw = Math.max(0, Math.min(1, (rms - 2.5) / 22));
        const smoothed = Math.max(raw, (levels.get(key) || 0) * 0.75);
        levels.set(key, smoothed);
        const target = getTarget(key);
        if (target) {
          target.style.setProperty('--lvl', smoothed.toFixed(3));
        }
      }
    } catch {}
  }, 100);
}
