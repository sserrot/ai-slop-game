"""
art/alien.py — builds the alien as a rigged, animated GLB. Reproducible.

    blender --background --python art/alien.py

Outputs:
    public/models/alien.glb   the asset the game loads
    art/alien.blend           the editable source

WHY A SCRIPT AND NOT A HAND-MODELLED .BLEND
Everything else in this project keeps geometry procedural because the geometry
also declares gameplay data (rails, hide spots). The alien is the one authored
exception (§5: "spend the budget on its animation"), because you cannot
skeletally animate a capsule. Keeping it scripted means it still diffs in git
and a proportion change stays a one-line edit rather than a re-export.

THE CREATURE — revision 3: UPRIGHT, ON TWO LEGS (playtest: "more upright,
almost like a dinosaur"). Revision 2 was a sprawling crocodilian; this pass
stands it up into a theropod without losing the wrongness:
  - BIPEDAL. Hips over folded z-legs (thigh forward, hock back, toes down),
    torso rising diagonally to a high chest, the long tail held out behind as
    the counterweight. Head carries at roughly a crewmate's eye height.
  - A DORSAL SPINE RANK from the neck to mid-tail — still most of the
    silhouette, now a serrated diagonal instead of a serrated horizon.
  - A HINGED JAW WITH TEETH, on its own bone, so `lunge` actually opens it.
  - BLIND. No eyes, no sockets, nothing. The sensory apparatus is a pair of low
    swept-back membranes behind the skull.
  - SHORT forelimbs, tucked and hooked — graspers, not front legs. They still
    haul along handrails in zero-G (the `pull` clip flattens the spine back
    out), but on a deck they never touch the plating.

FACING: head toward +Y in Blender, which the Y-up export turns into -Z. That is
the axis the existing in-game alien already uses (`src/alien/alienView.ts` puts
the skull at a NEGATIVE z), so a drop-in replacement must match it.

PROPORTIONS: nose to tail stays ~2.4 m, but the axis now runs diagonally —
hips at z 0.62, chest at 0.86, skull at ~1.14 (a crewmate's eye height), tail
sweeping back to y -1.58 as the counterbalance. Legs ~0.95 m of folded reach
carry everything; arms shrink to ~0.63 m tucked graspers. The deck is z = 0 in
this file and the feet stay ON it — the game drops the whole GLB by
ALIEN_DECK_DROP_M, so Blender-deck = station-deck by construction.

BUILD TECHNIQUE: vertex chains + Skin modifier + Subdivision for the body, with
hard-surface bits (spines, teeth, jaw, claws) built separately and joined after
skinning. Per-vertex radii keep the whole silhouette tunable numerically.
"""

import math
import os

import bpy
import bmesh
from mathutils import Vector, Matrix

FORWARD = 1.0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_GLB = os.path.join(ROOT, "public", "models", "alien.glb")
OUT_BLEND = os.path.join(ROOT, "art", "alien.blend")

FPS = 24

def y(v):
    return v * FORWARD


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    bpy.context.scene.unit_settings.system = "METRIC"


# ------------------------------------------------------------------- skeleton

def chains():
    """(x, y, z, skin_radius). Revision 3, upright: the spine is a rising
    diagonal — hips 0.62, ribcage 0.76, chest 0.86, skull 1.14 — over two
    folded z-legs, with the tail carried out behind as the counterweight.
    Radii run heavy on purpose: the Skin+Subsurf cage shrinks, and this
    animal should look FED."""
    spine = [
        (0.000, y(-0.35), 0.62, 0.190),   # hips — deep, the balance point
        (0.000, y(-0.16), 0.68, 0.165),   # waist — belly tucks up
        (0.000, y( 0.05), 0.76, 0.190),   # ribcage, deep and round
        (0.000, y( 0.22), 0.86, 0.160),   # chest / shoulder girdle
        (0.000, y( 0.35), 0.95, 0.110),   # neck base — flows, no step
        (0.000, y( 0.46), 1.06, 0.082),   # mid neck
        (0.000, y( 0.58), 1.14, 0.105),   # skull — a crewmate's eye height
        (0.000, y( 0.80), 1.10, 0.048),   # snout
    ]

    # The counterweight. Nearly level, sinking only slightly: a biped's tail
    # balances the raised torso rather than dragging behind a crawl.
    tail = [
        (0.000, y(-0.35), 0.60, 0.170),
        (0.000, y(-0.62), 0.55, 0.128),
        (0.000, y(-0.89), 0.50, 0.092),
        (0.000, y(-1.12), 0.45, 0.060),
        (0.000, y(-1.32), 0.41, 0.032),
        (0.000, y(-1.58), 0.38, 0.010),
    ]

    # Forelimbs: SHORT tucked graspers. Upper arm hangs down-back from a high
    # shoulder, forearm folds forward-up, hand carried in front of the chest.
    # They never walk; the elbow is kept well off the shoulder-wrist line so
    # the zero-G pull's IK still has a plane to solve in.
    arm = [
        (0.160, y( 0.24), 0.84, 0.085),   # shoulder — thick at the root
        (0.220, y( 0.10), 0.60, 0.052),   # elbow — down and back
        (0.190, y( 0.32), 0.56, 0.038),   # wrist — folded forward
        (0.178, y( 0.42), 0.55, 0.028),   # hand
        (0.172, y( 0.49), 0.53, 0.014),   # hooked claws
    ]

    # Hind limbs: the theropod z-fold. Thigh drives forward off a deep haunch,
    # the shank sweeps back to a raised hock, and the toes drop to the deck —
    # digitigrade, weight on the ball of the foot, everything under the hips.
    leg = [
        (0.150, y(-0.30), 0.58, 0.135),   # hip — haunch root
        (0.185, y(-0.08), 0.34, 0.095),   # knee — forward
        (0.175, y(-0.38), 0.16, 0.058),   # ankle — the swept-back hock
        (0.170, y(-0.14), 0.02, 0.032),   # toes, on the plating
    ]

    # Sensory membranes. The blade is built separately; this is just the spar.
    ear = [
        (0.045, y( 0.56), 1.17, 0.020),
        (0.100, y( 0.46), 1.22, 0.018),
        (0.150, y( 0.34), 1.24, 0.012),
        (0.175, y( 0.24), 1.21, 0.007),
    ]

    return spine, tail, arm, leg, ear


def mirrored(chain):
    return [(-x, yy, z, r) for (x, yy, z, r) in chain]


def ear_outline(side=1.0):
    """A low, swept-back, ragged fin — not a deer ear."""
    pts = [
        (0.040, y( 0.60), 1.16),
        (0.095, y( 0.52), 1.25),
        (0.165, y( 0.38), 1.28),
        (0.195, y( 0.26), 1.22),
        (0.150, y( 0.22), 1.13),
        (0.075, y( 0.36), 1.12),
    ]
    return [(x * side, yy, z) for (x, yy, z) in pts]


# ----------------------------------------------------------------- body mesh

def build_body():
    spine, tail, arm, leg, ear = chains()

    mesh = bpy.data.meshes.new("alien_body")
    obj = bpy.data.objects.new("Alien", mesh)
    bpy.context.collection.objects.link(obj)

    bm = bmesh.new()
    radii = []

    def add_chain(points, attach_to=None):
        verts = []
        for i, (x, yy, z, r) in enumerate(points):
            if i == 0 and attach_to is not None:
                verts.append(attach_to)
                continue
            v = bm.verts.new(Vector((x, yy, z)))
            verts.append(v)
            radii.append((v, r))
        for a, b in zip(verts, verts[1:]):
            if a is not b:
                bm.edges.new((a, b))
        return verts

    spine_v = add_chain(spine)
    pelvis, chest, skull = spine_v[0], spine_v[2], spine_v[6]

    tail_v = add_chain(tail, attach_to=pelvis)
    for side in (arm, mirrored(arm)):
        add_chain(side, attach_to=chest)
    for side in (leg, mirrored(leg)):
        add_chain(side, attach_to=pelvis)
    for side in (ear, mirrored(ear)):
        add_chain(side, attach_to=skull)

    # Muscle masses. Pure geometry, no bones: a deltoid bulge over each
    # shoulder root and a haunch over each hip, so the limbs grow OUT OF the
    # torso instead of poking from a barrel. This is most of the difference
    # between "anatomical" and "flat".
    for sx in (1.0, -1.0):
        add_chain([(0, 0, 0, 0),
                   (sx * 0.150, y(0.22), 0.85, 0.110)], attach_to=chest)
        add_chain([(0, 0, 0, 0),
                   (sx * 0.145, y(-0.28), 0.58, 0.155)], attach_to=pelvis)

    bm.verts.index_update()
    index_radius = {v.index: r for v, r in radii}
    # Per-station cross-sections. One global "1.3x wider" ellipse was itself
    # part of the flatness: a real torso is DEEP at the ribcage, FLAT at the
    # belly, and roundest at the hips. (lateral, vertical) per spine station:
    station_shape = [
        (1.22, 1.02),   # hips
        (1.32, 0.90),   # waist — wide and shallow, the tuck
        (1.10, 1.14),   # ribcage — deep
        (1.08, 1.10),   # withers
        (1.10, 1.00),   # neck base
        (1.00, 1.00), (1.00, 1.00), (1.00, 1.00),
    ]
    shape = {}
    for j, v in enumerate(spine_v):
        shape[v.index] = station_shape[j]  # IndexError = the lists drifted
    for v in tail_v:
        shape[v.index] = (1.26, 1.0)
    bm.to_mesh(mesh)
    bm.free()

    skin = obj.modifiers.new("Skin", "SKIN")
    skin.use_smooth_shade = True
    layer = mesh.skin_vertices[0].data
    for i, entry in enumerate(layer):
        r = index_radius.get(i, 0.05)
        rx, rz = shape.get(i, (1.0, 1.0))
        entry.radius = (r * rx, r * rz)
    layer[0].use_root = True

    sub = obj.modifiers.new("Subdivision", "SUBSURF")
    sub.levels = 1
    sub.render_levels = 1

    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for m in ("Skin", "Subdivision"):
        bpy.ops.object.modifier_apply(modifier=m)
    bpy.ops.object.shade_smooth()
    return obj


# --------------------------------------------------------------- hard surface

def new_mesh_obj(name):
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def cone_into(bm, base, tip, radius, segments=6):
    """A spike from base to tip. Used for spines, teeth and claws alike."""
    axis = Vector(tip) - Vector(base)
    length = axis.length
    if length < 1e-6:
        return
    rot = axis.to_track_quat("Z", "Y").to_matrix().to_4x4()
    mat = Matrix.Translation(Vector(base)) @ rot
    ring = []
    for i in range(segments):
        a = 2 * math.pi * i / segments
        ring.append(bm.verts.new(mat @ Vector((math.cos(a) * radius, math.sin(a) * radius, 0.0))))
    apex = bm.verts.new(mat @ Vector((0.0, 0.0, length)))
    for i in range(segments):
        b_ = ring[(i + 1) % segments]
        bm.faces.new((ring[i], b_, apex))
    bm.faces.new(tuple(reversed(ring)))


def measure_top(body, at_y, band=0.055, max_x=0.10):
    """Top of the finished BACK at a point along the body — midline verts only.

    Two lessons baked in. First, the subdivided surface sits inside the control
    cage, so a predicted height leaves spines hovering off the skin. Second —
    the bug that made the dorsal rank float over the shoulders — the elbows ride
    ABOVE the spine on this animal (z 0.78 vs a 0.62 back), so an unfiltered
    max() in a y-band measures the ARM TUBE, not the back. Clamp |x| to the
    body's midline or every spine near the shoulder girdle seats on an elbow.
    """
    lo, hi = y(at_y) - band, y(at_y) + band
    lo, hi = min(lo, hi), max(lo, hi)
    zs = [v.co.z for v in body.data.vertices
          if lo <= v.co.y <= hi and abs(v.co.x) <= max_x]
    return max(zs) if zs else 0.6


def build_spines(body):
    """The dorsal rank. Skull to mid-tail, raked backwards, tallest over the
    shoulders. This is the single biggest change to the silhouette."""
    obj = new_mesh_obj("AlienSpines")
    bm = bmesh.new()

    # (along-body y, spike length, base radius) — neck base to mid-tail,
    # tallest over the shoulder crest, riding the MEASURED diagonal back.
    row = [
        (0.40, 0.040, 0.016),
        (0.28, 0.055, 0.020),
        (0.16, 0.070, 0.024),
        (0.04, 0.082, 0.027),
        (-0.08, 0.090, 0.029),   # shoulder crest
        (-0.20, 0.094, 0.030),
        (-0.32, 0.088, 0.028),
        (-0.50, 0.078, 0.025),
        (-0.68, 0.066, 0.022),
        (-0.86, 0.056, 0.019),
        (-1.04, 0.046, 0.016),
        (-1.20, 0.036, 0.013),
        (-1.34, 0.028, 0.011),
    ]
    for (yy, length, r) in row:
        # Seat each spine 25 mm INSIDE the measured skin so the cone emerges
        # from the back rather than hovering above it.
        top = measure_top(body, yy)
        base = (0.0, y(yy), top - 0.035)
        tip = (0.0, y(yy - 0.040), top + length)   # raked toward the tail
        cone_into(bm, base, tip, r, segments=5)

    bm.to_mesh(obj.data)
    bm.free()
    return obj


def measure_underside(body, y_from, y_to):
    """Actual underside of the finished snout.

    The Skin+Subdivision cage is NOT the rendered surface — subdivision pulls it
    inward, so a palate height derived from `chain z - skin radius` sits well
    below the real mesh and the jaw ends up hanging in space. Measure the built
    geometry instead of predicting it.
    """
    lo, hi = sorted((y(y_from), y(y_to)))
    zs = [v.co.z for v in body.data.vertices
          if lo <= v.co.y <= hi and abs(v.co.x) <= 0.14]
    return min(zs) if zs else 0.45


def build_jaw_and_teeth(body):
    """Lower jaw + both tooth rows, hugging the MEASURED snout underside.

    r4 built the jaw as a flat box at the global minimum of the palate band.
    The snout underside is not flat — it rises toward the chin — so the box
    attached at the hinge and fell away from the head everywhere else: the
    floating-jaw read. Now every station of the jaw's top edge follows the
    built surface minus a constant mouth gap, so the jaw tracks the snout
    whatever the proportions are retuned to.
    """
    MOUTH_GAP = 0.008
    JAW_THICK = 0.042
    stations = (0.52, 0.60, 0.67, 0.73)      # hinge .. chin (overbite: < 0.80)
    half_w = (0.078, 0.068, 0.050, 0.028)

    def underside(yy):
        return measure_underside(body, yy - 0.035, yy + 0.035)

    tops = [underside(yy) - MOUTH_GAP for yy in stations]

    jaw = new_mesh_obj("AlienJaw")
    bmj = bmesh.new()
    left, right, lo_l, lo_r = [], [], [], []
    for (yy, hw, top) in zip(stations, half_w, tops):
        left.append(bmj.verts.new(Vector((hw, y(yy), top))))
        right.append(bmj.verts.new(Vector((-hw, y(yy), top))))
        lo_l.append(bmj.verts.new(Vector((hw * 0.82, y(yy), top - JAW_THICK))))
        lo_r.append(bmj.verts.new(Vector((-hw * 0.82, y(yy), top - JAW_THICK))))
    for i in range(len(stations) - 1):
        bmj.faces.new((left[i], left[i + 1], lo_l[i + 1], lo_l[i]))
        bmj.faces.new((right[i + 1], right[i], lo_r[i], lo_r[i + 1]))
        bmj.faces.new((left[i + 1], left[i], right[i], right[i + 1]))
        bmj.faces.new((lo_l[i], lo_l[i + 1], lo_r[i + 1], lo_r[i]))
    bmj.faces.new((left[0], lo_l[0], lo_r[0], right[0]))
    bmj.faces.new((left[-1], right[-1], lo_r[-1], lo_l[-1]))

    # Lower teeth ride the jaw's own (sloped) top edge. Irregular on purpose.
    lower_row = [(0.54, 0.040), (0.585, 0.048), (0.625, 0.037),
                 (0.66, 0.044), (0.69, 0.030), (0.715, 0.025)]
    for i, (t, length) in enumerate(lower_row):
        jt = underside(t) - MOUTH_GAP
        r = 0.012 - i * 0.0012
        for side in (1, -1):
            x = side * (0.062 - i * 0.008)
            cone_into(bmj, (x, y(t), jt - 0.004), (x, y(t + 0.010), jt + length), r, 4)
    bmj.to_mesh(jaw.data)
    bmj.free()

    # Upper teeth hang from the LOCAL underside, station by station.
    upper = new_mesh_obj("AlienTeethUpper")
    bmu = bmesh.new()
    upper_row = [(0.53, 0.046), (0.575, 0.037), (0.615, 0.047),
                 (0.65, 0.034), (0.68, 0.041), (0.705, 0.028)]
    for i, (t, length) in enumerate(upper_row):
        top = underside(t) + 0.006
        r = 0.013 - i * 0.0013
        for side in (1, -1):
            x = side * (0.065 - i * 0.008)
            cone_into(bmu, (x, y(t), top), (x, y(t + 0.008), top - length), r, 4)
    bmu.to_mesh(upper.data)
    bmu.free()

    hinge_z = underside(0.52) - MOUTH_GAP - JAW_THICK * 0.5
    return jaw, upper, hinge_z


def build_claws():
    """Hooked claws at every extremity. Small, but they catch the flashlight."""
    obj = new_mesh_obj("AlienClaws")
    bm = bmesh.new()
    _, _, arm, leg, _ = chains()
    for chain, spread, length in ((arm, 0.040, 0.055), (leg, 0.036, 0.045)):
        tipx, tipy, tipz, _ = chain[-1]
        for side in (1, -1):
            for k in (-1, 0, 1):
                base = (side * tipx + k * spread * 0.55, tipy, tipz + 0.012)
                tip = (side * tipx + k * spread, tipy + y(0.055), tipz - 0.008)
                cone_into(bm, base, tip, 0.008, 4)
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def build_ear_membranes():
    mesh_obj = new_mesh_obj("AlienEars")
    bm = bmesh.new()
    for side in (1.0, -1.0):
        verts = [bm.verts.new(Vector(p)) for p in ear_outline(side)]
        face = bm.faces.new(verts if side > 0 else list(reversed(verts)))
        face.smooth = True
    bm.to_mesh(mesh_obj.data)
    bm.free()

    bpy.context.view_layer.objects.active = mesh_obj
    mesh_obj.select_set(True)
    solid = mesh_obj.modifiers.new("Solidify", "SOLIDIFY")
    solid.thickness = 0.016
    solid.offset = 0.0
    bpy.ops.object.modifier_apply(modifier="Solidify")
    mesh_obj.select_set(False)
    return mesh_obj


def join_into(body, parts):
    """Join each part, recording the vertex range it occupies so weights can be
    forced afterwards."""
    ranges = {}
    for name, part in parts:
        before = len(body.data.vertices)
        bpy.ops.object.select_all(action="DESELECT")
        part.select_set(True)
        body.select_set(True)
        bpy.context.view_layer.objects.active = body
        bpy.ops.object.join()
        ranges[name] = (before, len(body.data.vertices))
    return ranges


# -------------------------------------------------------------------- material

def build_material(obj):
    """Pale, dry, dead. Seen almost entirely by flashlight, so the job is to not
    read like wet plastic when the beam lands on it."""
    mat = bpy.data.materials.new("alien_hide")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.74, 0.71, 0.66, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.78
    bsdf.inputs["Metallic"].default_value = 0.0
    obj.data.materials.append(mat)


# -------------------------------------------------------------------- armature

def build_armature(jaw_hinge_z):
    spine, tail, arm, leg, ear = chains()

    arm_data = bpy.data.armatures.new("alien_rig")
    rig = bpy.data.objects.new("AlienRig", arm_data)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")

    def bone(name, a, b, parent=None, connected=False):
        eb = arm_data.edit_bones.new(name)
        eb.head = Vector(a[:3])
        eb.tail = Vector(b[:3])
        if parent is not None:
            eb.parent = parent
            eb.use_connect = connected
        # Align every bone's roll so local X is the world LATERAL axis: an
        # X rotation then means "swing fore-aft in the sagittal plane" on
        # every limb, both sides. Blender's default roll for slanted bones is
        # arbitrary, and the stride probes caught the consequence: over half
        # of the forearm's rotation was leaking into sideways motion
        # (2.4 mm/deg measured against a 5.2 mm/deg lever arc).
        axis = (eb.tail - eb.head).normalized()
        lateral = Vector((1.0, 0.0, 0.0))
        x_t = (lateral - axis * axis.dot(lateral))
        if x_t.length > 1e-6:
            eb.align_roll(axis.cross(x_t.normalized()))
        return eb

    root = arm_data.edit_bones.new("root")
    root.head = Vector((0, 0, 0))
    root.tail = Vector((0, 0, 0.22))

    names = ["pelvis", "spine_01", "spine_02", "chest", "neck_01", "neck_02", "head"]
    prev, spine_bones = root, {}
    for i, n in enumerate(names):
        b = bone(n, spine[i], spine[i + 1], prev, i > 0)
        spine_bones[n] = b
        prev = b

    # The jaw hinges under the skull and swings the whole lower assembly.
    bone("jaw", (0.0, y(0.52), jaw_hinge_z), (0.0, y(0.73), jaw_hinge_z - 0.014), spine_bones["head"], False)

    prev = spine_bones["pelvis"]
    for i in range(len(tail) - 1):
        prev = bone(f"tail_{i + 1:02d}", tail[i], tail[i + 1], prev, i > 0)

    for side, pts in (("L", arm), ("R", mirrored(arm))):
        prev = spine_bones["chest"]
        for i, n in enumerate(["shoulder", "upperarm", "forearm", "hand"]):
            prev = bone(f"{n}.{side}", pts[i], pts[i + 1], prev, i > 0)

    for side, pts in (("L", leg), ("R", mirrored(leg))):
        prev = spine_bones["pelvis"]
        for i, n in enumerate(["thigh", "shin", "foot"]):
            prev = bone(f"{n}.{side}", pts[i], pts[i + 1], prev, i > 0)

    for side, pts in (("L", ear), ("R", mirrored(ear))):
        prev = spine_bones["head"]
        for i in range(len(pts) - 1):
            prev = bone(f"ear_{i + 1:02d}.{side}", pts[i], pts[i + 1], prev, i > 0)

    # Scapulae: one blade per shoulder, angled up and back over the withers.
    # Keyed to GLIDE along their own axis during stance, so the blade peaks
    # above the spine line while the body vaults over the planted limb — the
    # cat-shoulder roll, and the strongest single "alive" cue a stalk has.
    for side_name, sx in (("L", 1.0), ("R", -1.0)):
        eb = bone(f"scapula.{side_name}",
                  (sx * 0.150, y(0.20), 0.84),
                  (sx * 0.135, y(0.12), 0.97),
                  spine_bones["chest"], False)
        # Excluded from automatic weighting: a bone floating INSIDE the mesh
        # volume makes bone-heat fail outright, and the silent fallback to
        # envelope weights rebinds the whole body (r13: dislocated jaw,
        # floating spikes, a shoulder tear — all from this one warning).
        # The blade gets its weights from the proximity blend instead.
        eb.use_deform = False

    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


AXIAL_SPANS = (
    ("tail_05", -1.62, -1.32), ("tail_04", -1.32, -1.12),
    ("tail_03", -1.12, -0.89), ("tail_02", -0.89, -0.62),
    ("tail_01", -0.62, -0.35), ("pelvis", -0.35, -0.16),
    ("spine_01", -0.16, 0.05), ("spine_02", 0.05, 0.22),
    ("chest", 0.22, 0.35), ("neck_01", 0.35, 0.46),
    ("neck_02", 0.46, 0.58), ("head", 0.58, 1.05),
)


def _force_verts(mesh_obj, idx, bone_name):
    groups = {g.name: g for g in mesh_obj.vertex_groups}
    grp = groups.get(bone_name) or mesh_obj.vertex_groups.new(name=bone_name)
    for g in mesh_obj.vertex_groups:
        if g.name != bone_name:
            g.remove(idx)
    grp.add(idx, 1.0, "REPLACE")


def _blend_proximity(mesh_obj, center, radius, bone_name, w):
    """Blend `w` of the weight of every vertex within `radius` of `center`
    onto `bone_name`, scaling whatever automatic weights put there down to
    make room. This is how the deltoid surface follows the scapula and the
    haunch follows the thigh without tearing away from the torso."""
    c = Vector(center)
    grp = (mesh_obj.vertex_groups.get(bone_name)
           or mesh_obj.vertex_groups.new(name=bone_name))
    plan = []
    for v in mesh_obj.data.vertices:
        d = (v.co - c).length
        if d > radius:
            continue
        # Keep off the midline: the dorsal spikes ride axial bones, and skin
        # that follows the blade underneath a pinned spike shears them apart.
        if abs(v.co.x) < 0.06:
            continue
        # Feathered falloff — a hard sphere edge turns the glide into a shelf.
        t = 1.0 - d / radius
        wv = w * (t * t * (3 - 2 * t))
        existing = [(g.group, g.weight) for g in v.groups]
        plan.append((v.index, existing, wv))
    for idx, existing, wv in plan:
        for gi, weight in existing:
            if gi == grp.index:
                continue
            mesh_obj.vertex_groups[gi].add([idx], weight * (1.0 - wv), "REPLACE")
        grp.add([idx], wv, "ADD")


def bind(mesh_obj, rig, ranges):
    bpy.ops.object.select_all(action="DESELECT")
    mesh_obj.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    try:
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    except RuntimeError as err:
        # Envelope weights are the bind this file documents as broken (r13:
        # dislocated jaw, floating spikes). Never silently export from them.
        raise SystemExit(f"automatic weighting failed outright: {err}")

    # RESCUE PASS. "Bone Heat Weighting: failed to find solution" is a
    # WARNING, not an exception: parent_set succeeds, the failed bones simply
    # get no weights, and their skin silently follows whatever neighbours DID
    # solve. That is how the skull stayed at rest height while the head bone
    # (and the jaw, teeth and membranes forced onto it) dived with the stalk's
    # nose-down posture — the "detached jaw", and the floating tail spikes,
    # in one bug. Any vertex the solver left (near-)weightless gets assigned
    # to the nearest deform bone, and the build says so out loud.
    bones = [b for b in rig.data.bones if b.use_deform]
    segs = []
    for b in bones:
        segs.append((b.name, Vector(b.head_local), Vector(b.tail_local)))

    def nearest_bone(co):
        best, best_d = None, 1e9
        for name, h, t in segs:
            ab = t - h
            L2 = ab.length_squared
            u = 0.0 if L2 < 1e-12 else max(0.0, min(1.0, (co - h).dot(ab) / L2))
            d = (co - (h + ab * u)).length
            if d < best_d:
                best, best_d = name, d
        return best

    rescued = {}
    for v in mesh_obj.data.vertices:
        total = sum(g.weight for g in v.groups)
        if total >= 0.05:
            continue
        name = nearest_bone(v.co)
        grp = (mesh_obj.vertex_groups.get(name)
               or mesh_obj.vertex_groups.new(name=name))
        grp.add([v.index], 1.0, "REPLACE")
        rescued[name] = rescued.get(name, 0) + 1
    if rescued:
        print("RESCUED unweighted verts:", sorted(rescued.items()))

    # Re-enable the scapulae for deform now that the heat solve is done, then
    # organic blends: shoulder-bulge surface partly follows the scapula, the
    # haunch partly follows the thigh. Hard parts are forced after.
    for side in ("L", "R"):
        rig.data.bones[f"scapula.{side}"].use_deform = True
    for sx, side in ((1.0, "L"), (-1.0, "R")):
        _blend_proximity(mesh_obj, (sx * 0.150, y(0.22), 0.85), 0.13,
                         f"scapula.{side}", 0.55)
        _blend_proximity(mesh_obj, (sx * 0.145, y(-0.29), 0.58), 0.14,
                         f"thigh.{side}", 0.45)

    # Hard assignments for every joined hard-surface part. Automatic weights
    # BLEND across nearby bones, which is right for skin and wrong for rigid
    # attachments: a dorsal spike half-weighted to neck_02 slides off the back
    # whenever the head turns. Each spike belongs 100% to the one axial bone
    # whose span holds it; membranes and upper teeth belong to the head; the
    # jaw keeps its dedicated bone.
    verts = mesh_obj.data.vertices
    if "spines" in ranges:
        lo, hi = ranges["spines"]
        buckets = {}
        for i in range(lo, hi):
            vy = verts[i].co.y
            for bone_name, y0, y1 in AXIAL_SPANS:
                if y(y0) <= vy <= y(y1) or y(y1) <= vy <= y(y0):
                    buckets.setdefault(bone_name, []).append(i)
                    break
        for bone_name, idx in buckets.items():
            _force_verts(mesh_obj, idx, bone_name)
    for part, bone_name in (("ears", "head"), ("teeth_upper", "head")):
        if part in ranges:
            lo, hi = ranges[part]
            _force_verts(mesh_obj, list(range(lo, hi)), bone_name)
    if "jaw" in ranges:
        lo, hi = ranges["jaw"]
        _force_verts(mesh_obj, list(range(lo, hi)), "jaw")


# ------------------------------------------------------------------ animation

def rad(d):
    return math.radians(d)


def new_action(rig, name):
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    if rig.animation_data is None:
        rig.animation_data_create()
    rig.animation_data.action = action
    return action


def key(rig, bone_name, frame, rot=None, loc=None):
    pb = rig.pose.bones.get(bone_name)
    if pb is None:
        return
    pb.rotation_mode = "XYZ"
    if rot is not None:
        pb.rotation_euler = (rad(rot[0]), rad(rot[1]), rad(rot[2]))
        pb.keyframe_insert("rotation_euler", frame=frame)
    if loc is not None:
        pb.location = loc
        pb.keyframe_insert("location", frame=frame)


def cyclic(rig, action):
    for fcu in action.fcurves:
        if any(m.type == "CYCLES" for m in fcu.modifiers):
            continue
        mod = fcu.modifiers.new("CYCLES")
        mod.mode_before = "REPEAT_OFFSET"
        mod.mode_after = "REPEAT_OFFSET"


def stash(rig, action):
    track = rig.animation_data.nla_tracks.new()
    track.name = action.name
    track.strips.new(action.name, int(action.frame_range[0]), action)
    track.mute = True
    rig.animation_data.action = None


def anim_idle(rig):
    """LISTENING. Head sweeps, fins lead it, jaw hangs slightly open. This is
    the pose that teaches the player it has no eyes."""
    a = new_action(rig, "idle_listen")
    for f, yaw in ((1, 0), (36, -24), (60, -19), (96, 26), (120, 21), (144, 0)):
        key(rig, "neck_01", f, (0, 0, yaw * 0.45))
        key(rig, "neck_02", f, (0, 0, yaw * 0.35))
        key(rig, "head", f, (0, 0, yaw * 0.55))
        key(rig, "ear_01.L", f, (0, 0, -yaw * 0.5 - 10))
        key(rig, "ear_01.R", f, (0, 0, -yaw * 0.5 + 10))
    for f, gape in ((1, 5), (48, 9), (96, 4), (144, 5)):
        key(rig, "jaw", f, (gape, 0, 0))
    for f, rise in ((1, 0), (48, 2.0), (96, -1.2), (144, 0)):
        key(rig, "chest", f, (rise, 0, 0))
    for i, f in enumerate((1, 40, 80, 144)):
        s = (-1) ** i
        key(rig, "tail_02", f, (0, 0, 7 * s))
        key(rig, "tail_04", f, (0, 0, 13 * s))
    cyclic(rig, a)
    stash(rig, a)


# ===========================================================================
# Gait authoring — IK targets, baked to FK
#
# r6-r8 tried to make FK swing amplitudes produce ground-true feet: probe the
# joints, solve amplitudes, calibrate trims. Every pass surfaced a new leak —
# arbitrary bone rolls, a misnamed joint chain, near-parallel lever responses,
# and finally plain limb shortness. The lesson is the one production animation
# learned decades ago: author foot CONTACT, not joint angles. Each foot gets a
# world-space target that slides in a straight line on the deck through stance
# and arcs forward through swing; an IK solver poses the two limb bones every
# frame; the result is baked to plain FK keys and the IK rig is deleted. Feet
# are ground-true by construction, the stride is exact by construction, and
# the GLB that ships contains nothing but ordinary baked bones.
# ===========================================================================

# Per-gait footfall timing, for a BIPED now. PROWL is the stalk: two feet,
# long duty factor, oscillation suppressed. HUNT is the sprint: duty drops
# under 0.5 so the run trades stance for an aerial beat, and the energy moves
# into the sagittal plane (spine flex) instead of yaw. The forelimbs never
# walk — `limbs` names the IK-driven pair, and the tucked graspers are keyed
# directly by `_gait_body`.
GAITS = {
    "prowl": {
        "phases": {"LH": 0.0, "RH": 0.5},
        "duty": 0.62,
        "bias": {"hind": 0.38},
        "beats": 2,
        "limbs": ("LH", "RH"),
    },
    "hunt": {
        "phases": {"LH": 0.0, "RH": 0.5},
        "duty": 0.36,
        "bias": {"hind": 0.42},
        "beats": 2,
        "limbs": ("LH", "RH"),
    },
}

LIMBS = (
    # key      ik-holder      chain  rest target (wrist / ankle)
    ("LF", "upperarm.L", 2, ( 0.190, 0.32, 0.56)),
    ("RF", "upperarm.R", 2, (-0.190, 0.32, 0.56)),
    ("LH", "shin.L",     2, ( 0.175, -0.38, 0.12)),
    ("RH", "shin.R",     2, (-0.175, -0.38, 0.12)),
)


def add_ik_rigs(rig):
    """One target empty + one pole empty per limb. Without a pole the solver
    picks an arbitrary elbow direction every frame — limbs wander and twist.
    The pole pins each elbow/knee outboard and slightly raised, which is the
    croc push-up posture."""
    targets = {}
    for limb, holder, chain, rest in LIMBS:
        side = 1.0 if rest[0] > 0 else -1.0
        rest_loc = Vector((rest[0], y(rest[1]), rest[2]))

        emp = bpy.data.objects.new(f"ik_{limb}", None)
        emp.empty_display_size = 0.05
        bpy.context.collection.objects.link(emp)

        mid = rig.pose.bones[holder].bone.head_local
        pole = bpy.data.objects.new(f"pole_{limb}", None)
        pole.empty_display_size = 0.05
        bpy.context.collection.objects.link(pole)
        # The pole pins the middle joint's plane. On the z-fold hind leg the
        # KNEE points forward; on the tucked grasper the ELBOW points down and
        # back. (The croc build pinned everything outboard — a sprawl cue this
        # stance no longer has.)
        if limb in ("LH", "RH"):
            pole.location = Vector((side * 0.30, y(0.95), 0.40))
        else:
            pole.location = Vector((side * 0.45, y(-0.85), 0.45))

        con = rig.pose.bones[holder].constraints.new("IK")
        con.target = emp
        con.pole_target = pole
        con.chain_count = chain

        # Pole angle depends on the bone rolls this rig happened to bake, so
        # measure instead of guessing (the -90 guess cost a build): pick the
        # angle that best reaches the target with the joint held outboard.
        # Score each candidate across the STRIDE EXTREMES, not the rest pose:
        # at rest every angle reaches and they all score zero (the r10 bug —
        # four limbs picked four different angles). The wrong elbow direction
        # only shows up where it costs reach: at the far ends of the sweep.
        dg = bpy.context.evaluated_depsgraph_get()
        probes = (rest_loc,
                  rest_loc + Vector((0, y(0.28), 0)),
                  rest_loc + Vector((0, y(-0.28), 0)))
        best = (1e9, 0.0)
        for cand in range(-180, 180, 45):
            con.pole_angle = math.radians(cand)
            score = 0.0
            for probe in probes:
                emp.location = probe
                bpy.context.view_layer.update()
                dg.update()
                ob_eval = rig.evaluated_get(dg)
                pb_eval = ob_eval.pose.bones[holder]
                tip = ob_eval.matrix_world @ pb_eval.tail
                joint = ob_eval.matrix_world @ pb_eval.head
                # Reach dominates; the outboard term breaks the ties that
                # appear once every angle can reach (LF picked -45 to RF's
                # -90 purely by iteration order, and hovered for it).
                score += (tip - probe).length * 10.0
                score += max(0.0, 0.25 - side * joint.x)
                score -= 0.02 * (side * joint.x)
            if score < best[0]:
                best = (score, cand)
        con.pole_angle = math.radians(best[1])
        emp.location = rest_loc
        print("POLE %s angle=%d score=%.3f" % (limb, best[1], best[0]))

        targets[limb] = emp
        targets[f"pole_{limb}"] = pole
    return targets


def remove_ik_rigs(rig, targets):
    for limb, holder, _chain, _rest in LIMBS:
        pb = rig.pose.bones[holder]
        for con in list(pb.constraints):
            if con.type == "IK":
                pb.constraints.remove(con)
    for emp in targets.values():
        if emp.animation_data and emp.animation_data.action:
            bpy.data.actions.remove(emp.animation_data.action)
        bpy.data.objects.remove(emp, do_unlink=True)


def animate_targets(targets, length, stride, lift_h, cfg):
    """Foot paths: a straight rearward slide on the deck through stance, a
    lifted arc forward through swing. Linear interpolation on the stance keys
    is what makes the plant WORLD-TRUE once the viewer matches cadence.

    `bias` skews the sweep rearward of the rest point: a limb has far more
    reach in RETRACTION than in protraction (the vertical drop eats forward
    reach), so plant slightly ahead and trail far behind — which is also how
    stalking quadrupeds actually use their stride."""
    duty, phases = cfg["duty"], cfg["phases"]
    for limb, _holder, _chain, rest in LIMBS:
        if limb not in cfg.get("limbs", ("LF", "RF", "LH", "RH")):
            continue
        emp = targets[limb]
        if emp.animation_data:
            emp.animation_data_clear()
        phase = phases[limb]
        bias = cfg["bias"]["front" if limb in ("LF", "RF") else "hind"]
        for f in range(1, length + 2):
            fr = (f - 1) / length
            q = (fr - phase) % 1.0
            if q < duty:
                prog = q / duty
                fwd = stride * (bias - prog)
                z = rest[2]
            else:
                sw = (q - duty) / (1.0 - duty)
                fwd = stride * (bias - 1.0 + sw)
                z = rest[2] + lift_h * math.sin(math.pi * sw)
            emp.location = Vector((rest[0], y(rest[1] + fwd), z))
            emp.keyframe_insert("location", frame=f)
        for fcu in emp.animation_data.action.fcurves:
            for kp in fcu.keyframe_points:
                kp.interpolation = "LINEAR"


def bake_limbs(rig, length, which=("front", "hind")):
    """Manual visual bake of the four IK'd chains into the ACTIVE action —
    no operator context roulette in background mode. Reads the evaluated
    (constraint-included) pose per frame, converts to local space, then
    writes plain rotation keys."""
    chain_bones = []
    for _limb, holder, _chain, _rest in LIMBS:
        side = holder.split(".")[1]
        if holder.startswith("upperarm") and "front" in which:
            chain_bones += [f"shoulder.{side}", f"upperarm.{side}"]
        elif holder.startswith("shin") and "hind" in which:
            chain_bones += [f"thigh.{side}", f"shin.{side}"]

    dg = bpy.context.evaluated_depsgraph_get()
    frames = {}
    for f in range(1, length + 1):
        bpy.context.scene.frame_set(f)
        dg.update()
        ob_eval = rig.evaluated_get(dg)
        for bn in chain_bones:
            m_pose = ob_eval.pose.bones[bn].matrix.copy()
            m_local = rig.convert_space(
                pose_bone=rig.pose.bones[bn], matrix=m_pose,
                from_space="POSE", to_space="LOCAL")
            frames.setdefault(bn, []).append((f, m_local.to_euler("XYZ")))

    for bn, keys in frames.items():
        pb = rig.pose.bones[bn]
        pb.rotation_mode = "XYZ"
        for f, eul in keys:
            pb.rotation_euler = eul
            pb.keyframe_insert("rotation_euler", frame=f)


def measure_contacts(rig, name, length):
    """Min/max world height and fore-aft sweep of every tip, as data."""
    act = bpy.data.actions.get(name)
    rig.animation_data.action = act
    # Bones the action does NOT key keep whatever pose the previous author
    # left (the pull leaves root inverted at +1.6 m) — zero everything first
    # so unkeyed bones evaluate at rest.
    for pb in rig.pose.bones:
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
    tips = ("hand.L", "hand.R", "foot.L", "foot.R")
    lo = {t: 1e9 for t in tips}
    hi = {t: -1e9 for t in tips}
    ylo = {t: 1e9 for t in tips}
    yhi = {t: -1e9 for t in tips}
    for f in range(1, length + 1):
        bpy.context.scene.frame_set(f)
        for t in tips:
            w = rig.matrix_world @ rig.pose.bones[t].tail
            lo[t] = min(lo[t], w.z)
            hi[t] = max(hi[t], w.z)
            ylo[t] = min(ylo[t], w.y)
            yhi[t] = max(yhi[t], w.y)
    rig.animation_data.action = None
    stride = {t: yhi[t] - ylo[t] for t in tips}
    return lo, hi, stride


def contact_report(rig, name, length):
    lo, hi, stride = measure_contacts(rig, name, length)
    for t in lo:
        print("CONTACT %s %s: min=%.3f max=%.3f sweep=%.2fm"
              % (name, t, lo[t], hi[t], stride[t]))


def _gait_body(rig, name, length, p, cfg):
    """Everything except the limbs: girdle wave, roll, plant-beat bob, head
    stabilisation, tail lag, jaw, palm/foot rock — plus, for the bound, the
    sagittal spine wave (extend into the aerial phase, flex on the front
    landing) that the cat-gallop literature calls out as the stride-extending
    mechanism. Limb chains are posed by IK and baked afterwards."""
    a = new_action(rig, name)
    duty, phases = cfg["duty"], cfg["phases"]

    def q_of(fr, phase):
        return (fr - phase) % 1.0

    def st_of(fr, phase):
        q = q_of(fr, phase)
        if q < duty:
            return 1.0 - 2.0 * (q / duty)
        return -1.0 + 2.0 * ((q - duty) / (1.0 - duty))

    def lift_of(fr, phase):
        q = q_of(fr, phase)
        return 0.0 if q < duty else math.sin(math.pi * (q - duty) / (1.0 - duty))

    def swing_mid(phase):
        return (phase + duty + (1.0 - duty) * 0.5) % 1.0

    mid_LH = swing_mid(phases["LH"])
    # Shoulder counter-rotation runs off the OTHER foot: on a biped the torso
    # twists against the pelvis, arms riding the twist.
    mid_LF = swing_mid(phases["RH"])
    # Spine extension peaks as the hinds finish their drive (aerial launch).
    ext_phase = (phases["LH"] + duty) % 1.0

    n_keys = 8
    for k in range(n_keys + 1):
        fr = k / n_keys
        f = max(1, int(round(length * fr)))
        chest_yaw = p["girdle"] * math.cos(2 * math.pi * (fr - mid_LF))
        pelvis_yaw = p["pelvis"] * math.cos(2 * math.pi * (fr - mid_LH))
        roll = p["roll"] * math.sin(2 * math.pi * fr)
        bob = -p["bob"] * math.cos(cfg["beats"] * 2 * math.pi * fr)
        # Sagittal flexion wave (0 for the walk): + extends the back as the
        # hinds launch, - flexes it as the fronts take the landing.
        flex = p.get("flex", 0) * math.cos(2 * math.pi * (fr - ext_phase))

        key(rig, "pelvis", f, (p["crouch"] + flex * 0.8, roll, pelvis_yaw),
            loc=(0, 0, bob))
        key(rig, "spine_02", f, (-flex, roll * 0.5,
                                 (chest_yaw - pelvis_yaw) * 0.4))
        key(rig, "chest", f, (-p["crouch"] * 0.4 - flex * 0.9, -roll * 0.4,
                              (chest_yaw - pelvis_yaw) * 0.6))
        key(rig, "neck_01", f, (p["crouch"] * 0.5 + flex * 0.6, 0,
                                -chest_yaw * 0.6))
        key(rig, "head", f, (-p["crouch"] * 0.3 - flex * 0.5, 0,
                             -chest_yaw * 0.3))
        key(rig, "jaw", f, (p["gape"], 0, 0))

        for i, bn in enumerate(
                ("tail_01", "tail_02", "tail_03", "tail_04", "tail_05"), 1):
            s_i = (math.sin(2 * math.pi * (fr - mid_LH - 0.08 * i))
                   * p["tail"] * (0.5 + 0.4 * i))
            key(rig, bn, f, (0, 0, s_i))

        # Heel-to-toe rock on the feet, and the tucked graspers pumping
        # gently with the OPPOSITE foot — the weight-transfer cues the IK
        # bake cannot supply.
        for side, phh in (("L", phases["LH"]), ("R", phases["RH"])):
            sth, lfh = st_of(fr, phh), lift_of(fr, phh)
            opp = phases["RH"] if side == "L" else phases["LH"]
            sw = math.sin(2 * math.pi * (fr - opp))
            arm_a = p.get("armswing", 6)
            key(rig, f"shoulder.{side}", f, (arm_a * sw, 0, 0))
            key(rig, f"upperarm.{side}", f, (-arm_a * 0.7 * sw, 0, 0))
            key(rig, f"forearm.{side}", f, (8 + 3 * sw, 0, 0))
            key(rig, f"hand.{side}", f, (6, 0, 0))
            key(rig, f"foot.{side}", f, (p["rock"] * sth + 6 * lfh, 0, 0))
            # Scapula glide: the blade breathes with the same-side foot's
            # stance, peaking at mid-stance, flat through the swing.
            qh = q_of(fr, phh)
            rise = math.sin(math.pi * qh / duty) if qh < duty else 0.0
            key(rig, f"scapula.{side}", f, None,
                loc=(0, p.get("scap", 0.0) * rise, 0))
    return a


def author_gait(rig, targets, name, length, stride, lift_h, p):
    cfg = GAITS[name]
    a = _gait_body(rig, name, length, p, cfg)
    rig.animation_data.action = a
    animate_targets(targets, length, stride, lift_h, cfg)
    # The walking gaits are HIND-ONLY: the graspers are keyed by _gait_body,
    # and their IK must not fight those keys during the bake (mirror image of
    # what the pull does to the hind constraints).
    front_cons = []
    for side in ("L", "R"):
        for con in rig.pose.bones[f"upperarm.{side}"].constraints:
            if con.type == "IK":
                front_cons.append(con)
                con.influence = 0.0
    bake_limbs(rig, length, which=("hind",))
    for con in front_cons:
        con.influence = 1.0
    cyclic(rig, a)
    stash(rig, a)
    # Record the MEASURED sweep of the FEET — the only contacts a biped has.
    _lo, _hi, sweep = measure_contacts(rig, name, length)
    measured = (sweep["foot.L"] + sweep["foot.R"]) / 2
    return {"frames": length, "stride": round(measured / cfg["duty"], 4)}


def anim_prowl(rig, targets):
    """PATROL / SEARCH — the STALK, on two legs: long slow strides under the
    hips, oscillation suppressed, head carried level. Stealth reads as the
    near-elimination of bob, roll and sway, not as a different footfall."""
    return author_gait(rig, targets, "prowl", 48, stride=0.60, lift_h=0.07,
                       p=dict(girdle=5, pelvis=7, roll=2, bob=0.010,
                              crouch=6, gape=3, tail=3, rock=8, scap=0.030,
                              armswing=5))


def anim_hunt(rig, targets):
    """HUNT — the SPRINT. A theropod at 3 m/s runs: duty drops under half so
    the feet trade an aerial beat, the spine pumps in the sagittal plane, the
    tail whips harder, and the head drops toward the prey line. Jaw open,
    loud on purpose per section 5."""
    return author_gait(rig, targets, "hunt", 22, stride=0.95, lift_h=0.18,
                       p=dict(girdle=4, pelvis=5, roll=2, bob=0.045,
                              crouch=-3, gape=18, tail=7, rock=12, flex=8,
                              scap=0.020, armswing=10))


def anim_pull(rig, targets):
    """ZERO-G ceiling-rail haul, authored as a TWO-LIMB GAIT. The r16 pull was
    three symmetric keyframes: the arms seesawed without ever gripping and the
    legs were posed constants — "the arms aren't really pulling, the legs
    aren't moving." Now the hands are feet: IK targets stroke backward ALONG
    THE RAIL LINE through each power stroke (duty 0.5, half-cycle offset, so
    one hand always has the rail) and arc away from it through recovery. The
    legs are cargo — a passive wave lagging the spine, like the tail.
    """
    length = 48
    DUTY = 0.5
    STRIDE = 0.50
    # Authored in the body frame: the rail runs AHEAD at spine height, and the
    # GAME's rail-attachment logic supplies the orientation (ceiling rails
    # included). The old baked 180-degree roll would have double-rotated the
    # moment alienView oriented the body itself; the viewer page reapplies the
    # ceiling-hang as a display transform instead.
    RAIL_Z = 0.95
    PHASES = {"LF": 0.0, "RF": 0.5}

    a = new_action(rig, "pull")

    # Hind IK stays off: the leg targets sit on the DECK, and with the body
    # rolled inverted they would wrench the legs downward. Legs go FK.
    hind_cons = []
    for side in ("L", "R"):
        for con in rig.pose.bones[f"shin.{side}"].constraints:
            if con.type == "IK":
                hind_cons.append(con)
                con.influence = 0.0

    n_keys = 8
    for k in range(n_keys + 1):
        fr = k / n_keys
        f = max(1, int(round(length * fr)))
        wave = math.sin(2 * math.pi * fr)
        surge = math.sin(4 * math.pi * fr)   # one nod per power stroke

        # Flatten the standing spine into a swimmer: each joint sheds a slice
        # of the rest pose's rise, so the body lies out along the rail axis
        # instead of hanging off it at forty degrees.
        key(rig, "pelvis", f, (-14, 0, 5 * wave))
        key(rig, "spine_01", f, (-8, 0, 3 * wave))
        key(rig, "spine_02", f, (-10, 0, 6 * math.sin(2 * math.pi * (fr - 0.08))))
        key(rig, "chest", f, (-14 + 3 * surge, 0, -5 * wave))
        key(rig, "neck_01", f, (-16, 0, -3 * wave))
        key(rig, "neck_02", f, (-10, 0, 0))
        key(rig, "head", f, (14, 0, 0))
        key(rig, "jaw", f, (5, 0, 0))

        for i, bn in enumerate(
                ("tail_01", "tail_02", "tail_03", "tail_04", "tail_05"), 1):
            lazy = math.sin(2 * math.pi * (fr - 0.12 * i - 0.2))
            key(rig, bn, f, (0, 0, 10 * (0.4 + 0.3 * i) * lazy))

        # Legs: passive drift, delayed behind the pelvis wave, knees loose.
        for side, sgn in (("L", 1.0), ("R", -1.0)):
            lagged = math.sin(2 * math.pi * (fr - 0.22))
            key(rig, f"thigh.{side}", f,
                (10 + 5 * lagged, 0, sgn * 12 * math.sin(2 * math.pi * (fr - 0.28))))
            key(rig, f"shin.{side}", f,
                (-14 + 8 * math.sin(2 * math.pi * (fr - 0.34)), 0, 0))
            key(rig, f"foot.{side}", f, (5 * lagged, 0, 0))

        # Palms: curl hard through the power stroke (gripping the rail),
        # open through the recovery reach.
        for limb, side in (("LF", "L"), ("RF", "R")):
            q = (fr - PHASES[limb]) % 1.0
            if q < DUTY:
                key(rig, f"forearm.{side}", f, (38, 0, 0))
                key(rig, f"hand.{side}", f, (18, 0, 0))
            else:
                sw = (q - DUTY) / (1.0 - DUTY)
                lift = math.sin(math.pi * sw)
                key(rig, f"forearm.{side}", f, (6 - 14 * lift, 0, 0))
                key(rig, f"hand.{side}", f, (-8 * lift, 0, 0))

    # Hand targets on the rail line: straight backward slide while gripping,
    # an arc away from the rail while recovering. Same ground-truth idea as
    # the walk, rotated onto the ceiling.
    rig.animation_data.action = a
    for limb in ("LF", "RF"):
        emp = targets[limb]
        if emp.animation_data:
            emp.animation_data_clear()
        sgn = 1.0 if limb == "LF" else -1.0
        phase = PHASES[limb]
        for f in range(1, length + 2):
            fr = (f - 1) / length
            q = (fr - phase) % 1.0
            if q < DUTY:
                prog = q / DUTY
                yy = 0.45 + STRIDE * (0.5 - prog)
                z = RAIL_Z
            else:
                sw = (q - DUTY) / (1.0 - DUTY)
                yy = 0.45 + STRIDE * (-0.5 + sw)
                z = RAIL_Z - 0.22 * math.sin(math.pi * sw)
            emp.location = Vector((sgn * 0.10, y(yy), z))
            emp.keyframe_insert("location", frame=f)
        for fcu in emp.animation_data.action.fcurves:
            for kp in fcu.keyframe_points:
                kp.interpolation = "LINEAR"

    bake_limbs(rig, length, which=("front",))
    for con in hind_cons:
        con.influence = 1.0
    cyclic(rig, a)
    stash(rig, a)

    _lo, _hi, sweep = measure_contacts(rig, "pull", length)
    hands = (sweep["hand.L"] + sweep["hand.R"]) / 2
    return {"frames": length, "stride": round(hands / DUTY, 4)}


def anim_lunge(rig):
    """ATTACK. Coil, then everything at once, jaw wide."""
    a = new_action(rig, "lunge")
    # Coil: the body is ALREADY upright, so the wind-up is a rock back onto
    # the tail with the legs loading, not a rear-up from a crawl.
    for b, r in (("pelvis", (10, 0, 0)), ("chest", (10, 0, 0)), ("neck_01", (16, 0, 0)),
                 ("head", (10, 0, 0)), ("jaw", (6, 0, 0)),
                 ("shoulder.L", (40, 0, -20)), ("shoulder.R", (40, 0, -20)),
                 ("thigh.L", (-22, 0, 6)), ("thigh.R", (-22, 0, 6)),
                 ("tail_02", (-8, 0, 0)), ("tail_03", (-6, 0, 0))):
        key(rig, b, 1, r)

    for b, r in (("pelvis", (-14, 0, 0)), ("chest", (-16, 0, 0)), ("neck_01", (-14, 0, 0)),
                 ("head", (6, 0, 0)), ("jaw", (46, 0, 0)),
                 ("shoulder.L", (-60, 0, -26)), ("shoulder.R", (-60, 0, -26)),
                 ("upperarm.L", (36, 0, 0)), ("upperarm.R", (36, 0, 0)),
                 ("thigh.L", (20, 0, 4)), ("thigh.R", (20, 0, 4)),
                 ("tail_02", (6, 0, 0)), ("tail_03", (8, 0, 0)),
                 ("ear_01.L", (0, 0, 36)), ("ear_01.R", (0, 0, -36))):
        key(rig, b, 9, r)

    for b, r in (("pelvis", (6, 0, 0)), ("chest", (0, 0, 0)), ("neck_01", (0, 0, 0)),
                 ("head", (0, 0, 0)), ("jaw", (10, 0, 0)),
                 ("shoulder.L", (0, 0, -18)), ("shoulder.R", (0, 0, -18)),
                 ("upperarm.L", (10, 0, 0)), ("upperarm.R", (10, 0, 0))):
        key(rig, b, 26, r)
    stash(rig, a)


# ---------------------------------------------------------------------- export

def export(mesh_obj, rig):
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    mesh_obj.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_nla_strips=True,
        export_bake_animation=True,
        export_yup=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
    )
    bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)


def main():
    reset_scene()
    body = build_body()

    ears = build_ear_membranes()
    spines = build_spines(body)
    jaw, upper_teeth, jaw_hinge_z = build_jaw_and_teeth(body)
    claws = build_claws()

    ranges = join_into(body, [
        ("ears", ears), ("spines", spines),
        ("teeth_upper", upper_teeth),
        # claws: auto-weights are fine — tips sit inside hand/foot envelopes
        ("claws", claws),
        ("jaw", jaw),   # joined last so its range is the tail of the buffer
    ])

    bpy.context.view_layer.objects.active = body
    body.select_set(True)
    bpy.ops.object.shade_smooth()
    build_material(body)

    rig = build_armature(jaw_hinge_z)
    bind(body, rig, ranges)

    anim_idle(rig)
    targets = add_ik_rigs(rig)
    gait_meta = {
        "prowl": anim_prowl(rig, targets),
        "hunt": anim_hunt(rig, targets),
        "pull": anim_pull(rig, targets),
    }
    remove_ik_rigs(rig, targets)
    anim_lunge(rig)
    contact_report(rig, "prowl", gait_meta["prowl"]["frames"])

    # Sidecar the viewer (and later the game) reads to lock cadence to speed:
    # timeScale = speed * authoredDuration / stride. Written by the build so it
    # can never drift from the authored animation.
    import json
    meta_path = os.path.join(ROOT, "public", "models", "alien.meta.json")
    with open(meta_path, "w") as fh:
        json.dump({"fps": FPS, "clips": gait_meta}, fh, indent=2)
    print("META", json.dumps(gait_meta))

    export(body, rig)

    body.data.calc_loop_triangles()
    d = body.dimensions
    print("ALIEN_OK",
          f"tris={len(body.data.loop_triangles)}",
          f"verts={len(body.data.vertices)}",
          f"bones={len(rig.data.bones)}",
          f"actions={len(bpy.data.actions)}",
          f"dims={d.x:.2f}x{d.y:.2f}x{d.z:.2f}")


if __name__ == "__main__":
    main()
