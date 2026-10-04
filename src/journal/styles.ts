/** Journal styles: a leather-bound book with parchment pages and ribbon tabs. Injected once. */
const CSS = `
.wbj-root { position: absolute; inset: 0; display: grid; place-items: center; }
.wbj-book { position: relative; width: min(980px, 94vw); height: min(640px, 88vh); display: flex; flex-direction: column;
  background: #6b3f22; border-radius: 14px; padding: 14px 16px 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.6), inset 0 0 0 3px #4a2914, inset 0 0 0 6px #8a5a32;
  font-family: Georgia, 'Times New Roman', serif; color: #3a2a18; }
.wbj-tabs { display: flex; gap: 4px; padding: 0 18px; position: relative; z-index: 1; }
.wbj-tab { border: none; cursor: pointer; padding: 7px 14px 9px; border-radius: 8px 8px 0 0; font: 700 13px Georgia, serif; color: #f5e6c8;
  background: #8b2e2a; box-shadow: inset 0 -3px 0 rgba(0,0,0,0.25); transform: translateY(4px); transition: transform 0.12s; }
.wbj-tab:nth-child(2) { background: #2e5f8b; } .wbj-tab:nth-child(3) { background: #6a3a8b; } .wbj-tab:nth-child(4) { background: #9a7a1e; } .wbj-tab:nth-child(5) { background: #2e7a4a; }
.wbj-tab:hover { transform: translateY(1px); }
.wbj-tab.wbj-on { transform: translateY(0); box-shadow: none; filter: brightness(1.15); }
.wbj-tab small { opacity: 0.7; font-weight: 400; margin-left: 4px; }
.wbj-pages { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 0; min-height: 0; border-radius: 6px; overflow: hidden;
  background: linear-gradient(90deg, #efe0bd 0%, #f6ead0 46%, #d9c79f 50%, #f6ead0 54%, #efe0bd 100%); box-shadow: inset 0 0 30px rgba(120,80,30,0.35); }
.wbj-page { padding: 18px 26px; overflow-y: auto; min-height: 0; scrollbar-width: thin; scrollbar-color: #b49a6a transparent; }
.wbj-page h2 { margin: 0 0 6px; font-size: 22px; color: #5a2a14; border-bottom: 1px solid rgba(90,42,20,0.3); padding-bottom: 4px; }
.wbj-page h3 { margin: 14px 0 6px; font-size: 14px; letter-spacing: 1px; text-transform: uppercase; color: #7a4a24; }
.wbj-close { position: absolute; top: 10px; right: 14px; background: #4a2914; color: #f5e6c8; border: 1px solid #8a5a32; border-radius: 6px; cursor: pointer; font: 12px Georgia, serif; padding: 3px 8px; }
.wbj-muted { color: #7a6448; font-size: 12px; font-style: italic; }
.wbj-badge { display: inline-block; font: 700 9px var(--lc-mono, monospace); padding: 1px 5px; border-radius: 3px; letter-spacing: 0.5px; vertical-align: middle; margin-left: 6px; color: #fff; background: #5d6270; }
.wbj-badge.wbj-sonnet { background: #7c4dff; } .wbj-badge.wbj-haiku { background: #18a999; } .wbj-badge.wbj-cache { background: #2f74d0; } .wbj-badge.wbj-replay { background: #f2a516; color: #1a1200; }
.wbj-badge.wbj-server { background: #2e7a4a; } .wbj-badge.wbj-local { background: #8a7a5a; }
.wbj-profile { font-style: italic; font-size: 15px; line-height: 1.5; background: rgba(255,255,255,0.35); border-left: 3px solid #9a6a3a; padding: 8px 12px; margin: 6px 0; }
.wbj-btn { background: #6b3f22; color: #f5e6c8; border: 1px solid #4a2914; border-radius: 5px; padding: 3px 9px; cursor: pointer; font: 12px Georgia, serif; }
.wbj-btn:hover { background: #8a5a32; }
.wbj-trait { margin: 6px 0; }
.wbj-trait-h { display: flex; justify-content: space-between; font-weight: 700; font-size: 13px; text-transform: capitalize; }
.wbj-bar { height: 9px; background: rgba(90,60,30,0.18); border-radius: 5px; overflow: hidden; margin: 2px 0; }
.wbj-bar i { display: block; height: 100%; background: linear-gradient(90deg, #c27a2a, #e8b04a); border-radius: 5px; }
.wbj-ev { font-size: 11px; color: #6a5438; }
.wbj-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 14px; font-size: 13px; }
.wbj-stats div { display: flex; justify-content: space-between; border-bottom: 1px dotted rgba(90,60,30,0.3); }
.wbj-stats b { color: #5a2a14; }
.wbj-list { list-style: none; padding: 0; margin: 0; font-size: 13px; }
.wbj-list li { padding: 3px 0 3px 16px; position: relative; border-bottom: 1px dotted rgba(90,60,30,0.2); }
.wbj-list li::before { content: '✦'; position: absolute; left: 0; color: #9a6a3a; font-size: 10px; top: 5px; }
.wbj-when { color: #8a7458; font-size: 11px; margin-left: 4px; }
.wbj-npc { display: grid; grid-template-columns: 44px 1fr; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(90,60,30,0.25); }
.wbj-npc canvas { width: 44px; height: 44px; image-rendering: pixelated; border-radius: 6px; border: 2px solid #5a3a1a; }
.wbj-npc-h { display: flex; align-items: baseline; gap: 8px; }
.wbj-npc-h b { font-size: 15px; color: #4a2010; }
.wbj-npc-h span { font-size: 11px; color: #7a6448; }
.wbj-meter { position: relative; height: 10px; border-radius: 5px; margin: 4px 0; background: linear-gradient(90deg, #b23a2a, #d8b25a 50%, #3a9a4a); opacity: 0.85; }
.wbj-meter i { position: absolute; top: -3px; width: 4px; height: 16px; background: #2a1a0a; border-radius: 2px; transform: translateX(-2px); box-shadow: 0 0 0 1px #f6ead0; }
.wbj-att { font-size: 12px; font-weight: 700; }
.wbj-mem { font-size: 12px; margin: 2px 0 0; padding-left: 0; list-style: none; }
.wbj-mem li { padding: 1px 0; color: #4a3a24; }
.wbj-mem li.wbj-neg { color: #8a2a1a; } .wbj-mem li.wbj-pos { color: #2a6a3a; }
.wbj-look { font-size: 11px; color: #6a3a8b; margin-top: 2px; }
.wbj-rep { background: rgba(255,255,255,0.3); border: 1px solid rgba(90,60,30,0.3); border-radius: 6px; padding: 8px 10px; font-size: 13px; }
.wbj-nick { display: inline-block; background: #5a2a14; color: #ffe7b0; border-radius: 12px; padding: 2px 10px; margin: 2px 4px 2px 0; font-style: italic; }
.wbj-rumour { background: #f9f0d8; border: 1px solid rgba(90,60,30,0.3); box-shadow: 2px 3px 0 rgba(90,60,30,0.15); padding: 8px 10px; margin: 8px 0; transform: rotate(var(--tilt, 0deg)); }
.wbj-rumour q { font-style: italic; font-size: 14px; }
.wbj-rumour .wbj-was { text-decoration: line-through; color: #8a7458; font-size: 11px; display: block; }
.wbj-faces { display: flex; gap: 3px; align-items: center; margin-top: 4px; font-size: 11px; color: #6a5438; }
.wbj-faces canvas { width: 18px; height: 18px; image-rendering: pixelated; border-radius: 3px; }
.wbj-ach { display: grid; grid-template-columns: 40px 1fr; gap: 8px; align-items: center; padding: 6px; margin: 5px 0; border-radius: 6px;
  background: rgba(255,255,255,0.35); border: 2px solid var(--rar, #cfd3dc); box-shadow: 0 0 8px var(--rar, transparent); }
.wbj-ach .wbj-ico { font-size: 26px; text-align: center; }
.wbj-ach b { display: block; font-size: 14px; color: #3a2010; }
.wbj-ach small { font-size: 12px; color: #5a4a30; }
.wbj-ach.wbj-locked { filter: grayscale(1); opacity: 0.55; border-style: dashed; box-shadow: none; }
.wbj-chain { background: rgba(255,255,255,0.3); border: 1px solid rgba(90,60,30,0.3); border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
.wbj-chain b { font-size: 15px; color: #2e5a3a; }
.wbj-steps { display: flex; gap: 6px; margin: 6px 0 2px; }
.wbj-step { flex: 1; font-size: 11px; text-align: center; padding: 4px 3px; border-radius: 4px; background: rgba(90,60,30,0.12); color: #6a5438; }
.wbj-step.wbj-done { background: #3a8a4a; color: #fff; } .wbj-step.wbj-active { background: #c28a2a; color: #fff; } .wbj-step.wbj-offered { background: #d8c08a; color: #3a2a18; }
.wbj-obj { font-size: 12px; } .wbj-obj.wbj-done { color: #2a6a3a; text-decoration: line-through; }
`;

let injected = false;

/** Injects the journal styles (idempotent). */
export function injectJournalStyles(): void {
  if (injected) return;
  injected = true;
  const s = document.createElement('style');
  s.dataset.lane = 'wb-journal';
  s.textContent = CSS;
  document.head.appendChild(s);
}
