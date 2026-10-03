extends Node
## Liveforge autoload (K0 skeleton; K4 implements): HTTPRequest pool, WebSocketPeer, signal batching,
## asks with instant + upgrade, directives, fallback packs. Wire format: packages/protocol/schema/v1/*.json.

signal directive_received(directive: Dictionary)
signal ask_answered(id: String, response: Dictionary)
signal ask_upgraded(id: String, response: Dictionary)

@export var server_url := "http://localhost:8787"
@export var sdk_key := ""
@export var world := "default"
@export var player := "player"


func emit_signal_event(_type: String, _data: Dictionary = {}) -> void:
	push_warning("Liveforge: emit_signal_event not implemented yet (K4)")


func ask(_kind: String, _params: Dictionary = {}) -> String:
	push_warning("Liveforge: ask not implemented yet (K4)")
	return ""
