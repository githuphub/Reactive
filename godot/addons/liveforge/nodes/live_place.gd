class_name LivePlace
extends Area3D
## Reaction Library (R1): a visitable place (inn, shop, market, area). When a body in `player_group` enters,
## Liveforge gets movement.visited {place, kind} once per entry (inn_regular, avoided_area, rich_attention ...).
## Give it a CollisionShape3D child like any Area3D.

## Place id the manifest refers to (e.g. inn_regular params owners: {copper_kettle: bess}).
@export var place_id := ""
## inn | shop | tavern | market | area ...
@export var kind := "area"
## Zone the place belongs to (optional).
@export var zone := ""
## Group the player body is in.
@export var player_group := "player"

## The player entered (a movement.visited was sent when `counted`).
signal entered(counted: bool)
## The player left.
signal exited


func _ready() -> void:
	body_entered.connect(_on_enter)
	body_exited.connect(_on_exit)


func _on_enter(body: Node) -> void:
	if not body.is_in_group(player_group):
		return
	var lf := LiveforgeUtil.lf(self)
	var counted := false
	if lf != null:
		counted = lf.visited(place_id if not place_id.is_empty() else String(name).to_snake_case(), kind, zone)
	entered.emit(counted)


func _on_exit(body: Node) -> void:
	if not body.is_in_group(player_group):
		return
	var lf := LiveforgeUtil.lf(self)
	if lf != null:
		lf.left_place()
	exited.emit()
