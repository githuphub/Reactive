@tool
extends EditorPlugin
## Liveforge editor plugin (K0 skeleton; K4 implements the dock: connect, validate manifest, fire test signals,
## watch directives).

const AUTOLOAD_NAME := "Liveforge"


func _enter_tree() -> void:
	add_autoload_singleton(AUTOLOAD_NAME, "res://addons/liveforge/liveforge.gd")


func _exit_tree() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)
