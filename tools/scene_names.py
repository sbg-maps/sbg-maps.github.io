import sys, UnityPy
env = UnityPy.load(sys.argv[1])
for obj in env.objects:
    if obj.type.name == "BuildSettings":
        for i, s in enumerate(obj.read_typetree()["scenes"]):
            print(f"level{i}: {s}")
