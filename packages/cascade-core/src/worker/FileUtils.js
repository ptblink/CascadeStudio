// File Import and Export Utilities

/** Handles file import/export operations for the CAD worker. */
class CascadeStudioFileIO {
  constructor() {
    // Register message handlers
    self.messageHandlers["loadPrexistingExternalFiles"] = this.loadPrexistingExternalFiles.bind(this);
    self.messageHandlers["loadFiles"] = this.loadFiles.bind(this);
    self.messageHandlers["getExternalFileNames"] = () => Object.keys(self.externalShapes).filter(k => !k.includes('#'));
    self.messageHandlers["saveShapeSTEP"] = this.saveShapeSTEP.bind(this);
    self.messageHandlers["analyzeSTEP"] = this.analyzeSTEP.bind(this);
    self.messageHandlers["compareCurrentShapeToSTEP"] = this.compareCurrentShapeToSTEP.bind(this);
    self.messageHandlers["generateSTEPImportCode"] = this.generateSTEPImportCode.bind(this);
    self.messageHandlers["clearExternalFiles"] = () => { self.externalShapes = {}; self.externalFileTexts = {}; };

    // Expose methods on self for eval() access
    self.loadPrexistingExternalFiles = this.loadPrexistingExternalFiles.bind(this);
    self.loadFiles = this.loadFiles.bind(this);
    self.importSTEPorIGES = this.importSTEPorIGES.bind(this);
    self.importSTL = this.importSTL.bind(this);
    self.saveShapeSTEP = this.saveShapeSTEP.bind(this);
    self.analyzeSTEP = this.analyzeSTEP.bind(this);
    self.compareCurrentShapeToSTEP = this.compareCurrentShapeToSTEP.bind(this);
    self.generateSTEPImportCode = this.generateSTEPImportCode.bind(this);
    self.renderStepAssembly = this.renderStepAssembly.bind(this);
    self.externalFileTexts = self.externalFileTexts || {};
  }

  /** Synchronously loads the "files" in the current project into
   * the `externalFiles` dictionary upon startup. */
  loadPrexistingExternalFiles(externalFileDict) {
    console.log("Loading Pre-Existing external files...");
    for (let key in externalFileDict) {
      if (key.includes(".stl")) {
        this.importSTL(key, externalFileDict[key].content);
      } else {
        this.importSTEPorIGES(key, externalFileDict[key].content);
      }
    }
  }

  /** Synchronously loads a list of files into the `externalShapes`
   * dictionary and automatically generates STEP JS when STEP import finishes. */
  loadFiles(files) {
    let extFiles = {};
    self.sceneShapes = [];
    const fileList = Array.from(files);
    const totalBytes = fileList.reduce((sum, file) => sum + (file.size || 0), 0) || 1;
    let completedBytes = 0;
    const report = (label, detail, filePercent = 0, fileSize = 0, done = false) => {
      const percent = ((completedBytes + (fileSize * filePercent / 100)) / totalBytes) * 100;
      postMessage({ type: "importProgress", payload: { label, detail, percent, done } });
    };

    console.log("Import started: " + fileList.length + " file(s), " + totalBytes + " bytes");
    report("Importing files", "queued", 0, 0);

    (async () => {
      const results = [];
      for (let index = 0; index < fileList.length; index++) {
        const file = fileList[index];
        const fileName = file.name;
        const fileSize = file.size || 0;
        const isSTEP = /\.(step|stp)$/i.test(fileName);
        console.log("Import [" + (index + 1) + "/" + fileList.length + "]: reading " + fileName + " (" + fileSize + " bytes)");
        const fileText = await CascadeStudioFileIO.loadFileText(file, (readBytes, total) => {
          const p = total ? (readBytes / total) * 70 : 0;
          report("Reading files", fileName + " " + readBytes + "/" + total + " bytes", p, fileSize);
        });

        report("Importing files", "parsing " + fileName, 72, fileSize);
        console.log("Import [" + (index + 1) + "/" + fileList.length + "]: parsing " + fileName);
        let shape = null;
        if (fileName.toLowerCase().includes(".stl")) {
          shape = this.importSTL(fileName, fileText);
        } else {
          shape = this.importSTEPorIGES(fileName, fileText);
        }
        report("Importing files", "storing " + fileName, 92, fileSize);
        extFiles[fileName] = { content: fileText };
        completedBytes += fileSize;
        report("Importing files", "finished " + fileName, 100, 0);
        results.push({ fileName, isSTEP, shape });
      }

      postMessage({ "type": "loadFiles", payload: extFiles });

      const stepImport = results.find(result => result.isSTEP && result.shape);
      if (stepImport) {
        console.log("STEP import complete; generating CascadeStudio JS...");
        postMessage({ type: "importProgress", payload: { label: "Importing files", detail: "generating CascadeStudio JS", percent: 96 } });
        const code = this.generateSTEPImportCode({ fileName: stepImport.fileName });
        postMessage({ "type": "generatedSTEPImportCode", payload: { fileName: stepImport.fileName, code } });
        console.log("Generated CascadeStudio JS for " + stepImport.fileName);
        postMessage({ type: "importProgress", payload: { label: "Import complete", detail: stepImport.fileName, percent: 100, done: true } });
        return;
      }

      for (const result of results) {
        if (result.shape) { self.sceneShapes.push(result.shape); }
      }
      if (self.sceneShapes.length) {
        console.log("File import complete; rendering imported shapes...");
        postMessage({ type: "importProgress", payload: { label: "Importing files", detail: "rendering imported shapes", percent: 96 } });
        const shapeCount = self.sceneShapes.length;
        let response = self.messageHandlers["combineAndRenderShapes"]({ maxDeviation: self.GUIState['MeshRes'] || 0.1 });
        const transferList = self.CascadeStudioWorkerCollectTransferables ? self.CascadeStudioWorkerCollectTransferables(response) : [];
        if (transferList.length > 0) postMessage({ "type": "combineAndRenderShapes", payload: response }, transferList);
        else postMessage({ "type": "combineAndRenderShapes", payload: response });
        postMessage({ type: "importProgress", payload: { label: "Import complete", detail: shapeCount + " shape(s)", percent: 100, done: true } });
      }
    })().catch((error) => {
      console.log("Import failed: " + (error && error.message ? error.message : error));
      postMessage({ type: "importProgress", payload: { label: "Import failed", detail: error && error.message ? error.message : String(error), percent: 100, done: true } });
    });
  }

  /** Parses the ASCII contents of a `.STEP` or `.IGES` File as a
   * Shape into the `externalShapes` dictionary. */
  importSTEPorIGES(fileName, fileText) {
    let oc = self.oc;
    oc.FS.createDataFile("/", fileName, fileText, true, true);

    var reader = null; let tempFilename = fileName.toLowerCase();
    if (tempFilename.endsWith(".step") || tempFilename.endsWith(".stp")) {
      reader = new oc.STEPControl_Reader_1();
    } else if (tempFilename.endsWith(".iges") || tempFilename.endsWith(".igs")) {
      reader = new oc.IGESControl_Reader_1();
    } else { console.error("opencascade.js can't parse this extension! (yet)"); }

    let readResult = reader.ReadFile(fileName);
    if (readResult === oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
      console.log(fileName + " loaded successfully!     Converting to OCC now...");
      reader.TransferRoots(new oc.Message_ProgressRange_1());
      let stepShape = reader.OneShape();

        self.externalShapes[fileName] = stepShape;
      self.SetShapeHash(self.externalShapes[fileName], self.stringToHash(fileName));
      self.externalFileTexts[fileName] = fileText;
      this._extractSubShapes(fileName, stepShape, fileText);
      console.log("STEP shape imported: " + fileName);

      oc.FS.unlink("/" + fileName);
      return self.externalShapes[fileName];
    } else {
      console.error("Something in OCCT went wrong trying to read " + fileName);
      return null;
    }
  }

  /** Parses the contents of an ASCII .STL File as a Shape
   * into the `externalShapes` dictionary. */
  importSTL(fileName, fileText) {
    let oc = self.oc;
    oc.FS.createDataFile("/", fileName, fileText, true, true);

    var reader = new oc.StlAPI_Reader();
    let readShape = new oc.TopoDS_Shape();

    if (reader.Read(readShape, fileName)) {
      console.log(fileName + " loaded successfully!     Converting to OCC now...");

      let solidSTL = new oc.BRepBuilderAPI_MakeSolid_1();
      solidSTL.Add(oc.TopoDS_Cast.Shell_1(readShape));

      self.externalShapes[fileName] = solidSTL.Solid();
      self.SetShapeHash(self.externalShapes[fileName], self.stringToHash(fileName));
      console.log("STL shape imported: " + fileName);

      oc.FS.unlink("/" + fileName);
      return self.externalShapes[fileName];
    } else {
      console.log("Something in OCCT went wrong trying to read " + fileName + ".  \n" +
        "Cascade Studio only imports small ASCII stl files for now!");
      return null;
    }
  }

  /** Returns metadata and stable shape keys for an imported STEP file. */
  analyzeSTEP(payload = {}) {
    const fileName = typeof payload === 'string' ? payload : payload.fileName;
    if (!fileName || !self.externalShapes[fileName]) {
      return { fileName, parts: [], warnings: ["STEP file is not loaded: " + fileName], fallbackUsed: true };
    }
    return this._buildSTEPAnalysis(fileName, self.externalShapes[fileName], self.externalFileTexts[fileName] || "");
  }

  /** Compare the current evaluated shape against an imported STEP shape. */
  compareCurrentShapeToSTEP(payload = {}) {
    const fileName = typeof payload === 'string' ? payload : payload.fileName;
    const tolerance = Number(payload.tolerance ?? 0.25);
    if (!fileName || !self.externalShapes[fileName]) {
      return { success: false, fileName, warnings: ["STEP file is not loaded: " + fileName] };
    }
    if (!self.currentShape) {
      return { success: false, fileName, warnings: ["No current shape to compare. Evaluate generated JS first."] };
    }
    return this._compareShapes(self.externalShapes[fileName], self.currentShape, { tolerance });
  }

  /** Generate CascadeStudio JS that renders an imported STEP assembly by manifest. */
  generateSTEPImportCode(payload = {}) {
    const analysis = this.analyzeSTEP(payload);
    return this._generateSTEPImportCode(analysis, payload);
  }

  /** Render an exact imported STEP assembly from a generated manifest. */
  renderStepAssembly(fileName, parts) {
    if (!self.externalShapes[fileName]) {
      console.error("STEP file is not loaded: " + fileName + ". Import/attach the STEP file before running this script.");
      return null;
    }
    let rendered = [];
    for (let part of (parts || [])) {
      if (part && part.visible === false) { continue; }
      let shape = self.externalShapes[part.source] || self.externalShapes[fileName];
      if (!shape) {
        console.error("STEP part is not loaded: " + (part && part.source));
        continue;
      }
      if (part.translate) { shape = self.Translate(part.translate, shape); }
      if (part.rotate) {
        if (part.rotate[0]) { shape = self.Rotate([1, 0, 0], part.rotate[0], shape); }
        if (part.rotate[1]) { shape = self.Rotate([0, 1, 0], part.rotate[1], shape); }
        if (part.rotate[2]) { shape = self.Rotate([0, 0, 1], part.rotate[2], shape); }
      }
      rendered.push(shape);
      self.sceneShapes.push(shape);
    }
    return rendered.length === 1 ? rendered[0] : rendered;
  }

  _extractSubShapes(fileName, rootShape, fileText = "") {
    const shapes = this._collectSubShapes(rootShape);
    for (let index = 0; index < shapes.length; index++) {
      const kind = shapes[index].ShapeType ? this._shapeTypeName(shapes[index].ShapeType()) : 'shape';
      const n = String(index + 1).padStart(3, '0');
      const shapeKey = fileName + '#' + kind + '_' + n;
      self.externalShapes[shapeKey] = shapes[index];
      self.SetShapeHash(self.externalShapes[shapeKey], self.stringToHash(shapeKey));
    }
    return this._buildSTEPAnalysis(fileName, rootShape, fileText);
  }

  _buildSTEPAnalysis(fileName, rootShape, fileText = "") {
    const productContexts = this._extractSTEPProductContexts(fileText);
    const labels = productContexts.map(p => p.name);
    const shapes = this._collectSubShapes(rootShape);
    const warnings = [];
    const parts = shapes.map((shape, index) => {
      const n = String(index + 1).padStart(3, '0');
      const kind = shape.ShapeType ? this._shapeTypeName(shape.ShapeType()) : 'shape';
      const shapeKey = fileName + '#' + kind + '_' + n;
      return {
        id: kind + '_' + n,
        label: labels[index] || kind.replace('_', ' ') + ' ' + n,
        shapeKey,
        source: shapeKey,
        visible: true,
        translate: [0, 0, 0],
        rotate: [0, 0, 0],
        stepContext: productContexts[index]?.records || [],
        approximate: this._approximateShape(shape),
        shape
      };
    });
    if (parts.length === 0) {
      warnings.push('No sub-shapes found; generated code will render the combined STEP shape.');
      parts.push({ id: 'assembly_001', label: labels[0] || 'Imported Assembly', shapeKey: fileName, source: fileName, visible: true, translate: [0, 0, 0], rotate: [0, 0, 0], stepContext: productContexts[0]?.records || [], shape: rootShape });
    }
    return { fileName, parts: parts.map(({ shape, ...p }) => p), warnings, fallbackUsed: parts.length === 1 && parts[0].source === fileName };
  }

  _collectSubShapes(shape) {
    const oc = self.oc;
    const out = [];
    for (let type of [oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHELL]) {
      let exp = new oc.TopExp_Explorer_2(shape, type, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      for (exp.Init(shape, type, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); exp.More(); exp.Next()) {
        out.push(exp.Current());
      }
      if (out.length) { break; }
    }
    return out;
  }

  _shapeTypeName(shapeType) {
    const oc = self.oc;
    if (shapeType === oc.TopAbs_ShapeEnum.TopAbs_SOLID) return 'solid';
    if (shapeType === oc.TopAbs_ShapeEnum.TopAbs_SHELL) return 'shell';
    if (shapeType === oc.TopAbs_ShapeEnum.TopAbs_COMPOUND) return 'compound';
    return 'shape';
  }

  _extractSTEPProductNames(fileText) {
    return this._extractSTEPProductContexts(fileText).map(p => p.name);
  }

  _extractSTEPProductContexts(fileText) {
    const contexts = [];
    const records = this._splitSTEPRecords(fileText);
    for (const record of records) {
      const match = /PRODUCT\s*\(\s*'((?:[^']|'')*)'/i.exec(record.text);
      if (!match) { continue; }
      const name = match[1].replace(/''/g, "'").trim();
      if (!name || contexts.some(c => c.name === name)) { continue; }
      const refs = new Set([record.id]);
      const related = [record];
      for (let depth = 0; depth < 3; depth++) {
        let grew = false;
        for (const candidate of records) {
          if (related.includes(candidate)) { continue; }
          const mentionsRef = [...refs].some(ref => ref && candidate.text.includes(ref));
          if (!mentionsRef) { continue; }
          related.push(candidate);
          if (candidate.id && !refs.has(candidate.id)) { refs.add(candidate.id); grew = true; }
        }
        if (!grew) { break; }
      }
      contexts.push({ name, records: related.slice(0, 12).map(r => r.text) });
    }
    return contexts;
  }

  _splitSTEPRecords(fileText) {
    const records = [];
    const re = /#[0-9]+\s*=.*?;/gs;
    let match;
    while ((match = re.exec(fileText || ''))) {
      const text = match[0].replace(/\r\n/g, '\n').trim();
      const id = /^#[0-9]+/.exec(text)?.[0];
      records.push({ id, text });
    }
    return records;
  }

  _approximateShape(shape) {
    const bbox = this._meshBounds(shape);
    if (!bbox) { return { kind: 'fallback', confidence: 0, reason: 'no mesh bounds' }; }
    const dx = bbox.max[0] - bbox.min[0];
    const dy = bbox.max[1] - bbox.min[1];
    const dz = bbox.max[2] - bbox.min[2];
    const c = [(bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2];
    const maxDim = Math.max(dx, dy, dz);
    const eps = Math.max(maxDim * 1e-4, 1e-9);
    const features = this._shapeFeatures(shape);
    const volume = features.volume;
    const boxVolume = Math.max(dx * dy * dz, eps);
    const fill = volume / boxVolume;
    const xyRound = Math.abs(dx - dy) <= Math.max(dx, dy) * 0.08;
    const zAxis = (axis) => !axis || Math.abs(Math.abs(axis[2]) - 1) < 0.02;
    const zCyls = features.cylinders.filter(cy => zAxis(cy.axis) && Number.isFinite(cy.radius));
    const uniqueCyls = this._uniqueCylinders(zCyls, Math.max(maxDim * 1e-3, 1e-6));
    const roundness = Math.min(dx, dy) / Math.max(dx, dy, eps);

    // Prefer analytic STEP topology over bbox guesses when available.
    if (features.spheres.length === 1 && features.faces <= 2) {
      const s = features.spheres[0];
      const r = s.radius || (dx + dy + dz) / 6;
      return { kind: 'sphere', radius: r, translate: s.center || c, confidence: 0.95, reason: 'spherical face' };
    }
    if (uniqueCyls.length === 1 && features.cones.length === 0 && (roundness > 0.82 || features.planes >= 2)) {
      const r = uniqueCyls[0].radius || (dx + dy) / 4;
      const cylVolume = Math.PI * r * r * dz;
      const ratio = cylVolume ? volume / cylVolume : 0;
      if (features.planes >= 2 || ratio > 0.72) {
        return { kind: 'cylinder', radius: r, height: dz, translate: c, confidence: 0.9, reason: 'cylindrical side face(s)' };
      }
    }
    if (features.cones.length === 1 && zAxis(features.cones[0].axis)) {
      const cone = features.cones[0];
      const r1 = Math.max(dx, dy) / 2;
      let r2 = 0;
      if (volume && dz > eps) {
        // V = h*pi/3*(r1^2 + r1*r2 + r2^2). Solve conservative small root.
        const target = (3 * volume) / (Math.PI * dz);
        const disc = Math.max(0, 4 * target - 3 * r1 * r1);
        r2 = Math.max(0, (-r1 + Math.sqrt(disc)) / 2);
      }
      return { kind: 'cone', radius1: r1, radius2: r2, height: dz, translate: [c[0], c[1], bbox.min[2]], confidence: 0.82, reason: 'conical side face' };
    }

    const holes = this._detectVerticalHoles(uniqueCyls, bbox, features, eps);
    if (features.planes >= 2 && dz <= Math.max(dx, dy) * 0.22 && fill > 0.18 && holes.length) {
      return { kind: 'plate', size: [dx, dy, dz], translate: c, holes, confidence: 0.82, reason: 'thin planar plate with cylindrical inner faces' };
    }
    if (features.planes >= 2 && dz <= Math.max(dx, dy) * 0.18 && fill > 0.55) {
      return { kind: 'plate', size: [dx, dy, dz], translate: c, holes: [], confidence: 0.74, reason: 'thin planar plate bbox' };
    }
    if (uniqueCyls.length >= 2 && roundness > 0.82 && dz > eps) {
      const radii = uniqueCyls.map(cy => cy.radius).sort((a, b) => b - a);
      if (radii[1] < radii[0] * 0.82) {
        return { kind: 'washer', outerRadius: radii[0], innerRadius: radii[1], height: dz, translate: c, confidence: 0.78, reason: 'concentric cylindrical faces' };
      }
    }
    if (features.faces === 6 && features.planes === 6 && fill > 0.88) {
      return { kind: 'box', size: [dx, dy, dz], translate: c, confidence: 0.9, reason: 'six planar faces' };
    }
    if (features.faces <= 2 && xyRound) {
      return { kind: 'sphere', radius: (dx + dy + dz) / 6, translate: c, confidence: 0.65, reason: 'round bbox with few faces' };
    }
    if (xyRound && dz > eps && features.faces <= 3) {
      const r = (dx + dy) / 4;
      const cylVolume = Math.PI * r * r * dz;
      const ratio = cylVolume ? volume / cylVolume : 0;
      if (ratio > 0.82) { return { kind: 'cylinder', radius: r, height: dz, translate: c, confidence: 0.7, reason: 'cylinder volume ratio' }; }
      if (ratio > 0.22) { return { kind: 'cone', radius1: r, radius2: Math.max(0, r * Math.sqrt(Math.max(0, ratio * 3 - 1))), height: dz, translate: [c[0], c[1], bbox.min[2]], confidence: 0.55, reason: 'cone volume ratio' }; }
    }
    if (features.planes >= 2 && features.cylinders.length + features.cones.length + features.spheres.length > 0 && xyRound) {
      return { kind: 'revolve', radius: Math.max(dx, dy) / 2, height: dz, translate: c, confidence: 0.55, reason: 'axisymmetric analytic faces' };
    }
    const sketch = this._planarSketchApprox(shape, bbox, features, eps);
    if (sketch && features.faces >= 2) {
      return { kind: 'sketchExtrude', sketch, height: sketch.height || dz, translate: sketch.translate || [0, 0, 0], confidence: 0.68, reason: 'planar face boundary' };
    }
    if (sketch) {
      return { kind: 'sketchFace', sketch, translate: sketch.translate || [0, 0, 0], confidence: 0.7, reason: 'planar face boundary' };
    }
    if (features.faces >= 4 && features.planes >= 2 && fill > 0.45) {
      return { kind: 'extrude', size: [dx, dy], height: dz, translate: c, confidence: 0.45, reason: 'planar prism bbox' };
    }
    return { kind: 'fallback', confidence: 0, reason: 'complex topology' };
  }

  _planarSketchApprox(shape, bbox, features, eps) {
    const oc = self.oc;
    const ST = oc.GeomAbs_SurfaceType || {};
    const candidates = [];
    self.ForEachFace(shape, (index, face) => {
      try {
        const surf = new oc.BRepAdaptor_Surface_2(face, true);
        if (surf.GetType() !== ST.GeomAbs_Plane) { return; }
        const normal = this._axisDir(surf.Plane ? surf.Plane() : null) || [0, 0, 1];
        const plane = Math.abs(normal[2]) > 0.98 ? 'XY' : (Math.abs(normal[1]) > 0.98 ? 'XZ' : (Math.abs(normal[0]) > 0.98 ? 'YZ' : null));
        if (!plane) { return; }
        const edges = [];
        self.ForEachEdge(face, (edgeIndex, edge) => {
          const info = self.EdgeInfo ? self.EdgeInfo(edge) : null;
          if (!info || info.length <= eps) { return; }
          if (!['Line', 'Circle'].includes(info.type)) { return; }
          edges.push(info);
        });
        if (edges.length < 3 || edges.length > 80) { return; }
        const ordered = this._orderSketchEdges(edges, eps * 20);
        if (!ordered || ordered.length < 3) { return; }
        const coords = ordered.map(e => ({ type: e.type, start: this._projectPoint(e.startPoint, plane), mid: this._projectPoint(e.midpoint, plane), end: this._projectPoint(e.endPoint, plane) }));
        const area = Math.abs(this._polygonArea(coords.map(e => e.start)));
        if (area <= eps * eps) { return; }
        const offset = plane === 'XY' ? ordered[0].startPoint[2] : (plane === 'XZ' ? ordered[0].startPoint[1] : ordered[0].startPoint[0]);
        candidates.push({ plane, normal, coords, area, offset });
      } catch (e) {}
    });
    if (!candidates.length) { return null; }
    candidates.sort((a, b) => b.area - a.area);
    const best = candidates[0];
    const axisMin = best.plane === 'XY' ? bbox.min[2] : (best.plane === 'XZ' ? bbox.min[1] : bbox.min[0]);
    const axisMax = best.plane === 'XY' ? bbox.max[2] : (best.plane === 'XZ' ? bbox.max[1] : bbox.max[0]);
    const span = axisMax - axisMin;
    const height = Math.abs(best.offset - axisMax) < Math.abs(best.offset - axisMin) ? -span : span;
    const translate = best.plane === 'XY' ? [0, 0, best.offset] : (best.plane === 'XZ' ? [0, best.offset, 0] : [best.offset, 0, 0]);
    return { plane: best.plane, edges: best.coords, height, translate };
  }

  _projectPoint(p, plane) {
    if (plane === 'XZ') { return [p[0], p[2]]; }
    if (plane === 'YZ') { return [p[1], p[2]]; }
    return [p[0], p[1]];
  }

  _polygonArea(points) {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i], q = points[(i + 1) % points.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  _orderSketchEdges(edges, tol) {
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const remaining = edges.slice();
    const ordered = [remaining.shift()];
    while (remaining.length) {
      const last = ordered[ordered.length - 1].endPoint;
      let best = -1, flip = false, bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const ds = dist(last, remaining[i].startPoint);
        const de = dist(last, remaining[i].endPoint);
        if (ds < bestD) { best = i; flip = false; bestD = ds; }
        if (de < bestD) { best = i; flip = true; bestD = de; }
      }
      if (best < 0 || bestD > tol) { return null; }
      const next = remaining.splice(best, 1)[0];
      if (flip) {
        const s = next.startPoint; next.startPoint = next.endPoint; next.endPoint = s;
      }
      ordered.push(next);
    }
    return dist(ordered[ordered.length - 1].endPoint, ordered[0].startPoint) <= tol ? ordered : null;
  }

  _shapeFeatures(shape) {
    const oc = self.oc;
    const ST = oc.GeomAbs_SurfaceType || {};
    const features = { faces: 0, planes: 0, cylinders: [], cones: [], spheres: [], others: 0, volume: 0 };
    try {
      const props = new oc.GProp_GProps_1();
      oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
      features.volume = Math.abs(props.Mass());
    } catch (e) { features.volume = 0; }
    self.ForEachFace(shape, (index, face) => {
      features.faces++;
      try {
        const surf = new oc.BRepAdaptor_Surface_2(face, true);
        const type = surf.GetType();
        if (type === ST.GeomAbs_Plane) { features.planes++; return; }
        if (type === ST.GeomAbs_Cylinder) {
          const cyl = surf.Cylinder ? surf.Cylinder() : null;
          features.cylinders.push({ radius: this._safeCall(cyl, 'Radius'), axis: this._axisDir(cyl), center: this._location(cyl) });
          return;
        }
        if (type === ST.GeomAbs_Cone) {
          const cone = surf.Cone ? surf.Cone() : null;
          features.cones.push({ radius: this._safeCall(cone, 'RefRadius'), semiAngle: this._safeCall(cone, 'SemiAngle'), axis: this._axisDir(cone) });
          return;
        }
        if (type === ST.GeomAbs_Sphere) {
          const sphere = surf.Sphere ? surf.Sphere() : null;
          features.spheres.push({ radius: this._safeCall(sphere, 'Radius'), center: this._location(sphere) });
          return;
        }
        features.others++;
      } catch (e) { features.others++; }
    });
    return features;
  }

  _uniqueCylinders(cylinders, tol) {
    const out = [];
    for (const cy of cylinders || []) {
      if (!Number.isFinite(cy.radius)) { continue; }
      const p = cy.center || [0, 0, 0];
      const existing = out.find(o => Math.abs(o.radius - cy.radius) <= tol && Math.hypot((o.center?.[0] || 0) - p[0], (o.center?.[1] || 0) - p[1]) <= tol * 4);
      if (!existing) { out.push(cy); }
    }
    return out;
  }

  _detectVerticalHoles(cylinders, bbox, features, eps) {
    const cx = (bbox.min[0] + bbox.max[0]) / 2;
    const cy0 = (bbox.min[1] + bbox.max[1]) / 2;
    const maxR = Math.max(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1]) / 2;
    return (cylinders || [])
      .filter(c => Number.isFinite(c.radius) && c.radius < maxR * 0.45)
      .map(c => ({ radius: c.radius, translate: [c.center?.[0] ?? cx, c.center?.[1] ?? cy0, (bbox.min[2] + bbox.max[2]) / 2] }))
      .filter((h, i, a) => a.findIndex(o => Math.abs(o.radius - h.radius) <= eps && Math.hypot(o.translate[0] - h.translate[0], o.translate[1] - h.translate[1]) <= eps * 4) === i);
  }

  _safeCall(obj, method) {
    try { return obj && obj[method] ? obj[method]() : undefined; } catch (e) { return undefined; }
  }

  _location(obj) {
    try {
      const p = obj.Position ? obj.Position().Location() : (obj.Location ? obj.Location() : null);
      return p ? [p.X(), p.Y(), p.Z()] : undefined;
    } catch (e) { return undefined; }
  }

  _axisDir(obj) {
    try {
      const axis = obj.Position ? obj.Position().Direction() : (obj.Axis ? obj.Axis().Direction() : null);
      return axis ? [axis.X(), axis.Y(), axis.Z()] : undefined;
    } catch (e) { return undefined; }
  }

  _meshBounds(shape) {
    const points = this._meshPoints(shape);
    if (!points.length) { return null; }
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const p of points) {
      min[0] = Math.min(min[0], p[0]); min[1] = Math.min(min[1], p[1]); min[2] = Math.min(min[2], p[2]);
      max[0] = Math.max(max[0], p[0]); max[1] = Math.max(max[1], p[1]); max[2] = Math.max(max[2], p[2]);
    }
    return { min, max };
  }

  _meshPoints(shape, maxPoints = 2500) {
    try {
      const mesh = self.ShapeToMesh(shape, self.GUIState['MeshRes'] || 0.1, {}, {});
      const raw = [];
      for (let face of mesh[0] || []) {
        const v = face.vertex_coord || [];
        for (let i = 0; i < v.length; i += 3) { raw.push([v[i], v[i + 1], v[i + 2]]); }
      }
      if (raw.length <= maxPoints) { return raw; }
      const step = raw.length / maxPoints;
      const sampled = [];
      for (let i = 0; i < maxPoints; i++) { sampled.push(raw[Math.floor(i * step)]); }
      return sampled;
    } catch (e) { return []; }
  }

  _shapeStats(shape) {
    const features = this._shapeFeatures(shape);
    let area = 0;
    try {
      const props = new self.oc.GProp_GProps_1();
      self.oc.BRepGProp.SurfaceProperties_1(shape, props, false, false);
      area = Math.abs(props.Mass());
    } catch (e) {}
    return { bounds: this._meshBounds(shape), volume: features.volume, surfaceArea: area, faces: features.faces, planes: features.planes, cylinders: features.cylinders.length, cones: features.cones.length, spheres: features.spheres.length };
  }

  _compareShapes(reference, candidate, options = {}) {
    const tolerance = Number(options.tolerance ?? 0.25);
    const ref = this._shapeStats(reference);
    const cand = this._shapeStats(candidate);
    const refPts = this._meshPoints(reference);
    const candPts = this._meshPoints(candidate);
    const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), 1e-9);
    const bboxDelta = ref.bounds && cand.bounds ? Math.max(...ref.bounds.min.map((v, i) => Math.abs(v - cand.bounds.min[i])), ...ref.bounds.max.map((v, i) => Math.abs(v - cand.bounds.max[i]))) : Infinity;
    const nearest = (p, pts) => {
      let best = Infinity;
      for (const q of pts) {
        const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        if (d < best) { best = d; }
      }
      return best;
    };
    const directed = (a, b) => {
      if (!a.length || !b.length) { return { max: Infinity, mean: Infinity }; }
      let max = 0, sum = 0;
      for (const p of a) { const d = nearest(p, b); max = Math.max(max, d); sum += d; }
      return { max, mean: sum / a.length };
    };
    const a = directed(refPts, candPts);
    const b = directed(candPts, refPts);
    const hausdorff = Math.max(a.max, b.max);
    const meanDistance = (a.mean + b.mean) / 2;
    const volumeDelta = rel(ref.volume, cand.volume);
    const areaDelta = rel(ref.surfaceArea, cand.surfaceArea);
    const score = Math.max(0, 1 - Math.min(1, (bboxDelta / Math.max(tolerance, 1e-9) + volumeDelta * 4 + areaDelta * 2 + meanDistance / Math.max(tolerance, 1e-9)) / 8));
    return { success: bboxDelta <= tolerance && volumeDelta <= 0.02 && areaDelta <= 0.05, tolerance, score, bboxDelta, volumeDelta, areaDelta, hausdorff, meanDistance, reference: ref, candidate: cand, sampleCounts: { reference: refPts.length, candidate: candPts.length } };
  }

  _generateSTEPImportCode(analysis, options = {}) {
    const safeFileName = JSON.stringify(analysis.fileName || 'model.step');
    const warnings = (analysis.warnings || []).map(w => '// Warning: ' + w).join('\n');
    const usedNames = new Set();
    const safeIdentifier = (value, fallback) => {
      let name = String(value || fallback || 'part')
        .replace(/[^A-Za-z0-9_$]+/g, '_')
        .replace(/^([^A-Za-z_$])/, '_$1')
        .replace(/^_+|_+$/g, '') || fallback || 'part';
      if (!/^[A-Za-z_$]/.test(name)) { name = '_' + name; }
      let unique = name;
      let i = 2;
      while (usedNames.has(unique)) { unique = name + '_' + i++; }
      usedNames.add(unique);
      return unique;
    };
    const fmt = (n) => Number.isFinite(n) ? Number(n.toPrecision(6)) : 0;
    const arr = (a) => '[' + (a || []).map(fmt).join(', ') + ']';
    const stepCommentLines = (records) => {
      const out = [];
      for (const record of records || []) {
        for (const line of String(record).split('\n')) {
          out.push('// STEP: ' + line);
        }
      }
      return out;
    };
    const emitApprox = (part) => {
      const a = part.approximate || { kind: 'fallback' };
      if (a.kind === 'box') { return `Translate(${arr(a.translate)}, Box(${fmt(a.size[0])}, ${fmt(a.size[1])}, ${fmt(a.size[2])}, true))`; }
      if (a.kind === 'sphere') { return `Translate(${arr(a.translate)}, Sphere(${fmt(a.radius)}))`; }
      if (a.kind === 'cylinder') { return `Translate(${arr(a.translate)}, Cylinder(${fmt(a.radius)}, ${fmt(a.height)}, true))`; }
      if (a.kind === 'washer') {
        return `(function(){ let outer = Cylinder(${fmt(a.outerRadius)}, ${fmt(a.height)}, true); let inner = Cylinder(${fmt(a.innerRadius)}, ${fmt(a.height * 1.1)}, true); return Translate(${arr(a.translate)}, Difference(outer, [inner])); })()`;
      }
      if (a.kind === 'plate') {
        const holes = (a.holes || []).map((h, i) => `let h${i} = Translate([${fmt((h.translate?.[0] || 0) - (a.translate?.[0] || 0))}, ${fmt((h.translate?.[1] || 0) - (a.translate?.[1] || 0))}, 0], Cylinder(${fmt(h.radius)}, ${fmt(a.size[2] * 1.2)}, true));`).join(' ');
        const holeNames = (a.holes || []).map((h, i) => `h${i}`).join(', ');
        const base = `Box(${fmt(a.size[0])}, ${fmt(a.size[1])}, ${fmt(a.size[2])}, true)`;
        return `(function(){ let plate = ${base}; ${holes} return Translate(${arr(a.translate)}, ${(a.holes || []).length ? `Difference(plate, [${holeNames}])` : 'plate'}); })()`;
      }
      if (a.kind === 'cone') { return `Translate(${arr(a.translate)}, Cone(${fmt(a.radius1)}, ${fmt(a.radius2)}, ${fmt(a.height)}))`; }
      if (a.kind === 'extrude') {
        return `(function(){ let f = new Sketch([${fmt(-a.size[0] / 2)}, ${fmt(-a.size[1] / 2)}]).LineTo([${fmt(a.size[0] / 2)}, ${fmt(-a.size[1] / 2)}]).LineTo([${fmt(a.size[0] / 2)}, ${fmt(a.size[1] / 2)}]).LineTo([${fmt(-a.size[0] / 2)}, ${fmt(a.size[1] / 2)}]).End(true).Face(); return Translate(${arr(a.translate)}, Extrude(f, [0, 0, ${fmt(a.height)}])); })()`;
      }
      const emitSketch = (sk) => {
        const edge0 = sk.edges?.[0];
        if (!edge0) { return 'null'; }
        let code = `new Sketch([${fmt(edge0.start[0])}, ${fmt(edge0.start[1])}]${sk.plane && sk.plane !== 'XY' ? `, ${JSON.stringify(sk.plane)}` : ''})`;
        const closeDist = (p, q) => Math.hypot((p?.[0] || 0) - (q?.[0] || 0), (p?.[1] || 0) - (q?.[1] || 0));
        const edges = sk.edges.slice();
        if (edges.length && closeDist(edges[edges.length - 1].end, edge0.start) < 1e-7) { edges.pop(); }
        for (const e of edges) {
          if (e.type === 'Circle') { code += `.ArcTo([${fmt(e.mid[0])}, ${fmt(e.mid[1])}], [${fmt(e.end[0])}, ${fmt(e.end[1])}])`; }
          else { code += `.LineTo([${fmt(e.end[0])}, ${fmt(e.end[1])}])`; }
        }
        return code + '.End(true).Face()';
      };
      if (a.kind === 'sketchFace') { return `(function(){ return Translate(${arr(a.translate)}, ${emitSketch(a.sketch)}); })()`; }
      if (a.kind === 'sketchExtrude') {
        const dir = a.sketch?.plane === 'XZ' ? `[0, ${fmt(a.height)}, 0]` : (a.sketch?.plane === 'YZ' ? `[${fmt(a.height)}, 0, 0]` : `[0, 0, ${fmt(a.height)}]`);
        return `(function(){ let f = Translate(${arr(a.translate)}, ${emitSketch(a.sketch)}); return Extrude(f, ${dir}); })()`;
      }
      if (a.kind === 'revolve') {
        return `(function(){ let p = new Sketch([0, ${fmt(-a.height / 2)}], "XZ").LineTo([${fmt(a.radius)}, ${fmt(-a.height / 2)}]).LineTo([${fmt(a.radius)}, ${fmt(a.height / 2)}]).LineTo([0, ${fmt(a.height / 2)}]).End(true).Face(); return Translate(${arr(a.translate)}, Revolve(p, 360)); })()`;
      }
      return `useStepPart(${JSON.stringify(part.source)}, ${JSON.stringify(part.label || part.id || 'part')})`;
    };
    const approximate = options?.approximate === true || options?.exactByDefault === false;
    const singleAssembly = options?.singleAssembly === true || options?.exactByDefault === true;
    const lines = singleAssembly ? [
      '// Generated Exact STEP JS from imported STEP',
      '// Renders the imported STEP assembly as one OCCT shape.'
    ] : approximate ? [
      '// Generated Approximate Parametric JS from imported STEP',
      '// Reverse engineered best-effort primitives; complex parts fall back to exact STEP sub-shapes in original OCCT locations.'
    ] : [
      '// Generated Exact STEP Parts JS from imported STEP',
      '// Declares each detected STEP part as its own JS variable.',
      '// Each variable references the exact imported OCCT sub-shape; no parametric reverse engineering.'
    ];
    if (warnings) { lines.push(warnings); }
    lines.push('', 'const STEP_FILE = ' + safeFileName + ';', '');
    if (singleAssembly) {
      lines.push('let importedAssembly = externalShapes[STEP_FILE];');
      lines.push('if (!importedAssembly) {');
      lines.push('  console.error("STEP file is not loaded: " + STEP_FILE + ". Import/attach it before running this script.");');
      lines.push('} else {');
      lines.push('  sceneShapes.push(importedAssembly);');
      lines.push('  console.log("Loaded exact STEP assembly: " + STEP_FILE);');
      lines.push('}');
      return lines.join('\n');
    }
    lines.push('const STEP_PART_TOTAL = ' + (analysis.parts || []).length + ';');
    lines.push('let STEP_PART_LOADED = 0;');
    lines.push('function useStepPart(source, label, translate = [0, 0, 0], rotate = [0, 0, 0]) {');
    lines.push('  let shape = externalShapes[source];');
    lines.push('  if (!shape) {');
    lines.push('    console.error("STEP part is not loaded: " + source + ". Import/attach " + STEP_FILE + " before running this script.");');
    lines.push('    return null;');
    lines.push('  }');
    lines.push('  if (translate[0] || translate[1] || translate[2]) { shape = Translate(translate, shape); }');
    lines.push('  if (rotate[0]) { shape = Rotate([1, 0, 0], rotate[0], shape); }');
    lines.push('  if (rotate[1]) { shape = Rotate([0, 1, 0], rotate[1], shape); }');
    lines.push('  if (rotate[2]) { shape = Rotate([0, 0, 1], rotate[2], shape); }');
    lines.push('  sceneShapes.push(shape);');
    lines.push('  STEP_PART_LOADED += 1;');
    lines.push('  console.log("Loaded STEP part: " + label);');
    lines.push('  console.log("__CASCADE_STEP_PART_PROGRESS__" + JSON.stringify({ current: STEP_PART_LOADED, total: STEP_PART_TOTAL, label }));');
    lines.push('  return shape;');
    lines.push('}', '');
    const partNames = [];
    const groupCounts = approximate ? this._approxGroups(analysis.parts || []) : [];
    if (groupCounts.length) {
      lines.push('// Repeated solids detected: ' + groupCounts.map(g => g.count + 'x ' + g.signature).join('; '));
      lines.push('');
    }
    const hasGlass = approximate && (analysis.parts || []).some(p => this._looksLikeGlass(p));
    if (hasGlass) {
      lines.push('// Material hint: transparent/glass-like parts detected. If renderer supports per-shape material, set opacity ~0.25, color light blue.');
      lines.push('');
    }
    for (let part of analysis.parts || []) {
      const name = safeIdentifier(part.id || part.label, 'part');
      partNames.push(name);
      const approx = part.approximate || {};
      const confidence = Number.isFinite(approx.confidence) ? `, confidence ${fmt(approx.confidence)}` : '';
      const reason = approx.reason ? `, ${approx.reason}` : '';
      lines.push('// ' + (part.label || part.id || name) + ' — ' + (approx.kind || 'fallback') + confidence + reason);
      const stepLines = stepCommentLines(part.stepContext);
      if (stepLines.length) {
        lines.push('// Source STEP records copied verbatim:');
        lines.push(...stepLines);
      }
      lines.push('let ' + name + ' = ' + (approximate ? emitApprox(part) : `useStepPart(${JSON.stringify(part.source)}, ${JSON.stringify(part.label || part.id || name)})`) + ';');
      lines.push('');
    }
    lines.push('// Generated parts: ' + partNames.join(', '));
    lines.push('');
    return lines.join('\n');
  }

  _approxGroups(parts) {
    const sig = (p) => {
      const a = p.approximate || {};
      const nums = [];
      if (a.size) { nums.push(...a.size); }
      for (const k of ['radius', 'height', 'outerRadius', 'innerRadius', 'radius1', 'radius2']) {
        if (Number.isFinite(a[k])) { nums.push(a[k]); }
      }
      return (a.kind || 'fallback') + '(' + nums.map(n => Number(n).toPrecision(4)).join(',') + ')';
    };
    const counts = new Map();
    for (const p of parts || []) {
      const a = p.approximate || {};
      if (!a.kind || a.kind === 'fallback') { continue; }
      const s = sig(p);
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    return [...counts.entries()].filter(([, count]) => count > 1).map(([signature, count]) => ({ signature, count }));
  }

  _looksLikeGlass(part) {
    const text = ((part.label || '') + ' ' + (part.id || '')).toLowerCase();
    if (/glass|window|lens|transparent|clear|pane/.test(text)) { return true; }
    const a = part.approximate || {};
    return a.kind === 'plate' && a.confidence < 0.8 && /cover|screen/.test(text);
  }

  /** Returns `currentShape` `.STEP` file content. */
  saveShapeSTEP(filename = "CascadeStudioPart.step") {
    let oc = self.oc;
    let writer = new oc.STEPControl_Writer_1();
    let transferResult = writer.Transfer_1(self.currentShape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, new oc.Message_ProgressRange_1());
    if (transferResult === oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
      let writeResult = writer.Write(filename);
      if (writeResult === oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
        let stepFileText = oc.FS.readFile("/" + filename, { encoding: "utf8" });
        oc.FS.unlink("/" + filename);
        return stepFileText;
      } else {
        console.error("WRITE STEP FILE FAILED.");
      }
    } else {
      console.error("TRANSFER TO STEP WRITER FAILED.");
    }
  }

  /** Reads text contents of a file and reports byte progress. */
  static async loadFileText(file, onProgress = () => {}) {
    const total = file.size || 0;
    if (file.stream && TextDecoder) {
      const reader = file.stream().getReader();
      const decoder = new TextDecoder();
      let chunks = '';
      let loaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.byteLength;
        chunks += decoder.decode(value, { stream: true });
        onProgress(loaded, total);
      }
      chunks += decoder.decode();
      onProgress(total, total);
      return chunks;
    }

    const text = new FileReaderSync().readAsText(file);
    onProgress(total, total);
    return text;
  }

  /** Synchronously reads the text contents of a file. */
  static async loadFileSync(file) {
    return CascadeStudioFileIO.loadFileText(file);
  }
}

export { CascadeStudioFileIO };
