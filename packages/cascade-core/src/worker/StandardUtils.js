// Miscellaneous Helper Functions used in the Standard Library

/** Utility class for caching, hashing, and misc helper functions used by the CAD worker. */
class CascadeStudioUtils {
  constructor() {
    this.argCache = {};
    this.usedHashes = {};
    this.shapeHashes = new WeakMap();
    this.opNumber = 0;
    this.currentOp = '';
    this.currentLineNumber = 0;

    // Modeling history timeline: records sceneShapes state after each operation.
    // Uses a "capture-on-next-call" pattern: when CacheOp fires for op N,
    // it snapshots sceneShapes (which reflects the state after op N-1 completed).
    // The final state is captured after eval() completes.
    this.modelHistory = [];
    this._pendingHistoryOp = null; // {fnName, lineNumber} of the op that just ran

    // Expose instance and methods on self for eval() access
    self.argCache = this.argCache;
    self.usedHashes = this.usedHashes;
    self.shapeHashes = this.shapeHashes;
    self.opNumber = this.opNumber;
    self.modelHistory = this.modelHistory;
    self.CacheOp = this.CacheOp.bind(this);
    self.CheckCache = this.CheckCache.bind(this);
    self.AddToCache = this.AddToCache.bind(this);
    self.ComputeHash = this.ComputeHash.bind(this);
    self.SetShapeHash = this.SetShapeHash.bind(this);
    self.GetShapeHash = this.GetShapeHash.bind(this);
    self.flushHistoryStep = this.flushHistoryStep.bind(this);
    self.addHistoryStep = this.addHistoryStep.bind(this);
    self.recursiveTraverse = CascadeStudioUtils.recursiveTraverse;
    self.Remove = CascadeStudioUtils.Remove;
    self.isArrayLike = CascadeStudioUtils.isArrayLike;
    self.getCallingLocation = CascadeStudioUtils.getCallingLocation;
    self.convertToPnt = CascadeStudioUtils.convertToPnt;
    self.stringToHash = CascadeStudioUtils.stringToHash;
    self.CantorPairing = CascadeStudioUtils.CantorPairing;
  }

  /** Hashes input arguments and checks the cache for that hash.
   * It returns a copy of the cached object if it exists, but will
   * call the `cacheMiss()` callback otherwise. The result will be
   * added to the cache if `GUIState["Cache?"]` is true.
   * @param {IArguments} args - The function's arguments object
   * @param {string} fnName - The calling function's name (required since
   *   arguments.callee is not available in strict mode / ES modules)
   * @param {Function} cacheMiss - Callback if cache miss */
  CacheOp(args, fnName, cacheMiss) {
    // Capture the sceneShapes state left by the PREVIOUS operation.
    // At this point, the previous op has finished mutating sceneShapes,
    // so [...self.sceneShapes] is the correct post-op snapshot.
    this.flushHistoryStep();

    this.currentOp = fnName;
    self.currentOp = this.currentOp;
    this.currentLineNumber = CascadeStudioUtils.getCallingLocation()[0];
    self.currentLineNumber = this.currentLineNumber;
    postMessage({ "type": "Progress", "payload": { "opNumber": this.opNumber++, "opType": fnName } });
    self.opNumber = this.opNumber;

    let toReturn = null;
    let curHash = this.ComputeHash(args, false, fnName);
    this.usedHashes[curHash] = curHash;

    let check = this.CheckCache(curHash);
    if (check && self.GUIState["Cache?"]) {
      toReturn = check;
      this.SetShapeHash(toReturn, this.GetShapeHash(check));
      this.cacheHits = (this.cacheHits || 0) + 1;
    } else {
      toReturn = cacheMiss();
      this.SetShapeHash(toReturn, curHash);
      if (self.GUIState["Cache?"]) { this.AddToCache(curHash, toReturn); }
      this.cacheMisses = (this.cacheMisses || 0) + 1;
    }
    self.cacheHits = this.cacheHits;
    self.cacheMisses = this.cacheMisses;

    // Record this op so the NEXT CacheOp call (or flushHistoryStep) can snapshot its result
    this._pendingHistoryOp = { fnName, lineNumber: this.currentLineNumber };

    postMessage({ "type": "Progress", "payload": { "opNumber": this.opNumber, "opType": null } });
    return toReturn;
  }

  /** Flush the pending history step by snapshotting the current sceneShapes.
   *  Called at the start of each CacheOp (to capture the previous op's result)
   *  and after eval() completes (to capture the final op's result).
   *  Metadata (volume, surfaceArea) is deferred to avoid O(n²) cost during eval. */
  flushHistoryStep() {
    if (this._pendingHistoryOp) {
      this.addHistoryStep(this._pendingHistoryOp.fnName, this._pendingHistoryOp.lineNumber);
      this._pendingHistoryOp = null;
    }
  }

  /** Immediately append a modeling history step for direct scene mutations
   *  (for example imported STEP parts that are pushed without CacheOp).
   *  When `shapesOverride` is supplied, snapshot exactly that prefix. This lets
   *  generated STEP import history represent "all parts loaded up to this line"
   *  and ignore later useStepPart() calls. */
  addHistoryStep(fnName, lineNumber = null, shapesOverride = null) {
    const shapes = this._snapshotSceneShapes(shapesOverride || self.sceneShapes || []);
    this.modelHistory.push({
      fnName,
      lineNumber: lineNumber ?? CascadeStudioUtils.getCallingLocation()[0],
      shapes,
      shapeCount: shapes.length,
    });
    self.modelHistory = this.modelHistory;
  }

  /** Snapshot scene shape handles for later interactive timeline meshing.
   *  Direct imported STEP handles can otherwise be cleared/reused after final render. */
  _snapshotSceneShapes(sourceShapes = self.sceneShapes || []) {
    const snapshot = [];
    const loc = self.oc && self.oc.TopLoc_Location_1 ? new self.oc.TopLoc_Location_1() : null;
    for (const shape of sourceShapes) {
      if (!shape || !shape.IsNull || shape.IsNull()) { continue; }
      try {
        snapshot.push(loc && shape.Moved ? shape.Moved(loc, false) : shape);
      } catch (_) {
        snapshot.push(shape);
      }
    }
    return snapshot;
  }

  /** Returns the cached object if it exists, or null otherwise. */
  CheckCache(hash) { return this.argCache[hash] || null; }

  /** Adds this `shape` to the cache, indexable by `hash`. */
  AddToCache(hash, shape) {
    this.SetShapeHash(shape, hash);
    this.argCache[hash] = shape;
    return hash;
  }

  /** Stores shape metadata without depending on mutable Embind wrappers. */
  SetShapeHash(shape, hash) {
    if (!shape || typeof shape !== 'object') return hash;
    this.shapeHashes.set(shape, hash);
    try { shape.hash = hash; } catch (_) { /* OpenCascade wrappers may expose readonly properties. */ }
    return hash;
  }

  /** Reads shape metadata from side table first, then legacy expando property. */
  GetShapeHash(shape) {
    if (!shape || typeof shape !== 'object') return undefined;
    return this.shapeHashes.has(shape) ? this.shapeHashes.get(shape) : shape.hash;
  }

  /** This function computes a 32-bit integer hash given a set of `arguments`.
   * If `raw` is true, the raw set of sanitized arguments will be returned instead.
   * @param {string} fnName - The calling function's name */
  ComputeHash(args, raw, fnName) {
    let argsString = JSON.stringify(args);
    argsString = argsString.replace(/(\"ptr\"\:(-?[0-9]*?)\,)/g, '');
    argsString = argsString.replace(/(\"ptr\"\:(-?[0-9]*))/g, '');
    if (argsString.includes("ptr")) { console.error("YOU DONE MESSED UP YOUR REGEX."); }
    let hashString = (fnName || '') + argsString;
    if (raw) { return hashString; }
    return CascadeStudioUtils.stringToHash(hashString);
  }

  // --- Static utility methods (no instance state needed) ---

  /** This function recursively traverses x and calls `callback()` on each subelement. */
  static recursiveTraverse(x, callback) {
    if (Object.prototype.toString.call(x) === '[object Array]') {
      x.forEach(function (x1) {
        CascadeStudioUtils.recursiveTraverse(x1, callback);
      });
    } else if ((typeof x === 'object') && (x !== null)) {
      if (x.HashCode) {
        callback(x);
      } else {
        for (let key in x) {
          if (x.hasOwnProperty(key)) {
            CascadeStudioUtils.recursiveTraverse(x[key], callback);
          }
        }
      }
    } else {
      callback(x);
    }
  }

  /** This function returns a version of the `inputArray` without the `objectToRemove`. */
  static Remove(inputArray, objectToRemove) {
    return inputArray.filter((el) => {
      return self.GetShapeHash(el) !== self.GetShapeHash(objectToRemove) ||
             el.ptr  !== objectToRemove.ptr;
    });
  }

  /** This function returns true if item is indexable like an array. */
  static isArrayLike(item) {
    return (
      Array.isArray(item) ||
      (!!item &&
        typeof item === "object" &&
        item.hasOwnProperty("length") &&
        typeof item.length === "number" &&
        item.length > 0 &&
        (item.length - 1) in item
      )
    );
  }

  /** Mega Brittle Line Number Finding algorithm for Handle Backpropagation;
   * only works in Chrome and FF. */
  static getCallingLocation() {
    let errorStack = (new Error).stack;
    let lineAndColumn = [0, 0];

    let matchingString = ", <anonymous>:";
    if (navigator.userAgent.includes("Chrom")) {
      matchingString = ", <anonymous>:";
    } else if (navigator.userAgent.includes("Moz")) {
      matchingString = "eval:";
    } else {
      lineAndColumn[0] = "-1";
      lineAndColumn[1] = "-1";
      return lineAndColumn;
    }

    errorStack.split("\n").forEach((line) => {
      if (line.includes(matchingString)) {
        lineAndColumn = line.split(matchingString)[1].split(':');
      }
    });
    lineAndColumn[0] = parseFloat(lineAndColumn[0]);
    lineAndColumn[1] = parseFloat(lineAndColumn[1]);

    return lineAndColumn;
  }

  /** This function converts either single dimensional
   * array or a gp_Pnt to a gp_Pnt. */
  static convertToPnt(pnt) {
    let point = pnt;
    if (point.length) {
      point = new self.oc.gp_Pnt_3(point[0], point[1], (point[2]) ? point[2] : 0);
    }
    return point;
  }

  /** This function converts a string to a 32bit integer. */
  static stringToHash(string) {
    let hash = 0;
    if (string.length == 0) return hash;
    for (let i = 0; i < string.length; i++) {
      let char = string.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash;
  }

  static CantorPairing(x, y) {
    return ((x + y) * (x + y + 1)) / 2 + y;
  }
}

export { CascadeStudioUtils };
