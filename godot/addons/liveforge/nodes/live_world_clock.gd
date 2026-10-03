class_name LiveWorldClock
extends Node
## Reaction Library (R1): a simple day/night + weather clock that reports world.time to Liveforge (only when the
## hour, phase, day or weather changes). Optionally turns a DirectionalLight3D as the sun.
##
## [codeblock]
## var clock := LiveWorldClock.new()
## clock.day_length_min = 12.0
## clock.sun = $Sun
## add_child(clock)
## clock.set_weather("rain")
## [/codeblock]

## The in-game hour changed (whole hours).
signal hour_changed(hour: int, day: int)
## dawn | day | dusk | night
signal phase_changed(phase: String)
## clear | rain | storm | snow | fog | heat
signal weather_changed(weather: String)

## Real minutes per in-game day.
@export var day_length_min := 24.0
## Hour the clock starts at.
@export_range(0.0, 24.0) var start_hour := 9.0
## Current weather.
@export_enum("clear", "rain", "storm", "snow", "fog", "heat") var weather := "clear"
## Change the weather now and then (seeded per day).
@export var auto_weather := false
## Weathers auto_weather picks from.
@export var weather_pool: PackedStringArray = ["clear", "clear", "rain", "fog", "storm"]
## Optional sun to rotate (x axis) with the hour.
@export var sun: DirectionalLight3D
## Pause the clock.
@export var paused := false

var hour := 9.0
var day := 0
var _phase := ""
var _last_hour := -1


func _ready() -> void:
	hour = start_hour
	_report(true)


func _process(delta: float) -> void:
	if paused:
		return
	hour += delta * 24.0 / maxf(0.1, day_length_min * 60.0)
	if hour >= 24.0:
		hour -= 24.0
		day += 1
		if auto_weather and not weather_pool.is_empty():
			var rng := RandomNumberGenerator.new()
			rng.seed = hash("%d" % day)
			set_weather(weather_pool[rng.randi() % weather_pool.size()])
	if sun != null:
		sun.rotation_degrees.x = -((hour - 6.0) / 12.0) * 180.0
	_report(false)


## Jump to an hour (0-24).
func set_hour(h: float) -> void:
	hour = fposmod(h, 24.0)
	_report(true)


## Change the weather and report it.
func set_weather(w: String) -> void:
	if w == weather:
		return
	weather = w
	weather_changed.emit(w)
	_report(true)


## Current phase: dawn | day | dusk | night.
func phase() -> String:
	return LiveforgeUtil.day_phase(hour)


func _report(force: bool) -> void:
	var h := int(floor(hour))
	var p := phase()
	if p != _phase:
		_phase = p
		phase_changed.emit(p)
	if h == _last_hour and not force:
		return
	_last_hour = h
	hour_changed.emit(h, day)
	var lf := LiveforgeUtil.lf(self)
	if lf != null:
		lf.set_world_time(hour, day, weather, force)
