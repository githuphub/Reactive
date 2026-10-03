class_name LiveSpawner
extends Node3D
## Turns spawn.wave directives into instances of your unit scenes; pauses during pacing.breather.
## A wave is accepted when it targets "spawner:<spawner_id>", names this spawner in args.spawner, or names
## this spawner's zone (or any unaddressed wave when catch_all is on).

## A unit instance was created (node is already in the tree).
signal spawned(node: Node, unit: Dictionary)
## No scene is mapped for this unit type: spawn it yourself. info = {elite, modifiers, tactic, position, index}.
signal spawn_requested(unit_type: String, info: Dictionary)
signal wave_received(args: Dictionary)
## A breather started (seconds) or ended (0).
signal breather_changed(seconds: float)

@export var spawner_id := ""
@export var zone := ""
## Unit type -> PackedScene.
@export var unit_scenes: Dictionary = {}
## Where instances are added (default: this node's parent).
@export var spawn_parent: NodePath
@export var spread := 2.0
@export var catch_all := false
@export var max_per_wave := 50

var _breather_until_ms := 0
var _deferred: Array = []


func _ready() -> void:
	var lf := LiveforgeUtil.lf(self)
	if lf == null:
		push_warning("[liveforge] LiveSpawner: the Liveforge autoload is missing (enable the Liveforge plugin).")
		return
	lf.directive.connect(_on_directive)


func _process(_delta: float) -> void:
	if _breather_until_ms > 0 and Time.get_ticks_msec() >= _breather_until_ms:
		_breather_until_ms = 0
		breather_changed.emit(0.0)
		var waves := _deferred.duplicate()
		_deferred.clear()
		for w in waves:
			run_wave(w)


## True during a breather (waves wait until it ends).
func is_paused() -> bool:
	return _breather_until_ms > 0


## Starts a breather locally (also triggered by pacing.breather).
func breathe(seconds: float) -> void:
	_breather_until_ms = Time.get_ticks_msec() + int(seconds * 1000.0)
	breather_changed.emit(seconds)


## Spawns a wave now ({units: [{type, count, elite?, modifiers?, tactic?}], position?}).
func run_wave(args: Dictionary) -> void:
	wave_received.emit(args)
	var base := global_position if is_inside_tree() else position
	if typeof(args.get("position")) == TYPE_ARRAY:
		base = LiveforgeUtil.vec3(args.position, base)
	var parent: Node = get_node_or_null(spawn_parent) if not spawn_parent.is_empty() else get_parent()
	if parent == null:
		parent = self
	var budget := max_per_wave
	for unit in args.get("units", []):
		if typeof(unit) != TYPE_DICTIONARY:
			continue
		var type := str(unit.get("type", "unit"))
		for i in clampi(int(unit.get("count", 1)), 0, 50):
			if budget <= 0:
				return
			budget -= 1
			var ang := randf() * TAU
			var r := spread * sqrt(randf())
			var pos := base + Vector3(cos(ang) * r, 0.0, sin(ang) * r)
			var info := {"elite": bool(unit.get("elite", false)), "modifiers": unit.get("modifiers", []), "tactic": str(unit.get("tactic", "")), "position": pos, "index": i}
			var scene: Variant = unit_scenes.get(type)
			if scene is PackedScene:
				var node: Node = (scene as PackedScene).instantiate()
				for k in info:
					node.set_meta("liveforge_" + str(k), info[k])
				parent.add_child(node)
				if node is Node3D:
					(node as Node3D).global_position = pos
				spawned.emit(node, unit)
			else:
				spawn_requested.emit(type, info)


func _on_directive(kind: String, d: Dictionary) -> void:
	var args: Dictionary = d.get("args", {})
	var target := str(d.get("target", ""))
	if kind == "pacing.breather":
		if target.begins_with("spawner:") and target != "spawner:" + spawner_id:
			return
		breathe(float(args.get("seconds", 10.0)))
		return
	if kind != "spawn.wave" or not _accepts(target, args):
		return
	if is_paused():
		_deferred.append(args)
	else:
		run_wave(args)


func _accepts(target: String, args: Dictionary) -> bool:
	if target == "spawner:" + spawner_id or str(args.get("spawner", "")) == spawner_id:
		return not spawner_id.is_empty()
	if not str(args.get("spawner", "")).is_empty():
		return false
	if not str(args.get("zone", "")).is_empty():
		return str(args.zone) == zone
	return catch_all and not target.begins_with("spawner:")
