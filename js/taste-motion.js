'use strict';

const magneticSelector = [
  '.primary-button',
  '.side-add-main',
  '.home-call-action',
  '.home-text-action.is-primary',
  '.voice-prejoin-buttons button',
  '.v-control.leave',
  '.composer-send'
].join(',');

let initialized = false;

export function initTasteMotion() {
  if (initialized) {
    return;
  }
  initialized = true;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const controller = new AbortController();
  const { signal } = controller;
  let frame = 0;
  let active = null;

  const reset = (element) => {
    if (!element) {
      return;
    }
    element.style.removeProperty('--taste-magnetic-x');
    element.style.removeProperty('--taste-magnetic-y');
    element.classList.remove('taste-magnetic');
  };

  document.addEventListener('pointermove', (event) => {
    if (reducedMotion.matches || !finePointer.matches || event.pointerType === 'touch') {
      reset(active);
      active = null;
      return;
    }
    const target = event.target.closest(magneticSelector);
    if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') {
      reset(active);
      active = null;
      return;
    }
    if (active && active !== target) {
      reset(active);
    }
    active = target;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const rect = target.getBoundingClientRect();
      const x = Math.max(-3, Math.min(3, (event.clientX - (rect.left + rect.width / 2)) * 0.08));
      const y = Math.max(-2, Math.min(2, (event.clientY - (rect.top + rect.height / 2)) * 0.08));
      target.style.setProperty('--taste-magnetic-x', `${x.toFixed(2)}px`);
      target.style.setProperty('--taste-magnetic-y', `${y.toFixed(2)}px`);
      target.classList.add('taste-magnetic');
    });
  }, { signal, passive: true });

  document.addEventListener('pointerout', (event) => {
    if (!active || active.contains(event.relatedTarget)) {
      return;
    }
    cancelAnimationFrame(frame);
    reset(active);
    active = null;
  }, { signal, passive: true });

  const stopMotion = () => {
    if (!reducedMotion.matches) {
      return;
    }
    cancelAnimationFrame(frame);
    reset(active);
    active = null;
  };
  reducedMotion.addEventListener('change', stopMotion, { signal });

  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(frame);
    reset(active);
    controller.abort();
    initialized = false;
  }, { signal, once: true });
}
