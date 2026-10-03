class_name VillagePlayer
extends CharacterBody3D
## Simple third-person capsule: WASD relative to the view, mouse look while the mouse is captured, Space jumps.

@export var speed := 5.0
@export var jump_velocity := 4.5
@export var mouse_sensitivity := 0.003

## Set false while typing in the chat box.
var input_enabled := true
## Short sideways burst after a dodge (set by main.gd).
var dodge_velocity := Vector3.ZERO

@onready var head: Node3D = $Head

var _gravity: float = float(ProjectSettings.get_setting("physics/3d/default_gravity", 9.8))


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		var motion := event as InputEventMouseMotion
		rotate_y(-motion.relative.x * mouse_sensitivity)
		head.rotation.x = clampf(head.rotation.x - motion.relative.y * mouse_sensitivity, -1.1, 0.5)


func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y -= _gravity * delta
	var dir := Vector3.ZERO
	if input_enabled:
		if Input.is_physical_key_pressed(KEY_W):
			dir.z -= 1.0
		if Input.is_physical_key_pressed(KEY_S):
			dir.z += 1.0
		if Input.is_physical_key_pressed(KEY_A):
			dir.x -= 1.0
		if Input.is_physical_key_pressed(KEY_D):
			dir.x += 1.0
		if Input.is_physical_key_pressed(KEY_SPACE) and is_on_floor():
			velocity.y = jump_velocity
	dir = (transform.basis * dir)
	dir.y = 0.0
	dir = dir.normalized()
	velocity.x = dir.x * speed + dodge_velocity.x
	velocity.z = dir.z * speed + dodge_velocity.z
	dodge_velocity = dodge_velocity.move_toward(Vector3.ZERO, 30.0 * delta)
	move_and_slide()
