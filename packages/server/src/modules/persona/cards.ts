// Persona cards (spec §3.2) from the manifest, a generic card for undeclared NPC ids, voice styles for SDK TTS,
// and the action rules (persona allowedActions ∩ manifest action schema, args clamped).
import { actionsFor, personaById, type Manifest, type PersonaConfig } from "@liveforge/manifest";
import type { NpcAction, VoiceStyle } from "@liveforge/protocol";

export interface PersonaCard extends PersonaConfig {
  /** false = the NPC id is not declared in the manifest (generic townsperson, emote only). */
  declared: boolean;
}

/** The persona card for an NPC id (a neutral generic card when the manifest does not declare it). */
export function personaCard(m: Manifest, npc: string): PersonaCard {
  const p = personaById(m, npc);
  if (p) return { ...p, declared: true };
  const name = npc.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 64) || "Stranger";
  return {
    id: npc, name, role: "local", personality: "An ordinary inhabitant of this world: polite, a little wary of strangers, brief.",
    voice: {}, knowledge: [], secrets: [], likes: [], dislikes: [], barks: [], declared: false, allowedActions: ["emote"],
  };
}

/** Voice hints for SDK TTS, nudged by mood (angry = faster + lower, warm = slightly slower). */
export function voiceFor(card: PersonaCard, mood = 0): VoiceStyle {
  const v = card.voice ?? {};
  const out: VoiceStyle = {};
  const clampV = (x: number) => Math.round(Math.max(0.5, Math.min(2, x)) * 100) / 100;
  const pitch = v.pitch ?? 1;
  const rate = v.rate ?? 1;
  if (v.pitch !== undefined || mood <= -0.2) out.pitch = clampV(pitch - (mood <= -0.2 ? 0.05 : 0));
  if (v.rate !== undefined || Math.abs(mood) >= 0.2) out.rate = clampV(rate + (mood <= -0.2 ? 0.1 : mood >= 0.2 ? -0.05 : 0));
  if (v.accent) out.accent = v.accent;
  const style = [v.style, mood <= -0.3 ? "curt" : mood >= 0.3 ? "warm" : ""].filter(Boolean).join(", ");
  if (style) out.style = style.slice(0, 64);
  if (v.voiceId) out.voiceId = v.voiceId;
  return out;
}

/** Actions this NPC may take (persona allowedActions ∩ manifest actions usable by npc; undeclared NPCs: emote). */
export function allowedActions(m: Manifest, card: PersonaCard): string[] {
  if (!card.declared) return "emote" in m.actions ? ["emote"] : [];
  return actionsFor(m, card.id);
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Trade price multiplier from faction price range and attitude (friendly = cheaper), clamped by the manifest. */
export function priceMultiplier(m: Manifest, card: PersonaCard, attitude: number): number {
  const range = m.factions.find((f) => f.id === card.faction)?.priceRange ?? [0.8, 1.5];
  const [lo, hi] = [Math.min(range[0], range[1]), Math.max(range[0], range[1])];
  const mid = (lo + hi) / 2;
  const v = attitude >= 0 ? mid - (mid - lo) * attitude : mid + (hi - mid) * -attitude;
  const [cl, ch] = m.clamps.npc.priceMultiplier;
  const arg = m.actions.trade?.args?.priceMultiplier;
  const min = Math.max(cl, arg?.min ?? -Infinity);
  const max = Math.min(ch, arg?.max ?? Infinity);
  return Math.round(Math.max(min, Math.min(max, v)) * 100) / 100;
}

export interface RawAction {
  action: string;
  args?: Record<string, unknown>;
  target?: string;
}

/**
 * Validate + clamp actions against the persona's allowed actions and the manifest action schema:
 * unknown actions dropped, args coerced to their declared types, numbers clamped, enums enforced, unknown args
 * removed, missing required args filled from sensible defaults or the action dropped. `reveal` needs attitude
 * >= 0.35 and must name one of the persona's secrets. At most 3 actions, one per kind.
 */
export function sanitizeActions(m: Manifest, card: PersonaCard, raw: RawAction[], opts: { attitude: number }): NpcAction[] {
  const allowed = new Set(allowedActions(m, card));
  const out: NpcAction[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (out.length >= 3) break;
    const name = typeof r?.action === "string" ? r.action.trim() : "";
    if (!allowed.has(name) || seen.has(name)) continue;
    const schema = m.actions[name];
    const args: Record<string, unknown> = {};
    let ok = true;
    for (const [arg, spec] of Object.entries(schema?.args ?? {})) {
      let v: unknown = r.args?.[arg];
      if (v === undefined || v === null || v === "") v = defaultArg(m, card, name, arg, opts.attitude);
      if (v === undefined) { if (spec.required) ok = false; continue; }
      if (spec.type === "number") {
        let n = num(v);
        if (n === null) { if (spec.required) ok = false; continue; }
        if (spec.min !== undefined) n = Math.max(spec.min, n);
        if (spec.max !== undefined) n = Math.min(spec.max, n);
        if (name === "trade" && arg === "priceMultiplier") n = Math.max(m.clamps.npc.priceMultiplier[0], Math.min(m.clamps.npc.priceMultiplier[1], n));
        args[arg] = Math.round(n * 100) / 100;
      } else if (spec.type === "boolean") {
        args[arg] = v === true || v === "true" || v === 1 || v === "1";
      } else {
        const s = String(v).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);
        if (spec.enum && !spec.enum.includes(s)) { if (spec.required) ok = false; continue; }
        if (!s) { if (spec.required) ok = false; continue; }
        args[arg] = s;
      }
    }
    if (!ok) continue;
    if (name === "reveal") {
      if (opts.attitude < 0.35 || !card.secrets.length) continue;
      const said = String(args.secret ?? r.args?.secret ?? "").toLowerCase();
      const match = card.secrets.find((s) => said && (s.toLowerCase().includes(said) || said.includes(s.toLowerCase().slice(0, 24))));
      if ("secret" in (schema?.args ?? {})) args.secret = match ?? card.secrets[0];
    }
    seen.add(name);
    const target = typeof r.target === "string" && /^[A-Za-z0-9_\-.:]{1,64}$/.test(r.target) ? r.target : undefined;
    out.push({ action: name, args, ...(target ? { target } : {}) });
  }
  return out;
}

function defaultArg(m: Manifest, card: PersonaCard, action: string, arg: string, attitude: number): unknown {
  if (action === "trade" && arg === "priceMultiplier") return priceMultiplier(m, card, attitude);
  if (action === "emote" && (arg === "name" || arg === "emote" || arg === "anim")) return "nod";
  if (action === "steal" && arg === "gold") return 25;
  return undefined;
}

/** A safe single action for instant answers (an emote if this NPC may emote). */
export function safeEmote(m: Manifest, card: PersonaCard, emote: string): NpcAction[] {
  return sanitizeActions(m, card, [{ action: "emote", args: { name: emote, emote, anim: emote } }], { attitude: 0 });
}
