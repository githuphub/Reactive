// Build step: write JSON Schemas (draft 2020-12) for every wire type to packages/protocol/schema/v1/.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as P from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "schema", "v1");
mkdirSync(outDir, { recursive: true });

const top: Record<string, z.ZodType> = {
  Signal: P.Signal, SignalBatch: P.SignalBatch, SignalBatchResult: P.SignalBatchResult,
  AskRequest: P.AskRequest, AskResponse: P.AskResponse, Directive: P.Directive,
  Blueprint: P.Blueprint, VfxRecipe: P.VfxRecipe, Variant: P.Variant, MoveSpec: P.MoveSpec, EngineMoveRef: P.EngineMoveRef,
  ForgedItem: P.ForgedItem, Quest: P.Quest, Achievement: P.Achievement, Rumour: P.Rumour, Moment: P.Moment,
  NpcAction: P.NpcAction, VoiceStyle: P.VoiceStyle, Creature: P.Creature, Prop: P.Prop,
  StoredEvent: P.StoredEvent, ErrorBody: P.ErrorBody, SttResponse: P.SttResponse, ForgeJob: P.ForgeJob,
  Snapshot: P.Snapshot, PublicConfig: P.PublicConfig, BakePack: P.BakePack,
  WsClientMessage: P.WsClientMessage, WsServerMessage: P.WsServerMessage,
  ReactionInfo: P.ReactionInfo, ReactionDirectiveArgs: P.ReactionDirectiveArgs,
  FactionMind: P.FactionMind, FactionPostureArgs: P.FactionPostureArgs, GuardPostsArgs: P.GuardPostsArgs,
};
for (const [name, s] of Object.entries(P.PROJECTIONS)) top[`Projection_${name}`] = s.schema;

const index: Record<string, string> = {};
const write = (name: string, schema: z.ZodType) => {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any", io: "input" }) as Record<string, unknown>;
  json.$id = `https://liveforge.dev/schema/v1/${name}.json`;
  json.title = name;
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(json, null, 2) + "\n");
  index[name] = `${name}.json`;
};
for (const [name, s] of Object.entries(top)) write(name, s);
for (const [kind, k] of Object.entries(P.ASKS)) {
  write(`ask.${kind}.params`, k.params);
  write(`ask.${kind}.result`, k.result);
}
for (const [kind, s] of Object.entries(P.DIRECTIVE_ARGS)) write(`directive.${kind}.args`, s);

writeFileSync(
  join(outDir, "index.json"),
  JSON.stringify({
    protocol: P.PROTOCOL_ID,
    version: P.PROTOCOL_PACKAGE_VERSION,
    builtinSignals: P.BUILTIN_SIGNALS,
    askKinds: P.ASK_KINDS,
    directiveKinds: P.DIRECTIVE_KINDS,
    npcActions: P.BUILTIN_NPC_ACTIONS,
    moments: P.BUILTIN_MOMENTS,
    dslFunctions: P.DSL_FUNCTIONS,
    reactionRecipes: P.REACTION_RECIPES,
    commonRecipeParams: P.COMMON_RECIPE_PARAMS,
    weathers: P.WEATHERS,
    schemas: index,
  }, null, 2) + "\n",
);
console.log(`[protocol] wrote ${Object.keys(index).length} JSON Schemas to ${outDir}`);
