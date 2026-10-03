class_name LiveforgeReply
extends RefCounted
## Result of a one-shot Liveforge request (config, STT, snapshot, manifest validation).
##
## [codeblock]
## var r := Liveforge.stt(wav_bytes)
## var data: Dictionary = await r.completed   # {} on failure; check r.ok / r.error_message
## [/codeblock]

## Emitted once with the response body ({} when the request failed).
signal completed(data: Dictionary)
## Emitted (before completed) when the request failed.
signal failed(code: String, message: String)

var ok := false
var data: Dictionary = {}
var status := 0
var error_code: String = ""
var error_message: String = ""
var is_done := false


func _finish(p_status: int, p_data: Variant, code: String, message: String) -> void:
	if is_done:
		return
	is_done = true
	status = p_status
	ok = code.is_empty()
	if typeof(p_data) == TYPE_DICTIONARY:
		data = p_data
	elif typeof(p_data) == TYPE_ARRAY:
		data = {"items": p_data}
	if not ok:
		error_code = code
		error_message = message
		failed.emit(code, message)
	completed.emit(data if ok else {})
