"""Render what the dots wear as transparent plates over dot's body, headless with Blender (5.1).

Blender --background --factory-startup --python build_wearables.py -- --out DIR [--res 1024]
    [--samples 384] [--only glasses,mustache,...]

Each plate is the dot's 64-unit frame with one wearable on the body of build_plates.py, under the
same camera and neutral light rig. The body is a shadow catcher: it renders transparent but hides
what is behind it and keeps the shadows the wearable casts on it, so a plate laid over the body
plate reads as worn. Points named in frame units are projected onto the sphere along the view, so a
wearable meets the face exactly where apps/web/src/dot draws the eyes (anchors (32 +/- 5.5, 27.5)).
"""

import argparse
import json
import math
import os
import re
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_plates as bp  # noqa: E402

U = bp.U
EYES = ((26.5, 27.5), (37.5, 27.5))


# --- placement ----------------------------------------------------------------------------------


def view(x, y):
    """The ray through frame point (x, y): where it starts and its direction."""
    cam = bpy.context.scene.camera
    m = cam.matrix_world.to_3x3()
    right, up, fwd = m @ Vector((1, 0, 0)), m @ Vector((0, 1, 0)), m @ Vector((0, 0, -1))
    return cam.matrix_world.translation + right * ((x - 32) * U) + up * ((32 - y) * U), fwd


def on_sphere(x, y, r=1.0):
    """Where frame point (x, y) meets a sphere of radius r about the body's centre."""
    o, d = view(x, y)
    b = o.dot(d)
    disc = b * b - (o.dot(o) - r * r)
    t = -b - math.sqrt(max(disc, 0.0))
    return o + d * t


def toward_camera(p, distance):
    _, d = view(32, 32)
    return p - d * distance


# --- materials ----------------------------------------------------------------------------------


def material(name, base, roughness=0.5, **extra):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = bp.principled(mat)
    bp.set_input(bsdf, ["Base Color"], (*base, 1.0))
    bp.set_input(bsdf, ["Roughness"], roughness)
    names = {
        "metallic": ["Metallic"],
        "sheen": ["Sheen Weight"],
        "sheen_roughness": ["Sheen Roughness"],
        "coat": ["Coat Weight"],
        "coat_roughness": ["Coat Roughness"],
        "transmission": ["Transmission Weight", "Transmission"],
        "ior": ["IOR"],
        "specular": ["Specular IOR Level"],
        "anisotropic": ["Anisotropic"],
        "alpha": ["Alpha"],
    }
    for key, value in extra.items():
        bp.set_input(bsdf, names[key], value)
    return mat


def bump(mat, strength, distance, build):
    """Adds a bump made by build(nodes, links) -> a height socket."""
    nt = mat.node_tree
    bsdf = bp.principled(mat)
    node = nt.nodes.new("ShaderNodeBump")
    node.inputs["Strength"].default_value = strength
    node.inputs["Distance"].default_value = distance
    nt.links.new(build(nt.nodes, nt.links), node.inputs["Height"])
    nt.links.new(node.outputs["Normal"], bsdf.inputs["Normal"])


def object_coords(nodes):
    return nodes.new("ShaderNodeTexCoord").outputs["Object"]


def stripes(nodes, links, coord, axis, scale, width, phase=0.0):
    """1 inside a stripe across `axis`, repeating every 1/scale units."""
    sep = nodes.new("ShaderNodeSeparateXYZ")
    links.new(coord, sep.inputs[0])
    m = nodes.new("ShaderNodeMath")
    m.operation = "MULTIPLY_ADD"
    links.new(sep.outputs[axis], m.inputs[0])
    m.inputs[1].default_value = scale
    m.inputs[2].default_value = phase
    fr = nodes.new("ShaderNodeMath")
    fr.operation = "FRACT"
    links.new(m.outputs[0], fr.inputs[0])
    lt = nodes.new("ShaderNodeMath")
    lt.operation = "LESS_THAN"
    links.new(fr.outputs[0], lt.inputs[0])
    lt.inputs[1].default_value = width
    return lt.outputs[0]


def mix(nodes, links, fac, a, b, blend="MIX"):
    node = nodes.new("ShaderNodeMix")
    node.data_type = "RGBA"
    node.blend_type = blend
    links.new(fac, node.inputs["Factor"])
    for socket, value in ((node.inputs[6], a), (node.inputs[7], b)):
        if isinstance(value, tuple):
            socket.default_value = (*value, 1.0)
        else:
            links.new(value, socket)
    return node.outputs[2]


def knit(name, base, columns, rows, stripes_at=(), stripe=(0.36, 0.035, 0.03)):
    """Wool in stockinette: a V stitch per cell of a sweep's UV, darker in the grooves. Stripes run
    across the band between the given distances along it."""
    mat = material(name, base, 0.92, sheen=0.85, sheen_roughness=0.4, specular=0.2)
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links

    def op(kind, *inputs):
        node = nodes.new("ShaderNodeMath")
        node.operation = kind
        for socket, value in zip(node.inputs, inputs):
            if isinstance(value, (int, float)):
                socket.default_value = value
            else:
                links.new(value, socket)
        return node.outputs[0]

    sep = nodes.new("ShaderNodeSeparateXYZ")
    links.new(nodes.new("ShaderNodeTexCoord").outputs["UV"], sep.inputs[0])
    u, v = sep.outputs["X"], sep.outputs["Y"]
    y = op("FRACT", op("MULTIPLY", u, rows))
    x = op("SUBTRACT", op("FRACT", op("MULTIPLY", v, columns)), 0.5)
    leg = op("ABSOLUTE", op("SUBTRACT", op("ABSOLUTE", x), op("MULTIPLY_ADD", y, -0.5, 0.5)))
    q = op("MULTIPLY", leg, 4.2)
    stitch = op("MAXIMUM", op("SUBTRACT", 1.0, op("MULTIPLY", q, q)), 0.0)
    pillow = op("MULTIPLY_ADD", op("SINE", op("MULTIPLY", y, math.pi)), 0.45, 0.55)
    height = op("MULTIPLY", stitch, pillow)
    colour = base
    if stripes_at:
        band = None
        for lo, hi in stripes_at:
            inside = op("MULTIPLY", op("GREATER_THAN", u, lo), op("LESS_THAN", u, hi))
            band = inside if band is None else op("MAXIMUM", band, inside)
        colour = mix(nodes, links, band, base, stripe)
    groove = op("MULTIPLY_ADD", height, -0.62, 0.62)
    links.new(mix(nodes, links, groove, colour, (0.3, 0.3, 0.3), "MULTIPLY"), bp.principled(mat).inputs["Base Color"])
    bump(mat, 0.85, 0.006, lambda n, l: height)
    return mat


def weave(nodes, links, scale):
    tex = nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = scale
    tex.inputs["Detail"].default_value = 2.0
    links.new(object_coords(nodes), tex.inputs["Vector"])
    return tex.outputs["Fac"]


def ribs(nodes, links, scale):
    tex = nodes.new("ShaderNodeTexWave")
    tex.wave_type = "BANDS"
    tex.bands_direction = "X"
    tex.inputs["Scale"].default_value = scale
    links.new(object_coords(nodes), tex.inputs["Vector"])
    return tex.outputs["Fac"]


def felt(name, base):
    mat = material(name, base, 0.9, sheen=0.7, sheen_roughness=0.35, specular=0.25)
    bump(mat, 0.35, 0.003, lambda n, l: weave(n, l, 260.0))
    return mat


# --- geometry -----------------------------------------------------------------------------------


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def mesh_object(name, build, mat, smooth=True):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    build(bm)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        for poly in me.polygons:
            poly.use_smooth = True
    ob = link(bpy.data.objects.new(name, me))
    ob.data.materials.append(mat)
    return ob


def modifier(ob, kind, **settings):
    mod = ob.modifiers.new(kind.lower(), kind)
    for key, value in settings.items():
        setattr(mod, key, value)
    return mod


def shell(name, mat, radius, keep_below, tilt=0.0, thickness=0.018):
    """The sphere at `radius`, cut along a neckline that dips `tilt` towards the front."""

    def build(bm):
        bmesh.ops.create_icosphere(bm, subdivisions=6, radius=radius)
        normal = Vector((0.0, -tilt, 1.0)).normalized()
        bmesh.ops.bisect_plane(
            bm,
            geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
            plane_co=(0.0, 0.0, keep_below),
            plane_no=normal,
            clear_outer=True,
        )

    ob = mesh_object(name, build, mat)
    modifier(ob, "SOLIDIFY", thickness=thickness, offset=1.0, use_even_offset=True)
    modifier(ob, "BEVEL", width=thickness * 0.45, segments=3, limit_method="ANGLE")
    return ob


def conform(bm, radius, cuts=6):
    """Subdivides a piece and lays every vertex on the sphere, so no chord dips under it."""
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    for v in bm.verts:
        v.co = v.co.normalized() * radius
    for face in bm.faces:
        if face.normal.dot(face.calc_center_median()) < 0:
            face.normal_flip()


def fill(bm, points):
    verts = [bm.verts.new(p) for p in points]
    edges = [bm.edges.new((verts[i], verts[(i + 1) % len(verts)])) for i in range(len(verts))]
    bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)


def surface(name, points, mat, radius, thickness, subdivide=2):
    """A piece lying on the sphere at `radius` through world points, thickened outward."""

    def build(bm):
        fill(bm, points)
        conform(bm, radius)

    ob = mesh_object(name, build, mat)
    modifier(ob, "SOLIDIFY", thickness=thickness, offset=1.0)
    if subdivide:
        modifier(ob, "SUBSURF", levels=subdivide, render_levels=subdivide)
    return ob


def patch(name, outline, mat, radius, thickness, subdivide=2):
    """A piece on the sphere through frame-unit points, where the eyes and face are drawn."""
    return surface(name, [on_sphere(x, y, radius) for x, y in outline], mat, radius, thickness, subdivide)


def neckline(azimuth_deg, z0, tilt, r):
    """The point at an azimuth (0 faces the camera) where a shell cut by shell() ends."""
    a = math.radians(azimuth_deg)

    def at(phi):
        return Vector((r * math.cos(phi) * math.sin(a), -r * math.cos(phi) * math.cos(a), r * math.sin(phi)))

    lo, hi = -math.pi / 2, math.pi / 2
    for _ in range(60):
        mid = (lo + hi) / 2
        p = at(mid)
        if p.z - (z0 + tilt * p.y) < 0:
            lo = mid
        else:
            hi = mid
    return at((lo + hi) / 2)


def below(p, radians):
    """A point the given angle further down the sphere's meridian from p."""
    lat = math.asin(max(-1.0, min(1.0, p.z / p.length))) - radians
    lon = math.atan2(p.x, -p.y)
    return Vector((math.cos(lat) * math.sin(lon), -math.cos(lat) * math.cos(lon), math.sin(lat))) * p.length


def cubic(p0, p1, p2, p3, steps=8):
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        out.append(
            (
                u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
            )
        )
    return out


def path_points(d, steps=8):
    """The outline of an SVG path made of M and C commands, in frame units."""
    tokens = re.findall(r"[MCZ]|-?\d*\.?\d+", d)
    pts, i, cur = [], 0, None
    while i < len(tokens):
        cmd = tokens[i]
        if cmd == "M":
            cur = (float(tokens[i + 1]), float(tokens[i + 2]))
            pts.append(cur)
            i += 3
        elif cmd == "C":
            p1 = (float(tokens[i + 1]), float(tokens[i + 2]))
            p2 = (float(tokens[i + 3]), float(tokens[i + 4]))
            p3 = (float(tokens[i + 5]), float(tokens[i + 6]))
            pts.extend(cubic(cur, p1, p2, p3, steps))
            cur = p3
            i += 7
        elif cmd == "Z":
            i += 1
        else:
            raise ValueError(cmd)
    if pts[0] == pts[-1]:
        pts.pop()
    return pts


def tube(name, points, mat, bevel, closed=False):
    """A round tube along world points: straight between many points, a smooth NURBS through few."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = bevel
    cu.bevel_resolution = 6
    cu.resolution_u = 24
    cu.use_fill_caps = True
    smooth = len(points) <= 6 and not closed
    sp = cu.splines.new("NURBS" if smooth else "POLY")
    sp.points.add(len(points) - 1)
    for p, co in zip(sp.points, points):
        p.co = (*co, 1.0)
    if smooth:
        sp.order_u = min(4, len(points))
        sp.use_endpoint_u = True
    sp.use_cyclic_u = closed
    sp.use_smooth = True
    ob = link(bpy.data.objects.new(name, cu))
    ob.data.materials.append(mat)
    return ob


def sweep(name, centres, half, depth, mat, closed=False, sides=40, twist=None, cap=False, profile=0.6):
    """A soft band along world points `centres`, lying on whatever is under it. Its cross-section is
    a rounded slab `half(s)` either side of the centre line and `depth(s)` thick, where s is the
    distance along the band, squarer the smaller `profile` is (1 is an ellipse); the inner face
    passes through the centres and the outer face is away from the body's centre. UV u runs along
    the band in body radii and v once round the section, starting on the hidden inner face."""
    count = len(centres)
    pts = [*centres, centres[0]] if closed else list(centres)
    along = [0.0]
    for i in range(1, len(pts)):
        along.append(along[-1] + (pts[i] - pts[i - 1]).length)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    rings = []
    for i, c in enumerate(pts):
        if closed:
            prev, nxt = pts[(i - 1) % count], pts[(i + 1) % count]
        else:
            prev, nxt = pts[max(i - 1, 0)], pts[min(i + 1, count - 1)]
        t = (nxt - prev).normalized()
        n = (c - t * c.dot(t)).normalized()
        b = t.cross(n)
        s_i = along[i]
        if twist:
            a = twist(s_i)
            b, n = b * math.cos(a) + n * math.sin(a), n * math.cos(a) - b * math.sin(a)
        ring = []
        for k in range(sides + 1):
            phi = -math.pi / 2 + 2 * math.pi * k / sides
            cx, sx = math.cos(phi), math.sin(phi)
            across = half(s_i) * math.copysign(abs(cx) ** profile, cx)
            out = depth(s_i) * 0.5 * (1 + math.copysign(abs(sx) ** profile, sx))
            ring.append(bm.verts.new(c + b * across + n * out))
        rings.append(ring)
    for i in range(len(rings) - 1):
        for k in range(sides):
            face = bm.faces.new((rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k]))
            for loop, (ii, kk) in zip(face.loops, ((i, k), (i, k + 1), (i + 1, k + 1), (i + 1, k))):
                loop[uv].uv = (along[ii], kk / sides)
    if cap:
        bm.faces.new(rings[-1][:-1])
        bm.faces.new(list(reversed(rings[0][:-1])))
    bm.normal_update()
    outer = rings[len(rings) // 2][sides // 2]
    if next(iter(outer.link_faces)).normal.dot(outer.co) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    ob = link(bpy.data.objects.new(name, me))
    ob.data.materials.append(mat)
    return ob


def smooth_path(points, steps=12):
    """A Catmull-Rom curve through world points, sampled `steps` times per span."""
    out = []
    ext = [points[0] * 2 - points[1], *points, points[-1] * 2 - points[-2]]
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        for k in range(steps):
            t = k / steps
            out.append(
                0.5
                * (
                    2 * p1
                    + (p2 - p0) * t
                    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                    + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t
                )
            )
    out.append(points[-1].copy())
    return out


def sphere_at(lat_deg, az_deg, r=1.0):
    """The point at a latitude and an azimuth (0 faces the camera) on a sphere about the body's centre."""
    lat, az = math.radians(lat_deg), math.radians(az_deg)
    return Vector((math.cos(lat) * math.sin(az), -math.cos(lat) * math.cos(az), math.sin(lat))) * r


def region(name, lo, hi, mat, radius, thickness, step=2.0, rows=48):
    """The sphere at `radius` between latitudes lo(az) and hi(az) at each azimuth (degrees, 0 facing
    the camera), thickened outward: a garment's body with a clean edge of any shape. UV u runs up a
    meridian in body radii and v once round."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    count = int(round(360 / step))
    azs = [-180 + step * i for i in range(count + 1)]
    grid = []
    for az in azs:
        a, b_ = lo(az), hi(az)
        grid.append([(bm.verts.new(sphere_at(a + (b_ - a) * j / rows, az, radius)), a + (b_ - a) * j / rows) for j in range(rows + 1)])
    for i in range(count):
        left, right = grid[i], grid[i + 1]
        for j in range(rows):
            corners = (left[j], right[j], right[j + 1], left[j + 1])
            face = bm.faces.new([v for v, _ in corners])
            for loop, (column, (_, lat)) in zip(face.loops, ((i, corners[0]), (i + 1, corners[1]), (i + 1, corners[2]), (i, corners[3]))):
                loop[uv].uv = (math.radians(lat), column / count)
    bmesh.ops.remove_doubles(bm, verts=[v for column in (grid[0], grid[-1]) for v, _ in column], dist=1e-6)
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    probe = bm.faces[len(bm.faces) // 2]
    if probe.normal.dot(probe.calc_center_median()) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    ob = link(bpy.data.objects.new(name, me))
    ob.data.materials.append(mat)
    modifier(ob, "SOLIDIFY", thickness=thickness, offset=1.0, use_even_offset=True)
    modifier(ob, "BEVEL", width=thickness * 0.45, segments=3, limit_method="ANGLE")
    return ob


def on_body(lat, az, lift):
    """A world point on the sphere at a latitude and azimuth, `lift` above the body."""
    return sphere_at(lat, az, 1.0 + lift)


def smoothstep(lo, hi, x):
    t = max(0.0, min(1.0, (x - lo) / (hi - lo)))
    return t * t * (3 - 2 * t)


def frame_shape(name, centre, hw, hh, radius, mat, bevel, lens_mat=None):
    """A spectacle rim facing the camera about world point `centre`."""
    m = bpy.context.scene.camera.matrix_world.to_3x3()
    right, up = m @ Vector((1, 0, 0)), m @ Vector((0, 1, 0))
    pts = []
    steps = 10
    r = min(radius, hw, hh)
    for qx, qy, start in ((hw - r, hh - r, 0), (-(hw - r), hh - r, 90), (-(hw - r), -(hh - r), 180), (hw - r, -(hh - r), 270)):
        for k in range(steps + 1):
            a = math.radians(start + 90 * k / steps)
            pts.append(centre + right * (qx + r * math.cos(a)) + up * (qy + r * math.sin(a)))
    rim = tube(f"{name}-rim", pts, mat, bevel, closed=True)
    if lens_mat:

        def build(bm):
            verts = [bm.verts.new(p) for p in pts]
            bm.faces.new(verts)

        mesh_object(f"{name}-lens", build, lens_mat)
    return rim


# --- wearables ----------------------------------------------------------------------------------


def eye_point(i, lift):
    x, y = EYES[i]
    return toward_camera(on_sphere(x, y), lift)


def spectacles(rim, hw, hh, corner, bevel, lift):
    """Two rims about the eyes with clear lenses, which cast no shadow so the eyes stay bright."""
    lens = material("lens", (0.9, 0.95, 1.0), 0.02, transmission=1.0, ior=1.45, specular=0.6)
    centres = [eye_point(i, lift) for i in range(2)]
    for i, c in enumerate(centres):
        frame_shape(f"rim{i}", c, hw * U, hh * U, corner * U, rim, bevel, lens)
        bpy.data.objects[f"rim{i}-lens"].visible_shadow = False
    m = bpy.context.scene.camera.matrix_world.to_3x3()
    return centres, m @ Vector((1, 0, 0)), m @ Vector((0, 1, 0))


def glasses_round():
    gold = material("gold-wire", (0.83, 0.62, 0.3), 0.18, metallic=1.0)
    (left, right), rt, up = spectacles(gold, 5.3, 5.3, 5.3, 0.0105, 0.065)
    ends = []
    for side, eye in ((1, left), (-1, right)):
        ends.append(eye + rt * (side * 5.3 * U * math.cos(0.5)) + up * (5.3 * U * math.sin(0.5)))
    tube("bridge", [ends[0], (ends[0] + ends[1]) / 2 + up * (0.9 * U), ends[1]], gold, 0.009)


MUSTACHE = (
    "M32 36.2 C30 34.9 26.8 35 24.9 36.8 C23.6 38.1 22.1 38.3 21.1 37.3 C20.4 36.6 20.5 35.6 21.2 35.1 "
    "C20 35.3 19.4 36.6 19.9 37.9 C20.9 40.4 25.4 41.1 28.5 39.6 C30.1 38.8 31.2 38.2 32 37.6 "
    "C32.8 38.2 33.9 38.8 35.5 39.6 C38.6 41.1 43.1 40.4 44.1 37.9 C44.6 36.6 44 35.3 42.8 35.1 "
    "C43.5 35.6 43.6 36.6 42.9 37.3 C41.9 38.3 40.4 38.1 39.1 36.8 C37.2 35 34 34.9 32 36.2"
)


def mustache():
    hair = material("hair", (0.07, 0.035, 0.02), 0.45, sheen=0.4, sheen_roughness=0.3, coat=0.1)
    bump(hair, 0.5, 0.004, lambda n, l: ribs(n, l, 90.0))
    ob = patch("mustache", path_points(MUSTACHE, 10), hair, 1.004, 0.03, 2)
    modifier(ob, "SMOOTH", factor=0.6, iterations=4)


def heather(name, dark, light, sheen, ribs=0.0):
    """Cotton fleece of dark and light yarn, which a few pixels see as one soft grey. With `ribs`
    it is knitted in ribs across a sweep's band, that many to a body radius."""
    mat = material(name, dark, 0.9, sheen=sheen, sheen_roughness=0.5, specular=0.2)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    tex = nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = 150.0
    tex.inputs["Detail"].default_value = 4.0
    links.new(object_coords(nodes), tex.inputs["Vector"])
    yarn = nodes.new("ShaderNodeMapRange")
    yarn.inputs["From Min"].default_value = 0.35
    yarn.inputs["From Max"].default_value = 0.65
    links.new(tex.outputs["Fac"], yarn.inputs["Value"])
    colour = mix(nodes, links, yarn.outputs["Result"], dark, light)
    if ribs:
        sep = nodes.new("ShaderNodeSeparateXYZ")
        links.new(nodes.new("ShaderNodeTexCoord").outputs["UV"], sep.inputs[0])
        phase = nodes.new("ShaderNodeMath")
        phase.operation = "MULTIPLY"
        links.new(sep.outputs["X"], phase.inputs[0])
        phase.inputs[1].default_value = 2 * math.pi * ribs
        wave = nodes.new("ShaderNodeMath")
        wave.operation = "SINE"
        links.new(phase.outputs[0], wave.inputs[0])
        groove = nodes.new("ShaderNodeMath")
        groove.operation = "MULTIPLY_ADD"
        links.new(wave.outputs[0], groove.inputs[0])
        groove.inputs[1].default_value = -0.5
        groove.inputs[2].default_value = 0.5
        colour = mix(nodes, links, groove.outputs[0], colour, (0.6, 0.6, 0.6), "MULTIPLY")
        bump(mat, 0.5, 0.004, lambda n, l: wave.outputs[0])
    else:
        bump(mat, 0.25, 0.003, lambda n, l: weave(n, l, 240.0))
    links.new(colour, bp.principled(mat).inputs["Base Color"])
    return mat


HEATHER = ((0.019, 0.02, 0.022), (0.055, 0.057, 0.061))


def hoodie():
    """A heather-charcoal hoodie with the hood down, on the lower body as the suit is: a scoop
    neckline well under the face with a rolled ribbed collar, the hood bunched in a soft cowl behind
    the neck that rises toward the back and hangs down it, and two flat drawstrings from eyelets
    either side of the scoop."""
    cloth = heather("hoodie", *HEATHER, 0.3)

    def neck(az):
        """The neckline's latitude: lowest at the front, rising to the sides and the back."""
        a = abs((az + 180.0) % 360.0 - 180.0)
        return -6.0 - 12.0 * math.exp(-((a / 30.0) ** 2)) + 8.0 * smoothstep(90.0, 180.0, a)

    body = region("hoodie", lambda az: -89.0, neck, cloth, 1.02, 0.025)
    # Soft folds: the cloth sagging in ripples under the scoop, creases hanging beside the
    # drawstrings, and wider folds round the sides.
    for v in body.data.vertices:
        lat = math.degrees(math.asin(max(-1.0, min(1.0, v.co.z / v.co.length))))
        az = math.degrees(math.atan2(v.co.x, -v.co.y))
        below = neck(az) - lat
        front = math.exp(-((az / 45.0) ** 2))
        wave = below - 3.0 + 2.5 * math.sin(math.radians(3.0 * az) + 0.4)
        ripple = front * smoothstep(2.0, 8.0, below) * (1 - smoothstep(24.0, 40.0, below)) * math.sin(2 * math.pi * wave / 13.0) * (0.75 + 0.25 * math.sin(math.radians(5.0 * az) + 1.1))
        crease = front * smoothstep(4.0, 12.0, below) * (1 - smoothstep(26.0, 44.0, below)) * (abs(math.sin(math.radians(8.0 * az + 20.0))) ** 0.5 - 0.7)
        side = smoothstep(6.0, 28.0, below) * (0.6 * math.sin(math.radians(4.0 * az) + 0.8) + 0.4 * math.sin(math.radians(7.0 * az) + 2.3))
        v.co += v.co.normalized() * (0.02 * ripple + 0.01 * crease + 0.007 * side)
    collar = heather("hoodie-collar", (0.016, 0.017, 0.019), (0.046, 0.048, 0.053), 0.35, ribs=70.0)
    sweep("collar", [sphere_at(neck(az), az, 1.004) for az in range(0, 360, 3)], lambda s: 0.028, lambda s: 0.05, collar, closed=True, sides=24, profile=1.0)

    # The hood's opening edge, bunched in a roll that rides higher behind the neck and thins toward
    # the front, where it tucks behind the collar.
    def lift(a):
        return 3.0 + 13.0 * smoothstep(40.0, 170.0, a)

    azs = [40.0 + 2.0 * i for i in range(141)]
    behind = [180.0 - abs(180.0 - az) for az in azs]
    roll = [sphere_at(neck(az) + lift(a), az, 1.004) for az, a in zip(azs, behind)]
    along = [0.0]
    for i in range(1, len(roll)):
        along.append(along[-1] + (roll[i] - roll[i - 1]).length)
    bunch = [1 + 0.18 * math.sin(math.radians(5.0 * az) + 0.5) + 0.07 * math.sin(math.radians(11.0 * az) + 1.7) for az in azs]
    half = [(0.025 + 0.085 * smoothstep(40.0, 110.0, a)) * k for a, k in zip(behind, bunch)]
    deep = [(0.025 + 0.085 * smoothstep(40.0, 110.0, a)) * k for a, k in zip(behind, bunch)]
    nearest = lambda s: min(range(len(along)), key=lambda i: abs(along[i] - s))
    sweep("hood", roll, lambda s: half[nearest(s)], lambda s: deep[nearest(s)], cloth, sides=32, cap=True, profile=1.0)

    def pouch_at(az, t):
        """The hood hanging down the back from under the roll, t from its hem (0) to the roll (1):
        the latitude, and how far it swells above the cloth."""
        a = 180.0 - abs(180.0 - az % 360.0)
        hang = smoothstep(95.0, 135.0, a)
        crown = max(0.0, math.cos(math.pi / 2 * (180.0 - a) / 55.0)) ** 1.2
        top = neck(az) + lift(a)
        hem = neck(az) - (10.0 * hang + 22.0 * crown)
        swell = (0.03 * hang + 0.05 * crown) * (1 + 0.22 * math.sin(math.radians(11.0 * az) + 0.9))
        return hem + (top - hem) * t, swell * math.sin(math.pi * t**0.8) ** 0.8

    def build(bm):
        rows = 20
        grid = []
        for az in (95.0 + 1.5 * i for i in range(115)):
            column = []
            for j in range(rows + 1):
                lat, swell = pouch_at(az, j / rows)
                column.append(bm.verts.new(sphere_at(lat, az, 1.047 + swell)))
            grid.append(column)
        for i in range(len(grid) - 1):
            for j in range(rows):
                bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
        bm.normal_update()
        bm.faces.ensure_lookup_table()
        probe = bm.faces[len(bm.faces) // 2]
        if probe.normal.dot(probe.calc_center_median()) < 0:
            bmesh.ops.reverse_faces(bm, faces=bm.faces[:])

    pouch = mesh_object("hood-pouch", build, cloth)
    modifier(pouch, "SOLIDIFY", thickness=0.016, offset=-1.0, use_even_offset=True)
    modifier(pouch, "BEVEL", width=0.007, segments=3, limit_method="ANGLE")
    seam = material("hood-seam", HEATHER[0], 0.9, sheen=0.3)
    crown = []
    for k in range(13):
        lat, swell = pouch_at(180.0, 0.9 - 0.85 * k / 12)
        crown.append(sphere_at(lat, 180.0, 1.05 + swell))
    tube("hood-seam", crown, seam, 0.0045)
    cord = material("cord", (0.6, 0.6, 0.59), 0.75, sheen=0.4)
    metal = material("aglet", (0.7, 0.71, 0.74), 0.25, metallic=1.0)
    for sign, length, sway in ((-1, 22.5, 1.4), (1, 24.0, -0.9)):
        az = sign * 9.0
        top = neck(az) - 0.6
        eyelet = on_body(top, az, 0.054)
        bpy.ops.mesh.primitive_torus_add(major_radius=0.013, minor_radius=0.0035, location=eyelet, major_segments=24, minor_segments=8)
        ring = bpy.context.active_object
        ring.rotation_euler = eyelet.normalized().to_track_quat("Z", "Y").to_euler()
        ring.data.materials.append(metal)
        bpy.ops.object.shade_smooth()
        path = [on_body(top - length * t, az + sway * math.sin(0.9 * math.pi * t), 0.06 + 0.004 * math.sin(math.pi * t)) for t in (k / 18 for k in range(19))]
        sweep(f"string{sign}", path, lambda s: 0.0105, lambda s: 0.006, cord, sides=16, cap=True)
        end, before = path[-1], path[-2]
        down = (end - before).normalized()
        tube(f"aglet{sign}", [end - down * 0.004, end + down * 0.02, end + down * 0.042], metal, 0.0085)


def suit():
    """A navy jacket open in a V over a white shirt and a red tie: the lapels fold back along the V
    from the shoulders to the button, and the shirt's collar points frame the knot."""
    wool = material("suit", (0.03, 0.045, 0.085), 0.72, sheen=0.4, sheen_roughness=0.4)
    bump(wool, 0.15, 0.003, lambda n, l: weave(n, l, 220.0))
    side, low, corner = -16.0, -60.0, 40.0

    def v_neck(az):
        return low + (side - low) * min(abs(az) / corner, 1.0)

    region("jacket", lambda az: -89.0, v_neck, wool, 1.03, 0.022)
    shirt = material("shirt", (0.86, 0.87, 0.89), 0.6, sheen=0.2)
    # The shirt shows only in the V; at the sides it stays under the jacket.
    region("shirt", lambda az: -89.0, lambda az: -19.0, shirt, 1.012, 0.008)
    # The lapels: a strip on the jacket along each side of the V, widest under the shoulder.
    lapel = material("lapel", (0.04, 0.056, 0.1), 0.5, sheen=0.5, sheen_roughness=0.25)
    for sign in (-1, 1):
        rim = []
        steps = 14
        for i in range(steps + 1):
            lat = side - (side - low) * i / steps
            az = corner * (lat - low) / (side - low)
            rim.append((lat, az))
        inner = [on_body(lat, sign * az, 0.0) for lat, az in rim]
        outer = []
        for lat, az in reversed(rim):
            k = (lat - low) / (side - low)
            width = 11.0 * math.sin(math.pi * min(1.0, k * 1.15) / 2) ** 1.5 if k < 0.87 else 11.0 - 30.0 * (k - 0.87)
            outer.append(on_body(lat - 1.0 * k, sign * (az + max(width, 0.0)), 0.0))
        surface(f"lapel{sign}", inner + outer, lapel, 1.056, 0.012, 2)
    # The collar behind the neck, rolled.
    tube("collar", [on_body(side + 1.0, az, 0.052) for az in range(40, 321, 4)], wool, 0.02)
    silk = material("tie", (0.36, 0.035, 0.07), 0.3, sheen=0.3, coat=0.25, coat_roughness=0.2)
    knot = [on_body(-19.5, -3.6, 0), on_body(-19.5, 3.6, 0), on_body(-26.0, 2.4, 0), on_body(-26.0, -2.4, 0)]
    surface("knot", knot, silk, 1.034, 0.02, 2)
    blade = [on_body(-26.0, -2.4, 0), on_body(-26.0, 2.4, 0), on_body(-47.0, 4.8, 0), on_body(-52.0, 0.0, 0), on_body(-47.0, -4.8, 0)]
    surface("blade", blade, silk, 1.026, 0.01, 2)
    for sign in (-1, 1):
        points = [on_body(-19.0, sign * 3.4, 0), on_body(-17.5, sign * 15.0, 0), on_body(-29.0, sign * 9.0, 0)]
        surface(f"shirt-collar{sign}", points, shirt, 1.04, 0.01, 2)
    button = material("jacket-button", (0.015, 0.018, 0.03), 0.3, coat=0.5)
    p = on_body(low - 4.5, 0.0, 0.056)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.026, depth=0.012, location=p, vertices=32)
    ob = bpy.context.active_object
    ob.rotation_euler = p.to_track_quat("Z", "Y").to_euler()
    ob.data.materials.append(button)
    modifier(ob, "BEVEL", width=0.004, segments=2)


MUSTARD = (0.62, 0.34, 0.02)


def scarf():
    """A knitted wrap round the lower body with two ends hanging at the front left, fringed."""
    z0, tilt = -0.36, 0.22
    loop = [neckline(a, z0, tilt, 1.004) for a in range(180, 540, 3)]
    w = 2 * math.pi / sum((loop[i] - loop[i - 1]).length for i in range(len(loop)))

    def half(s):
        return 0.13 * (1 + 0.08 * math.sin(3 * w * s + 0.4) + 0.05 * math.sin(7 * w * s + 1.3))

    def depth(s):
        return 0.1 * (1 + 0.14 * math.sin(4 * w * s + 2.0) + 0.06 * math.sin(9 * w * s))

    sweep("scarf", loop, half, depth, knit("scarf", MUSTARD, 18, 30), closed=True, sides=48)
    yarn = material("yarn", MUSTARD, 0.9, sheen=0.8, sheen_roughness=0.4)
    bump(yarn, 0.4, 0.003, lambda n, l: weave(n, l, 300.0))
    for i, (az, drift, lift) in enumerate(((-40, -7, 0.0), (-19, 5, 0.03))):
        top = neckline(az, z0, tilt, 1.006 + lift)
        lat = math.degrees(math.asin(top.z / top.length))
        low = sphere_at(lat - 30, az + drift, 1.008 + lift)
        path = smooth_path([top, sphere_at(lat - 14, az + drift * 0.4, 1.008 + lift), low, low + Vector((0, 0, -0.15))])
        floor = 1.006 + lift
        path = [p if p.length >= floor else p.normalized() * floor for p in path]
        length = sum((path[k] - path[k - 1]).length for k in range(1, len(path)))
        stripes_at = ((length - 0.2, length - 0.165), (length - 0.125, length - 0.09))

        def tail_half(s, length=length):
            return 0.125 * (1 + 0.05 * math.sin(11 * s)) + 0.016 * max(0.0, (s - length + 0.16) / 0.16)

        def turn(s, i=i):
            return (0.16 if i else -0.12) * math.sin(2.4 * s)

        sweep(f"tail{i}", path, tail_half, lambda s: 0.028, knit(f"tail{i}", MUSTARD, 12, 30, stripes_at), sides=32, twist=turn, cap=True)
        end, before = path[-1], path[-2]
        t = (end - before).normalized()
        n = (end - t * end.dot(t)).normalized()
        b = t.cross(n)
        a = turn(length)
        b, n = b * math.cos(a) + n * math.sin(a), n * math.cos(a) - b * math.sin(a)
        span = tail_half(length)
        for j in range(9):
            f = -0.86 + 1.72 * j / 8
            start = end + b * (f * span) + n * 0.014 - t * 0.01
            reach = 0.075 + 0.018 * math.sin(j * 2.3 + i)
            tip = start + (t * 0.6 + Vector((0, 0, -0.4))).normalized() * reach + b * (0.008 * math.sin(j * 1.7))
            tube(f"fringe{i}-{j}", [start, (start + tip) / 2 + n * 0.006, tip], yarn, 0.0085)


def headphones():
    plastic = material("plastic", (0.02, 0.022, 0.026), 0.42, coat=0.2, coat_roughness=0.3)
    leather = material("leather", (0.03, 0.03, 0.034), 0.6, sheen=0.2)
    metal = material("metal", (0.55, 0.57, 0.6), 0.28, metallic=1.0)
    # The band rests on the head: its inner face meets the body at radius 1.
    bpy.ops.mesh.primitive_torus_add(major_radius=1.045, minor_radius=0.045, rotation=(math.radians(90), 0, 0), major_segments=128, minor_segments=24)
    band = bpy.context.active_object
    band.data.materials.append(plastic)
    bpy.ops.object.shade_smooth()
    bm = bmesh.new()
    bm.from_mesh(band.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, -0.02, 0), plane_no=(0, -1, 0), clear_outer=True)
    bm.to_mesh(band.data)
    bm.free()
    for side in (-1, 1):
        x = side * 1.06
        bpy.ops.mesh.primitive_cylinder_add(radius=0.22, depth=0.16, location=(x, 0.0, -0.08), rotation=(0, math.radians(90), 0), vertices=64)
        cup = bpy.context.active_object
        cup.data.materials.append(plastic)
        modifier(cup, "BEVEL", width=0.04, segments=6)
        bpy.ops.object.shade_smooth()
        bpy.ops.mesh.primitive_torus_add(major_radius=0.17, minor_radius=0.055, location=(side * 0.985, 0.0, -0.08), rotation=(0, math.radians(90), 0), major_segments=64, minor_segments=20)
        pad = bpy.context.active_object
        pad.data.materials.append(leather)
        bpy.ops.object.shade_smooth()
        bpy.ops.mesh.primitive_cylinder_add(radius=0.03, depth=0.2, location=(side * 1.075, 0.0, 0.16), vertices=32)
        slider = bpy.context.active_object
        slider.data.materials.append(metal)
        bpy.ops.object.shade_smooth()


def mortarboard():
    black = felt("mortar", (0.012, 0.012, 0.015))
    cap = mesh_object("skull", lambda bm: bmesh.ops.create_icosphere(bm, subdivisions=6, radius=1.03), black)
    bm = bmesh.new()
    bm.from_mesh(cap.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, 0.66), plane_no=(0, 0, -1), clear_outer=True)
    bm.to_mesh(cap.data)
    bm.free()
    modifier(cap, "SOLIDIFY", thickness=0.03, offset=1.0)
    # Seen almost edge on, felt or any strong specular turns the board white; this one stays black.
    card = material("board", (0.014, 0.014, 0.017), 0.8, specular=0.08)
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 1.055))
    board = bpy.context.active_object
    board.scale = (1.02, 1.02, 0.03)
    board.rotation_euler = (math.radians(-6), 0, math.radians(45))
    board.data.materials.append(card)
    modifier(board, "BEVEL", width=0.012, segments=3)
    gold = material("gold", (0.85, 0.6, 0.18), 0.32, metallic=1.0)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.035, location=(0, 0, 1.085))
    bpy.context.active_object.data.materials.append(gold)
    bpy.ops.object.shade_smooth()
    tip = Vector((0.66, -0.02, 1.02))
    tube("cord", [Vector((0, 0, 1.09)), Vector((0.3, -0.05, 1.085)), tip, tip + Vector((0.02, -0.08, -0.12)), tip + Vector((0.03, -0.1, -0.26))], gold, 0.008)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.04, depth=0.2, location=tip + Vector((0.03, -0.1, -0.36)), vertices=24)
    bpy.context.active_object.data.materials.append(gold)
    bump(gold, 0.6, 0.01, lambda n, l: ribs(n, l, 260.0))


def beret():
    """A felt puff on a narrow band that grips the head, tilted to one side."""
    tilt = Euler((math.radians(-8), math.radians(-12), 0))
    m = tilt.to_matrix()
    axis = m @ Vector((0, 0, 1))
    seat = 0.78
    bpy.ops.mesh.primitive_torus_add(major_radius=math.sqrt(1 - seat * seat) + 0.012, minor_radius=0.04, location=axis * seat, major_segments=128, minor_segments=24)
    band = bpy.context.active_object
    band.rotation_euler = tilt
    band.data.materials.append(felt("beret-band", (0.22, 0.014, 0.032)))
    bpy.ops.object.shade_smooth()
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=96, ring_count=48)
    puff = bpy.context.active_object
    # A beret's underside is nearly flat, so the band shows beneath it.
    for v in puff.data.vertices:
        if v.co.z < 0:
            v.co.z *= 0.45
    puff.location = axis * 0.9 + m @ Vector((0.05, 0, 0))
    puff.scale = (0.86, 0.82, 0.22)
    puff.rotation_euler = tilt
    puff.data.materials.append(felt("beret", (0.42, 0.03, 0.06)))
    bpy.ops.object.shade_smooth()
    bpy.ops.mesh.primitive_cylinder_add(radius=0.026, depth=0.07, location=axis * 1.13 + m @ Vector((0.03, 0, 0)), vertices=24)
    stem = bpy.context.active_object
    stem.rotation_euler = tilt
    stem.data.materials.append(puff.data.materials[0])
    bpy.ops.object.shade_smooth()


# What tells one localDot from another, worn with any dot's outfit.


def cap_twill():
    twill = material("cap", (0.016, 0.05, 0.3), 0.78, sheen=0.3, sheen_roughness=0.5)
    bump(twill, 0.2, 0.003, lambda n, l: weave(n, l, 260.0))
    return twill


CAP_EDGE = 46.0


def cap_rim(az):
    """Where the cap meets the head: level in front over the eyes, lower round the sides and back."""
    return CAP_EDGE - 9.0 * (1 - math.cos(math.radians(az))) / 2


def cap_brim(twill):
    """The cap's curved bill, forward over the eyes."""

    def build(bm):
        steps_u, steps_v = 32, 8
        grid = []
        for i in range(steps_u + 1):
            u = -1 + 2 * i / steps_u
            az = 44.0 * u
            inner = on_body(cap_rim(az) + 0.5, az, 0.03)
            out = Vector((math.sin(math.radians(az)) * 0.6, -math.cos(math.radians(az)), -0.18)).normalized()
            reach = 0.5 * math.sqrt(max(0.0, 1 - u * u)) ** 0.6
            row = []
            for j in range(steps_v + 1):
                k = j / steps_v
                row.append(bm.verts.new(inner + out * (reach * k) + Vector((0, 0, -0.1 * u * u * k))))
            grid.append(row)
        for i in range(steps_u):
            for j in range(steps_v):
                bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))

    brim = mesh_object("brim", build, twill)
    modifier(brim, "SOLIDIFY", thickness=0.026, offset=0.0)
    modifier(brim, "BEVEL", width=0.01, segments=3, limit_method="ANGLE")
    modifier(brim, "SUBSURF", levels=2, render_levels=2)


def cap():
    """A baseball cap above the eyes: a tall six-panel crown with a button, and the bill forward."""
    twill = cap_twill()
    # The crown rises above the head the way a structured cap's front panels stand up.
    lift = lambda lat: 0.16 * max(0.0, min(1.0, (lat - 40.0) / 50.0)) ** 1.4

    crown = region("cap", cap_rim, lambda az: 89.5, twill, 1.012, 0.03, rows=48)
    for v in crown.data.vertices:
        lat = math.degrees(math.asin(max(-1.0, min(1.0, v.co.z / v.co.length))))
        v.co += v.co.normalized() * (lift(lat) + 0.03 * math.sin(math.pi * max(0.0, min(1.0, (lat - 38.0) / 52.0))))
    seam = material("cap-seam", (0.01, 0.03, 0.2), 0.7)
    for az in range(-150, 181, 60):
        points = []
        for k in range(9):
            lat = cap_rim(az) + 3 + (86 - cap_rim(az) - 3) * k / 8
            points.append(on_body(lat, az, 0.046 + lift(lat) + 0.03 * math.sin(math.pi * k / 8)))
        tube(f"seam{az}", points, seam, 0.004)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.035, location=(0, 0, 1.012 + 0.03 + 0.16 + 0.012), segments=32, ring_count=16)
    button = bpy.context.active_object
    button.scale = (1, 1, 0.5)
    button.data.materials.append(twill)
    bpy.ops.object.shade_smooth()
    cap_brim(twill)


def wayfarer(centre, rt, up, top, bottom, height, corner, steps=6):
    """A wayfarer lens outline about a world point: wider at the brow than at the cheek."""
    points = []
    corners = (
        (top - corner, height / 2 - corner, 0),
        (-(top - corner), height / 2 - corner, 90),
        (-(bottom - corner), -height / 2 + corner, 180),
        (bottom - corner, -height / 2 + corner, 270),
    )
    for cx, cy, start in corners:
        for k in range(steps + 1):
            a = math.radians(start + 90 * k / steps)
            points.append(centre + rt * ((cx + corner * math.cos(a)) * U) + up * ((cy + corner * math.sin(a)) * U))
    return points


def sunglasses():
    """Wayfarer sunglasses over the eyes, tinted so dot's eyes still show through them."""
    acetate = material("shades-frame", (0.01, 0.011, 0.013), 0.16, coat=0.8, coat_roughness=0.05)
    tint = material("shades-lens", (0.01, 0.014, 0.022), 0.04, coat=1.0, coat_roughness=0.02, specular=0.9, alpha=0.58)
    m = bpy.context.scene.camera.matrix_world.to_3x3()
    rt, up = m @ Vector((1, 0, 0)), m @ Vector((0, 1, 0))
    centres = []
    for i, x in enumerate((25.0, 39.0)):
        centre = toward_camera(on_sphere(x, 27.2), 0.075)
        centres.append(centre)
        outline = wayfarer(centre, rt, up, 5.8, 4.7, 10.6, 2.2)
        tube(f"rim{i}", outline + outline[:1], acetate, 0.03)

        def lens(bm, outline=outline):
            bm.faces.new([bm.verts.new(p) for p in outline])

        glass = mesh_object(f"lens{i}", lens, tint)
        glass.visible_shadow = False
        brow = [centre + rt * ((-5.8 + 11.6 * k / 10) * U) + up * ((5.3 - 0.2 * math.sin(math.pi * k / 10)) * U) for k in range(11)]
        tube(f"brow{i}", brow, acetate, 0.034)
    a, b = centres[0] + rt * (5.6 * U) + up * (2.6 * U), centres[1] - rt * (5.6 * U) + up * (2.6 * U)
    tube("bridge", [a, (a + b) / 2 + up * (0.8 * U), b], acetate, 0.026)
    steel = material("hinge", (0.75, 0.76, 0.78), 0.25, metallic=1.0)
    for side, centre in ((-1, centres[0]), (1, centres[1])):
        at = toward_camera(centre + rt * (side * 4.6 * U) + up * (4.4 * U), 0.03)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.012, location=at, segments=24, ring_count=12)
        bpy.context.active_object.data.materials.append(steel)
        bpy.ops.object.shade_smooth()


def bow():
    """A satin bow on the upper left of the head."""
    satin = material("bow", (0.55, 0.02, 0.09), 0.32, sheen=0.5, sheen_roughness=0.3, coat=0.3, coat_roughness=0.2)
    centre = on_body(50.0, -40.0, 0.07)
    n = centre.normalized()
    across = Vector((0, 0, 1)).cross(n).normalized()
    up = n.cross(across).normalized()
    turn = Matrix((across, up, n)).transposed()
    for side in (-1, 1):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=64, ring_count=32)
        loop = bpy.context.active_object
        tilt = Matrix.Rotation(math.radians(side * 18), 4, "Z")
        loop.matrix_world = Matrix.Translation(centre + across * (side * 0.2)) @ turn.to_4x4() @ tilt @ Matrix.Diagonal((0.22, 0.14, 0.08, 1.0))
        loop.data.materials.append(satin)
        bpy.ops.object.shade_smooth()
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=48, ring_count=24)
    knot = bpy.context.active_object
    knot.matrix_world = Matrix.Translation(centre + n * 0.03) @ turn.to_4x4() @ Matrix.Diagonal((0.08, 0.095, 0.07, 1.0))
    knot.data.materials.append(satin)
    bpy.ops.object.shade_smooth()
    for side in (-1, 1):
        start = centre - up * 0.06
        tube(f"tail{side}", [start, start - up * 0.13 + across * (side * 0.07), start - up * 0.25 + across * (side * 0.13)], satin, 0.03)


def star_pin():
    """A small gold star pinned low on the chest, over whatever dot wears."""
    gold = material("star", (0.86, 0.6, 0.16), 0.22, metallic=1.0)
    centre = on_sphere(41.5, 50.0, 1.075)
    n = centre.normalized()
    across = Vector((0, 0, 1)).cross(n).normalized()
    up = n.cross(across).normalized()
    points = []
    for k in range(10):
        a = math.pi / 2 + k * math.pi / 5
        r = 0.12 if k % 2 == 0 else 0.05
        points.append(centre + (across * math.cos(a) + up * math.sin(a)) * r)

    def build(bm):
        fill(bm, points)

    star = mesh_object("star", build, gold, smooth=False)
    modifier(star, "SOLIDIFY", thickness=0.03, offset=1.0)
    modifier(star, "BEVEL", width=0.008, segments=3, limit_method="ANGLE")



# --- for telling tasks apart ---------------------------------------------------------------------


def frame_at(p):
    """Axes at a point on the sphere: across, up its meridian, and out of it, as a matrix's columns."""
    n = p.normalized()
    across = Vector((0, 0, 1)).cross(n).normalized()
    return Matrix((across, n.cross(across).normalized(), n)).transposed()


def lean(side=0.0, back=0.0):
    """What a hat's upright turns by: `side` degrees to the viewer's right, `back` away from them."""
    return Euler((math.radians(-back), math.radians(side), 0))


def smooth_profile(points, steps=8):
    return [(p.x, p.y) for p in smooth_path([Vector(q) for q in points], steps)]


def revolve(name, profile, mat, tilt=None, ripple=None, bend=None, sides=128):
    """A surface of revolution about the hat's upright through the body's centre, from (radius,
    height) pairs. Object coordinates run along the upright, so a pattern can follow it. ripple(a)
    scales a ring by its angle; bend(h) moves it sideways by its height."""

    def build(bm):
        layer = bm.loops.layers.uv.new("UVMap")
        rings = []
        for r, h in profile:
            off = bend(h) if bend else Vector((0, 0, 0))
            ring = []
            for k in range(sides):
                a = 2 * math.pi * k / sides
                rr = r * (ripple(a, h) if ripple else 1.0)
                ring.append(bm.verts.new(Vector((rr * math.cos(a), rr * math.sin(a), h)) + off))
            rings.append(ring)
        for at, (lower, upper) in enumerate(zip(rings, rings[1:])):
            for k in range(sides):
                face = bm.faces.new((lower[k], lower[(k + 1) % sides], upper[(k + 1) % sides], upper[k]))
                coords = ((at, k), (at, k + 1), (at + 1, k + 1), (at + 1, k))
                for loop, (u, v) in zip(face.loops, coords):
                    loop[layer].uv = (u / len(profile), v / sides)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    ob = mesh_object(name, build, mat)
    if tilt:
        ob.rotation_euler = tilt
    return ob


def blobs(name, matrices, mat, segments=32):
    """Spheres as one mesh, each a matrix from the unit sphere."""

    def build(bm):
        for m in matrices:
            bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=segments // 2, radius=1.0, matrix=m)

    return mesh_object(name, build, mat)


def ball(p, r):
    return Matrix.Translation(p) @ Matrix.Diagonal((r, r, r, 1.0))


def blade(name, base, along, across, normal, length, width, mat, thickness=0.02, bulge=0.0, curl=0.0, rows=24, cols=12, subdivide=1):
    """A soft flat piece from `base`: `width(t)` either side of its middle at t along its length. It
    domes `bulge` across and bends `curl` toward its normal by its end."""

    def build(bm):
        grid = []
        for i in range(rows + 1):
            t = i / rows
            w = max(width(t), 1e-3)
            row = []
            for j in range(cols + 1):
                s = -1 + 2 * j / cols
                row.append(bm.verts.new(base + along * (length * t) + across * (s * w) + normal * (bulge * (1 - s * s) * w + curl * t * t)))
            grid.append(row)
        for i in range(rows):
            for j in range(cols):
                bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    ob = mesh_object(name, build, mat)
    if thickness:
        modifier(ob, "SOLIDIFY", thickness=thickness, offset=0.0)
    if subdivide:
        modifier(ob, "SUBSURF", levels=subdivide, render_levels=subdivide)
    return ob


def sheen_felt(name, base, roughness=0.85):
    mat = material(name, base, roughness, sheen=0.6, sheen_roughness=0.4, specular=0.3)
    bump(mat, 0.3, 0.003, lambda n, l: weave(n, l, 240.0))
    return mat


GOLD = (0.86, 0.6, 0.18)


def gold(name="gold"):
    return material(name, GOLD, 0.24, metallic=1.0)


def gloss(name, base, roughness=0.22):
    return material(name, base, roughness, coat=0.7, coat_roughness=0.1, specular=0.6)


def party_hat():
    """A paper cone leaning off the left of the head, in bands, with a pompom at its tip."""
    tilt = lean(-33, 6)
    paper = material("party", (0.72, 0.09, 0.14), 0.55, sheen=0.2, specular=0.35)
    nodes, links = paper.node_tree.nodes, paper.node_tree.links
    band = stripes(nodes, links, object_coords(nodes), "Z", 7.4, 0.5, 0.2)
    links.new(mix(nodes, links, band, (0.72, 0.09, 0.14), (0.86, 0.8, 0.62)), bp.principled(paper).inputs["Base Color"])
    revolve("cone", [(0.5, 0.87), (0.38, 1.02), (0.2, 1.22), (0.01, 1.43)], paper, tilt)
    trim = sheen_felt("trim", GOLD)
    rim = revolve("rim", [(0.5, 0.84), (0.535, 0.865), (0.5, 0.895)], trim, tilt)
    for poly in rim.data.polygons:
        poly.use_smooth = True
    pom = sheen_felt("pom", (0.86, 0.72, 0.2), 0.95)
    top = lean(-33, 6).to_matrix() @ Vector((0, 0, 1.45))
    blobs("pom", [ball(top, 0.075)], pom)


def top_hat():
    """A small silk top hat, tipped to the left, with a magenta band."""
    tilt = lean(-15, 8)
    silk = material("silk", (0.022, 0.022, 0.028), 0.22, coat=0.8, coat_roughness=0.12, specular=0.7)
    crown_at = smooth_profile([(0.001, 1.27), (0.24, 1.27), (0.3, 1.255), (0.29, 1.12), (0.3, 1.0)], 8)
    revolve("crown", [*crown_at, (0.34, 0.965), (0.52, 0.955), (0.575, 0.975), (0.585, 0.955), (0.52, 0.925), (0.3, 0.915)], silk, tilt)
    ribbon = material("ribbon", (0.62, 0.03, 0.26), 0.36, sheen=0.5, coat=0.2)
    revolve("ribbon", [(0.303, 1.0), (0.3, 1.085)], ribbon, tilt)


def crown():
    """A gold crown, tipped a little to the left, with a red velvet cap showing through its points."""
    tilt = lean(-8, 10)
    metal = gold("crown")

    def build(bm):
        sides, rows = 240, 12
        grid = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            peak = abs(math.cos(a * 4 + math.pi / 4)) ** 2.6
            top = 0.92 + 0.235 * peak
            row = []
            for j in range(rows + 1):
                h = 0.74 + (top - 0.74) * j / rows
                r = 0.655 + 0.09 * (h - 0.74)
                row.append(bm.verts.new((r * math.cos(a), r * math.sin(a), h)))
            grid.append(row)
        for k in range(sides):
            for j in range(rows):
                bm.faces.new((grid[k][j], grid[(k + 1) % sides][j], grid[(k + 1) % sides][j + 1], grid[k][j + 1]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    ob = mesh_object("crown", build, metal)
    modifier(ob, "SOLIDIFY", thickness=0.03, offset=1.0)
    modifier(ob, "BEVEL", width=0.008, segments=2, limit_method="ANGLE")
    ob.rotation_euler = tilt
    velvet = sheen_felt("velvet", (0.5, 0.03, 0.08))
    cap = smooth_profile([(0.64, 0.76), (0.6, 0.96), (0.36, 1.07), (0.001, 1.1)], 8)
    revolve("velvet", cap, velvet, tilt)
    m = tilt.to_matrix()
    tips, stones = [], []
    for k in range(8):
        a = (2 * k + 1) * math.pi / 8
        tips.append(ball(m @ Vector((0.74 * math.cos(a), 0.74 * math.sin(a), 1.165)), 0.032))
        stones.append(ball(m @ Vector((0.685 * math.cos(a), 0.685 * math.sin(a), 0.815)), 0.036))
    blobs("tips", tips, metal, 24)
    blobs("stones", stones, gloss("stones", (0.5, 0.02, 0.07), 0.1), 24)
    revolve("band", [(0.668, 0.74), (0.682, 0.755), (0.682, 0.775), (0.668, 0.79)], metal, tilt)


WIZARD_CONE = [(0.82, 0.7), (0.76, 0.78), (0.62, 0.9), (0.44, 1.02), (0.22, 1.2), (0.012, 1.33)]


def wizard_hat():
    """A navy felt hat with a bent point, a wide brim, a gold band and stars."""
    tilt = lean(-5, 8)
    felted = sheen_felt("wizard", (0.03, 0.045, 0.24))

    def bend(h):
        k = max(0.0, (h - 0.72) / 0.62)
        return Vector((-0.3 * k * k, 0.0, 0.0))

    def cone_r(h):
        for (r0, h0), (r1, h1) in zip(WIZARD_CONE, WIZARD_CONE[1:]):
            if h0 <= h <= h1:
                return r0 + (r1 - r0) * (h - h0) / (h1 - h0)
        return 0.0

    revolve("cone", smooth_profile(WIZARD_CONE, 10), felted, tilt, bend=bend)
    brim = smooth_profile([(0.78, 0.72), (0.9, 0.69), (1.0, 0.65), (1.07, 0.6), (1.06, 0.585), (0.98, 0.63), (0.78, 0.68)], 6)
    revolve("brim", brim, felted, tilt, ripple=lambda a, h: 1 + 0.018 * math.sin(3 * a + 0.6))
    metal = gold("wizard-gold")
    revolve("band", [(0.836, 0.7), (0.82, 0.74), (0.78, 0.775)], metal, tilt)
    m = tilt.to_matrix()

    def star(name, deg, h, size):
        a = math.radians(deg)
        n = (m @ Vector((math.cos(a), math.sin(a), 0.65))).normalized()
        at = m @ (Vector(((cone_r(h) + 0.012) * math.cos(a), (cone_r(h) + 0.012) * math.sin(a), h)) + bend(h))
        across = Vector((0, 0, 1)).cross(n).normalized()
        up = n.cross(across).normalized()
        points = [at + (across * math.cos(math.pi / 2 + k * math.pi / 5) + up * math.sin(math.pi / 2 + k * math.pi / 5)) * (size if k % 2 == 0 else size * 0.42) for k in range(10)]
        ob = mesh_object(name, lambda bm: fill(bm, points), metal, smooth=False)
        modifier(ob, "SOLIDIFY", thickness=0.012, offset=1.0)

    for i, (deg, h, size) in enumerate(((-104, 0.9, 0.082), (-66, 0.84, 0.056), (-126, 1.06, 0.056))):
        star(f"star{i}", deg, h, size)


def chef_hat():
    """A chef's toque: a starched band and a pleated puff above it."""
    tilt = lean(4, 6)
    cotton = material("toque", (0.86, 0.86, 0.84), 0.62, sheen=0.3, sheen_roughness=0.5)
    bump(cotton, 0.2, 0.003, lambda n, l: weave(n, l, 260.0))
    puff = smooth_profile([(0.7, 0.84), (0.77, 0.92), (0.78, 1.03), (0.7, 1.16), (0.45, 1.25), (0.001, 1.275)], 12)

    def pleats(a, h):
        return 1 + 0.05 * smoothstep(0.84, 0.94, h) * (1 - smoothstep(1.1, 1.25, h)) * math.cos(16 * a)

    revolve("puff", puff, cotton, tilt, ripple=pleats, sides=320)
    band = material("toque-band", (0.9, 0.9, 0.88), 0.55)
    revolve("band", [(0.742, 0.68), (0.752, 0.7), (0.74, 0.84), (0.72, 0.87)], band, tilt)


def hard_hat():
    """A yellow site helmet: a glossy dome with a ridge front to back and a short peak."""
    tilt = lean(0, 6)
    shell_mat = gloss("helmet", (0.93, 0.56, 0.015), 0.3)
    dome = smooth_profile([(0.76, 0.7), (0.74, 0.86), (0.6, 1.02), (0.34, 1.13), (0.001, 1.17)], 10)
    revolve("helmet", dome, shell_mat, tilt)
    outer = smooth_profile([(0.76, 0.7), (0.76, 0.87), (0.62, 1.04), (0.35, 1.15), (0.001, 1.19)], 10)
    m = tilt.to_matrix()
    front = [m @ Vector((0, -r, h)) for r, h in outer[3:]]
    back = [m @ Vector((0, r, h)) for r, h in reversed(outer[3:-1])]
    sweep("ridge", front + back, lambda s: 0.07, lambda s: 0.03, shell_mat, sides=24, cap=True, profile=0.7)

    def build(bm):
        steps_u, steps_v = 96, 8
        grid = []
        for i in range(steps_u + 1):
            a = math.radians(-180 + 360 * i / steps_u)
            cx, cy = math.sin(a), -math.cos(a)
            inner = Vector((0.75 * cx, 0.75 * cy, 0.72))
            forward = max(0.0, math.cos(a))
            out = Vector((cx * 0.8, cy, -0.16)).normalized()
            reach = 0.07 + 0.2 * forward**1.5
            grid.append([bm.verts.new(inner + out * (reach * j / steps_v)) for j in range(steps_v + 1)])
        for i in range(steps_u):
            for j in range(steps_v):
                bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))

    peak = mesh_object("peak", build, shell_mat)
    modifier(peak, "SOLIDIFY", thickness=0.035, offset=0.0)
    modifier(peak, "BEVEL", width=0.014, segments=3, limit_method="ANGLE")
    peak.rotation_euler = tilt


TEAL = (0.012, 0.3, 0.33)


def rib_knit(name, base, ribs_round):
    """Wool knitted in ribs round a revolved piece, darker in the grooves."""
    mat = material(name, base, 0.9, sheen=0.8, sheen_roughness=0.45, specular=0.2)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    sep = nodes.new("ShaderNodeSeparateXYZ")
    links.new(nodes.new("ShaderNodeTexCoord").outputs["UV"], sep.inputs[0])
    phase = nodes.new("ShaderNodeMath")
    phase.operation = "MULTIPLY"
    links.new(sep.outputs["Y"], phase.inputs[0])
    phase.inputs[1].default_value = 2 * math.pi * ribs_round
    wave = nodes.new("ShaderNodeMath")
    wave.operation = "SINE"
    links.new(phase.outputs[0], wave.inputs[0])
    groove = nodes.new("ShaderNodeMath")
    groove.operation = "MULTIPLY_ADD"
    links.new(wave.outputs[0], groove.inputs[0])
    groove.inputs[1].default_value = 0.5
    groove.inputs[2].default_value = 0.5
    links.new(mix(nodes, links, groove.outputs[0], base, (0.45, 0.45, 0.45), "MULTIPLY"), bp.principled(mat).inputs["Base Color"])
    bump(mat, 0.7, 0.008, lambda n, l: wave.outputs[0])
    return mat


def beanie():
    """A ribbed teal beanie with a turned-up cuff and a cream pompom."""
    tilt = lean(-4, 6)
    dome = smooth_profile([(0.85, 0.56), (0.83, 0.7), (0.73, 0.86), (0.54, 1.01), (0.27, 1.1), (0.001, 1.12)], 10)
    revolve("beanie", dome, rib_knit("beanie", TEAL, 54), tilt, sides=320)
    cuff = smooth_profile([(0.875, 0.5), (0.885, 0.53), (0.88, 0.62), (0.85, 0.69), (0.82, 0.71)], 6)
    revolve("cuff", cuff, rib_knit("beanie-cuff", (0.016, 0.36, 0.39), 90), tilt, sides=320)
    pom = material("pompom", (0.84, 0.79, 0.68), 0.95, sheen=1.0, sheen_roughness=0.6, specular=0.15)
    bump(pom, 1.0, 0.03, lambda n, l: weave(n, l, 60.0))
    at = tilt.to_matrix() @ Vector((0, 0, 1.17))

    def build(bm):
        bmesh.ops.create_icosphere(bm, subdivisions=5, radius=0.125, matrix=Matrix.Translation(at))

    ball_of_wool = mesh_object("pompom", build, pom)
    tex = bpy.data.textures.new("fluff", "CLOUDS")
    tex.noise_scale = 0.018
    modifier(ball_of_wool, "DISPLACE", texture=tex, strength=0.03, mid_level=0.5)


def ear(side, lat, az, width, height, felted, inner):
    base = on_body(lat, side * az, -0.03)
    m = bpy.context.scene.camera.matrix_world.to_3x3()
    toward = -(m @ Vector((0, 0, -1)))
    up = (base.normalized() * 0.55 + Vector((side * 0.12, 0, 1)) * 0.75).normalized()
    across = up.cross(toward).normalized()
    normal = across.cross(up).normalized()
    if normal.dot(toward) < 0:
        normal = -normal

    def shape(t):
        return width * (1 - t) ** 0.72 * (1 - 0.16 * math.sin(math.pi * t))

    blade(f"ear{side}", base, up, across, normal, height, shape, felted, thickness=0.05, bulge=0.1, curl=-0.035, rows=24, cols=20, subdivide=2)
    return base + normal * 0.03, up, across, normal, shape


def cat_ears():
    """Soft ginger ears, pink inside."""
    fur = sheen_felt("ears", (0.62, 0.26, 0.05), 0.95)
    inside = sheen_felt("ears-inside", (0.8, 0.32, 0.36), 0.95)
    for side in (-1, 1):
        at, up, across, normal, shape = ear(side, 49.0, 36.0, 0.25, 0.44, fur, inside)
        blade(f"inner{side}", at + up * 0.05, up, across, normal, 0.3, lambda t: 0.62 * shape(t), inside, thickness=0.012, bulge=0.1, curl=-0.03, rows=20, cols=16, subdivide=2)


def sprout():
    """A two-leaf seedling growing from the crown of the head."""
    leaf = material("leaf", (0.13, 0.46, 0.05), 0.42, sheen=0.3, coat=0.25, coat_roughness=0.25)
    bump(leaf, 0.25, 0.006, lambda n, l: ribs(n, l, 70.0))
    stem_mat = material("stem", (0.2, 0.42, 0.08), 0.5)
    root = Vector((0.0, -0.02, 0.97))
    tip = Vector((-0.012, -0.03, 1.12))
    tube("stem", [root, Vector((-0.002, -0.025, 1.05)), tip], stem_mat, 0.017)
    for side, length, rise in ((-1, 0.36, 0.5), (1, 0.31, 0.62)):
        along = Vector((side * 0.86, -0.1, rise)).normalized()
        across = along.cross(Vector((0, -1, 0.15))).normalized()
        normal = across.cross(along).normalized()
        if normal.z < 0:
            normal = -normal
        blade(f"leaf{side}", tip, along, across, normal, length, lambda t: 0.105 * math.sin(math.pi * t**0.8) ** 0.9, leaf, thickness=0.012, bulge=-0.25, curl=-0.07, rows=24, cols=12, subdivide=2)


def flowers(name, places, size, palette):
    """Five-petalled flowers lying on the sphere at the given places, in turn through the palette."""
    petals = {i: [] for i in range(len(palette))}
    hearts = []
    for at, p in enumerate(places):
        turn = frame_at(p).to_4x4()
        spin = at * 0.7
        for k in range(5):
            a = spin + k * 2 * math.pi / 5
            local = Matrix.Translation((math.cos(a) * size * 0.56, math.sin(a) * size * 0.56, size * 0.06)) @ Matrix.Rotation(a, 4, "Z") @ Matrix.Diagonal((size * 0.5, size * 0.36, size * 0.13, 1.0))
            petals[at % len(palette)].append(Matrix.Translation(p) @ turn @ local)
        hearts.append(Matrix.Translation(p) @ turn @ Matrix.Translation((0, 0, size * 0.1)) @ Matrix.Diagonal((size * 0.25, size * 0.25, size * 0.16, 1.0)))
    for i, colour in enumerate(palette):
        blobs(f"{name}-petals{i}", petals[i], material(f"{name}-petal{i}", colour, 0.5, sheen=0.5, sheen_roughness=0.4), 20)
    blobs(f"{name}-hearts", hearts, material(f"{name}-heart", (0.86, 0.56, 0.06), 0.55, sheen=0.3), 16)


LEAVES = (0.08, 0.32, 0.06)


def leaves_along(name, places, length, width):
    mat = material(name, LEAVES, 0.45, coat=0.2)
    for i, (p, angle) in enumerate(places):
        m = frame_at(p)
        across, up, n = m.col[0], m.col[1], m.col[2]
        along = (across * math.cos(angle) + up * math.sin(angle)).normalized()
        side = n.cross(along).normalized()
        blade(f"{name}{i}", p, along, side, n, length, lambda t: width * math.sin(math.pi * t**0.8) ** 0.9, mat, thickness=0.008, bulge=0.15, curl=-0.03, rows=14, cols=8, subdivide=1)


PINKS = ((0.82, 0.16, 0.34), (0.86, 0.74, 0.72), (0.6, 0.2, 0.62), (0.88, 0.42, 0.12))


def flower_crown():
    """A garland of small flowers and leaves round the head, tipped back."""
    tilt = lean(-7, 12).to_matrix()
    seat = 0.74
    r = math.sqrt(1 - seat * seat) + 0.03
    at = lambda deg: tilt @ Vector((r * math.cos(math.radians(deg)), r * math.sin(math.radians(deg)), seat))
    flowers("crown-flowers", [at(deg) for deg in range(-10, 350, 30)], 0.175, PINKS)
    leaves_along("crown-leaf", [(at(deg), math.radians(deg * 3.1)) for deg in range(5, 365, 30)], 0.19, 0.06)


def antenna():
    """A robot's antenna: a steel collar, a spring and a red ball, off to the left of the crown."""
    steel = material("antenna-steel", (0.72, 0.74, 0.77), 0.26, metallic=1.0)
    root = sphere_at(74.0, -90.0, 0.985)
    up = (root.normalized() * 0.4 + Vector((0, 0, 0.9))).normalized()
    bpy.ops.mesh.primitive_cylinder_add(radius=0.075, depth=0.03, location=root + up * 0.018, vertices=48)
    collar = bpy.context.active_object
    collar.rotation_euler = up.to_track_quat("Z", "Y").to_euler()
    collar.data.materials.append(steel)
    modifier(collar, "BEVEL", width=0.008, segments=2)
    bpy.ops.object.shade_smooth()
    m = up.to_track_quat("Z", "Y").to_matrix()
    coil = []
    for k in range(121):
        t = k / 120
        a = t * 2 * math.pi * 4.5
        coil.append(root + m @ Vector((0.04 * math.cos(a), 0.04 * math.sin(a), 0.03 + 0.1 * t)))
    tube("spring", coil, steel, 0.0095)
    top = root + up * 0.2
    tube("rod", [root + up * 0.13, root + up * 0.165, top], steel, 0.0105)
    blobs("bead", [ball(top + up * 0.06, 0.085)], gloss("bead", (0.72, 0.03, 0.03), 0.12))


def halo():
    """A gold ring afloat above the head, tipped toward the viewer."""
    metal = material("halo", (0.95, 0.68, 0.2), 0.2, metallic=1.0)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.5, minor_radius=0.04, location=(0, 0, 1.06), rotation=(math.radians(-18), 0, 0), major_segments=128, minor_segments=24)
    ring = bpy.context.active_object
    ring.data.materials.append(metal)
    ring.visible_shadow = False
    bpy.ops.object.shade_smooth()


def horn(side, bone):
    points = [Vector((side * 0.68, -0.06, 0.76)), Vector((side * 0.84, -0.06, 0.82)), Vector((side * 0.85, -0.06, 0.96)), Vector((side * 0.7, -0.06, 1.15))]
    path = smooth_path(points, 16)
    length = sum((path[i] - path[i - 1]).length for i in range(1, len(path)))
    width = lambda s: 0.092 * (1 - s / length) ** 0.8 + 0.006

    def build(bm):
        rings = []
        for i, c in enumerate(path):
            t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
            n = t.cross(Vector((0, 1, 0))).normalized()
            b = t.cross(n).normalized()
            s = sum((path[k] - path[k - 1]).length for k in range(1, i + 1))
            rings.append([bm.verts.new(c + (n * math.cos(k * 2 * math.pi / 32) + b * math.sin(k * 2 * math.pi / 32)) * width(s)) for k in range(32)])
        for a, b_ in zip(rings, rings[1:]):
            for k in range(32):
                bm.faces.new((a[k], a[(k + 1) % 32], b_[(k + 1) % 32], b_[k]))
        bm.faces.new(rings[-1])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh_object(f"horn{side}", build, bone)


def viking_helmet():
    """A rounded steel helmet with a bronze band and two short horns."""
    steel = material("viking-steel", (0.56, 0.58, 0.6), 0.34, metallic=1.0)
    bump(steel, 0.08, 0.002, lambda n, l: weave(n, l, 120.0))
    edge = 42.0

    def rim(az):
        return edge - 8.0 * (1 - math.cos(math.radians(az))) / 2

    dome = region("viking", rim, lambda az: 89.5, steel, 1.02, 0.03)
    bronze = material("viking-bronze", (0.62, 0.36, 0.13), 0.3, metallic=1.0)
    sweep("band", [sphere_at(rim(az) + 2.2, az, 1.05) for az in range(0, 360, 3)], lambda s: 0.058, lambda s: 0.03, bronze, closed=True, sides=24, profile=0.7)
    ridge = [sphere_at(lat, 0.0, 1.05) for lat in range(int(rim(0)) + 4, 90, 3)] + [sphere_at(90 - k, 180.0, 1.05) for k in range(3, 40, 3)]
    sweep("ridge", ridge, lambda s: 0.04, lambda s: 0.028, bronze, sides=20, cap=True, profile=0.7)
    studs = [ball(sphere_at(rim(az) + 2.2, az, 1.083), 0.016) for az in range(-90, 91, 20)]
    blobs("studs", studs, gold("viking-studs"), 16)
    bone = material("horn", (0.8, 0.7, 0.5), 0.42, coat=0.3, coat_roughness=0.3)
    bump(bone, 0.12, 0.003, lambda n, l: ribs(n, l, 55.0))
    for side in (-1, 1):
        horn(side, bone)


def cowboy_hat():
    """A tan felt cowboy hat with a pinched crown and a brim rolled up at the sides."""
    felted = sheen_felt("cowboy", (0.42, 0.24, 0.1))
    tilt = lean(-4, 7)
    m = tilt.to_matrix()

    def build(bm):
        sides, rows = 180, 24
        grid = []
        for i in range(rows + 1):
            t = i / rows
            r = 0.7 - 0.2 * t**1.6
            for_h = 0.74 + 0.5 * t
            row = []
            for k in range(sides):
                a = 2 * math.pi * k / sides
                x, y = r * math.cos(a), r * math.sin(a)
                # The pinch down the crown's top and in at its front.
                crease = math.exp(-((x / 0.2) ** 2)) * t**3
                z = for_h - 0.1 * crease + 0.04 * t * math.sin(a) * (1 - crease)
                row.append(bm.verts.new((x * (1 - 0.1 * t), y * (1 + 0.04 * t), z)))
            grid.append(row)
        for i in range(rows):
            for k in range(sides):
                bm.faces.new((grid[i][k], grid[i][(k + 1) % sides], grid[i + 1][(k + 1) % sides], grid[i + 1][k]))
        centre = bm.verts.new((0, 0, 1.13))
        for k in range(sides):
            bm.faces.new((grid[rows][k], grid[rows][(k + 1) % sides], centre))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    crown_ob = mesh_object("crown", build, felted)
    crown_ob.rotation_euler = tilt

    def brim(bm):
        sides, rows = 180, 14
        grid = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            cx, cy = math.cos(a), math.sin(a)
            reach = 0.92 + 0.06 * cx * cx
            row = []
            for j in range(rows + 1):
                t = j / rows
                r = 0.68 + (reach - 0.68) * t
                h = 0.72 + 0.18 * cx * cx * t * t - 0.07 * cy * cy * t
                row.append(bm.verts.new((r * cx, r * cy, h)))
            grid.append(row)
        for k in range(sides):
            for j in range(rows):
                bm.faces.new((grid[k][j], grid[(k + 1) % sides][j], grid[(k + 1) % sides][j + 1], grid[k][j + 1]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    brim_ob = mesh_object("brim", brim, felted)
    modifier(brim_ob, "SOLIDIFY", thickness=0.035, offset=0.0)
    modifier(brim_ob, "BEVEL", width=0.014, segments=3, limit_method="ANGLE")
    brim_ob.rotation_euler = tilt
    leather = material("hatband", (0.05, 0.02, 0.012), 0.4, coat=0.2)
    revolve("hatband", [(0.706, 0.75), (0.7, 0.76), (0.684, 0.83), (0.668, 0.838)], leather, tilt, sides=180)
    buckle = gold("buckle")
    at = m @ Vector((0.0, -0.71, 0.795))
    blobs("buckle", [Matrix.Translation(at) @ Matrix.Diagonal((0.05, 0.016, 0.04, 1.0))], buckle, 24)


def propeller_cap():
    """A beanie of four coloured panels with a small peak and a propeller on top."""
    red, yellow, blue = (0.66, 0.05, 0.05), (0.88, 0.56, 0.02), (0.02, 0.16, 0.56)
    cloth = material("propeller-cap", red, 0.72, sheen=0.4, sheen_roughness=0.45)
    nodes, links = cloth.node_tree.nodes, cloth.node_tree.links
    bump(cloth, 0.15, 0.003, lambda n, l: weave(n, l, 260.0))
    sep = nodes.new("ShaderNodeSeparateXYZ")
    links.new(object_coords(nodes), sep.inputs[0])
    right = nodes.new("ShaderNodeMath")
    right.operation = "GREATER_THAN"
    left = nodes.new("ShaderNodeMath")
    left.operation = "LESS_THAN"
    add = nodes.new("ShaderNodeMath")
    add.operation = "ADD"
    sub = nodes.new("ShaderNodeMath")
    sub.operation = "SUBTRACT"
    links.new(sep.outputs["X"], add.inputs[0])
    links.new(sep.outputs["Y"], add.inputs[1])
    links.new(sep.outputs["X"], sub.inputs[0])
    links.new(sep.outputs["Y"], sub.inputs[1])
    # Seen from the front the middle panel is red, with blue to its left and yellow to its right.
    links.new(sub.outputs[0], right.inputs[0])
    right.inputs[1].default_value = 0.0
    links.new(add.outputs[0], left.inputs[0])
    left.inputs[1].default_value = 0.0
    both = mix(nodes, links, right.outputs[0], blue, red)
    links.new(mix(nodes, links, left.outputs[0], yellow, both), bp.principled(cloth).inputs["Base Color"])
    dome = region("propeller-cap", cap_rim, lambda az: 89.5, cloth, 1.012, 0.03, rows=48)
    for v in dome.data.vertices:
        lat = math.degrees(math.asin(max(-1.0, min(1.0, v.co.z / v.co.length))))
        v.co += v.co.normalized() * 0.05 * math.sin(math.pi * max(0.0, min(1.0, (lat - 38.0) / 52.0)))
    peak = material("propeller-peak", blue, 0.7, sheen=0.3)
    cap_brim(peak)
    steel = material("propeller-steel", (0.74, 0.76, 0.78), 0.25, metallic=1.0)
    tube("spindle", [Vector((0, 0, 1.04)), Vector((0, 0, 1.13)), Vector((0, 0, 1.2))], steel, 0.016)
    blobs("hub", [Matrix.Translation((0, 0, 1.2)) @ Matrix.Diagonal((0.034, 0.034, 0.024, 1.0))], steel, 24)
    vane = material("propeller-vane", (0.8, 0.8, 0.78), 0.3, coat=0.5)
    for side in (-1, 1):
        along = Vector((side, -0.25, 0.02)).normalized()
        across = Vector((0.25 * side, side, -0.28 * side)).normalized()
        normal = along.cross(across).normalized()
        blade(f"vane{side}", Vector((0, 0, 1.2)), along, across, normal, 0.36, lambda t: 0.024 + 0.05 * math.sin(math.pi * min(1.0, t * 1.02)) ** 0.7, vane, thickness=0.012, rows=16, cols=6, subdivide=2)


def headband():
    """A terry sweatband round the forehead, coral with a white stripe, tied at the left."""
    coral = (0.76, 0.14, 0.11)
    terry = material("headband", coral, 0.92, sheen=0.7, sheen_roughness=0.5, specular=0.2)
    nodes, links = terry.node_tree.nodes, terry.node_tree.links
    bump(terry, 0.5, 0.006, lambda n, l: weave(n, l, 190.0))
    low = lambda az: 37.0 - 7.0 * (1 - math.cos(math.radians(az))) / 2
    high = lambda az: low(az) + 16.5
    band = stripes(nodes, links, object_coords(nodes), "Z", 1.0, 0.055, 0.285)
    links.new(mix(nodes, links, band, coral, (0.86, 0.85, 0.82)), bp.principled(terry).inputs["Base Color"])
    region("headband", low, high, terry, 1.012, 0.03)
    tail = material("headband-tail", coral, 0.9, sheen=0.7, sheen_roughness=0.5, specular=0.2)
    knot_at = sphere_at(40.0, -72.0, 1.06)
    blobs("knot", [Matrix.Translation(knot_at) @ frame_at(knot_at).to_4x4() @ Matrix.Diagonal((0.075, 0.09, 0.05, 1.0))], tail)
    for i, (drop, out) in enumerate(((1.0, 0.72), (1.0, 0.28))):
        along = Vector((-out, -0.08, -drop)).normalized()
        across = along.cross(knot_at.normalized()).normalized()
        blade(f"tail{i}", knot_at, along, across, knot_at.normalized(), 0.46 - 0.08 * i, lambda t: 0.052 + 0.02 * t, tail, thickness=0.012, curl=0.02, rows=20, cols=6, subdivide=1)


def monocle():
    """A gold-rimmed lens over dot's right eye, with a fine chain falling off to its side."""
    metal = gold("monocle")
    lens = material("monocle-lens", (0.92, 0.96, 1.0), 0.02, transmission=1.0, ior=1.45, specular=0.6)
    centre = eye_point(1, 0.07)
    frame_shape("rim", centre, 6.3 * U, 6.3 * U, 6.3 * U, metal, 0.018, lens)
    bpy.data.objects["rim-lens"].visible_shadow = False
    m = bpy.context.scene.camera.matrix_world.to_3x3()
    rt, up = m @ Vector((1, 0, 0)), m @ Vector((0, 1, 0))
    start = centre + rt * (6.3 * U * 0.7) - up * (6.3 * U * 0.7)
    points = [start]
    for x, y in ((44.8, 36.5), (47.0, 41.0), (49.0, 46.0), (52.5, 49.0)):
        points.append(toward_camera(on_sphere(x, y, 1.004), 0.004))
    tube("chain", smooth_path(points, 10), metal, 0.0055)


def heart_outline(centre, rt, up, size, steps=64):
    points = []
    for k in range(steps):
        t = 2 * math.pi * k / steps
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        points.append(centre + rt * (x / 16 * size * U) + up * ((y + 2.0) / 16 * size * U))
    return points


def heart_glasses():
    """Heart-shaped glasses in glossy pink, tinted so dot's eyes still show through them."""
    frame_mat = gloss("hearts-frame", (0.8, 0.07, 0.34), 0.2)
    tint = material("hearts-lens", (0.86, 0.14, 0.42), 0.05, coat=1.0, coat_roughness=0.02, specular=0.8, alpha=0.4)
    m = bpy.context.scene.camera.matrix_world.to_3x3()
    rt, up = m @ Vector((1, 0, 0)), m @ Vector((0, 1, 0))
    centres = []
    for i, x in enumerate((25.2, 38.8)):
        centre = toward_camera(on_sphere(x, 27.4), 0.075)
        centres.append(centre)
        outline = heart_outline(centre, rt, up, 6.6)
        tube(f"rim{i}", [*outline, outline[0]], frame_mat, 0.026)
        lens = mesh_object(f"lens{i}", lambda bm, outline=outline: bm.faces.new([bm.verts.new(p) for p in outline]), tint)
        lens.visible_shadow = False
    a, b = centres[0] + rt * (5.9 * U) + up * (2.1 * U), centres[1] - rt * (5.9 * U) + up * (2.1 * U)
    tube("bridge", [a, (a + b) / 2 + up * (0.9 * U), b], frame_mat, 0.022)


def clown_nose():
    """A round, shiny red nose."""
    at = toward_camera(on_sphere(32.0, 34.0), 0.075)
    blobs("nose", [ball(at, 0.17)], gloss("nose", (0.72, 0.025, 0.03), 0.14), 48)


def blush():
    """Soft pink cheeks, under the eyes, that fade out at their edges."""
    mat = bpy.data.materials.new("blush")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = bp.principled(mat)
    bp.set_input(bsdf, ["Base Color"], (0.9, 0.16, 0.24, 1.0))
    bp.set_input(bsdf, ["Roughness"], 0.7)
    uv = nodes.new("ShaderNodeTexCoord").outputs["UV"]
    length = nodes.new("ShaderNodeVectorMath")
    length.operation = "LENGTH"
    links.new(uv, length.inputs[0])
    ramp = nodes.new("ShaderNodeMapRange")
    ramp.interpolation_type = "SMOOTHERSTEP"
    ramp.inputs["From Min"].default_value = 0.15
    ramp.inputs["From Max"].default_value = 1.0
    ramp.inputs["To Min"].default_value = 0.62
    ramp.inputs["To Max"].default_value = 0.0
    links.new(length.outputs["Value"], ramp.inputs["Value"])
    bp.set_input(bsdf, ["Alpha"], 1.0)
    links.new(ramp.outputs["Result"], bsdf.inputs["Alpha"])

    def build(bm, x, y):
        layer = bm.loops.layers.uv.new("UVMap")
        rows = 24
        grid = []
        for i in range(rows + 1):
            row = []
            for j in range(rows + 1):
                u, v = -1 + 2 * i / rows, -1 + 2 * j / rows
                row.append((bm.verts.new(on_sphere(x + u * 5.8, y + v * 3.9, 1.003)), (u, v)))
            grid.append(row)
        for i in range(rows):
            for j in range(rows):
                corners = (grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1])
                face = bm.faces.new([v for v, _ in corners])
                for loop, (_, coord) in zip(face.loops, corners):
                    loop[layer].uv = coord

    for side, x in ((0, 20.8), (1, 43.2)):
        ob = mesh_object(f"cheek{side}", lambda bm, x=x: build(bm, x, 36.0), mat)
        ob.visible_shadow = False


def bow_tie():
    """A purple satin bow tie at the neck."""
    satin = material("bow-tie", (0.19, 0.03, 0.42), 0.3, sheen=0.5, sheen_roughness=0.3, coat=0.35, coat_roughness=0.2)
    centre = on_body(-21.0, 0.0, 0.06)
    m = frame_at(centre)
    across, up, n = m.col[0], m.col[1], m.col[2]
    for side in (-1, 1):
        along = across * side + up * 0.02
        blade(f"wing{side}", centre - n * 0.01, along.normalized(), up, n, 0.3, lambda t: (0.042 + 0.13 * t**0.75) * math.sqrt(max(0.0, 1 - t**9)), satin, thickness=0.05, bulge=0.32, curl=-0.03, rows=24, cols=14, subdivide=2)
    blobs("knot", [Matrix.Translation(centre + n * 0.038) @ m.to_4x4() @ Matrix.Diagonal((0.056, 0.066, 0.045, 1.0))], satin)


def medal():
    """A gold medal on a striped ribbon round the neck."""
    red = material("ribbon-red", (0.62, 0.04, 0.05), 0.42, sheen=0.5, sheen_roughness=0.35)
    white = material("ribbon-white", (0.85, 0.85, 0.82), 0.45, sheen=0.4)
    hang = -36.0
    for side in (-1, 1):
        lats = [-6.0 + (hang + 6.0) * k / 16 for k in range(17)]
        azs = [side * (40.0 - 38.0 * ((lat + 6.0) / (hang + 6.0)) ** 0.85) for lat in lats]
        path = [sphere_at(lat, az, 1.006) for lat, az in zip(lats, azs)]
        sweep(f"strap{side}", path, lambda s: 0.058, lambda s: 0.01, red, sides=16, cap=True, profile=0.5)
        path = [sphere_at(lat, az, 1.016) for lat, az in zip(lats, azs)]
        sweep(f"stripe{side}", path, lambda s: 0.02, lambda s: 0.006, white, sides=12, cap=True, profile=0.5)
    metal = gold("medal")
    at = on_body(hang - 8.5, 0.0, 0.03)
    n = at.normalized()
    bpy.ops.mesh.primitive_cylinder_add(radius=0.135, depth=0.032, location=at, vertices=96)
    disc = bpy.context.active_object
    disc.rotation_euler = n.to_track_quat("Z", "Y").to_euler()
    disc.data.materials.append(metal)
    modifier(disc, "BEVEL", width=0.012, segments=4)
    bpy.ops.object.shade_smooth()
    m = frame_at(at)
    across, up = m.col[0], m.col[1]
    points = [at + n * 0.018 + (across * math.cos(math.pi / 2 + k * math.pi / 5) + up * math.sin(math.pi / 2 + k * math.pi / 5)) * (0.082 if k % 2 == 0 else 0.034) for k in range(10)]
    star = mesh_object("medal-star", lambda bm: fill(bm, points), material("medal-star", (0.62, 0.38, 0.08), 0.3, metallic=1.0), smooth=False)
    modifier(star, "SOLIDIFY", thickness=0.012, offset=1.0)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.026, minor_radius=0.008, location=on_body(hang - 0.4, 0.0, 0.034), rotation=(math.radians(90), 0, 0), major_segments=24, minor_segments=8)
    loop = bpy.context.active_object
    loop.data.materials.append(metal)
    bpy.ops.object.shade_smooth()


def neck_dip(az, top, depth, width=62.0):
    return top - depth * math.exp(-((az / width) ** 2))


def pearls():
    """A strand of pearls round the neck with a ruby drop."""
    pearl = material("pearl", (0.84, 0.81, 0.76), 0.2, coat=1.0, coat_roughness=0.06, specular=0.7, sheen=0.3)
    size = 0.046
    points = []
    az = -112.0
    while az <= 112.0:
        lat = neck_dip(az, -8.0, 34.0)
        p = sphere_at(lat, az, 1.0 + size * 0.75)
        points.append(ball(p, size))
        lat2 = neck_dip(az + 1.0, -8.0, 34.0)
        step = (sphere_at(lat2, az + 1.0, 1.0) - sphere_at(lat, az, 1.0)).length
        az += 2.05 * size / step
    blobs("pearls", points, pearl, 32)
    drop = on_body(neck_dip(0, -8.0, 34.0) - 9.0, 0.0, 0.045)
    ruby = gloss("ruby", (0.55, 0.012, 0.07), 0.08)
    m = frame_at(drop)
    blobs("ruby", [Matrix.Translation(drop) @ m.to_4x4() @ Matrix.Diagonal((0.058, 0.08, 0.04, 1.0))], ruby, 40)





def striped_tee():
    """A navy and cream striped jersey with a ribbed collar."""
    cream, navy = (0.84, 0.81, 0.72), (0.02, 0.05, 0.2)
    cloth = material("tee", cream, 0.82, sheen=0.5, sheen_roughness=0.5, specular=0.2)
    nodes, links = cloth.node_tree.nodes, cloth.node_tree.links
    bump(cloth, 0.2, 0.003, lambda n, l: weave(n, l, 280.0))
    band = stripes(nodes, links, object_coords(nodes), "Z", 7.0, 0.46, 0.08)
    links.new(mix(nodes, links, band, cream, navy), bp.principled(cloth).inputs["Base Color"])

    def neck(az):
        a = abs((az + 180.0) % 360.0 - 180.0)
        return -11.0 - 12.0 * math.exp(-((a / 40.0) ** 2)) + 6.0 * smoothstep(90.0, 180.0, a)

    body = region("tee", lambda az: -89.0, neck, cloth, 1.02, 0.025)
    for v in body.data.vertices:
        lat = math.degrees(math.asin(max(-1.0, min(1.0, v.co.z / v.co.length))))
        az = math.degrees(math.atan2(v.co.x, -v.co.y))
        below = neck(az) - lat
        v.co += v.co.normalized() * 0.008 * smoothstep(8.0, 30.0, below) * math.sin(math.radians(5.0 * az) + 0.8)
    rib = heather("tee-collar", (0.015, 0.035, 0.15), (0.03, 0.06, 0.24), 0.35, ribs=70.0)
    sweep("collar", [sphere_at(neck(az), az, 1.006) for az in range(0, 360, 3)], lambda s: 0.03, lambda s: 0.042, rib, closed=True, sides=24, profile=1.0)


def overalls():
    """Denim dungarees: a bib and two straps over the shoulders, with brass buttons and stitching."""
    denim = material("denim", (0.035, 0.11, 0.3), 0.85, sheen=0.3, sheen_roughness=0.5, specular=0.25)
    bump(denim, 0.35, 0.003, lambda n, l: ribs(n, l, 180.0))
    hip = -37.0

    def waist(az):
        return hip + 2.0 * math.sin(math.radians(az))**2

    region("overalls", lambda az: -89.0, waist, denim, 1.018, 0.024)
    bib_top, bib_half = -13.0, 25.0

    def bib_high(az):
        a = abs((az + 180.0) % 360.0 - 180.0)
        if a >= bib_half + 7.0:
            return waist(az) + 0.0
        return waist(az) + (bib_top - waist(az)) * (1 - smoothstep(bib_half - 4.0, bib_half + 7.0, a))

    bib = region("bib", lambda az: waist(az) - 1.0, bib_high, denim, 1.021, 0.022, step=1.0)
    stitch = material("stitch", (0.68, 0.38, 0.08), 0.6)
    edge = [sphere_at(bib_top - 2.0, az, 1.046) for az in range(-int(bib_half) + 2, int(bib_half) - 1, 2)]
    tube("bib-stitch", edge, stitch, 0.0038)
    waist_line = [sphere_at(waist(az) - 1.3, az, 1.044) for az in range(-180, 181, 3)]
    tube("waist-stitch", waist_line, stitch, 0.0038)
    pocket = [sphere_at(-20.0, -11.0, 1.05), sphere_at(-20.0, 11.0, 1.05), sphere_at(-31.0, 9.0, 1.05), sphere_at(-34.5, 0.0, 1.05), sphere_at(-31.0, -9.0, 1.05)]
    points = []
    for a, b in zip(pocket, pocket[1:] + pocket[:1]):
        points.extend(a.lerp(b, k / 8).normalized() * 1.05 for k in range(8))
    tube("pocket", [*points, points[0]], stitch, 0.0034)
    brass = material("brass", (0.78, 0.52, 0.16), 0.28, metallic=1.0)
    for side in (-1, 1):
        lats = [bib_top - 1.0 + (42.0 - bib_top) * k / 20 for k in range(21)]
        azs = [side * (bib_half - 7.0 + 62.0 * (k / 20) ** 1.3) for k in range(21)]
        path = [sphere_at(lat, az, 1.022) for lat, az in zip(lats, azs)]
        sweep(f"strap{side}", path, lambda s: 0.058, lambda s: 0.016, denim, sides=16, cap=True, profile=0.5)
        at = on_body(bib_top - 2.5, side * (bib_half - 7.0), 0.055)
        bpy.ops.mesh.primitive_cylinder_add(radius=0.032, depth=0.016, location=at, vertices=32)
        button = bpy.context.active_object
        button.rotation_euler = at.to_track_quat("Z", "Y").to_euler()
        button.data.materials.append(brass)
        modifier(button, "BEVEL", width=0.006, segments=2)
        bpy.ops.object.shade_smooth()


def lei():
    """A garland of tropical flowers round the neck."""
    colours = ((0.86, 0.3, 0.04), (0.8, 0.09, 0.28), (0.9, 0.62, 0.05), (0.45, 0.1, 0.6))
    places = []
    az = -116.0
    while az <= 116.0:
        places.append(sphere_at(neck_dip(az, -9.0, 22.0, 72.0), az, 1.03))
        az += 17.0
    flowers("lei", places, 0.135, colours)
    leaves_along("lei-leaf", [(sphere_at(neck_dip(a + 8.5, -9.0, 22.0, 72.0), a + 8.5, 1.015), math.radians(a * 7.0)) for a in range(-116, 116, 17)], 0.15, 0.048)


WEARABLES = {
    "hoodie": hoodie,
    "cap": cap,
    "sunglasses": sunglasses,
    "bow": bow,
    "star-pin": star_pin,
    "round-glasses": glasses_round,
    "mustache": mustache,
    "suit": suit,
    "scarf": scarf,
    "headphones": headphones,
    "mortarboard": mortarboard,
    "beret": beret,
    "beanie": beanie,
    "party-hat": party_hat,
    "crown": crown,
    "wizard-hat": wizard_hat,
    "top-hat": top_hat,
    "chef-hat": chef_hat,
    "hard-hat": hard_hat,
    "sprout": sprout,
    "flower-crown": flower_crown,
    "antenna": antenna,
    "cat-ears": cat_ears,
    "halo": halo,
    "viking-helmet": viking_helmet,
    "cowboy-hat": cowboy_hat,
    "propeller-cap": propeller_cap,
    "headband": headband,
    "monocle": monocle,
    "heart-glasses": heart_glasses,
    "clown-nose": clown_nose,
    "blush": blush,
    "bow-tie": bow_tie,
    "medal": medal,
    "pearls": pearls,
    "striped-tee": striped_tee,
    "overalls": overalls,
    "lei": lei,
}


def clear_wearables(keep):
    for ob in list(bpy.context.scene.objects):
        if ob.name not in keep and ob.type not in {"CAMERA", "LIGHT"}:
            bpy.data.objects.remove(ob, do_unlink=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--res", type=int, default=1024)
    ap.add_argument("--samples", type=int, default=384)
    ap.add_argument("--only", default=",".join(WEARABLES))
    ap.add_argument("--cfg", default=os.path.join(HERE, "plates.json"))
    args = ap.parse_args(argv)
    with open(args.cfg) as fh:
        cfg = json.load(fh)
    os.makedirs(args.out, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bp.setup_render(args.res, args.samples)
    bpy.context.scene.cycles.film_transparent_glass = True
    bp.make_world(cfg["world"])
    body = bp.make_body(cfg)
    body.is_shadow_catcher = True
    bp.make_camera(cfg)
    # Projection reads the camera's world matrix, which Blender computes only on an update.
    bpy.context.view_layer.update()
    bp.rig(cfg, "neutral")
    keep = {body.name}
    for name in [n.strip() for n in args.only.split(",") if n.strip()]:
        clear_wearables(keep)
        WEARABLES[name]()
        bp.render_to(os.path.join(args.out, f"wear-{name}.png"))


if __name__ == "__main__":
    main()
