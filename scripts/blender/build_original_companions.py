"""Build the four original companion VRMs with Blender + VRM Add-on."""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

CHARACTERS = [
    {
        "id": "mira",
        "file": "Mira.vrm",
        "name": "澄羽 MIRA",
        "body": "mini",
        "hair": "bob",
        "outfit": "cloak",
        "extra": "ribbon",
        "face": "soft",
        "palette": {
            "skin": "#f0d3ca",
            "hair": "#0c5961",
            "eye": "#78c9ca",
            "outfit": "#f0eadf",
            "accent": "#d6644a",
            "inner": "#d7e7ea",
            "secondary": "#0c5961",
        },
    },
    {
        "id": "kite",
        "file": "Kite.vrm",
        "name": "曜柚 KITE",
        "body": "mini",
        "hair": "ponytail",
        "outfit": "jacket",
        "extra": "clip",
        "face": "round",
        "palette": {
            "skin": "#efd1c4",
            "hair": "#2c2528",
            "eye": "#168b83",
            "outfit": "#fff4dd",
            "accent": "#f2c84b",
            "inner": "#3aa39a",
            "secondary": "#1a1a1c",
        },
    },
    {
        "id": "cael",
        "file": "Cael.vrm",
        "name": "凛序 CAEL",
        "body": "tall",
        "hair": "long",
        "outfit": "coat",
        "extra": "glasses",
        "face": "sharp",
        "palette": {
            "skin": "#e7c8bb",
            "hair": "#162433",
            "eye": "#86dce3",
            "outfit": "#1a2b3d",
            "accent": "#c69a52",
            "inner": "#d8e8ea",
            "secondary": "#0e1720",
        },
    },
    {
        "id": "lyra",
        "file": "Lyra.vrm",
        "name": "弦灯 LYRA",
        "body": "mini",
        "hair": "asym",
        "outfit": "studio",
        "extra": "sash",
        "face": "serene",
        "palette": {
            "skin": "#f0d3ca",
            "hair": "#463843",
            "eye": "#d4a24c",
            "outfit": "#3c2f3d",
            "accent": "#e78745",
            "inner": "#f4d7c0",
            "secondary": "#2a1f28",
        },
    },
]


def argv_value(flag: str, default: str) -> str:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if flag in args:
        index = args.index(flag)
        if index + 1 < len(args):
            return args[index + 1]
    return default


def hex_rgb(hex_color: str) -> tuple[float, float, float]:
    value = hex_color.lstrip("#")
    return (
        int(value[0:2], 16) / 255.0,
        int(value[2:4], 16) / 255.0,
        int(value[4:6], 16) / 255.0,
    )


def mix(a: tuple[float, float, float], b: tuple[float, float, float], t: float) -> tuple[float, float, float]:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def shade(rgb: tuple[float, float, float], factor: float = 0.72) -> tuple[float, float, float]:
    return (rgb[0] * factor, rgb[1] * factor, rgb[2] * factor)


def object_mode() -> None:
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")


def select_only(obj: bpy.types.Object) -> None:
    object_mode()
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def reset_scene() -> None:
    object_mode()
    if bpy.data.objects:
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete(use_global=True)
    for collection in (bpy.data.meshes, bpy.data.curves, bpy.data.armatures, bpy.data.materials, bpy.data.images, bpy.data.objects):
        for item in list(collection):
            if getattr(item, "users", 0) == 0:
                collection.remove(item)


def paint_roots() -> list[Path]:
    roots: list[Path] = []
    override = argv_value("--paint", "")
    if override:
        roots.append(Path(override))
    roots.append(Path(__file__).resolve().parents[2] / "apps/web/public/assets/characters/art/painted")
    return roots


def find_painted(spec_id: str, slot: str) -> Path | None:
    for root in paint_roots():
        path = root / f"{spec_id}_{slot}.png"
        if path.is_file():
            return path
    return None


def load_image(path: Path) -> bpy.types.Image:
    image = bpy.data.images.load(str(path), check_existing=False)
    image.name = path.stem
    image.pack()
    return image


def load_slot_image(spec: dict, slot: str) -> bpy.types.Image | None:
    path = find_painted(spec["id"], slot)
    if path is None:
        return None
    print(f"painted {spec['id']}_{slot}: {path}")
    return load_image(path)


def make_mtoon(name: str, color: tuple[float, float, float], image: bpy.types.Image | None = None, outline: float = 0.0034) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.vrm_addon_extension.mtoon1.enabled = True
    gltf = material.vrm_addon_extension.mtoon1
    factor = (1.0, 1.0, 1.0) if image is not None else color
    gltf.pbr_metallic_roughness.base_color_factor = (*factor, 1.0)
    gltf.double_sided = name.startswith("Hair") or name.startswith("Face")
    mtoon = gltf.extensions.vrmc_materials_mtoon
    mtoon.shade_color_factor = shade(color, 0.78 if image is not None else (0.68 if name.startswith("Skin") else 0.62))
    mtoon.shading_toony_factor = 0.92
    mtoon.shading_shift_factor = -0.08
    mtoon.outline_width_mode = "worldCoordinates"
    mtoon.outline_width_factor = outline
    mtoon.outline_color_factor = shade(color, 0.22)
    if image is not None:
        gltf.pbr_metallic_roughness.base_color_texture.index.source = image
        mtoon.shade_multiply_texture.index.source = image
    return material


def bounds_uv(obj: bpy.types.Object, axes: str = "xz") -> None:
    mesh = obj.data
    if mesh.uv_layers.active is None:
        mesh.uv_layers.new(name="UVMap")
    axis_index = {"x": 0, "y": 1, "z": 2}
    axis_u = axis_index[axes[0]]
    axis_v = axis_index[axes[1]]
    coords = [(vertex.co[axis_u], vertex.co[axis_v]) for vertex in mesh.vertices]
    min_u = min(item[0] for item in coords)
    max_u = max(item[0] for item in coords)
    min_v = min(item[1] for item in coords)
    max_v = max(item[1] for item in coords)
    span_u = max(max_u - min_u, 1e-6)
    span_v = max(max_v - min_v, 1e-6)
    uv_layer = mesh.uv_layers.active
    for loop in mesh.loops:
        vertex = mesh.vertices[loop.vertex_index]
        uv_layer.data[loop.index].uv = (
            (vertex.co[axis_u] - min_u) / span_u,
            (vertex.co[axis_v] - min_v) / span_v,
        )


def smart_uv(obj: bpy.types.Object) -> None:
    if obj.type != "MESH" or not obj.data.vertices:
        return
    select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    try:
        bpy.ops.uv.smart_project(angle_limit=1.15192, island_margin=0.018, scale_to_bounds=True)
    except Exception:
        bpy.ops.uv.cube_project(cube_size=1.0, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def bone_head_tail(armature: bpy.types.Object, name: str) -> tuple[Vector, Vector]:
    bone = armature.data.bones[name]
    return armature.matrix_world @ bone.head_local, armature.matrix_world @ bone.tail_local


def add_mesh_primitive(op_name: str, **kwargs) -> bpy.types.Object:
    getattr(bpy.ops.mesh, op_name)(**kwargs)
    return bpy.context.active_object


def add_capsule(head: Vector, tail: Vector, radius: float, segments: int = 20) -> bpy.types.Object:
    direction = tail - head
    length = max(direction.length, 0.012)
    center = (head + tail) * 0.5
    obj = add_mesh_primitive("primitive_cylinder_add", radius=radius, depth=length, vertices=segments, location=center)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0.0, 0.0, 1.0)).rotation_difference(direction.normalized())
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, segments=segments, ring_count=max(10, segments // 2), location=head)
    cap_a = bpy.context.active_object
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius * 0.92, segments=segments, ring_count=max(10, segments // 2), location=tail)
    cap_b = bpy.context.active_object
    return join_objects([obj, cap_a, cap_b], obj.name)


def add_sphere(location: Vector, radius: float, segments: int = 28) -> bpy.types.Object:
    return add_mesh_primitive("primitive_uv_sphere_add", radius=radius, segments=segments, ring_count=18, location=location)


def join_objects(objects: list[bpy.types.Object], name: str) -> bpy.types.Object:
    objects = [obj for obj in objects if obj is not None]
    if not objects:
        raise RuntimeError("nothing to join")
    object_mode()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    objects[0].name = name
    return objects[0]


def apply_subdiv(obj: bpy.types.Object, levels: int = 1) -> None:
    select_only(obj)
    modifier = obj.modifiers.new("subdiv", "SUBSURF")
    modifier.levels = levels
    modifier.render_levels = levels
    bpy.ops.object.modifier_apply(modifier="subdiv")
    bpy.ops.object.shade_smooth()


def remesh_smooth(obj: bpy.types.Object, voxel: float = 0.016) -> None:
    select_only(obj)
    before = len(obj.data.vertices)
    backup = obj.data.copy()
    modifier = obj.modifiers.new("remesh", "REMESH")
    modifier.mode = "VOXEL"
    modifier.voxel_size = voxel
    modifier.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier="remesh")
    if len(obj.data.vertices) < 80:
        print(f"remesh produced {len(obj.data.vertices)} verts from {before}; restoring capsules")
        obj.data = backup
        return
    bpy.data.meshes.remove(backup)
    smooth = obj.modifiers.new("smooth", "SMOOTH")
    smooth.factor = 0.5
    smooth.iterations = 8
    bpy.ops.object.modifier_apply(modifier="smooth")
    bpy.ops.object.shade_smooth()
    print(f"{obj.name}: {before} -> {len(obj.data.vertices)} verts")


def dist_point_segment(point: Vector, head: Vector, tail: Vector) -> float:
    direction = tail - head
    length_sq = direction.length_squared
    if length_sq < 1e-10:
        return (point - head).length
    t = max(0.0, min(1.0, (point - head).dot(direction) / length_sq))
    return (point - (head + direction * t)).length


def bind_nearest_bones(mesh_obj: bpy.types.Object, armature: bpy.types.Object) -> None:
    bones = [bone for bone in armature.data.bones if bone.name != "root" and not bone.name.startswith("eye.")]
    groups = {bone.name: mesh_obj.vertex_groups.new(name=bone.name) for bone in bones}
    mesh_from_arm = mesh_obj.matrix_world.inverted() @ armature.matrix_world
    segments = [(bone.name, mesh_from_arm @ bone.head_local, mesh_from_arm @ bone.tail_local) for bone in bones]
    for index, vertex in enumerate(mesh_obj.data.vertices):
        ranked: list[tuple[float, str]] = []
        for name, head, tail in segments:
            ranked.append((dist_point_segment(vertex.co, head, tail), name))
        ranked.sort(key=lambda item: item[0])
        nearest = ranked[0][0]
        chosen = [item for item in ranked[:3] if item[0] <= nearest * 2.6 + 0.018]
        weights = [(1.0 / max(distance, 0.01), name) for distance, name in chosen]
        total = sum(weight for weight, _ in weights) or 1.0
        for weight, name in weights:
            groups[name].add([index], weight / total, "ADD")
    modifier = mesh_obj.modifiers.new("Armature", "ARMATURE")
    modifier.object = armature
    modifier.use_vertex_groups = True
    world = mesh_obj.matrix_world.copy()
    mesh_obj.parent = armature
    mesh_obj.matrix_world = world


def parent_keep_world(obj: bpy.types.Object, armature: bpy.types.Object, bone_name: str) -> None:
    world = obj.matrix_world.copy()
    obj.parent = armature
    obj.parent_type = "BONE"
    obj.parent_bone = bone_name
    bpy.context.view_layer.update()
    obj.matrix_world = world


def assign_material(obj: bpy.types.Object, material: bpy.types.Material) -> None:
    obj.data.materials.clear()
    obj.data.materials.append(material)


def parent_armature(obj: bpy.types.Object, armature: bpy.types.Object) -> None:
    object_mode()
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


def parent_bone(obj: bpy.types.Object, armature: bpy.types.Object, bone_name: str) -> None:
    obj.parent = armature
    obj.parent_type = "BONE"
    obj.parent_bone = bone_name


def radius_for(bone_name: str, mini: bool) -> float | None:
    name = bone_name.lower()
    if name in {"root", "eye.l", "eye.r"}:
        return None
    scale = 0.94 if mini else 1.0
    if name == "head":
        return 0.11 * scale
    if name == "neck":
        return 0.036 * scale
    if name == "spine":
        return 0.068 * scale
    if name == "chest":
        return 0.082 * scale
    if name == "hips":
        return 0.096 * scale
    if "shoulder" in name:
        return 0.038 * scale
    if "upper_arm" in name:
        return 0.034 * scale
    if "lower_arm" in name:
        return 0.028 * scale
    if name.endswith("hand.l") or name.endswith("hand.r") or name in {"hand.l", "hand.r"}:
        return 0.024 * scale
    if "upper_leg" in name:
        return 0.058 * scale
    if "lower_leg" in name:
        return 0.046 * scale
    if "foot" in name:
        return 0.032 * scale
    if "toes" in name:
        return 0.02 * scale
    if any(part in name for part in ("thumb", "index", "middle", "ring", "little")):
        return 0.0074 * scale
    return 0.02 * scale


def paint_face_image(spec: dict) -> bpy.types.Image:
    width = 512
    skin = hex_rgb(spec["palette"]["skin"])
    eye = hex_rgb(spec["palette"]["eye"])
    accent = hex_rgb(spec["palette"]["accent"])
    hair = hex_rgb(spec["palette"]["hair"])
    pixels = [0.0] * (width * width * 4)
    face = spec["face"]
    round_face = face == "round"
    sharp = face == "sharp"
    smile = 1.0 if face in {"round", "serene"} else 0.55 if face == "soft" else 0.2

    def put(x: int, y: int, rgb: tuple[float, float, float], alpha: float = 1.0) -> None:
        if x < 0 or y < 0 or x >= width or y >= width:
            return
        index = (y * width + x) * 4
        pixels[index : index + 4] = [rgb[0], rgb[1], rgb[2], alpha]

    def ellipse(cx: float, cy: float, rx: float, ry: float, rgb: tuple[float, float, float], alpha: float = 1.0) -> None:
        x0 = max(0, int(cx - rx) - 1)
        x1 = min(width - 1, int(cx + rx) + 1)
        y0 = max(0, int(cy - ry) - 1)
        y1 = min(width - 1, int(cy + ry) + 1)
        rx2 = max(rx * rx, 1.0)
        ry2 = max(ry * ry, 1.0)
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if ((x - cx) ** 2) / rx2 + ((y - cy) ** 2) / ry2 <= 1.0:
                    put(x, y, rgb, alpha)

    for y in range(width):
        for x in range(width):
            shade_v = 1.0 - abs(x / width - 0.5) * 0.06 - (y / width) * 0.03
            put(x, y, (min(1.0, skin[0] * shade_v), min(1.0, skin[1] * shade_v), min(1.0, skin[2] * shade_v)))
    ellipse(168, 318, 58, 28, mix(skin, accent, 0.18), 0.35)
    ellipse(344, 318, 58, 28, mix(skin, accent, 0.18), 0.35)
    brow_y = 168 if sharp else 176
    brow_w = 54 if sharp else 62 if round_face else 58
    ellipse(170, brow_y, brow_w, 6 if sharp else 8, mix(hair, (0.16, 0.12, 0.11), 0.35))
    ellipse(342, brow_y, brow_w, 6 if sharp else 8, mix(hair, (0.16, 0.12, 0.11), 0.35))
    eye_y = 232
    eye_rx = 58 if round_face else 46 if sharp else 52
    eye_ry = 32 if round_face else 22 if sharp else 28
    for cx in (168, 344):
        ellipse(cx, eye_y, eye_rx, eye_ry, (0.99, 0.98, 0.97))
        ellipse(cx + (4 if sharp else 0), eye_y + 2, eye_rx * 0.55, eye_ry * 0.78, eye)
        ellipse(cx + 2, eye_y + 4, 11, 14, (0.11, 0.09, 0.13))
        ellipse(cx - 10, eye_y - 8, 8, 7, (1.0, 1.0, 1.0))
        ellipse(cx, eye_y - eye_ry + 2, eye_rx, 7, mix(hair, (0.08, 0.06, 0.07), 0.2))
    mouth_y = 348 + smile * 4
    ellipse(256, mouth_y, 28 + smile * 10, 6 + smile * 5, mix(accent, (0.35, 0.16, 0.16), 0.45))
    ellipse(256, mouth_y - 2, 22 + smile * 8, 3 + smile * 2, mix(skin, (1.0, 0.86, 0.82), 0.35))
    image = bpy.data.images.new(f"{spec['id']}_face", width=width, height=width, alpha=True)
    image.pixels = pixels
    image.pack()
    return image


def face_image_for(spec: dict) -> bpy.types.Image:
    painted = load_slot_image(spec, "face")
    if painted is not None:
        return painted
    return paint_face_image(spec)


def add_face_card(armature: bpy.types.Object, spec: dict, material: bpy.types.Material) -> bpy.types.Object:
    head, tail = bone_head_tail(armature, "head")
    center = (head + tail) * 0.5
    size_x = 0.172 if spec["body"] == "mini" else 0.154
    size_z = 0.166 if spec["body"] == "mini" else 0.15
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=22, y_subdivisions=18, size=1.0, location=(center.x, center.y - 0.07, center.z + 0.012))
    face = bpy.context.active_object
    face.name = "FaceFront"
    face.rotation_euler = (math.radians(90.0), 0.0, 0.0)
    face.scale = (size_x, 1.0, size_z)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for vertex in face.data.vertices:
        vertex.co.y -= abs(vertex.co.x) * 0.12 + abs(vertex.co.z) * 0.04
    bounds_uv(face, "xz")
    assign_material(face, material)
    face.shape_key_add(name="Basis")
    key_map = {
        "happy": (0.0, 0.0, 0.012),
        "relaxed": (0.0, 0.0, -0.006),
        "surprised": (0.0, -0.004, 0.01),
        "sad": (0.0, 0.0, -0.01),
        "aa": (0.0, -0.012, 0.002),
        "ih": (0.0, -0.004, 0.0),
        "ou": (0.0, -0.006, 0.008),
        "ee": (0.0, -0.003, -0.001),
        "oh": (0.0, -0.009, 0.005),
        "blink": (0.0, 0.0, -0.018),
    }
    for name, offset in key_map.items():
        key = face.shape_key_add(name=name)
        for index, vertex in enumerate(face.data.vertices):
            u = (vertex.co.x / size_x + 1.0) * 0.5
            v = (vertex.co.z / size_z + 1.0) * 0.5
            mouth = v < 0.38 and 0.28 < u < 0.72
            lid = v > 0.55 and ((0.16 < u < 0.42) or (0.58 < u < 0.84))
            if name in {"happy", "sad"} and mouth:
                side = -1.0 if u < 0.5 else 1.0
                key.data[index].co.z += offset[2] * (0.6 if name == "sad" else 1.0)
                key.data[index].co.x += side * 0.004
            elif name == "aa" and mouth:
                key.data[index].co.z -= 0.016
                key.data[index].co.y -= 0.006
            elif name == "ih" and mouth:
                key.data[index].co.z -= 0.007
                key.data[index].co.x *= 1.08
            elif name == "ee" and mouth:
                side = -1.0 if u < 0.5 else 1.0
                key.data[index].co.z -= 0.005
                key.data[index].co.x += side * 0.006
            elif name == "ou" and mouth:
                key.data[index].co.z -= 0.008
                key.data[index].co.y -= 0.01
                key.data[index].co.x *= 0.86
            elif name == "oh" and mouth:
                key.data[index].co.z -= 0.013
                key.data[index].co.y -= 0.007
                key.data[index].co.x *= 0.9
            elif name == "surprised" and mouth:
                key.data[index].co.z -= 0.012
                key.data[index].co.y -= 0.004
            elif name in {"blink", "relaxed", "surprised"} and lid:
                key.data[index].co.z += offset[2]
    return face


def add_curve_hair(points: list[Vector], radius: float, name: str) -> bpy.types.Object:
    curve_data = bpy.data.curves.new(name, "CURVE")
    curve_data.dimensions = "3D"
    curve_data.bevel_depth = radius
    curve_data.bevel_resolution = 3
    curve_data.fill_mode = "FULL"
    spline = curve_data.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for point, bezier in zip(points, spline.bezier_points):
        bezier.co = point
        bezier.handle_left_type = "AUTO"
        bezier.handle_right_type = "AUTO"
        bezier.radius = 1.0
    obj = bpy.data.objects.new(name, curve_data)
    bpy.context.collection.objects.link(obj)
    select_only(obj)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.active_object


def add_hair(armature: bpy.types.Object, spec: dict, material: bpy.types.Material, inner_material: bpy.types.Material) -> list[bpy.types.Object]:
    head, tail = bone_head_tail(armature, "head")
    center = (head + tail) * 0.5
    meshes: list[bpy.types.Object] = []
    style = spec["hair"]
    bangs = [
        add_curve_hair([
            center + Vector((side * 0.028, -0.062, 0.068)),
            center + Vector((side * 0.052, -0.086, 0.012)),
            center + Vector((side * 0.04, -0.074, -0.046)),
        ], 0.015, f"bang_{side}")
        for side in (-1.0, -0.45, 0.0, 0.45, 1.0)
    ]
    meshes.extend(bangs)
    if style == "bob":
        cap = add_sphere(center + Vector((0.0, 0.014, 0.034)), 0.138)
        meshes.append(cap)
        for side in (-1.0, 1.0):
            meshes.append(add_curve_hair([
                center + Vector((side * 0.06, -0.03, 0.07)),
                center + Vector((side * 0.13, -0.018, 0.01)),
                center + Vector((side * 0.12, 0.02, -0.08)),
                center + Vector((side * 0.09, 0.04, -0.14)),
            ], 0.032, f"bob_{side}"))
            meshes.append(add_curve_hair([
                center + Vector((side * 0.04, -0.05, 0.04)),
                center + Vector((side * 0.09, -0.06, -0.02)),
                center + Vector((side * 0.08, -0.03, -0.1)),
            ], 0.02, f"bob_cheek_{side}"))
            meshes.append(add_curve_hair([
                center + Vector((side * 0.08, 0.0, 0.06)),
                center + Vector((side * 0.14, 0.01, -0.02)),
                center + Vector((side * 0.11, 0.03, -0.12)),
            ], 0.018, f"bob_layer_{side}"))
        meshes.append(add_curve_hair([
            center + Vector((0.0, 0.05, 0.08)),
            center + Vector((0.0, 0.1, 0.02)),
            center + Vector((0.0, 0.09, -0.1)),
        ], 0.038, "bob_back"))
    elif style == "ponytail":
        meshes.append(add_sphere(center + Vector((0.0, 0.02, 0.045)), 0.128))
        for side in (-1.0, 1.0):
            meshes.append(add_curve_hair([
                center + Vector((side * 0.05, -0.045, 0.055)),
                center + Vector((side * 0.09, -0.032, 0.0)),
                center + Vector((side * 0.075, -0.008, -0.06)),
            ], 0.019, f"pony_side_{side}"))
        meshes.append(add_sphere(center + Vector((0.0, 0.086, 0.074)), 0.03))
        meshes.append(add_curve_hair([
            center + Vector((0.0, 0.086, 0.082)),
            center + Vector((0.014, 0.12, -0.02)),
            center + Vector((-0.012, 0.11, -0.18)),
            center + Vector((0.024, 0.086, -0.34)),
            center + Vector((0.0, 0.048, -0.52)),
        ], 0.026, "tail"))
        meshes.append(add_curve_hair([
            center + Vector((0.0, 0.074, 0.07)),
            center + Vector((-0.024, 0.11, -0.08)),
            center + Vector((0.016, 0.096, -0.26)),
            center + Vector((-0.012, 0.06, -0.44)),
        ], 0.017, "tail_soft"))
        meshes.append(add_curve_hair([
            center + Vector((0.01, 0.08, 0.06)),
            center + Vector((0.03, 0.1, -0.12)),
            center + Vector((0.018, 0.07, -0.3)),
        ], 0.014, "tail_fly"))
        meshes.append(add_curve_hair([
            center + Vector((-0.02, 0.09, 0.05)),
            center + Vector((-0.04, 0.12, -0.1)),
            center + Vector((-0.02, 0.08, -0.28)),
            center + Vector((0.01, 0.05, -0.46)),
        ], 0.012, "tail_fly2"))
    elif style == "long":
        meshes.append(add_sphere(center + Vector((0.0, 0.022, 0.05)), 0.132))
        for side in (-1.0, 1.0):
            meshes.append(add_curve_hair([
                center + Vector((side * 0.052, 0.02, 0.078)),
                center + Vector((side * 0.1, 0.056, -0.04)),
                center + Vector((side * 0.086, 0.044, -0.22)),
                center + Vector((side * 0.064, 0.03, -0.4)),
                center + Vector((side * 0.04, 0.016, -0.54)),
            ], 0.028, f"long_{side}"))
            meshes.append(add_curve_hair([
                center + Vector((side * 0.03, -0.014, 0.052)),
                center + Vector((side * 0.078, 0.02, -0.1)),
                center + Vector((side * 0.056, 0.032, -0.3)),
                center + Vector((side * 0.03, 0.02, -0.48)),
            ], 0.019, f"long_front_{side}"))
            meshes.append(add_curve_hair([
                center + Vector((side * 0.02, 0.04, 0.04)),
                center + Vector((side * 0.06, 0.07, -0.16)),
                center + Vector((side * 0.04, 0.05, -0.36)),
            ], 0.016, f"long_wave_{side}"))
            meshes.append(add_curve_hair([
                center + Vector((side * 0.07, 0.03, 0.06)),
                center + Vector((side * 0.11, 0.05, -0.12)),
                center + Vector((side * 0.08, 0.04, -0.32)),
                center + Vector((side * 0.05, 0.02, -0.5)),
            ], 0.015, f"long_cape_{side}"))
    else:
        meshes.append(add_sphere(center + Vector((-0.018, 0.022, 0.032)), 0.124))
        meshes.append(add_curve_hair([
            center + Vector((0.05, -0.032, 0.055)),
            center + Vector((0.13, -0.008, -0.016)),
            center + Vector((0.15, 0.028, -0.12)),
            center + Vector((0.11, 0.04, -0.22)),
        ], 0.034, "asym_main"))
        meshes.append(add_curve_hair([
            center + Vector((0.02, 0.044, 0.064)),
            center + Vector((0.09, 0.07, -0.02)),
            center + Vector((0.1, 0.056, -0.16)),
        ], 0.024, "asym_back"))
        meshes.append(add_curve_hair([
            center + Vector((0.06, -0.02, 0.03)),
            center + Vector((0.1, 0.01, -0.08)),
            center + Vector((0.08, 0.02, -0.16)),
        ], 0.018, "asym_layer"))
        meshes.append(add_curve_hair([
            center + Vector((0.04, -0.05, 0.05)),
            center + Vector((0.12, -0.02, -0.04)),
            center + Vector((0.16, 0.02, -0.14)),
        ], 0.016, "asym_flare"))
        inner = add_curve_hair([
            center + Vector((-0.04, 0.03, 0.044)),
            center + Vector((-0.09, 0.056, -0.03)),
            center + Vector((-0.078, 0.044, -0.16)),
        ], 0.021, "asym_inner")
        assign_material(inner, inner_material)
        meshes.append(inner)
    hair_meshes = [mesh for mesh in meshes if mesh.name != "asym_inner"]
    joined = join_objects(hair_meshes, "Hair")
    assign_material(joined, material)
    apply_subdiv(joined, 1)
    result = [joined]
    if spec["hair"] == "asym":
        result.append(inner)
    return result


def add_box(location: Vector, scale: Vector, name: str) -> bpy.types.Object:
    obj = add_mesh_primitive("primitive_cube_add", size=1.0, location=location)
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.name = name
    return obj


def taper_mesh(obj: bpy.types.Object, bottom_scale: float = 0.78, top_scale: float = 1.0) -> None:
    zs = [vertex.co.z for vertex in obj.data.vertices]
    zmin, zmax = min(zs), max(zs)
    span = max(zmax - zmin, 1e-6)
    for vertex in obj.data.vertices:
        mix_t = (vertex.co.z - zmin) / span
        scale = bottom_scale + (top_scale - bottom_scale) * mix_t
        vertex.co.x *= scale
        vertex.co.y *= scale


def add_sleeve(armature: bpy.types.Object, side: str, radius: float, name: str) -> bpy.types.Object:
    candidates = [
        (f"upper_arm.{side}", f"lower_arm.{side}"),
        (f"upper_arm.{side.lower()}", f"lower_arm.{side.lower()}"),
        (f"shoulder.{side}", f"lower_arm.{side}"),
    ]
    bones = armature.data.bones
    for start_name, end_name in candidates:
        if start_name in bones and end_name in bones:
            head, _ = bone_head_tail(armature, start_name)
            _, tail = bone_head_tail(armature, end_name)
            sleeve = add_capsule(head, tail, radius, 14)
            sleeve.name = name
            return sleeve
    raise RuntimeError(f"arm bones for sleeve {name} were not found")


def add_outfit(armature: bpy.types.Object, spec: dict, cloth: bpy.types.Material, inner: bpy.types.Material, secondary: bpy.types.Material, accent: bpy.types.Material) -> list[bpy.types.Object]:
    hips, _ = bone_head_tail(armature, "hips")
    chest, _ = bone_head_tail(armature, "chest")
    neck, _ = bone_head_tail(armature, "neck")
    parts: list[bpy.types.Object] = []
    if spec["outfit"] == "cloak":
        cape = add_box(Vector((0.0, 0.08, hips.z + 0.08)), Vector((0.5, 0.13, 0.84)), "Cloth")
        taper_mesh(cape, 0.58, 1.14)
        hood = add_box(Vector((0.0, 0.06, neck.z + 0.04)), Vector((0.22, 0.12, 0.12)), "Collar")
        taper_mesh(hood, 0.88, 1.12)
        assign_material(cape, cloth)
        assign_material(hood, cloth)
        inner_top = add_box(Vector((0.0, -0.03, chest.z - 0.01)), Vector((0.17, 0.09, 0.2)), "InnerCloth")
        taper_mesh(inner_top, 0.82, 1.0)
        assign_material(inner_top, inner)
        ribbon = add_box(Vector((0.08, -0.08, neck.z + 0.01)), Vector((0.055, 0.025, 0.045)), "AccentTrim")
        assign_material(ribbon, accent)
        parts.extend([cape, hood, inner_top, ribbon])
    elif spec["outfit"] == "jacket":
        jacket = add_box(Vector((0.0, -0.008, chest.z)), Vector((0.32, 0.17, 0.34)), "Cloth")
        taper_mesh(jacket, 0.84, 1.08)
        assign_material(jacket, cloth)
        hem = add_box(Vector((0.0, 0.01, hips.z + 0.04)), Vector((0.26, 0.12, 0.08)), "Collar")
        taper_mesh(hem, 0.96, 1.04)
        assign_material(hem, cloth)
        shirt = add_box(Vector((0.0, -0.04, chest.z - 0.02)), Vector((0.16, 0.1, 0.18)), "InnerCloth")
        taper_mesh(shirt, 0.88, 1.0)
        assign_material(shirt, inner)
        shorts = add_box(Vector((0.0, 0.0, hips.z - 0.03)), Vector((0.21, 0.13, 0.2)), "SecondaryCloth")
        taper_mesh(shorts, 0.9, 1.06)
        assign_material(shorts, secondary)
        left_sleeve = add_sleeve(armature, "L", 0.04, "Sleeve_L")
        right_sleeve = add_sleeve(armature, "R", 0.04, "Sleeve_R")
        assign_material(left_sleeve, cloth)
        assign_material(right_sleeve, cloth)
        parts.extend([jacket, hem, shirt, shorts, left_sleeve, right_sleeve])
    elif spec["outfit"] == "coat":
        coat = add_box(Vector((0.0, 0.04, hips.z + 0.08)), Vector((0.36, 0.19, 1.02)), "Cloth")
        taper_mesh(coat, 0.66, 1.08)
        assign_material(coat, cloth)
        lapel = add_box(Vector((0.0, -0.08, chest.z + 0.04)), Vector((0.2, 0.06, 0.22)), "Collar")
        taper_mesh(lapel, 0.9, 1.06)
        assign_material(lapel, cloth)
        shirt = add_box(Vector((0.0, -0.03, chest.z)), Vector((0.17, 0.11, 0.24)), "InnerCloth")
        taper_mesh(shirt, 0.86, 1.0)
        assign_material(shirt, inner)
        trim = add_box(Vector((0.0, -0.12, chest.z + 0.05)), Vector((0.035, 0.02, 0.22)), "AccentTrim")
        assign_material(trim, accent)
        left_sleeve = add_sleeve(armature, "L", 0.042, "Sleeve_L")
        right_sleeve = add_sleeve(armature, "R", 0.042, "Sleeve_R")
        assign_material(left_sleeve, cloth)
        assign_material(right_sleeve, cloth)
        parts.extend([coat, lapel, shirt, trim, left_sleeve, right_sleeve])
    else:
        wrap = add_box(Vector((0.02, 0.016, hips.z + 0.1)), Vector((0.28, 0.15, 0.72)), "Cloth")
        taper_mesh(wrap, 0.64, 1.1)
        assign_material(wrap, cloth)
        inner_top = add_box(Vector((0.0, -0.04, chest.z)), Vector((0.15, 0.09, 0.2)), "InnerCloth")
        taper_mesh(inner_top, 0.84, 1.0)
        assign_material(inner_top, inner)
        sash = add_box(Vector((0.02, -0.07, hips.z + 0.09)), Vector((0.24, 0.055, 0.07)), "AccentTrim")
        assign_material(sash, accent)
        drape = add_box(Vector((0.08, -0.02, hips.z - 0.02)), Vector((0.08, 0.04, 0.22)), "Collar")
        taper_mesh(drape, 0.7, 1.05)
        assign_material(drape, accent)
        left_leg, left_foot = bone_head_tail(armature, "upper_leg.L")
        stocking = add_capsule(left_leg, left_foot, 0.05)
        stocking.name = "SecondaryCloth"
        assign_material(stocking, secondary)
        parts.extend([wrap, inner_top, sash, drape, stocking])
    if spec["extra"] == "glasses":
        for side in (-1.0, 1.0):
            lens = add_mesh_primitive("primitive_torus_add", major_radius=0.028, minor_radius=0.004, location=(center_x(armature, side), -0.09, neck.z + 0.08))
            lens.name = f"Glasses_{side}"
            assign_material(lens, accent)
            parts.append(lens)
    elif spec["extra"] == "clip":
        clip = add_box(Vector((-0.07, -0.08, neck.z + 0.14)), Vector((0.05, 0.02, 0.02)), "HairClip")
        assign_material(clip, accent)
        parts.append(clip)
    for part in parts:
        levels = 2 if part.name in {"Cloth", "Collar", "InnerCloth", "SecondaryCloth", "Sleeve_L", "Sleeve_R"} else 1
        apply_subdiv(part, levels)
        if part.name in {"Cloth", "Collar", "InnerCloth", "SecondaryCloth", "Sleeve_L", "Sleeve_R", "AccentTrim"}:
            smart_uv(part)
    return parts


def center_x(armature: bpy.types.Object, side: float) -> float:
    head, _ = bone_head_tail(armature, "head")
    return head.x + side * 0.04


def bind_expressions(armature: bpy.types.Object, face: bpy.types.Object) -> None:
    preset = armature.data.vrm_addon_extension.vrm1.expressions.preset
    for name in ("happy", "relaxed", "surprised", "sad", "aa", "ih", "ou", "ee", "oh", "blink"):
        expression = getattr(preset, name)
        expression.is_binary = False
        bind = expression.morph_target_binds.add()
        bind.node.bpy_object = face
        bind.index = name
        bind.weight = 1.0


def set_meta(armature: bpy.types.Object, spec: dict) -> None:
    armature.data.vrm_addon_extension.spec_version = "1.0"
    meta = armature.data.vrm_addon_extension.vrm1.meta
    meta.vrm_name = spec["name"]
    meta.version = "1.4.0"
    if len(meta.authors) == 0:
        meta.authors.add()
    meta.authors[0].value = "Companion Space"
    meta.copyright_information = "Companion Space project original companion"
    meta.avatar_permission = "everyone"
    meta.allow_excessively_violent_usage = False
    meta.allow_excessively_sexual_usage = False
    meta.commercial_usage = "personalProfit"
    meta.allow_political_or_religious_usage = False
    meta.allow_antisocial_or_hate_usage = False
    meta.credit_notation = "unnecessary"
    meta.allow_redistribution = True
    meta.modification = "allowModificationRedistribution"
    meta.other_license_url = "https://vrm.dev/licenses/1.0/"


def build_body(armature: bpy.types.Object, spec: dict, skin: bpy.types.Material) -> bpy.types.Object:
    mini = spec["body"] == "mini"
    parts: list[bpy.types.Object] = []
    for bone in armature.data.bones:
        radius = radius_for(bone.name, mini)
        if radius is None:
            continue
        head, tail = bone_head_tail(armature, bone.name)
        if bone.name == "head":
            parts.append(add_sphere((head + tail) * 0.5, radius, 32))
        elif bone.name == "hips":
            parts.append(add_sphere(head, radius * 1.15, 24))
            parts.append(add_capsule(head, tail, radius * 0.86))
        else:
            parts.append(add_capsule(head, tail, radius, 16 if radius < 0.02 else 22))
    body = join_objects(parts, "BodySkin")
    assign_material(body, skin)
    remesh_smooth(body, 0.015 if mini else 0.016)
    return body


def build_character(spec: dict, output_dir: Path, blend_dir: Path) -> Path:
    reset_scene()
    mini = spec["body"] == "mini"
    bpy.ops.icyp.make_basic_armature(
        tall=1.42 if mini else 1.68,
        head_ratio=5.7 if mini else 7.1,
        aging_ratio=0.28 if mini else 0.62,
        shoulder_width=0.07 if mini else 0.09,
        hand_ratio=1.05,
    )
    armature = bpy.context.active_object
    if armature is None or armature.type != "ARMATURE":
        raise RuntimeError("VRM humanoid armature was not created")
    set_meta(armature, spec)
    palette = spec["palette"]
    face_image = face_image_for(spec)
    hair_image = load_slot_image(spec, "hair")
    cloth_image = load_slot_image(spec, "cloth")
    skin = make_mtoon("Skin", hex_rgb(palette["skin"]))
    cloth = make_mtoon("Cloth", hex_rgb(palette["outfit"]), image=cloth_image)
    inner = make_mtoon("Inner", hex_rgb(palette["inner"]), outline=0.0024)
    secondary = make_mtoon("Secondary", hex_rgb(palette["secondary"]))
    hair = make_mtoon("Hair", hex_rgb(palette["hair"]), image=hair_image)
    accent = make_mtoon("Accent", hex_rgb(palette["accent"]), outline=0.002)
    face_mat = make_mtoon("Face", hex_rgb(palette["skin"]), image=face_image, outline=0.0022)
    body = build_body(armature, spec, skin)
    face = add_face_card(armature, spec, face_mat)
    hair_objs = add_hair(armature, spec, hair, accent)
    for hair_obj in hair_objs:
        smart_uv(hair_obj)
    outfit_objs = add_outfit(armature, spec, cloth, inner, secondary, accent)
    bind_nearest_bones(body, armature)
    for obj in hair_objs:
        bind_nearest_bones(obj, armature)
    rigid_parts = {"AccentTrim", "HairClip", "Glasses_-1.0", "Glasses_1.0"}
    sleeve_parts = {"Sleeve_L", "Sleeve_R"}
    for obj in outfit_objs:
        if obj.name in rigid_parts or obj.name.startswith("Glasses"):
            bone_name = "head" if obj.name == "HairClip" else "chest"
            parent_keep_world(obj, armature, bone_name)
        elif obj.name in sleeve_parts:
            bind_nearest_bones(obj, armature)
        else:
            bind_nearest_bones(obj, armature)
    parent_keep_world(face, armature, "head")
    bind_expressions(armature, face)
    print("scene objects:")
    for obj in bpy.context.scene.objects:
        verts = len(obj.data.vertices) if getattr(obj.data, "vertices", None) else 0
        print(f"  {obj.name} type={obj.type} verts={verts} parent={obj.parent.name if obj.parent else '-'} vg={len(obj.vertex_groups)}")
    blend_path = blend_dir / f"{spec['id']}.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    output_path = output_dir / spec["file"]
    result = bpy.ops.export_scene.vrm(filepath=str(output_path), ignore_warning=True, armature_object_name=armature.name)
    if result != {"FINISHED"}:
        raise RuntimeError(f"VRM export failed for {spec['id']}: {result}")
    print(f"exported {output_path} ({output_path.stat().st_size} bytes)")
    return output_path


def main() -> None:
    output_dir = Path(argv_value("--out", str(Path(__file__).resolve().parents[2] / "apps/web/public/assets/characters/models")))
    blend_dir = Path(
        argv_value(
            "--blend",
            str(Path(__file__).resolve().parents[2] / "build/original-companions"),
        )
    )
    only = argv_value("--only", "")
    output_dir.mkdir(parents=True, exist_ok=True)
    blend_dir.mkdir(parents=True, exist_ok=True)
    targets = [item for item in CHARACTERS if not only or item["id"] == only]
    if not targets:
        raise RuntimeError(f"unknown character id: {only}")
    for spec in targets:
        print(f"building {spec['id']}...")
        build_character(spec, output_dir, blend_dir)
    print("done")


if __name__ == "__main__":
    main()
