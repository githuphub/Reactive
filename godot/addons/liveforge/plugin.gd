@tool
extends EditorPlugin
## Registers the Liveforge autoload, the project settings (Project Settings > Liveforge) and the editor dock.
## The Live* nodes (LiveNPC, LiveBoss, LiveDirector, LiveEquipSlot, LiveSpawner, LiveQuestBoard, LiveVFX,
## LiveBlueprint) are global classes (class_name), so they appear in the Create Node dialog on their own.

const AUTOLOAD_NAME := "Liveforge"
const AUTOLOAD_PATH := "res://addons/liveforge/liveforge.gd"
const Util := preload("res://addons/liveforge/nodes/live_util.gd")
const Dock := preload("res://addons/liveforge/editor/dock.gd")

var _dock: Control


func _enter_tree() -> void:
	_add_settings()
	_dock = Dock.new()
	_dock.name = "Liveforge"
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, _dock)


func _exit_tree() -> void:
	if _dock != null:
		remove_control_from_docks(_dock)
		_dock.queue_free()
		_dock = null


func _enable_plugin() -> void:
	if not ProjectSettings.has_setting("autoload/" + AUTOLOAD_NAME):
		add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)


func _disable_plugin() -> void:
	if ProjectSettings.has_setting("autoload/" + AUTOLOAD_NAME):
		remove_autoload_singleton(AUTOLOAD_NAME)


func _add_settings() -> void:
	var changed := false
	for key in Util.SETTINGS:
		var value: Variant = Util.SETTINGS[key]
		if not ProjectSettings.has_setting(key):
			ProjectSettings.set_setting(key, value)
			changed = true
		ProjectSettings.set_initial_value(key, value)
		var info := {"name": key, "type": typeof(value)}
		if key == "liveforge/server/game_key":
			info["hint"] = PROPERTY_HINT_PLACEHOLDER_TEXT
			info["hint_string"] = "pk_dev_<gameId> (publishable key, never the admin key)"
		ProjectSettings.add_property_info(info)
		ProjectSettings.set_as_basic(key, true)
	if changed:
		ProjectSettings.save()
