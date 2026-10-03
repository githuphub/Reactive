// @liveforge/three - three.js helpers (K0 skeleton; K4 owns and implements). Signatures are the contract.
import type * as THREE from "three";
import type { Blueprint, VfxRecipe, Variant } from "@liveforge/protocol";
import type { LiveforgeClient } from "@liveforge/sdk";

export interface BuiltBlueprint {
  object: THREE.Group;
  /** Named attachment points (grip, tip, sockets ...) as child Object3Ds. */
  attachments: Record<string, THREE.Object3D>;
  /** Advance part animations / particles (seconds). */
  update(dt: number): void;
  dispose(): void;
}

export interface BuiltVfx {
  object: THREE.Object3D;
  update(dt: number): void;
  /** true once a non-looping recipe has finished. */
  readonly done: boolean;
  dispose(): void;
}

const todo = (name: string): never => {
  throw new Error(`@liveforge/three: ${name} is not implemented yet (K4)`);
};

/** Build a Blueprint v1 (protocol SHAPE_NOTES conventions: metres, +Y up, grip at origin). */
export function buildBlueprint(_bp: Blueprint, _opts: { three: typeof THREE }): BuiltBlueprint {
  return todo("buildBlueprint");
}

/** Build a VFX recipe v1. */
export function buildVfx(_recipe: VfxRecipe, _opts: { three: typeof THREE }): BuiltVfx {
  return todo("buildVfx");
}

/** Apply a Variant to a loaded developer asset. */
export function applyVariant(_root: THREE.Object3D, _variant: Variant, _opts: { three: typeof THREE }): void {
  todo("applyVariant");
}

/** Browser speechSynthesis wrapper honouring VoiceStyle. */
export function speak(_text: string, _voice?: { pitch?: number; rate?: number; accent?: string }): void {
  todo("speak");
}

/** Push-to-talk: record mic audio and POST it to /v1/stt. */
export function createMic(_client: LiveforgeClient): { start(): Promise<void>; stop(): Promise<string> } {
  return todo("createMic");
}
