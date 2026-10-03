class_name LiveBoss
extends Node
## Adaptive boss glue: maps Director output (phase plans, boss.move_added, boss.adapt) onto your move ids.
##
## [codeblock]
## # move_map: {"dummy_spin": "spin", "dummy_slam": "slam"}  (Liveforge engine move id -> your move id)
## $Boss.move_triggered.connect(func(move, params, _spec): $Dummy.call(move, params))
## $Boss.taunt.connect(func(text): $Subtitle.text = text)
## $Boss.request_phase(2, 0.5)
## $Boss.perform_next()
## [/codeblock]

## The boss learned a move. engine_move_id is "" for invented grammar-only moves.
signal move_added(move: Dictionary, engine_move_id: String, params: Dictionary)
## Run this move now (your move id from move_map, its params, the grammar MoveSpec or {}).
signal move_triggered(user_move: String, params: Dictionary, move: Dictionary)
## A taunt line to show / speak.
signal taunt(text: String)
## Aggression / attunement changed.
signal adapted(aggression: float, attune: String)
## A phase plan arrived (instant, then again after the AI upgrade). moves = current rotation.
signal phase_planned(phase: int, moves: Array, why: String)

## Boss id from the manifest (bosses[].id).
@export var boss_id: String = ""
## Liveforge engine move id -> your move id (method / animation name). Missing entries use the same id.
@export var move_map: Dictionary = {}
## Optional: call methods named after your move ids on this node (method(params: Dictionary)).
@export var call_methods_on: NodePath

## Current rotation: [{id, engine_id, params, grammar, weight}].
var moves: Array = []
var aggression := 0.5
var attune := ""
var phase := 1


func _ready() -> void:
	for engine_id in move_map:
		moves.append({"id": str(engine_id), "engine_id": str(engine_id), "params": {}, "grammar": {}, "weight": 1.0})
	var lf := LiveforgeUtil.lf(self)
	if lf == null:
		push_warning("[liveforge] LiveBoss: the Liveforge autoload is missing (enable the Liveforge plugin).")
		return
	lf.directive.connect(_on_directive)


## Asks the Director for a phase plan (director.boss_phase); applies the instant plan, then the AI upgrade.
func request_phase(p_phase: int, hp: float = -1.0, habits: Dictionary = {}, gear: Array = []) -> LiveforgeAsk:
	var lf := LiveforgeUtil.lf(self)
	if lf == null:
		return null
	phase = p_phase
	var existing: Array = []
	for m in moves:
		existing.append(m.id)
	var params := {"boss": boss_id, "phase": p_phase, "existing": existing}
	if hp >= 0.0:
		params["hp"] = clampf(hp, 0.0, 1.0)
	if not habits.is_empty():
		params["habits"] = habits
	if not gear.is_empty():
		params["gear"] = gear
	var a: LiveforgeAsk = lf.ask("director.boss_phase", params)
	a.answered.connect(_apply_plan.bind(a))
	a.upgraded.connect(_apply_plan.bind(a))
	return a


## Adds a move (also called for boss.move_added directives).
func learn(move: Dictionary, engine: Dictionary = {}) -> void:
	var engine_id := str(engine.get("moveId", ""))
	if engine_id.is_empty() and typeof(move.get("engine")) == TYPE_DICTIONARY:
		engine = move.engine
		engine_id = str(engine.get("moveId", ""))
	var id := engine_id if not engine_id.is_empty() else str(move.get("name", "move"))
	var params: Dictionary = engine.get("params", {}) if typeof(engine.get("params")) == TYPE_DICTIONARY else {}
	var found := false
	for m in moves:
		if m.id == id:
			m.grammar = move
			m.params = params
			found = true
	if not found:
		moves.append({"id": id, "engine_id": engine_id, "params": params, "grammar": move, "weight": 1.0})
	move_added.emit(move, engine_id, params)
	if move.has("taunt") and not str(move.taunt).is_empty():
		taunt.emit(str(move.taunt))


## Runs a move by id (engine move id or grammar name). Returns false when unknown.
func perform(id: String) -> bool:
	for m in moves:
		if m.id == id:
			_run(m)
			return true
	if move_map.has(id):
		_run({"id": id, "engine_id": id, "params": {}, "grammar": {}, "weight": 1.0})
		return true
	return false


## Picks a move by weight and runs it. Returns it ({} when the rotation is empty).
func perform_next() -> Dictionary:
	var total := 0.0
	for m in moves:
		total += maxf(0.0, float(m.weight))
	if total <= 0.0:
		return {}
	var x := randf() * total
	for m in moves:
		x -= maxf(0.0, float(m.weight))
		if x <= 0.0:
			_run(m)
			return m
	_run(moves[moves.size() - 1])
	return moves[moves.size() - 1]


## Signal helpers (source = this boss).
func report_dodge(direction: String = "", attack: String = "") -> void:
	var data := {"source": boss_id}
	if not direction.is_empty():
		data["direction"] = direction
	if not attack.is_empty():
		data["attack"] = attack
	_send("combat.dodged", data)


func report_hit(damage: float, weapon: String = "") -> void:
	var data := {"target": boss_id, "target_type": "boss", "damage": damage}
	if not weapon.is_empty():
		data["weapon"] = weapon
	_send("combat.hit", data)


func report_hurt(damage: float, hp: float, attack: String = "") -> void:
	var data := {"source": boss_id, "source_type": "boss", "damage": damage, "hp": clampf(hp, 0.0, 1.0)}
	if not attack.is_empty():
		data["attack"] = attack
	_send("combat.hurt", data)


func report_block(attack: String = "") -> void:
	_send("combat.blocked", {"source": boss_id} if attack.is_empty() else {"source": boss_id, "attack": attack})


# ---- internals


func _send(type: String, data: Dictionary) -> void:
	var lf := LiveforgeUtil.lf(self)
	if lf != null:
		lf.send_signal(type, data)


func _run(m: Dictionary) -> void:
	var engine_id := str(m.get("engine_id", ""))
	var user_move := str(move_map.get(engine_id, engine_id)) if not engine_id.is_empty() else str(m.id)
	var params: Dictionary = m.get("params", {})
	var grammar: Dictionary = m.get("grammar", {})
	move_triggered.emit(user_move, params, grammar)
	if not call_methods_on.is_empty():
		var target := get_node_or_null(call_methods_on)
		if target != null and target.has_method(user_move):
			target.call(user_move, params)


func _apply_plan(result: Dictionary, a: LiveforgeAsk) -> void:
	var next: Array = []
	var known := {}
	for m in moves:
		known[m.id] = true
	for plan in result.get("moves", []):
		if typeof(plan) != TYPE_DICTIONARY:
			continue
		var engine: Dictionary = plan.get("engine", {}) if typeof(plan.get("engine")) == TYPE_DICTIONARY else {}
		var grammar: Dictionary = plan.get("grammar", {}) if typeof(plan.get("grammar")) == TYPE_DICTIONARY else {}
		if engine.is_empty() and typeof(grammar.get("engine")) == TYPE_DICTIONARY:
			engine = grammar.engine
		var engine_id := str(engine.get("moveId", ""))
		var id := engine_id if not engine_id.is_empty() else str(grammar.get("name", ""))
		if id.is_empty():
			continue
		var params: Dictionary = engine.get("params", {}) if typeof(engine.get("params")) == TYPE_DICTIONARY else {}
		next.append({"id": id, "engine_id": engine_id, "params": params, "grammar": grammar, "weight": float(plan.get("weight", 1.0))})
		if not grammar.is_empty() and not known.has(id):
			move_added.emit(grammar, engine_id, params)
	if not next.is_empty():
		moves = next
	aggression = float(result.get("aggression", aggression))
	phase_planned.emit(phase, moves, a.why)
	if not str(result.get("taunt", "")).is_empty():
		taunt.emit(str(result.taunt))


func _on_directive(kind: String, d: Dictionary) -> void:
	var args: Dictionary = d.get("args", {})
	if str(d.get("target", "")) != "boss:" + boss_id and str(args.get("boss", "")) != boss_id:
		return
	match kind:
		"boss.move_added":
			var engine: Dictionary = args.get("engineMove", {}) if typeof(args.get("engineMove")) == TYPE_DICTIONARY else {}
			learn(args.get("move", {}), engine)
		"boss.adapt":
			if args.has("aggression"):
				aggression = float(args.aggression)
			if args.has("attune"):
				attune = "" if args.attune == null else str(args.attune)
			if typeof(args.get("weights")) == TYPE_DICTIONARY:
				for m in moves:
					if (args.weights as Dictionary).has(m.id):
						m.weight = float(args.weights[m.id])
			adapted.emit(aggression, attune)
			if not str(args.get("taunt", "")).is_empty():
				taunt.emit(str(args.taunt))
