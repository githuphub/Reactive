extends Node
## Liveforge autoload (registered as "Liveforge" by the plugin).
##
## Signals the game reports, asks with an instant answer plus an AI upgrade, directives pushed over WebSocket,
## a fallback cache + bake packs, STT upload and snapshots. Configure in Project Settings > Liveforge
## (server url, game key, world, player) or call configure() at runtime.
##
## [codeblock]
## Liveforge.send_signal("combat.dodged", {"source": "training_dummy", "direction": "left"})
## var a := Liveforge.ask("npc.bark", {"npc": "bess", "trigger": "approach"})
## var r: Dictionary = await a.answered
## Liveforge.directive.connect(func(kind, d): print(kind, " ", d.args))
## [/codeblock]

## A directive arrived. kind = directive kind ("npc.bark", "spawn.wave" ...); data = the whole directive
## {id, kind, target, args, why, ts, world, player, source}.
signal directive(kind: String, data: Dictionary)
## WebSocket status: idle | connecting | open | reconnecting | unavailable.
signal status_changed(status: String)
## A background request failed (signal flush, rejected signal, socket error).
signal request_failed(code: String, message: String)
## GET /v1/config loaded (personas, bosses, actions, modules ...).
signal config_loaded(config: Dictionary)
## A forge job changed state ({id, state, url?}).
signal job_updated(job: Dictionary)

const WS_PATH := "/v1/ws"
const PROTOCOL_ID := "liveforge-protocol/1"
const RETRYABLE := ["network", "timeout", "rate_limited", "provider_unavailable", "internal"]

var url: String = "http://localhost:8787"
var game_key: String = ""
var world: String = "default"
var player: String = "player1"
var session: String = ""
## WebSocket status (see status_changed).
var status: String = "idle"
## Last GET /v1/config result.
var public_config: Dictionary = {}
## Answer only from cache / packs / fallbacks; never call the server for asks; drop signals.
var offline := false
## Last-good-answer cache and bake packs.
var cache: LiveforgeCache

var _flush_interval := 0.25
var _flush_size := 50
var _timeout := 8.0
var _upgrade_timeout := 45.0
var _realtime := true
var _debug := false
var _persist := true
var _queue: Array = []
var _flushing := false
var _flush_failures := 0
var _flush_timer: Timer
var _save_timer: Timer
var _pool: Array[HTTPRequest] = []
var _busy := {}
var _waiting_jobs: Array = []
var _ws: WebSocketPeer
var _ws_state := -1
var _ws_attempt := 0
var _ws_retry_at_ms := 0
var _ws_last_msg_ms := 0
var _ws_next_ping_ms := 0
var _asks := {}
var _seen: Array = []
var _seen_set := {}
var _fallbacks := {}


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	url = str(LiveforgeUtil.setting("liveforge/server/url")).strip_edges().trim_suffix("/")
	game_key = str(LiveforgeUtil.setting("liveforge/server/game_key")).strip_edges()
	world = str(LiveforgeUtil.setting("liveforge/session/world"))
	player = str(LiveforgeUtil.setting("liveforge/session/player"))
	_flush_interval = maxf(0.02, float(LiveforgeUtil.setting("liveforge/signals/flush_interval_ms")) / 1000.0)
	_flush_size = maxi(1, int(LiveforgeUtil.setting("liveforge/signals/flush_size")))
	_timeout = maxf(1.0, float(LiveforgeUtil.setting("liveforge/http/timeout_sec")))
	_upgrade_timeout = maxf(1.0, float(LiveforgeUtil.setting("liveforge/asks/upgrade_timeout_sec")))
	_realtime = bool(LiveforgeUtil.setting("liveforge/realtime/enabled"))
	_debug = bool(LiveforgeUtil.setting("liveforge/debug/log"))
	_persist = bool(LiveforgeUtil.setting("liveforge/cache/persist"))
	session = LiveforgeUtil.new_id("s")
	cache = LiveforgeCache.new()
	if _persist:
		cache.load_from_disk()
	for i in maxi(1, int(LiveforgeUtil.setting("liveforge/http/pool_size"))):
		var r := HTTPRequest.new()
		r.name = "Http%d" % i
		add_child(r)
		_pool.append(r)
	_flush_timer = Timer.new()
	_flush_timer.one_shot = true
	_flush_timer.timeout.connect(flush)
	add_child(_flush_timer)
	_save_timer = Timer.new()
	_save_timer.wait_time = 5.0
	_save_timer.autostart = true
	_save_timer.timeout.connect(_save_cache)
	add_child(_save_timer)
	if game_key.is_empty():
		push_warning("[liveforge] Project Settings > liveforge/server/game_key is empty. In dev mode use pk_dev_<gameId>.")
	if not offline:
		fetch_config()
		if _realtime:
			_ws_connect()


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		_save_cache()
		if not _queue.is_empty() and not offline:
			flush()


## Changes connection settings at runtime. Keys: url, game_key, world, player, offline, realtime.
func configure(opts: Dictionary) -> void:
	if opts.has("url"):
		url = str(opts.url).strip_edges().trim_suffix("/")
	if opts.has("game_key"):
		game_key = str(opts.game_key)
	if opts.has("world"):
		world = str(opts.world)
	if opts.has("player"):
		player = str(opts.player)
	if opts.has("offline"):
		offline = bool(opts.offline)
	if opts.has("realtime"):
		_realtime = bool(opts.realtime)
	_ws_close()
	if _realtime and not offline:
		_ws_connect()
	if not offline:
		fetch_config()


## Switches player (and optionally world) without reconnecting.
func set_player(p_player: String, p_world: String = "") -> void:
	if p_world.is_empty():
		p_world = world
	flush()
	if _ws != null and _ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_ws_send({"t": "unsubscribe", "world": world, "player": player})
		_ws_send({"t": "subscribe", "world": p_world, "player": p_player})
	player = p_player
	world = p_world


# ================================================================================================ signals


## Reports a fact (fire-and-forget, batched). Use the built-in vocabulary ("combat.dodged", "economy.gold" ...)
## or custom types declared in the manifest. ("signal" is a GDScript keyword, hence send_signal.)
func send_signal(type: String, data: Dictionary = {}) -> void:
	if not _valid_signal_type(type):
		_report("invalid_input", "signal type \"%s\" is invalid: use dotted lowercase like \"combat.dodged\"" % type)
		return
	if offline:
		return
	_queue.append({"type": type, "data": data, "ts": LiveforgeUtil.now_ms(), "player": player, "world": world, "session": session})
	if _queue.size() > 2000:
		_queue = _queue.slice(_queue.size() - 2000)
	if _queue.size() >= _flush_size:
		flush()
	elif _flush_timer.is_stopped():
		_flush_timer.start(_flush_interval)


## Sends queued signals now.
func flush() -> void:
	if _flushing or _queue.is_empty() or offline:
		return
	var batch := _queue.slice(0, 500)
	_queue = _queue.slice(500)
	_flushing = true
	_request(HTTPClient.METHOD_POST, "/v1/signals", {"signals": batch}, _on_flushed.bind(batch))


func _on_flushed(code: int, data: Variant, ecode: String, emsg: String, batch: Array) -> void:
	_flushing = false
	if ecode.is_empty():
		_flush_failures = 0
		if typeof(data) == TYPE_DICTIONARY:
			for rej in data.get("rejected", []):
				var i := int(rej.get("index", -1))
				var t: String = str(batch[i].get("type", "?")) if i >= 0 and i < batch.size() else "?"
				_report(str(rej.get("code", "bad_request")), "signal \"%s\" rejected: %s" % [t, str(rej.get("message", ""))])
		if not _queue.is_empty():
			flush()
		return
	if _retryable(ecode, code):
		_queue = batch + _queue
		if _queue.size() > 2000:
			_queue = _queue.slice(_queue.size() - 2000)
		_flush_failures += 1
		if _flush_failures == 1 or _debug:
			_report(ecode, emsg)
		var delay := minf(30.0, pow(2.0, mini(_flush_failures, 5)))
		_flush_timer.start(delay)
	else:
		_report(ecode, emsg)


# ================================================================================================ asks


## Asks a module (kinds: npc.bark, npc.reply, director.*, forge.*, quest.offer, achievement.check,
## world.reactions). Returns a LiveforgeAsk: connect answered / upgraded / partial / done.
## opts: upgrade (bool, default true), timeout (sec), fallback (Dictionary result used when everything fails).
func ask(kind: String, params: Dictionary = {}, opts: Dictionary = {}) -> LiveforgeAsk:
	var a := LiveforgeAsk.new(LiveforgeUtil.new_id("a"), kind, params)
	if offline:
		_answer_locally.call_deferred(a, opts, "offline", "offline and no local answer for %s" % kind)
		return a
	_asks[a.id] = a
	var body := {"id": a.id, "world": world, "player": player, "session": session, "params": params}
	if opts.get("upgrade", true) == false:
		body["upgrade"] = false
	_request(HTTPClient.METHOD_POST, "/v1/ask/" + kind, body, _on_ask_instant.bind(a, opts), {"timeout": float(opts.get("timeout", _timeout))})
	return a


## Registers a local fallback for a kind: func(params: Dictionary) -> Dictionary result ({} = no answer).
func set_fallback(kind: String, fn: Callable) -> void:
	_fallbacks[kind] = fn


## Loads a bake pack (Dictionary or res:// / user:// JSON path). Returns the entry count (-1 if invalid).
func load_pack(pack: Variant) -> int:
	return cache.load_pack(pack)


func _on_ask_instant(code: int, data: Variant, ecode: String, emsg: String, a: LiveforgeAsk, opts: Dictionary) -> void:
	if not ecode.is_empty() or typeof(data) != TYPE_DICTIONARY or not (data as Dictionary).has("result"):
		if ecode.is_empty():
			ecode = "internal"
			emsg = "ask %s: the server returned no answer" % a.kind
		if _retryable(ecode, code) or ecode == "budget_exceeded":
			_answer_locally(a, opts, ecode, emsg)
		else:
			_asks.erase(a.id)
			a._fail(ecode, emsg)
		return
	var resp: Dictionary = data
	cache.put(a.kind, a.params, resp.get("result"), str(resp.get("source", "rules")), str(resp.get("why", "")))
	var pending := str(resp.get("upgrade", "none")) == "pending" and opts.get("upgrade", true) != false
	if pending:
		a._deadline_ms = Time.get_ticks_msec() + int(_upgrade_timeout * 1000.0)
	a._resolve_instant(resp)
	if not pending or a.is_done:
		_asks.erase(a.id)
		if not a.is_done:
			a._settle_upgrade(null)
	elif not _ws_open():
		_poll_upgrade(a)


func _answer_locally(a: LiveforgeAsk, opts: Dictionary, ecode: String, emsg: String) -> void:
	_asks.erase(a.id)
	var local := _local_answer(a.kind, a.params, opts)
	if local.is_empty():
		a._fail("no_fallback" if ecode != "offline" else "offline", emsg + " (no cached / pack / fallback answer)")
		return
	local["id"] = a.id
	local["kind"] = a.kind
	a._resolve_instant(local)
	a._settle_upgrade(null)


func _local_answer(kind: String, params: Dictionary, opts: Dictionary) -> Dictionary:
	var base := {"stage": "instant", "upgrade": "none", "ms": 0, "ts": LiveforgeUtil.now_ms()}
	var hit := cache.get_answer(kind, params)
	if not hit.is_empty():
		base.merge({"result": hit.get("result"), "source": "cache", "why": "cached answer (server unreachable)"}, true)
		return base
	var packed := cache.from_pack(kind, params)
	if not packed.is_empty():
		base.merge({"result": packed.get("result"), "source": "bake", "why": "bake pack answer"}, true)
		return base
	if _fallbacks.has(kind):
		var r: Variant = (_fallbacks[kind] as Callable).call(params)
		if typeof(r) == TYPE_DICTIONARY and not (r as Dictionary).is_empty():
			base.merge({"result": r, "source": "rules", "why": "local fallback"}, true)
			return base
	if typeof(opts.get("fallback")) == TYPE_DICTIONARY:
		base.merge({"result": opts.fallback, "source": "rules", "why": "fallback answer"}, true)
		return base
	return {}


func _accept_upgrade(resp: Dictionary) -> void:
	var a: LiveforgeAsk = _asks.get(str(resp.get("id", "")))
	if a == null:
		return
	_asks.erase(a.id)
	if resp.has("result"):
		cache.put(a.kind, a.params, resp.get("result"), "ai", str(resp.get("why", "")))
	a._settle_upgrade(resp)


## Long-poll GET /v1/upgrades/:id?wait=25 (used while the WebSocket is down).
func _poll_upgrade(a: LiveforgeAsk) -> void:
	if a._polling or a.is_done:
		return
	var left := (a._deadline_ms - Time.get_ticks_msec()) / 1000.0
	if left <= 0.0:
		return
	a._polling = true
	var wait := clampi(int(left), 1, 25)
	_request(HTTPClient.METHOD_GET, "/v1/upgrades/%s?wait=%d" % [a.id.uri_encode(), wait], null, _on_polled.bind(a), {"timeout": wait + 10.0, "dedicated": true})


func _on_polled(code: int, data: Variant, ecode: String, _emsg: String, a: LiveforgeAsk) -> void:
	a._polling = false
	if a.is_done:
		return
	if ecode.is_empty() and code == 200 and typeof(data) == TYPE_DICTIONARY:
		_accept_upgrade(data)
		return
	if ecode == "not_found":
		_asks.erase(a.id)
		a._settle_upgrade(null)
		return
	if ecode.is_empty():
		_poll_upgrade(a)  # 204: still pending
	else:
		get_tree().create_timer(2.0).timeout.connect(_poll_upgrade.bind(a))


func _tick_asks() -> void:
	if _asks.is_empty():
		return
	var now := Time.get_ticks_msec()
	for id in _asks.keys():
		var a: LiveforgeAsk = _asks[id]
		if a._deadline_ms > 0 and now > a._deadline_ms:
			_asks.erase(id)
			a._settle_upgrade(null)
		elif a._deadline_ms > 0 and not _ws_open() and not a._polling:
			_poll_upgrade(a)


# ================================================================================================ other endpoints


## GET /v1/config (also stored in public_config; emits config_loaded).
func fetch_config() -> LiveforgeReply:
	var reply := LiveforgeReply.new()
	_request(HTTPClient.METHOD_GET, "/v1/config", null, _on_config.bind(reply))
	return reply


func _on_config(code: int, data: Variant, ecode: String, emsg: String, reply: LiveforgeReply) -> void:
	if ecode.is_empty() and typeof(data) == TYPE_DICTIONARY:
		public_config = data
		config_loaded.emit(public_config)
	elif _debug:
		push_warning("[liveforge] GET /v1/config failed: %s %s" % [ecode, emsg])
	reply._finish(code, data, ecode, emsg)


## Persona card from /v1/config ({id, name, role, faction?, voice?, zone?}) or {}.
func persona(id: String) -> Dictionary:
	for p in public_config.get("personas", []):
		if typeof(p) == TYPE_DICTIONARY and str(p.get("id", "")) == id:
			return p
	return {}


## Speech to text: POST /v1/stt with WAV bytes (see LiveforgeUtil.wav_bytes). completed -> {text, ...}.
func stt(wav: PackedByteArray, language: String = "") -> LiveforgeReply:
	var reply := LiveforgeReply.new()
	var path := "/v1/stt" + ("?language=" + language.uri_encode() if not language.is_empty() else "")
	_request(HTTPClient.METHOD_POST, path, null, _on_reply.bind(reply), {"raw": wav, "content_type": "audio/wav", "timeout": 30.0, "dedicated": true})
	return reply


## GET /v1/forge/jobs/:id
func forge_job(id: String) -> LiveforgeReply:
	var reply := LiveforgeReply.new()
	_request(HTTPClient.METHOD_GET, "/v1/forge/jobs/" + id.uri_encode(), null, _on_reply.bind(reply))
	return reply


## Exports this world (event log + projections). completed -> Snapshot.
func export_snapshot() -> LiveforgeReply:
	flush()
	var reply := LiveforgeReply.new()
	_request(HTTPClient.METHOD_GET, "/v1/snapshot?world=" + world.uri_encode(), null, _on_reply.bind(reply), {"timeout": 60.0, "dedicated": true})
	return reply


## Imports a snapshot (replaces the world's events; the server rebuilds projections).
func import_snapshot(snapshot: Dictionary) -> LiveforgeReply:
	var reply := LiveforgeReply.new()
	_request(HTTPClient.METHOD_POST, "/v1/snapshot", snapshot, _on_reply.bind(reply), {"timeout": 120.0, "dedicated": true})
	return reply


## Absolute URL for a server-relative path (e.g. a forge GLB "/v1/assets/x.glb").
func resolve_url(path: String) -> String:
	return path if path.begins_with("http") else url + path


## Headers for your own HTTPRequests (asset downloads).
func auth_headers() -> PackedStringArray:
	return PackedStringArray(["x-liveforge-key: " + game_key, "x-liveforge-protocol: " + PROTOCOL_ID])


## Dispatches a directive locally as if the server pushed it (testing, scripted events).
func dispatch_local(d: Dictionary) -> void:
	_dispatch(d)


func _on_reply(code: int, data: Variant, ecode: String, emsg: String, reply: LiveforgeReply) -> void:
	reply._finish(code, data, ecode, emsg)


# ================================================================================================ HTTP


func _request(method: int, path: String, body: Variant, cb: Callable, opts: Dictionary = {}) -> void:
	var job := {"method": method, "path": path, "body": body, "cb": cb, "opts": opts}
	if opts.get("dedicated", false):
		var r := HTTPRequest.new()
		add_child(r)
		_start(r, job, true)
		return
	for r in _pool:
		if not _busy.has(r):
			_start(r, job, false)
			return
	_waiting_jobs.append(job)


func _start(r: HTTPRequest, job: Dictionary, dedicated: bool) -> void:
	var headers := PackedStringArray(["x-liveforge-key: " + game_key, "x-liveforge-protocol: " + PROTOCOL_ID, "accept: application/json"])
	var full: String = url + str(job.path)
	var opts: Dictionary = job.opts
	r.timeout = float(opts.get("timeout", _timeout))
	var err := OK
	if opts.has("raw"):
		headers.append("content-type: " + str(opts.get("content_type", "application/octet-stream")))
		err = r.request_raw(full, headers, job.method, opts.raw)
	elif job.body != null:
		headers.append("content-type: application/json")
		err = r.request(full, headers, job.method, JSON.stringify(job.body))
	else:
		err = r.request(full, headers, job.method)
	if err != OK:
		if dedicated:
			r.queue_free()
		_call(job, 0, null, "network", "cannot start request %s (%s)" % [job.path, error_string(err)])
		if not dedicated:
			_pump.call_deferred()
		return
	_busy[r] = {"job": job, "dedicated": dedicated}
	r.request_completed.connect(_on_http_done.bind(r), CONNECT_ONE_SHOT)


func _on_http_done(result: int, code: int, _headers: PackedStringArray, body: PackedByteArray, r: HTTPRequest) -> void:
	var entry: Dictionary = _busy.get(r, {})
	_busy.erase(r)
	if entry.get("dedicated", false):
		r.queue_free()
	else:
		_pump()
	if entry.is_empty():
		return
	var job: Dictionary = entry.job
	var data: Variant = null
	var text := body.get_string_from_utf8()
	if not text.is_empty():
		data = JSON.parse_string(text)
	if result != HTTPRequest.RESULT_SUCCESS:
		var ec := "timeout" if result == HTTPRequest.RESULT_TIMEOUT else "network"
		_call(job, code, null, ec, "%s %s failed (cannot reach %s, result %d)" % [_method_name(job.method), job.path, url, result])
		return
	if code >= 400:
		var ecode := _status_code(code)
		var msg := "%s %s failed with HTTP %d" % [_method_name(job.method), job.path, code]
		if typeof(data) == TYPE_DICTIONARY and typeof(data.get("error")) == TYPE_DICTIONARY:
			ecode = str(data.error.get("code", ecode))
			msg = str(data.error.get("message", msg))
		_call(job, code, data, ecode, msg)
		return
	_call(job, code, data, "", "")


func _pump() -> void:
	if _waiting_jobs.is_empty():
		return
	for r in _pool:
		if _waiting_jobs.is_empty():
			return
		if not _busy.has(r):
			_start(r, _waiting_jobs.pop_front(), false)


func _call(job: Dictionary, code: int, data: Variant, ecode: String, emsg: String) -> void:
	var cb: Callable = job.cb
	if cb.is_valid():
		cb.call(code, data, ecode, emsg)


# ================================================================================================ WebSocket


func _process(_delta: float) -> void:
	_ws_tick()
	_tick_asks()


func _ws_open() -> bool:
	return _ws != null and _ws.get_ready_state() == WebSocketPeer.STATE_OPEN


func _ws_connect() -> void:
	if offline or game_key.is_empty():
		return
	_ws = WebSocketPeer.new()
	var base := url.replace("https://", "wss://").replace("http://", "ws://")
	var full := "%s%s?key=%s&world=%s&player=%s" % [base, WS_PATH, game_key.uri_encode(), world.uri_encode(), player.uri_encode()]
	var err := _ws.connect_to_url(full)
	_ws_state = -1
	if err != OK:
		_ws = null
		_ws_schedule_retry()
		return
	_set_status("unavailable" if _ws_attempt >= 3 else "connecting")


func _ws_close() -> void:
	if _ws != null:
		_ws.close()
	_ws = null
	_ws_state = -1
	_ws_retry_at_ms = 0
	_set_status("idle")


func _ws_schedule_retry() -> void:
	var delay := minf(30.0, 0.5 * pow(2.0, mini(_ws_attempt, 6))) * randf_range(0.75, 1.25)
	_ws_attempt += 1
	_ws_retry_at_ms = Time.get_ticks_msec() + int(delay * 1000.0)
	_set_status("unavailable" if _ws_attempt >= 3 else "reconnecting")


func _ws_tick() -> void:
	if _ws == null:
		if _realtime and not offline and _ws_retry_at_ms > 0 and Time.get_ticks_msec() >= _ws_retry_at_ms:
			_ws_retry_at_ms = 0
			_ws_connect()
		return
	_ws.poll()
	var st := _ws.get_ready_state()
	if st != _ws_state:
		_ws_state = st
		if st == WebSocketPeer.STATE_OPEN:
			_ws_attempt = 0
			_ws_last_msg_ms = Time.get_ticks_msec()
			_ws_next_ping_ms = _ws_last_msg_ms + 25000
			_ws_send({"t": "subscribe", "world": world, "player": player})
			_set_status("open")
		elif st == WebSocketPeer.STATE_CLOSED:
			_ws = null
			_ws_schedule_retry()
			return
	if st != WebSocketPeer.STATE_OPEN:
		return
	while _ws.get_available_packet_count() > 0:
		_ws_last_msg_ms = Time.get_ticks_msec()
		_on_ws_text(_ws.get_packet().get_string_from_utf8())
	var now := Time.get_ticks_msec()
	if now - _ws_last_msg_ms > 75000:
		_ws.close(4000, "stale")
	elif now >= _ws_next_ping_ms:
		_ws_next_ping_ms = now + 25000
		_ws_send({"t": "ping", "ts": LiveforgeUtil.now_ms()})


func _ws_send(msg: Dictionary) -> void:
	if _ws_open():
		_ws.send_text(JSON.stringify(msg))


func _on_ws_text(text: String) -> void:
	var msg: Variant = JSON.parse_string(text)
	if typeof(msg) != TYPE_DICTIONARY:
		return
	match str(msg.get("t", "")):
		"directive":
			if typeof(msg.get("directive")) == TYPE_DICTIONARY:
				_dispatch(msg.directive)
		"upgrade":
			if typeof(msg.get("response")) == TYPE_DICTIONARY:
				_accept_upgrade(msg.response)
		"chunk":
			var a: LiveforgeAsk = _asks.get(str(msg.get("id", "")))
			if a != null:
				a._push_partial(int(msg.get("seq", 0)), str(msg.get("text", "")))
		"job":
			job_updated.emit(msg)
		"error":
			var e: Dictionary = msg.get("error", {})
			_report(str(e.get("code", "internal")), "server: " + str(e.get("message", "")))
		_:
			pass


func _dispatch(d: Dictionary) -> void:
	var id := str(d.get("id", ""))
	if not id.is_empty():
		if _seen_set.has(id):
			return
		_seen_set[id] = true
		_seen.append(id)
		if _seen.size() > 500:
			_seen_set.erase(_seen.pop_front())
	if typeof(d.get("args")) != TYPE_DICTIONARY:
		d["args"] = {}
	if _debug:
		print("[liveforge] directive %s -> %s: %s" % [d.get("kind", "?"), d.get("target", "?"), d.get("why", "")])
	directive.emit(str(d.get("kind", "")), d)


func _set_status(s: String) -> void:
	if s == status:
		return
	status = s
	status_changed.emit(s)


# ================================================================================================ helpers


func _report(code: String, message: String) -> void:
	request_failed.emit(code, message)
	if request_failed.get_connections().is_empty():
		push_warning("[liveforge] %s: %s" % [code, message])


func _retryable(ecode: String, http_code: int) -> bool:
	return ecode in RETRYABLE or http_code >= 500


func _status_code(code: int) -> String:
	match code:
		400:
			return "bad_request"
		401:
			return "unauthorized"
		403:
			return "forbidden"
		404:
			return "not_found"
		429:
			return "rate_limited"
		503:
			return "provider_unavailable"
		504:
			return "timeout"
	return "internal"


func _method_name(m: int) -> String:
	return "POST" if m == HTTPClient.METHOD_POST else "GET"


func _valid_signal_type(t: String) -> bool:
	if t.length() < 3 or t.length() > 64 or not t.contains("."):
		return false
	var re := RegEx.new()
	re.compile("^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$")
	return re.search(t) != null


func _save_cache() -> void:
	if _persist and cache != null:
		cache.save_to_disk()
