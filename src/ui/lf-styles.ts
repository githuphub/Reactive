/**
 * Styles for the Liveforge UI (Brain View, Demo panel, captions, chat, quests, forge, badge). Injected once.
 * Everything lives in an overlay above the screen stack so it stays clickable while the game is paused.
 */
const CSS = `
.lcx-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 30; font-family: var(--lc-font, system-ui); color: #eef; }
.lcx-overlay > * { pointer-events: auto; }

/* ---------- Brain View ---------- */
.lcx-brain { position: absolute; left: 10px; bottom: 10px; width: 420px; height: 300px; display: flex; flex-direction: column;
  background: rgba(10, 12, 20, 0.78); border: 1px solid rgba(160, 170, 255, 0.25); border-radius: 8px; backdrop-filter: blur(3px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.45); font-size: 12px; overflow: hidden; }
.lcx-brain.lcx-collapsed { height: 30px; }
.lcx-brain.lcx-hidden { display: none; }
.lcx-brain-head { display: flex; align-items: center; gap: 6px; padding: 5px 8px; background: rgba(255,255,255,0.05); border-bottom: 1px solid rgba(255,255,255,0.08); cursor: default; user-select: none; }
.lcx-brain-title { font-weight: 700; letter-spacing: 2px; font-size: 12px; color: #c9c4ff; }
.lcx-brain-head .lcx-sp { flex: 1; }
.lcx-ib { background: rgba(255,255,255,0.07); color: #dde; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; padding: 1px 6px; font: 11px var(--lc-mono, monospace); cursor: pointer; }
.lcx-ib:hover { background: rgba(255,255,255,0.16); }
.lcx-ib.lcx-on { background: rgba(140, 120, 255, 0.35); border-color: rgba(170,150,255,0.7); }
.lcx-brain-body { flex: 1; overflow-y: auto; padding: 4px 6px 8px; scrollbar-width: thin; }
.lcx-group { margin: 4px 0 6px; border-left: 2px solid rgba(160,170,255,0.25); padding-left: 6px; }
.lcx-group.lcx-pinned { border-left-color: #f5c542; background: rgba(245,197,66,0.06); }
.lcx-ghead { display: flex; align-items: center; gap: 6px; font-weight: 700; color: #fff; margin-bottom: 2px; }
.lcx-ghead canvas { width: 16px; height: 16px; image-rendering: pixelated; border-radius: 3px; flex: none; }
.lcx-ghead .lcx-gtext { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lcx-ghead .lcx-pin { opacity: 0.4; cursor: pointer; font-size: 11px; }
.lcx-ghead .lcx-pin:hover, .lcx-group.lcx-pinned .lcx-pin { opacity: 1; }
.lcx-row { display: flex; gap: 5px; align-items: flex-start; padding: 1px 2px; border-radius: 3px; cursor: pointer; line-height: 1.35; }
.lcx-row:hover { background: rgba(255,255,255,0.06); }
.lcx-row .lcx-ico { flex: none; width: 16px; text-align: center; }
.lcx-row .lcx-txt { flex: 1; word-break: break-word; color: #dfe3ff; }
.lcx-row.lcx-thought .lcx-txt { font-style: italic; color: #b9c2e6; }
.lcx-row.lcx-fail .lcx-txt { color: #ff9c8c; }
.lcx-row code { font: 11px var(--lc-mono, monospace); color: #ffd98a; }
.lcx-badge { flex: none; font: 700 9px var(--lc-mono, monospace); padding: 1px 4px; border-radius: 3px; letter-spacing: 0.5px; margin-top: 1px; }
.lcx-b-sonnet { background: #7c4dff; color: #fff; }
.lcx-b-haiku { background: #18a999; color: #fff; }
.lcx-b-rules { background: #5d6270; color: #e6e8ef; }
.lcx-b-cache { background: #2f74d0; color: #fff; }
.lcx-b-replay { background: #f2a516; color: #1a1200; }
.lcx-ms { flex: none; font: 10px var(--lc-mono, monospace); color: #8a90a8; margin-top: 2px; }
.lcx-json { margin: 2px 0 4px 21px; padding: 4px 6px; background: rgba(0,0,0,0.45); border-radius: 4px; font: 10px/1.35 var(--lc-mono, monospace); color: #bfe; white-space: pre-wrap; max-height: 160px; overflow: auto; }

/* ---------- status badge ---------- */
.lcx-lfbadge { position: absolute; top: 8px; right: 10px; display: flex; gap: 6px; align-items: center; font: 700 11px var(--lc-mono, monospace);
  background: rgba(10,12,20,0.7); border: 1px solid rgba(255,255,255,0.15); border-radius: 12px; padding: 3px 9px; }
.lcx-dot { width: 8px; height: 8px; border-radius: 50%; background: #888; }
.lcx-dot.lcx-online { background: #43d17a; box-shadow: 0 0 6px #43d17a; }
.lcx-dot.lcx-offline { background: #e0564a; }
.lcx-dot.lcx-connecting { background: #e8c547; }
.lcx-cas { padding: 0 5px; border-radius: 3px; background: #5d6270; }
.lcx-cas.lcx-REPLAY { background: #f2a516; color: #1a1200; }
.lcx-cas.lcx-LIVE { background: #7c4dff; }
.lcx-cas.lcx-RECORD { background: #d33; }

/* ---------- Demo panel ---------- */
.lcx-demo { position: absolute; top: 36px; right: 10px; width: 236px; background: rgba(12, 14, 22, 0.82); border: 1px solid rgba(255,255,255,0.16);
  border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 5px; box-shadow: 0 6px 24px rgba(0,0,0,0.45); }
.lcx-demo.lcx-hidden { display: none; }
.lcx-demo h3 { margin: 0 0 2px; font-size: 12px; letter-spacing: 2px; color: #ffd98a; display: flex; justify-content: space-between; }
.lcx-db { text-align: left; font: 13px var(--lc-font, system-ui); color: #fff; background: linear-gradient(#3d4a66, #2b344a); border: 1px solid #141a26; border-radius: 5px; padding: 7px 9px; cursor: pointer; }
.lcx-db:hover { background: linear-gradient(#52648a, #36435e); }
.lcx-db small { display: block; color: #aab4d0; font-size: 10px; margin-top: 1px; }
.lcx-db.lcx-busy { opacity: 0.6; }
.lcx-utils { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-top: 3px; }
.lcx-ub { font: 11px var(--lc-font, system-ui); color: #e8ecff; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); border-radius: 4px; padding: 5px 4px; cursor: pointer; }
.lcx-ub:hover { background: rgba(255,255,255,0.18); }
.lcx-ub.lcx-on { background: rgba(140,120,255,0.35); }

/* ---------- captions ---------- */
.lcx-caption { position: absolute; left: 50%; bottom: 118px; transform: translateX(-50%); max-width: 70vw; text-align: center; pointer-events: none;
  background: rgba(0,0,0,0.68); color: #fff; font-size: 17px; padding: 7px 16px; border-radius: 6px; text-shadow: 1px 1px 0 #000; transition: opacity 0.4s; }
.lcx-caption.lcx-hidden { opacity: 0; }

/* ---------- chat ---------- */
.lcx-chat { width: min(560px, 90vw); background: rgba(14, 16, 24, 0.92); border: 1px solid rgba(255,255,255,0.18); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.lcx-chat-head { display: flex; align-items: center; gap: 8px; font-weight: 700; }
.lcx-chat-head canvas { width: 24px; height: 24px; image-rendering: pixelated; border-radius: 4px; }
.lcx-chat-log { max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
.lcx-chat-log .lcx-me { color: #9fe0ff; }
.lcx-chat-log .lcx-npc { color: #ffe9b0; }
.lcx-chat-log .lcx-sys { color: #9aa0b8; font-size: 12px; font-style: italic; }
.lcx-chat-row { display: flex; gap: 6px; }
.lcx-chat-row input { flex: 1; font: 15px var(--lc-font, system-ui); padding: 8px 10px; border-radius: 5px; border: 1px solid #445; background: #0b0d14; color: #fff; outline: none; }
.lcx-chat-row button { font: 14px var(--lc-font, system-ui); padding: 0 14px; border-radius: 5px; border: 1px solid #2a3350; background: #3f5fa8; color: #fff; cursor: pointer; }
.lcx-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.lcx-chip { font-size: 12px; padding: 3px 8px; border-radius: 10px; background: rgba(255,217,138,0.15); border: 1px solid rgba(255,217,138,0.45); color: #ffe3a3; cursor: pointer; }
.lcx-hint { font: 11px var(--lc-mono, monospace); color: #8f96b2; }
.lcx-mic { color: #ff7a6a; font-weight: 700; }

/* ---------- quests ---------- */
.lcx-quests { position: absolute; top: 70px; left: 10px; width: 250px; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
.lcx-quest { background: rgba(20, 16, 8, 0.72); border: 1px solid rgba(255, 210, 120, 0.4); border-radius: 6px; padding: 6px 9px; font-size: 12px; }
.lcx-quest b { color: #ffd98a; display: block; font-size: 13px; }
.lcx-quest .lcx-obj { color: #e8dcc0; }
.lcx-quest .lcx-obj.lcx-done { color: #8fdc8f; text-decoration: line-through; }
.lcx-bar { height: 4px; background: rgba(255,255,255,0.12); border-radius: 2px; margin-top: 3px; overflow: hidden; }
.lcx-bar > i { display: block; height: 100%; background: #8fdc8f; width: 0; transition: width 0.3s; }
.lcx-offer { width: min(460px, 90vw); background: #2a2116; border: 2px solid #8a6a3a; border-radius: 6px; padding: 14px 18px; color: #f3e6c8; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
.lcx-offer h2 { margin: 0 0 4px; font-size: 20px; color: #ffd98a; }
.lcx-offer .lcx-giver { font-size: 12px; color: #c9b48a; margin-bottom: 8px; }
.lcx-offer .lcx-line { font-style: italic; margin: 8px 0; }
.lcx-offer ul { margin: 6px 0; padding-left: 18px; font-size: 13px; }
.lcx-offer .lcx-btns { display: flex; gap: 8px; margin-top: 10px; }
.lcx-offer .lcx-btns button { flex: 1; }
.lcx-ach { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; align-items: center; pointer-events: none;
  background: rgba(30, 30, 40, 0.92); border: 2px solid #f5c542; border-radius: 6px; padding: 8px 14px; animation: lcx-drop 0.4s ease-out; }
.lcx-ach .lcx-glyph { font-size: 26px; }
.lcx-ach b { color: #f5c542; display: block; font-size: 12px; letter-spacing: 1px; }
@keyframes lcx-drop { from { transform: translate(-50%, -40px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }

/* ---------- forge ---------- */
.lcx-forge { width: min(620px, 92vw); background: rgba(16, 12, 24, 0.95); border: 1px solid rgba(190, 150, 255, 0.4); border-radius: 8px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.lcx-forge h2 { margin: 0; letter-spacing: 3px; color: #d9c4ff; font-size: 20px; }
.lcx-tabs { display: flex; gap: 4px; }
.lcx-tab { font: 13px var(--lc-font, system-ui); padding: 5px 14px; border-radius: 5px 5px 0 0; border: 1px solid #3a3150; border-bottom-color: rgba(190, 150, 255, 0.4); background: #15111f; color: #a99cc6; cursor: pointer; }
.lcx-tab.on { background: #3a2a5c; color: #fff; border-color: rgba(190, 150, 255, 0.6); }
.lcx-forge .lcx-chat-row select { font: 14px var(--lc-font, system-ui); background: #0b0d14; color: #fff; border: 1px solid #445; border-radius: 5px; }
.lcx-card { display: flex; gap: 14px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 10px; }
.lcx-card canvas { width: 96px; height: 96px; image-rendering: pixelated; background: rgba(0,0,0,0.35); border-radius: 4px; flex: none; }
.lcx-card h3 { margin: 0 0 2px; color: #ffe08a; font-size: 17px; }
.lcx-card .lcx-flavor { font-style: italic; color: #c8c0e0; font-size: 12px; margin-bottom: 6px; }
.lcx-stats { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font: 12px var(--lc-mono, monospace); }
.lcx-recipe { display: inline-grid; grid-template-columns: repeat(3, 18px); gap: 2px; margin-top: 6px; }
.lcx-recipe span { width: 18px; height: 18px; background: rgba(255,255,255,0.08); border-radius: 2px; font: 9px var(--lc-mono, monospace); display: flex; align-items: center; justify-content: center; }
`;

let injected = false;

/** Injects the Liveforge UI styles (idempotent). */
export function injectLfStyles(): void {
  if (injected) return;
  injected = true;
  const style = document.createElement('style');
  style.id = 'livecraft-liveforge-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}

let overlay: HTMLElement | null = null;

/** The overlay layer (above the screen stack, below nothing) that every Liveforge widget mounts into. */
export function lfOverlay(): HTMLElement {
  if (overlay) return overlay;
  injectLfStyles();
  overlay = document.createElement('div');
  overlay.className = 'lcx-overlay';
  document.body.appendChild(overlay);
  return overlay;
}
