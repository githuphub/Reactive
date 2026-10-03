class_name LiveforgeAsk
extends RefCounted
## The two-stage answer of one Liveforge ask (returned by Liveforge.ask()).
##
## [codeblock]
## var a := Liveforge.ask("npc.reply", {"npc": "bess", "text": "Any news?", "stream": true})
## a.answered.connect(func(r): $Bubble.text = r.text)      # instant (rules / cache / bake)
## a.partial.connect(func(t): print("streamed: ", t))       # streamed sentences
## a.upgraded.connect(func(r): $Bubble.text = r.text)      # AI upgrade
## var best: Dictionary = await a.done                      # upgrade if any, else instant
## [/codeblock]

## The instant answer arrived (result Dictionary per protocol ASKS[kind].result).
signal answered(result: Dictionary)
## The AI upgrade arrived (replaces the instant answer).
signal upgraded(result: Dictionary)
## One streamed sentence of the upgrade (npc.reply with "stream": true).
signal partial(text: String)
## Everything settled: emits the best result (upgrade if one came, else the instant answer).
signal done(result: Dictionary)
## The ask failed and no local fallback existed.
signal failed(code: String, message: String)

## Ask id (upgrades and chunks reuse it).
var id: String
var kind: String
var params: Dictionary
## Instant result (empty until answered).
var instant: Dictionary = {}
## Latest result (instant, then upgrade).
var result: Dictionary = {}
## Latest full response {id, kind, stage, result, source, why, upgrade, ms, ts}.
var response: Dictionary = {}
## "" -> "instant" -> "upgrade".
var stage: String = ""
## rules | cache | ai | bake
var source: String = ""
## Short reason from the server (dashboard "why").
var why: String = ""
## True when the server said an upgrade will follow.
var upgrade_pending := false
## Everything streamed so far.
var partial_text: String = ""
var is_done := false
var error_code: String = ""

var _instant_done := false
var _early_upgrade: Variant = null
var _seqs := {}
var _deadline_ms := 0
var _polling := false


func _init(p_id: String = "", p_kind: String = "", p_params: Dictionary = {}) -> void:
	id = p_id
	kind = p_kind
	params = p_params


## Stop waiting for an upgrade (emits done with the instant answer).
func cancel() -> void:
	_settle_upgrade(null)


# ---- driven by the Liveforge autoload


func _resolve_instant(resp: Dictionary) -> void:
	if _instant_done:
		return
	_instant_done = true
	response = resp
	var r: Variant = resp.get("result", {})
	instant = r if typeof(r) == TYPE_DICTIONARY else {}
	result = instant
	stage = "instant"
	source = str(resp.get("source", ""))
	why = str(resp.get("why", ""))
	upgrade_pending = str(resp.get("upgrade", "none")) == "pending"
	answered.emit(instant)
	if _early_upgrade != null:
		var up: Variant = _early_upgrade
		_early_upgrade = null
		_settle_upgrade(up if typeof(up) == TYPE_DICTIONARY and not (up as Dictionary).is_empty() else null)
	elif not upgrade_pending:
		_settle_upgrade(null)


func _fail(code: String, message: String) -> void:
	if _instant_done:
		return
	_instant_done = true
	error_code = code
	failed.emit(code, message)
	is_done = true
	done.emit({})


func _settle_upgrade(resp: Variant) -> void:
	if is_done:
		return
	if not _instant_done:
		# Buffer until the instant answer resolved ({} = "no upgrade").
		_early_upgrade = resp if resp != null else {}
		return
	is_done = true
	if typeof(resp) == TYPE_DICTIONARY and (resp as Dictionary).has("result"):
		response = resp
		var r: Variant = resp.get("result", {})
		result = r if typeof(r) == TYPE_DICTIONARY else {}
		stage = "upgrade"
		source = str(resp.get("source", "ai"))
		why = str(resp.get("why", why))
		upgraded.emit(result)
	done.emit(result)


func _push_partial(seq: int, text: String) -> void:
	if is_done or _seqs.has(seq):
		return
	_seqs[seq] = true
	partial_text = (partial_text + " " + text).strip_edges()
	partial.emit(text)
