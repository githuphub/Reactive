class_name LiveforgeCache
extends RefCounted
## Last-good-answer cache (memory + user://liveforge_cache.json) and bake packs, used when the server is unreachable.

const PATH := "user://liveforge_cache.json"
const VOLATILE := ["seed", "stream", "history"]
const IDENTITY := ["npc", "boss", "giver"]
const KEY_PARAMS := ["prompt", "trigger", "enemy", "zone", "asset", "family", "slot", "role"]
const MAX_ENTRIES := 300

var entries := {}  # key -> {kind, result, source, why, ts}
var order: Array[String] = []
var packs: Array = []  # BakePack dictionaries, latest first
var dirty := false


## Cache key: kind + params without volatile fields (sorted JSON).
func key(kind: String, params: Dictionary) -> String:
	var p := params.duplicate(true)
	for k in VOLATILE:
		p.erase(k)
	return kind + "|" + JSON.stringify(p, "", true)


func get_answer(kind: String, params: Dictionary) -> Dictionary:
	var k := key(kind, params)
	return entries.get(k, {})


## Remembers an answer. A rules answer never replaces an AI / cached one.
func put(kind: String, params: Dictionary, result: Variant, source: String, why: String = "") -> void:
	var k := key(kind, params)
	var prev: Dictionary = entries.get(k, {})
	if not prev.is_empty() and str(prev.get("source", "")) in ["ai", "cache"] and source == "rules":
		return
	entries[k] = {"kind": kind, "result": result, "source": source, "why": why, "ts": LiveforgeUtil.now_ms()}
	order.erase(k)
	order.append(k)
	while order.size() > MAX_ENTRIES:
		entries.erase(order.pop_front())
	dirty = true


func clear() -> void:
	entries.clear()
	order.clear()
	dirty = true


## Adds a bake pack (Dictionary, or a res:// / user:// JSON path). Returns entry count, or -1 when invalid.
func load_pack(pack: Variant) -> int:
	if typeof(pack) == TYPE_STRING:
		if not FileAccess.file_exists(pack):
			push_warning("[liveforge] pack not found: %s" % pack)
			return -1
		pack = JSON.parse_string(FileAccess.get_file_as_string(pack))
	if typeof(pack) != TYPE_DICTIONARY or str(pack.get("protocol", "")) != "liveforge-protocol/1" or typeof(pack.get("entries")) != TYPE_DICTIONARY:
		push_warning("[liveforge] not a Liveforge bake pack (expected {protocol: \"liveforge-protocol/1\", entries: {...}})")
		return -1
	packs.push_front(pack)
	var n := 0
	for list in (pack["entries"] as Dictionary).values():
		if typeof(list) == TYPE_ARRAY:
			n += (list as Array).size()
	return n


## Picks a pack answer (same matching rules as the JS SDK). Returns {} when none.
func from_pack(kind: String, params: Dictionary) -> Dictionary:
	var exact := key(kind, params)
	for pack in packs:
		var list: Variant = (pack["entries"] as Dictionary).get(kind)
		if typeof(list) != TYPE_ARRAY or (list as Array).is_empty():
			continue
		var pool: Array = list
		for e in pool:
			if typeof(e) == TYPE_DICTIONARY and str(e.get("key", "")) == exact:
				return e
		var ident := ""
		for k in IDENTITY:
			if typeof(params.get(k)) == TYPE_STRING and not str(params[k]).is_empty():
				ident = str(params[k])
				break
		if not ident.is_empty():
			pool = pool.filter(func(e): return typeof(e) == TYPE_DICTIONARY and _matches(e, ident))
			if pool.is_empty():
				continue
		for k in KEY_PARAMS:
			var v: Variant = params.get(k)
			if typeof(v) != TYPE_STRING or str(v).is_empty():
				continue
			for e in pool:
				if typeof(e) == TYPE_DICTIONARY and (_matches(e, v) or str(e.get("key", "")).to_lower().ends_with(":" + str(v).to_lower())):
					return e
		return pool[absi(exact.hash()) % pool.size()]
	return {}


func _matches(e: Dictionary, id: String) -> bool:
	var k := str(e.get("key", "")).to_lower()
	var v := id.to_lower()
	if k == v or k.begins_with(v + ":") or k.begins_with(v + "|"):
		return true
	for t in e.get("tags", []):
		if str(t).to_lower() == v:
			return true
	return false


func load_from_disk() -> void:
	if not FileAccess.file_exists(PATH):
		return
	var data: Variant = JSON.parse_string(FileAccess.get_file_as_string(PATH))
	if typeof(data) != TYPE_DICTIONARY:
		return
	var now := LiveforgeUtil.now_ms()
	var week := 7 * 24 * 3600 * 1000
	for k in data:
		var e: Variant = data[k]
		if typeof(e) == TYPE_DICTIONARY and now - int(e.get("ts", 0)) <= week:
			entries[k] = e
			order.append(str(k))


func save_to_disk() -> void:
	if not dirty:
		return
	dirty = false
	var f := FileAccess.open(PATH, FileAccess.WRITE)
	if f == null:
		return
	f.store_string(JSON.stringify(entries))
	f.close()
