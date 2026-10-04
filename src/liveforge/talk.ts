/**
 * Talking to villagers: T opens chat to the targeted villager (or the villager menu's Talk), hold V to speak
 * (SDK mic: browser recognition or server STT). Replies stream from `npc.reply` into the speech bubble and the chat
 * log, and their actions run (trade, quest_offer, follow, give, build, guard ...). Lines that read as requests
 * ("build me…", "bring me…", "follow me", "guard…") also become agent goals (`lf.agents.goal`).
 */
import type { AskResult } from '@liveforge/sdk';
import type { Game } from '../game/game';
import type { Screen } from '../ui/ui';
import { faceIcon } from '../ui/brain/faces';
import { Npc, village } from '../village';
import { npcSituation, worldSummary } from './context';
import { getHub, playerTitle } from './hub';
import { lfNpcId } from './ids';
import { getQuests } from './quests';
import { isGoalRequest, stripAddress } from './rules';
import type { LiveforgeService } from './service';
import { getMic, micFailure, speakAs, voiceBlocker } from './voice';

type Turn = { role: 'player' | 'npc'; text: string };

/** NPC actions from replies and directives (shared with directives.ts). */
export async function runNpcAction(game: Game, lf: LiveforgeService, npcId: string, action: string, args: Record<string, unknown>): Promise<void> {
  const ctl = village.controller(npcId);
  if (!ctl) return;
  switch (action) {
    case 'trade':
      await ctl.trade({ priceMultiplier: Number(args.priceMultiplier) || undefined, priority: 'schedule' });
      break;
    case 'follow':
      await ctl.follow('player', { distance: 3 });
      break;
    case 'give':
      await ctl.give(String(args.item ?? 'bread'), Math.max(1, Math.min(16, Number(args.count) || 1)), 'player');
      break;
    case 'flee':
      await ctl.walkTo('home', { run: true });
      break;
    case 'hostile':
      if (npcId === 'iron_golem' || npcId === 'golem') village.golemConfront(20, 'hostile');
      else void ctl.emote('glare');
      break;
    case 'call_guards':
      village.golemConfront(15, 'called by villagers');
      void village.controller('rowan')?.guard('player');
      break;
    case 'guard':
      await ctl.guard(String(args.post ?? 'gate'));
      break;
    case 'emote':
      await ctl.emote(String(args.name ?? 'nod'), { priority: 'schedule' });
      break;
    case 'build':
      void lf.client.agents.goal(lfNpcId(npcId), `build ${String(args.prompt ?? 'a cosy house')}`, { context: worldSummary(game, playerTitle()) });
      break;
    case 'quest_offer':
      void requestQuest(lf, lfNpcId(npcId));
      break;
    default:
      break;
  }
}

/** Asks the quests module for an offer from a giver; the quest UI shows it. */
export async function requestQuest(lf: LiveforgeService, giver: string): Promise<void> {
  try {
    const r = await lf.ask('quest.offer', { giver }, { upgrade: false }).instant;
    if (r.result.quest) getQuests().offer(r.result.quest, giver);
  } catch {
    /* offline: no generic quest offers */
  }
}

export class Talk {
  private readonly histories = new Map<string, Turn[]>();
  private screen: Screen | null = null;
  private npc: Npc | null = null;
  private log!: HTMLElement;
  private input!: HTMLInputElement;
  private chips!: HTMLElement;
  private head!: HTMLElement;
  private listening = false;

  constructor(private readonly game: Game, private readonly lf: LiveforgeService) {
    village.onTalk = (npc) => this.open(npc, '', true);
    game.input.onKey((e) => {
      if (!game.ready || game.ui.screens.isOpen) return false;
      if (e.code === 'KeyT' && !e.repeat) {
        const n = this.targetNpc();
        if (n) this.open(n);
        else game.ui.toast('Look at a villager and press T to talk');
        return true;
      }
      if (e.code === 'KeyV' && !e.repeat) {
        void this.startListening();
        return true;
      }
      return false;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyV' && this.listening && !this.screen) void this.stopListening(null);
    });
  }

  /** The villager under the crosshair, else the nearest within 6 blocks. */
  targetNpc(): Npc | null {
    const t = this.game.interaction.targetEntity;
    if (t instanceof Npc && !t.removed) return t;
    const p = this.game.player.position;
    let best: Npc | null = null;
    let bd = 6;
    for (const n of village.npcs.values()) {
      const d = n.position.distanceTo(p);
      if (!n.removed && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  /** Opens chat with a villager, optionally pre-filled (the demo fills the line; the player presses Enter). */
  open(npc: Npc, prefill = '', fromMenu = false): void {
    if (!this.screen) this.screen = this.build();
    this.npc = npc;
    this.head.replaceChildren(faceIcon(npc.def.id), text(`${npc.def.name} · ${npc.def.role}`));
    this.log.replaceChildren();
    for (const t of (this.histories.get(npc.def.id) ?? []).slice(-8)) this.addLine(t.role === 'player' ? 'You' : npc.def.name, t.text, t.role === 'player' ? 'lcx-me' : 'lcx-npc');
    this.chips.replaceChildren();
    for (const s of suggestions(npc.def.id)) {
      const c = document.createElement('span');
      c.className = 'lcx-chip';
      c.textContent = s;
      c.addEventListener('click', () => {
        this.input.value = s;
        this.input.focus();
      });
      this.chips.appendChild(c);
    }
    this.input.value = prefill;
    if (!this.game.ui.screens.has('lf-chat')) this.game.ui.screens.open(this.screen);
    npc.lookAtTarget(this.game.player, 8);
    // the villager menu's Talk already emitted villagerTalk (→ social.talked_to); T / the demo did not
    if (!fromMenu) this.game.events.emit('villagerTalk', { npc: npc.def.id });
    setTimeout(() => this.input.focus(), 30);
  }

  /** The villager currently in chat. */
  get current(): Npc | null {
    return this.screen && this.game.ui.screens.has('lf-chat') ? this.npc : null;
  }

  /** Adds an NPC line to the log if chat with that NPC is open. */
  npcLine(npcId: string, line: string): void {
    const n = this.current;
    if (n && (n.def.id === npcId || lfNpcId(n.def.id) === npcId)) this.addLine(n.def.name, line, 'lcx-npc');
  }

  /** Sends a line to the open villager. */
  async send(raw: string): Promise<void> {
    const npc = this.npc;
    const said = raw.trim().slice(0, 600);
    if (!npc || !said) return;
    const id = lfNpcId(npc.def.id);
    const hist = this.histories.get(npc.def.id) ?? [];
    this.histories.set(npc.def.id, hist);
    this.addLine('You', said, 'lcx-me');
    this.lf.signal('social.said', { text: said, to: id });
    const goal = isGoalRequest(said) && npc.def.id !== 'iron_golem';
    if (goal) void this.sendGoal(npc, id, said);
    const lineEl = this.addLine(npc.def.name, '…', 'lcx-npc');
    const h = this.lf.ask('npc.reply', {
      npc: id,
      text: said,
      history: hist.slice(-10).map((t) => ({ role: t.role, text: t.text.slice(0, 1000) })),
      stream: true,
      context: { situation: worldSummary(this.game, playerTitle()), playerName: playerTitle() },
    });
    hist.push({ role: 'player', text: said });
    let shown = '';
    const show = (s: string, bubble: boolean) => {
      lineEl.lastChild!.textContent = ` ${s}`;
      if (bubble && s !== shown && npc.bubble) {
        shown = s;
        void npc.bubble.say(s);
      }
    };
    let streamed = false;
    h.onPartial((p) => {
      if (!streamed) show(p.full, true);
      streamed = true;
      lineEl.lastChild!.textContent = ` ${p.full}`;
    });
    try {
      const r = await h.instant;
      show(r.result.text, !streamed);
      if (!h.settled && this.lf.online) {
        const up = await h.upgrade;
        if (up) {
          show(up.result.text, true);
          this.finish(npc, hist, up.result, goal);
          return;
        }
      }
      this.finish(npc, hist, r.result, goal);
    } catch (err) {
      show(`(${npc.def.name} doesn't answer: ${(err as Error).message})`, false);
    }
  }

  private finish(npc: Npc, hist: Turn[], res: AskResult<'npc.reply'>, goalSent: boolean): void {
    hist.push({ role: 'npc', text: res.text });
    if (hist.length > 20) hist.splice(0, hist.length - 20);
    speakAs(this.lf, lfNpcId(npc.def.id), res.text);
    if (res.emote) void npc.controller.emote(res.emote, { priority: 'schedule' });
    for (const a of res.actions ?? []) {
      if (goalSent && ['build', 'follow', 'guard', 'give'].includes(a.action)) continue;
      if (a.action === 'trade' || a.action === 'quest_offer') this.close();
      void runNpcAction(this.game, this.lf, npc.def.id, a.action, (a.args ?? {}) as Record<string, unknown>);
    }
    if (res.end) setTimeout(() => this.close(), 1500);
  }

  private async sendGoal(npc: Npc, id: string, said: string): Promise<void> {
    const goal = stripAddress(said);
    this.addLine('', `${npc.def.name} takes it on as a goal: "${goal}"`, 'lcx-sys');
    try {
      const r = await this.lf.client.agents.goal(id, goal, { context: `${worldSummary(this.game, playerTitle())} ${npcSituation(this.game, npc.def.id)}` });
      getHub().caption(`${npc.def.name} plans: ${(r.plan ?? []).slice(0, 4).join(' → ') || goal}${r.local ? ' (local rules)' : ''}`, 6);
      setTimeout(() => this.close(), 900);
    } catch (err) {
      this.addLine('', `goal failed: ${(err as Error).message}`, 'lcx-sys');
    }
  }

  private close(): void {
    if (this.screen) this.game.ui.screens.close(this.screen);
  }

  private async startListening(): Promise<void> {
    const blocked = voiceBlocker(this.lf);
    const mic = blocked ? null : getMic(this.lf);
    if (!mic) {
      const msg = blocked ?? 'No microphone or speech recognition here: press T to type';
      this.game.ui.toast(msg, { kind: 'warn' });
      getHub().caption(`🎙 ${msg}`, 8);
      return;
    }
    try {
      await mic.start();
      this.listening = true;
      getHub().caption('🎙 Listening… (release V)', 30);
    } catch (err) {
      this.game.ui.toast(`Mic unavailable: ${(err as Error).message}`, { kind: 'warn' });
    }
  }

  private async stopListening(into: HTMLInputElement | null): Promise<void> {
    const mic = getMic(this.lf);
    this.listening = false;
    getHub().caption('', 0);
    if (!mic) return;
    let said = '';
    try {
      said = (await mic.stop()).trim();
    } catch (err) {
      const msg = micFailure(err);
      this.game.ui.toast(msg, { kind: 'warn' });
      getHub().caption(`🎙 ${msg}`, 8);
      return;
    }
    if (!said) {
      this.game.ui.toast('Didn’t catch that. Press T to type instead.');
      return;
    }
    if (into) {
      into.value = said;
      void this.send(said).then(() => (into.value = ''));
      return;
    }
    const n = this.targetNpc();
    if (!n) {
      this.game.ui.toast(`You said "${said}", but nobody is close enough`);
      return;
    }
    void this.voiceSend(n, said);
  }

  /** Voice talk stays in the world: no chat popup, the reply shows in the villager's speech bubble. */
  private async voiceSend(n: Npc, said: string): Promise<void> {
    this.npc = n;
    n.lookAtTarget(this.game.player, 8);
    this.game.events.emit('villagerTalk', { npc: n.def.id });
    getHub().caption(`You → ${n.def.name}: "${said}"`, 5);
    await this.send(said);
  }

  private build(): Screen {
    const root = document.createElement('div');
    const box = document.createElement('div');
    box.className = 'lcx-chat';
    this.head = document.createElement('div');
    this.head.className = 'lcx-chat-head';
    this.log = document.createElement('div');
    this.log.className = 'lcx-chat-log';
    this.chips = document.createElement('div');
    this.chips.className = 'lcx-chips';
    const row = document.createElement('div');
    row.className = 'lcx-chat-row';
    this.input = document.createElement('input');
    this.input.placeholder = 'Say something… (Enter to send, Esc to leave)';
    this.input.maxLength = 600;
    const sendBtn = document.createElement('button');
    sendBtn.textContent = 'Send';
    const micBtn = document.createElement('button');
    micBtn.textContent = '🎤';
    micBtn.title = 'Hold to speak';
    const doSend = () => {
      const v = this.input.value;
      this.input.value = '';
      void this.send(v);
    };
    sendBtn.addEventListener('click', doSend);
    micBtn.addEventListener('mousedown', () => void this.startListening());
    micBtn.addEventListener('mouseup', () => void this.stopListening(this.input));
    row.append(this.input, sendBtn, micBtn);
    const hint = document.createElement('div');
    hint.className = 'lcx-hint';
    hint.textContent = 'Enter — say · 🎤 hold — speak · ask for things: "build me…", "bring me…", "follow me"';
    box.append(this.head, this.log, this.chips, row, hint);
    root.appendChild(box);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doSend();
      }
      if (e.key !== 'Escape') e.stopPropagation();
    });
    return {
      id: 'lf-chat',
      el: root,
      pausesGame: false,
      dim: false,
      onKey: (e) => e.code !== 'Escape',
    };
  }

  private addLine(who: string, line: string, cls: string): HTMLElement {
    const d = document.createElement('div');
    d.className = cls;
    if (who) {
      const b = document.createElement('b');
      b.textContent = `${who}:`;
      d.append(b, document.createTextNode(` ${line}`));
    } else d.textContent = line;
    if (this.screen) {
      this.log.appendChild(d);
      this.log.scrollTop = this.log.scrollHeight;
    }
    return d;
  }
}

function text(s: string): HTMLElement {
  const sp = document.createElement('span');
  sp.textContent = s;
  return sp;
}

function suggestions(id: string): string[] {
  switch (id) {
    case 'bram': return ['Bram, build me a cosy house with a little tower', 'Bram, help me repair Mara’s house', 'What are you working on?'];
    case 'mara': return ['I’m sorry about your house.', 'Any work for me?', 'Can I buy some bread?'];
    case 'hilde': return ['What do you sell?', 'Got any work for me?', 'Bring me 8 iron ingots'];
    case 'pip': return ['Heard any rumours?', 'Follow me', 'What do people say about me?'];
    case 'rowan': return ['Guard the gate tonight', 'What do the monsters do at night?', 'Follow me'];
    default: return ['Hello!', 'Follow me'];
  }
}
