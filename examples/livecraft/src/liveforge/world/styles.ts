/** Styles for lane WB's in-world UI: gossip bubbles and particles, achievement toasts, board hint. Injected once. */
const CSS = `
.wbw-gossip { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 6; }
.wbw-bubble { position: absolute; left: 0; top: 0; max-width: 240px; padding: 6px 10px; font: 12px/1.35 var(--lc-font, system-ui);
  border-radius: 14px; white-space: normal; will-change: transform; }
.wbw-thought { background: rgba(255,255,255,0.94); color: #2a2440; border: 2px solid #b9b2e6; font-style: italic;
  box-shadow: 0 3px 10px rgba(0,0,0,0.35); }
.wbw-thought::after { content: ''; position: absolute; left: 50%; bottom: -12px; width: 9px; height: 9px; border-radius: 50%;
  background: rgba(255,255,255,0.94); border: 2px solid #b9b2e6; transform: translateX(-50%); }
.wbw-thought::before { content: ''; position: absolute; left: calc(50% + 7px); bottom: -20px; width: 5px; height: 5px; border-radius: 50%;
  background: rgba(255,255,255,0.94); border: 1px solid #b9b2e6; }
.wbw-note { background: rgba(255, 236, 170, 0.95); color: #4a3510; border: 1px dashed #b08a2a; font-size: 11px; border-radius: 6px; }
.wbw-particle { position: absolute; left: 0; top: 0; font-size: 20px; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.5)); will-change: transform, opacity; }

.wbw-ach { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); display: flex; gap: 12px; align-items: center; pointer-events: none;
  min-width: 300px; max-width: 460px; padding: 10px 16px; border-radius: 10px; background: linear-gradient(180deg, rgba(36,30,18,0.95), rgba(20,16,10,0.95));
  border: 2px solid var(--wbw-rar, #cfd3dc); box-shadow: 0 0 18px var(--wbw-rar, #cfd3dc), 0 6px 20px rgba(0,0,0,0.5); color: #f3ead6;
  animation: wbw-pop 0.45s cubic-bezier(.2,1.6,.4,1), wbw-glow 1.6s ease-in-out infinite alternate; }
.wbw-ach.wbw-out { transition: opacity 0.6s, transform 0.6s; opacity: 0; transform: translateX(-50%) translateY(-14px); }
.wbw-ach .wbw-icon { font-size: 30px; width: 44px; height: 44px; display: grid; place-items: center; border-radius: 8px; background: rgba(255,255,255,0.07);
  border: 1px solid var(--wbw-rar, #cfd3dc); }
.wbw-ach b { display: block; font: 700 11px var(--lc-mono, monospace); letter-spacing: 1.5px; color: var(--wbw-rar, #cfd3dc); }
.wbw-ach .wbw-t { font-weight: 700; font-size: 15px; }
.wbw-ach .wbw-d { font-size: 12px; opacity: 0.85; }
@keyframes wbw-pop { from { transform: translateX(-50%) scale(0.6); opacity: 0; } to { transform: translateX(-50%) scale(1); opacity: 1; } }
@keyframes wbw-glow { from { box-shadow: 0 0 8px var(--wbw-rar, #cfd3dc), 0 6px 20px rgba(0,0,0,0.5); } to { box-shadow: 0 0 26px var(--wbw-rar, #cfd3dc), 0 6px 20px rgba(0,0,0,0.5); } }

.wbw-hint { position: absolute; left: 50%; top: 58%; transform: translateX(-50%); pointer-events: none; padding: 4px 10px; border-radius: 6px;
  background: rgba(40, 28, 12, 0.8); color: #ffe7b0; font: 12px var(--lc-font, system-ui); border: 1px solid rgba(255, 210, 120, 0.4); }
.wbw-hint.wbw-hidden { display: none; }
`;

let injected = false;

/** Injects the WB world styles (idempotent). */
export function injectWorldStyles(): void {
  if (injected) return;
  injected = true;
  const s = document.createElement('style');
  s.dataset.lane = 'wb-world';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/** Rarity → glow colour. */
export const RARITY_COLOR: Record<string, string> = {
  common: '#cfd3dc', uncommon: '#5fd068', rare: '#4aa3ff', epic: '#b26bff', legendary: '#ffb02e',
};
