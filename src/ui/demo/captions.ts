/**
 * One-line caption strip at the bottom of the screen (Demo captions). Toggle with the Demo panel.
 */
import { lfOverlay } from '../lf-styles';

export class Captions {
  readonly el: HTMLElement;
  enabled: boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.el = document.createElement('div');
    this.el.className = 'lcx-caption lcx-hidden';
    lfOverlay().appendChild(this.el);
  }

  /** Shows `text` for `seconds` (0 or empty text hides it). */
  show(text: string, seconds = 5): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!text || !seconds || !this.enabled) {
      this.el.classList.add('lcx-hidden');
      return;
    }
    this.el.textContent = text;
    this.el.classList.remove('lcx-hidden');
    this.timer = setTimeout(() => this.el.classList.add('lcx-hidden'), seconds * 1000);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.el.classList.add('lcx-hidden');
  }
}
