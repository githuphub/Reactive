class_name LiveEquipSlot
extends BoneAttachment3D
## Attaches forged gear to a bone (child of a Skeleton3D, or with an external skeleton) or, without a skeleton,
## simply to this node. equip(item) builds the item's blueprint (LiveBlueprint) + VFX; forge(prompt) asks
## forge.item, equips the instant item and swaps in the AI upgrade.
##
## [codeblock]
## $Player/Skeleton3D/RightHand.forge("a rusty cleaver that drips green fire")
## [/codeblock]

signal equipped(item: Dictionary)
signal unequipped(item: Dictionary)
## The AI upgrade of a forge() replaced the instant item.
signal upgraded(item: Dictionary)
signal forge_failed(code: String, message: String)

## Slot name sent with forge asks and gear signals.
@export var slot := "weapon"
## Scale gear so its longest extent is this many metres (0 = authored size).
@export var item_length := 0.0
## Send gear.equipped / gear.unequipped signals.
@export var send_signals := true

## Current item ({} when empty).
var item: Dictionary = {}
## Current visual (LiveBlueprint) or null.
var visual: LiveBlueprint

var _seq := 0


## Equips a ForgedItem Dictionary ({id, name, blueprint, vfx?, ...}) or a bare blueprint. Returns the visual.
func equip(gear: Dictionary) -> LiveBlueprint:
	var is_item := gear.has("blueprint")
	var bp: Dictionary = gear.blueprint if is_item and typeof(gear.blueprint) == TYPE_DICTIONARY else gear
	_remove_visual()
	visual = LiveBlueprint.new()
	visual.name = "Gear"
	visual.target_length = item_length
	add_child(visual)
	visual.build(bp)
	var grip := visual.attachment("grip")
	if grip != null:
		visual.position = -grip.position * visual.scale_factor
	if is_item and typeof(gear.get("vfx")) == TYPE_DICTIONARY:
		var fx := LiveVFX.new()
		fx.recipe = gear.vfx
		var host := visual.attachment(str(gear.vfx.get("attach", "tip")))
		(host if host != null else visual).add_child(fx)
	var prev_id := str(item.get("id", ""))
	item = gear if is_item else {}
	if is_item and send_signals and str(gear.get("id", "")) != prev_id:
		var data := {"item": str(gear.get("id", "item")), "slot": str(gear.get("slot", slot)), "name": str(gear.get("name", "")), "tags": gear.get("tags", [])}
		var stats: Dictionary = gear.get("stats", {}) if typeof(gear.get("stats")) == TYPE_DICTIONARY else {}
		if stats.has("value"):
			data["value"] = float(stats.value)
		_send("gear.equipped", data)
	equipped.emit(item)
	return visual


## Removes the current gear.
func unequip() -> void:
	var old := item
	_remove_visual()
	item = {}
	if not old.is_empty() and send_signals:
		_send("gear.unequipped", {"item": str(old.get("id", "item")), "slot": str(old.get("slot", slot))})
	unequipped.emit(old)


## Forges an item from a prompt (forge.item) and equips it: instant item now, AI upgrade when it lands.
func forge(prompt: String, params: Dictionary = {}) -> LiveforgeAsk:
	var lf := LiveforgeUtil.lf(self)
	if lf == null:
		push_warning("[liveforge] LiveEquipSlot.forge: the Liveforge autoload is missing.")
		return null
	_seq += 1
	var p := params.duplicate()
	p["prompt"] = prompt.left(400)
	p["slot"] = slot
	var a: LiveforgeAsk = lf.ask("forge.item", p)
	a.answered.connect(_on_forged.bind(_seq, false))
	a.upgraded.connect(_on_forged.bind(_seq, true))
	a.failed.connect(func(code: String, message: String): forge_failed.emit(code, message))
	return a


func _on_forged(result: Dictionary, seq: int, is_upgrade: bool) -> void:
	if seq != _seq or typeof(result.get("item")) != TYPE_DICTIONARY:
		return
	equip(result.item)
	if is_upgrade:
		upgraded.emit(result.item)


func _remove_visual() -> void:
	if visual != null and is_instance_valid(visual):
		visual.queue_free()
	visual = null


func _send(type: String, data: Dictionary) -> void:
	var lf := LiveforgeUtil.lf(self)
	if lf != null:
		lf.send_signal(type, data)
