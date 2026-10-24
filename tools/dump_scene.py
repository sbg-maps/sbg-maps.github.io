"""Print a built scene's GameObject tree with component types (MonoBehaviours by script class).
usage: dump_scene.py <extracted_dir> <levelN> [max_depth]"""
import os, sys, collections
import UnityPy

d, level = sys.argv[1], sys.argv[2]
max_depth = int(sys.argv[3]) if len(sys.argv) > 3 else 99
files = [os.path.join(d, f) for f in os.listdir(d) if f in (level, "globalgamemanagers", "globalgamemanagers.assets") or f.startswith("sharedassets")]
env = UnityPy.load(*files)
scene = next(f for n, f in env.files.items() if os.path.basename(n) == level)

go_comps = collections.defaultdict(list)
transforms, gos = {}, {}
for obj in scene.objects.values():
    t = obj.type.name
    if t == "GameObject":
        gos[obj.path_id] = obj.read()
    elif t in ("Transform", "RectTransform"):
        transforms[obj.path_id] = obj.read()

def comp_name(pptr):
    try:
        o = pptr.deref()
        t = o.type.name
        if t == "MonoBehaviour":
            return o.read(check_read=False).m_Script.read().m_ClassName
        return t
    except Exception as e:
        return f"?({e.__class__.__name__})"

for pid, go in gos.items():
    go_comps[pid] = [comp_name(c.component if hasattr(c, "component") else c[1]) for c in go.m_Component]

children = collections.defaultdict(list)
go_of_tf = {}
roots = []
for pid, tf in transforms.items():
    go_of_tf[pid] = tf.m_GameObject.path_id
    parent = tf.m_Father.path_id
    (children[parent] if parent else roots).append(pid)

def walk(tf_id, depth):
    if depth > max_depth:
        return
    g = go_of_tf[tf_id]
    comps = [c for c in go_comps[g] if c not in ("Transform",)]
    print("  " * depth + f"{gos[g].m_Name}  [{', '.join(comps)}]")
    for c in transforms[tf_id].m_Children:
        walk(c.path_id, depth + 1)

for r in roots:
    walk(r, 0)
