"""Export what dot wears as web models, headless with Blender (5.1).

Blender --background --factory-startup --python export_glb.py -- --out DIR [--only hoodie,suit]
    [--samples 256] [--cfg plates.json]

Each wearable of build_wearables.py is built in the plates' scene and made whole where the plates
only ever showed its front. Its parts are decimated to a triangle budget, joined, unwrapped, and
their procedural materials baked to glTF textures: base colour, and at half its size a
tangent-space normal map and ORM (occlusion with the body present, roughness, metalness). Glass
stays glass. For each wearable DIR gets wear-<name>.glb and shadow-<name>.webp, the shadow it casts
on the body under the neutral rig; and once, dot-rig.json and the rig as environment maps,
studio-env.hdr and studio-env-xenon.hdr.

The axes are glTF's, with the body a sphere of radius 1 at the origin. Everything is first turned
elevation_deg about X, so a camera on +Z looking down -Z sees dot exactly as the plate camera does.
A shadow map covers the body by longitude and latitude in those axes: u = 0.5 + atan2(x, z) / 2pi,
v = 0.5 + asin(y) / pi, with v = 1 on the top row; three.js's SphereGeometry(1, w, h, -PI / 2)
has these UVs.
"""

import argparse
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import zlib

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform
from mathutils.kdtree import KDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_plates as bp  # noqa: E402
import build_wearables as bw  # noqa: E402

U = bp.U
# Triangles and texture size for each wearable.
BUDGET = {
    "hoodie": (6500, 1024),
    "cap": (8000, 1024),
    "sunglasses": (4000, 512),
    "bow": (2000, 512),
    "star-pin": (600, 512),
    "round-glasses": (2800, 512),
    "mustache": (1800, 512),
    "suit": (6500, 1024),
    "scarf": (5600, 1024),
    "headphones": (5000, 1024),
    "mortarboard": (5000, 1024),
    "beret": (4500, 1024),
}
# What turns with the face as the eyes do (apps/web/src/dot/render/wearables.ts).
ON_FACE = {"round-glasses", "sunglasses", "mustache"}
TOLERANCE = 0.0006  # how far, in body radii, a decimated part may stray before the budget forces more
LEAST = 48  # triangles a part keeps however small, so a button stays round
HIDDEN_TEXELS = 0.15  # texel density of faces no view from outside sees, against the rest
CHART_ANGLE = 60.0  # the most, in degrees, a UV chart's faces turn from one another
AO_DISTANCE = 0.3
TO_GLTF = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))  # Blender's Z-up axes to glTF's Y-up


def gltf(front, v):
    return [round(c, 6) + 0.0 for c in TO_GLTF @ (front @ Vector(v))]


def from_gltf(front, v):
    return front.inverted() @ (TO_GLTF.transposed() @ Vector(v))


# What the plates never showed: the star needs a pin to sit on the body.


def star_pin():
    star = bpy.data.objects["star"]
    n = (sum((v.co for v in star.data.vertices), Vector()) / len(star.data.vertices)).normalized()
    dg = bpy.context.evaluated_depsgraph_get()
    depths = [v.co.dot(n) for v in star.evaluated_get(dg).to_mesh().vertices]
    star.evaluated_get(dg).to_mesh_clear()
    # From inside the body to halfway through the star.
    depth = (min(depths) + max(depths)) / 2 - 0.99
    bpy.ops.mesh.primitive_cylinder_add(radius=0.008, depth=depth, location=n * (0.99 + depth / 2), vertices=16)
    pin = bpy.context.active_object
    pin.name = "pin"
    pin.rotation_euler = n.to_track_quat("Z", "Y").to_euler()
    pin.data.materials.append(star.data.materials[0])
    bpy.ops.object.shade_smooth()


COMPLETE = {"star-pin": star_pin}


# Geometry.


def realise(ob):
    """A mesh object in ob's place with its modifiers applied; curves become meshes."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    out = bw.link(bpy.data.objects.new(ob.name + "-mesh", me))
    out.matrix_world = ob.matrix_world
    out.visible_shadow = ob.visible_shadow
    bpy.data.objects.remove(ob, do_unlink=True)
    return out


def is_glass(ob):
    bsdf = bp.principled(ob.data.materials[0])
    return bsdf.inputs["Transmission Weight"].default_value > 0 or bsdf.inputs["Alpha"].default_value < 1


def triangles(me):
    me.calc_loop_triangles()
    return len(me.loop_triangles)


def collapse(me, ratio):
    """A triangulated copy of mesh me with about `ratio` of its faces."""
    ob = bw.link(bpy.data.objects.new("collapse", me))
    if ratio < 1:
        bw.modifier(ob, "DECIMATE", decimate_type="COLLAPSE", ratio=ratio, use_collapse_triangulate=True)
    bw.modifier(ob, "TRIANGULATE", quad_method="BEAUTY", ngon_method="BEAUTY")
    dg = bpy.context.evaluated_depsgraph_get()
    out = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    bpy.data.objects.remove(ob, do_unlink=True)
    return out


def points(me, matrix, limit=None):
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    if limit and len(co) > limit:
        co = co[:: len(co) // limit]
    m = np.array(matrix)
    return co @ m[:3, :3].T + m[:3, 3]


def tree(me, matrix):
    me.calc_loop_triangles()
    tris = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", tris)
    return BVHTree.FromPolygons(points(me, matrix).tolist(), tris.reshape(-1, 3).tolist())


def deviation(pts, t):
    return max(t.find_nearest(Vector(p))[3] for p in pts)


RATIOS = [0.7**k for k in range(1, 17)]


def options(ob):
    """(triangles, error, ratio) for collapsing a part by each of RATIOS, the error being the
    furthest either surface strays from the other, in body radii."""
    full = triangles(ob.data)
    if full > 60000:
        old = ob.data
        ob.data = collapse(old, 60000 / full)
        bpy.data.meshes.remove(old)
        full = triangles(ob.data)
    out = [(full, 0.0, 1.0)]
    if full < 64:
        return out
    m = ob.matrix_world
    hi, hi_pts = tree(ob.data, m), points(ob.data, m, 8000)
    for r in RATIOS:
        if full * r < 16:
            break
        lo = collapse(ob.data, r)
        err = max(deviation(hi_pts, tree(lo, m)), deviation(points(lo, m), hi))
        out.append((triangles(lo), err, r))
        bpy.data.meshes.remove(lo)
    return out


def plan(choices, budget):
    """The coarsest collapse of each part within one tolerance, the smallest tolerance (from
    TOLERANCE up) whose total fits the budget; what the budget has left then goes, a step at a time,
    to the part that strays furthest. Returns the picks and the furthest any part strays."""
    tol = TOLERANCE
    while True:
        pick = [min((c for c in opts if c[1] <= tol and c[0] >= min(LEAST, opts[0][0])), key=lambda c: c[0]) for opts in choices]
        if sum(c[0] for c in pick) <= budget or tol > 0.05:
            break
        tol *= 1.1
    while True:
        spare = budget - sum(c[0] for c in pick)
        steps = [(i, min((c for c in opts if pick[i][0] < c[0] <= pick[i][0] + spare), key=lambda c: c[0], default=None)) for i, opts in enumerate(choices)]
        steps = [(i, c) for i, c in steps if c is not None and c[1] < pick[i][1]]
        if not steps:
            return pick, max(c[1] for c in pick)
        i, c = max(steps, key=lambda step: pick[step[0]][1])
        pick[i] = c


def smooth_like(me, src):
    """Gives a decimated mesh the shading normals of the surface it came from, so its few
    triangles shade like the many: each smooth corner takes the normal of the nearest point of the
    original that faces its way, which keeps the two sides of a thin shell apart."""
    src.calc_loop_triangles()
    tris = src.loop_triangles
    co = [v.co for v in src.vertices]
    corner = [c.vector.copy() for c in src.corner_normals]
    t = BVHTree.FromPolygons(co, [tri.vertices[:] for tri in tris])
    unit = (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
    normals = []
    for p in me.polygons:
        for li in p.loop_indices:
            vi = me.loops[li].vertex_index
            hits = [h for h in t.find_nearest_range(me.vertices[vi].co, 0.012) if h[1].dot(p.normal) > 0.2] if p.use_smooth else []
            if not hits:
                normals.append(p.normal.copy() if not p.use_smooth else me.vertex_normals[vi].vector.copy())
                continue
            at, _, i, _ = min(hits, key=lambda h: h[3])
            (a, b, c), (la, lb, lc) = tris[i].vertices, tris[i].loops
            w = barycentric_transform(at, co[a], co[b], co[c], *unit)
            normals.append((corner[la] * w.x + corner[lb] * w.y + corner[lc] * w.z).normalized())
    me.normals_split_custom_set(normals)


def keep_object_space(ob):
    """Stores each vertex's place in its object, where the textures still look once parts join."""
    co = np.empty(len(ob.data.vertices) * 3, np.float32)
    ob.data.vertices.foreach_get("co", co)
    ob.data.attributes.new("obj_co", "FLOAT_VECTOR", "POINT").data.foreach_set("vector", co)


def select(*objects):
    bpy.ops.object.select_all(action="DESELECT")
    for ob in objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def join(parts, name):
    """The parts as one object in world space."""
    target = parts[0]
    target.data.transform(target.matrix_world)
    target.matrix_world = Matrix.Identity(4)
    if len(parts) > 1:
        select(*parts)
        bpy.ops.object.join()
    target.name = target.data.name = name
    return target


def islands(bm):
    seen, out = set(), []
    for f0 in bm.faces:
        if f0.index in seen:
            continue
        seen.add(f0.index)
        stack, island = [f0], []
        while stack:
            f = stack.pop()
            island.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        out.append(island)
    return out


def orient(ob):
    """Turns outward any piece of ob that encloses negative volume; returns how many."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.faces.index_update()
    flipped = 0
    for island in islands(bm):
        volume = sum(f.verts[0].co.dot(f.verts[i].co.cross(f.verts[i + 1].co)) for f in island for i in range(1, len(f.verts) - 1))
        if volume < -1e-7:
            bmesh.ops.reverse_faces(bm, faces=island)
            flipped += 1
    bm.to_mesh(ob.data)
    bm.free()
    return flipped


def fibonacci(n):
    out = []
    for i in range(n):
        z = 1 - 2 * (i + 0.5) / n
        a = i * math.pi * (3 - math.sqrt(5))
        out.append(Vector((math.cos(a) * math.sqrt(1 - z * z), math.sin(a) * math.sqrt(1 - z * z), z)))
    return out


DIRECTIONS = fibonacci(160)


def seen_from_outside(ob):
    """Whether each face of ob can be seen from far away in some direction past the body."""
    me = ob.data
    verts = [v.co.copy() for v in me.vertices]
    polys = [p.vertices[:] for p in me.polygons]
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=4, radius=1.0)
    verts += [v.co.copy() for v in bm.verts]
    polys += [[v.index + len(me.vertices) for v in f.verts] for f in bm.faces]
    bm.free()
    t = BVHTree.FromPolygons(verts, polys)
    seen = []
    for p in me.polygons:
        n = p.normal
        o = p.center + n * 1e-4
        seen.append(any(t.ray_cast(o, d)[0] is None for d in DIRECTIONS if d.dot(n) > 0.05))
    return seen


def cull(ob, seen, margin=0.04):
    """Deletes the faces no view sees, but for those within `margin` of one it does."""
    me = ob.data
    near = [me.vertices[i].co for p, s in zip(me.polygons, seen) if s for i in p.vertices]
    kd = KDTree(len(near))
    for i, co in enumerate(near):
        kd.insert(co, i)
    kd.balance()
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    deep = [f for f in bm.faces if not seen[f.index] and all(kd.find(v.co)[2] > margin for v in f.verts)]
    bmesh.ops.delete(bm, geom=deep, context="FACES")
    bm.to_mesh(me)
    bm.free()
    return len(deep)


def uv_area(f, uv):
    pts = [loop[uv].uv for loop in f.loops]
    return 0.5 * abs(sum(a.x * b.y - b.x * a.y for a, b in zip(pts, pts[1:] + pts[:1])))


def unwrap(ob, seen, size):
    """A UV map "bake" for the atlas: the faces seen from outside and the rest are projected apart,
    the rest at HIDDEN_TEXELS the density, and all packed together."""
    me = ob.data
    layer = me.uv_layers.new(name="bake")
    me.uv_layers.active = layer
    layer.active_render = True
    select(ob)
    bpy.ops.object.mode_set(mode="EDIT")
    ts = bpy.context.scene.tool_settings
    ts.mesh_select_mode = (False, False, True)
    ts.use_uv_select_sync = True
    for want in (True, False):
        bm = bmesh.from_edit_mesh(me)
        bm.faces.index_update()
        for f in bm.faces:
            f.select_set(False)
        chosen = [f for f in bm.faces if seen[f.index] == want]
        for f in chosen:
            f.select_set(True)
        bmesh.update_edit_mesh(me)
        if chosen:
            bpy.ops.uv.smart_project(angle_limit=math.radians(CHART_ANGLE), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bm = bmesh.from_edit_mesh(me)
    bm.faces.index_update()
    uv = bm.loops.layers.uv["bake"]
    sums = {True: [0.0, 0.0], False: [0.0, 0.0]}
    for f in bm.faces:
        s = sums[seen[f.index]]
        s[0] += uv_area(f, uv)
        s[1] += f.calc_area()
    if all(a > 0 and b > 0 for a, b in sums.values()):
        k = HIDDEN_TEXELS * math.sqrt((sums[True][0] / sums[True][1]) / (sums[False][0] / sums[False][1]))
        for f in bm.faces:
            if not seen[f.index]:
                for loop in f.loops:
                    loop[uv].uv *= k
    for f in bm.faces:
        f.select_set(True)
    bmesh.update_edit_mesh(me)
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin_method="FRACTION", margin=6 / size, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")


# Baking.


def object_space(mat):
    """Has the material read the coordinates its textures used before its object joined others."""
    nt = mat.node_tree
    for node in [n for n in nt.nodes if n.type == "TEX_COORD"]:
        for link in list(node.outputs["Object"].links):
            attr = nt.nodes.new("ShaderNodeAttribute")
            attr.attribute_name = "obj_co"
            nt.links.new(attr.outputs["Vector"], link.to_socket)
        for link in list(node.outputs["UV"].links):
            uv = nt.nodes.new("ShaderNodeUVMap")
            uv.uv_map = "UVMap"
            nt.links.new(uv.outputs["UV"], link.to_socket)


def feed(nt, src, dst):
    """Feeds dst whatever feeds src."""
    if src.is_linked:
        nt.links.new(src.links[0].from_socket, dst)
    elif isinstance(src.default_value, float):
        dst.default_value = src.default_value
    else:
        dst.default_value = tuple(src.default_value)[: len(dst.default_value)]


def emit(mat, inputs):
    """Shows the material's BSDF inputs as emission, one input as a colour or up to three as
    channels; returns what undoes it."""
    nt = mat.node_tree
    bsdf = bp.principled(mat)
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    surface = out.inputs["Surface"].links[0].from_socket
    em = nt.nodes.new("ShaderNodeEmission")
    if len(inputs) == 1:
        feed(nt, bsdf.inputs[inputs[0]], em.inputs["Color"])
    else:
        comb = nt.nodes.new("ShaderNodeCombineColor")
        for channel, name in zip(("Red", "Green", "Blue"), inputs):
            feed(nt, bsdf.inputs[name], comb.inputs[channel])
        nt.links.new(comb.outputs["Color"], em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return lambda: nt.links.new(surface, out.inputs["Surface"])


def bake(ob, image, kind, samples, margin, **settings):
    for mat in ob.data.materials:
        nt = mat.node_tree
        node = nt.nodes.get("bake-target") or nt.nodes.new("ShaderNodeTexImage")
        node.name = "bake-target"
        node.image = image
        nt.nodes.active = node
    bpy.context.scene.cycles.samples = samples
    select(ob)
    bpy.ops.object.bake(type=kind, margin=margin, margin_type="ADJACENT_FACES", use_clear=True, uv_layer=ob.data.uv_layers.active.name, **settings)


def target(name, size, height=None):
    img = bpy.data.images.new(name, size, height or size, alpha=False, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    return img


def pixels(image):
    w, h = image.size
    a = np.empty(w * h * 4, np.float32)
    image.pixels.foreach_get(a)
    return a.reshape(h, w, 4)[::-1]


def bake_textures(ob, size, samples):
    """Base colour, normal, and AO, roughness, metalness, as arrays with the top row first; the
    last two at half the size, as nothing in them is finer than that."""
    margin = size // 64
    mats = list(ob.data.materials)
    img = target("bake", size)
    coats = [(m, bp.principled(m).inputs["Coat Weight"]) for m in mats]
    kept = [s.default_value for _, s in coats]
    # A coat's normal ignores the bump, so the coat stays off while the bump is baked.
    for _, s in coats:
        s.default_value = 0.0
    bake(ob, img, "NORMAL", 64, margin, normal_space="TANGENT")
    for (_, s), v in zip(coats, kept):
        s.default_value = v
    normal = pixels(img)[..., :3] * 2 - 1
    bake(ob, img, "AO", samples, margin)
    ao = pixels(img)[..., 0]
    undo = [emit(m, ["Base Color"]) for m in mats]
    bake(ob, img, "EMIT", 16, margin)
    base = pixels(img)[..., :3]
    for u in undo:
        u()
    undo = [emit(m, ["Roughness", "Metallic"]) for m in mats]
    bake(ob, img, "EMIT", 16, margin)
    rm = pixels(img)
    for u in undo:
        u()
    undo = [emit(m, ["Alpha"] * 3) for m in mats]
    bake(ob, img, "EMIT", 1, margin)
    for u in undo:
        u()
    cover = pixels(img)[..., 0] > 0.5
    bpy.data.images.remove(img)
    # Occlusion varies slowly, and a weave finer than a texel only averages to grain; both keep
    # what is larger than a texel or two.
    orm = np.stack([blur(ao, cover, 1.2), rm[..., 0], rm[..., 1]], axis=-1)
    normal = half(fill(blur(normal, cover, 0.8), cover))
    normal /= np.maximum(np.linalg.norm(normal, axis=-1, keepdims=True), 1e-6)
    return {"base": fill(base, cover), "orm": half(fill(orm, cover)), "normal": normal * 0.5 + 0.5}


def half(a):
    h, w = a.shape[0] // 2, a.shape[1] // 2
    return a.reshape(h, 2, w, 2, -1).mean(axis=(1, 3))


def blur(a, cover, sigma):
    """A Gaussian blur of the covered texels of a, from covered texels only."""
    r = math.ceil(3 * sigma)
    kernel = [(s, math.exp(-0.5 * (s / sigma) ** 2)) for s in range(-r, r + 1)]
    w = cover.astype(np.float64)
    num = a * (w[..., None] if a.ndim == 3 else w)
    for axis in (0, 1):
        num = sum(k * np.roll(num, s, axis=axis) for s, k in kernel)
        w = sum(k * np.roll(w, s, axis=axis) for s, k in kernel)
    out = num / np.maximum(w, 1e-9)[..., None] if a.ndim == 3 else num / np.maximum(w, 1e-9)
    return np.where(cover[..., None] if a.ndim == 3 else cover, out, a)


def fill(a, cover):
    """Fills the texels no face covers from the covered ones near them (pull-push), so they cost
    little to store and nothing bleeds into the islands' mipmaps."""
    levels, col, w = [], a, cover.astype(np.float64)
    while min(w.shape) > 1:
        levels.append((col, w))
        h, v = w.shape[0] // 2, w.shape[1] // 2
        cw = (col * w[..., None]).reshape(h, 2, v, 2, -1).sum(axis=(1, 3))
        w = w.reshape(h, 2, v, 2).sum(axis=(1, 3))
        col = cw / np.maximum(w, 1e-9)[..., None]
        w = (w > 0).astype(np.float64)
    for fine, fw in reversed(levels):
        col = np.where(fw[..., None] > 0, fine, np.repeat(np.repeat(col, 2, axis=0), 2, axis=1))
    return col


# Textures.


def write_png(path, rows):
    """An 8-bit PNG of rows (height x width x 1, 3 or 4 channels), the top row first."""
    h, w, c = rows.shape
    raw = b"".join(b"\x00" + rows[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    head = struct.pack(">IIBBBBB", w, h, 8, {1: 0, 3: 2, 4: 6}[c], 0, 0, 0)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def to8(a):
    return np.clip(np.round(a * 255), 0, 255).astype(np.uint8)


def srgb(a):
    a = np.clip(a, 0, 1)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(a, 1 / 2.4) - 0.055)


def webp(rows, path, *flags):
    with tempfile.TemporaryDirectory() as tmp:
        png = os.path.join(tmp, "in.png")
        write_png(png, rows)
        subprocess.run(["cwebp", "-quiet", "-m", "6", *flags, png, "-o", path], check=True)


def encode(name, maps, tmp):
    """The baked maps as WebP files Blender loads back, so the exporter embeds them unchanged."""
    files = {
        "base": (to8(srgb(maps["base"])), "sRGB", ("-q", "75", "-sharp_yuv")),
        "orm": (to8(maps["orm"]), "Non-Color", ("-q", "85", "-sharp_yuv")),
        "normal": (to8(maps["normal"]), "Non-Color", ("-q", "85", "-sharp_yuv")),
    }
    images = {}
    for kind, (rows, space, flags) in files.items():
        path = os.path.join(tmp, f"{name}-{kind}.webp")
        webp(rows, path, *flags)
        img = bpy.data.images.load(path)
        img.name = f"{name}-{kind}"
        img.colorspace_settings.name = space
        images[kind] = img
    return images


# Materials.

FINISH = ("Sheen Weight", "Sheen Roughness", "Coat Weight", "Coat Roughness", "Specular IOR Level")


def finish_of(mat):
    bsdf = bp.principled(mat)
    out = {k: bsdf.inputs[k].default_value for k in FINISH}
    out["Sheen Tint"] = tuple(bsdf.inputs["Sheen Tint"].default_value)[:3]
    return out


def apart(a, b):
    """How far two finishes differ, in steps that one material may still share."""
    return max(abs(a[k] - b[k]) / step for k, step in (("Sheen Weight", 0.25), ("Coat Weight", 0.25), ("Specular IOR Level", 0.3)))


def finishes(ob):
    """The source materials grouped by the finish glTF keeps as constants (sheen, coat, specular),
    the largest by area first; a material with little area takes the nearest group's finish."""
    area = [0.0] * len(ob.data.materials)
    for p in ob.data.polygons:
        area[p.material_index] += p.area
    groups = []
    for i in sorted(range(len(area)), key=lambda i: -area[i]):
        f = finish_of(ob.data.materials[i])
        near = min(groups, key=lambda g: apart(g[0], f), default=None)
        if near and (apart(near[0], f) <= 1 or area[i] < 0.05 * sum(area)):
            near[1].append(i)
        else:
            groups.append((f, [i]))
    return groups


def gltf_output():
    """The node group the glTF exporter reads occlusion from."""
    group = bpy.data.node_groups.get("glTF Material Output")
    if group is None:
        group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
        group.nodes.new("NodeGroupOutput")
        group.nodes.new("NodeGroupInput")
    return group


def baked_material(name, images, finish):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = bp.principled(mat)

    def texture(kind):
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = images[kind]
        return node.outputs["Color"]

    nt.links.new(texture("base"), bsdf.inputs["Base Color"])
    orm = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(texture("orm"), orm.inputs["Color"])
    nt.links.new(orm.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(orm.outputs["Blue"], bsdf.inputs["Metallic"])
    occlusion = nt.nodes.new("ShaderNodeGroup")
    occlusion.node_tree = gltf_output()
    nt.links.new(orm.outputs["Red"], occlusion.inputs["Occlusion"])
    normal = nt.nodes.new("ShaderNodeNormalMap")
    normal.uv_map = "bake"
    nt.links.new(texture("normal"), normal.inputs["Color"])
    nt.links.new(normal.outputs["Normal"], bsdf.inputs["Normal"])
    w = finish["Sheen Weight"]
    if w > 0:
        # glTF's sheen colour carries the weight; the exporter writes the tint as it.
        bsdf.inputs["Sheen Weight"].default_value = 1.0
        bsdf.inputs["Sheen Tint"].default_value = (*(w * c for c in finish["Sheen Tint"]), 1.0)
        bsdf.inputs["Sheen Roughness"].default_value = finish["Sheen Roughness"]
    for k in ("Coat Weight", "Coat Roughness", "Specular IOR Level"):
        bsdf.inputs[k].default_value = finish[k]
    return mat


def dress(ob, name, images):
    groups = finishes(ob)
    index = {i: k for k, (_, members) in enumerate(groups) for i in members}
    faces = [index[p.material_index] for p in ob.data.polygons]
    # Clearing the slots sets every face's index to 0, so the indices go back after.
    ob.data.materials.clear()
    for k, (finish, _) in enumerate(groups):
        ob.data.materials.append(baked_material(f"{name}~{k}", images, finish))
    ob.data.polygons.foreach_set("material_index", faces)


def glass(parts, name):
    """The lenses as one mesh facing out, with the source's constants for glTF to keep."""
    ob = join(parts, f"{name}-lens~")
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    for f in bm.faces:
        if f.normal.dot(f.calc_center_median()) < 0:
            f.normal_flip()
    bm.to_mesh(ob.data)
    bm.free()
    for slot in ob.material_slots:
        slot.material = slot.material.copy()
        slot.material.use_backface_culling = True
    return ob


# The shadow on the body.


def shadow_sphere(front, cols=256, rows=128):
    """A sphere of radius 1 whose UVs are longitude and latitude in glTF axes."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    grid = []
    for j in range(rows + 1):
        lat = -math.pi / 2 + math.pi * j / rows
        grid.append([
            bm.verts.new(from_gltf(front, (math.cos(lat) * math.sin(lon), math.sin(lat), math.cos(lat) * math.cos(lon))))
            for lon in (-math.pi + 2 * math.pi * i / cols for i in range(cols + 1))
        ])
    for j in range(rows):
        for i in range(cols):
            corners = ((j, i), (j, i + 1), (j + 1, i + 1), (j + 1, i))
            f = bm.faces.new([grid[a][b] for a, b in corners])
            for loop, (a, b) in zip(f.loops, corners):
                loop[uv].uv = (b / cols, a / rows)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    me = bpy.data.meshes.new("shadow-sphere")
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bw.link(bpy.data.objects.new("shadow-sphere", me))
    mat = bpy.data.materials.new("shadow-sphere")
    mat.use_nodes = True
    bsdf = bp.principled(mat)
    bp.set_input(bsdf, ["Roughness"], 1.0)
    bp.set_input(bsdf, ["Specular IOR Level"], 0.0)
    me.materials.append(mat)
    ob.hide_render = True
    return ob


def light_on(sphere, body, samples):
    """The light reaching the body from the rig, as baked on the shadow sphere in its place."""
    img = target("light", 512, 256)
    sphere.hide_render, body.hide_render = False, True
    bake(sphere, img, "DIFFUSE", samples, 0, pass_filter={"DIRECT", "INDIRECT"})
    sphere.hide_render, body.hide_render = True, False
    out = pixels(img)[..., :3].mean(axis=-1)
    bpy.data.images.remove(img)
    return out


# The light rig as the web sees it.


def light_rig(cfg, variant, front):
    lights = bp.deep_merge(json.loads(json.dumps(cfg["lights"])), cfg["variants"].get(variant, {}))
    out = []
    for name, spec in lights.items():
        if spec.get("power", 0) <= 0:
            continue
        loc = Vector(spec["loc"])
        turn = TO_GLTF @ front @ (-loc).to_track_quat("-Z", "Y").to_matrix()
        q = turn.to_quaternion()
        w, h = spec["size"]
        out.append({
            "name": name,
            "position": gltf(front, loc),
            "quaternion": [round(c, 6) for c in (q.x, q.y, q.z, q.w)],
            "width": w,
            "height": h,
            "color": spec.get("color", [1, 1, 1]),
            "power": spec["power"],
            "radiance": round(spec["power"] / (math.pi * w * h), 4),
        })
    return out


def environment(cfg, variant, path, front, body):
    """The rig and the world seen from the body's centre, equirectangular as three.js maps it:
    u = 0.5 + atan2(z, x) / 2pi, v = 0.5 + asin(y) / pi, top row up."""
    sc = bpy.context.scene
    bp.rig(cfg, variant)
    for ob in sc.objects:
        if ob.type == "LIGHT":
            ob.visible_camera = True
    data = bpy.data.cameras.new("pano")
    data.type = "PANO"
    data.panorama_type = "EQUIRECTANGULAR"
    cam = bw.link(bpy.data.objects.new("pano", data))
    # Blender's panorama looks down its -Z at the centre with +X at three quarters across.
    cam.matrix_world = Matrix((from_gltf(front, (0, 0, 1)), from_gltf(front, (0, 1, 0)), -from_gltf(front, (1, 0, 0)))).transposed().to_4x4()
    plate_camera, sc.camera = sc.camera, cam
    saved = (sc.render.resolution_x, sc.render.resolution_y, sc.render.film_transparent, sc.view_settings.view_transform, sc.cycles.samples, sc.cycles.use_denoising)
    sc.render.resolution_x, sc.render.resolution_y = 1024, 512
    sc.render.film_transparent = False
    sc.view_settings.view_transform = "Standard"
    sc.cycles.samples = 64
    sc.cycles.use_denoising = False
    st = sc.render.image_settings
    st.media_type = "IMAGE"
    st.file_format = "HDR"
    body.hide_render = True
    bp.render_to(path)
    body.hide_render = False
    st.file_format = "PNG"
    sc.camera = plate_camera
    (sc.render.resolution_x, sc.render.resolution_y, sc.render.film_transparent, sc.view_settings.view_transform, sc.cycles.samples, sc.cycles.use_denoising) = saved
    bpy.data.objects.remove(cam, do_unlink=True)
    bp.rig(cfg, "neutral")


# One wearable.


def export_wearable(name, front, body, sphere, unlit, keep, out, samples):
    budget, size = BUDGET[name]
    bw.WEARABLES[name]()
    COMPLETE.get(name, lambda: None)()
    parts = [realise(ob) for ob in list(bpy.context.scene.objects) if ob.type in {"MESH", "CURVE"} and ob.name not in keep]
    lenses = [ob for ob in parts if is_glass(ob)]
    solid = [ob for ob in parts if ob not in lenses]
    source = sum(triangles(ob.data) for ob in solid)
    flipped = sum(orient(ob) for ob in solid)
    picks, error = plan([options(ob) for ob in solid], budget)
    for ob, (_, _, ratio) in zip(solid, picks):
        old = ob.data
        ob.data = collapse(old, ratio)
        smooth_like(ob.data, old)
        bpy.data.meshes.remove(old)
        keep_object_space(ob)
    model = join(solid, f"{name}~")
    culled = cull(model, seen_from_outside(model))
    unwrap(model, seen_from_outside(model), size)
    for mat in model.data.materials:
        object_space(mat)
    for ob in lenses:
        ob.hide_render = True
    with tempfile.TemporaryDirectory() as tmp:
        images = encode(name, bake_textures(model, size, samples), tmp)
        for img in images.values():
            img.pack()
    dress(model, name, images)
    for layer in [layer for layer in model.data.uv_layers if layer.name != "bake"]:
        model.data.uv_layers.remove(layer)
    model.data.attributes.remove(model.data.attributes["obj_co"])

    lit = light_on(sphere, body, samples * 4)
    eps = 0.01 * unlit.max()
    shade = np.clip((lit + eps) / (unlit + eps), 0.0, 1.0)
    webp(to8(shade)[..., None], os.path.join(out, f"shadow-{name}.webp"), "-lossless", "-z", "9")

    pieces = [model] + ([glass(lenses, name)] if lenses else [])
    for ob in pieces:
        ob.data.transform(front.to_4x4() @ ob.matrix_world)
        ob.matrix_world = Matrix.Identity(4)
    bpy.data.orphans_purge(do_recursive=True)
    root = bw.link(bpy.data.objects.new(f"wear-{name}", None))
    root["bodyRadius"] = 1.0
    for ob in pieces:
        ob.parent = root
        ob.name = ob.data.name = ob.name.replace("~", "")
        for k, slot in enumerate(ob.material_slots):
            if "~" in slot.material.name:
                slot.material.name = name if k == 0 else f"{name}-{k + 1}"
            else:
                slot.material.name = f"{name}-lens"
    path = os.path.join(out, f"wear-{name}.glb")
    select(root, *pieces)
    bpy.ops.export_scene.gltf(
        filepath=path,
        check_existing=False,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_image_add_webp=False,
        export_image_webp_fallback=False,
        export_draco_mesh_compression_enable=False,
        export_extras=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_vertex_color="NONE",
        export_attributes=False,
    )

    corners = [TO_GLTF @ (ob.matrix_world @ Vector(c)) for ob in pieces for c in ob.bound_box]
    lo = [min(c[i] for c in corners) for i in range(3)]
    hi = [max(c[i] for c in corners) for i in range(3)]
    stats = {
        "model": os.path.basename(path),
        "shadow": f"shadow-{name}.webp",
        "bytes": os.path.getsize(path),
        "triangles": sum(triangles(ob.data) for ob in pieces),
        "texture": size,
        "bounds": [[round(v, 4) for v in lo], [round(v, 4) for v in hi]],
        "glass": bool(lenses),
    }
    if name in ON_FACE:
        # Where it sits on the face: the middle of what is in front of it, not of the arms.
        ahead = [p for ob in pieces for p in (TO_GLTF @ v.co for v in ob.data.vertices) if p.z > 0.8]
        mid = Vector([(min(p[i] for p in ahead) + max(p[i] for p in ahead)) / 2 for i in range(3)])
        stats["faceAnchor"] = [round(v, 4) for v in mid.normalized()]
    print(
        f"{name}: {source} -> {stats['triangles']} triangles (error {error:.4f}, culled {culled}, "
        f"turned {flipped}), {len(model.data.materials)} material(s), {stats['bytes']} bytes"
    )
    return stats


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default=",".join(bw.WEARABLES))
    ap.add_argument("--samples", type=int, default=256)
    ap.add_argument("--cfg", default=os.path.join(HERE, "plates.json"))
    args = ap.parse_args(argv)
    with open(args.cfg) as fh:
        cfg = json.load(fh)
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bp.setup_render(64, args.samples)
    bp.make_world(cfg["world"])
    bpy.context.scene.world.light_settings.distance = AO_DISTANCE
    body = bp.make_body(cfg)
    bp.make_camera(cfg)
    bpy.context.view_layer.update()
    bp.rig(cfg, "neutral")
    front = Matrix.Rotation(math.radians(cfg["elevation_deg"]), 3, "X")
    sphere = shadow_sphere(front)
    keep = {body.name, sphere.name}
    unlit = light_on(sphere, body, args.samples * 4)

    rig_path = os.path.join(out, "dot-rig.json")
    worn = {}
    if os.path.exists(rig_path):
        with open(rig_path) as fh:
            worn = json.load(fh).get("wearables", {})
    for name in [n.strip() for n in args.only.split(",") if n.strip()]:
        bw.clear_wearables(keep)
        bpy.data.orphans_purge(do_recursive=True)
        worn[name] = export_wearable(name, front, body, sphere, unlit, keep, out, args.samples)
    bw.clear_wearables(keep)

    environment(cfg, "neutral", os.path.join(out, "studio-env.hdr"), front, body)
    environment(cfg, "xenon", os.path.join(out, "studio-env-xenon.hdr"), front, body)

    eyes = [gltf(front, bw.on_sphere(x, y)) for x, y in bw.EYES]
    up = gltf(front, (0, 0, 1))
    floor = -(24.0 + cfg["hover_units"]) * U
    rig = {
        "radius": 1.0,
        "axes": "glTF: +Y is the plate camera's up and dot faces +Z; a camera on +Z looking down -Z sees what the plates show",
        "front": [0, 0, 1],
        "up": up,
        "cameraUp": [0, 1, 0],
        "plateElevationDeg": cfg["elevation_deg"],
        "plateCamera": {"position": [0, 0, 20], "direction": [0, 0, -1], "orthographicHeight": 64 * U},
        "frame": {"units": 64, "centre": [32, 32], "bodyRadius": 24},
        "eyeAnchors": [list(e) for e in bw.EYES],
        "eyes": eyes,
        "floor": {"point": gltf(front, (0, 0, floor)), "normal": up, "albedo": cfg["floor"]["albedo"]},
        "body": cfg["body"],
        "world": cfg["world"],
        "toneMapping": "Khronos PBR Neutral",
        "lights": {variant: light_rig(cfg, variant, front) for variant in ("neutral", "xenon", "dim")},
        "environment": {
            "neutral": "studio-env.hdr",
            "xenon": "studio-env-xenon.hdr",
            "mapping": "equirectangular as three.js maps it: u = 0.5 + atan2(z, x) / 2pi, v = 0.5 + asin(y) / pi, top row +Y",
        },
        "shadowMaps": {
            "size": [512, 256],
            "mapping": "u = 0.5 + atan2(x, z) / 2pi, v = 0.5 + asin(y) / pi, top row v = 1 (+Y); three.js SphereGeometry(1, w, h, -Math.PI / 2) UVs",
            "value": "linear factor on the body's colour, 1 where the wearable casts no shadow",
        },
        "wearables": {name: worn[name] for name in bw.WEARABLES if name in worn},
    }
    with open(rig_path, "w") as fh:
        json.dump(rig, fh, indent=2)
        fh.write("\n")
    print("wrote", rig_path)


if __name__ == "__main__":
    main()
