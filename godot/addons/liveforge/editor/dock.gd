@tool
extends VBoxContainer
## Liveforge editor dock: connect / test, validate the manifest via the server, fire test signals, watch the
## live directive log. The admin key typed here is kept in memory only (never saved to the project).

const Util := preload("res://addons/liveforge/nodes/live_util.gd")

var _url: LineEdit
var _key: LineEdit
var _world: LineEdit
var _player: LineEdit
var _admin: LineEdit
var _manifest: LineEdit
var _status: Label
var _signal_type: OptionButton
var _signal_data: LineEdit
var _watch: Button
var _log: RichTextLabel
var _ws: WebSocketPeer
var _ws_state := -1


func _ready() -> void:
	custom_minimum_size = Vector2(240, 0)
	_add_title("Server")
	_url = _add_field("URL", str(Util.setting("liveforge/server/url")), "http://localhost:8787")
	_key = _add_field("Game key", str(Util.setting("liveforge/server/game_key")), "pk_dev_<gameId>")
	_world = _add_field("World", str(Util.setting("liveforge/session/world")), "default")
	_player = _add_field("Player", str(Util.setting("liveforge/session/player")), "player1")
	var row := HBoxContainer.new()
	add_child(row)
	_add_button(row, "Save to project", _save_settings)
	_add_button(row, "Test connection", _test_connection)
	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_status.text = "Not connected."
	add_child(_status)

	_add_title("Manifest")
	_manifest = _add_field("File", "res://liveforge.yaml", "res://liveforge.yaml")
	_admin = _add_field("Admin key", "", "dev-admin (memory only)")
	_admin.secret = true
	var vrow := HBoxContainer.new()
	add_child(vrow)
	_add_button(vrow, "Validate on server", _validate_manifest)

	_add_title("Test signal")
	_signal_type = OptionButton.new()
	for t in Util.BUILTIN_SIGNALS:
		_signal_type.add_item(t)
	add_child(_signal_type)
	_signal_data = _add_field("Data (JSON)", "{\"source\": \"editor\"}", "{\"source\": \"boss\"}")
	var srow := HBoxContainer.new()
	add_child(srow)
	_add_button(srow, "Fire signal", _fire_signal)

	_add_title("Directives")
	var drow := HBoxContainer.new()
	add_child(drow)
	_watch = _add_button(drow, "Watch directives", _toggle_watch)
	_add_button(drow, "Clear", _clear_log)
	_log = RichTextLabel.new()
	_log.bbcode_enabled = true
	_log.scroll_following = true
	_log.selection_enabled = true
	_log.custom_minimum_size = Vector2(0, 220)
	_log.size_flags_vertical = Control.SIZE_EXPAND_FILL
	add_child(_log)


func _process(_delta: float) -> void:
	if _ws == null:
		return
	_ws.poll()
	var st := _ws.get_ready_state()
	if st != _ws_state:
		_ws_state = st
		if st == WebSocketPeer.STATE_OPEN:
			_ws.send_text(JSON.stringify({"t": "subscribe", "world": _world.text, "player": _player.text}))
			_line("[color=green]watching %s / %s[/color]" % [_world.text, _player.text])
		elif st == WebSocketPeer.STATE_CLOSED:
			_line("[color=orange]socket closed (%d %s)[/color]" % [_ws.get_close_code(), _ws.get_close_reason()])
			_ws = null
			_watch.text = "Watch directives"
			return
	while _ws.get_available_packet_count() > 0:
		var msg: Variant = JSON.parse_string(_ws.get_packet().get_string_from_utf8())
		if typeof(msg) != TYPE_DICTIONARY:
			continue
		match str(msg.get("t", "")):
			"directive":
				var d: Dictionary = msg.get("directive", {})
				_line("[b]%s[/b] -> %s  [color=gray]%s[/color]\n    %s" % [d.get("kind", "?"), d.get("target", "?"), d.get("why", ""), JSON.stringify(d.get("args", {}))])
			"upgrade":
				var r: Dictionary = msg.get("response", {})
				_line("[color=cyan]upgrade[/color] %s %s" % [r.get("kind", "?"), str(r.get("why", ""))])
			"error":
				_line("[color=red]error[/color] %s" % JSON.stringify(msg.get("error", {})))
			"welcome":
				_line("[color=gray]welcome: game %s[/color]" % str(msg.get("game", "?")))


func _save_settings() -> void:
	ProjectSettings.set_setting("liveforge/server/url", _url.text.strip_edges().trim_suffix("/"))
	ProjectSettings.set_setting("liveforge/server/game_key", _key.text.strip_edges())
	ProjectSettings.set_setting("liveforge/session/world", _world.text.strip_edges())
	ProjectSettings.set_setting("liveforge/session/player", _player.text.strip_edges())
	ProjectSettings.save()
	_status.text = "Saved to Project Settings > Liveforge."


func _test_connection() -> void:
	_status.text = "Connecting..."
	_http(HTTPClient.METHOD_GET, "/v1/config", _key.text, "", "", _on_config_tested)


func _on_config_tested(_code: int, data: Variant, err: String) -> void:
	if not err.is_empty() or typeof(data) != TYPE_DICTIONARY:
		_status.text = "Failed: " + (err if not err.is_empty() else "no config returned")
		return
	var game: Dictionary = data.get("game", {})
	var personas: Array = data.get("personas", [])
	var bosses: Array = data.get("bosses", [])
	var names := PackedStringArray()
	for p in personas:
		if typeof(p) == TYPE_DICTIONARY:
			names.append(str(p.get("name", p.get("id", "?"))))
	var asks: Array = data.get("askKinds", [])
	var kinds: Array = data.get("directiveKinds", [])
	_status.text = "Connected to %s (%s).
Personas: %s
Bosses: %d, ask kinds: %d, directive kinds: %d" % [
		str(game.get("name", "?")), str(game.get("id", "?")), ", ".join(names), bosses.size(), asks.size(), kinds.size()]


func _validate_manifest() -> void:
	var path := _manifest.text.strip_edges()
	if not FileAccess.file_exists(path):
		_line("[color=red]manifest not found: %s[/color]" % path)
		return
	if _admin.text.strip_edges().is_empty():
		_line("[color=orange]validation needs the admin key (dev mode: dev-admin)[/color]")
		return
	var text := FileAccess.get_file_as_string(path)
	var ctype := "application/json" if path.ends_with(".json") else "application/yaml"
	_line("validating %s ..." % path)
	_http(HTTPClient.METHOD_POST, "/admin/manifest/validate", _admin.text.strip_edges(), text, ctype, _on_validated)


func _on_validated(_code: int, data: Variant, err: String) -> void:
	if typeof(data) == TYPE_DICTIONARY:
		var issues: Variant = data.get("issues", data.get("errors"))
		if typeof(issues) == TYPE_ARRAY:
			if (issues as Array).is_empty():
				_line("[color=green]manifest OK[/color]")
			for i in issues:
				if typeof(i) == TYPE_DICTIONARY:
					_line("[color=red]line %s[/color] %s: %s" % [str(i.get("line", "?")), str(i.get("path", "")), str(i.get("message", ""))])
				else:
					_line(str(i))
			return
		if bool(data.get("ok", data.get("valid", false))):
			_line("[color=green]manifest OK[/color]")
			return
	if not err.is_empty():
		_line("[color=red]%s[/color]" % err)
	else:
		_line(JSON.stringify(data))


func _fire_signal() -> void:
	var data: Variant = JSON.parse_string(_signal_data.text) if not _signal_data.text.strip_edges().is_empty() else {}
	if typeof(data) != TYPE_DICTIONARY:
		_line("[color=red]signal data must be a JSON object[/color]")
		return
	var type := _signal_type.get_item_text(_signal_type.selected)
	var body := {"signals": [{"type": type, "data": data, "ts": Util.now_ms(), "world": _world.text, "player": _player.text, "session": "editor"}]}
	_http(HTTPClient.METHOD_POST, "/v1/signals", _key.text, JSON.stringify(body), "application/json", _on_signal_fired.bind(type))


func _on_signal_fired(_code: int, res: Variant, err: String, type: String) -> void:
	if not err.is_empty():
		_line("[color=red]%s failed: %s[/color]" % [type, err])
	else:
		_line("[color=green]%s sent[/color] %s" % [type, JSON.stringify(res)])


func _toggle_watch() -> void:
	if _ws != null:
		_ws.close()
		_ws = null
		_watch.text = "Watch directives"
		_line("[color=gray]stopped[/color]")
		return
	var base := _url.text.strip_edges().trim_suffix("/").replace("https://", "wss://").replace("http://", "ws://")
	var key := _admin.text.strip_edges() if not _admin.text.strip_edges().is_empty() else _key.text.strip_edges()
	_ws = WebSocketPeer.new()
	_ws_state = -1
	var err := _ws.connect_to_url("%s/v1/ws?key=%s&world=%s&player=%s" % [base, key.uri_encode(), _world.text.uri_encode(), _player.text.uri_encode()])
	if err != OK:
		_line("[color=red]cannot open socket: %s[/color]" % error_string(err))
		_ws = null
		return
	_watch.text = "Stop watching"


## Minimal HTTP helper (the autoload does not run inside the editor). cb(code, data, error).
func _http(method: int, path: String, key: String, body: String, content_type: String, cb: Callable) -> void:
	var req := HTTPRequest.new()
	req.timeout = 10.0
	add_child(req)
	var headers := PackedStringArray(["x-liveforge-key: " + key.strip_edges(), "x-liveforge-protocol: liveforge-protocol/1", "accept: application/json"])
	if not content_type.is_empty():
		headers.append("content-type: " + content_type)
	req.request_completed.connect(_on_http_done.bind(req, cb), CONNECT_ONE_SHOT)
	var url := _url.text.strip_edges().trim_suffix("/") + path
	var e := req.request(url, headers, method, body) if not body.is_empty() else req.request(url, headers, method)
	if e != OK:
		req.queue_free()
		cb.call(0, {}, "request failed: " + error_string(e))


func _on_http_done(result: int, code: int, _headers: PackedStringArray, raw: PackedByteArray, req: HTTPRequest, cb: Callable) -> void:
	req.queue_free()
	var data: Variant = JSON.parse_string(raw.get_string_from_utf8()) if raw.size() > 0 else null
	var err := ""
	if result != HTTPRequest.RESULT_SUCCESS:
		err = "cannot reach %s (result %d)" % [_url.text, result]
	elif code >= 400:
		err = "HTTP %d" % code
		if typeof(data) == TYPE_DICTIONARY and typeof(data.get("error")) == TYPE_DICTIONARY:
			err += ": " + str(data.error.get("message", ""))
	cb.call(code, data if data != null else {}, err)


func _add_title(text: String) -> void:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", 15)
	add_child(l)


func _add_field(label: String, value: String, placeholder: String) -> LineEdit:
	var row := HBoxContainer.new()
	var l := Label.new()
	l.text = label
	l.custom_minimum_size = Vector2(80, 0)
	row.add_child(l)
	var e := LineEdit.new()
	e.text = value
	e.placeholder_text = placeholder
	e.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(e)
	add_child(row)
	return e


func _add_button(parent: Node, text: String, cb: Callable) -> Button:
	var b := Button.new()
	b.text = text
	b.pressed.connect(cb)
	parent.add_child(b)
	return b


func _clear_log() -> void:
	_log.clear()


func _line(bbcode: String) -> void:
	if _log != null:
		_log.append_text(bbcode + "\n")
