// "Simulate player" presets: scripted signal sequences that push the Observer toward a recognisable play style.
// The dashboard streams them to POST /admin/simulate in small batches (so traits visibly climb in real time); the
// demo source feeds them into its in-browser simulation. Signal fields follow BUILTIN_SIGNALS.
import { mulberry32 } from "@liveforge/protocol";

export interface SimSignal {
  type: string;
  data: Record<string, unknown>;
}

export interface SimPreset {
  id: string;
  name: string;
  /** One-line pitch shown on the card. */
  blurb: string;
  /** Traits this preset should light up. */
  expect: string[];
  /** Suggested player id. */
  player: string;
  /** Accent colour for the card. */
  color: string;
  build(seed: number): SimSignal[];
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)];
const NPCS = ["vale", "pell", "marrow", "kit"];
const ENEMIES = ["hollow", "slag_imp", "chalk_wraith", "ash_hound"];
const ZONES = ["courtyard", "library", "forge_hall", "undercroft", "lecture_hall"];

export const PRESETS: SimPreset[] = [
  {
    id: "rich_hoarder",
    name: "Rich hoarder",
    blurb: "Sits on a mountain of forge-marks, sells everything, buys nothing - then struts around the courtyard.",
    expect: ["rich", "hoarder"],
    player: "sim_hoarder",
    color: "#c98500",
    build(seed) {
      const r = mulberry32(seed);
      const out: SimSignal[] = [{ type: "movement.entered_zone", data: { zone: "forge_hall" } }];
      let gold = 120;
      for (let i = 0; i < 14; i++) {
        const price = 40 + Math.round(r() * 160);
        gold += price;
        out.push({ type: "economy.sold", data: { item: pick(r, ["slag_ingot", "old_blade", "chalk_relic", "veil_shard"]), price, vendor: "pell" } });
        out.push({ type: "economy.gold", data: { amount: gold, delta: price } });
      }
      out.push({ type: "gear.equipped", data: { item: "gilded_circlet", slot: "head", name: "Gilded Circlet", tags: ["gold", "showy"], value: 900 } });
      out.push({ type: "movement.entered_zone", data: { zone: "courtyard", kind: "hub" } });
      out.push({ type: "social.talked_to", data: { npc: "pell" } });
      out.push({ type: "economy.gold", data: { amount: gold + 400, delta: 400 } });
      return out;
    },
  },
  {
    id: "dodger",
    name: "Dodger",
    blurb: "Rolls through everything the Forge Titan throws, always to the left. The Director notices.",
    expect: ["dodger"],
    player: "sim_dodger",
    color: "#3987e5",
    build(seed) {
      const r = mulberry32(seed);
      const out: SimSignal[] = [{ type: "movement.entered_zone", data: { zone: "forge_hall", kind: "arena" } }];
      for (let i = 0; i < 26; i++) {
        out.push({ type: "combat.dodged", data: { source: "forge_titan", attack: pick(r, ["slam", "barrage", "sweep", "geysers"]), direction: r() < 0.75 ? "left" : "right" } });
        if (i % 5 === 4) out.push({ type: "combat.hit", data: { target: "forge_titan", target_type: "boss", damage: 8 + Math.round(r() * 6), weapon: "spear" } });
      }
      out.push({ type: "combat.hurt", data: { source: "forge_titan", damage: 9, hp: 0.82, attack: "sweep" } });
      out.push({ type: "boss.phase_cleared", data: { boss: "forge_titan", phase: 1, flawless: false } });
      return out;
    },
  },
  {
    id: "pacifist_chatterbox",
    name: "Pacifist chatterbox",
    blurb: "Talks to every NPC, gives gifts, never draws a blade. The porters adore them.",
    expect: ["pacifist", "chatterbox", "beloved"],
    player: "sim_chatter",
    color: "#d55181",
    build(seed) {
      const r = mulberry32(seed);
      const lines = [
        "Lovely morning, isn't it?", "What do you know about the Veil?", "Can I help with anything?", "Tell me about the Titan.",
        "I brought you something.", "Any news from the lodge?", "Is the library open late?", "I'd rather talk than fight.",
      ];
      const out: SimSignal[] = [{ type: "movement.entered_zone", data: { zone: "courtyard", kind: "hub" } }];
      for (let i = 0; i < 18; i++) {
        const npc = pick(r, NPCS);
        if (i % 3 === 0) out.push({ type: "social.talked_to", data: { npc } });
        out.push({ type: "social.said", data: { text: pick(r, lines), to: npc } });
        if (i % 6 === 5) out.push({ type: "social.gave", data: { to: npc, item: pick(r, ["tea", "returned_book", "ribbon"]) } });
      }
      out.push({ type: "world.helped", data: { npc: "pell", how: "carried trunks" } });
      out.push({ type: "movement.fled", data: { from: "ash_hound", hp: 0.9 } });
      return out;
    },
  },
  {
    id: "murderer",
    name: "Murderer",
    blurb: "Cuts down porters and students in the courtyard. Guards keep their distance; rumours spread fast.",
    expect: ["murderer", "feared"],
    player: "sim_murderer",
    color: "#e66767",
    build(seed) {
      const r = mulberry32(seed);
      const out: SimSignal[] = [{ type: "movement.entered_zone", data: { zone: "courtyard", kind: "hub" } }];
      for (let i = 0; i < 9; i++) {
        const target = pick(r, ["student", "porter", "warden", "student"]);
        out.push({ type: "social.threatened", data: { target } });
        out.push({ type: "combat.hit", data: { target: `${target}_${i}`, target_type: "civilian", damage: 30 + Math.round(r() * 20), weapon: "greatsword" } });
        out.push({ type: "combat.killed", data: { target: `${target}_${i}`, target_type: "civilian", weapon: "greatsword" } });
      }
      out.push({ type: "world.destroyed", data: { object: "lodge_door", zone: "courtyard", owner: "porters" } });
      out.push({ type: "combat.killed", data: { target: "warden_captain", target_type: "civilian", elite: true } });
      return out;
    },
  },
  {
    id: "light_fingers",
    name: "Light fingers",
    blurb: "Pockets everything not nailed down, lies about it, and fences the loot in the Undercroft.",
    expect: ["thief", "liar"],
    player: "sim_thief",
    color: "#9085e9",
    build(seed) {
      const r = mulberry32(seed);
      const out: SimSignal[] = [{ type: "movement.entered_zone", data: { zone: "courtyard", kind: "hub" } }];
      for (let i = 0; i < 10; i++) {
        out.push({ type: "economy.stole", data: { from: pick(r, ["pell", "student", "marrow", "vendor"]), item: pick(r, ["purse", "inkwell", "ledger", "ring"]), value: 20 + Math.round(r() * 80), seen: r() < 0.3 } });
        if (i % 3 === 2) out.push({ type: "social.lied", data: { to: pick(r, NPCS), about: "the missing purse" } });
      }
      out.push({ type: "movement.entered_zone", data: { zone: "undercroft" } });
      out.push({ type: "economy.sold", data: { item: "stolen_ring", price: 140, vendor: "kit" } });
      return out;
    },
  },
  {
    id: "explorer",
    name: "Explorer",
    blurb: "Maps every corridor and reads every plaque before the first fight.",
    expect: ["explorer"],
    player: "sim_explorer",
    color: "#199e70",
    build(seed) {
      const r = mulberry32(seed);
      const out: SimSignal[] = [];
      const discoveries = ["hidden_stair", "old_mural", "sealed_door", "professor_notes", "veil_crack", "bell_tower", "dry_well", "lost_anvil"];
      for (let i = 0; i < 16; i++) {
        out.push({ type: "movement.entered_zone", data: { zone: pick(r, ZONES) } });
        out.push({ type: "movement.explored", data: { discovery: pick(r, discoveries), zone: pick(r, ZONES) } });
      }
      out.push({ type: "combat.killed", data: { target: "ash_hound_1", target_type: pick(r, ENEMIES) } });
      return out;
    },
  },
];

export const presetById = (id: string): SimPreset | undefined => PRESETS.find((p) => p.id === id);
