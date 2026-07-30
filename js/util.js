'use strict';

/** Small DOM + formatting helpers shared across the app. */

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === 'class') {
      node.className = value;
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'text') {
      node.textContent = value;
    } else if (key.startsWith('aria-') || key === 'role' || key === 'for' || key === 'type' ||
               key === 'placeholder' || key === 'maxlength' || key === 'title' || key === 'href' ||
               key === 'download' || key === 'rel' || key === 'target' || key === 'src' || key === 'alt') {
      node.setAttribute(key, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else {
      node[key] = value;
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** An <svg> with no viewBox of its own does not reliably scale the referenced
    <symbol> — Chrome renders the glyph at a fraction of the box, which shows
    up as a dot next to a label. Copy the symbol's viewBox onto every icon. */
const viewBoxCache = new Map();

function viewBoxFor(id) {
  if (viewBoxCache.has(id)) {
    return viewBoxCache.get(id);
  }
  const symbol = document.getElementById(id);
  const box = (symbol && symbol.getAttribute('viewBox')) || '0 0 24 24';
  viewBoxCache.set(id, box);
  return box;
}

export function icon(id, extraClass) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBoxFor(id));
  if (extraClass) {
    svg.setAttribute('class', extraClass);
  }
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

/** Same repair for the icons written straight into index.html. */
export function normaliseIcons(root = document) {
  for (const svg of root.querySelectorAll('svg:not([viewBox])')) {
    const use = svg.querySelector(':scope > use');
    const href = use && (use.getAttribute('href') || use.getAttribute('xlink:href'));
    if (href && href.startsWith('#')) {
      svg.setAttribute('viewBox', viewBoxFor(href.slice(1)));
    }
  }
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return '?';
  }
  return parts.slice(0, 2).map((part) => [...part][0]).join('').toUpperCase();
}

export function avatarEl(user, extraClass = '') {
  const node = el('span', {
    class: `avatar c${(user && user.color) || 1}${extraClass ? ` ${extraClass}` : ''}`
  });
  if (user && user.avatar) {
    node.classList.add('has-img');
    node.append(el('img', { src: user.avatar, alt: '', loading: 'lazy' }));
  } else {
    node.textContent = initials(user && user.name);
  }
  return node;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const fullFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
});

export function formatTime(ts) {
  return timeFormat.format(new Date(ts));
}

export function formatDay(ts) {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return dayFormat.format(date);
}

export function formatFull(ts) {
  return fullFormat.format(new Date(ts));
}

export function formatBytes(bytes) {
  if (!bytes) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function sameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

let toastTimer = null;

export function toast(message, isError = false) {
  const node = document.querySelector('#toast');
  clearTimeout(toastTimer);
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.hidden = false;
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3400);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const input = document.createElement('input');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    return ok;
  }
}

/** Tiny synth beeps for voice events — no audio assets needed. */
let audioContext = null;

export function beep(kind) {
  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
    const notes = kind === 'join' ? [392, 523.25] : kind === 'leave' ? [523.25, 392] : [660];
    let at = audioContext.currentTime;
    for (const frequency of notes) {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.06, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(at);
      osc.stop(at + 0.18);
      at += 0.09;
    }
  } catch {
    // Sound is a nicety; never let it break anything.
  }
}

export function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
