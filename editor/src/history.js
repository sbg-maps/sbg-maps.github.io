// Undo/redo by snapshots: holes, golfers, objects (incl. added/removed ones) and terrain.
const LIMIT = 60;

export class History {
  constructor(getProject, onChange) {
    this.getProject = getProject;
    this.onChange = onChange;
    this.undoStack = [];
    this.redoStack = [];
    /** Bumped on every change, so autosave knows when to save. */
    this.version = 0;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Captures everything an edit could change. Terrain is only captured when asked (it is large). */
  capture({ terrain = false, meshes = null } = {}) {
    const p = this.getProject();
    if (!p) return null;
    return {
      holes: structuredClone(p.holes),
      activeHole: p.activeHole,
      golfers: structuredClone(p.golfers),
      objects: p.objects.map((o) => ({ object: o, parent: o.parent, matrix: o.matrix.clone(), userData: structuredClone(o.userData), visible: o.visible })),
      terrain: terrain && p.terrain ? p.terrain.snapshot() : null,
      // Level meshes an edit replaces the geometry of (cutting out a piece); geometries are swapped, never changed.
      meshes: meshes ? meshes.map((mesh) => ({ mesh, geometry: mesh.geometry })) : null,
    };
  }

  /** Runs an edit and records it, so it can be undone. */
  record(edit, { terrain = false, meshes = null } = {}) {
    const before = this.capture({ terrain, meshes });
    edit();
    this.commit(before, { terrain, meshes });
  }

  /** Records an edit whose "before" was captured earlier (e.g. at the start of a brush stroke or drag). */
  commit(before, { terrain = false, meshes = null } = {}) {
    if (!before) return;
    const after = this.capture({ terrain, meshes });
    this.undoStack.push({ before, after });
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.version++;
  }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return false;
    this.apply(step.before);
    this.redoStack.push(step);
    return true;
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return false;
    this.apply(step.after);
    this.undoStack.push(step);
    return true;
  }

  apply(state) {
    const p = this.getProject();
    if (!p || !state) return;
    this.version++;
    p.holes = structuredClone(state.holes);
    p.activeHole = Math.min(state.activeHole, p.holes.length - 1);
    p.golfers = structuredClone(state.golfers);
    // Objects: put back the ones that existed, take out the ones that didn't.
    const keep = new Set(state.objects.map((s) => s.object));
    for (const o of p.objects) if (!keep.has(o)) o.removeFromParent();
    for (const s of state.objects) {
      if (s.object.parent !== s.parent) s.parent.add(s.object);
      s.object.matrix.copy(s.matrix);
      s.object.matrix.decompose(s.object.position, s.object.quaternion, s.object.scale);
      s.object.userData = structuredClone(s.userData);
      s.object.visible = s.visible;
    }
    if (state.terrain && p.terrain) p.terrain.restore(state.terrain);
    for (const { mesh, geometry } of state.meshes ?? []) mesh.geometry = geometry;
    p.collectMaterials();
    p.rebuildMarkers();
    this.onChange?.();
  }
}
