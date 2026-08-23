"""
art/preview.py — render reference images of the alien.

    blender --background art/alien.blend --python art/preview.py

Renders into art/preview/:
    profile.png       side-on, flat lit — the silhouette read, which per §9 is
                      the only read the player reliably gets
    threequarter.png  3/4 lit, so you can judge the anatomy
    ingame.png        one spot from the camera, black world, fog — roughly what
                      a flashlight in a dark module actually shows you
    pose_hunt.png     mid-hunt pose, to check the gait reads at speed
"""

import math
import os

import bpy
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "art", "preview")
os.makedirs(OUT, exist_ok=True)

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.render.resolution_x = 1100
scene.render.resolution_y = 700
scene.render.film_transparent = False
scene.eevee.taa_render_samples = 48

rig = bpy.data.objects.get("AlienRig")
target = Vector((0.0, 0.0, 0.72))


def clear_lights():
    for o in list(bpy.data.objects):
        if o.type in {"LIGHT", "CAMERA"}:
            bpy.data.objects.remove(o, do_unlink=True)


def add_camera(location, look_at=target, lens=52):
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = lens
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = Vector(location)
    direction = look_at - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    return cam


def add_light(kind, location, energy, look_at=target, size=3.0, angle=45.0):
    data = bpy.data.lights.new("l", type=kind)
    data.energy = energy
    if kind == "AREA":
        data.size = size
    if kind == "SPOT":
        data.spot_size = math.radians(angle)
        data.spot_blend = 0.5
        data.shadow_soft_size = 0.08
    light = bpy.data.objects.new("l", data)
    bpy.context.collection.objects.link(light)
    light.location = Vector(location)
    d = look_at - light.location
    light.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return light


def world(color, strength):
    w = bpy.data.worlds.new("w") if scene.world is None else scene.world
    scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (*color, 1.0)
    bg.inputs[1].default_value = strength


def backdrop():
    """A floor and a back wall so the silhouette has something to sit against."""
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
    floor = bpy.context.object
    m = bpy.data.materials.new("floor")
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.05, 0.055, 0.06, 1)
    b.inputs["Roughness"].default_value = 0.9
    floor.data.materials.append(m)
    return floor


def pose(action_name, frame):
    if rig is None:
        return
    act = bpy.data.actions.get(action_name)
    if act is None:
        return
    if rig.animation_data is None:
        rig.animation_data_create()
    for track in rig.animation_data.nla_tracks:
        track.mute = True
    rig.animation_data.action = act
    scene.frame_set(frame)


def render(name):
    scene.render.filepath = os.path.join(OUT, name)
    bpy.ops.render.render(write_still=True)
    print("RENDERED", name)


# ------------------------------------------------------------------- profile
# Flat, bright, side-on. This is the silhouette test: if the creature does not
# read here, it will never read in a dark corridor.
clear_lights()
backdrop()
world((0.5, 0.52, 0.55), 1.1)
pose("idle_listen", 1)
add_camera((8.2, 0.0, 0.95), lens=55)
add_light("AREA", (3.0, -4.0, 4.0), 900, size=6)
add_light("AREA", (-4.0, 3.0, 2.5), 260, size=6)
render("profile.png")

# -------------------------------------------------------------- three-quarter
clear_lights()
world((0.16, 0.17, 0.2), 0.7)
pose("prowl", 9)
add_camera((4.6, -4.4, 2.0), lens=50)
add_light("AREA", (3.5, -3.5, 3.4), 700, size=4)
add_light("AREA", (-3.5, -1.0, 1.6), 180, size=5)
render("threequarter.png")

# -------------------------------------------------------------------- in-game
# Black world, a single hard spot from roughly where the player's flashlight is,
# plus mist. This is the honest preview.
clear_lights()
world((0.0, 0.0, 0.0), 0.0)
pose("prowl", 5)
add_camera((1.1, -5.2, 1.45), lens=40)
add_light("SPOT", (1.0, -5.0, 1.55), 520, angle=46)
add_light("AREA", (-2.5, 1.5, 2.2), 25, size=6)  # faint emergency bounce
mist = scene.world.mist_settings
mist.use_mist = True
mist.start = 2.0
mist.depth = 9.0
render("ingame.png")

# ------------------------------------------------------------------ hunt pose
clear_lights()
world((0.1, 0.1, 0.12), 0.6)
pose("hunt", 5)
add_camera((5.8, -3.4, 1.35), lens=52)
add_light("AREA", (3.0, -3.5, 3.0), 800, size=5)
add_light("AREA", (-3.0, 1.0, 1.2), 150, size=5)
render("pose_hunt.png")

# ------------------------------------------------------------------ pull pose
clear_lights()
world((0.16, 0.17, 0.2), 0.7)
pose("pull", 12)
add_camera((4.8, -2.6, 0.9), look_at=Vector((0.0, 0.0, 1.35)), lens=50)
add_light("AREA", (3.5, -3.5, 3.0), 700, size=4)
add_light("AREA", (-3.5, -1.0, 1.2), 180, size=5)
render("pose_pull.png")

# ---------------------------------------------------------------- gait strip
# Four quarter-phases of the prowl, side on. A walk cycle cannot be judged from
# one frozen frame — what matters is that the limbs ALTERNATE and the swinging
# foot is visibly off the deck while the planted ones are on it.
clear_lights()
world((0.5, 0.52, 0.55), 1.1)
add_camera((4.6, 0.3, 0.75), look_at=Vector((0.0, 0.15, 0.45)), lens=58)
add_light("AREA", (3.0, -4.0, 4.0), 900, size=6)
add_light("AREA", (-4.0, 3.0, 2.5), 260, size=6)
for i, frm in enumerate((1, 9, 18, 27)):
    pose("prowl", frm)
    render(f"gait_{i}.png")

print("PREVIEW_OK")
