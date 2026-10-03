# Recipe: voice conversation

**Goal:** hold a key and ask Vale about the Titan out loud. Vale answers in her own voice, sentence by sentence
as the reply streams in, and remembers the conversation next time.

## How it flows

```
mic ──▶ STT (browser recognition, or POST /v1/stt → Whisper API / whisper.cpp)
    ──▶ ask("npc.reply", {npc, text, stream: true})
          ├─ instant: a short rules line (show it, don't speak it)
          ├─ chunk, chunk, chunk …  (sentences of the AI reply → speak each one as it arrives)
          └─ upgrade: final text + actions (trade, reveal, quest_offer …) + mood
    ──▶ memory: Persona records the exchange (salience decays, sharpens when recalled)
```

## Manifest

```yaml
personas:
  - id: vale
    name: Vale
    role: Academy guide
    personality: Patient, dry-witted mentor. Short, precise sentences.
    voice: { pitch: 1.05, rate: 0.95, accent: en-GB, style: calm }   # SDK TTS uses these hints
    knowledge: [counterforging, the Forge Titan, the Veil]           # out-of-scope questions are refused in character
    secrets: [The Titan was once a student who forged too well.]
    allowedActions: [emote, give, quest_offer, reveal, help]
safety: { rating: T, inWorldOnly: true }
```

The server needs one of these for STT:

- `OPENAI_API_KEY` (the Whisper API);
- `WHISPER_CPP_BIN` + `WHISPER_CPP_MODEL` (fully local);
- or nothing, if you rely on browser speech recognition.

## Web

```ts
import { LiveNPC, Mic } from "@liveforge/three";

const vale = new LiveNPC({ client: lf, id: "vale", object: valeMesh, player: playerMesh, stream: true });
vale.on("say", (line) => subtitles.show("Vale", line.text, { pending: !line.final }));
vale.on("action", (a) => a.action === "reveal" && journal.add(a.args.secret));

const mic = new Mic(lf, { mode: "auto", language: "en-GB" });  // browser STT if available, else server STT
pushToTalk.onDown(() => mic.start());
pushToTalk.onUp(async () => {
  const text = await mic.stop();
  if (text) await vale.talk(text);        // streams; each sentence is spoken with speechSynthesis
});
```

`LiveNPC` handles several things for you:

- conversation history;
- `social.talked_to` / `social.said` signals;
- speaking each sentence once (it skips the instant line when an upgrade is coming);
- mood and end-of-conversation events.

## Godot

```gdscript
# Push-to-talk: record with AudioEffectRecord on a "Mic" bus, then:
var wav: AudioStreamWAV = $Recorder.get_recording()
var stt := Liveforge.stt(wav.get_data_as_wav_bytes() if wav.has_method("get_data_as_wav_bytes") else wav.data)
var heard: Dictionary = await stt.completed
var a := Liveforge.ask("npc.reply", {"npc": "bess", "text": heard.body.text, "stream": true})
a.partial.connect(func(t): DisplayServer.tts_speak(t, voice_id, 50, 1.0, 1.0))
var r: Dictionary = await a.done
```

The `LiveNPC` node wraps all of this: push-to-talk, STT, streaming and `tts_speak` with the persona's pitch and
rate.

## Tips

- **Instant line:** show it greyed out and speak only the upgrade or streamed sentences. If no upgrade is coming
  (no key, or over budget), speak the instant line.
- **Context:** pass `context: { zone, timeOfDay, questState }` so the reply is grounded in the moment.
- **Moderation:** player input is moderated, and off-topic questions are refused in character (`safety`).

## In the dashboard

| Panel | What you see |
|---|---|
| **Signal stream** | `social.talked_to` and `social.said`. |
| **NPC memories → Vale** | *conversation* entries with salience bars. The summary updates as the attitude moves. |
| **Cost & latency** | `persona`: instant p95 in milliseconds, upgrade p50/p95, cache hits. |
