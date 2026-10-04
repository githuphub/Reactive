/** CSS for the village UI (injected once; keeps V0's stylesheet untouched). */
const CSS = `
.lcv-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.lcv-tag { position: absolute; left: 0; top: 0; transform-origin: 50% 100%; display: flex; flex-direction: column; align-items: center; gap: 4px; will-change: transform; }
.lcv-name { font: bold 13px var(--lc-font); color: #fff; background: rgba(0,0,0,0.42); padding: 1px 7px; border-radius: 3px; text-shadow: 1px 1px 0 #000; white-space: nowrap; }
.lcv-name small { font-weight: normal; color: #d8d2c0; margin-left: 4px; }
.lcv-bubble { position: relative; max-width: 260px; font: 14px/1.3 var(--lc-font); color: #2a2218; background: #fbf6e9; border: 2px solid #3b2f22; border-radius: 8px; padding: 6px 10px; box-shadow: 0 3px 0 rgba(0,0,0,0.25); white-space: pre-wrap; }
.lcv-bubble::after { content: ''; position: absolute; left: 50%; bottom: -8px; margin-left: -7px; border: 7px solid transparent; border-top-color: #3b2f22; border-bottom: 0; }
.lcv-bubble.lcv-emote { font-style: italic; color: #5a4a36; background: #efe6cf; }
.lcv-bubble.lcv-hidden, .lcv-name.lcv-hidden { display: none; }
.lcv-label { position: absolute; left: 0; top: 0; font: bold 14px var(--lc-font); color: #fff3c4; background: rgba(60,38,18,0.78); border: 2px solid #8a6436; padding: 3px 9px; border-radius: 4px; white-space: nowrap; transform-origin: 50% 100%; text-shadow: 1px 1px 0 #000; }
.lcv-menu { min-width: 260px; }
.lcv-menu h2 { margin-bottom: 4px; }
.lcv-menu .lcv-sub { text-align: center; color: #c9c2ae; font-size: 13px; margin-bottom: 10px; }
.lcv-menu .lc-btn kbd { float: right; opacity: 0.6; font: 12px var(--lc-mono); }
.lcv-trade { min-width: 420px; max-width: 520px; }
.lcv-trade-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; font-size: 14px; }
.lcv-coins { display: inline-flex; align-items: center; gap: 4px; font: bold 15px var(--lc-mono); color: #ffd85a; }
.lcv-coins canvas { width: 20px; height: 20px; image-rendering: pixelated; }
.lcv-mult { font: 12px var(--lc-mono); padding: 2px 6px; border-radius: 3px; background: rgba(255,255,255,0.08); }
.lcv-mult.up { color: #ff9a7a; } .lcv-mult.down { color: #9be27f; }
.lcv-offers { display: flex; flex-direction: column; gap: 4px; max-height: 50vh; overflow-y: auto; }
.lcv-offer { display: grid; grid-template-columns: 40px 1fr 18px 40px 1fr 84px; align-items: center; gap: 6px; padding: 4px 6px; background: rgba(255,255,255,0.05); border-radius: 4px; font-size: 13px; }
.lcv-offer canvas { width: 32px; height: 32px; image-rendering: pixelated; }
.lcv-offer .lcv-arrow { color: #aab; text-align: center; }
.lcv-offer button { margin: 0; padding: 5px 6px; font-size: 13px; }
.lcv-offer button:disabled { opacity: 0.45; cursor: default; }
.lcv-trade-foot { display: flex; gap: 8px; margin-top: 10px; }
.lcv-trade-foot .lc-btn { margin: 0; }
.lcv-trade-line { min-height: 18px; margin-top: 8px; font-style: italic; color: #e8dcc0; text-align: center; font-size: 13px; }
`;

let injected = false;

/** Injects the village stylesheet once. */
export function injectVillageStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.id = 'livecraft-village-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}
