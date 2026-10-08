"""Render dot's body plates headless with Blender (5.1).

Blender --background --factory-startup --python build_plates.py -- --out DIR [--res 1024]
    [--samples 512] [--only neutral,xenon,dim,shadow] [--cfg plates.json] [--blend FILE]

Geometry contract with apps/web/src/dot: the frame is the dot's 64-unit viewBox and the body is a
sphere of radius 24 centred at (32, 32). The camera is orthographic, so the sphere projects to an
exact circle from any elevation; it looks down elevation_deg so the floor under the body reads as an
ellipse near y 59, where the contact shadow sits.
"""

import argparse
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

U = 1.0 / 24.0  # one frame unit in Blender units (body radius = 1)
HERE = os.path.dirname(os.path.abspath(__file__))


def deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


def set_input(node, names, value):
    # Principled BSDF socket names changed across Blender versions; take the first that exists.
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return


def principled(mat):
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def setup_render(res, samples):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    try:
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = "GPU"
    except Exception as exc:  # CPU fallback keeps the script portable
        print("GPU unavailable, using CPU:", exc)
    sc.cycles.samples = samples
    sc.cycles.use_adaptive_sampling = False
    sc.cycles.seed = 7
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 8
    sc.render.film_transparent = True
    sc.render.filter_size = 1.2
    sc.render.resolution_x = res
    sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    transforms = [
        i.identifier
        for i in bpy.types.ColorManagedViewSettings.bl_rna.properties["view_transform"].enum_items
    ]
    # Khronos PBR Neutral keeps the base colour faithful; older builds fall back to AgX.
    try:
        sc.view_settings.view_transform = "Khronos PBR Neutral"
    except TypeError:
        sc.view_settings.view_transform = "AgX" if "AgX" in transforms else "Standard"
    sc.view_settings.look = "None"
    sc.view_settings.exposure = 0.0
    sc.view_settings.gamma = 1.0
    sc.render.dither_intensity = 1.0
    st = sc.render.image_settings
    st.file_format = "PNG"
    st.color_mode = "RGBA"
    st.color_depth = "16"
    st.compression = 15


def make_world(color):
    w = bpy.data.worlds.new("void")
    w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (*color, 1.0)
    bg.inputs[1].default_value = 1.0
    bpy.context.scene.world = w
    return bg


def icosphere(name, radius, subdivisions):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=radius)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def make_body(cfg):
    ob = icosphere("body", 1.0, 6)
    mat = bpy.data.materials.new("porcelain")
    mat.use_nodes = True
    bsdf = principled(mat)
    b = cfg["body"]
    set_input(bsdf, ["Base Color"], (*b["base"], 1.0))
    set_input(bsdf, ["Roughness"], b["roughness"])
    set_input(bsdf, ["Subsurface Weight", "Subsurface"], b["subsurface"])
    set_input(bsdf, ["Subsurface Radius"], tuple(b["subsurface_radius"]))
    set_input(bsdf, ["Subsurface Scale"], b["subsurface_scale"])
    set_input(bsdf, ["Coat Weight"], b["coat"])
    set_input(bsdf, ["Coat Roughness"], b["coat_roughness"])
    set_input(bsdf, ["Sheen Weight"], b["sheen"])
    set_input(bsdf, ["Specular IOR Level"], b["specular_level"])
    ob.data.materials.append(mat)
    return ob


def make_floor(cfg):
    me = bpy.data.meshes.new("floor")
    s = 40.0
    me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new("floor", me)
    ob.location = (0, 0, -(24.0 + cfg["hover_units"]) * U)
    ob.visible_camera = False
    bpy.context.scene.collection.objects.link(ob)
    mat = bpy.data.materials.new("floor")
    mat.use_nodes = True
    bsdf = principled(mat)
    a = cfg["floor"]["albedo"]
    set_input(bsdf, ["Base Color"], (a, a, a, 1.0))
    set_input(bsdf, ["Roughness"], 0.9)
    set_input(bsdf, ["Specular IOR Level"], 0.0)
    me.materials.append(mat)
    return ob


def make_shadow_proxy(cfg):
    # A smaller hidden sphere whose bottom matches the body's casts the contact shadow, so it is a
    # soft core rather than the full footprint.
    r = cfg["floor"]["proxy_radius"]
    ob = icosphere("shadow_proxy", r, 5)
    ob.location = (0, 0, -1.0 + r)
    ob.visible_camera = False
    ob.hide_render = True
    return ob


def make_camera(cfg):
    cam = bpy.data.cameras.new("cam")
    cam.type = "ORTHO"
    cam.ortho_scale = 64.0 * U
    cam.clip_start = 0.1
    cam.clip_end = 100
    ob = bpy.data.objects.new("cam", cam)
    bpy.context.scene.collection.objects.link(ob)
    e = math.radians(cfg["elevation_deg"])
    ob.location = (0.0, -20.0 * math.cos(e), 20.0 * math.sin(e))
    ob.rotation_euler = (Vector((0, 0, 0)) - ob.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = ob


def make_area(name, spec):
    li = bpy.data.lights.new(name, type="AREA")
    li.shape = "RECTANGLE"
    li.size = spec["size"][0]
    li.size_y = spec["size"][1]
    li.energy = spec["power"]
    li.color = tuple(spec.get("color", [1, 1, 1]))
    ob = bpy.data.objects.new(name, li)
    ob.location = tuple(spec["loc"])
    ob.rotation_euler = (Vector((0, 0, 0)) - ob.location).to_track_quat("-Z", "Y").to_euler()
    ob.visible_camera = False
    bpy.context.scene.collection.objects.link(ob)


def clear_lights():
    for ob in [o for o in bpy.context.scene.objects if o.type == "LIGHT"]:
        bpy.data.objects.remove(ob, do_unlink=True)


def rig(cfg, variant):
    clear_lights()
    lights = deep_merge(json.loads(json.dumps(cfg["lights"])), cfg["variants"].get(variant, {}))
    for name, spec in lights.items():
        if spec.get("power", 0) > 0:
            make_area(name, spec)


def render_to(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("wrote", path)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--res", type=int, default=1024)
    ap.add_argument("--samples", type=int, default=512)
    ap.add_argument("--only", default="neutral,xenon,dim,shadow")
    ap.add_argument("--cfg", default=os.path.join(HERE, "plates.json"))
    ap.add_argument("--blend", default=None)
    args = ap.parse_args(argv)
    with open(args.cfg) as fh:
        cfg = json.load(fh)
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    os.makedirs(args.out, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    setup_render(args.res, args.samples)
    world = make_world(cfg["world"])
    body = make_body(cfg)
    floor = make_floor(cfg)
    make_camera(cfg)

    for variant in ["neutral", "xenon", "dim"]:
        if variant in only:
            rig(cfg, variant)
            render_to(os.path.join(args.out, f"body-{variant}.png"))

    proxy = make_shadow_proxy(cfg)
    if "shadow" in only:
        # Ambient occlusion from a uniform white sky onto a shadow catcher.
        clear_lights()
        world.inputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
        body.hide_render = True
        proxy.hide_render = False
        floor.visible_camera = True
        floor.is_shadow_catcher = True
        render_to(os.path.join(args.out, "shadow.png"))
        world.inputs[0].default_value = (*cfg["world"], 1.0)
        body.hide_render = False
        proxy.hide_render = True
        floor.visible_camera = False
        floor.is_shadow_catcher = False

    if args.blend:
        rig(cfg, "neutral")
        bpy.ops.wm.save_as_mainfile(filepath=args.blend)
        print("saved", args.blend)


main()
