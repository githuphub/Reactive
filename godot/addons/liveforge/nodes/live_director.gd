class_name LiveDirector
extends Node
## Pacing / encounter glue: turns Director directives into Godot signals and asks for pacing decisions.
##
## [codeblock]
## $Director.spawn_wave.connect(func(args, _d): $Spawner.run_wave(args))
## $Director.breather.connect(func(sec): $Music.calm(sec))
## $Director.request_pacing(0.8, enemies_alive, player_hp)
## [/codeblock]

## Result of request_pacing: action = spawn | breather | loot | hold | escalate.
signal pacing(action: String, tension: float, why: String)
signal spawn_wave(args: Dictionary, directive: Dictionary)
signal breather(seconds: float)
signal difficulty_changed(aggression: float, mode: String)
signal objective(args: Dictionary)
signal moment(moment: Dictionary)
signal loot_dropped(items: Array)
## Tactic assignments from request_encounter: [{unit, tactic, target?}].
signal tactics(assignments: Array, modifiers: Array)

## Ask for pacing every N seconds (0 = only when you call request_pacing).
@export var auto_pacing_interval := 0.0
@export var zone := ""

var tension := 0.0
var aggression := 0.5
## Game-measured intensity / state used by auto pacing (update these from your game).
var intensity := -1.0
var enemies_alive := -1
var player_hp := -1.0

var _timer: Timer


func _ready() -> void:
	var lf := LiveforgeUtil.lf(self)
	if lf == null:
		push_warning("[liveforge] LiveDirector: the Liveforge autoload is missing (enable the Liveforge plugin).")
		return
	lf.directive.connect(_on_directive)
	if auto_pacing_interval > 0.0:
		_timer = Timer.new()
		_timer.wait_time = auto_pacing_interval
		_timer.autostart = true
		_timer.timeout.connect(func(): request_pacing(intensity, enemies_alive, player_hp))
		add_child(_timer)


## Asks director.pacing (negative values = let the server derive them from recent signals).
func request_pacing(p_intensity: float = -1.0, p_enemies_alive: int = -1, p_player_hp: float = -1.0) -> LiveforgeAsk:
	var lf := LiveforgeUtil.lf(self)
	if lf == null:
		return null
	var params := {}
	if not zone.is_empty():
		params["zone"] = zone
	if p_intensity >= 0.0:
		params["intensity"] = clampf(p_intensity, 0.0, 1.0)
	if p_enemies_alive >= 0:
		params["enemiesAlive"] = p_enemies_alive
	if p_player_hp >= 0.0:
		params["playerHp"] = clampf(p_player_hp, 0.0, 1.0)
	var a: LiveforgeAsk = lf.ask("director.pacing", params)
	a.answered.connect(_on_pacing.bind(a))
	a.upgraded.connect(_on_pacing.bind(a))
	return a


## Asks director.encounter for squad tactics. units: [{id, type, elite?, modifiers?}].
func request_encounter(units: Array, encounter: String = "") -> LiveforgeAsk:
	var lf := LiveforgeUtil.lf(self)
	if lf == null:
		return null
	var params := {"units": units}
	if not encounter.is_empty():
		params["encounter"] = encounter
	if not zone.is_empty():
		params["zone"] = zone
	var a: LiveforgeAsk = lf.ask("director.encounter", params)
	a.answered.connect(_on_encounter)
	a.upgraded.connect(_on_encounter)
	return a


func _on_pacing(r: Dictionary, a: LiveforgeAsk) -> void:
	tension = float(r.get("tension", tension))
	if r.has("aggression"):
		aggression = float(r.aggression)
	pacing.emit(str(r.get("action", "hold")), tension, a.why)
	# Directives in the answer are also pushed over WS; apply them locally only when the socket is down.
	var lf := LiveforgeUtil.lf(self)
	if lf != null and lf.status != "open":
		for d in r.get("directives", []):
			if typeof(d) == TYPE_DICTIONARY:
				_on_directive(str(d.get("kind", "")), d)


func _on_encounter(r: Dictionary) -> void:
	aggression = float(r.get("aggression", aggression))
	tactics.emit(r.get("assignments", []), r.get("modifiers", []))


func _on_directive(kind: String, d: Dictionary) -> void:
	var args: Dictionary = d.get("args", {})
	match kind:
		"spawn.wave":
			spawn_wave.emit(args, d)
		"pacing.breather":
			breather.emit(float(args.get("seconds", 10.0)))
		"difficulty.set":
			aggression = float(args.get("aggression", aggression))
			difficulty_changed.emit(aggression, str(args.get("mode", "hidden")))
		"objective.dynamic":
			objective.emit(args)
		"moment":
			moment.emit(args.get("moment", {}))
		"loot.drop":
			loot_dropped.emit(args.get("items", []))
