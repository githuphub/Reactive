class_name LiveforgeUtil
extends RefCounted
## Shared helpers for the Liveforge addon: project settings, JSON-to-Godot conversion, WAV encoding, sprites.

## Project settings the addon reads (Project Settings > Liveforge). Values here are the defaults.
const SETTINGS := {
	"liveforge/server/url": "http://localhost:8787",
	"liveforge/server/game_key": "",
	"liveforge/session/world": "default",
	"liveforge/session/player": "player1",
	"liveforge/signals/flush_interval_ms": 250,
	"liveforge/signals/flush_size": 50,
	"liveforge/realtime/enabled": true,
	"liveforge/http/pool_size": 4,
	"liveforge/http/timeout_sec": 8.0,
	"liveforge/asks/upgrade_timeout_sec": 45.0,
	"liveforge/cache/persist": true,
	"liveforge/debug/log": false,
	## Reaction Library (R1): send session.started (with the last-seen time) when the autoload starts.
	"liveforge/auto/session_started": true,
}

## Built-in signal vocabulary (protocol BUILTIN_SIGNALS), for tools and validation hints.
const BUILTIN_SIGNALS := [
	"combat.hit", "combat.hurt", "combat.dodged", "combat.blocked", "combat.parried", "combat.killed", "combat.died",
	"combat.ability_used", "economy.gold", "economy.bought", "economy.sold", "economy.stole", "social.said",
	"social.talked_to", "social.gave", "social.lied", "social.threatened", "movement.entered_zone", "movement.explored",
	"movement.fled", "gear.equipped", "gear.unequipped", "quest.accepted", "quest.completed", "quest.failed",
	"world.destroyed", "world.helped", "world.time", "movement.near_npc", "social.approach",
	# Reaction Library (R1)
	"world.property_damaged", "appearance.state", "appearance.outfit", "social.promise", "social.promise_kept",
	"social.promise_broken", "social.claim", "economy.haggled", "combat.boss_attempt", "combat.phase_flawless",
	"combat.fled", "companion.died", "session.started", "movement.visited",
]

## Reaction Library recipe ids (manifest reactions.library); docs/reactions.md.
const REACTION_RECIPES := [
	"outfit_comments", "appearance_state", "deed_nicknames", "lies_caught", "promises_remembered", "town_mood",
	"rich_attention", "broke_support", "collector_interest", "haggle_memory", "boss_attempt_memory", "dodge_bait",
	"flawless_secret_phase", "coward_rumour", "companion_grief", "time_weather_barks", "inn_regular", "absence_recap",
	"property_damage", "avoided_area",
]

## hour 0-24 -> "dawn" | "day" | "dusk" | "night" (same buckets as the server).
static func day_phase(hour: float) -> String:
	var h := fposmod(hour, 24.0)
	if h >= 5.0 and h < 8.0:
		return "dawn"
	if h >= 8.0 and h < 18.0:
		return "day"
	if h >= 18.0 and h < 21.0:
		return "dusk"
	return "night"

const ACCENTS := {
	"british": "en", "english": "en", "scottish": "en", "irish": "en", "american": "en", "australian": "en",
	"french": "fr", "german": "de", "spanish": "es", "italian": "it", "dutch": "nl", "russian": "ru",
	"japanese": "ja", "polish": "pl", "swedish": "sv", "portuguese": "pt",
}

static var _sprites := {}


## Returns the Liveforge autoload (or null when the plugin / autoload is not enabled).
static func lf(from: Node) -> Node:
	if from == null or not from.is_inside_tree():
		return null
	return from.get_tree().root.get_node_or_null("Liveforge")


## Reads a Liveforge project setting with its default.
static func setting(key: String) -> Variant:
	return ProjectSettings.get_setting(key, SETTINGS.get(key))


## "#rrggbb" -> Color (fallback when invalid).
static func color(v: Variant, fallback: Color = Color(0.72, 0.75, 0.78)) -> Color:
	if typeof(v) == TYPE_STRING and Color.html_is_valid(v):
		return Color.html(v)
	return fallback


## [x, y, z] -> Vector3 (fallback when invalid).
static func vec3(v: Variant, fallback: Vector3 = Vector3.ZERO) -> Vector3:
	if typeof(v) == TYPE_ARRAY and v.size() >= 3:
		return Vector3(float(v[0]), float(v[1]), float(v[2]))
	return fallback


## Wire-safe random id ([a-z0-9_], <= 64 chars).
static func new_id(prefix: String) -> String:
	const ALPHABET := "abcdefghijklmnopqrstuvwxyz0123456789"
	var s := ""
	for i in 12:
		s += ALPHABET[randi() % ALPHABET.length()]
	return ("%s_%d%s" % [prefix, Time.get_ticks_usec(), s]).left(64)


## Milliseconds since the Unix epoch.
static func now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)


## Accent hint ("scottish", "en-GB", "fr") -> TTS language code ("en", "fr").
static func accent_to_lang(accent: String) -> String:
	var a := accent.strip_edges().to_lower()
	if a.is_empty():
		return "en"
	if a.length() == 2 or (a.length() == 5 and a[2] == "-"):
		return a.left(2)
	for k in ACCENTS:
		if a.contains(k):
			return ACCENTS[k]
	return "en"


## Pitch / rate multipliers for voice style words ("gruff", "nervous", "whispering").
static func style_tweaks(style: String) -> Vector2:
	var s := style.to_lower()
	var pitch := 1.0
	var rate := 1.0
	for w in ["gruff", "deep", "growl", "booming", "stern"]:
		if s.contains(w):
			pitch *= 0.85
			break
	for w in ["nervous", "excited", "brisk", "quick", "fast", "chirpy"]:
		if s.contains(w):
			rate *= 1.1
			break
	for w in ["slow", "weary", "old", "ancient", "drawl", "sleepy", "whisper"]:
		if s.contains(w):
			rate *= 0.88
			break
	for w in ["squeaky", "high", "childlike", "sing-song"]:
		if s.contains(w):
			pitch *= 1.15
			break
	return Vector2(pitch, rate)


## Encodes a recording (AudioEffectRecord.get_recording()) as a 16-bit PCM WAV file for POST /v1/stt.
static func wav_bytes(stream: AudioStreamWAV) -> PackedByteArray:
	var channels := 2 if stream.stereo else 1
	var bits := 16 if stream.format == AudioStreamWAV.FORMAT_16_BITS else 8
	var data: PackedByteArray = stream.data
	if bits == 8:
		# Godot stores 8-bit PCM signed; WAV wants unsigned.
		data = data.duplicate()
		for i in data.size():
			data[i] = (data[i] + 128) & 0xff
	var block := channels * (bits >> 3)
	var out := PackedByteArray()
	out.append_array("RIFF".to_ascii_buffer())
	out.append_array(_u32(36 + data.size()))
	out.append_array("WAVE".to_ascii_buffer())
	out.append_array("fmt ".to_ascii_buffer())
	out.append_array(_u32(16))
	out.append_array(_u16(1))
	out.append_array(_u16(channels))
	out.append_array(_u32(stream.mix_rate))
	out.append_array(_u32(stream.mix_rate * block))
	out.append_array(_u16(block))
	out.append_array(_u16(bits))
	out.append_array("data".to_ascii_buffer())
	out.append_array(_u32(data.size()))
	out.append_array(data)
	return out


static func _u32(v: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(4)
	b.encode_u32(0, v)
	return b


static func _u16(v: int) -> PackedByteArray:
	var b := PackedByteArray()
	b.resize(2)
	b.encode_u16(0, v)
	return b


## Procedural particle sprite (white, alpha shaped) for a VFX sprite name.
static func sprite_texture(sprite: String) -> Texture2D:
	if _sprites.has(sprite):
		return _sprites[sprite]
	var n := 32
	var img := Image.create(n, n, false, Image.FORMAT_RGBA8)
	for y in n:
		for x in n:
			var p := Vector2((x + 0.5) / n * 2.0 - 1.0, (y + 0.5) / n * 2.0 - 1.0)
			var r := p.length()
			var a := 0.0
			match sprite:
				"ring", "bubble":
					a = clampf((1.0 - r) * 6.0, 0.0, 1.0) * clampf((r - 0.5) * 6.0, 0.0, 1.0)
				"shard":
					a = clampf((1.0 - (absf(p.x) * 1.6 + absf(p.y))) * 6.0, 0.0, 1.0)
				"spark":
					var star := maxf(1.0 - absf(p.x) * 5.0, 1.0 - absf(p.y) * 5.0)
					a = clampf(star, 0.0, 1.0) * clampf(1.0 - r, 0.0, 1.0) + clampf(1.0 - r * 3.0, 0.0, 1.0)
				"flame", "leaf":
					var d := Vector2(p.x * 1.7, p.y + 0.25 * (1.0 - p.y)).length()
					a = clampf((0.95 - d) * 3.0, 0.0, 1.0)
				"glyph":
					var m := maxf(absf(p.x), absf(p.y))
					a = 1.0 if (m < 0.8 and not (m < 0.55 and minf(absf(p.x), absf(p.y)) < 0.4)) else 0.0
				_:
					a = pow(clampf(1.0 - r, 0.0, 1.0), 2.0)
			img.set_pixel(x, y, Color(1, 1, 1, clampf(a, 0.0, 1.0)))
	var tex := ImageTexture.create_from_image(img)
	_sprites[sprite] = tex
	return tex
