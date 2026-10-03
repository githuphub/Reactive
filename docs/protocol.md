# Protocol: `liveforge-protocol/1`

Every SDK speaks the same small HTTP + WebSocket protocol. If your engine has no SDK yet (Unity, Unreal, a custom
engine), you need only three things:

1. `POST /v1/signals` to report what happens.
2. `POST /v1/ask/:kind` to get an instant answer.
3. A WebSocket to `/v1/ws` for directives and AI upgrades. You can long-poll `GET /v1/upgrades/:id` instead.

**Where the types live:**

- **JSON Schemas** for every type: `packages/protocol/schema/v1/*.json`. `index.json` lists them, plus the
  signal, ask and directive vocabularies.
- **Source of truth:** the TypeScript and zod definitions in `packages/protocol/src`.

**Every response:**

- carries the header `x-liveforge-protocol: liveforge-protocol/1`;
- on error, uses the body `{"error": {"code", "message", "details?"}}`.

## Auth

| Key | Where | Used for |
|---|---|---|
| Publishable game key (`pk_…`) | game clients | `/v1/*`. Scoped to one game and rate-limited per key. |
| Admin key | dashboard / tools only | `/admin/*` and the admin WebSocket firehose. Never ship it in a game. |

- **Sending a key:** `Authorization: Bearer <key>` or the `x-liveforge-key: <key>` header. The WebSocket takes
  `?key=` instead.
- **Dev mode keys** (no keys configured): `pk_dev_<gameId>` and `dev-admin`.
- **Admin requests with several games:** add `x-liveforge-game: <id>` (or `?game=`) to pick the game.

## Signals

```http
POST /v1/signals
Authorization: Bearer pk_dev_counterforge
Content-Type: application/json

{ "signals": [
  { "type": "combat.dodged", "data": { "source": "forge_titan", "direction": "left" },
    "ts": 1791043200000, "player": "p1", "world": "w1", "session": "s1" }
] }
```

→ `{ "accepted": 1, "rejected": [], "lastSeq": 4812 }`

| Field | |
|---|---|
| `type` | Dotted lowercase. Built-in (below) or declared under the manifest's `signals`. |
| `data` | Free object. Built-ins document their fields. |
| `ts` | Client time (ms since epoch). The server stamps its own receive time too. |
| `player`, `world` | Ids (`[A-Za-z0-9_\-.:]`, ≤ 64). |
| `session` | Optional play-session id. |

Batches hold 1–500 signals. Rejections are per index (unknown custom type, bad shape, moderation). Accepted
signals are kept.

### Built-in signals

| Type | Data |
|---|---|
| `combat.hit` | `target, target_type?, damage, weapon?, element?, range?, crit?` |
| `combat.hurt` | `source, source_type?, damage, hp` (remaining fraction 0–1)`, attack?, element?` |
| `combat.dodged` | `source?, attack?, direction?` |
| `combat.blocked` | `source?, attack?, prevented?` |
| `combat.parried` | `source?, attack?` |
| `combat.killed` | `target, target_type, weapon?, elite?, boss?` |
| `combat.died` | `killer?, killer_type?` |
| `combat.ability_used` | `ability, target?, cost?, element?` |
| `economy.gold` | `amount` (new balance)`, delta?, currency?` |
| `economy.bought` / `economy.sold` | `item, price, vendor?` |
| `economy.stole` | `from, item?, value?, seen?` |
| `social.said` | `text, to?` |
| `social.talked_to` | `npc` |
| `social.gave` | `to, item?, gold?` |
| `social.lied` | `to, about?` |
| `social.threatened` | `target` |
| `movement.entered_zone` | `zone, kind?` |
| `movement.explored` | `zone?, discovery?` |
| `movement.fled` | `from?, hp?` |
| `gear.equipped` | `item, slot, name?, tags?, value?` |
| `gear.unequipped` | `item, slot` |
| `quest.accepted` | `quest, giver?` |
| `quest.completed` | `quest` |
| `quest.failed` | `quest, reason?` |
| `world.destroyed` | `object, zone?, owner?` |
| `world.helped` | `npc, how?` |
| `world.time` | `hour` (0–24)`, day?, phase?` (dawn / day / dusk / night) |

## Asks

```http
POST /v1/ask/npc.reply
Authorization: Bearer pk_dev_counterforge

{ "id": "a_19x", "world": "w1", "player": "p1",
  "params": { "npc": "pell", "text": "Any news from the lodge?", "stream": true } }
```

The instant answer comes back in the HTTP response:

```json
{ "id": "a_19x", "kind": "npc.reply", "stage": "instant", "source": "rules",
  "result": { "npc": "pell", "text": "News? Always, young master.", "actions": [] },
  "why": "bark pool (attitude 0.3)", "upgrade": "pending", "ms": 4, "ts": 1791043200123 }
```

When `upgrade` is `"pending"`, the AI upgrade follows with **the same id**:

- over the WebSocket as `{"t":"upgrade","response":{…,"stage":"upgrade","source":"ai"}}`. With `stream: true`,
  `chunk` messages come first.
- or by long-poll: `GET /v1/upgrades/a_19x?wait=25` returns `200` with the response, or `204` when nothing has
  arrived yet.

If the upgrade fails, you still get a final `upgrade` that echoes the instant result with a non-`ai` source.
Send `"upgrade": false` to get the instant answer only.

| Kind | Params (main fields) | Result |
|---|---|---|
| `npc.bark` | `npc, trigger` (approach / idle / combat / gear / moment / greeting …)`, context?` | `{npc, text, emote?, voice?, actions[]}` |
| `npc.reply` | `npc, text, history?, stream?, context?` | `{npc, text, emote?, voice?, actions[], mood?, end?}` |
| `director.boss_phase` | `boss, phase, hp?, habits?, gear?, existing?` | `{boss, phase, moves[{engine?, grammar?, weight}], aggression, counters[], attune?, taunt?}` |
| `director.boss_move` | `boss, phase, habits?, existing?, attune?` | `{boss, move: MoveSpec, engineMove?}` |
| `director.encounter` | `units[{id, type, elite?, modifiers?}], zone?, habits?` | `{assignments[{unit, tactic, target?}], modifiers[], aggression}` |
| `director.pacing` | `zone?, intensity?, enemiesAlive?, playerHp?, sinceLastBreatherSec?` | `{tension, action, directives[], aggression?}` |
| `forge.item` | `prompt?, family?, slot?, element?, mesh?, context?` | `{item: ForgedItem}` |
| `forge.armour_set` | `prompt, slots?, mesh?` | `{name, pieces[], setBonus?}` |
| `forge.look` | `prompt, asset, slots?` | `{variant: Variant}` |
| `forge.vfx` | `prompt, attach?, durationSec?` | `{vfx: VfxRecipe}` |
| `forge.creature` | `prompt, role?, mesh?` | `{creature}` |
| `forge.npc_look` | `npc, prompt, asset?` | `{npc, variant?, accessories[]}` |
| `forge.prop` | `prompt, mesh?` | `{prop}` |
| `forge.loot` | `count, enemy?, zone?, moment?` | `{items[]}` |
| `quest.offer` | `giver?, zone?, context?` | `{quest \| null}` |
| `achievement.check` | `recent?` | `{unlocked[]}` |
| `world.reactions` | `zone?, npcs?` | `{rumours[], directives[], attitudes{}}` |

All forge kinds accept an integer `seed` for reproducible results. The exact schemas are
`schema/v1/ask.<kind>.params.json` and `ask.<kind>.result.json`.

## WebSocket

```
GET /v1/ws?key=pk_dev_counterforge&world=w1&player=p1        (Upgrade: websocket)
```

Frames are JSON text, one message per frame, discriminated by `t`. Passing `world` (and `player`) in the query
subscribes you straight away. Otherwise, send:

```json
{ "t": "subscribe", "world": "w1", "player": "p1", "topics": ["directives", "upgrades", "chunks", "jobs"] }
```

| Server → client | |
|---|---|
| `welcome {protocol, game, connId, serverTime, admin}` | On connect. |
| `subscribed {world, player, topics}` | |
| `directive {directive}` | See below. |
| `upgrade {response}` | AI upgrade for an earlier ask. |
| `chunk {id, seq, text, done}` | Streamed sentence of an upgrade (`npc.reply` with `stream: true`). |
| `job {id, state, url?}` | Forge mesh job state (`queued → generating → done \| failed`). |
| `event {event}` | Admin only: the live event firehose (topic `events`). |
| `pong {ts?, serverTime}` / `error {error}` | |

- **Client messages:** `subscribe`, `unsubscribe {world, player?}` and `ping {ts?}`.
- **Keep-alive:** the server pings every 30 s. Reconnect with backoff and subscribe again.

## Directives

```json
{ "id": "d_8k2", "kind": "boss.move_added", "target": "boss:forge_titan",
  "args": { "boss": "forge_titan", "move": { "name": "Leftward Reckoning", "shape": "beam", "pattern": "fan",
            "element": "fire", "count": 3, "telegraph": 0.9, "speed": 1.3, "size": 1.2, "damage_budget": 16,
            "status": "burning", "bias": "left", "taunt": "You always roll left, little smith." } },
  "why": "p1 dodges left 75% of the time (24 dodges)", "ts": 1791043260000, "world": "w1", "player": "p1",
  "source": "director" }
```

`target` addresses the receiver: `npc:<id>`, `boss:<id>`, `spawner:<id>`, `player`, `world` or `ui`. A
directive with `player: null` goes to everyone in the world.

| Kind | Args |
|---|---|
| `npc.action` | `npc, action {action, args, target?}, line?` |
| `npc.bark` | `npc, text, emote?, voice?` |
| `rumour.heard` | `npc, rumourId, content, heat?` |
| `spawn.wave` | `spawner?, zone?, position?, units[{type, count, elite?, modifiers?, tactic?}]` |
| `pacing.breather` | `seconds, loot?` |
| `boss.move_added` | `boss, move: MoveSpec, engineMove?` |
| `boss.adapt` | `boss, aggression?, attune?, weights?, taunt?` |
| `quest.offer` | `quest, giver?` |
| `quest.update` | `questId, status, objectiveId?, progress?` |
| `achievement.unlocked` | `achievement` |
| `objective.dynamic` | `id, text, condition (DSL), reward, expiresInSec?` |
| `forge.ready` | `jobId, askId?, url?, item?, blueprint?, state` |
| `loot.drop` | `items[], position?, from?` |
| `difficulty.set` | `aggression, mode, reason?` |
| `moment` | `moment {id, kind, ts, evidence[], salience}` |
| `world.reaction` | `rule, effect, data?` |
| `custom.<name>` | Free args (manifest reactions). |

Only actions declared in the manifest action schema are ever emitted. Clients should still re-validate content
before using it. The protocol exports `clampBlueprint`, `clampVfx` and `clampMove` for exactly this.

## Other endpoints

| Route | |
|---|---|
| `GET /health` | No auth. `{ok, protocol, games, llm}` |
| `GET /v1/config` | `PublicConfig`: personas (+ voice), bosses, actions, custom signals, elements, modules, ask and directive kinds. |
| `POST /v1/stt?language=en` | Multipart field `audio` (WAV/WebM/OGG), or a raw `audio/*` body → `{id, text, language?, durationMs?, provider, flagged?}`. |
| `GET /v1/forge/jobs/:id` | `ForgeJob {id, provider, state, prompt, url?, error?}` |
| `GET /v1/assets/:file` | Generated GLB meshes. |
| `GET /v1/snapshot?world=` / `POST /v1/snapshot` | Export a world's event log + projections / import (replace + rebuild). |

### Admin API (dashboard)

All of these need the admin key.

| Route | |
|---|---|
| `GET /admin/games` | Games, modules, world counts. |
| `GET /admin/manifest` · `GET /admin/manifest/source` · `POST /admin/manifest/validate` · `POST /admin/manifest/reload` | Manifest (parsed / raw YAML / validate / hot reload). |
| `GET /admin/worlds` · `GET /admin/players?world=` | Tenancy. |
| `GET /admin/events?world&player&type&after&limit&desc` | Event log page `{events, next}`. |
| `GET /admin/projections` · `GET /admin/projections/:name?world&player` | Projection state. Player-scope projections without `player` return `{players: {id: state}}`. |
| `POST /admin/rebuild {world?}` | Rebuild projections from the log. |
| `GET /admin/stats` | Per-module asks, cache hits, p50/p95, tokens, $, budgets, sockets. |
| `GET /admin/jobs` | Forge jobs. |
| `POST /admin/m/forge/bake {kind, count?, prompts?, ai?}` · `GET /admin/m/forge/review?status=&kind=` · `POST /admin/m/forge/review/:id {status, note?}` · `GET /admin/m/forge/pack?kinds=` | Forge bake mode, the review queue (event-sourced, in the `forge.gallery` projection) and the `BakePack` export (plus `assets[]`). |
| `GET /admin/review` · `POST /admin/review/:id` · `GET /admin/bake` | The core review queue, for non-forge content. |
| `GET /admin/simulate/presets` · `POST /admin/simulate {world, player, preset?, signals?}` | Simulate a player. |
| `GET /admin/m/observer/traits` · `GET /admin/m/persona/pools` · `GET /admin/m/world/state?world` · `POST /admin/m/director/difficulty` | Module admin routes: trait library and designer rules, bark pools, world state, designer difficulty override. |

Module public routes include:

- `POST /v1/m/persona/stt?npc=`: NPC-biased STT.
- `GET /v1/m/world/rumours|standing|reactions`: world queries.
- `GET /v1/m/quests/log|progression`: quest log and progression suggestions.
- `POST /v1/m/quests/objective`: a dynamic objective.
- `POST /v1/m/director/assist`: the player's assist toggle.
- `GET /v1/m/forge/mesh/:jobId`: the mesh proxy.

Projection names: `observer.player_model`, `persona.memories`, `quests.log` (player scope); `world.rumours`,
`world.factions`, `director.state`, `forge.gallery`, `core.directives` (world scope).

## Examples

### curl

```bash
KEY=pk_dev_counterforge
curl -s localhost:8787/v1/signals -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"signals":[{"type":"economy.gold","data":{"amount":1500},"ts":'$(date +%s000)',"player":"p1","world":"w1"}]}'
curl -s localhost:8787/v1/ask/npc.bark -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"world":"w1","player":"p1","params":{"npc":"kit","trigger":"approach"}}'
```

### Unity (C#)

```csharp
using System.Text;
using UnityEngine;
using UnityEngine.Networking;
using System.Net.WebSockets;   // or NativeWebSocket on WebGL

public class Liveforge : MonoBehaviour {
  public string url = "http://localhost:8787", key = "pk_dev_counterforge", world = "w1", player = "p1";

  public IEnumerator Signal(string type, string dataJson) {
    var body = $"{{\"signals\":[{{\"type\":\"{type}\",\"data\":{dataJson},\"ts\":{System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()},\"player\":\"{player}\",\"world\":\"{world}\"}}]}}";
    using var req = new UnityWebRequest($"{url}/v1/signals", "POST");
    req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
    req.downloadHandler = new DownloadHandlerBuffer();
    req.SetRequestHeader("Content-Type", "application/json");
    req.SetRequestHeader("Authorization", "Bearer " + key);
    yield return req.SendWebRequest();
  }

  public IEnumerator Ask(string kind, string paramsJson, System.Action<string> onInstant) {
    var body = $"{{\"world\":\"{world}\",\"player\":\"{player}\",\"params\":{paramsJson}}}";
    using var req = new UnityWebRequest($"{url}/v1/ask/{kind}", "POST");
    req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
    req.downloadHandler = new DownloadHandlerBuffer();
    req.SetRequestHeader("Content-Type", "application/json");
    req.SetRequestHeader("Authorization", "Bearer " + key);
    yield return req.SendWebRequest();
    onInstant(req.downloadHandler.text);   // AskResponse JSON; the upgrade arrives on the socket with the same id
  }

  async void Start() {
    var ws = new ClientWebSocket();
    await ws.ConnectAsync(new System.Uri($"{url.Replace("http", "ws")}/v1/ws?key={key}&world={world}&player={player}"), default);
    var buf = new byte[1 << 16];
    while (ws.State == WebSocketState.Open) {
      var r = await ws.ReceiveAsync(buf, default);
      var json = Encoding.UTF8.GetString(buf, 0, r.Count);   // {"t":"directive"|"upgrade"|"chunk"|...}
      Debug.Log(json);                                        // dispatch on t / directive.kind
    }
  }
}
```

### Unreal (C++)

```cpp
// Build.cs: PublicDependencyModuleNames += { "HTTP", "Json", "WebSockets" };
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "WebSocketsModule.h"
#include "IWebSocket.h"

void ULiveforge::Ask(const FString& Kind, const FString& ParamsJson) {
  auto Req = FHttpModule::Get().CreateRequest();
  Req->SetURL(Url + TEXT("/v1/ask/") + Kind);
  Req->SetVerb(TEXT("POST"));
  Req->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
  Req->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + Key);
  Req->SetContentAsString(FString::Printf(TEXT("{\"world\":\"%s\",\"player\":\"%s\",\"params\":%s}"), *World, *Player, *ParamsJson));
  Req->OnProcessRequestComplete().BindLambda([this](FHttpRequestPtr, FHttpResponsePtr Res, bool bOk) {
    if (bOk) OnInstant.Broadcast(Res->GetContentAsString());   // AskResponse JSON
  });
  Req->ProcessRequest();
}

void ULiveforge::Connect() {
  const FString WsUrl = Url.Replace(TEXT("http"), TEXT("ws")) +
    FString::Printf(TEXT("/v1/ws?key=%s&world=%s&player=%s"), *Key, *World, *Player);
  Socket = FWebSocketsModule::Get().CreateWebSocket(WsUrl);
  Socket->OnMessage().AddLambda([this](const FString& Msg) { OnMessage.Broadcast(Msg); });  // parse "t"
  Socket->Connect();
}
```

In both engines:

- **Signals:** batch them, flushing every 250 ms or 50 signals.
- **Instant answers:** keep the last good answer per ask for offline play.
- **Bake packs:** load the `BakePack` exported from the dashboard. Its format is `schema/v1/BakePack.json`:
  `{protocol, game, createdAt, entries: {askKind: [{key, result, tags?}]}}`.
