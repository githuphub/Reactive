class_name LiveBlueprint
extends Node3D
## Builds a Liveforge Blueprint v1 (protocol blueprint.ts) from MeshInstance3D primitives: box, cylinder, cone
## (CylinderMesh with top radius 0), sphere, torus, prism, capsule, octahedron / icosahedron (low-poly spheres),
## wedge and crescent (generated meshes). StandardMaterial3D with emission, mirrored parts, attachment points
## (Marker3D), part animations (spin, pulse, float, orbit, flicker, wobble), quick particles and VFX recipes.
##
## [codeblock]
## var bp := LiveBlueprint.new()
## bp.target_length = 1.1
## bp.blueprint = item.blueprint     # builds in _ready, or call bp.build(dict) any time
## $Hand.add_child(bp)
## [/codeblock]

signal built

@export var blueprint: Dictionary = {}
## Optional JSON file with a blueprint (used when `blueprint` is empty).
@export_file("*.json") var blueprint_path: String = ""
## Scale so the longest extent is this many metres (0 = authored size).
@export var target_length := 0.0
@export_enum("low", "medium", "high") var detail: String = "medium"
## Play part animations.
@export var animate := true
## Build quick particles and VFX recipes.
@export var build_vfx := true

## Attachment points by name ("grip", "tip" ...) as Marker3D nodes (a "tip" always exists).
var attachments := {}
## Longest extent of the unscaled model (m) and the applied scale.
var measure := 1.0
var scale_factor := 1.0
var palette: Array = []

var _content: Node3D
var _anim: Array = []
var _time := 0.0
var _float_cap := 0.1

const METAL := ["blade", "head", "guard", "pommel", "spike", "barrel", "rim", "ring", "plate", "helm", "visor", "pauldron", "gauntlet", "greave", "trim", "frame"]
const GEM := ["gem", "orb", "shard", "rune", "crystal", "eye"]
const SEGMENTS := {"low": [6, 8, 6], "medium": [10, 12, 8], "high": [18, 20, 14]}


func _ready() -> void:
	if _content != null:
		return
	if not blueprint.is_empty():
		build(blueprint)
	elif not blueprint_path.is_empty() and FileAccess.file_exists(blueprint_path):
		var data: Variant = JSON.parse_string(FileAccess.get_file_as_string(blueprint_path))
		if typeof(data) == TYPE_DICTIONARY:
			build(data)


func _process(delta: float) -> void:
	if animate and not _anim.is_empty():
		_time += delta
		animate_to(_time)


## Builds (or rebuilds) from a blueprint Dictionary. Accepts Counterforge ItemBlueprints (inline part colours) too.
func build(bp: Dictionary) -> void:
	clear_model()
	blueprint = bp
	var parts: Variant = bp.get("parts")
	if typeof(parts) != TYPE_ARRAY or (parts as Array).is_empty():
		push_warning("[liveforge] LiveBlueprint: blueprint has no parts")
		return
	if bp.has("lod") and typeof(bp.lod) == TYPE_DICTIONARY and SEGMENTS.has(str(bp.lod.get("detail", ""))):
		detail = str(bp.lod.detail)
	palette = bp.get("palette", ["#b8c0c8", "#5a3a22", "#d4af37"])
	if palette.is_empty():
		palette = ["#b8c0c8"]
	_content = Node3D.new()
	_content.name = "Content"
	add_child(_content)

	for a in bp.get("attachments", []):
		if typeof(a) != TYPE_DICTIONARY:
			continue
		var m := Marker3D.new()
		var aname := str(a.get("name", "point")).replace(" ", "_")
		m.name = "attach_" + aname
		m.rotation_order = EULER_ORDER_XYZ
		m.position = LiveforgeUtil.vec3(a.get("position"))
		m.rotation = LiveforgeUtil.vec3(a.get("rotation"))
		m.set_meta("attachment_kind", str(a.get("kind", "other")))
		_content.add_child(m)
		attachments[aname] = m

	var i := 0
	for p in parts:
		if typeof(p) == TYPE_DICTIONARY and i < 64:
			_build_part(bp, p, i)
		i += 1

	var box := _measure_aabb()
	measure = maxf(maxf(box.size.x, box.size.y), maxf(box.size.z, 0.001))
	scale_factor = target_length / measure if target_length > 0.0 else 1.0
	_content.scale = Vector3.ONE * scale_factor
	_float_cap = 0.12 * measure
	if not attachments.has("tip"):
		var tip := Marker3D.new()
		tip.name = "attach_tip"
		tip.position = Vector3(0, maxf(0.0, box.end.y), 0)
		tip.set_meta("attachment_kind", "tip")
		_content.add_child(tip)
		attachments["tip"] = tip

	if build_vfx:
		if typeof(bp.get("particles")) == TYPE_DICTIONARY and float(bp.particles.get("rate", 0)) > 0.0:
			var q := LiveVFX.new()
			q.name = "QuickParticles"
			var top := box.position + Vector3(box.size.x * 0.5, box.size.y * 0.8, box.size.z * 0.5)
			q.recipe = LiveVFX.quick_recipe(bp.particles, top, measure * 0.4)
			_content.add_child(q)
		for r in bp.get("vfx", []):
			if typeof(r) != TYPE_DICTIONARY:
				continue
			var fx := LiveVFX.new()
			fx.recipe = r
			var host: Node3D = attachments.get(str(r.get("attach", "")), _content)
			host.add_child(fx)
	built.emit()


## Removes the built model.
func clear_model() -> void:
	if _content != null:
		_content.queue_free()
	_content = null
	attachments.clear()
	_anim.clear()


## Attachment point by name or kind ("grip", "tip", "vfx" ...), or null.
func attachment(name_or_kind: String) -> Node3D:
	if attachments.has(name_or_kind):
		return attachments[name_or_kind]
	for k in attachments:
		var m: Node3D = attachments[k]
		if str(m.get_meta("attachment_kind", "")) == name_or_kind:
			return m
	return null


## Poses the part animations at time t (seconds). Called from _process when `animate` is on.
func animate_to(t: float) -> void:
	for a in _anim:
		var kind: String = a.kind
		var speed: float = a.speed
		var amount: float = a.amount
		var ph := speed * t + float(a.phase0)
		var spin_node: Node3D = a.spin
		var pivot: Node3D = a.pivot
		var base_pos: Vector3 = a.base_pos
		match kind:
			"spin":
				match str(a.axis):
					"x":
						spin_node.rotation.x = speed * t
					"z":
						spin_node.rotation.z = speed * t
					_:
						spin_node.rotation.y = speed * t
			"pulse":
				var k := sin(ph * 2.0)
				spin_node.scale = Vector3.ONE * (1.0 + amount * 0.35 * k)
				(a.mat as StandardMaterial3D).emission_energy_multiplier = float(a.energy) * (1.0 + amount * k)
			"float":
				pivot.position.y = base_pos.y + minf(float(a.amp), _float_cap) * sin(ph)
				spin_node.rotation.y = t * 0.6
			"orbit":
				var amp: float = a.amp
				pivot.position = Vector3(cos(ph) * amp, base_pos.y + sin(ph * 1.7) * 0.02 * measure, sin(ph) * amp)
				spin_node.rotation.y = speed * t * 1.5
			"flicker":
				var n := 0.5 + 0.25 * sin(t * speed * 1.7 + float(a.phase0)) + 0.25 * sin(t * speed * 2.93 + float(a.phase0) * 2.0)
				(a.mat as StandardMaterial3D).emission_energy_multiplier = float(a.energy) * (1.0 - amount * 0.6 + amount * 1.2 * n)
				spin_node.scale = Vector3(1.0, 1.0 + amount * 0.25 * (n - 0.5), 1.0)
			"wobble":
				var br: Vector3 = a.base_rot
				pivot.rotation = Vector3(br.x + amount * 0.25 * sin(ph * 0.8), br.y, br.z + amount * 0.6 * sin(ph))


func _build_part(bp: Dictionary, p: Dictionary, index: int) -> void:
	var size := LiveforgeUtil.vec3(p.get("size"), Vector3(0.1, 0.1, 0.1))
	size = Vector3(clampf(size.x, 0.01, 3.0), clampf(size.y, 0.01, 3.0), clampf(size.z, 0.01, 3.0))
	var offset := LiveforgeUtil.vec3(p.get("offset"))
	var rot := LiveforgeUtil.vec3(p.get("rotation"))
	var shape := str(p.get("shape", "box"))
	var role := str(p.get("role", "decor"))
	var mat := _material(bp, p, role)
	var parent: Node3D = attachments.get(str(p.get("parent", "")), _content)
	var copies := [[offset, rot]]
	match str(p.get("mirror", "")):
		"x":
			copies.append([Vector3(-offset.x, offset.y, offset.z), Vector3(rot.x, -rot.y, -rot.z)])
		"z":
			copies.append([Vector3(offset.x, offset.y, -offset.z), Vector3(-rot.x, -rot.y, rot.z)])
	var mesh_and_xf := _mesh_for(shape, size)
	var anim: Variant = p.get("anim")
	for ci in copies.size():
		var pivot := Node3D.new()
		pivot.name = "%s_%d%s" % [str(p.get("id", role)), index, "_m" if ci > 0 else ""]
		pivot.rotation_order = EULER_ORDER_XYZ
		pivot.position = copies[ci][0]
		pivot.rotation = copies[ci][1]
		var spin_node := Node3D.new()
		spin_node.name = "Anim"
		pivot.add_child(spin_node)
		var mi := MeshInstance3D.new()
		mi.name = "Mesh"
		mi.mesh = mesh_and_xf[0]
		mi.transform = mesh_and_xf[1]
		var copy_mat: StandardMaterial3D = mat if ci == 0 else (mat.duplicate() as StandardMaterial3D)
		mi.material_override = copy_mat
		mi.set_meta("role", role)
		if p.has("id"):
			mi.set_meta("part_id", str(p.id))
		spin_node.add_child(mi)
		parent.add_child(pivot)
		if typeof(anim) == TYPE_DICTIONARY:
			var speed := clampf(float(anim.get("speed", 0.0)), 0.0, 10.0)
			var amount := clampf(float(anim.get("amount", 0.0)), 0.0, 1.0)
			var kind := str(anim.get("kind", ""))
			if speed > 0.0 and (amount > 0.0 or kind == "spin"):
				var pos: Vector3 = copies[ci][0]
				var orbit_r := Vector2(pos.x, pos.z).length()
				_anim.append({
					"pivot": pivot, "spin": spin_node, "mat": copy_mat, "kind": kind, "speed": speed, "amount": amount,
					"base_pos": pos, "base_rot": copies[ci][1], "energy": copy_mat.emission_energy_multiplier,
					"phase0": atan2(pos.z, pos.x) if kind == "orbit" else index * 0.6 + ci * 1.3,
					"axis": _spin_axis(shape, size),
					"amp": (amount if amount > 0.01 else orbit_r) if kind == "orbit" else amount,
				})


func _spin_axis(shape: String, s: Vector3) -> String:
	if shape == "torus" or shape == "crescent":
		return "z"
	var v := [s.x, s.y, s.z]
	var order := [0, 1, 2]
	order.sort_custom(func(a, b): return v[a] < v[b])
	if v[order[0]] < 0.5 * v[order[1]]:
		return ["x", "y", "z"][order[0]]
	return "y"


## [Mesh, Transform3D for the MeshInstance3D] filling `size` per protocol SHAPE_NOTES.
func _mesh_for(shape: String, size: Vector3) -> Array:
	var seg: Array = SEGMENTS.get(detail, SEGMENTS["medium"])
	var radial: int = seg[0]
	match shape:
		"box":
			var m := BoxMesh.new()
			m.size = size
			return [m, Transform3D.IDENTITY]
		"cylinder", "cone", "prism":
			var m := CylinderMesh.new()
			m.top_radius = 0.0 if shape == "cone" else 0.5
			m.bottom_radius = 0.5
			m.height = 1.0
			m.radial_segments = 3 if shape == "prism" else radial
			m.rings = 1
			var basis := Basis.from_scale(size)
			if shape == "prism":
				basis = basis * Basis(Vector3.UP, PI * 0.5)
			return [m, Transform3D(basis, Vector3.ZERO)]
		"sphere", "octahedron", "icosahedron":
			var m := SphereMesh.new()
			m.radius = 0.5
			m.height = 1.0
			if shape == "octahedron":
				m.radial_segments = 4
				m.rings = 1
			elif shape == "icosahedron":
				m.radial_segments = 6
				m.rings = 2
			else:
				m.radial_segments = seg[1]
				m.rings = seg[2]
			return [m, Transform3D(Basis.from_scale(size), Vector3.ZERO)]
		"capsule":
			var r := maxf(0.0005, minf(size.x, size.z) * 0.5)
			var m := CapsuleMesh.new()
			m.radius = r
			m.height = maxf(size.y, r * 2.0)
			m.radial_segments = radial
			return [m, Transform3D(Basis.from_scale(Vector3(size.x / (2.0 * r), 1.0, size.z / (2.0 * r))), Vector3.ZERO)]
		"torus":
			var tube := minf(size.z, size.x * 0.45) * 0.5
			var big_r := maxf(0.001, size.x * 0.5 - tube)
			var m := TorusMesh.new()
			m.inner_radius = maxf(0.0005, big_r - tube)
			m.outer_radius = big_r + tube
			m.rings = 20 if detail != "low" else 12
			m.ring_segments = 6 if detail != "high" else 10
			# TorusMesh lies in XZ; the blueprint torus is a ring in XY, squashed to y / x.
			var basis := Basis.from_scale(Vector3(1.0, size.y / maxf(size.x, 0.0001), 1.0)) * Basis(Vector3.RIGHT, PI * 0.5)
			return [m, Transform3D(basis, Vector3.ZERO)]
		"wedge":
			return [_wedge_mesh(size), Transform3D.IDENTITY]
		"crescent":
			return [_crescent_mesh(size, 8 if detail == "low" else 12), Transform3D.IDENTITY]
	var b := BoxMesh.new()
	b.size = size
	return [b, Transform3D.IDENTITY]


func _wedge_mesh(s: Vector3) -> ArrayMesh:
	# Blade outline in XY (tip +Y), sharp edges at z = 0, ridge on each face (diamond cross-section).
	var o := [Vector2(-0.5, -0.5), Vector2(0.5, -0.5), Vector2(0.5, 0.2), Vector2(0, 0.5), Vector2(-0.5, 0.2)]
	var f := Vector3(0, -0.05, 0.5) * s
	var bk := Vector3(0, -0.05, -0.5) * s
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	for i in o.size():
		var a: Vector2 = o[i]
		var b: Vector2 = o[(i + 1) % o.size()]
		var va := Vector3(a.x * s.x, a.y * s.y, 0)
		var vb := Vector3(b.x * s.x, b.y * s.y, 0)
		# Godot front faces are clockwise: reversed relative to three.js.
		st.add_vertex(va)
		st.add_vertex(f)
		st.add_vertex(vb)
		st.add_vertex(vb)
		st.add_vertex(bk)
		st.add_vertex(va)
	st.generate_normals()
	return st.commit()


func _crescent_mesh(s: Vector3, n: int) -> ArrayMesh:
	# Moon arc in XY bulging toward +Y (horns at y = -0.5), extruded along Z.
	var outer: Array[Vector2] = []
	var inner: Array[Vector2] = []
	for i in n + 1:
		var t := float(i) / n * PI
		outer.append(Vector2(0.5 * cos(t), -0.5 + sin(t)))
		inner.append(Vector2(0.42 * cos(t), -0.5 + 0.7 * sin(t)))
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var hz := 0.5 * s.z
	var V := func(p: Vector2, z: float) -> Vector3: return Vector3(p.x * s.x, p.y * s.y, z)
	for i in n:
		var o0: Vector2 = outer[i]
		var o1: Vector2 = outer[i + 1]
		var i0: Vector2 = inner[i]
		var i1: Vector2 = inner[i + 1]
		# front (+z)
		_tri(st, V.call(o0, hz), V.call(i1, hz), V.call(o1, hz))
		_tri(st, V.call(o0, hz), V.call(i0, hz), V.call(i1, hz))
		# back (-z)
		_tri(st, V.call(o0, -hz), V.call(o1, -hz), V.call(i1, -hz))
		_tri(st, V.call(o0, -hz), V.call(i1, -hz), V.call(i0, -hz))
		# outer wall
		_tri(st, V.call(o0, hz), V.call(o1, hz), V.call(o1, -hz))
		_tri(st, V.call(o0, hz), V.call(o1, -hz), V.call(o0, -hz))
		# inner wall
		_tri(st, V.call(i0, hz), V.call(i0, -hz), V.call(i1, -hz))
		_tri(st, V.call(i0, hz), V.call(i1, -hz), V.call(i1, hz))
	# horn caps
	_tri(st, V.call(outer[0], hz), V.call(outer[0], -hz), V.call(inner[0], -hz))
	_tri(st, V.call(outer[0], hz), V.call(inner[0], -hz), V.call(inner[0], hz))
	_tri(st, V.call(outer[n], hz), V.call(inner[n], hz), V.call(inner[n], -hz))
	_tri(st, V.call(outer[n], hz), V.call(inner[n], -hz), V.call(outer[n], -hz))
	st.generate_normals()
	return st.commit()


func _tri(st: SurfaceTool, a: Vector3, b: Vector3, c: Vector3) -> void:
	st.add_vertex(a)
	st.add_vertex(b)
	st.add_vertex(c)


func _material(bp: Dictionary, p: Dictionary, role: String) -> StandardMaterial3D:
	var m: Variant = p.get("material")
	if typeof(m) == TYPE_STRING:
		var named: Dictionary = bp.get("materials", {})
		m = named.get(m, {"color": palette[0]})
	if typeof(m) != TYPE_DICTIONARY:
		m = p if p.has("color") else {}  # Counterforge parts carry colour inline
	var metal := role in METAL
	var gem := role in GEM
	var mat := StandardMaterial3D.new()
	var col := LiveforgeUtil.color(m.get("color"), LiveforgeUtil.color(palette[0]))
	mat.albedo_color = col
	mat.metallic = clampf(float(m.get("metalness", 0.35 if metal else (0.1 if gem else 0.05))), 0.0, 1.0)
	mat.roughness = clampf(float(m.get("roughness", 0.35 if metal else (0.2 if gem else 0.7))), 0.0, 1.0)
	mat.emission_enabled = true
	var em: Variant = m.get("emissive")
	if typeof(em) == TYPE_STRING and Color.html_is_valid(em) and str(em) != "#000000":
		mat.emission = Color.html(em)
		mat.emission_energy_multiplier = clampf(float(m.get("emissiveIntensity", 1.0)), 0.0, 3.0)
	else:
		# Faint self-glow of the part's own colour keeps blueprints readable in dark scenes.
		mat.emission = col
		mat.emission_energy_multiplier = 0.08
	var opacity := float(m.get("opacity", 1.0))
	if opacity < 1.0:
		mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		mat.albedo_color.a = clampf(opacity, 0.05, 1.0)
	if str(p.get("shape", "")) in ["wedge", "crescent"]:
		mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	return mat


func _measure_aabb() -> AABB:
	var box := AABB()
	var first := true
	for mi in _content.find_children("*", "MeshInstance3D", true, false):
		var xf := _local_xf(mi as Node3D)
		var b: AABB = xf * (mi as MeshInstance3D).get_aabb()
		if first:
			box = b
			first = false
		else:
			box = box.merge(b)
	if first:
		box = AABB(Vector3(-0.05, 0, -0.05), Vector3(0.1, 0.1, 0.1))
	return box


## Transform of `n` relative to _content (works before the node enters the tree).
func _local_xf(n: Node3D) -> Transform3D:
	var xf := Transform3D.IDENTITY
	var cur: Node = n
	while cur != null and cur != _content:
		if cur is Node3D:
			xf = (cur as Node3D).transform * xf
		cur = cur.get_parent()
	return xf
