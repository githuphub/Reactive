// @liveforge/three - three.js helpers for Liveforge: Blueprint / VFX / Variant builders, speech (TTS + mic),
// and drop-in LiveNPC / LiveBoss / LiveEquipSlot / LiveSpawner that wire signals, asks and directives.
export { buildBlueprint, partGeometry, makePartMaterial, BlueprintObject } from "./blueprint.js";
export type { BuildBlueprintOptions, BlueprintFx, Detail } from "./blueprint.js";
export { buildVfx, VfxObject } from "./vfx.js";
export type { BuildVfxOptions } from "./vfx.js";
export { applyVariant, findNode } from "./variant.js";
export type { ApplyVariantOptions, VariantHandle } from "./variant.js";
export { disposeObject } from "./dispose.js";
export { speak, stopSpeaking, speechSupported, pickVoice, accentToLang } from "./tts.js";
export type { SpeakOptions } from "./tts.js";
export { Mic, micSupport } from "./mic.js";
export type { MicOptions, MicMode } from "./mic.js";
export { LiveNPC } from "./npc.js";
export type { LiveNPCOptions, NpcLine } from "./npc.js";
export { LiveBoss } from "./boss.js";
export type { LiveBossOptions, MoveHandler, RotationEntry } from "./boss.js";
export { LiveEquipSlot } from "./equip.js";
export type { LiveEquipSlotOptions } from "./equip.js";
export { LiveSpawner } from "./spawner.js";
export type { LiveSpawnerOptions, SpawnRequest, SpawnUnit, SpawnWaveArgs } from "./spawner.js";
