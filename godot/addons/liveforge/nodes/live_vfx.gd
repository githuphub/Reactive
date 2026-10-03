class_name LiveVFX
extends Node3D
## Builds a Liveforge VFX recipe (protocol vfx.ts) as GPUParticles3D emitters, particle trails, aura meshes and
## OmniLight3Ds. Set `recipe` before adding the node, or call build(recipe) any time.
##
## [codeblock]
## var fx := LiveVFX.new()
## fx.recipe = item.vfx
## $Sword.add_child(fx)
## [/codeblock]

## A finite effect (recipe.duration) finished.
signal finished

@export var recipe: Dictionary = {}
@export var autoplay := true
## Free the node when a finite effect finishes.
@export var free_on_finish := false
## Particle amount multiplier (quality setting).
@export_range(0.1, 2.0) var quality := 1.0

var playing := false
var elapsed := 0.0
var _emitters: Array[GPUParticles3D] = []
var _auras: Array = []
var _lights: Array = []
var _max_life := 0.0
var _done := false


func _ready() -> void:
	if not recipe.is_empty() and _emitters.is_empty() and _auras.is_empty() and _lights.is_empty():
		build(recipe)


## Builds (or rebuilds) the effect from a recipe Dictionary.
func build(r: Dictionary) -> void:
	clear_effect()
	recipe = r
	_max_life = 0.0
	for e in r.get("emitters", []):
		if typeof(e) == TYPE_DICTIONARY:
			_build_emitter(e)
	for t in r.get("trails", []):
		if typeof(t) == TYPE_DICTIONARY:
			_build_trail(t)
	for a in r.get("auras", []):
		if typeof(a) == TYPE_DICTIONARY:
			_build_aura(a)
	for l in r.get("lights", []):
		if typeof(l) == TYPE_DICTIONARY:
			_build_light(l)
	if autoplay:
		play()


## Starts / restarts emitting.
func play() -> void:
	playing = true
	_done = false
	elapsed = 0.0
	for p in _emitters:
		p.emitting = true
		p.restart()


## Stops emitting (live particles finish their life).
func stop() -> void:
	playing = false
	for p in _emitters:
		p.emitting = false


## Removes all built children.
func clear_effect() -> void:
	for p in _emitters:
		p.queue_free()
	for a in _auras:
		(a.mesh as Node).queue_free()
	for l in _lights:
		(l.light as Node).queue_free()
	_emitters.clear()
	_auras.clear()
	_lights.clear()


func _process(delta: float) -> void:
	if _emitters.is_empty() and _auras.is_empty() and _lights.is_empty():
		return
	elapsed += delta
	var dur: Variant = recipe.get("duration")
	var finite := typeof(dur) == TYPE_FLOAT or typeof(dur) == TYPE_INT
	if playing and finite and elapsed >= float(dur):
		stop()
	var fade := 1.0
	if not playing and finite:
		fade = clampf(1.0 - (elapsed - float(dur)) / 0.4, 0.0, 1.0)
	for a in _auras:
		var k := 1.0
		if a.pulse_speed > 0.0:
			k = 1.0 + a.pulse_amount * sin(elapsed * a.pulse_speed * TAU)
			(a.mesh as Node3D).scale = Vector3.ONE * (1.0 + (k - 1.0) * 0.3)
		var c: Color = a.color
		c.a = a.base_alpha * k * fade
		(a.mat as StandardMaterial3D).albedo_color = c
	for l in _lights:
		var n := 1.0
		if l.flicker > 0.0:
			n = 1.0 - l.flicker * (0.5 + 0.25 * sin(elapsed * 23.0 + l.seed) + 0.25 * sin(elapsed * 37.7 + l.seed * 2.0))
		(l.light as OmniLight3D).light_energy = l.base * n * fade
	if finite and not playing and not _done and elapsed >= float(dur) + _max_life:
		_done = true
		finished.emit()
		if free_on_finish:
			queue_free()


func _build_emitter(e: Dictionary) -> void:
	var p := GPUParticles3D.new()
	p.name = "Emitter%d" % _emitters.size()
	var lt: Array = e.get("lifetime", [0.5, 1.0])
	var life_min := maxf(0.0, float(lt[0]) if lt.size() > 0 else 0.5)
	var life_max := maxf(0.05, float(lt[1]) if lt.size() > 1 else 1.0)
	life_max = maxf(life_max, life_min)
	_max_life = maxf(_max_life, life_max)
	p.lifetime = life_max
	var rate := float(e.get("rate", 10.0)) * quality
	var burst := int(float(e.get("burst", 0)) * quality)
	var cap := clampi(int(float(e.get("maxParticles", 64)) * quality), 1, 1024)
	if rate <= 0.0 and burst > 0:
		p.amount = clampi(burst, 1, cap)
		p.one_shot = true
		p.explosiveness = 1.0
	else:
		p.amount = clampi(int(ceil(rate * life_max)) + burst, 1, cap)
	p.local_coords = bool(e.get("local", false))
	p.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	p.visibility_aabb = AABB(Vector3(-8, -8, -8), Vector3(16, 16, 16))
	p.position = LiveforgeUtil.vec3(e.get("offset"))

	var pm := ParticleProcessMaterial.new()
	var radius := float(e.get("radius", 0.2))
	var shape := str(e.get("shape", "point"))
	match shape:
		"sphere":
			pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_SPHERE
			pm.emission_sphere_radius = maxf(0.001, radius)
		"box":
			pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_BOX
			pm.emission_box_extents = LiveforgeUtil.vec3(e.get("extents"), Vector3(0.4, 0.4, 0.4)) * 0.5
		"ring":
			pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_RING
			pm.emission_ring_axis = Vector3.UP
			pm.emission_ring_radius = maxf(0.001, radius)
			pm.emission_ring_inner_radius = radius * 0.9
			pm.emission_ring_height = 0.01
		"line":
			pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_BOX
			var ext := LiveforgeUtil.vec3(e.get("extents"), Vector3(radius * 2.0, 0, 0))
			pm.emission_box_extents = Vector3(maxf(0.001, ext.x * 0.5), 0.001, 0.001)
		"cone":
			pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_SPHERE
			pm.emission_sphere_radius = maxf(0.001, float(e.get("radius", 0.05)))
		_:
			pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_POINT

	var vel: Dictionary = e.get("velocity", {})
	var dir := LiveforgeUtil.vec3(vel.get("dir"), Vector3.UP)
	if dir.length() < 0.0001:
		dir = Vector3.UP
	pm.direction = dir.normalized()
	if shape == "cone":
		pm.spread = clampf(float(e.get("angle", 25.0)), 0.0, 180.0)
	else:
		pm.spread = clampf(float(vel.get("spread", 0.3)), 0.0, 1.0) * 180.0
	var sp: Array = vel.get("speed", [0.5, 1.0])
	var v0 := float(sp[0]) if sp.size() > 0 else 0.5
	var v1 := float(sp[1]) if sp.size() > 1 else v0
	pm.initial_velocity_min = minf(v0, v1)
	pm.initial_velocity_max = maxf(v0, v1)
	pm.gravity = Vector3(0, -float(e.get("gravity", 0.0)), 0)
	var drag := float(e.get("drag", 0.0))
	if drag > 0.0:
		pm.damping_min = drag * (v0 + v1) * 0.5
		pm.damping_max = pm.damping_min
	pm.lifetime_randomness = clampf(1.0 - life_min / life_max, 0.0, 1.0)
	var spin := float(e.get("spin", 0.0))
	if spin != 0.0:
		pm.angle_min = 0.0
		pm.angle_max = 360.0
		pm.angular_velocity_min = rad_to_deg(spin) * 0.6
		pm.angular_velocity_max = rad_to_deg(spin) * 1.4

	# Colour ramp over life.
	var stops: Array = e.get("colorRamp", [])
	if not stops.is_empty():
		pm.color_ramp = _gradient_texture(stops)
	# Size curve over life (normalised; the quad is sized to the largest key).
	var keys: Array = e.get("sizeCurve", [{"t": 0.0, "size": 0.05}, {"t": 1.0, "size": 0.0}])
	var max_size := 0.001
	for k in keys:
		max_size = maxf(max_size, float(k.get("size", 0.05)))
	var curve := Curve.new()
	for k in keys:
		curve.add_point(Vector2(clampf(float(k.get("t", 0.0)), 0.0, 1.0), clampf(float(k.get("size", 0.05)) / max_size, 0.0, 1.0)))
	var ct := CurveTexture.new()
	ct.curve = curve
	pm.scale_curve = ct
	p.process_material = pm

	var quad := QuadMesh.new()
	quad.size = Vector2(max_size, max_size)
	quad.material = _particle_material(str(e.get("sprite", "spark")), str(e.get("blend", "additive")))
	p.draw_pass_1 = quad
	add_child(p)
	_emitters.append(p)


func _build_trail(t: Dictionary) -> void:
	# A world-space ribbon of short-lived particles that follows this node (or the named attachment's parent).
	var life := clampf(float(t.get("lifetime", 0.3)), 0.05, 2.0)
	var width := clampf(float(t.get("width", 0.1)), 0.01, 1.0)
	var e := {
		"shape": "point", "rate": 90.0, "maxParticles": 256, "lifetime": [life, life],
		"velocity": {"dir": [0, 0, 0], "speed": [0.0, 0.0], "spread": 0.0},
		"colorRamp": t.get("colorRamp", []), "sizeCurve": [{"t": 0.0, "size": width}, {"t": 1.0, "size": width * 0.3}],
		"sprite": "mote", "blend": t.get("blend", "additive"), "local": false,
	}
	_build_emitter(e)


func _build_aura(a: Dictionary) -> void:
	var r := maxf(0.01, float(a.get("radius", 0.5)))
	var mi := MeshInstance3D.new()
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	mat.no_depth_test = false
	match str(a.get("shape", "sphere")):
		"ring":
			var m := TorusMesh.new()
			m.inner_radius = r * 0.96
			m.outer_radius = r * 1.04
			m.rings = 48
			m.ring_segments = 6
			mi.mesh = m
			mi.position.y = 0.02
		"column":
			var h := float(a.get("height", 2.0))
			var m := CylinderMesh.new()
			m.top_radius = r
			m.bottom_radius = r
			m.height = h
			m.cap_top = false
			m.cap_bottom = false
			mi.mesh = m
			mi.position.y = h * 0.5
		"ground_decal":
			var m := PlaneMesh.new()
			m.size = Vector2(r * 2.0, r * 2.0)
			mi.mesh = m
			mi.position.y = 0.02
			mat.albedo_texture = LiveforgeUtil.sprite_texture("mote")
		_:
			var m := SphereMesh.new()
			m.radius = r
			m.height = r * 2.0
			mi.mesh = m
	var col := LiveforgeUtil.color(a.get("color"), Color(1, 0.8, 0.3))
	var base_alpha := clampf(0.12 + 0.22 * float(a.get("intensity", 1.0)), 0.0, 0.85)
	col.a = base_alpha
	mat.albedo_color = col
	mi.material_override = mat
	add_child(mi)
	var pulse: Dictionary = a.get("pulse", {}) if typeof(a.get("pulse")) == TYPE_DICTIONARY else {}
	_auras.append({
		"mesh": mi, "mat": mat, "color": col, "base_alpha": base_alpha,
		"pulse_speed": float(pulse.get("speed", 0.0)), "pulse_amount": float(pulse.get("amount", 0.0)),
	})


func _build_light(l: Dictionary) -> void:
	var o := OmniLight3D.new()
	o.light_color = LiveforgeUtil.color(l.get("color"), Color(1, 0.8, 0.4))
	o.light_energy = float(l.get("intensity", 1.0))
	o.omni_range = maxf(0.1, float(l.get("range", 3.0)))
	o.position = LiveforgeUtil.vec3(l.get("offset"))
	add_child(o)
	_lights.append({"light": o, "base": o.light_energy, "flicker": float(l.get("flicker", 0.0)), "seed": randf() * 100.0})


func _gradient_texture(stops: Array) -> GradientTexture1D:
	var offsets := PackedFloat32Array()
	var colors := PackedColorArray()
	for s in stops:
		if typeof(s) != TYPE_DICTIONARY:
			continue
		var c := LiveforgeUtil.color(s.get("color"), Color.WHITE)
		c.a = float(s.get("alpha", 1.0))
		offsets.append(clampf(float(s.get("t", 0.0)), 0.0, 1.0))
		colors.append(c)
	var g := Gradient.new()
	g.offsets = offsets
	g.colors = colors
	var tex := GradientTexture1D.new()
	tex.gradient = g
	return tex


func _particle_material(sprite: String, blend: String) -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	mat.vertex_color_use_as_albedo = true
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.blend_mode = BaseMaterial3D.BLEND_MODE_MIX if blend == "alpha" else BaseMaterial3D.BLEND_MODE_ADD
	mat.albedo_texture = LiveforgeUtil.sprite_texture(sprite)
	return mat


## Recipe for Counterforge-style quick particles ({kind, color, rate}) emitted around `center`.
static func quick_recipe(particles: Dictionary, center: Vector3 = Vector3.ZERO, size: float = 0.3) -> Dictionary:
	var kind := str(particles.get("kind", "motes"))
	var color := str(particles.get("color", "#ffd23f"))
	var rate := clampf(float(particles.get("rate", 12.0)), 0.0, 60.0)
	var up := -1.0 if kind == "frost" else 1.0
	var speeds := {"embers": 0.5, "frost": 0.18, "sparks": 0.9, "motes": 0.12, "smoke": 0.22, "bubbles": 0.3}
	var sprites := {"embers": "ember", "frost": "snow", "sparks": "spark", "motes": "mote", "smoke": "smoke", "bubbles": "bubble"}
	var s := float(speeds.get(kind, 0.3))
	return {
		"v": 1,
		"emitters": [{
			"shape": "sphere", "radius": size * 0.5, "rate": rate, "maxParticles": 64, "lifetime": [0.6, 1.4],
			"velocity": {"dir": [0, up, 0], "speed": [s * 0.6, s * 1.2], "spread": 0.3},
			"colorRamp": [{"t": 0.0, "color": color, "alpha": 0.9}, {"t": 1.0, "color": color, "alpha": 0.0}],
			"sizeCurve": [{"t": 0.0, "size": size * 0.12}, {"t": 1.0, "size": size * (0.2 if kind == "smoke" else 0.04)}],
			"sprite": sprites.get(kind, "mote"), "blend": "alpha" if kind == "smoke" else "additive",
			"offset": [center.x, center.y, center.z], "local": true,
		}],
	}
