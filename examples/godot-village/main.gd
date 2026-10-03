extends Node3D
## Liveforge Godot sample: Thornbury village. Three LiveNPCs (Bess, Aldric, Wick), a forge slot in the player's
## hand, and a LiveBoss training dummy that adapts to how you dodge. Chat on the left, directive log on the right.

@onready var player: VillagePlayer = $Player
@onready var hand: LiveEquipSlot = $Player/RightHand
@onready var boss: LiveBoss = $Dummy/Boss
@onready var dummy: Node3D = $Dummy
@onready var dummy_body: Node3D = $Dummy/Body
@onready var quests: LiveQuestBoard = $QuestBoard
@onready var director: LiveDirector = $Director
@onready var chat: RichTextLabel = $UI/Chat
@onready var log_box: RichTextLabel = $UI/Log
@onready var prompt: LineEdit = $UI/Bottom/Prompt
@onready var status_label: Label = $UI/Status

var npcs: Array = []
var dummy_hp := 1.0
var player_hp := 1.0
var gold := 0
var dodges_left := 0
var dodges_right := 0
var _phase := 1
var _move_timer := 0.0
var _last_dodge_ms := -10000
var _listening_npc: LiveNPC
var _anim_busy_ms := 0


func _ready() -> void:
	npcs = [$Bess, $Aldric, $Wick]
	for npc in npcs:
		npc.said.connect(_on_npc_said.bind(npc))
		npc.partial_said.connect(_on_npc_partial.bind(npc))
		npc.action.connect(_on_npc_action.bind(npc))
		npc.heard.connect(_on_heard)
		npc.rumour_heard.connect(_on_rumour.bind(npc))
	prompt.text_submitted.connect(_say)
	prompt.focus_entered.connect(_on_prompt_focus.bind(true))
	prompt.focus_exited.connect(_on_prompt_focus.bind(false))
	$UI/Bottom/Say.pressed.connect(_on_say_pressed)
	$UI/Bottom/Forge.pressed.connect(_forge)
	boss.move_triggered.connect(_on_boss_move)
	boss.taunt.connect(_on_taunt)
	boss.move_added.connect(_on_move_added)
	boss.phase_planned.connect(_on_phase_planned)
	hand.equipped.connect(_on_equipped)
	hand.upgraded.connect(_on_gear_upgraded)
	hand.forge_failed.connect(_on_forge_failed)
	quests.quest_offered.connect(_on_quest_offered)
	quests.achievement_unlocked.connect(_on_achievement)
	director.breather.connect(_on_breather)
	_add_campfire()

	var lf := get_node_or_null("/root/Liveforge")
	if lf == null:
		_chat("[color=red]The Liveforge autoload is missing: enable the plugin in Project > Project Settings > Plugins.[/color]")
		return
	lf.directive.connect(_on_directive)
	lf.status_changed.connect(_on_status)
	lf.request_failed.connect(_on_request_failed)
	lf.config_loaded.connect(_on_config)
	_on_status(lf.status)
	# Reaction Library (R1): a day/night + weather clock (world.time), mud that dries off, places the inn counts.
	var clock := LiveWorldClock.new()
	clock.name = "WorldClock"
	clock.day_length_min = 12.0
	clock.auto_weather = true
	clock.sun = get_node_or_null("Sun") as DirectionalLight3D
	add_child(clock)
	lf.appearance_decay = {"muddy": 0.02, "wet": 0.05, "bloodied": 0.01}
	var inn := LivePlace.new()
	inn.place_id = "copper_kettle"
	inn.kind = "inn"
	inn.zone = "inn"
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(4, 3, 4)
	shape.shape = box
	inn.add_child(shape)
	inn.position = Vector3(-8, 1.5, -6)
	add_child(inn)
	# Local fallbacks keep the village talking when the server is unreachable.
	lf.set_fallback("npc.bark", _fallback_bark)
	lf.set_fallback("npc.reply", _fallback_reply)
	_chat("[color=gray]Welcome to Thornbury. Walk up to someone and press Enter to talk, or hold V to speak.[/color]")


func _process(delta: float) -> void:
	# The dummy faces the player and attacks every few seconds when you are close.
	var to_player := player.global_position - dummy.global_position
	to_player.y = 0.0
	if to_player.length() > 0.1 and Time.get_ticks_msec() > _anim_busy_ms:
		dummy_body.rotation.y = atan2(to_player.x, to_player.z)
	_move_timer += delta
	if to_player.length() < 10.0 and _move_timer > 3.5 and dummy_hp > 0.0:
		_move_timer = 0.0
		boss.perform_next()
	status_label.text = "Liveforge: %s   ·   HP %d%%   ·   Gold %d   ·   Dummy %d%%   ·   Gear: %s" % [
		get_node("/root/Liveforge").status if has_node("/root/Liveforge") else "missing", int(player_hp * 100.0), gold,
		int(dummy_hp * 100.0), str(hand.item.get("name", "bare hands"))]


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		if Input.mouse_mode != Input.MOUSE_MODE_CAPTURED:
			Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		else:
			_attack()
		return
	if not (event is InputEventKey):
		return
	var key := event as InputEventKey
	if key.echo:
		return
	if not key.pressed:
		if key.physical_keycode == KEY_V and _listening_npc != null:
			_listening_npc.stop_listening()
			_chat("[color=gray](transcribing...)[/color]")
			_listening_npc = null
		return
	match key.physical_keycode:
		KEY_ESCAPE:
			Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		KEY_ENTER, KEY_KP_ENTER:
			Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
			prompt.grab_focus()
		KEY_Q:
			_dodge("left")
		KEY_E:
			_dodge("right")
		KEY_G:
			_find_gold()
		KEY_T:
			var npc := _nearest_npc(6.0)
			if npc != null:
				npc.bark("greeting")
		KEY_Y:
			if not quests.offers.is_empty():
				var qid: String = quests.offers.keys()[0]
				var title := str(quests.offers[qid].get("title", qid))
				quests.accept(qid)
				_chat("[color=#fd6]Quest accepted:[/color] " + title)
		KEY_V:
			var npc := _nearest_npc(6.0)
			if npc == null:
				_chat("[color=gray](nobody close enough to hear you)[/color]")
			else:
				_listening_npc = npc
				npc.start_listening()
				_chat("[color=gray](listening... release V to send)[/color]")


# ---- actions


func _say(text: String) -> void:
	text = text.strip_edges()
	prompt.clear()
	prompt.release_focus()
	if text.is_empty():
		return
	var npc := _nearest_npc(6.0)
	if npc == null:
		_chat("[color=gray](nobody close enough to hear you)[/color]")
		return
	_chat("[color=#9cf]You:[/color] " + text)
	npc.talk(text, {"zone": _zone_of(npc), "gold": gold})


func _on_say_pressed() -> void:
	_say(prompt.text)


func _forge() -> void:
	var text := prompt.text.strip_edges()
	if text.is_empty():
		text = "a sturdy village sword with a copper guard"
	prompt.clear()
	prompt.release_focus()
	_chat("[color=#fd6]You ask the forge for:[/color] " + text)
	hand.forge(text)


func _attack() -> void:
	if player.global_position.distance_to(dummy.global_position) > 3.5 or dummy_hp <= 0.0:
		return
	var dmg := 0.08 + float(hand.item.get("stats", {}).get("damage", 0.0)) / 400.0
	dummy_hp = maxf(0.0, dummy_hp - dmg)
	boss.report_hit(dmg * 100.0, str(hand.item.get("id", "fists")))
	var tw := create_tween()
	tw.tween_property(dummy_body, "scale", Vector3(1.15, 0.9, 1.15), 0.06)
	tw.tween_property(dummy_body, "scale", Vector3.ONE, 0.12)
	if dummy_hp <= 0.5 and _phase == 1:
		_phase = 2
		_log("dummy at half straw: asking the Director for phase 2")
		boss.request_phase(2, dummy_hp, _habits(), hand.item.get("tags", []))
	if dummy_hp <= 0.0:
		_chat("[color=#fd6]The dummy collapses in a heap of straw![/color]")
		var lf := get_node_or_null("/root/Liveforge")
		if lf != null:
			lf.send_signal("combat.killed", {"target": "training_dummy", "target_type": "boss", "boss": true})
		quests.check_achievements(["combat.killed"])
		get_tree().create_timer(5.0).timeout.connect(_reset_dummy)


func _dodge(direction: String) -> void:
	var side := player.global_transform.basis.x * (-1.0 if direction == "left" else 1.0)
	player.dodge_velocity = side * 9.0
	if player.global_position.distance_to(dummy.global_position) > 10.0:
		return
	_last_dodge_ms = Time.get_ticks_msec()
	if direction == "left":
		dodges_left += 1
	else:
		dodges_right += 1
	boss.report_dodge(direction, "dummy")
	var total := dodges_left + dodges_right
	_log("dodged %s (%d left / %d right)" % [direction, dodges_left, dodges_right])
	if total % 4 == 0:
		_log("asking the Director to adapt (phase %d)" % _phase)
		boss.request_phase(_phase, dummy_hp, _habits(), hand.item.get("tags", []))


func _find_gold() -> void:
	gold += 150
	var lf := get_node_or_null("/root/Liveforge")
	if lf != null:
		lf.send_signal("economy.gold", {"amount": gold, "delta": 150})
	_chat("[color=#fd6]You find 150 gold[/color] (now %d). Somebody in the shadows noticed." % gold)


func _reset_dummy() -> void:
	dummy_hp = 1.0
	_phase = 1
	_chat("[color=gray]The bored wizard waves a hand. The dummy stands up again.[/color]")


func _habits() -> Dictionary:
	var total := maxi(1, dodges_left + dodges_right)
	return {"dodgeLeft": float(dodges_left) / total, "dodgeRate": float(dodges_left + dodges_right), "playerHp": player_hp}


func _nearest_npc(max_dist: float) -> LiveNPC:
	var best: LiveNPC = null
	var best_d := max_dist
	for npc in npcs:
		var d: float = player.global_position.distance_to((npc as Node3D).global_position)
		if d <= best_d:
			best_d = d
			best = npc
	return best


func _zone_of(npc: LiveNPC) -> String:
	match npc.persona_id:
		"bess":
			return "inn"
		"aldric":
			return "bridge"
	return "green"


# ---- boss


func _on_boss_move(user_move: String, params: Dictionary, spec: Dictionary) -> void:
	_anim_busy_ms = Time.get_ticks_msec() + 700
	var tw := create_tween()
	match user_move:
		"spin":
			var turns := float(params.get("speed", 1.0))
			tw.tween_property(dummy_body, "rotation:y", dummy_body.rotation.y + TAU * turns, 0.6)
		"lunge":
			var toward := (player.global_position - dummy.global_position)
			toward.y = 0.0
			var target := toward.normalized() * minf(2.0, toward.length())
			tw.tween_property(dummy_body, "position", Vector3(target.x, dummy_body.position.y, target.z), 0.18)
			tw.tween_property(dummy_body, "position", Vector3(0, dummy_body.position.y, 0), 0.4)
		"slam":
			tw.tween_property(dummy_body, "scale", Vector3(1.3, 0.55, 1.3), 0.15)
			tw.tween_property(dummy_body, "scale", Vector3.ONE, 0.3)
		_:
			# An invented grammar move without an engine mapping: wobble and announce it.
			tw.tween_property(dummy_body, "rotation:z", 0.4, 0.12)
			tw.tween_property(dummy_body, "rotation:z", -0.4, 0.12)
			tw.tween_property(dummy_body, "rotation:z", 0.0, 0.12)
			_chat("[color=#f96]The dummy unleashes %s![/color]" % str(spec.get("name", user_move)))
	# Hits you unless you dodged in the last 0.8 s.
	var reach := float(params.get("radius", 3.0)) + 0.5
	if player.global_position.distance_to(dummy.global_position) <= reach and Time.get_ticks_msec() - _last_dodge_ms > 800:
		player_hp = maxf(0.05, player_hp - 0.1)
		boss.report_hurt(10.0, player_hp, user_move)
		_log("[color=#f96]hit by %s[/color] (hp %d%%)" % [user_move, int(player_hp * 100.0)])
		if player_hp <= 0.1:
			player_hp = 1.0
			_chat("[color=gray]You sit down for a moment. The dummy looks smug.[/color]")


func _on_taunt(text: String) -> void:
	_chat("[color=#f96]Training Dummy:[/color] " + text)


func _on_move_added(move: Dictionary, engine_id: String, _params: Dictionary) -> void:
	_log("dummy learned [b]%s[/b] %s" % [str(move.get("name", engine_id)), "(" + engine_id + ")" if not engine_id.is_empty() else "(invented)"])


func _on_phase_planned(phase: int, moves: Array, why: String) -> void:
	_log("phase %d plan: %d moves  [color=gray]%s[/color]" % [phase, moves.size(), why])


# ---- npcs / world


func _on_npc_said(text: String, stage: String, npc: LiveNPC) -> void:
	if stage == "instant" and text.is_empty():
		return
	var tag := "" if stage in ["upgrade", "bark", "directive"] else " [color=gray](%s)[/color]" % stage
	_chat("[color=#fc8]%s:[/color] %s%s" % [npc.name, text, tag])


func _on_npc_partial(text: String, npc: LiveNPC) -> void:
	_chat("[color=#fc8]%s[/color] [color=gray]…[/color] %s" % [npc.name, text])


func _on_npc_action(kind: String, args: Dictionary, npc: LiveNPC) -> void:
	_chat("[color=#c9f]* %s: %s %s[/color]" % [npc.name, kind, JSON.stringify(args) if not args.is_empty() else ""])
	match kind:
		"steal":
			var amount := int(args.get("gold", 10))
			gold = maxi(0, gold - amount)
			_chat("[color=#f66]Your purse feels %d gold lighter.[/color]" % amount)
		"quest_offer":
			quests.request_offer(npc.persona_id, _zone_of(npc))


func _on_heard(text: String) -> void:
	_chat("[color=#9cf]You (voice):[/color] " + text)


func _on_rumour(content: String, npc: LiveNPC) -> void:
	_log("%s heard a rumour: %s" % [npc.name, content])


func _on_equipped(item: Dictionary) -> void:
	if not item.is_empty():
		_chat("[color=#fd6]You wield %s.[/color] [color=gray]%s[/color]" % [str(item.get("name", "something")), str(item.get("flavor", ""))])


func _on_gear_upgraded(item: Dictionary) -> void:
	_log("forge upgrade landed: [b]%s[/b]" % str(item.get("name", "?")))


func _on_forge_failed(code: String, message: String) -> void:
	_chat("[color=red]The forge sputters (%s): %s[/color]" % [code, message])


func _on_quest_offered(quest: Dictionary, giver: String) -> void:
	_chat("[color=#fd6]Quest from %s: %s[/color] %s [color=gray](Y to accept)[/color]" % [giver if not giver.is_empty() else "the village", str(quest.get("title", "?")), str(quest.get("summary", ""))])


func _on_achievement(a: Dictionary) -> void:
	_chat("[color=gold]Achievement unlocked: %s[/color] [color=gray]%s[/color]" % [str(a.get("title", "?")), str(a.get("description", ""))])


func _on_breather(seconds: float) -> void:
	_log("breather for %d s" % int(seconds))
	_move_timer = -seconds


func _on_directive(kind: String, d: Dictionary) -> void:
	_log("[b]%s[/b] → %s  [color=gray]%s[/color]" % [kind, str(d.get("target", "?")), str(d.get("why", ""))])


func _on_status(s: String) -> void:
	_log("[color=gray]socket: %s[/color]" % s)


func _on_request_failed(code: String, message: String) -> void:
	_log("[color=red]%s[/color] %s" % [code, message])


func _on_config(config: Dictionary) -> void:
	var game: Dictionary = config.get("game", {})
	_log("connected to [b]%s[/b]" % str(game.get("name", "?")))


func _on_prompt_focus(focused: bool) -> void:
	player.input_enabled = not focused


func _fallback_bark(params: Dictionary) -> Dictionary:
	return {"npc": str(params.get("npc", "")), "text": "Lovely day for it, isn't it?", "actions": []}


func _fallback_reply(params: Dictionary) -> Dictionary:
	return {"npc": str(params.get("npc", "")), "text": "Sorry, my head's all fog today. Ask me again later.", "actions": []}


func _add_campfire() -> void:
	# A hand-written VFX recipe (protocol VfxRecipe v1): embers, smoke, a warm flickering light.
	var fx := LiveVFX.new()
	fx.name = "Campfire"
	fx.position = Vector3(-2.0, 0.1, -2.0)
	fx.recipe = {
		"v": 1, "name": "campfire",
		"emitters": [
			{"shape": "sphere", "radius": 0.25, "rate": 40, "maxParticles": 120, "lifetime": [0.6, 1.2],
				"velocity": {"dir": [0, 1, 0], "speed": [0.8, 1.6], "spread": 0.2}, "gravity": -0.5,
				"colorRamp": [{"t": 0.0, "color": "#ffe08a", "alpha": 1.0}, {"t": 0.5, "color": "#ff7a1a", "alpha": 0.8}, {"t": 1.0, "color": "#7a1a00", "alpha": 0.0}],
				"sizeCurve": [{"t": 0.0, "size": 0.25}, {"t": 1.0, "size": 0.05}], "sprite": "flame", "blend": "additive"},
			{"shape": "point", "rate": 6, "maxParticles": 40, "lifetime": [2.0, 3.5],
				"velocity": {"dir": [0, 1, 0], "speed": [0.4, 0.8], "spread": 0.15},
				"colorRamp": [{"t": 0.0, "color": "#555555", "alpha": 0.5}, {"t": 1.0, "color": "#999999", "alpha": 0.0}],
				"sizeCurve": [{"t": 0.0, "size": 0.3}, {"t": 1.0, "size": 1.2}], "sprite": "smoke", "blend": "alpha", "offset": [0, 0.6, 0]},
		],
		"lights": [{"color": "#ff9a3c", "intensity": 2.5, "range": 7.0, "flicker": 0.35, "offset": [0, 0.6, 0]}],
	}
	add_child(fx)


func _chat(bbcode: String) -> void:
	chat.append_text(bbcode + "\n")


func _log(bbcode: String) -> void:
	log_box.append_text(bbcode + "\n")
