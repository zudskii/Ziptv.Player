/**
 * jsdom lacks a few browser features the app relies on. Importing this module (first!) adds
 * minimal stand-ins so real components can render in tests.
 */

// <dialog>: jsdom has the element but not showModal()/close().
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  if (!this.hasAttribute('open')) return;
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

// Virtualised lists measure their scroll container; jsdom has no layout, so give every element a size.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 720 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 960 });
Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 960, bottom: 720, width: 960, height: 720, toJSON: () => ({}) });
Element.prototype.scrollTo = function scrollTo() {};
Element.prototype.scrollIntoView = function scrollIntoView() {};
window.scrollTo = () => {};

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
