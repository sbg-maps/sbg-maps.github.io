"""List the files inside data.unity3d (level files = built scenes) and the scene names from globalgamemanagers."""
import sys
import UnityPy

env = UnityPy.load(sys.argv[1])
for name, f in env.files.items():
    for sub in getattr(f, "files", {}):
        print(sub)
    for obj in getattr(f, "objects", {}).values() if hasattr(f, "objects") else []:
        pass

for obj in env.objects:
    if obj.type.name == "BuildSettings":
        d = obj.read_typetree()
        for i, s in enumerate(d.get("scenes", [])):
            print(f"scene[{i}] {s}")
        break
