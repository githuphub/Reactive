class_name LiveNPC
extends Node3D
## A talking, remembering NPC bound to a manifest persona. Proximity barks (Area3D), text or push-to-talk
## conversation (AudioEffectRecord -> WAV -> /v1/stt), replies spoken with DisplayServer.tts_speak in the persona's
## voice style, structured actions, and directives addressed to "npc:<persona_id>".
##
## Needs: the Liveforge autoload (enable the plugin). For TTS enable Project Settings >
## audio/general/text_to_speech; for push-to-talk enable audio/driver/enable_input.
##
## [codeblock]
## $Bess.said.connect(func(text, stage): $Chat.add_line("Bess", text))
## $Bess.action.connect(func(kind, args): if kind == "trade": open_shop(args.get("priceMultiplier", 1.0)))
## $Bess.talk("Any news from the bridge?")
## [/codeblock]

## A line to show. stage: instant | upgrade | bark | directive.
signal said(text: String, stage: String)
## A streamed sentence of the reply (also spoken).
signal partial_said(text: String)
## A structured action (emote, trade, give, flee, call_guards ...), validated by the server.
signal action(kind: String, args: Dictionary)
## A bark line (also emitted through said with stage "bark").
signal barked(text: String)
## Push-to-talk transcript (what the player said).
signal heard(text: String)
## The NPC heard a rumour (rumour.heard directive).
signal rumour_heard(content: String)
## The conversation ended (NPC ended it, or the player walked away).
signal conversation_ended
## Mic capture started / stopped.
signal listening_changed(active: bool)

## Persona id from the manifest (personas[].id).
@export var persona_id: String = ""
## Bark when a body in `player_group` comes this close (0 = off).
@export var bark_radius := 4.0
## Minimum seconds between proximity barks.
@export var bark_cooldown := 25.0
@export var player_group: StringName = &"player"
## Physics layers the proximity area watches.
@export_flags_3d_physics var proximity_mask := 1
## Speak lines with DisplayServer.tts_speak.
@export var speak_lines := true
## Stream replies sentence by sentence.
@export var stream_replies := true
## Send social.talked_to when a conversation starts.
@export var auto_signals := true
## Language for push-to-talk STT ("en", "fr" ...).
@export var stt_language := "en"
## Voice overrides (0 / empty = persona voice from the server).
@export_range(0.0, 2.0) var voice_pitch := 0.0
@export_range(0.0, 2.0) var voice_rate := 0.0
@export var voice_id := ""
@export var history_size := 10

var history: Array = []
var busy := false
var listening := false

var _voice := {}
var _last_bark := -1000.0
var _conversation := false
var _area: Area3D
var _mic_player: AudioStreamPlayer
var _record: AudioEffectRecord
var _warned_tts := false

const MIC_BUS := "LiveforgeMic"


func _ready() -> void:
	var lf := LiveforgeUtil.lf(self)
	if lf == null:
		push_warning("[liveforge] LiveNPC '%s': the Liveforge autoload is missing (enable the Liveforge plugin)." % persona_id)
		return
	if persona_id.is_empty():
		push_warning("[liveforge] LiveNPC '%s' has no persona_id." % name)
	lf.directive.connect(_on_directive)
	lf.config_loaded.connect(_on_config)
	if not lf.public_config.is_empty():
		_on_config(lf.public_config)
	if bark_radius > 0.0:
		_area = Area3D.new()
		_area.name = "Proximity"
		_area.collision_layer = 0
		_area.collision_mask = proximity_mask
		var cs := CollisionShape3D.new()
		var sphere := SphereShape3D.new()
		sphere.radius = bark_radius
		cs.shape = sphere
		_area.add_child(cs)
		add_child(_area)
		_area.body_entered.connect(_on_body_entered)
		_area.body_exited.connect(_on_body_exited)


## Asks for a one-liner (npc.bark) and says it. Triggers: approach, idle, combat, gear, moment, greeting, farewell.
func bark(trigger: String = "idle", context: Dictionary = {}) -> LiveforgeAsk:
	var lf := LiveforgeUtil.lf(self)
	if lf == null:
		return null
	var params := {"npc": persona_id, "trigger": trigger}
	if not context.is_empty():
		params["context"] = context
	var a: LiveforgeAsk = lf.ask("npc.bark", params)
	a.done.connect(_on_bark_done)
	return a


## Says something to the NPC. Lines arrive through said / partial_said; actions through action.
func talk(text: String, context: Dictionary = {}) -> LiveforgeAsk:
	var lf := LiveforgeUtil.lf(self)
	text = text.strip_edges()
	if lf == null or text.is_empty():
		return null
	if not _conversation:
		_conversation = true
		if auto_signals:
			lf.send_signal("social.talked_to", {"npc": persona_id})
	var params := {"npc": persona_id, "text": text.left(1000)}
	if not history.is_empty():
		params["history"] = history.slice(maxi(0, history.size() - history_size))
	if stream_replies:
		params["stream"] = true
	if not context.is_empty():
		params["context"] = context
	history.append({"role": "player", "text": text})
	busy = true
	var a: LiveforgeAsk = lf.ask("npc.reply", params)
	a.answered.connect(_on_reply_instant.bind(a))
	a.partial.connect(_on_reply_partial)
	a.done.connect(_on_reply_done.bind(a))
	a.failed.connect(_on_reply_failed)
	return a


## Ends the conversation (clears history).
func end_conversation() -> void:
	if not _conversation:
		return
	_conversation = false
	history.clear()
	conversation_ended.emit()


## Push-to-talk: start recording from the default microphone.
func start_listening() -> void:
	if listening:
		return
	if not bool(ProjectSettings.get_setting("audio/driver/enable_input", false)):
		push_warning("[liveforge] enable Project Settings > audio/driver/enable_input for push-to-talk")
		return
	_ensure_mic()
	_mic_player.play()
	_record.set_recording_active(true)
	listening = true
	listening_changed.emit(true)


## Push-to-talk: stop, transcribe with /v1/stt, emit heard(text) and talk(text).
func stop_listening() -> void:
	if not listening:
		return
	listening = false
	listening_changed.emit(false)
	_record.set_recording_active(false)
	var rec: AudioStreamWAV = _record.get_recording()
	_mic_player.stop()
	var lf := LiveforgeUtil.lf(self)
	if rec == null or rec.data.is_empty() or lf == null:
		return
	var reply: LiveforgeReply = lf.stt(LiveforgeUtil.wav_bytes(rec), stt_language)
	reply.completed.connect(_on_stt)


## Speaks a line with the NPC's voice (DisplayServer TTS).
func speak(text: String, voice: Dictionary = {}) -> void:
	if not speak_lines or text.strip_edges().is_empty():
		return
	if not bool(ProjectSettings.get_setting("audio/general/text_to_speech", false)):
		if not _warned_tts:
			_warned_tts = true
			push_warning("[liveforge] enable Project Settings > audio/general/text_to_speech for NPC voices")
		return
	var v := _voice.duplicate()
	v.merge(voice, true)
	var lang := LiveforgeUtil.accent_to_lang(str(v.get("accent", "")))
	var voices := DisplayServer.tts_get_voices_for_language(lang)
	if voices.is_empty():
		voices = DisplayServer.tts_get_voices_for_language("en")
	if voices.is_empty():
		return
	var vid: String = voices[absi(persona_id.hash()) % voices.size()]
	var want := str(v.get("voiceId", voice_id))
	if not want.is_empty():
		for candidate in voices:
			if candidate.to_lower().contains(want.to_lower()):
				vid = candidate
				break
	var tweak := LiveforgeUtil.style_tweaks(str(v.get("style", "")))
	var pitch := clampf(float(v.get("pitch", 1.0)) * tweak.x, 0.0, 2.0)
	var rate := clampf(float(v.get("rate", 1.0)) * tweak.y, 0.1, 10.0)
	DisplayServer.tts_speak(text, vid, 100, pitch, rate, 0, false)


# ---- internals


func _on_config(config: Dictionary) -> void:
	for p in config.get("personas", []):
		if typeof(p) == TYPE_DICTIONARY and str(p.get("id", "")) == persona_id and typeof(p.get("voice")) == TYPE_DICTIONARY:
			_voice = (p.voice as Dictionary).duplicate()
	if voice_pitch > 0.0:
		_voice["pitch"] = voice_pitch
	if voice_rate > 0.0:
		_voice["rate"] = voice_rate
	if not voice_id.is_empty():
		_voice["voiceId"] = voice_id


func _on_body_entered(body: Node3D) -> void:
	if not body.is_in_group(player_group):
		return
	var now := Time.get_ticks_msec() / 1000.0
	if now - _last_bark >= bark_cooldown and not busy:
		_last_bark = now
		bark("approach")


func _on_body_exited(body: Node3D) -> void:
	if body.is_in_group(player_group) and _conversation:
		end_conversation()


func _on_bark_done(r: Dictionary) -> void:
	var text := str(r.get("text", ""))
	if text.is_empty():
		return
	barked.emit(text)
	said.emit(text, "bark")
	speak(text, r.get("voice", {}) if typeof(r.get("voice")) == TYPE_DICTIONARY else {})
	_emit_actions(r.get("actions", []))


func _on_reply_instant(r: Dictionary, a: LiveforgeAsk) -> void:
	var text := str(r.get("text", ""))
	said.emit(text, "instant")
	if not a.upgrade_pending:
		speak(text, r.get("voice", {}) if typeof(r.get("voice")) == TYPE_DICTIONARY else {})


func _on_reply_partial(text: String) -> void:
	partial_said.emit(text)
	speak(text)


func _on_reply_done(r: Dictionary, a: LiveforgeAsk) -> void:
	busy = false
	if r.is_empty():
		return
	var text := str(r.get("text", ""))
	var voice: Dictionary = r.get("voice", {}) if typeof(r.get("voice")) == TYPE_DICTIONARY else {}
	if a.stage == "upgrade":
		said.emit(text, "upgrade")
		if a.partial_text.is_empty():
			speak(text, voice)
	elif a.upgrade_pending and a.partial_text.is_empty():
		speak(text, voice)  # the upgrade never came: speak the instant answer after all
	history.append({"role": "npc", "text": text})
	while history.size() > history_size * 2:
		history.pop_front()
	_emit_actions(r.get("actions", []))
	if bool(r.get("end", false)):
		end_conversation()


func _on_reply_failed(code: String, message: String) -> void:
	busy = false
	push_warning("[liveforge] %s could not reply: %s %s" % [persona_id, code, message])


func _on_stt(data: Dictionary) -> void:
	var text := str(data.get("text", "")).strip_edges()
	if text.is_empty():
		return
	heard.emit(text)
	talk(text)


func _on_directive(kind: String, d: Dictionary) -> void:
	var args: Dictionary = d.get("args", {})
	if str(d.get("target", "")) != "npc:" + persona_id and str(args.get("npc", "")) != persona_id:
		return
	match kind:
		"npc.bark":
			var text := str(args.get("text", ""))
			said.emit(text, "directive")
			speak(text, args.get("voice", {}) if typeof(args.get("voice")) == TYPE_DICTIONARY else {})
		"npc.action":
			if args.has("line"):
				said.emit(str(args.line), "directive")
				speak(str(args.line))
			var act: Dictionary = args.get("action", {})
			action.emit(str(act.get("action", "")), act.get("args", {}))
		"rumour.heard":
			rumour_heard.emit(str(args.get("content", "")))


func _emit_actions(list: Variant) -> void:
	if typeof(list) != TYPE_ARRAY:
		return
	for act in list:
		if typeof(act) == TYPE_DICTIONARY:
			action.emit(str(act.get("action", "")), act.get("args", {}) if typeof(act.get("args")) == TYPE_DICTIONARY else {})


func _ensure_mic() -> void:
	var bus := AudioServer.get_bus_index(MIC_BUS)
	if bus == -1:
		AudioServer.add_bus()
		bus = AudioServer.bus_count - 1
		AudioServer.set_bus_name(bus, MIC_BUS)
		AudioServer.set_bus_mute(bus, true)
		AudioServer.add_bus_effect(bus, AudioEffectRecord.new(), 0)
	_record = AudioServer.get_bus_effect(bus, 0) as AudioEffectRecord
	if _mic_player == null:
		_mic_player = AudioStreamPlayer.new()
		_mic_player.name = "Mic"
		_mic_player.stream = AudioStreamMicrophone.new()
		_mic_player.bus = MIC_BUS
		add_child(_mic_player)
