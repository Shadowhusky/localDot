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
