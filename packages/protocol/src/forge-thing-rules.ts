// forge.thing keyless rules (the instant / offline answer): keyword categorisation (head noun wins: "chicken soup"
// is food, "a statue of a chicken" a decoration, "block of gold" a block), colour words -> palette, effect / rarity
// words, and template voxel models per category that look like the thing in broad strokes (a white chicken with a red
// comb and wattle, yellow beak and legs, small wings). Deterministic, pure TypeScript.
//
//   rulesForgedThing({ prompt: "a chicken" })  -> ForgedThing (category creature, chicken model, sounds, lays egg)
//   analyzeThing("a golden fire sword")        -> { category: "weapon", kind: "sword", colors: [gold], effect: "fire_trail" ... }
import { cleanText, hashString } from "./common.js";
import type { VoxelOp, VoxelVec } from "./voxel.js";
import { shiftVoxelOps } from "./voxel-templates.js";
import {
  THING_CATEGORIES, THING_COLOR_WORDS, THING_RARITIES, VOXEL_MODEL_LIMITS, clampThingStats, clampVoxelModel, expandVoxelModel, thingId,
  type ForgedThing, type ThingBehaviour, type ThingCategory, type ThingCreature, type ThingEffect, type ThingPart, type ThingRarity,
  type ThingRecipe, type ThingSlot, type ThingStats, type ThingVehicle, type VoxelModel,
} from "./forge-thing.js";

// ================================================================ model builder

/** Lighten (amt > 0) or darken (amt < 0) a "#rrggbb" colour. */
export function shadeColor(hex: string, amt: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (c: number) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Writes ops in nominal coordinates and scales them to fit `maxSize` (k = min(scale, maxSize / largest axis)).
 * `*X` helpers add the mirror image across the model's centre plane (x' = W - 1 - x).
 */
class ModelBuilder {
  readonly ops: VoxelOp[] = [];
  readonly palette: Record<string, string> = {};
  readonly parts: ThingPart[] = [];
  readonly size: VoxelVec;
  pivot: VoxelVec | undefined;
  /** Palette keys the first / second colour word recolours. */
  main = "main";
  accent = "accent";
  private readonly k: number;
  private readonly W: number;

  constructor(nominal: VoxelVec, maxSize: number, scale = 1) {
    this.k = Math.min(scale, maxSize / Math.max(...nominal));
    this.W = nominal[0];
    this.size = nominal.map((d) => Math.max(1, Math.min(maxSize, Math.round(d * this.k)))) as VoxelVec;
  }
  private p(v: VoxelVec): VoxelVec {
    return v.map((x, i) => Math.max(0, Math.min(this.size[i] - 1, Math.round(x * this.k)))) as VoxelVec;
  }
  private r(n: number): number {
    return Math.max(1, Math.round(n * this.k));
  }
  private mx(v: VoxelVec): VoxelVec {
    return [this.W - 1 - v[0], v[1], v[2]];
  }
  color(key: string, hex: string): this {
    this.palette[key] = hex;
    return this;
  }
  colors(map: Record<string, string>): this {
    Object.assign(this.palette, map);
    return this;
  }
  box(a: VoxelVec, b: VoxelVec, key: string): this {
    this.ops.push({ op: "box", from: this.p(a), to: this.p(b), block: key });
    return this;
  }
  hollow(a: VoxelVec, b: VoxelVec, key: string): this {
    this.ops.push({ op: "hollow_box", from: this.p(a), to: this.p(b), block: key });
    return this;
  }
  edges(a: VoxelVec, b: VoxelVec, key: string): this {
    this.ops.push({ op: "edges", from: this.p(a), to: this.p(b), block: key });
    return this;
  }
  line(a: VoxelVec, b: VoxelVec, key: string): this {
    this.ops.push({ op: "line", from: this.p(a), to: this.p(b), block: key });
    return this;
  }
  dot(a: VoxelVec, key: string): this {
    this.ops.push({ op: "block", at: this.p(a), block: key });
    return this;
  }
  air(a: VoxelVec, b: VoxelVec): this {
    this.ops.push({ op: "fill_air", from: this.p(a), to: this.p(b) });
    return this;
  }
  sphere(c: VoxelVec, radius: number, key: string): this {
    this.ops.push({ op: "sphere", center: this.p(c), radius: this.r(radius), block: key });
    return this;
  }
  /** Vertical cylinder standing on c (bottom centre). */
  cyl(c: VoxelVec, radius: number, height: number, key: string, hollow = false): this {
    this.ops.push({ op: "cylinder", center: this.p(c), radius: this.r(radius), height: this.r(height), ...(hollow ? { hollow: true } : {}), block: key });
    return this;
  }
  roof(a: VoxelVec, b: VoxelVec, key: string): this {
    this.ops.push({ op: "roof", style: "gable", from: this.p(a), to: this.p(b), block: key });
    return this;
  }
  boxX(a: VoxelVec, b: VoxelVec, key: string): this {
    return this.box(a, b, key).box(this.mx(a), this.mx(b), key);
  }
  lineX(a: VoxelVec, b: VoxelVec, key: string): this {
    return this.line(a, b, key).line(this.mx(a), this.mx(b), key);
  }
  dotX(a: VoxelVec, key: string): this {
    return this.dot(a, key).dot(this.mx(a), key);
  }
  part(name: string, a: VoxelVec, b: VoxelVec): this {
    this.parts.push({ name, from: this.p(a), to: this.p(b) });
    return this;
  }
  partX(left: string, right: string, a: VoxelVec, b: VoxelVec): this {
    return this.part(left, a, b).part(right, this.mx(a), this.mx(b));
  }
  setPivot(v: VoxelVec): this {
    this.pivot = this.p(v);
    return this;
  }
  model(): VoxelModel {
    return { size: this.size, palette: { ...this.palette }, ops: this.ops, ...(this.pivot ? { pivot: this.pivot } : {}) };
  }
}

const EYE = "#1c1c22";
const WHITE = "#f4f4f0";
const WOOD = "#a8743e";
const DARK_WOOD = "#6b4a2b";
const IRON = "#d8dde4";
const GOLD = "#f2c230";
const GLOW = "#ffe27a";
const FLAME = "#ff8a1a";
const LEAF = "#4caf50";
const STONE = "#9a9aa0";

// ================================================================ creatures

type Plan = "bird" | "quad" | "fish" | "bug" | "serpent" | "blob" | "biped" | "dragon";

interface Species {
  key: string;
  plan: Plan;
  /** 0 small, 1 medium, 2 large (model detail scale). */
  scale: number;
  colors: [string, string, string];
  behaviour: ThingBehaviour;
  health: number;
  speed: number;
  /** World height in blocks. */
  size: number;
  sounds: string[];
  drops: string[];
  flags: Set<string>;
  lays?: string;
  tame?: string;
}

const SPECIES: Record<string, Species> = {};
/** creature word -> species key. */
const CREATURE_WORDS: Record<string, string> = {};

/** names (first = key) | plan | scale | colours | behaviour | health | speed | size | sounds | drops | flags | lays | tame */
function sp(names: string, plan: Plan, scale: number, colors: string, behaviour: ThingBehaviour, health: number, speed: number, size: number, sounds: string, drops: string, flags = "", lays = "", tame = ""): void {
  const words = names.split(" ");
  const c = colors.split(" ");
  const s: Species = {
    key: words[0], plan, scale, colors: [c[0], c[1] ?? c[0], c[2] ?? c[1] ?? c[0]], behaviour, health, speed, size,
    sounds: sounds.split("|").filter(Boolean), drops: drops.split(" ").filter(Boolean), flags: new Set(flags.split(" ").filter(Boolean)),
    ...(lays ? { lays } : {}), ...(tame ? { tame } : {}),
  };
  SPECIES[s.key] = s;
  for (const w of words) CREATURE_WORDS[w.replace(/_/g, " ")] = s.key;
}

// birds
sp("chicken hen", "bird", 1, "#f4f4f0 #d93b2b #f2c230", "passive", 4, 2.5, 0.7, "bawk!|cluck cluck|bok bok?", "feather raw_chicken", "comb wattle", "egg", "wheat_seeds");
sp("rooster cockerel", "bird", 1, "#f4f4f0 #d93b2b #f2c230", "passive", 5, 2.5, 0.8, "cock-a-doodle-doo!|bawk!", "feather raw_chicken", "comb tallcomb wattle", "", "wheat_seeds");
sp("chick chickling", "bird", 0, "#ffe14a #f29a2e #f29a2e", "passive", 2, 2, 0.4, "peep!|cheep cheep", "feather", "", "", "wheat_seeds");
sp("turkey", "bird", 2, "#6b4a2b #d93b2b #a07a50", "passive", 6, 2.5, 1, "gobble gobble!", "feather raw_turkey", "wattle fan");
sp("duck duckling", "bird", 1, "#f4f4f0 #f29a2e #f29a2e", "passive", 4, 2.5, 0.7, "quack!|quack quack", "feather raw_duck", "flatbeak", "egg", "bread");
sp("goose", "bird", 1, "#f4f4f0 #f29a2e #2a2a2a", "neutral", 6, 3, 0.9, "honk!|HONK", "feather", "flatbeak neck", "egg", "bread");
sp("swan", "bird", 1, "#f8f8f8 #f29a2e #2a2a2a", "swimming", 6, 2.5, 1, "hiss!", "feather", "flatbeak neck");
sp("owl", "bird", 1, "#8a6a43 #f2c230 #f2c230", "flying", 5, 4, 0.7, "hoo hoo|hoo?", "feather", "upright");
sp("parrot parakeet macaw", "bird", 1, "#e23b2e #f2c230 #3b6fd9", "pet", 4, 4, 0.6, "squawk!|hello!|pretty bird!", "feather", "", "", "wheat_seeds");
sp("bat", "bird", 0, "#3a3036 #5a4a50 #f4f4f0", "flying", 3, 5, 0.4, "squeak!|*flap flap*", "leather", "upright");
sp("crow raven", "bird", 1, "#24242c #3a3a44 #3a3a44", "flying", 4, 5, 0.6, "caw!|caw caw", "feather");
sp("eagle hawk falcon", "bird", 2, "#6b4a2b #f4f4f0 #f2c230", "flying", 8, 6, 1, "screech!", "feather");
sp("pigeon dove", "bird", 1, "#9aa0aa #6a6f7a #d98aa0", "flying", 3, 4, 0.5, "coo|coo coo", "feather");
sp("penguin", "bird", 1, "#22242a #f4f4f0 #f29a2e", "swimming", 6, 2, 0.8, "honk honk", "feather", "upright");
sp("flamingo", "bird", 1, "#f29ab8 #22242a #f29ab8", "passive", 6, 2.5, 1.4, "honk?", "feather", "longlegs neck");
sp("bird sparrow robin canary finch bluebird songbird", "bird", 0, "#5fa0e0 #f2c230 #f2c230", "flying", 3, 4, 0.4, "tweet!|chirp chirp", "feather");
sp("phoenix firebird", "bird", 2, "#ff6a1a #ffd23f #ffd23f", "flying", 60, 7, 1.5, "kreee!", "phoenix_feather", "fan");
// quadrupeds (flags: stocky / slim / tall / low build + features)
sp("cow calf cattle", "quad", 2, "#f4f4f0 #2a2a2a #f2b8c0", "passive", 10, 2, 1.4, "moo|moooo", "leather raw_beef", "stocky horns spots snout", "", "wheat");
sp("bull ox buffalo bison yak", "quad", 2, "#5a3a24 #e8e0c8 #2a2a2a", "neutral", 14, 2.5, 1.5, "snort!|MOO", "leather raw_beef", "stocky horns snout");
sp("pig piglet hog swine", "quad", 1, "#f2a6b4 #e0808f #d0707f", "passive", 10, 2, 0.9, "oink!|oink oink", "raw_porkchop", "stocky snout ears", "", "carrot");
sp("boar warthog", "quad", 1, "#5a3e2b #e8e0c8 #3a2a1e", "hostile", 12, 3, 1, "snort!", "raw_porkchop leather", "stocky snout tusks");
sp("sheep lamb ram", "quad", 1, "#f0efe8 #4a4a4a #4a4a4a", "passive", 8, 2, 1, "baa|baaa", "wool raw_mutton", "stocky wool", "", "wheat");
sp("goat", "quad", 1, "#e8e2d4 #8a7a64 #5a4a3a", "neutral", 10, 3, 1, "meh-eh-eh!", "leather", "slim horns");
sp("horse pony stallion mare foal", "quad", 2, "#8a5a35 #3a2a1e #3a2a1e", "passive", 15, 6, 1.6, "neigh!|whinny", "leather", "tall mane neck", "", "apple");
sp("donkey mule", "quad", 1, "#8a8078 #3a3a3a #2a2a2a", "passive", 15, 4, 1.4, "hee-haw!", "leather", "tall mane neck longears", "", "apple");
sp("unicorn", "quad", 2, "#f8f4ff #f29ae0 #ffd23f", "passive", 20, 7, 1.6, "neigh~", "unicorn_hair", "tall mane neck horn", "", "golden_apple");
sp("deer stag doe elk moose reindeer", "quad", 2, "#9a6a3a #f4f4f0 #2a2a2a", "passive", 10, 6, 1.4, "*snort*", "leather raw_venison", "tall antlers neck");
sp("dog puppy hound pup doggo", "quad", 1, "#b07a45 #6b4a2b #2a2a2a", "pet", 12, 5, 0.8, "woof!|arf arf|*wags tail*", "", "slim ears snout", "", "bone");
sp("wolf", "quad", 1, "#9a9a9e #d8d8d8 #2a2a2a", "neutral", 10, 5, 0.9, "awoo!|grrr", "bone", "slim ears snout", "", "bone");
sp("fox", "quad", 0, "#e0732a #f4f4f0 #2a2a2a", "neutral", 8, 5, 0.6, "yip!|ring-ding-ding!", "", "slim ears snout bushy", "", "sweet_berries");
sp("cat kitten kitty", "quad", 0, "#e09a4a #f4f4f0 #f2a6b4", "pet", 8, 4, 0.5, "meow|purr...|mrrp?", "string", "slim ears", "", "raw_fish");
sp("tiger", "quad", 2, "#f08a2a #22242a #f4f4f0", "hostile", 30, 6, 1.2, "ROAR|grrr", "", "stocky ears stripes snout");
sp("lion lioness", "quad", 2, "#d8a24a #8a5a25 #2a2a2a", "hostile", 30, 6, 1.3, "ROAR!", "", "stocky mane snout ears");
sp("leopard cheetah jaguar panther", "quad", 1, "#e0b050 #2a2a2a #2a2a2a", "hostile", 20, 8, 1, "rrrowr", "", "slim spots ears snout");
sp("bear grizzly", "quad", 2, "#6b4a2b #3a2a1e #2a2a2a", "neutral", 30, 4, 1.6, "grrr|*sniff*", "raw_salmon", "stocky ears snout", "", "honey");
sp("panda", "quad", 2, "#f4f4f0 #22242a #22242a", "passive", 20, 2, 1.3, "*munch munch*", "bamboo", "stocky ears panda", "", "bamboo");
sp("rabbit bunny hare", "quad", 0, "#e8e0d4 #f2a6b4 #2a2a2a", "passive", 3, 5, 0.4, "*sniff sniff*|*thump*", "rabbit_hide raw_rabbit", "slim longears", "", "carrot");
sp("mouse rat hamster gerbil", "quad", 0, "#9a9a9e #f2a6b4 #2a2a2a", "passive", 2, 4, 0.3, "squeak!", "", "low ears", "", "cheese");
sp("squirrel chipmunk", "quad", 0, "#a0603a #f4e0c0 #2a2a2a", "passive", 3, 6, 0.4, "chitter!", "", "slim ears bushy", "", "acorn");
sp("hedgehog porcupine", "quad", 0, "#7a5a3a #e8d0b0 #2a2a2a", "passive", 4, 2, 0.3, "huff!", "", "low spikes snout");
sp("elephant mammoth", "quad", 2, "#9a9aa4 #f4f0e0 #2a2a2a", "neutral", 40, 3, 2.5, "PAWOO!", "ivory", "stocky trunk ears tusks");
sp("giraffe", "quad", 2, "#e8b84a #8a5a25 #2a2a2a", "passive", 20, 5, 3, "*hum*", "leather", "tall neck spots horn");
sp("camel llama alpaca", "quad", 2, "#d8c09a #8a6a4a #2a2a2a", "neutral", 15, 4, 1.8, "*spit*", "wool", "tall neck ears", "", "wheat");
sp("otter beaver raccoon badger ferret weasel skunk mole", "quad", 0, "#7a5a3a #e8d8c0 #2a2a2a", "passive", 6, 4, 0.5, "chirp!", "", "low ears snout");
sp("turtle tortoise", "quad", 0, "#6a9a4a #5a7a3a #2a2a2a", "passive", 15, 1, 0.5, "...", "turtle_shell", "low shell", "turtle_egg", "seagrass");
sp("frog toad", "quad", 0, "#4caf50 #f4f4f0 #2a2a2a", "passive", 4, 3, 0.4, "ribbit!|croak", "slimeball", "low frog");
sp("lizard gecko axolotl iguana chameleon salamander newt", "quad", 0, "#6ab04a #f2d03a #2a2a2a", "passive", 5, 4, 0.3, "*blink*", "", "low longtail");
sp("crocodile alligator croc gator", "quad", 2, "#4a7a3a #e8e0a0 #2a2a2a", "hostile", 30, 3, 1, "SNAP!", "leather", "low longtail snout spikes");
sp("dinosaur dino rex trex raptor triceratops stegosaurus", "quad", 2, "#5a9a4a #e8d06a #2a2a2a", "hostile", 60, 5, 3, "RAWR!", "bone", "stocky longtail spikes snout");
sp("monster creature beast animal critter", "quad", 1, "#8a6ad0 #f2d03a #2a2a2a", "neutral", 15, 3, 1, "grr?|*snuffle*", "", "slim ears snout");
sp("pet", "quad", 0, "#c8a07a #f4f4f0 #2a2a2a", "pet", 8, 4, 0.6, "*happy noises*", "", "slim ears snout", "", "cookie");
// dragons
sp("dragon wyvern drake", "dragon", 2, "#3a9a4a #e8d06a #ff6a1a", "hostile", 200, 6, 4, "ROAR!|*puffs smoke*", "dragon_scale", "stocky wings horns spikes longtail snout");
sp("griffin gryphon hippogriff", "dragon", 2, "#c8a050 #f4f4f0 #f2c230", "neutral", 60, 7, 2, "screech!", "feather", "stocky wings snout");
// fish
sp("fish goldfish salmon cod trout carp koi tuna minnow", "fish", 0, "#f29a2e #f4f4f0 #2a2a2a", "swimming", 3, 4, 0.4, "blub|*blub blub*", "raw_fish");
sp("clownfish", "fish", 0, "#f08a24 #f4f4f0 #2a2a2a", "swimming", 3, 4, 0.3, "blub!", "raw_fish", "stripes");
sp("piranha", "fish", 0, "#9aa0aa #d93b2b #2a2a2a", "hostile", 4, 6, 0.4, "*chomp chomp*", "raw_fish");
sp("shark", "fish", 2, "#7a8a9a #f4f4f0 #2a2a2a", "hostile", 30, 6, 2, "*chomp*", "shark_tooth", "fin");
sp("whale orca", "fish", 2, "#3a5a8a #e8eef4 #2a2a2a", "swimming", 100, 3, 6, "*whale song*", "blubber", "fin");
sp("dolphin porpoise", "fish", 1, "#8a9aaa #e8eef4 #2a2a2a", "swimming", 10, 7, 1.2, "click click!|eee-eee!", "raw_fish", "fin");
sp("seal walrus", "fish", 1, "#8a8a90 #c8c8cc #2a2a2a", "swimming", 10, 3, 1, "arf arf!", "raw_fish");
// bugs
sp("spider tarantula", "bug", 1, "#2a2a30 #d93b2b #4a2a2a", "hostile", 16, 4, 0.9, "hsss|*click click*", "string spider_eye", "eight");
sp("ant termite", "bug", 0, "#3a2a24 #2a2a2a #2a2a2a", "passive", 2, 3, 0.2, "...", "", "six");
sp("beetle ladybug ladybird", "bug", 0, "#d93b2b #22242a #22242a", "passive", 3, 2, 0.3, "*click*", "", "six spots");
sp("scorpion", "bug", 1, "#c8903a #8a5a25 #2a2a2a", "hostile", 12, 4, 0.6, "*clack*", "", "six claws stinger");
sp("crab lobster crayfish", "bug", 0, "#d9533a #f4c0a0 #2a2a2a", "neutral", 6, 3, 0.4, "*clack clack*", "crab_claw", "six claws");
sp("bee bumblebee wasp hornet", "bug", 0, "#f2c230 #2a2a2a #e8f4ff", "flying", 4, 4, 0.3, "bzzz|bzz bzz", "", "six wings stripes stinger", "honeycomb", "flower");
sp("butterfly moth", "bug", 0, "#f29a2e #2a2a2a #ffffff", "flying", 2, 3, 0.3, "*flutter*", "", "bigwings");
sp("firefly glowbug lightningbug", "bug", 0, "#3a3a2a #f0ff80 #ffffff", "flying", 2, 3, 0.2, "*blink*", "glowstone_dust", "bigwings glowtail");
sp("dragonfly", "bug", 0, "#3ad6e0 #c8f0ff #2a2a2a", "flying", 2, 6, 0.3, "*zzip*", "", "bigwings");
// serpents
sp("snake serpent cobra python viper", "serpent", 1, "#4a9a3a #f2d03a #d93b2b", "hostile", 8, 3, 0.3, "hsss!", "snake_skin");
sp("worm earthworm caterpillar slug grub", "serpent", 0, "#e0a0a0 #c08080 #2a2a2a", "passive", 2, 1, 0.2, "*wiggle*", "", "nohead");
sp("snail", "serpent", 0, "#c8b090 #a0603a #2a2a2a", "passive", 3, 0.5, 0.3, "*slurp*", "", "nohead shell");
sp("eel", "serpent", 1, "#3a4a3a #e8e070 #2a2a2a", "swimming", 6, 5, 0.3, "*zzt*", "raw_fish");
// blobs
sp("slime blob goo ooze jelly", "blob", 1, "#6ad06a #3a9a3a #2a2a2a", "hostile", 8, 3, 1, "blorp|*squish*", "slimeball");
sp("ghost spirit phantom wraith specter spectre poltergeist", "blob", 1, "#eef0ff #2a2a2a #9aa0ff", "flying", 10, 4, 1.2, "ooOOoo|boo!", "ectoplasm", "ghost");
sp("jellyfish", "blob", 1, "#c8a0f0 #f0d8ff #2a2a2a", "swimming", 4, 2, 0.6, "*bloop*", "slimeball", "tentacles");
sp("octopus squid kraken", "blob", 1, "#d9534f #f4d0c0 #2a2a2a", "swimming", 10, 3, 1, "*splort*", "ink_sac", "tentacles");
sp("snowman", "blob", 1, "#f8f8ff #f08a24 #26262c", "passive", 4, 1, 1.8, "*crunch*", "snowball", "snowman");
// bipeds
sp("zombie undead ghoul", "biped", 1, "#5a9a4a #3a5aa0 #4a3a8a", "hostile", 20, 2, 1.9, "braaains|urrgh", "rotten_flesh");
sp("skeleton", "biped", 1, "#e8e4d8 #c8c4b8 #2a2a2a", "hostile", 20, 2.5, 1.9, "*rattle rattle*", "bone arrow", "thin");
sp("golem", "biped", 2, "#9a9a9a #c8c8c8 #ff6a1a", "guard", 100, 2, 2.5, "*clunk*", "iron_ingot", "bulky");
sp("robot automaton android droid", "biped", 1, "#b8c0c8 #3ad6e0 #5a6068", "guard", 40, 3, 1.8, "beep boop|*whirr*", "iron_ingot redstone", "antenna");
sp("goblin imp gremlin kobold", "biped", 0, "#6aa04a #6b4a2b #d93b2b", "hostile", 10, 4, 1, "hehehe!|mine!", "coin");
sp("troll ogre giant cyclops", "biped", 2, "#7a9a6a #6b4a2b #4a3a2a", "hostile", 60, 2, 3, "OOGH!", "club");
sp("yeti bigfoot sasquatch", "biped", 2, "#f0f0f8 #9ab0d0 #c8c8d8", "neutral", 50, 3, 2.6, "HRRAAGH", "fur");
sp("monkey ape gorilla chimp chimpanzee orangutan", "biped", 1, "#6b4a2b #d8b890 #4a3a2a", "neutral", 12, 4, 1.2, "ooh ooh aah aah!", "", "", "", "banana");
sp("villager person human man woman kid child farmer merchant baker", "biped", 1, "#e8b890 #3b6fd9 #5a3a24", "neutral", 20, 3, 1.8, "hmm?|hello!|nice weather", "");
sp("knight guard soldier", "biped", 1, "#e8b890 #c8ccd4 #8a8f98", "guard", 30, 3, 1.9, "halt!|who goes there?", "iron_ingot");
sp("wizard mage sorcerer witch warlock", "biped", 1, "#e8b890 #6a3ab0 #4a2a80", "neutral", 20, 3, 1.9, "hmm, curious...|abracadabra!", "magic_dust", "hat");
sp("king queen prince princess", "biped", 1, "#e8b890 #b0172f #6a1a2a", "neutral", 20, 3, 1.9, "we are amused.", "gold_ingot", "crown");
sp("vampire", "biped", 1, "#e0e0e8 #22242a #b0172f", "hostile", 25, 4, 1.9, "bleh!|I vant...", "", "");
sp("mummy", "biped", 1, "#e8dcc0 #c8bca0 #2a2a2a", "hostile", 20, 2, 1.9, "mmmhhh", "paper");
sp("alien martian", "biped", 0, "#7ad06a #9aa0aa #2a2a2a", "neutral", 15, 4, 1.2, "zorp?|take me to your leader", "", "antenna");
sp("fairy pixie sprite", "biped", 0, "#f8d0f0 #a0e0ff #f29ae0", "flying", 4, 6, 0.5, "*tinkle*|hey! listen!", "fairy_dust", "wings");
sp("elemental", "biped", 1, "#ff8a3a #ffd23f #8a3a1a", "guard", 40, 3, 2, "*crackle*", "ember");
sp("scarecrow", "biped", 1, "#e8c870 #6a8a3a #6b4a2b", "guard", 10, 0, 1.9, "...", "wheat", "hat");

/** Quad build proportions: body width / length / height, leg height + width, head size. */
const BUILDS: Record<string, { bw: number; bl: number; bh: number; lh: number; lw: number; hs: number }> = {
  stocky: { bw: 6, bl: 9, bh: 5, lh: 3, lw: 2, hs: 4 },
  slim: { bw: 5, bl: 8, bh: 3, lh: 3, lw: 1, hs: 3 },
  tall: { bw: 5, bl: 9, bh: 4, lh: 6, lw: 1, hs: 3 },
  low: { bw: 5, bl: 8, bh: 2, lh: 1, lw: 1, hs: 3 },
};

const SCALES = [0.75, 1, 1.3];

function quadModel(s: Species, maxSize: number, colorsOverride?: string[]): ModelBuilder {
  const f = s.flags;
  const g = BUILDS[f.has("stocky") ? "stocky" : f.has("tall") ? "tall" : f.has("low") ? "low" : "slim"];
  const { bw, bl, bh, lh, lw, hs } = g;
  const wings = f.has("wings");
  const ox = wings ? 4 : 0;
  const W = bw + ox * 2;
  const neck = f.has("neck") ? 3 : 0;
  const tail = f.has("longtail") ? 4 : f.has("bushy") ? 3 : 1;
  const z0 = tail, z1 = z0 + bl - 1;
  const by0 = lh, by1 = lh + bh - 1;
  const hz0 = z1 - 1 + (neck ? 1 : 0), hz1 = hz0 + hs - 1;
  const hy0 = by1 - 1 + neck, hy1 = hy0 + hs - 1;
  const snout = f.has("snout") || f.has("trunk");
  const L = hz1 + 1 + (snout ? 1 : 0) + (f.has("tusks") && !snout ? 1 : 0);
  const extra = f.has("longears") ? 3 : f.has("antlers") ? 3 : f.has("horn") ? 3 : f.has("horns") || f.has("ears") || f.has("mane") ? 2 : 1;
  const H = hy1 + 1 + extra + (wings ? 0 : 0);
  const m = new ModelBuilder([W, H, L], maxSize, SCALES[s.scale] ?? 1);
  const [c0, c1, c2] = colorsOverride ?? s.colors;
  m.colors({ body: c0, accent: c1, detail: c2, eye: EYE, horn: "#e8e0c8" });
  m.main = "body";
  m.accent = "accent";
  const legKey = f.has("wool") || f.has("panda") ? "accent" : "body";
  const headKey = f.has("wool") ? "accent" : "body";
  const hx0 = ox + Math.floor((bw - hs) / 2), hx1 = hx0 + hs - 1;
  const tx0 = ox + Math.floor((bw - 1) / 2), tx1 = ox + Math.ceil((bw - 1) / 2);
  // legs
  m.boxX([ox, 0, z0], [ox + lw - 1, lh - 1, z0 + lw - 1], legKey).boxX([ox, 0, z1 - lw + 1], [ox + lw - 1, lh - 1, z1], legKey);
  m.partX("leg_back_left", "leg_back_right", [ox, 0, z0], [ox + lw - 1, lh - 1, z0 + lw - 1]);
  m.partX("leg_front_left", "leg_front_right", [ox, 0, z1 - lw + 1], [ox + lw - 1, lh - 1, z1]);
  // body (+ shell / wool)
  if (f.has("shell")) m.box([ox, by0, z0], [ox + bw - 1, by1, z1], "body").box([ox, by0 + 1, z0], [ox + bw - 1, by1 + 1, z1], "accent").box([ox + 1, by1 + 2, z0 + 1], [ox + bw - 2, by1 + 2, z1 - 1], "accent");
  else m.box([ox, by0, z0], [ox + bw - 1, by1, z1], "body");
  if (f.has("spots")) m.dotX([ox, by0 + 1, z0 + 2], "accent").dotX([ox, by1, z0 + 5], "accent").dot([ox + 1, by1, z0 + 3], "accent").dot([ox + bw - 2, by1, z0 + 6], "accent").dotX([ox, by0, z1 - 2], "accent");
  if (f.has("stripes")) for (let z = z0 + 1; z <= z1 - 1; z += 2) m.lineX([ox, by0, z], [ox, by1, z], "accent").line([ox, by1, z], [ox + bw - 1, by1, z], "accent");
  if (f.has("spikes")) for (let z = z0; z <= z1; z += 2) m.dotX([tx0, by1 + 1, z], "detail");
  // neck + head
  if (neck) m.box([hx0, by1, hz0], [hx1, hy0, hz0 + 1], "body");
  m.box([hx0, hy0, hz0], [hx1, hy1, hz1], headKey);
  if (f.has("panda")) m.boxX([hx0, hy1 - 2, hz1], [hx0, hy1 - 1, hz1], "accent");
  m.dotX([hx0, hy1 - 1, hz1], f.has("panda") ? "eye" : "eye");
  if (f.has("frog")) m.dotX([hx0, hy1 + 1, hz1 - 1], "accent").dotX([hx0, hy1 + 1, hz1], "eye");
  if (snout) {
    const sx1 = Math.max(hx0 + 1, hx1 - 1);
    m.box([hx0 + 1, hy0, hz1 + 1], [sx1, hy0 + (hs >= 4 ? 1 : 0), hz1 + 1], "detail");
  }
  if (f.has("trunk")) m.box([hx0 + 1, Math.max(1, lh - 1), hz1 + 1], [hx1 - 1, hy0 + 1, hz1 + 1], "body");
  if (f.has("tusks")) m.dotX([hx0, hy0, hz1 + 1], "horn");
  if (f.has("mane")) {
    if (neck) m.box([hx0, hy1 + 1, hz0 - 1], [hx1, hy1 + 1, hz0 + 1], "accent").box([tx0, by1 + 1, hz0 - 2], [tx1, hy1, hz0 - 1], "accent");
    else m.box([hx0 - 1, hy0 - 1, hz0 - 1], [hx1 + 1, hy1 + 1, hz0], "accent").box([hx0, hy0, hz0 + 1], [hx1, hy1, hz1], "body").dotX([hx0, hy1 - 1, hz1], "eye");
  }
  const earKey = f.has("panda") ? "accent" : headKey;
  if (f.has("longears")) m.lineX([hx0, hy1 + 1, hz0 + 1], [hx0, hy1 + 3, hz0 + 1], earKey);
  else if (f.has("ears")) m.dotX([hx0, hy1 + 1, hz0 + 1], earKey);
  if (f.has("horns")) m.lineX([hx0, hy1 + 1, hz0 + 1], [hx0 - 1, hy1 + 2, hz0 + 1], "horn");
  if (f.has("antlers")) m.lineX([hx0, hy1 + 1, hz0 + 1], [hx0 - 1, hy1 + 3, hz0], "horn").dotX([hx0, hy1 + 3, hz0], "horn");
  if (f.has("horn")) m.line([tx0, hy1 + 1, hz1], [tx0, hy1 + 3, hz1], "detail");
  m.part("head", [hx0, hy0, hz0], [hx1, Math.min(H - 1, hy1 + extra), L - 1]);
  // tail
  if (f.has("longtail")) {
    m.box([tx0, by0, 1], [tx1, by0 + 1, z0 - 1], "body").box([tx0, by0, 0], [tx1, by0, 0], "body");
    m.part("tail", [tx0, by0, 0], [tx1, by0 + 1, z0 - 1]);
  } else if (f.has("bushy")) {
    m.box([tx0 - 1, by1 - 1, 0], [tx1 + 1, by1 + 1, z0 - 1], "body").box([tx0, by1, 0], [tx1, by1 + 1, 0], "accent");
    m.part("tail", [tx0 - 1, by1 - 1, 0], [tx1 + 1, by1 + 1, z0 - 1]);
  } else {
    m.box([tx0, by1 - 1, 0], [tx1, by1, 0], f.has("wool") ? "body" : "body");
    m.part("tail", [tx0, by1 - 1, 0], [tx1, by1, 0]);
  }
  // wings (dragons, griffins)
  if (wings) {
    m.boxX([0, by1, z0 + 1], [ox - 1, by1, z1 - 1], "accent").lineX([0, by1 + 1, z0 + 1], [ox - 1, by1 + 1, z1 - 1], "detail");
    m.partX("wing_left", "wing_right", [0, by1, z0 + 1], [ox - 1, by1 + 1, z1 - 1]);
  }
  m.setPivot([(W - 1) / 2, 0, (L - 1) / 2]);
  return m;
}

function birdModel(s: Species, maxSize: number, colorsOverride?: string[]): ModelBuilder {
  const f = s.flags;
  const legH = f.has("longlegs") ? 5 : 2;
  const y0 = legH + 1;
  const upright = f.has("upright");
  const neck = f.has("neck") ? 3 : 0;
  const bodyTop = y0 + (upright ? 5 : 3);
  const hy0 = (upright ? bodyTop - 1 : y0 + 3) + neck;
  const hz0 = upright ? 5 : 7;
  const flat = f.has("flatbeak");
  const L = hz0 + 3 + (flat ? 2 : 1);
  const H = hy0 + 3 + (f.has("tallcomb") ? 2 : f.has("comb") ? 1 : 0) + (f.has("fan") ? 2 : 0);
  const m = new ModelBuilder([8, Math.max(H, f.has("fan") ? y0 + 8 : 0), L], maxSize, SCALES[s.scale] ?? 1);
  const [c0, c1, c2] = colorsOverride ?? s.colors;
  m.colors({ body: c0, wing: shadeColor(c0, -0.12), comb: c1, beak: c2, leg: c2, eye: EYE });
  if (upright) m.color("belly", c1);
  m.main = "body";
  m.accent = "comb";
  // legs + feet
  m.lineX([2, 0, 4], [2, legH, 4], "leg").dotX([2, 0, 5], "leg");
  m.partX("leg_left", "leg_right", [2, 0, 4], [2, legH, 5]);
  // body
  if (upright) m.box([1, y0, 2], [6, bodyTop, 5], "body").box([2, y0, 6], [5, bodyTop - 1, 6], "belly");
  else m.box([1, y0, 2], [6, y0 + 3, 7], "body").box([2, y0 - 1, 3], [5, y0 + 4, 6], "body");
  // wings
  m.boxX([0, y0 + 1, 3], [0, y0 + 3, upright ? 5 : 6], "wing");
  m.partX("wing_left", "wing_right", [0, y0 + 1, 3], [0, y0 + 3, upright ? 5 : 6]);
  // tail (turkey / phoenix fan)
  if (f.has("fan")) {
    m.box([1, y0 + 2, 0], [6, y0 + 7, 0], "comb").box([2, y0 + 3, 0], [5, y0 + 6, 0], "beak").box([1, y0 + 2, 1], [6, y0 + 3, 1], "body");
    m.part("tail", [1, y0 + 2, 0], [6, y0 + 7, 1]);
  } else {
    m.box([2, y0 + 2, 0], [5, y0 + 4, 1], "body");
    if (f.has("comb")) m.box([3, y0 + 5, 0], [4, y0 + 5, 0], "wing");
    m.part("tail", [2, y0 + 2, 0], [5, y0 + 5, 1]);
  }
  // neck + head
  if (neck) m.box([3, y0 + 3, hz0 - 1], [4, hy0, hz0], "body");
  m.box([2, hy0, hz0], [5, hy0 + 2, hz0 + 2], "body");
  m.dotX([2, hy0 + 1, hz0 + 2], "eye");
  if (flat) m.box([2, hy0, hz0 + 3], [5, hy0, hz0 + 4], "beak");
  else m.box([3, hy0 + 1, hz0 + 3], [4, hy0 + 1, hz0 + 3], "beak");
  if (f.has("wattle")) m.box([3, hy0, hz0 + 3], [4, hy0, hz0 + 3], "comb");
  if (f.has("comb")) m.box([3, hy0 + 3, hz0 + 1], [4, hy0 + 3, hz0 + 2], "comb");
  if (f.has("tallcomb")) m.box([3, hy0 + 4, hz0 + 1], [4, hy0 + 4, hz0 + 1], "comb");
  m.part("head", [2, hy0, hz0], [5, hy0 + 3, L - 1]);
  m.setPivot([3.5, 0, (L - 1) / 2]);
  return m;
}

function fishModel(s: Species, maxSize: number, colorsOverride?: string[]): ModelBuilder {
  const f = s.flags;
  const fin = f.has("fin");
  const m = new ModelBuilder([4, fin ? 8 : 6, 12], maxSize, (SCALES[s.scale] ?? 1) * (s.scale === 2 ? 1.25 : 1));
  const [c0, c1] = colorsOverride ?? s.colors;
  m.colors({ body: c0, belly: c1, fin: shadeColor(c0, -0.2), eye: EYE });
  m.main = "body";
  m.accent = "belly";
  m.box([0, 1, 3], [3, 4, 9], "body").box([1, 0, 4], [2, 5, 8], "body").box([0, 1, 4], [3, 1, 8], "belly");
  if (f.has("stripes")) m.box([0, 1, 5], [3, 4, 5], "belly").box([0, 1, 8], [3, 4, 8], "belly");
  m.box([0, 1, 10], [3, 4, 10], "body").box([1, 2, 11], [2, 3, 11], "body");
  m.dotX([0, 3, 10], "eye");
  m.box([1, 1, 1], [2, 4, 2], "fin").box([1, 0, 0], [2, 1, 0], "fin").box([1, 4, 0], [2, 5, 0], "fin");
  m.dotX([0, 1, 7], "fin");
  if (fin) m.box([1, 6, 5], [2, 7, 6], "fin").box([1, 6, 4], [2, 6, 4], "fin");
  m.part("tail", [1, 0, 0], [2, 5, 2]).part("head", [0, 1, 10], [3, 4, 11]);
  m.setPivot([1.5, 2, 6]);
  return m;
}

function bugModel(s: Species, maxSize: number, colorsOverride?: string[]): ModelBuilder {
  const f = s.flags;
  const big = f.has("bigwings");
  const m = new ModelBuilder([10, big ? 9 : f.has("wings") || f.has("stinger") ? 7 : 5, 10], maxSize, SCALES[s.scale] ?? 1);
  const [c0, c1, c2] = colorsOverride ?? s.colors;
  m.colors({ body: c0, accent: c1, wing: c2, leg: shadeColor(c0, -0.25), eye: EYE });
  m.main = "body";
  m.accent = "accent";
  if (big) {
    m.box([4, 1, 2], [5, 2, 8], "body").dotX([4, 3, 8], "leg");
    m.boxX([2, 3, 2], [3, 8, 7], "accent").dotX([2, 6, 4], "wing").dotX([2, 4, 6], "wing");
    if (f.has("glowtail")) m.box([4, 1, 1], [5, 2, 3], "wing");
    m.partX("wing_left", "wing_right", [2, 3, 2], [3, 8, 7]);
    m.setPivot([4.5, 1, 5]);
    return m;
  }
  m.box([3, 1, 0], [6, 3, 4], "body").box([3, 1, 5], [6, 2, 6], "body").box([3, 1, 7], [6, 3, 8], "body");
  if (f.has("stripes")) m.box([3, 1, 1], [6, 3, 1], "accent").box([3, 1, 3], [6, 3, 3], "accent");
  if (f.has("spots")) m.dotX([3, 3, 1], "accent").dotX([4, 3, 3], "accent");
  const zs = f.has("eight") ? [1, 3, 5, 7] : [2, 4, 6];
  for (const z of zs) m.lineX([2, 2, z], [0, 0, z], "leg");
  m.partX("legs_left", "legs_right", [0, 0, zs[0]], [2, 2, zs[zs.length - 1]]);
  if (f.has("eight")) m.dotX([4, 3, 8], "accent").dotX([3, 3, 8], "accent");
  else m.dotX([3, 3, 8], "eye");
  if (f.has("claws")) m.boxX([1, 1, 8], [2, 2, 9], "accent");
  if (f.has("stinger")) m.box([4, 4, 0], [5, 6, 0], "accent").box([4, 6, 1], [5, 6, 1], "accent");
  if (f.has("wings")) {
    m.boxX([1, 4, 3], [3, 4, 6], "wing");
    m.partX("wing_left", "wing_right", [1, 4, 3], [3, 4, 6]);
  }
  m.part("head", [3, 1, 7], [6, 3, 9]);
  m.setPivot([4.5, 0, 4.5]);
  return m;
}

function serpentModel(s: Species, maxSize: number, colorsOverride?: string[]): ModelBuilder {
  const f = s.flags;
  const m = new ModelBuilder([5, f.has("shell") ? 6 : 4, 15], maxSize, SCALES[s.scale] ?? 1);
  const [c0, c1, c2] = colorsOverride ?? s.colors;
  m.colors({ body: c0, accent: c1, tongue: c2, eye: EYE });
  m.main = "body";
  m.accent = "accent";
  m.box([1, 0, 0], [2, 1, 3], "body").box([0, 0, 3], [1, 1, 6], "body").box([1, 0, 6], [2, 1, 9], "body").box([2, 0, 9], [3, 1, 11], "body");
  m.dot([1, 1, 2], "accent").dot([0, 1, 5], "accent").dot([2, 1, 8], "accent");
  if (f.has("shell")) m.box([1, 2, 3], [3, 5, 7], "accent").box([2, 3, 4], [2, 4, 6], "body");
  if (f.has("nohead")) {
    m.box([1, 0, 11], [3, 1, 13], "body").dotX([1, 1, 13], "eye");
  } else {
    m.box([1, 0, 11], [3, 2, 13], "body").dotX([1, 2, 13], "eye").dot([2, 0, 14], "tongue");
  }
  m.part("head", [1, 0, 11], [3, 2, 14]).part("tail", [1, 0, 0], [2, 1, 3]);
  m.setPivot([2, 0, 7]);
  return m;
}

function blobModel(s: Species, maxSize: number, colorsOverride?: string[]): ModelBuilder {
  const f = s.flags;
  const [c0, c1, c2] = colorsOverride ?? s.colors;
  if (f.has("snowman")) {
    const m = new ModelBuilder([8, 16, 8], maxSize, SCALES[s.scale] ?? 1);
    m.colors({ body: c0, nose: c1, coal: c2, hat: "#26262c" });
    m.main = "body";
    m.accent = "nose";
    m.box([0, 0, 0], [7, 4, 7], "body").box([1, 5, 1], [6, 8, 6], "body").box([2, 9, 2], [5, 12, 5], "body");
    m.dotX([3, 11, 5], "coal").box([3, 10, 6], [4, 10, 7], "nose").dot([3, 7, 6], "coal").dot([3, 6, 6], "coal");
    m.box([1, 13, 1], [6, 13, 6], "hat").box([2, 14, 2], [5, 15, 5], "hat");
    m.part("head", [2, 9, 2], [5, 15, 7]);
    m.setPivot([3.5, 0, 3.5]);
    return m;
  }
  if (f.has("ghost")) {
    const m = new ModelBuilder([8, 12, 8], maxSize, SCALES[s.scale] ?? 1);
    m.colors({ body: c0, eye: c1, accent: c2 });
    m.main = "body";
    m.accent = "accent";
    m.box([1, 2, 1], [6, 9, 6], "body").box([2, 10, 2], [5, 10, 5], "body");
    m.dotX([1, 1, 1], "body").dotX([1, 1, 4], "body").dotX([2, 0, 2], "body").dot([3, 1, 5], "body");
    m.boxX([2, 7, 6], [2, 8, 6], "eye").box([3, 4, 6], [4, 5, 6], "eye");
    m.boxX([0, 5, 3], [0, 6, 4], "body");
    m.partX("arm_left", "arm_right", [0, 5, 3], [0, 6, 4]);
    m.setPivot([3.5, 0, 3.5]);
    return m;
  }
  if (f.has("tentacles")) {
    const m = new ModelBuilder([8, 11, 8], maxSize, SCALES[s.scale] ?? 1);
    m.colors({ body: c0, accent: c1, eye: EYE });
    m.main = "body";
    m.accent = "accent";
    m.box([1, 5, 1], [6, 9, 6], "body").box([2, 10, 2], [5, 10, 5], "body");
    m.lineX([1, 4, 1], [0, 0, 0], "body").lineX([1, 4, 6], [0, 0, 7], "body").lineX([2, 4, 3], [1, 0, 3], "accent").lineX([2, 4, 4], [2, 0, 5], "accent");
    m.dotX([2, 7, 6], "eye");
    m.part("head", [1, 5, 1], [6, 10, 6]).part("tentacles", [0, 0, 0], [7, 4, 7]);
    m.setPivot([3.5, 0, 3.5]);
    return m;
  }
  const m = new ModelBuilder([8, 8, 8], maxSize, SCALES[s.scale] ?? 1);
  m.colors({ body: c0, core: c1, eye: c2 });
  m.main = "body";
  m.accent = "core";
  m.box([0, 0, 0], [7, 7, 7], "body").box([2, 2, 2], [5, 5, 5], "core");
  m.boxX([1, 4, 7], [2, 5, 7], "eye").box([3, 2, 7], [4, 2, 7], "eye");
  m.setPivot([3.5, 0, 3.5]);
  return m;
}

function bipedModel(s: Species, maxSize: number, colorsOverride?: string[]): ModelBuilder {
  const f = s.flags;
  const wings = f.has("wings");
  const ox = wings ? 3 : 0;
  const W = 8 + ox * 2;
  const top = f.has("hat") ? 19 : f.has("antenna") || f.has("crown") ? 17 : 16;
  const m = new ModelBuilder([W, top, 4], maxSize, SCALES[s.scale] ?? 1);
  const [c0, c1, c2] = colorsOverride ?? s.colors;
  m.colors({ skin: c0, shirt: c1, legs: c2, hair: shadeColor(c2, -0.35), eye: EYE, accent: GOLD });
  m.main = "shirt";
  m.accent = "legs";
  if (f.has("thin")) {
    m.boxX([ox + 2, 0, 1], [ox + 2, 5, 2], "skin").box([ox + 2, 6, 1], [ox + 5, 11, 2], "shirt").line([ox + 3, 6, 2], [ox + 3, 11, 2], "skin");
    m.boxX([ox + 0, 6, 1], [ox + 0, 11, 1], "skin");
  } else if (f.has("bulky")) {
    m.boxX([ox + 1, 0, 0], [ox + 3, 4, 3], "legs").box([ox + 1, 5, 0], [ox + 6, 12, 3], "shirt");
    m.boxX([ox + 0, 2, 0], [ox + 0, 11, 3], "skin");
  } else {
    m.boxX([ox + 1, 0, 0], [ox + 3, 5, 3], "legs").box([ox + 1, 6, 0], [ox + 6, 11, 3], "shirt");
    m.boxX([ox + 0, 6, 1], [ox + 0, 11, 2], "skin");
  }
  m.partX("leg_left", "leg_right", [ox + 1, 0, 0], [ox + 3, 5, 3]);
  m.partX("arm_left", "arm_right", [ox + 0, 6, 0], [ox + 0, 11, 3]);
  m.box([ox + 2, 12, 0], [ox + 5, 15, 3], "skin").box([ox + 2, 15, 0], [ox + 5, 15, 3], f.has("thin") ? "skin" : "hair").box([ox + 2, 13, 0], [ox + 5, 15, 0], f.has("thin") ? "skin" : "hair");
  m.dotX([ox + 3, 14, 3], "eye");
  if (f.has("thin")) m.box([ox + 3, 13, 3], [ox + 4, 13, 3], "eye");
  m.part("head", [ox + 2, 12, 0], [ox + 5, top - 1, 3]);
  if (f.has("antenna")) m.lineX([ox + 2, 16, 1], [ox + 2, 16, 1], "accent");
  if (f.has("crown")) m.box([ox + 2, 16, 0], [ox + 5, 16, 3], "accent").dotX([ox + 2, 16, 3], "shirt");
  if (f.has("hat")) m.box([ox + 1, 16, -1], [ox + 6, 16, 4], "shirt").box([ox + 2, 17, 0], [ox + 5, 17, 3], "shirt").box([ox + 3, 18, 1], [ox + 4, 18, 2], "shirt");
  if (wings) {
    m.boxX([0, 8, 0], [ox, 13, 0], "accent");
    m.color("accent", shadeColor(c1, 0.4));
    m.partX("wing_left", "wing_right", [0, 8, 0], [ox, 13, 0]);
  }
  m.setPivot([(W - 1) / 2, 0, 1.5]);
  return m;
}

function creatureModel(s: Species, maxSize: number, colorsOverride?: string[]): ModelBuilder {
  switch (s.plan) {
    case "bird": return birdModel(s, maxSize, colorsOverride);
    case "fish": return fishModel(s, maxSize, colorsOverride);
    case "bug": return bugModel(s, maxSize, colorsOverride);
    case "serpent": return serpentModel(s, maxSize, colorsOverride);
    case "blob": return blobModel(s, maxSize, colorsOverride);
    case "biped": return bipedModel(s, maxSize, colorsOverride);
    case "dragon":
    case "quad": return quadModel(s, maxSize, colorsOverride);
  }
}

// ================================================================ item templates

type TemplateFn = (m: ModelBuilder) => void;
interface Template { cat: ThingCategory; size: VoxelVec; build: TemplateFn; words: string }
const TEMPLATES: Record<string, Template> = {};
/** non-creature word (or bigram) -> template kind. */
const KIND_WORDS: Record<string, string> = {};
function tpl(kind: string, cat: ThingCategory, words: string, size: VoxelVec, build: TemplateFn): void {
  TEMPLATES[kind] = { cat, size, build, words };
  for (const w of words.split(",").map((x) => x.trim()).filter(Boolean)) KIND_WORDS[w] = kind;
}
const held = (m: ModelBuilder, main: string, accent: string, colors: Record<string, string>) => {
  m.colors(colors);
  m.main = main;
  m.accent = accent;
};

// ---- weapons (grip at the bottom, pointing up +Y)
tpl("sword", "weapon", "sword,blade,katana,sabre,saber,rapier,longsword,broadsword,greatsword,cutlass,scimitar,claymore,excalibur", [5, 16, 1], (m) => {
  held(m, "blade", "guard", { blade: IRON, edge: "#f4f6f8", guard: GOLD, grip: DARK_WOOD, gem: "#d93b2b" });
  m.dot([2, 0, 0], "guard").line([2, 1, 0], [2, 3, 0], "grip").box([0, 4, 0], [4, 4, 0], "guard").dot([2, 4, 0], "gem");
  m.box([1, 5, 0], [3, 13, 0], "blade").line([2, 6, 0], [2, 13, 0], "edge").dot([2, 14, 0], "blade").dot([2, 15, 0], "edge");
  m.setPivot([2, 2, 0]);
});
tpl("dagger", "weapon", "dagger,knife,dirk,stiletto,shiv,kunai", [3, 10, 1], (m) => {
  held(m, "blade", "guard", { blade: IRON, guard: GOLD, grip: DARK_WOOD, edge: "#f4f6f8" });
  m.dot([1, 0, 0], "guard").line([1, 1, 0], [1, 2, 0], "grip").box([0, 3, 0], [2, 3, 0], "guard").box([0, 4, 0], [2, 6, 0], "blade").line([1, 7, 0], [1, 8, 0], "blade").dot([1, 9, 0], "edge");
  m.setPivot([1, 1, 0]);
});
tpl("spear", "weapon", "spear,lance,javelin,pike,halberd,glaive,polearm,harpoon", [3, 16, 1], (m) => {
  held(m, "blade", "ribbon", { shaft: WOOD, blade: IRON, ribbon: "#d93b2b" });
  m.line([1, 0, 0], [1, 12, 0], "shaft").dot([1, 11, 0], "ribbon").box([0, 13, 0], [2, 13, 0], "blade").line([1, 14, 0], [1, 15, 0], "blade");
  m.setPivot([1, 4, 0]);
});
tpl("trident", "weapon", "trident,pitchfork", [5, 16, 1], (m) => {
  held(m, "blade", "shaft", { shaft: "#2a7a8a", blade: GOLD });
  m.line([2, 0, 0], [2, 11, 0], "shaft").box([0, 11, 0], [4, 11, 0], "blade").line([0, 12, 0], [0, 14, 0], "blade").line([2, 12, 0], [2, 15, 0], "blade").line([4, 12, 0], [4, 14, 0], "blade");
  m.setPivot([2, 3, 0]);
});
tpl("mace", "weapon", "mace,morningstar,flail,maul", [5, 16, 5], (m) => {
  held(m, "head", "spike", { shaft: DARK_WOOD, head: "#8a8f98", spike: IRON });
  m.line([2, 0, 2], [2, 10, 2], "shaft").box([1, 11, 1], [3, 14, 3], "head");
  m.dot([0, 12, 2], "spike").dot([4, 12, 2], "spike").dot([2, 12, 0], "spike").dot([2, 12, 4], "spike").dot([2, 15, 2], "spike").dot([0, 14, 2], "spike").dot([4, 14, 2], "spike");
  m.setPivot([2, 2, 2]);
});
tpl("club", "weapon", "club,cudgel,baseball bat,cricket bat,bludgeon", [3, 14, 3], (m) => {
  held(m, "head", "grip", { head: WOOD, grip: DARK_WOOD });
  m.line([1, 0, 1], [1, 4, 1], "grip").box([0, 5, 0], [2, 12, 2], "head").dot([1, 13, 1], "head");
  m.setPivot([1, 1, 1]);
});
tpl("warhammer", "weapon", "warhammer,war hammer,battle hammer,mallet", [7, 16, 3], (m) => {
  held(m, "head", "shaft", { shaft: DARK_WOOD, head: "#8a8f98", face: IRON });
  m.line([3, 0, 1], [3, 12, 1], "shaft").box([0, 12, 0], [6, 15, 2], "head").box([0, 13, 0], [0, 14, 2], "face").box([6, 13, 0], [6, 14, 2], "face");
  m.setPivot([3, 2, 1]);
});
tpl("battleaxe", "weapon", "battleaxe,battle axe,war axe,waraxe,greataxe,double axe,labrys", [7, 16, 1], (m) => {
  held(m, "blade", "shaft", { shaft: DARK_WOOD, blade: IRON, edge: "#f4f6f8" });
  m.line([3, 0, 0], [3, 15, 0], "shaft").boxX([4, 10, 0], [5, 14, 0], "blade").lineX([6, 11, 0], [6, 13, 0], "edge");
  m.setPivot([3, 2, 0]);
});
tpl("scythe", "weapon", "scythe,sickle,reaper", [6, 16, 1], (m) => {
  held(m, "blade", "shaft", { shaft: DARK_WOOD, blade: "#b8c0c8" });
  m.line([1, 0, 0], [1, 15, 0], "shaft").line([1, 15, 0], [5, 14, 0], "blade").line([2, 14, 0], [5, 13, 0], "blade").line([5, 13, 0], [5, 11, 0], "blade");
  m.setPivot([1, 3, 0]);
});
tpl("bow", "weapon", "bow,longbow,shortbow,crossbow", [4, 16, 1], (m) => {
  held(m, "wood", "string", { wood: WOOD, string: "#f0ece0", grip: DARK_WOOD });
  m.line([0, 0, 0], [0, 15, 0], "string");
  m.line([0, 0, 0], [2, 3, 0], "wood").line([2, 3, 0], [3, 6, 0], "wood").line([3, 9, 0], [2, 12, 0], "wood").line([2, 12, 0], [0, 15, 0], "wood").line([3, 6, 0], [3, 9, 0], "grip");
  m.setPivot([3, 7.5, 0]);
});
tpl("staff", "weapon", "staff,stave,rod of power,scepter,sceptre,quarterstaff", [5, 16, 5], (m) => {
  held(m, "gem", "shaft", { shaft: WOOD, gem: "#9a5ad8", prong: GOLD });
  m.line([2, 0, 2], [2, 12, 2], "shaft").lineX([1, 11, 2], [0, 13, 2], "prong").line([2, 11, 1], [2, 13, 0], "prong").line([2, 11, 3], [2, 13, 4], "prong").box([1, 13, 1], [3, 15, 3], "gem");
  m.setPivot([2, 4, 2]);
});
tpl("wand", "weapon", "wand,magic wand,gun,blaster,pistol,rifle,raygun,ray gun", [3, 10, 3], (m) => {
  held(m, "shaft", "gem", { shaft: DARK_WOOD, gem: "#7ad6ff", glow: GLOW });
  m.line([1, 0, 1], [1, 7, 1], "shaft").box([0, 7, 1], [2, 7, 1], "gem").dot([1, 8, 1], "gem").dot([1, 9, 1], "glow");
  m.setPivot([1, 1, 1]);
});
tpl("shield", "weapon", "shield,buckler", [9, 11, 2], (m) => {
  held(m, "face", "emblem", { face: "#3b6fd9", rim: IRON, emblem: GOLD, grip: DARK_WOOD });
  m.box([1, 0, 0], [7, 10, 0], "face").box([0, 1, 0], [8, 9, 0], "face").lineX([0, 1, 0], [0, 9, 0], "rim").line([1, 10, 0], [7, 10, 0], "rim").line([1, 0, 0], [7, 0, 0], "rim");
  m.box([3, 4, 0], [5, 6, 0], "emblem").box([3, 4, 1], [5, 5, 1], "grip");
  m.setPivot([4, 5, 1]);
});
tpl("whip", "weapon", "whip,lasso,chain", [7, 16, 1], (m) => {
  held(m, "cord", "grip", { grip: DARK_WOOD, cord: "#8a5a35" });
  m.line([0, 0, 0], [0, 4, 0], "grip").line([0, 5, 0], [3, 10, 0], "cord").line([3, 10, 0], [6, 15, 0], "cord");
  m.setPivot([0, 1, 0]);
});

// ---- tools
tpl("pickaxe", "tool", "pickaxe,pick,pick axe,mattock,drill", [9, 14, 1], (m) => {
  held(m, "head", "shaft", { shaft: WOOD, head: IRON });
  m.line([4, 0, 0], [4, 12, 0], "shaft").box([1, 12, 0], [7, 13, 0], "head").line([0, 11, 0], [0, 12, 0], "head").line([8, 11, 0], [8, 12, 0], "head");
  m.setPivot([4, 2, 0]);
});
tpl("axe", "tool", "axe,hatchet,tomahawk,woodaxe", [6, 16, 1], (m) => {
  held(m, "blade", "shaft", { shaft: WOOD, blade: IRON, edge: "#f4f6f8" });
  m.line([1, 0, 0], [1, 15, 0], "shaft").box([2, 10, 0], [4, 14, 0], "blade").line([5, 11, 0], [5, 13, 0], "edge").dot([0, 12, 0], "blade");
  m.setPivot([1, 2, 0]);
});
tpl("shovel", "tool", "shovel,spade,trowel", [3, 16, 1], (m) => {
  held(m, "head", "shaft", { shaft: WOOD, head: IRON, grip: DARK_WOOD });
  m.box([0, 0, 0], [2, 0, 0], "grip").line([1, 1, 0], [1, 10, 0], "shaft").box([0, 11, 0], [2, 14, 0], "head").dot([1, 15, 0], "head");
  m.setPivot([1, 1, 0]);
});
tpl("hoe", "tool", "hoe,rake", [4, 15, 1], (m) => {
  held(m, "head", "shaft", { shaft: WOOD, head: IRON });
  m.line([1, 0, 0], [1, 13, 0], "shaft").box([1, 14, 0], [3, 14, 0], "head").line([3, 12, 0], [3, 13, 0], "head");
  m.setPivot([1, 2, 0]);
});
tpl("hammer", "tool", "hammer,wrench,spanner,tool,screwdriver,saw,chisel,toolkit", [5, 13, 3], (m) => {
  held(m, "head", "shaft", { shaft: WOOD, head: "#8a8f98" });
  m.line([2, 0, 1], [2, 9, 1], "shaft").box([0, 10, 0], [4, 12, 2], "head");
  m.setPivot([2, 2, 1]);
});
tpl("rod", "tool", "fishing rod,rod,fishing pole,net", [7, 16, 1], (m) => {
  held(m, "shaft", "bobber", { shaft: WOOD, string: "#f0ece0", bobber: "#d93b2b", reel: IRON });
  m.line([0, 0, 0], [5, 15, 0], "shaft").dot([1, 3, 0], "reel").line([6, 15, 0], [6, 9, 0], "string").dot([6, 8, 0], "bobber");
  m.setPivot([0, 1, 0]);
});
tpl("torch", "tool", "torch,flashlight,glowstick", [3, 10, 3], (m) => {
  held(m, "flame", "shaft", { shaft: WOOD, flame: FLAME, glow: GLOW });
  m.line([1, 0, 1], [1, 6, 1], "shaft").box([0, 7, 0], [2, 8, 2], "flame").dot([1, 9, 1], "glow").dot([1, 8, 1], "glow");
  m.setPivot([1, 1, 1]);
});
tpl("key", "tool", "key,lockpick,compass,bucket,shears,scissors,lighter", [5, 10, 1], (m) => {
  held(m, "main", "main", { main: GOLD });
  m.box([0, 6, 0], [4, 9, 0], "main").air([1, 7, 0], [3, 8, 0]).line([2, 0, 0], [2, 5, 0], "main").box([3, 0, 0], [4, 0, 0], "main").dot([3, 2, 0], "main");
  m.setPivot([2, 7, 0]);
});

// ---- food
tpl("fruit", "food", "apple,orange,peach,tomato,plum,lemon,lime fruit,berry,blueberry,strawberry,cherry,grape,pear,coconut,onion,fruit,potato,turnip,beet,beetroot,radish,nut,acorn,meatball,dumpling,candy,sweet,bonbon,truffle,food,snack,treat,meal", [7, 8, 7], (m) => {
  held(m, "main", "leaf", { main: "#d93b2b", stem: DARK_WOOD, leaf: LEAF, shine: "#ffffff" });
  m.sphere([3, 3, 3], 3, "main").dot([2, 5, 1], "shine").line([3, 6, 3], [3, 7, 3], "stem").dot([4, 7, 3], "leaf");
  m.setPivot([3, 0, 3]);
});
tpl("melon", "food", "melon,watermelon,pumpkin,squash,gourd,cabbage,lettuce", [9, 8, 9], (m) => {
  held(m, "main", "rib", { main: "#6ab04a", rib: "#3a7a2a", stem: DARK_WOOD });
  m.box([0, 0, 1], [8, 6, 7], "main").box([1, 0, 0], [7, 6, 8], "main").box([1, 7, 1], [7, 7, 7], "main");
  m.line([2, 0, 0], [2, 6, 0], "rib").line([6, 0, 0], [6, 6, 0], "rib").line([2, 0, 8], [2, 6, 8], "rib").line([6, 0, 8], [6, 6, 8], "rib").line([0, 0, 4], [0, 6, 4], "rib").line([8, 0, 4], [8, 6, 4], "rib");
  m.dot([4, 7, 4], "stem").dot([4, 8, 4], "stem");
  m.setPivot([4, 0, 4]);
});
tpl("loaf", "food", "bread,loaf,baguette,bun,roll,croissant,biscuit,toast,cornbread,brownie,muffin,cupcake", [6, 5, 10], (m) => {
  held(m, "main", "crust", { main: "#e0b060", crust: "#a8682a" });
  m.box([0, 0, 0], [5, 2, 9], "main").box([1, 3, 0], [4, 3, 9], "crust").box([1, 4, 1], [4, 4, 8], "crust").line([1, 4, 3], [4, 4, 3], "main").line([1, 4, 6], [4, 4, 6], "main");
  m.setPivot([2.5, 0, 4.5]);
});
tpl("cake", "food", "cake,cheesecake,birthday cake,gateau", [9, 6, 9], (m) => {
  held(m, "main", "icing", { main: "#f3e5c0", icing: "#f29ab8", cherry: "#d93b2b" });
  m.cyl([4, 0, 4], 4, 3, "main").cyl([4, 3, 4], 4, 1, "icing").dot([4, 4, 4], "cherry").dot([2, 4, 2], "cherry").dot([6, 4, 6], "cherry").dot([2, 2, 0], "icing").dot([6, 2, 8], "icing");
  m.setPivot([4, 0, 4]);
});
tpl("pie", "food", "pie,pizza,tart,quiche,pancake,waffle,cookie,cracker,flatbread,tortilla,omelette,omelet,crepe", [9, 2, 9], (m) => {
  held(m, "main", "topping", { crust: "#d8a050", main: "#b0172f", topping: "#f3e5c0" });
  m.cyl([4, 0, 4], 4, 1, "crust").cyl([4, 1, 4], 3, 1, "main").dot([2, 1, 4], "topping").dot([6, 1, 3], "topping").dot([4, 1, 6], "topping").dot([4, 1, 2], "topping");
  m.setPivot([4, 0, 4]);
});
tpl("donut", "food", "donut,doughnut,bagel,ring cake", [9, 2, 9], (m) => {
  held(m, "icing", "sprinkle", { main: "#d8a050", icing: "#f29ab8", sprinkle: "#3ad6e0" });
  m.cyl([4, 0, 4], 4, 1, "main").cyl([4, 1, 4], 4, 1, "icing").air([3, 0, 3], [5, 1, 5]).dot([1, 1, 4], "sprinkle").dot([6, 1, 2], "sprinkle").dot([4, 1, 7], "sprinkle");
  m.setPivot([4, 0, 4]);
});
tpl("drumstick", "food", "drumstick,meat,leg,chicken leg,chicken wing,chicken wings,wing,kebab,skewer,roast,turkey leg", [5, 9, 5], (m) => {
  held(m, "main", "bone", { main: "#b8642a", bone: "#f4ecd8" });
  m.line([2, 0, 2], [2, 3, 2], "bone").dot([1, 0, 2], "bone").dot([3, 0, 2], "bone");
  m.box([1, 4, 1], [3, 8, 3], "main").box([0, 5, 1], [4, 7, 3], "main").box([1, 5, 0], [3, 7, 4], "main");
  m.setPivot([2, 1, 2]);
});
tpl("steak", "food", "steak,ham,bacon,porkchop,pork chop,chop,fillet,filet,jerky,cutlet,schnitzel", [8, 2, 6], (m) => {
  held(m, "main", "fat", { main: "#b0402a", fat: "#f3e5c0" });
  m.box([0, 0, 0], [7, 1, 5], "main").box([0, 0, 0], [0, 1, 5], "fat").line([2, 1, 2], [6, 1, 3], "fat");
  m.setPivot([3.5, 0, 2.5]);
});
tpl("egg", "food", "egg,easter egg", [5, 6, 5], (m) => {
  held(m, "main", "speckle", { main: "#f4ecd8", speckle: "#c8b898" });
  m.box([1, 0, 1], [3, 5, 3], "main").box([0, 1, 1], [4, 4, 3], "main").box([1, 1, 0], [3, 4, 4], "main").dot([0, 3, 2], "speckle").dot([3, 2, 4], "speckle").dot([2, 4, 0], "speckle");
  m.setPivot([2, 0, 2]);
});
tpl("bowl", "food", "soup,stew,salad,ramen,noodles,cereal,porridge,curry,chili,bowl,broth,risotto,rice,pasta,spaghetti", [7, 3, 7], (m) => {
  held(m, "main", "garnish", { bowl: "#8a5a35", main: "#d8902a", garnish: LEAF });
  m.cyl([3, 0, 3], 2, 1, "bowl").cyl([3, 1, 3], 3, 2, "bowl", true).cyl([3, 2, 3], 2, 1, "main").dot([3, 2, 4], "garnish").dot([2, 2, 2], "garnish");
  m.setPivot([3, 0, 3]);
});
tpl("bottle", "food", "potion,elixir,tonic,juice,milk,drink,soda,wine,flask,bottle,brew,smoothie,lemonade,water,nectar,vial,beer,ale,mead,cider", [5, 9, 5], (m) => {
  held(m, "main", "glass", { main: "#d63bd0", glass: "#c8e8f8", cork: "#a8743e", shine: "#ffffff" });
  m.cyl([2, 0, 2], 2, 5, "main").dot([1, 3, 0], "shine").box([1, 5, 1], [3, 5, 3], "glass").line([2, 6, 2], [2, 7, 2], "glass").dot([2, 8, 2], "cork");
  m.setPivot([2, 0, 2]);
});
tpl("mug", "food", "mug,cup,coffee,tea,cocoa,hot chocolate,latte,espresso,teacup", [6, 6, 5], (m) => {
  held(m, "cup", "main", { cup: "#f4f4f0", main: "#6b4a2b" });
  m.cyl([2, 0, 2], 2, 5, "cup", true).cyl([2, 0, 2], 1, 1, "cup").cyl([2, 4, 2], 1, 1, "main").line([5, 1, 2], [5, 3, 2], "cup").dot([4, 1, 2], "cup").dot([4, 3, 2], "cup");
  m.setPivot([2, 0, 2]);
});
tpl("carrot", "food", "carrot,corn,banana,cucumber,sausage,hotdog,hot dog,parsnip,leek,zucchini,eggplant,aubergine,pickle,churro,burrito,popsicle", [5, 10, 5], (m) => {
  held(m, "main", "leaf", { main: "#f08a24", leaf: LEAF });
  m.line([2, 0, 2], [2, 2, 2], "main").box([1, 3, 1], [3, 7, 3], "main").line([2, 8, 2], [2, 9, 2], "leaf").dot([1, 9, 2], "leaf").dot([3, 9, 2], "leaf").dot([2, 9, 1], "leaf");
  m.setPivot([2, 0, 2]);
});
tpl("cheese", "food", "cheese,cheese wedge,butter,tofu,fudge", [8, 4, 8], (m) => {
  held(m, "main", "hole", { main: "#f2d03a", hole: "#c8a020" });
  m.box([0, 0, 0], [7, 3, 1], "main").box([0, 0, 2], [5, 3, 3], "main").box([0, 0, 4], [3, 3, 5], "main").box([0, 0, 6], [1, 3, 7], "main");
  m.dot([2, 3, 1], "hole").dot([5, 2, 0], "hole").dot([1, 1, 4], "hole").dot([0, 2, 2], "hole");
  m.setPivot([2, 0, 2]);
});
tpl("mushroom", "food", "mushroom,toadstool,fungus,shroom,truffle mushroom", [7, 6, 7], (m) => {
  held(m, "main", "spot", { stem: "#f3e5c0", main: "#d93b2b", spot: "#f4f4f0" });
  m.cyl([3, 0, 3], 1, 3, "stem").cyl([3, 3, 3], 3, 2, "main").cyl([3, 5, 3], 2, 1, "main").dot([0, 4, 3], "spot").dot([5, 4, 1], "spot").dot([3, 5, 5], "spot").dot([2, 5, 2], "spot");
  m.setPivot([3, 0, 3]);
});
tpl("sandwich", "food", "sandwich,burger,hamburger,cheeseburger,sub,taco,wrap,club sandwich", [8, 7, 8], (m) => {
  held(m, "main", "lettuce", { bun: "#e0a050", lettuce: LEAF, main: "#6b3a1e", cheese: "#f2d03a" });
  m.box([0, 0, 0], [7, 1, 7], "bun").box([0, 2, 0], [7, 2, 7], "lettuce").box([0, 3, 0], [7, 3, 7], "main").box([0, 4, 0], [7, 4, 7], "cheese").box([0, 5, 0], [7, 5, 7], "bun").box([1, 6, 1], [6, 6, 6], "bun");
  m.setPivot([3.5, 0, 3.5]);
});
tpl("icecream", "food", "ice cream,icecream,sundae,gelato,frozen yogurt,cone,lollipop", [5, 11, 5], (m) => {
  held(m, "main", "cherry", { cone: "#d8a050", main: "#f8d8e8", cherry: "#d93b2b" });
  m.line([2, 0, 2], [2, 1, 2], "cone").box([1, 2, 1], [3, 4, 3], "cone").box([0, 5, 0], [4, 8, 4], "main").box([1, 9, 1], [3, 9, 3], "main").dot([2, 10, 2], "cherry");
  m.setPivot([2, 0, 2]);
});

// ---- wearables (head items: pivot = bottom centre, resting on the head)
tpl("hat", "wearable", "hat,cap,beanie,sombrero,top hat,cowboy hat,bonnet,fedora,beret,hood,headband", [11, 6, 11], (m) => {
  held(m, "main", "band", { main: "#6b4a2b", band: "#d93b2b" });
  m.cyl([5, 0, 5], 5, 1, "main").cyl([5, 1, 5], 3, 4, "main").cyl([5, 1, 5], 3, 1, "band").cyl([5, 5, 5], 2, 1, "main");
  m.setPivot([5, 0, 5]);
});
tpl("wizardhat", "wearable", "wizard hat,witch hat,witches hat,party hat,dunce cap", [9, 11, 9], (m) => {
  held(m, "main", "star", { main: "#6a3ab0", star: GOLD });
  m.cyl([4, 0, 4], 4, 1, "main").cyl([4, 1, 4], 3, 3, "main").cyl([4, 1, 4], 3, 1, "star").cyl([4, 4, 4], 2, 3, "main").cyl([4, 7, 4], 1, 2, "main").dot([4, 9, 4], "main").dot([4, 10, 5], "main");
  m.dot([4, 5, 6], "star").dot([2, 3, 6], "star");
  m.setPivot([4, 0, 4]);
});
tpl("helmet", "wearable", "helmet,helm,headgear,armet,bascinet", [9, 9, 9], (m) => {
  held(m, "main", "crest", { main: IRON, crest: "#d93b2b", visor: "#2a2a30" });
  m.hollow([0, 0, 0], [8, 7, 8], "main").air([1, 0, 1], [7, 0, 7]).air([2, 2, 8], [6, 4, 8]).line([2, 3, 8], [6, 3, 8], "visor").line([4, 8, 1], [4, 8, 7], "crest");
  m.setPivot([4, 0, 4]);
});
tpl("crown", "wearable", "crown,tiara,circlet,diadem,coronet,halo", [9, 4, 9], (m) => {
  held(m, "main", "gem", { main: GOLD, gem: "#d93b2b" });
  m.cyl([4, 0, 4], 4, 2, "main", true);
  for (const [x, z] of [[4, 0], [4, 8], [0, 4], [8, 4], [1, 1], [7, 7], [1, 7], [7, 1]] as [number, number][]) m.dot([x, 2, z], "main");
  m.dot([4, 3, 0], "main").dot([4, 3, 8], "main").dot([0, 3, 4], "main").dot([8, 3, 4], "main");
  m.dot([4, 1, 0], "gem").dot([0, 1, 4], "gem").dot([8, 1, 4], "gem").dot([4, 1, 8], "gem");
  m.setPivot([4, 0, 4]);
});
tpl("mask", "wearable", "mask,visor,goggles,glasses,sunglasses,monocle", [8, 7, 1], (m) => {
  held(m, "main", "trim", { main: "#f4f4f0", trim: "#d93b2b" });
  m.box([0, 0, 0], [7, 6, 0], "main").air([1, 3, 0], [2, 4, 0]).air([5, 3, 0], [6, 4, 0]).line([2, 1, 0], [5, 1, 0], "trim").line([0, 6, 0], [7, 6, 0], "trim");
  m.setPivot([3.5, 3, 0]);
});
tpl("chest", "wearable", "chestplate,breastplate,armor,armour,shirt,tunic,robe,coat,jacket,vest,dress,sweater,hoodie,jersey,gown,suit,cuirass,mail,chainmail,t shirt,tshirt,jumper,uniform", [12, 10, 5], (m) => {
  held(m, "main", "belt", { main: "#3b6fd9", belt: DARK_WOOD, emblem: GOLD });
  m.box([2, 0, 0], [9, 9, 4], "main").boxX([0, 5, 1], [1, 9, 3], "main").air([4, 9, 1], [7, 9, 3]).box([2, 0, 0], [9, 1, 4], "belt").dot([5, 6, 4], "emblem").dot([6, 6, 4], "emblem");
  m.setPivot([5.5, 5, 2]);
});
tpl("legs", "wearable", "pants,trousers,leggings,greaves,jeans,shorts,skirt,kilt,breeches,tights,overalls", [8, 12, 4], (m) => {
  held(m, "main", "belt", { main: "#3a4a6a", belt: DARK_WOOD });
  m.box([0, 10, 0], [7, 11, 3], "belt").boxX([0, 0, 0], [3, 9, 3], "main");
  m.setPivot([3.5, 11, 1.5]);
});
tpl("boots", "wearable", "boots,boot,shoes,shoe,sandals,slippers,sneakers,clogs,sabatons,socks", [7, 6, 5], (m) => {
  held(m, "main", "cuff", { main: "#6b4a2b", cuff: "#f3e5c0", sole: "#3a2a1e" });
  m.boxX([0, 0, 0], [2, 0, 4], "sole").boxX([0, 1, 0], [2, 1, 4], "main").boxX([0, 2, 0], [2, 4, 2], "main").boxX([0, 5, 0], [2, 5, 2], "cuff");
  m.setPivot([3, 0, 2]);
});
tpl("gloves", "wearable", "gloves,glove,gauntlets,gauntlet,mittens,bracers,bracelet", [9, 6, 4], (m) => {
  held(m, "main", "cuff", { main: "#8a5a35", cuff: "#f3e5c0" });
  m.boxX([0, 0, 0], [3, 4, 3], "main").boxX([0, 5, 0], [3, 5, 3], "cuff").dotX([3, 2, 4], "main");
  m.setPivot([4, 3, 2]);
});
tpl("amulet", "wearable", "amulet,necklace,pendant,locket,talisman,medallion,ring,scarf,tie,bowtie,bow tie,collar,brooch", [7, 8, 1], (m) => {
  held(m, "gem", "chain", { chain: GOLD, gem: "#2fbf71" });
  m.lineX([0, 7, 0], [2, 2, 0], "chain").box([2, 0, 0], [4, 2, 0], "gem").dot([3, 1, 0], "chain");
  m.setPivot([3, 7, 0]);
});
tpl("cape", "wearable", "cape,cloak,mantle,poncho,shawl", [10, 14, 2], (m) => {
  held(m, "main", "collar", { main: "#b0172f", collar: GOLD });
  m.box([0, 0, 1], [9, 12, 1], "main").box([1, 12, 1], [8, 12, 1], "main").box([2, 13, 0], [7, 13, 1], "collar").dot([0, 0, 0], "main").dot([9, 0, 0], "main");
  m.setPivot([4.5, 13, 1]);
});
tpl("backpack", "wearable", "backpack,rucksack,satchel,bag,quiver,pack,jetpack", [8, 10, 6], (m) => {
  held(m, "main", "strap", { main: "#8a5a35", strap: "#5a3a24", buckle: GOLD });
  m.box([0, 0, 0], [7, 9, 4], "main").box([2, 1, 5], [5, 4, 5], "strap").box([0, 8, 0], [7, 9, 5], "strap").dot([3, 7, 5], "buckle").lineX([1, 0, 0], [1, 9, 0], "strap");
  m.setPivot([3.5, 9, 0]);
});
tpl("wings", "wearable", "wings,angel wings,fairy wings,butterfly wings,glider,jet wings", [14, 12, 2], (m) => {
  held(m, "main", "tip", { main: "#f4f4f0", tip: "#c8d8f0", mount: DARK_WOOD });
  m.boxX([0, 4, 0], [5, 11, 0], "main").boxX([1, 2, 0], [4, 3, 0], "main").lineX([0, 4, 0], [0, 11, 0], "tip").lineX([1, 2, 0], [1, 3, 0], "tip").box([6, 6, 1], [7, 9, 1], "mount");
  m.setPivot([6.5, 8, 1]);
});

// ---- decorations
tpl("crate", "decoration", "crate,box,container,package,present,gift,parcel,cube decoration", [8, 8, 8], (m) => {
  held(m, "main", "frame", { main: WOOD, frame: DARK_WOOD });
  m.box([0, 0, 0], [7, 7, 7], "main").edges([0, 0, 0], [7, 7, 7], "frame").line([0, 0, 7], [7, 7, 7], "frame").line([0, 0, 0], [7, 7, 0], "frame").line([0, 0, 0], [0, 7, 7], "frame").line([7, 0, 7], [7, 7, 0], "frame");
  m.setPivot([3.5, 0, 3.5]);
});
tpl("treasure", "decoration", "chest,treasure chest,treasure,coffer,trunk,strongbox,safe", [10, 7, 7], (m) => {
  held(m, "main", "band", { main: WOOD, band: DARK_WOOD, lock: GOLD });
  m.box([0, 0, 0], [9, 4, 6], "main").box([0, 5, 0], [9, 6, 6], "main").line([0, 4, 6], [9, 4, 6], "band").lineX([1, 0, 6], [1, 6, 6], "band").line([1, 6, 0], [1, 6, 6], "band").line([8, 6, 0], [8, 6, 6], "band").box([4, 3, 6], [5, 5, 6], "lock");
  m.setPivot([4.5, 0, 3]);
});
tpl("barrel", "decoration", "barrel,keg,cask,drum,tub,bin,trash can", [9, 9, 9], (m) => {
  held(m, "main", "band", { main: WOOD, band: "#5a5f68", top: DARK_WOOD });
  m.cyl([4, 0, 4], 4, 9, "main").cyl([4, 1, 4], 4, 1, "band").cyl([4, 7, 4], 4, 1, "band").cyl([4, 8, 4], 3, 1, "top");
  m.setPivot([4, 0, 4]);
});
tpl("lantern", "decoration", "lantern,lamp,lightbulb,light bulb,light,glow lamp,paper lantern", [5, 8, 5], (m) => {
  held(m, "glow", "main", { main: "#3a3a44", glow: GLOW });
  m.box([0, 0, 0], [4, 0, 4], "main").box([0, 5, 0], [4, 5, 4], "main").edges([0, 1, 0], [4, 4, 4], "main").box([1, 1, 1], [3, 4, 3], "glow").box([2, 6, 2], [2, 7, 2], "main");
  m.setPivot([2, 0, 2]);
});
tpl("streetlamp", "decoration", "streetlamp,street lamp,lamppost,lamp post,floor lamp,torch post,lighthouse", [5, 16, 5], (m) => {
  held(m, "glow", "main", { main: "#3a3a44", glow: GLOW });
  m.box([1, 0, 1], [3, 1, 3], "main").line([2, 2, 2], [2, 12, 2], "main").box([1, 13, 1], [3, 14, 3], "glow").box([0, 15, 0], [4, 15, 4], "main");
  m.setPivot([2, 0, 2]);
});
tpl("candle", "decoration", "candle,candlestick,candelabra,tealight", [3, 7, 3], (m) => {
  held(m, "main", "flame", { main: "#f3e5c0", wick: "#26262c", flame: FLAME, glow: GLOW });
  m.box([0, 0, 0], [2, 4, 2], "main").dot([1, 5, 1], "wick").dot([1, 6, 1], "flame").dot([1, 5, 0], "main");
  m.setPivot([1, 0, 1]);
});
tpl("campfire", "decoration", "campfire,bonfire,fire pit,firepit,fireplace,brazier,fire", [8, 5, 8], (m) => {
  held(m, "flame", "log", { log: DARK_WOOD, flame: FLAME, glow: GLOW, stone: STONE });
  m.line([0, 0, 1], [7, 0, 6], "log").line([0, 0, 6], [7, 0, 1], "log").line([1, 1, 3], [6, 1, 4], "log");
  m.box([2, 1, 2], [5, 1, 5], "flame").box([3, 2, 3], [4, 3, 4], "flame").dot([3, 4, 3], "glow").dot([4, 3, 4], "glow");
  m.dot([0, 0, 0], "stone").dot([7, 0, 7], "stone").dot([0, 0, 7], "stone").dot([7, 0, 0], "stone");
  m.setPivot([3.5, 0, 3.5]);
});
tpl("table", "decoration", "table,desk,counter,workbench,altar,crafting table", [12, 8, 8], (m) => {
  held(m, "main", "item", { main: WOOD, item: "#d93b2b" });
  m.box([0, 6, 0], [11, 6, 7], "main").boxX([0, 0, 0], [0, 5, 0], "main").boxX([0, 0, 7], [0, 5, 7], "main").dot([5, 7, 3], "item");
  m.setPivot([5.5, 0, 3.5]);
});
tpl("chair", "decoration", "chair,stool,throne,armchair,seat,bench", [6, 11, 6], (m) => {
  held(m, "main", "cushion", { main: WOOD, cushion: "#b0172f" });
  m.box([0, 4, 0], [5, 4, 5], "main").boxX([0, 0, 0], [0, 3, 0], "main").boxX([0, 0, 5], [0, 3, 5], "main").box([0, 5, 0], [5, 10, 0], "main").box([1, 6, 0], [4, 9, 0], "cushion").box([1, 4, 1], [4, 4, 4], "cushion");
  m.setPivot([2.5, 0, 2.5]);
});
tpl("bed", "decoration", "bed,cot,hammock,bunk,mattress,sleeping bag", [7, 5, 13], (m) => {
  held(m, "blanket", "main", { main: WOOD, sheet: WHITE, blanket: "#b0172f" });
  m.box([0, 0, 0], [6, 1, 12], "main").box([0, 2, 1], [6, 2, 12], "sheet").box([0, 2, 5], [6, 3, 12], "blanket").box([1, 3, 1], [5, 3, 3], "sheet").box([0, 0, 0], [6, 4, 0], "main");
  m.setPivot([3, 0, 6]);
});
tpl("sofa", "decoration", "sofa,couch,loveseat,ottoman,beanbag", [12, 6, 5], (m) => {
  held(m, "main", "cushion", { main: "#3a6a5a", cushion: "#5a8a7a", foot: DARK_WOOD });
  m.box([0, 1, 0], [11, 2, 4], "main").box([0, 3, 0], [11, 5, 1], "main").boxX([0, 3, 0], [0, 4, 4], "main").box([1, 3, 2], [10, 3, 4], "cushion").boxX([0, 0, 0], [0, 0, 0], "foot").boxX([0, 0, 4], [0, 0, 4], "foot");
  m.setPivot([5.5, 0, 2]);
});
tpl("shelf", "decoration", "bookshelf,bookcase,shelf,cabinet,wardrobe,dresser,cupboard,library", [8, 12, 4], (m) => {
  held(m, "main", "book", { main: WOOD, book: "#b0172f", book2: "#3b6fd9", book3: "#4caf50" });
  m.hollow([0, 0, 0], [7, 11, 3], "main").air([1, 1, 3], [6, 10, 3]).box([1, 4, 0], [6, 4, 3], "main").box([1, 8, 0], [6, 8, 3], "main");
  m.box([1, 1, 1], [2, 3, 2], "book").box([3, 1, 1], [3, 3, 2], "book2").box([4, 5, 1], [6, 7, 2], "book3").box([1, 9, 1], [3, 10, 2], "book2").box([5, 9, 1], [5, 10, 2], "book");
  m.setPivot([3.5, 0, 1.5]);
});
tpl("flower", "decoration", "flower,rose,tulip,daisy,sunflower,lily,orchid,plant,potted plant,flower pot,flowerpot,houseplant,bouquet,lotus,poppy,dandelion,herb,fern,sapling", [5, 10, 5], (m) => {
  held(m, "main", "pot", { pot: "#b0603a", main: "#e0303a", center: "#f2d03a", leaf: LEAF });
  m.box([1, 0, 1], [3, 2, 3], "pot").box([0, 2, 0], [4, 2, 4], "pot").line([2, 3, 2], [2, 7, 2], "leaf").dot([1, 5, 2], "leaf").dot([3, 6, 2], "leaf");
  m.box([1, 8, 1], [3, 8, 3], "main").dot([2, 9, 2], "main").dot([2, 7, 1], "main").dot([2, 7, 3], "main").dot([1, 7, 2], "main").dot([3, 7, 2], "main").dot([2, 8, 2], "center");
  m.setPivot([2, 0, 2]);
});
tpl("cactus", "decoration", "cactus,cacti,succulent,aloe", [7, 12, 7], (m) => {
  held(m, "main", "flower", { main: "#3a9a4a", flower: "#f29ab8", spine: "#f3e5c0" });
  m.box([2, 0, 2], [4, 10, 4], "main").boxX([0, 4, 3], [1, 4, 3], "main").boxX([0, 5, 3], [0, 8, 3], "main").dot([3, 11, 3], "flower").dot([2, 7, 4], "spine").dot([4, 3, 2], "spine");
  m.setPivot([3, 0, 3]);
});
tpl("tree", "decoration", "tree,oak,pine,palm,christmas tree,bonsai,willow,birch", [11, 16, 11], (m) => {
  held(m, "main", "fruit", { trunk: DARK_WOOD, main: "#3f8a2e", fruit: "#d93b2b" });
  m.box([4, 0, 4], [6, 8, 6], "trunk").sphere([5, 11, 5], 4, "main").dot([2, 10, 8], "fruit").dot([8, 12, 3], "fruit").dot([5, 14, 8], "fruit");
  m.setPivot([5, 0, 5]);
});
tpl("bush", "decoration", "bush,shrub,hedge,topiary,grass,moss,vine", [8, 6, 8], (m) => {
  held(m, "main", "berry", { main: "#3f8a2e", berry: "#d93b2b" });
  m.box([0, 0, 1], [7, 4, 6], "main").box([1, 0, 0], [6, 4, 7], "main").box([1, 5, 1], [6, 5, 6], "main").dot([2, 3, 0], "berry").dot([6, 4, 7], "berry").dot([0, 2, 3], "berry");
  m.setPivot([3.5, 0, 3.5]);
});
// ---- vehicles (decorations / toys; facing +Z, standing on y = 0)
tpl("train", "vehicle", "train,locomotive,steam train,steam engine,engine,choo choo,tram,trolley,railcar,subway", [7, 11, 16], (m) => {
  held(m, "main", "trim", { main: "#2e4a7a", trim: GOLD, base: "#2a2a2e", wheel: "#1a1a1c", window: "#9fd4ff", roof: "#8a2a2a", lamp: "#ffe27a", smoke: "#d8d8d8" });
  m.box([1, 1, 0], [5, 2, 15], "base");
  for (const z of [2, 7, 12]) m.box([0, 0, z], [0, 1, z + 1], "wheel").box([6, 0, z], [6, 1, z + 1], "wheel");
  m.box([1, 3, 6], [5, 6, 15], "main").line([1, 4, 9], [5, 4, 9], "trim").line([1, 4, 12], [5, 4, 12], "trim");
  m.box([0, 3, 0], [6, 8, 5], "main").box([0, 6, 2], [0, 7, 3], "window").box([6, 6, 2], [6, 7, 3], "window").box([0, 9, 0], [6, 9, 5], "roof");
  m.box([2, 7, 12], [4, 8, 14], "trim").dot([3, 9, 13], "base").dot([3, 10, 13], "smoke").dot([3, 5, 15], "lamp");
  m.box([1, 0, 15], [5, 0, 15], "trim");
  m.setPivot([3, 0, 8]);
});
tpl("car", "vehicle", "car,truck,bus,van,jeep,taxi,race car,racecar,sports car,lorry,tractor,ambulance,fire truck,firetruck", [7, 7, 12], (m) => {
  held(m, "main", "trim", { main: "#d93b2b", trim: "#e6e6e6", wheel: "#1a1a1c", window: "#9fd4ff", lamp: "#ffe27a" });
  for (const z of [2, 9]) m.box([0, 0, z], [0, 1, z + 1], "wheel").box([6, 0, z], [6, 1, z + 1], "wheel");
  m.box([1, 1, 0], [5, 3, 11], "main").box([1, 4, 3], [5, 5, 8], "main").box([1, 4, 8], [5, 4, 8], "window").box([1, 4, 3], [5, 4, 3], "window");
  m.box([0, 5, 4], [0, 5, 7], "window").box([6, 5, 4], [6, 5, 7], "window").box([1, 6, 4], [5, 6, 7], "main");
  m.dot([1, 2, 11], "lamp").dot([5, 2, 11], "lamp").box([1, 1, 0], [5, 1, 0], "trim");
  m.setPivot([3, 0, 6]);
});
tpl("boat", "vehicle", "boat,ship,sailboat,sailing ship,pirate ship,galleon,canoe,kayak,raft,yacht,submarine,ferry", [7, 12, 14], (m) => {
  held(m, "main", "sail", { main: WOOD, trim: DARK_WOOD, sail: "#f3efe2", flag: "#d93b2b" });
  m.box([2, 0, 2], [4, 0, 11], "trim").box([1, 1, 1], [5, 2, 12], "main").box([0, 3, 0], [6, 3, 13], "trim").box([2, 1, 13], [4, 2, 13], "main");
  m.line([3, 4, 6], [3, 11, 6], "trim").box([1, 5, 7], [5, 10, 7], "sail").dot([3, 11, 7], "flag");
  m.setPivot([3, 0, 7]);
});
tpl("cart", "vehicle", "cart,wagon,minecart,mine cart,wheelbarrow,carriage,chariot,sled,sleigh", [7, 6, 9], (m) => {
  held(m, "main", "trim", { main: WOOD, trim: IRON, wheel: "#3a2a1e" });
  for (const z of [1, 6]) m.box([0, 0, z], [0, 2, z + 1], "wheel").box([6, 0, z], [6, 2, z + 1], "wheel");
  m.box([1, 1, 0], [5, 1, 8], "main").box([1, 2, 0], [5, 4, 0], "main").box([1, 2, 8], [5, 4, 8], "main").box([1, 2, 1], [1, 4, 7], "main").box([5, 2, 1], [5, 4, 7], "main");
  m.line([1, 5, 0], [5, 5, 0], "trim").line([1, 5, 8], [5, 5, 8], "trim");
  m.setPivot([3, 0, 4]);
});
tpl("plane", "vehicle", "plane,airplane,aeroplane,jet,biplane,aircraft,helicopter,glider,airship,blimp,zeppelin", [13, 6, 12], (m) => {
  held(m, "main", "trim", { main: "#e6e6e6", trim: "#2e6ad9", window: "#9fd4ff", prop: "#3a3a3e" });
  m.box([5, 1, 0], [7, 3, 11], "main").box([0, 2, 6], [12, 2, 8], "trim").box([3, 3, 0], [9, 3, 1], "trim").box([6, 4, 0], [6, 5, 1], "trim");
  m.box([5, 3, 8], [7, 3, 9], "window").box([5, 0, 11], [7, 4, 11], "prop").dot([6, 2, 11], "trim");
  m.setPivot([6, 0, 6]);
});
tpl("rocket", "vehicle", "rocket,spaceship,space ship,spacecraft,ufo,space shuttle,shuttle,missile", [7, 16, 7], (m) => {
  held(m, "main", "trim", { main: "#e6e6e6", trim: "#d93b2b", window: "#9fd4ff", flame: "#ff9a2a" });
  m.cyl([3, 2, 3], 2, 11, "main").box([2, 13, 2], [4, 14, 4], "trim").dot([3, 15, 3], "trim").box([3, 8, 5], [3, 9, 5], "window");
  m.box([0, 1, 3], [0, 4, 3], "trim").box([6, 1, 3], [6, 4, 3], "trim").box([3, 1, 0], [3, 4, 0], "trim").box([3, 1, 6], [3, 4, 6], "trim").box([2, 0, 2], [4, 1, 4], "flame");
  m.setPivot([3, 0, 3]);
});
tpl("statue", "decoration", "statue,figure,figurine,idol,sculpture,bust,totem,gnome,garden gnome,monument,effigy,plush,plushie,teddy,teddy bear,stuffed animal,toy,doll,action figure", [8, 16, 6], (m) => {
  held(m, "main", "base", { main: "#c8c8cc", base: "#8a8a90", eye: "#6a6a70" });
  m.box([0, 0, 0], [7, 1, 5], "base").boxX([1, 2, 1], [3, 6, 4], "main").box([1, 7, 1], [6, 11, 4], "main").boxX([0, 7, 2], [0, 11, 3], "main").box([2, 12, 1], [5, 15, 4], "main").dotX([3, 14, 4], "eye");
  m.setPivot([3.5, 0, 2.5]);
});
tpl("painting", "decoration", "painting,picture,portrait,poster,canvas,artwork,mural,photo,photograph,tapestry,map,window", [10, 8, 1], (m) => {
  held(m, "sky", "frame", { frame: GOLD, sky: "#7ac0f0", hill: "#4caf50", sun: "#f2d03a" });
  m.box([0, 0, 0], [9, 7, 0], "frame").box([1, 1, 0], [8, 6, 0], "sky").box([1, 1, 0], [8, 2, 0], "hill").box([3, 3, 0], [5, 3, 0], "hill").dot([7, 5, 0], "sun");
  m.setPivot([4.5, 3.5, 0]);
});
tpl("banner", "decoration", "banner,flag,pennant,standard,windsock", [7, 16, 1], (m) => {
  held(m, "main", "emblem", { pole: DARK_WOOD, main: "#b0172f", emblem: GOLD });
  m.line([0, 0, 0], [0, 15, 0], "pole").box([1, 8, 0], [6, 14, 0], "main").box([3, 10, 0], [4, 12, 0], "emblem").dot([0, 15, 0], "emblem");
  m.setPivot([0, 0, 0]);
});
tpl("sign", "decoration", "sign,signpost,sign post,noticeboard,notice board,plaque,mailbox,scroll,book,tome,letter,note", [8, 9, 2], (m) => {
  held(m, "main", "text", { post: DARK_WOOD, main: WOOD, text: "#3a2a1e" });
  m.box([3, 0, 0], [4, 4, 0], "post").box([0, 5, 0], [7, 8, 0], "main").line([1, 7, 1], [6, 7, 1], "text").line([1, 6, 1], [5, 6, 1], "text");
  m.setPivot([3.5, 0, 0]);
});
tpl("vase", "decoration", "vase,urn,jar,pot,amphora,jug,pitcher,teapot,kettle,cauldron", [7, 9, 7], (m) => {
  held(m, "main", "band", { main: "#3b6fd9", band: "#f4f4f0" });
  m.cyl([3, 0, 3], 2, 1, "main").cyl([3, 1, 3], 3, 4, "main").cyl([3, 3, 3], 3, 1, "band").cyl([3, 5, 3], 2, 2, "main").cyl([3, 7, 3], 1, 1, "main").cyl([3, 8, 3], 2, 1, "main", true);
  m.setPivot([3, 0, 3]);
});
tpl("trophy", "decoration", "trophy,goblet,chalice,grail,cup trophy,award,medal", [7, 9, 7], (m) => {
  held(m, "main", "base", { main: GOLD, base: "#3a3a44" });
  m.box([1, 0, 1], [5, 1, 5], "base").line([3, 2, 3], [3, 3, 3], "main").cyl([3, 4, 3], 2, 1, "main").cyl([3, 5, 3], 3, 4, "main", true);
  m.setPivot([3, 0, 3]);
});
tpl("orb", "decoration", "orb,globe,crystal ball,snow globe,snowglobe,sphere,ball,planet,moon,star,sun,disco ball,bubble", [7, 9, 7], (m) => {
  held(m, "main", "base", { main: "#7ac0f0", base: DARK_WOOD, shine: "#ffffff" });
  m.box([1, 0, 1], [5, 1, 5], "base").sphere([3, 5, 3], 3, "main").dot([2, 7, 1], "shine");
  m.setPivot([3, 0, 3]);
});
tpl("rug", "decoration", "rug,carpet,mat,doormat,blanket,quilt,towel,tablecloth", [12, 1, 8], (m) => {
  held(m, "main", "border", { main: "#b0172f", border: GOLD });
  m.box([0, 0, 0], [11, 0, 7], "border").box([1, 0, 1], [10, 0, 6], "main").box([4, 0, 3], [7, 0, 4], "border");
  m.setPivot([5.5, 0, 3.5]);
});
tpl("clock", "decoration", "clock,watch,sundial,hourglass", [9, 9, 1], (m) => {
  held(m, "rim", "hand", { rim: GOLD, face: "#f8f4e8", hand: "#26262c" });
  m.box([1, 0, 0], [7, 8, 0], "rim").box([0, 1, 0], [8, 7, 0], "rim").box([1, 1, 0], [7, 7, 0], "face").line([4, 4, 0], [4, 7, 0], "hand").line([4, 4, 0], [6, 4, 0], "hand");
  m.setPivot([4, 4, 0]);
});
tpl("bell", "decoration", "bell,chime,gong,horn", [7, 8, 7], (m) => {
  held(m, "main", "loop", { main: GOLD, loop: "#8a5a25" });
  m.cyl([3, 0, 3], 3, 2, "main").cyl([3, 2, 3], 2, 4, "main").line([3, 6, 3], [3, 7, 3], "loop").dot([3, 0, 3], "loop");
  m.setPivot([3, 7, 3]);
});
tpl("skull", "decoration", "skull,head,bones decoration,jack o lantern,jackolantern", [6, 6, 6], (m) => {
  held(m, "main", "eye", { main: "#e8e4d8", eye: "#26262c" });
  m.box([0, 1, 0], [5, 5, 5], "main").box([1, 0, 1], [4, 0, 5], "main").boxX([1, 2, 5], [2, 3, 5], "eye").dot([2, 1, 5], "eye").dot([3, 1, 5], "eye");
  m.setPivot([2.5, 0, 2.5]);
});
tpl("fountain", "decoration", "fountain,birdbath,bird bath,well,pond,pool", [11, 8, 11], (m) => {
  held(m, "main", "water", { main: STONE, water: "#3a8ad8" });
  m.cyl([5, 0, 5], 5, 1, "main").cyl([5, 1, 5], 5, 2, "main", true).cyl([5, 1, 5], 4, 1, "water").cyl([5, 0, 5], 1, 6, "main").cyl([5, 6, 5], 2, 1, "main").cyl([5, 7, 5], 1, 1, "water");
  m.setPivot([5, 0, 5]);
});
tpl("house", "decoration", "house,hut,cottage,cabin,shed,birdhouse,doghouse,dollhouse,tent,igloo", [8, 9, 8], (m) => {
  held(m, "main", "roof", { main: WOOD, roof: "#a4513f", door: DARK_WOOD, window: "#a8d8f0" });
  m.box([0, 0, 1], [7, 4, 6], "main").roof([0, 5, 0], [7, 5, 7], "roof").box([3, 0, 6], [4, 2, 6], "door").dot([1, 2, 6], "window").dot([6, 2, 6], "window");
  m.setPivot([3.5, 0, 3.5]);
});
tpl("tower", "decoration", "tower,castle,fortress,keep,windmill,lighthouse tower,obelisk,spire,pillar,column", [7, 16, 7], (m) => {
  held(m, "main", "roof", { main: STONE, roof: "#3b6fd9", window: "#26262c" });
  m.cyl([3, 0, 3], 3, 12, "main").cyl([3, 12, 3], 3, 1, "main", true).cyl([3, 13, 3], 2, 1, "roof").cyl([3, 14, 3], 1, 1, "roof").dot([3, 15, 3], "roof").dot([3, 8, 6], "window").dot([3, 4, 6], "window");
  m.setPivot([3, 0, 3]);
});
tpl("curio", "decoration", "curio,trinket,thing,object,item,decoration,ornament,gadget,device,machine,contraption,artifact,artefact,relic", [7, 8, 7], (m) => {
  held(m, "main", "base", { main: "#9a5ad8", base: "#5a5f68", shine: "#ffffff" });
  m.box([1, 0, 1], [5, 1, 5], "base").box([2, 2, 2], [4, 2, 4], "base").box([2, 3, 2], [4, 6, 4], "main").box([1, 4, 2], [5, 5, 4], "main").box([2, 4, 1], [4, 5, 5], "main").dot([3, 7, 3], "main").dot([2, 6, 1], "shine");
  m.setPivot([3, 0, 3]);
});

// ---- materials
tpl("ingot", "material", "ingot,bar,gold bar,bullion,brick of gold", [8, 3, 4], (m) => {
  held(m, "main", "shine", { main: IRON, shine: "#ffffff" });
  m.box([0, 0, 0], [7, 1, 3], "main").box([1, 2, 1], [6, 2, 2], "main").line([1, 2, 1], [6, 2, 1], "shine");
  m.setPivot([3.5, 0, 1.5]);
});
tpl("gem", "material", "gem,gemstone,jewel,diamond,ruby,emerald,sapphire,amethyst,topaz,opal,jade,onyx,garnet,quartz,crystal gem,coin,token", [5, 5, 5], (m) => {
  held(m, "main", "shine", { main: "#6ee0e0", shine: "#ffffff" });
  m.dot([2, 0, 2], "main").box([1, 1, 1], [3, 1, 3], "main").box([0, 2, 0], [4, 3, 4], "main").box([1, 4, 1], [3, 4, 3], "main").dot([1, 3, 0], "shine").dot([2, 4, 1], "shine");
  m.setPivot([2, 0, 2]);
});
tpl("crystal", "material", "crystal,shard,crystals,geode,prism,icicle", [6, 10, 6], (m) => {
  held(m, "main", "shine", { main: "#c8a0f0", shine: "#ffffff" });
  m.box([2, 0, 2], [3, 7, 3], "main").dot([2, 8, 2], "main").dot([3, 9, 3], "shine").box([0, 0, 3], [1, 4, 4], "main").dot([0, 5, 3], "main").box([4, 0, 1], [5, 5, 2], "main").dot([5, 6, 1], "main").line([2, 1, 2], [2, 6, 2], "shine");
  m.setPivot([3, 0, 3]);
});
tpl("dust", "material", "dust,powder,sand,salt,sugar,ash,flour,glitter,pollen,spice,pile,heap,seeds,grain,wheat", [7, 3, 7], (m) => {
  held(m, "main", "sparkle", { main: "#d8c890", sparkle: "#ffffff" });
  m.cyl([3, 0, 3], 3, 1, "main").cyl([3, 1, 3], 2, 1, "main").dot([3, 2, 3], "main").dot([1, 1, 3], "sparkle").dot([4, 2, 3], "sparkle");
  m.setPivot([3, 0, 3]);
});
tpl("nugget", "material", "nugget,ore,lump,rock,pebble,coal,slag,chunk,stone chunk,meteorite,boulder,clay,charcoal,honeycomb,resin,amber", [5, 4, 4], (m) => {
  held(m, "main", "speck", { main: "#8d8f94", speck: "#f2c230" });
  m.box([0, 0, 0], [4, 2, 3], "main").box([1, 3, 1], [3, 3, 2], "main").dot([1, 2, 0], "speck").dot([3, 1, 3], "speck").dot([4, 2, 1], "speck");
  m.setPivot([2, 0, 1.5]);
});
tpl("feather", "material", "feather,quill,plume", [3, 10, 1], (m) => {
  held(m, "main", "quill", { main: "#f4f4f0", quill: "#c8b898" });
  m.line([1, 0, 0], [1, 9, 0], "quill").box([0, 3, 0], [2, 8, 0], "main").dot([1, 9, 0], "main");
  m.setPivot([1, 0, 0]);
});
tpl("cloth", "material", "leather,hide,cloth,fabric,wool,silk,paper,fur,pelt,linen,cotton,felt,parchment,sheet", [8, 2, 8], (m) => {
  held(m, "main", "fold", { main: "#a0603a", fold: "#7a4a2a" });
  m.box([0, 0, 0], [7, 0, 7], "main").box([0, 1, 0], [7, 1, 3], "main").line([0, 1, 3], [7, 1, 3], "fold");
  m.setPivot([3.5, 0, 3.5]);
});
tpl("string", "material", "string,thread,rope,yarn,twine,cord,wire,vine rope", [5, 3, 5], (m) => {
  held(m, "main", "end", { main: "#f0ece0", end: "#c8c4b8" });
  m.cyl([2, 0, 2], 2, 3, "main", true).line([4, 0, 2], [4, 0, 4], "end");
  m.setPivot([2, 0, 2]);
});
tpl("bone", "material", "bone,bones,tusk,fang,tooth,claw,horn material", [3, 10, 3], (m) => {
  held(m, "main", "main", { main: "#f4ecd8" });
  m.line([1, 1, 1], [1, 8, 1], "main").dotX([0, 0, 1], "main").dotX([0, 9, 1], "main").dot([1, 0, 1], "main").dot([1, 9, 1], "main");
  m.setPivot([1, 0, 1]);
});
tpl("stick", "material", "stick,twig,branch,plank,log,lumber,timber,dowel,pole", [3, 12, 3], (m) => {
  held(m, "main", "knot", { main: WOOD, knot: DARK_WOOD });
  m.line([1, 0, 1], [1, 11, 1], "main").dot([1, 5, 1], "knot").dot([2, 7, 1], "main").dot([2, 8, 1], "main");
  m.setPivot([1, 0, 1]);
});
tpl("pearl", "material", "pearl,marble,bead,orb material,egg stone,seed", [4, 4, 4], (m) => {
  held(m, "main", "shine", { main: "#f4f0f8", shine: "#ffffff" });
  m.box([1, 0, 1], [2, 3, 2], "main").box([0, 1, 1], [3, 2, 2], "main").box([1, 1, 0], [2, 2, 3], "main").dot([1, 2, 0], "shine");
  m.setPivot([1.5, 0, 1.5]);
});
tpl("scale", "material", "scale,shell,seashell,petal,leaf,flake,chip,shingle", [6, 2, 6], (m) => {
  held(m, "main", "ridge", { main: "#3a9a4a", ridge: "#2a6a3a" });
  m.box([0, 0, 1], [5, 0, 4], "main").box([1, 0, 0], [4, 0, 5], "main").line([2, 1, 0], [2, 1, 5], "ridge").line([3, 1, 0], [3, 1, 5], "ridge");
  m.setPivot([2.5, 0, 2.5]);
});

// ---- blocks
tpl("block", "block", "block,cube,brick,bricks,tile,slab", [8, 8, 8], (m) => {
  held(m, "main", "speck", { main: "#8d8f94", speck: "#b8babf", shade: "#6d6f74" });
  m.box([0, 0, 0], [7, 7, 7], "main");
  for (const [x, y, z, k] of [[0, 2, 1, "speck"], [0, 5, 4, "shade"], [7, 1, 3, "speck"], [7, 6, 6, "shade"], [2, 7, 2, "speck"], [5, 7, 5, "shade"], [3, 3, 7, "speck"], [6, 5, 7, "shade"], [1, 6, 0, "speck"], [4, 1, 0, "shade"], [5, 3, 0, "speck"], [2, 4, 7, "shade"]] as [number, number, number, string][]) m.dot([x, y, z], k);
  m.setPivot([3.5, 0, 3.5]);
});

// ================================================================ analysis

const STOP = new Set(["a", "an", "the", "some", "my", "me", "please", "make", "forge", "create", "craft", "give", "build", "i", "want", "need", "new", "would", "like", "can", "you", "we", "us", "really", "very", "super", "little", "big", "tiny", "huge", "giant", "small", "large", "cute", "one", "of", "with", "and", "that", "is", "it", "to", "for", "in", "on", "made", "from"]);
const CONNECTORS = new Set(["of", "with", "that", "which", "who", "made", "from", "for", "to", "in", "on", "wearing", "holding", "covered", "full", "and"]);
const COOKED = new Set(["roast", "roasted", "fried", "cooked", "grilled", "baked", "smoked", "stewed", "boiled", "barbecued", "bbq", "steamed", "toasted", "crispy", "raw"]);
const FIGURE_WORDS = new Set(["statue", "statuette", "figure", "figurine", "plush", "plushie", "toy", "teddy", "doll", "sculpture", "idol", "carving", "stuffed"]);
const DARKER = new Set(["dark", "deep", "shadowy", "dusky"]);
const LIGHTER = new Set(["light", "pale", "bright", "pastel", "soft"]);
/** Kinds that take what follows "of" as their subject ("statue of a chicken", "block of gold", "potion of healing"). */
const OF_HEADS = new Set(["block", "statue", "bottle", "bowl", "painting", "banner", "crate", "dust", "ingot", "treasure", "orb", "cake", "pie", "rug"]);

function singular(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ves") && w.length > 4) return `${w.slice(0, -3)}f`;
  if (/(ches|shes|xes|sses|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

interface Hit { cat: ThingCategory; kind: string; at: number; len: number }

function lookup(word: string): { cat: ThingCategory; kind: string } | null {
  for (const w of [word, singular(word)]) {
    const kind = KIND_WORDS[w];
    if (kind) return { cat: TEMPLATES[kind].cat, kind };
    const c = CREATURE_WORDS[w];
    if (c) return { cat: "creature", kind: c };
  }
  return null;
}

/** The last lexicon hit in tokens[from..to) (bigrams first). */
function lastHit(tokens: string[], from: number, to: number): Hit | null {
  for (let i = to - 1; i >= from; i--) {
    if (i - 1 >= from) {
      const bi = lookup(`${tokens[i - 1]} ${tokens[i]}`);
      if (bi) return { ...bi, at: i - 1, len: 2 };
    }
    const tok = tokens[i];
    if (tok === "of" || STOP.has(tok) && !lookup(tok)) continue;
    const one = lookup(tok);
    if (one) return { ...one, at: i, len: 1 };
  }
  return null;
}

function tokenize(prompt: string): string[] {
  return prompt.toLowerCase().replace(/['’]s\b/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 60);
}

/** Result of reading a prompt with the rules. */
export interface ThingAnalysis {
  category: ThingCategory;
  /** Template kind (sword, fruit, hat ...) or species key for creatures (chicken, cow ...). */
  kind: string;
  /** The noun the kind came from ("chicken"). */
  noun: string;
  /** A creature named elsewhere in the prompt (statue / plush / cooked subject). */
  subject: string | null;
  /** The noun after "of" for of-heads ("block of cheese" -> "cheese"). */
  subjectNoun: string | null;
  /** Hex colours from colour / material words, in order. */
  colors: string[];
  colorWords: string[];
  effect: ThingEffect;
  rarity: ThingRarity;
  /** Words the forge used: "cooked", "plush" ... */
  mods: string[];
}

const EFFECT_RULES: [ThingEffect, RegExp][] = [
  ["chain_lightning", /\b(lightning|thunder\w*|storm\w*|shock\w*|electric\w*|zap\w*|spark\w*|static)\b/],
  ["explode_on_hit", /\b(explo\w*|bomb\w*|tnt|boom\w*|blast\w*|dynamite|nuclear)\b/],
  ["fire_trail", /\b(fire|fiery|flam\w*|blaz\w*|burn\w*|lava|molten|inferno|ember\w*|magma|scorch\w*|hot)\b/],
  ["frost_slow", /\b(ice|icy|frost\w*|frozen|freez\w*|snow\w*|glacial|cold|chill\w*|winter)\b/],
  ["heal_aura", /\b(heal\w*|holy|life|blessed|sacred|cur(?:e|ing)|regen\w*|mend\w*|soothing)\b/],
  ["knockback_burst", /\b(knockback|gust\w*|wind\w*|push\w*|bounc\w*|force|shockwave|thump\w*|bonk\w*)\b/],
  ["vein_mine", /\b(vein\w*|excavat\w*|miner|mining|tunnel\w*|drill\w*|digg\w*)\b/],
  ["speed", /\b(swift\w*|speed\w*|fast\w*|quick\w*|rocket\w*|haste|zoom\w*|turbo|sprint\w*|racing)\b/],
  ["jump", /\b(jump\w*|spring\w*|leap\w*|hop\w*|boing\w*|kangaroo)\b/],
  ["night_vision", /\b(night|vision|nocturnal|seeing|darksight|infrared|owl)\b/],
  ["glow", /\b(glow\w*|shin\w*|radiant|luminous|sparkl\w*|lumin\w*|neon|magic\w*|enchant\w*|glitter\w*|light up)\b/],
];
const RARITY_RULES: [ThingRarity, RegExp][] = [
  ["legendary", /\b(legendary|mythic\w*|godly|divine|ancient|ultimate|celestial|cosmic|infinity|omnipotent|excalibur)\b/],
  ["epic", /\b(epic|enchanted|magic\w*|arcane|cursed|dragon\w*|royal|phoenix|unicorn|demonic|angelic)\b/],
  ["rare", /\b(rare|golden|gold|diamond|crystal\w*|glowing|shiny|silver|ruby|sapphire|emerald|amethyst|obsidian|rainbow)\b/],
  ["uncommon", /\b(uncommon|fine|sturdy|iron|steel|bronze|copper|reinforced|fancy|big|giant|huge|great)\b/],
];

/** Reads a prompt: category + template kind (head noun wins), colours, effect, rarity. Never throws. */
export function analyzeThing(prompt: string): ThingAnalysis {
  const tokens = tokenize(prompt);
  let cut = tokens.findIndex((t, i) => i > 0 && CONNECTORS.has(t));
  if (cut < 0) cut = tokens.length;
  let hit = lastHit(tokens, 0, cut);
  const tailHit = cut < tokens.length ? lastHit(tokens, cut + 1, tokens.length) : null;
  let subjectHit: Hit | null = null;
  if (hit && tailHit && tokens[cut] === "of" && OF_HEADS.has(hit.kind)) subjectHit = tailHit;
  if (!hit) hit = tailHit;
  // "the block" alone, "X block" with X a thing -> block of X
  const used = new Set<number>();
  if (hit) for (let i = hit.at; i < hit.at + hit.len; i++) used.add(i);
  if (subjectHit) for (let i = subjectHit.at; i < subjectHit.at + subjectHit.len; i++) used.add(i);
  const mods: string[] = [];
  let category: ThingCategory = hit?.cat ?? "decoration";
  let kind = hit?.kind ?? "curio";
  let noun = hit ? tokens.slice(hit.at, hit.at + hit.len).join(" ") : tokens.filter((t) => !STOP.has(t)).pop() ?? "thing";
  let subject: string | null = subjectHit?.cat === "creature" ? subjectHit.kind : null;
  const subjectNoun = subjectHit ? tokens.slice(subjectHit.at, subjectHit.at + subjectHit.len).join(" ") : null;
  // "teddy bear": the creature inside a statue / plush bigram
  if (!subject && hit?.kind === "statue") {
    for (let i = hit.at; i < hit.at + hit.len; i++) {
      const c = CREATURE_WORDS[tokens[i]] ?? CREATURE_WORDS[singular(tokens[i])];
      if (c) subject = c;
    }
  }
  // a creature named anywhere else (plush chicken, chicken statue)
  if (!subject && hit && hit.cat !== "creature") {
    for (let i = 0; i < tokens.length; i++) {
      if (used.has(i)) continue;
      const c = lookup(tokens[i]);
      if (c?.cat === "creature") { subject = c.kind; break; }
    }
  }
  // "plush chicken", "chicken figurine": a decoration of the creature
  if (hit?.cat === "creature" && tokens.some((t) => FIGURE_WORDS.has(t))) {
    mods.push("figure");
    subject = hit.kind;
    category = "decoration";
    kind = "statue";
  }
  // cooked creatures are food
  if (hit?.cat === "creature" && category === "creature" && tokens.some((t) => COOKED.has(t))) {
    mods.push("cooked");
    subject = hit.kind;
    category = "food";
    kind = SPECIES[hit.kind]?.plan === "fish" ? "cooked_fish" : "drumstick";
  }
  // colours (skip words that are the thing itself: "an orange", "ice cream")
  const colors: string[] = [];
  const colorWords: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (used.has(i) && !(category === "material" || category === "block")) continue;
    const t = tokens[i];
    if (t === "rainbow") {
      colors.push("#e03a3a", "#f2d03a", "#3a7ae0");
      colorWords.push("rainbow");
      continue;
    }
    const hex = THING_COLOR_WORDS[t];
    if (!hex) continue;
    const prev = tokens[i - 1] ?? "";
    colors.push(DARKER.has(prev) ? shadeColor(hex, -0.35) : LIGHTER.has(prev) ? shadeColor(hex, 0.35) : hex);
    colorWords.push(t);
  }
  const rest = tokens.filter((_, i) => !used.has(i) || category === "creature").join(" ");
  const effect = EFFECT_RULES.find(([, re]) => re.test(rest))?.[0] ?? "none";
  let rarity: ThingRarity = RARITY_RULES.find(([, re]) => re.test(tokens.join(" ")))?.[0] ?? "common";
  if (effect !== "none" && rarity === "common") rarity = "uncommon";
  if (/\b(plush|plushie|teddy|toy|doll|stuffed)\b/.test(tokens.join(" "))) mods.push("plush");
  if (!hit && /\bblock\b/.test(tokens.join(" "))) { category = "block"; kind = "block"; }
  noun = noun || "thing";
  return { category, kind, noun, subject, subjectNoun, colors: [...new Set(colors)].slice(0, 3), colorWords, effect, rarity, mods };
}

// ================================================================ stats, recipes, text

const RARITY_MULT = [1, 1.2, 1.45, 1.75, 2.1];
const WEAPON_BASE: Record<string, [number, number]> = {
  sword: [7, 1.6], dagger: [4, 2.5], spear: [7, 1.1], trident: [8, 1.1], mace: [9, 0.9], club: [6, 1.2], warhammer: [10, 0.8],
  battleaxe: [9, 0.9], scythe: [8, 1], bow: [6, 1], staff: [5, 1.2], wand: [4, 1.8], shield: [2, 1], whip: [4, 2],
};
const TOOL_BASE: Record<string, [number, number, number]> = {
  pickaxe: [6, 3, 1.2], axe: [5, 6, 0.9], shovel: [5, 2.5, 1], hoe: [2, 1, 1.5], hammer: [4, 4, 1], rod: [0, 1, 1], torch: [0, 1, 1.5], key: [0, 1, 1],
};
const FOOD_BASE: Record<string, [number, number, number]> = {
  fruit: [4, 2.4, 64], melon: [6, 3.6, 16], loaf: [5, 6, 64], cake: [14, 2.8, 1], pie: [8, 4.8, 16], donut: [4, 2, 64], drumstick: [6, 7.2, 64],
  steak: [8, 12.8, 64], egg: [2, 1, 16], bowl: [6, 7.2, 1], bottle: [3, 2, 16], mug: [2, 1, 16], carrot: [3, 3.6, 64], cheese: [4, 3, 64],
  mushroom: [2, 1, 64], sandwich: [8, 9, 16], icecream: [4, 2, 16], cooked_fish: [5, 6, 64],
};
const ARMOR_BASE: Record<ThingSlot, number> = { head: 2, chest: 6, legs: 5, feet: 2, back: 1 };
const LIGHTS: Record<string, number> = { lantern: 15, streetlamp: 15, campfire: 15, candle: 12, torch: 14, orb: 0 };
const MATERIAL_FACTOR: [RegExp, number][] = [[/\b(wood|wooden|oak)\b/, 0.25], [/\b(gold|golden)\b/, 0.3], [/\b(stone)\b/, 0.55], [/\b(diamond)\b/, 3], [/\b(obsidian|netherite|adamant\w*|mithril)\b/, 4]];

const SLOT_OF: Record<string, ThingSlot> = {
  hat: "head", wizardhat: "head", helmet: "head", crown: "head", mask: "head", chest: "chest", gloves: "chest", amulet: "chest",
  legs: "legs", boots: "feet", cape: "back", backpack: "back", wings: "back",
};

function statsFor(cat: ThingCategory, kind: string, ri: number, effect: ThingEffect, prompt: string, species?: Species): ThingStats {
  const mult = RARITY_MULT[ri];
  const mat = MATERIAL_FACTOR.find(([re]) => re.test(prompt))?.[1] ?? 1;
  const s: Partial<ThingStats> = {};
  if (cat === "weapon") {
    const [d, a] = WEAPON_BASE[kind] ?? WEAPON_BASE.sword;
    s.damage = d * mult;
    s.attackSpeed = a;
    s.durability = 250 * (1 + ri) * mat;
    if (kind === "shield") s.armor = Math.round(4 * mult);
  } else if (cat === "tool") {
    const [mine, d, a] = TOOL_BASE[kind] ?? TOOL_BASE.hammer;
    s.miningSpeed = mine * mult * Math.max(0.6, Math.min(2, mat));
    s.damage = d;
    s.attackSpeed = a;
    s.durability = kind === "torch" ? 0 : 250 * (1 + ri) * mat;
    if (kind === "torch") s.light = 14;
  } else if (cat === "food") {
    const [food, sat, stack] = FOOD_BASE[kind] ?? FOOD_BASE.fruit;
    s.food = food;
    s.saturation = sat * (1 + ri * 0.3);
    s.stackSize = stack;
  } else if (cat === "wearable") {
    const slot = SLOT_OF[kind] ?? "head";
    const soft = kind === "hat" || kind === "wizardhat" || kind === "crown" || kind === "mask" || kind === "amulet" || kind === "cape";
    s.armor = Math.round((soft ? 1 : ARMOR_BASE[slot]) * mult);
    s.durability = 200 * (1 + ri) * mat;
  } else if (cat === "decoration") {
    s.light = LIGHTS[kind] ?? 0;
    s.stackSize = kind === "rug" ? 64 : 16;
  } else if (cat === "creature" && species && species.behaviour === "hostile") {
    s.damage = Math.max(1, Math.round(2 + species.size * 2));
  }
  if (effect === "glow") s.light = Math.max(s.light ?? 0, 10);
  return clampThingStats(s, cat);
}

const MAT_ITEMS: [RegExp, string][] = [
  [/\b(iron|steel)\b/, "iron_ingot"], [/\b(gold|golden)\b/, "gold_ingot"], [/\bdiamond\b/, "diamond"], [/\bemerald\b/, "emerald"],
  [/\bruby\b/, "ruby"], [/\bsapphire\b/, "sapphire"], [/\bamethyst\b/, "amethyst_shard"], [/\bobsidian\b/, "obsidian"],
  [/\b(wood|wooden|oak)\b/, "oak_planks"], [/\bstone\b/, "cobblestone"], [/\bcopper\b/, "copper_ingot"], [/\bbronze\b/, "bronze_ingot"],
  [/\bcrystal\b/, "crystal_shard"], [/\bbone\b/, "bone"], [/\bice\b/, "ice"], [/\bglass\b/, "glass"], [/\bwool\b/, "wool"], [/\bleather\b/, "leather"],
];
const RECIPES: Record<string, [string, string, string, Record<string, string>]> = {
  sword: [" X ", " X ", " S ", {}], dagger: ["   ", " X ", " S ", {}], spear: ["  X", " S ", "S  ", {}], trident: ["XXX", " S ", " S ", {}],
  mace: [" XX", " XX", "S  ", {}], club: [" X ", " X ", " S ", { X: "oak_log" }], warhammer: ["XXX", "XSX", " S ", {}], battleaxe: ["XXX", "XSX", " S ", {}],
  scythe: ["XX ", " SX", " S ", {}], bow: [" XT", "X T", " XT", { X: "stick", T: "string" }], staff: ["  G", " S ", "S  ", { G: "amethyst_shard" }],
  wand: ["  G", " S ", "   ", { G: "diamond" }], shield: ["XPX", "XXX", " X ", { P: "oak_planks" }], whip: ["  T", " T ", "S  ", { T: "leather" }],
  pickaxe: ["XXX", " S ", " S ", {}], axe: ["XX ", "XS ", " S ", {}], shovel: [" X ", " S ", " S ", {}], hoe: ["XX ", " S ", " S ", {}],
  hammer: ["XXX", "XSX", " S ", {}], rod: ["  S", " ST", "S T", { T: "string" }], torch: ["   ", " C ", " S ", { C: "coal" }], key: [" X ", " X ", " X ", { X: "gold_ingot" }],
  loaf: ["   ", "WWW", "   ", { W: "wheat" }], cake: ["MMM", "SES", "WWW", { M: "milk_bucket", S: "sugar", E: "egg", W: "wheat" }],
  pie: ["   ", "FSE", "   ", { F: "pumpkin", S: "sugar", E: "egg" }], sandwich: [" B ", " M ", " B ", { B: "bread", M: "cooked_beef" }],
  helmet: ["XXX", "X X", "   ", {}], chest: ["X X", "XXX", "XXX", {}], legs: ["XXX", "X X", "X X", {}], boots: ["   ", "X X", "X X", {}],
  hat: ["   ", " W ", "WWW", { W: "wool" }], wizardhat: [" W ", " W ", "WWW", { W: "purple_wool" }], crown: ["   ", "XGX", "XXX", { X: "gold_ingot", G: "ruby" }],
  cape: ["WW ", "WW ", "WW ", { W: "wool" }], backpack: ["LTL", "L L", "LLL", { L: "leather", T: "string" }], gloves: ["   ", "L L", "L L", { L: "leather" }],
  crate: ["PPP", "P P", "PPP", { P: "oak_planks" }], treasure: ["PPP", "PIP", "PPP", { P: "oak_planks", I: "iron_ingot" }],
  barrel: ["PSP", "P P", "PSP", { P: "oak_planks", S: "oak_slab" }], lantern: ["NNN", "NTN", "NNN", { N: "iron_nugget", T: "torch" }],
  streetlamp: [" L ", " I ", " I ", { L: "lantern", I: "iron_ingot" }], candle: [" T ", " H ", "   ", { T: "string", H: "honeycomb" }],
  campfire: [" S ", "SCS", "LLL", { S: "stick", C: "coal", L: "oak_log" }], table: ["PPP", "S S", "S S", { P: "oak_planks", S: "stick" }],
  chair: ["P  ", "PPP", "S S", { P: "oak_planks", S: "stick" }], bed: ["   ", "WWW", "PPP", { W: "wool", P: "oak_planks" }],
  shelf: ["PPP", "BBB", "PPP", { P: "oak_planks", B: "book" }], flower: ["   ", "BFB", " B ", { B: "brick", F: "flower" }],
  painting: ["SSS", "SWS", "SSS", { S: "stick", W: "wool" }], banner: ["WWW", "WWW", " S ", { W: "wool", S: "stick" }],
  sign: ["PPP", "PPP", " S ", { P: "oak_planks", S: "stick" }], vase: ["   ", "C C", " C ", { C: "clay_ball" }], trophy: ["G G", " G ", "GGG", { G: "gold_ingot" }],
  rug: ["   ", "   ", "WWW", { W: "wool" }], clock: [" G ", "GRG", " G ", { G: "gold_ingot", R: "redstone" }], bell: [" S ", "GGG", "G G", { S: "stick", G: "gold_ingot" }],
  house: [" P ", "PPP", "PDP", { P: "oak_planks", D: "door" }], orb: ["   ", " G ", "PPP", { G: "glass", P: "oak_planks" }],
};

function recipeFor(cat: ThingCategory, kind: string, prompt: string, a: ThingAnalysis): ThingRecipe | null {
  const matHit = MAT_ITEMS.find(([re]) => re.test(prompt))?.[1];
  if (cat === "block") {
    const item = matHit ?? (a.subjectNoun ?? a.subject ?? a.colorWords[0] ?? a.noun).replace(/\s+/g, "_");
    return { shape: ["XXX", "XXX", "XXX"], key: { X: item } };
  }
  const r = RECIPES[kind];
  if (!r) return null;
  const [r0, r1, r2, keys] = r;
  const def = cat === "decoration" ? "oak_planks" : cat === "wearable" ? "leather" : "iron_ingot";
  const key: Record<string, string> = { S: "stick", ...keys };
  const shape = [r0, r1, r2];
  for (const c of new Set(shape.join("").replace(/ /g, ""))) if (!key[c]) key[c] = c === "X" ? (matHit ?? def) : "stick";
  if (keys.X === undefined && matHit) key.X = matHit;
  for (const c of Object.keys(key)) if (!shape.join("").includes(c)) delete key[c];
  return { shape, key };
}

const titleCase = (s: string) => s.replace(/\b[a-z]+/g, (w) => (w === "of" || w === "and" ? w : w[0].toUpperCase() + w.slice(1)));

function nameFor(prompt: string, a: ThingAnalysis): string {
  const words = tokenize(prompt).filter((t) => !STOP.has(t) || t === "of");
  while (words[0] === "of") words.shift();
  while (words[words.length - 1] === "of") words.pop();
  let n = words.slice(0, 6).join(" ");
  if (!n) n = a.noun;
  if (a.mods.includes("cooked") && !/\b(roast|roasted|fried|cooked|grilled|baked|smoked)\b/.test(n)) n = `roast ${n}`;
  return titleCase(cleanText(n, 40) || a.noun || "Thing");
}

const BEHAVIOUR_TEXT: Record<ThingBehaviour, string> = {
  passive: "wanders about peacefully", pet: "follows its favourite people around", hostile: "attacks anyone who comes too close",
  neutral: "keeps to itself unless provoked", flying: "flutters through the sky", swimming: "glides through the water", guard: "stands guard over its home",
};
const EFFECT_TEXT: Record<ThingEffect, string> = {
  none: "", chain_lightning: "calls down chain lightning", fire_trail: "leaves a trail of fire", vein_mine: "breaks whole ore veins at once",
  knockback_burst: "knocks foes back with a burst", heal_aura: "heals everyone nearby", frost_slow: "slows targets with frost", glow: "glows softly",
  speed: "makes you faster", jump: "makes you jump higher", night_vision: "lets you see in the dark", explode_on_hit: "explodes on impact",
};
const FLAVORS: Record<ThingCategory, string[]> = {
  weapon: ["Heavier than it looks. Sharper than it should be.", "The smith swore it hummed when finished.", "It remembers every hand that held it."],
  tool: ["Honest work, honestly made.", "The handle is worn smooth already.", "A good tool makes its own luck."],
  food: ["Smells better than anything has a right to.", "Best eaten warm. Or now.", "Grandma's recipe, more or less."],
  creature: ["It regards you with great seriousness.", "Nobody knows where it sleeps.", "It seems to like you. Probably."],
  wearable: ["Fits like it was made for you. It was.", "Fashionable in at least three villages.", "Surprisingly comfortable."],
  decoration: ["It really ties the room together.", "Guests always ask about it.", "Made with more love than skill."],
  material: ["The crafters will want this.", "Raw, but full of promise.", "Worth more than it looks."],
  block: ["Solid. Dependable. Square.", "Stack it, place it, build a dream.", "A fine block for a fine wall."],
  vehicle: ["Hop on. Hold tight.", "Goes faster than it has any right to.", "The village kids want a ride."],
};

function describe(cat: ThingCategory, name: string, a: ThingAnalysis, stats: ThingStats, creature: ThingCreature | null, slot: ThingSlot | null): string {
  const n = name.toLowerCase();
  const eff = EFFECT_TEXT[a.effect];
  switch (cat) {
    case "creature":
      return `A ${n} that ${BEHAVIOUR_TEXT[creature?.behaviour ?? "passive"]}${creature?.lays ? ` and lays ${creature.lays.replace(/_/g, " ")}s` : ""}.`;
    case "food":
      return `A tasty ${n} that restores ${stats.food} hunger${eff ? ` and ${eff}` : ""}.`;
    case "weapon":
      return `A ${a.rarity} ${n} that deals ${stats.damage} damage${eff ? ` and ${eff}` : ""}.`;
    case "tool":
      return `A ${n} for ${a.kind === "pickaxe" ? "mining stone and ore" : a.kind === "axe" ? "chopping wood" : a.kind === "shovel" ? "digging" : a.kind === "hoe" ? "tilling soil" : a.kind === "rod" ? "fishing" : a.kind === "torch" ? "lighting the way" : "all sorts of jobs"}${eff ? `; it ${eff}` : ""}.`;
    case "wearable":
      return `A ${n} worn on the ${slot ?? "head"}${stats.armor ? ` that gives ${stats.armor} armour` : ""}${eff ? `${stats.armor ? " and" : " that"} ${eff}` : ""}.`;
    case "decoration":
      return `A decorative ${n}${stats.light ? " that lights up the room" : eff ? ` that ${eff}` : " to brighten up any home"}.`;
    case "material":
      return `A crafting material: ${n}.`;
    case "block":
      return `A placeable block of ${(a.subjectNoun ?? a.subject ?? a.colorWords[0] ?? a.noun).replace(/_/g, " ")}.`;
    case "vehicle":
      return `A rideable ${n}${eff ? ` that ${eff}` : ""}: right-click to hop on.`;
  }
}

// ================================================================ assembly

/** Colours a template uses by default for some nouns (fruit kinds, flowers, potions, metals ...). */
const NOUN_COLORS: Record<string, string> = {
  apple: "#d93b2b", orange: "#f08a24", peach: "#f8b088", tomato: "#e0301e", plum: "#7a3a8a", lemon: "#f2e03a", berry: "#4a3ab0", blueberry: "#3a4ab0",
  strawberry: "#e0303a", cherry: "#b0172f", grape: "#7a3a9a", pear: "#b8d04a", coconut: "#6b4a2b", onion: "#e8d0b0", potato: "#c8a060", turnip: "#e8e0f0",
  beet: "#8a1a3a", beetroot: "#8a1a3a", radish: "#d93b5a", nut: "#a0703a", acorn: "#a0703a", meatball: "#7a3a1e", candy: "#f29ab8", sweet: "#f29ab8",
  pumpkin: "#e08a1e", watermelon: "#3a8a3a", melon: "#b8d04a", cabbage: "#9be04a", lettuce: "#9be04a", squash: "#f2c230",
  corn: "#f2d03a", banana: "#f2e03a", cucumber: "#4a9a3a", sausage: "#9a4a2a", hotdog: "#c86a3a", eggplant: "#5a2a6a", aubergine: "#5a2a6a", pickle: "#6a9a3a", popsicle: "#3ad6e0",
  milk: "#f8f8f8", water: "#7ac0f0", juice: "#f08a24", wine: "#7a1f3a", beer: "#e0a030", soda: "#6b3a1e", lemonade: "#f2e870", smoothie: "#f29ab8",
  rose: "#d0213a", tulip: "#f29ab8", daisy: "#f4f4f0", sunflower: "#f2c230", lily: "#f8f0f8", orchid: "#d090e0", lotus: "#f8b0d0", poppy: "#e0301e", dandelion: "#f2d03a",
  cheese: "#f2d03a", bread: "#e0b060", honey: "#f0a820", chocolate: "#5a3420", butter: "#f8e080", ice: "#bfefff", snow: "#f8f8ff", dirt: "#8a5a35",
  grass: "#5fa83a", mud: "#6a4a2a", slime: "#6ad06a", jelly: "#e05a8a", meat: "#b0402a", gold: GOLD, iron: IRON, cake: "#f3e5c0",
  pizza: "#f2b030", cookie: "#c8904a", pancake: "#e8b860", waffle: "#e0a850", pie: "#b0172f", omelette: "#f2d860",
  diamond: "#6ee0e0", ruby: "#d0213a", emerald: "#2fbf71", sapphire: "#2a4fd0", amethyst: "#9a5ad8", topaz: "#f0b030", opal: "#e0f0f8", jade: "#4ab070",
  onyx: "#26262c", garnet: "#8a1a2a", quartz: "#f4f0f8", coin: GOLD, coal: "#2a2a30", clay: "#a8b0c0", honeycomb: "#f0a820", amber: "#f0a020",
  sand: "#e3d49a", salt: "#f8f8f8", sugar: "#f8f8f8", ash: "#6a6a6a", flour: "#f4f0e8", glitter: "#f0c0f0", wheat: "#e0c060", seeds: "#a0b050",
  leather: "#a0603a", wool: "#f0efe8", silk: "#f8f0f8", paper: "#f4f0e0", fur: "#8a6a4a", cotton: "#f8f8f8",
  pine: "#2a6a3a", palm: "#4caf50", birch: "#6ab04a", "christmas tree": "#2a6a3a",
};

/** How each vehicle template rides. */
const VEHICLE_OF: Record<string, ThingVehicle> = {
  train: { mode: "rail", speed: 14, seats: 2 },
  car: { mode: "ground", speed: 16, seats: 2 },
  boat: { mode: "water", speed: 9, seats: 2 },
  cart: { mode: "ground", speed: 7, seats: 1 },
  plane: { mode: "air", speed: 20, seats: 1 },
  rocket: { mode: "air", speed: 26, seats: 1 },
};

const DEFAULT_FALLBACK_KIND: Record<ThingCategory, string> = {
  weapon: "sword", tool: "pickaxe", food: "fruit", creature: "monster", wearable: "hat", decoration: "curio", material: "gem", block: "block", vehicle: "cart",
};

/** Shift a built model up and put a pedestal under it (statues). */
function onPedestal(model: VoxelModel, maxSize: number, base: string): VoxelModel {
  const [w, h, l] = model.size;
  const lift = maxSize >= 6 ? 1 : 0;
  const size: VoxelVec = [w, Math.min(maxSize, h + lift), l];
  const ops: VoxelOp[] = [...(lift ? [{ op: "box", from: [0, 0, 0], to: [w - 1, 0, l - 1], block: "base" } as VoxelOp] : []), ...shiftVoxelOps(model.ops, [0, lift, 0])];
  return { size, palette: { ...model.palette, base }, ops, ...(model.pivot ? { pivot: [model.pivot[0], 0, model.pivot[2]] as VoxelVec } : {}) };
}

function recolor(m: ModelBuilder, colors: string[]): void {
  if (colors[0] && m.palette[m.main] !== undefined) m.palette[m.main] = colors[0];
  if (colors[1] && m.accent !== m.main && m.palette[m.accent] !== undefined) m.palette[m.accent] = colors[1];
}

export interface RulesThingParams {
  prompt: string;
  categories?: readonly ThingCategory[];
  maxModelSize?: number;
}

/**
 * The keyless forge.thing answer: keyword category + template model + stats / creature / wearable / recipe. Always
 * returns a valid ForgedThing (the model has at least 8 voxels).
 */
export function rulesForgedThing(params: RulesThingParams): ForgedThing {
  const prompt = String(params.prompt ?? "").slice(0, 400);
  const maxSize = Math.max(4, Math.min(VOXEL_MODEL_LIMITS.maxSize, Math.round(params.maxModelSize ?? VOXEL_MODEL_LIMITS.defaultSize)));
  const allowed = params.categories?.length ? params.categories : THING_CATEGORIES;
  const a = analyzeThing(prompt);
  let category = a.category;
  let kind = a.kind;
  // not allowed here: a creature becomes a figurine, anything else the first allowed category's default
  if (!allowed.includes(category)) {
    if (category === "creature" && allowed.includes("decoration")) {
      a.subject = a.kind;
      kind = "statue";
      category = "decoration";
    } else {
      category = allowed[0];
      kind = DEFAULT_FALLBACK_KIND[category];
      if (category === "decoration" && a.subject) kind = "statue";
    }
  }
  const ri = THING_RARITIES.indexOf(a.rarity);
  const lower = prompt.toLowerCase();
  const sn = a.subjectNoun ?? "";
  const nounColor = NOUN_COLORS[a.noun] ?? NOUN_COLORS[singular(a.noun)] ?? NOUN_COLORS[sn] ?? NOUN_COLORS[singular(sn)];
  const colors = a.colors.length ? a.colors : nounColor ? [nounColor] : [];

  let model: VoxelModel;
  let parts: ThingPart[] = [];
  const species = category === "creature" ? SPECIES[kind] ?? SPECIES.monster : undefined;
  if (species) {
    const b = creatureModel(species, maxSize);
    recolor(b, a.colors);
    model = b.model();
    parts = b.parts;
  } else if (kind === "statue" && a.subject && SPECIES[a.subject]) {
    const s = SPECIES[a.subject];
    const plush = a.mods.includes("plush");
    const stone = colors[0] ?? (plush ? undefined : "#c8c8cc");
    const b = creatureModel(s, Math.max(4, maxSize - (plush ? 0 : 1)), plush ? undefined : [stone!, shadeColor(stone!, -0.15), shadeColor(stone!, -0.3)]);
    if (plush) recolor(b, a.colors);
    else for (const k of Object.keys(b.palette)) b.palette[k] = k === "eye" ? shadeColor(stone!, -0.45) : shadeColor(stone!, k === b.main ? 0 : -0.12);
    model = plush ? b.model() : onPedestal(b.model(), maxSize, shadeColor(stone!, -0.3));
  } else if (kind === "cooked_fish" || (category === "food" && a.subject && SPECIES[a.subject]?.plan === "fish")) {
    const b = fishModel(SPECIES.fish, maxSize, ["#c87a3a", "#e8b070", "#2a2a2a"]);
    model = b.model();
    kind = "cooked_fish";
  } else {
    const t = TEMPLATES[kind] ?? TEMPLATES[DEFAULT_FALLBACK_KIND[category]] ?? TEMPLATES.curio;
    const b = new ModelBuilder(t.size, maxSize);
    t.build(b);
    if (kind === "block" && a.subject && SPECIES[a.subject]) b.palette.main = SPECIES[a.subject].colors[0];
    recolor(b, colors);
    if (kind === "bottle" && !a.colors.length) {
      const potion: Partial<Record<ThingEffect, string>> = { heal_aura: "#e0306a", speed: "#3ad6e0", jump: "#9be04a", night_vision: "#2a4fd0", fire_trail: "#ff6a1a", frost_slow: "#bfefff", glow: "#ffe27a", explode_on_hit: "#5a5a5a" };
      if (potion[a.effect]) b.palette.main = potion[a.effect]!;
    }
    if (a.effect === "glow" && b.palette.glow === undefined && category !== "food") b.palette[b.accent] = GLOW;
    model = b.model();
  }
  model = clampVoxelModel(model, { maxSize });
  if (expandVoxelModel(model).voxels.length < VOXEL_MODEL_LIMITS.minVoxels) {
    const n = Math.max(2, Math.min(maxSize, 4));
    model = { size: [n, n, n], palette: { main: colors[0] ?? "#9a5ad8" }, ops: [{ op: "box", from: [0, 0, 0], to: [n - 1, n - 1, n - 1], block: "main" }] };
  }

  const name = nameFor(prompt, a);
  const stats = statsFor(category, kind, ri, a.effect, lower, species);
  let creature: ThingCreature | null = null;
  if (category === "creature" && species) {
    creature = {
      behaviour: species.behaviour,
      health: Math.max(1, Math.min(1000, Math.round(species.health * (1 + ri * 0.25)))),
      speed: species.speed,
      size: species.size,
      ...(parts.length ? { parts: parts.slice(0, VOXEL_MODEL_LIMITS.maxParts) } : {}),
      sounds: species.sounds.slice(0, 6),
      drops: species.drops.slice(0, 6),
      ...(species.lays ? { lays: species.lays } : {}),
      ...(species.tame ? { tameWith: species.tame } : {}),
    };
  }
  const slot: ThingSlot | null = category === "wearable" ? SLOT_OF[kind] ?? "head" : null;
  const vehicle: ThingVehicle | null = category === "vehicle" ? VEHICLE_OF[kind] ?? { mode: "ground", speed: 10, seats: 1 } : null;
  const tags = [...new Set([category, kind.replace(/_/g, "-"), ...(a.effect !== "none" ? [a.effect] : []), ...a.colorWords, ...(creature ? [creature.behaviour] : []), ...a.mods])].slice(0, 12);
  const flavors = FLAVORS[category];
  const h = hashString(prompt.toLowerCase());
  const flavor = creature?.sounds.length ? `"${titleCase(creature.sounds[h % creature.sounds.length])}" it says, with great conviction.` : flavors[h % flavors.length];
  return {
    id: thingId(name, prompt),
    name,
    description: describe(category, name, a, stats, creature, slot).slice(0, 240),
    flavor: flavor.slice(0, 240),
    rarity: a.rarity,
    category,
    model,
    stats,
    effect: a.effect,
    creature,
    wearable: slot ? { slot } : null,
    vehicle,
    recipe: category === "creature" || category === "material" ? null : recipeFor(category, kind, lower, a),
    tags,
  };
}

/** Normalised prompt for caching ("A Chicken!" -> "chicken"). */
export function normalizeThingPrompt(prompt: string): string {
  return tokenize(prompt).filter((t) => !["a", "an", "the", "some", "please", "me", "my"].includes(t)).join(" ");
}

/** Every template kind and creature key the rules know (docs / dashboards). */
export const THING_TEMPLATE_KINDS: readonly string[] = Object.keys(TEMPLATES);
export const THING_CREATURE_KINDS: readonly string[] = Object.keys(SPECIES);
