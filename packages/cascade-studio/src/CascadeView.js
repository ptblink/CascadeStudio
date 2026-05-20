// This file governs the 3D Viewport which displays the 3D Model
// It is also in charge of saving to STL and OBJ
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { HandleManager } from './CascadeViewHandles.js';

/** Base class for a 3D viewport environment.
 *  Includes floor, grid, fog, camera, lights, and orbit controls. */
class Environment {
  constructor(goldenContainer) {
    this.goldenContainer = goldenContainer;

    // Get the current Width and Height of the Parent Element
    this.parentWidth  = this.goldenContainer.width;
    this.parentHeight = this.goldenContainer.height;

    // Create the Canvas and WebGL Renderer
    this.curCanvas = document.createElement('canvas');
    this.goldenContainer.element.appendChild(this.curCanvas);
    THREE.ColorManagement.enabled = false;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.curCanvas, antialias: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(this.parentWidth, this.parentHeight);
    this.goldenContainer.on('resize', this.onWindowResize.bind(this));

    // Create the Three.js Scene
    this.scene = new THREE.Scene();
    this.backgroundColor  = 0x222222;
    this.scene.background = new THREE.Color(this.backgroundColor);
    this.scene.fog        = new THREE.Fog(this.backgroundColor, 200, 600);

    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
    this.camera.position.set(50, 100, 150);
    this.camera.lookAt(0, 45, 0);
    this.camera.aspect = this.parentWidth / this.parentHeight;
    this.camera.updateProjectionMatrix();

    // Create two lights to evenly illuminate the model and cast shadows
    this.light  = new THREE.HemisphereLight(0xffffff, 0x444444);
    this.light.position.set(0, 200, 0);
    this.light2 = new THREE.DirectionalLight(0xbbbbbb);
    this.light2.position.set(6, 50, -12);
    this.light2.castShadow = true;
    this.light2.shadow.camera.top      =  200;
    this.light2.shadow.camera.bottom   = -200;
    this.light2.shadow.camera.left     = -200;
    this.light2.shadow.camera.right    =  200;
    this.light2.shadow.mapSize.width   =  128;
    this.light2.shadow.mapSize.height  =  128;
    this.scene.add(this.light);
    this.scene.add(this.light2);
    this.renderer.shadowMap.enabled    = true;
    this.renderer.shadowMap.type       = THREE.PCFSoftShadowMap;

    // Set up the orbit controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 45, 0);
    this.controls.panSpeed  = 2;
    this.controls.zoomSpeed = 1;
    this.controls.screenSpacePanning = true;
    this.controls.update();

    // Keep track of the last time the scene was interacted with
    this.controls.addEventListener('change', () => this.viewDirty = true);
    this.isVisible = true;
    this.viewDirty = true;
    this.time = new THREE.Clock();
    this.time.autoStart = true;
    this.lastTimeRendered = 0.0;

    this.goldenContainer.layoutManager.eventHub.emit('Start');
  }

  /** Resize the container, canvas, and renderer when the window resizes. */
  onWindowResize() {
    this.goldenContainer.layoutManager.updateSize(
      window.innerWidth,
      window.innerHeight - document.getElementsByClassName('topnav')[0].offsetHeight
    );
    this.camera.aspect = this.goldenContainer.width / this.goldenContainer.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.goldenContainer.width, this.goldenContainer.height);
    this.renderer.render(this.scene, this.camera);
    this.viewDirty = true;
  }
}

/** CAD-specific 3D viewport that extends Environment with shape rendering,
 *  edge/face highlighting, export functionality, and transform gizmos. */
class CascadeEnvironment {
  constructor(goldenContainer, app, getNewFileHandle, writeFile, downloadFile) {
    this.active          = true;
    this.goldenContainer = goldenContainer;
    this.environment     = new Environment(this.goldenContainer);
    this._app            = app;

    // State for the Hover Highlighting
    this.raycaster       = new THREE.Raycaster();
    this.highlightedObj  = null;
    this._hoverFaceMesh  = null;
    this._altKeyDown     = false;
    this.fogDist         = 200;

    // State for the Handles
    this.handles         = [];
    this.gizmoMode       = "translate";
    this.gizmoSpace      = "local";

    // Load the Shiny Dull Metal Matcap Material
    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin('');
    this.matcap = this.loader.load('./textures/dullFrontLitMetal.png', () => {
      this.environment.viewDirty = true;
    });
    this.matcapMaterial = new THREE.MeshMatcapMaterial({
      color: new THREE.Color(0xf5f5f5),
      matcap: this.matcap,
      polygonOffset: true,
      polygonOffsetFactor: 2.0,
      polygonOffsetUnits: 1.0
    });

    // Store dependencies for export methods
    this._getNewFileHandle = getNewFileHandle;
    this._writeFile = writeFile;
    this._downloadFile = downloadFile;

    // Modeling history timeline state
    this._historySteps = [];       // Metadata from worker: [{fnName, lineNumber, shapeCount, volume, surfaceArea, solidCount}, ...]
    this._historyMeshCache = {};   // stepIndex → [facelist, edgelist]
    this._historyCurrentStep = -1;   // -1 = showing final result (default)
    this._historyRequestedStep = -1; // Last timeline target requested while async meshing may be pending
    this._historyObject = null;      // THREE.Group for the history preview
    this._historyPending = false;    // True while awaiting worker mesh response
    this._lastSceneOptions = {};

    // Fit camera on first render so the orbit target centers on the model
    this._isFirstRender = true;

    // Set up mouse tracking
    this.mouse = { x: 0, y: 0 };
    this._selectedEdgeLine = null;
    this._selectedEdgeIndex = -1;
    this._selectedFaceMesh = null;
    this._selectedFaceIndex = -1;
    this._selectedPartMesh = null;
    this._selectedPartIndex = -1;
    this._pointerDown = null;
    this.goldenContainer.element.addEventListener('mousemove', (event) => {
      this._updateMouseFromEvent(event);
      this._altKeyDown = event.altKey;
    }, false);
    this.goldenContainer.element.addEventListener('pointerdown', (event) => {
      this._pointerDown = { x: event.clientX, y: event.clientY };
    }, false);
    this.goldenContainer.element.addEventListener('click', (event) => {
      this._altKeyDown = event.altKey;
      if (this._pointerDown) {
        let dx = event.clientX - this._pointerDown.x;
        let dy = event.clientY - this._pointerDown.y;
        if ((dx * dx + dy * dy) > 16) return;
      }
      this._selectTargetFromEvent(event);
    }, false);

    // Create the timeline overlay DOM
    this._createTimelineOverlay();

    // Initialize the Handle Manager (no messageBus needed — app wires events)
    this.handleManager = new HandleManager(this);

    // Start the animation loop
    this._animate();
    this.environment.renderer.render(this.environment.scene, this.environment.camera);
  }

  /** Render mesh data received from the engine.
   *  Replaces the old _registerRenderCallback / "combineAndRenderShapes" handler. */
  async renderMeshData(meshData, sceneOptions) {
    if (!meshData) return;
    const { faces: facelist, edges: edgelist } = meshData;
    await this._yieldToMainThread();
    if (!facelist) { return; }
    if (!sceneOptions) { sceneOptions = {}; }
    this._lastSceneOptions = sceneOptions;

    // The old mainObject is dead! Long live the mainObject!
    this._clearHoverHighlight();
    this._clearSelection();
    this.environment.scene.remove(this.mainObject);

    this.environment.scene.remove(this.groundMesh);
    if (sceneOptions.groundPlaneVisible) {
      this.groundMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2000, 2000),
        new THREE.MeshPhongMaterial({
          color: 0x080808, depthWrite: true, dithering: true,
          polygonOffset: true,
          polygonOffsetFactor: 6.0, polygonOffsetUnits: 1.0
        })
      );
      this.groundMesh.position.y = -0.1;
      this.groundMesh.rotation.x = -Math.PI / 2;
      this.groundMesh.receiveShadow = true;
      this.environment.scene.add(this.groundMesh);
    }

    this.environment.scene.remove(this.grid);
    if (sceneOptions.gridVisible) {
      this.grid = new THREE.GridHelper(2000, 20, 0xcccccc, 0xcccccc);
      this.grid.position.y = -0.01;
      this.grid.material.opacity = 0.3;
      this.grid.material.transparent = true;
      this.environment.scene.add(this.grid);
    }

    this.mainObject = await this._buildObjectFromMesh(facelist, edgelist);

    // Expand fog distance to enclose the current object
    this.boundingBox = new THREE.Box3().setFromObject(this.mainObject);
    this.fogDist = Math.max(this.fogDist, this.boundingBox.min.distanceTo(this.boundingBox.max) * 1.5);
    this.environment.scene.fog = new THREE.Fog(this.environment.backgroundColor, this.fogDist, this.fogDist + 400);

    // Cache the final mesh data for the timeline's last step
    this._finalMeshData = [facelist, edgelist];

    // Reset timeline to show final result
    this._historyCurrentStep = -1;
    this._historyRequestedStep = -1;
    if (this._historyObject) {
      this.environment.scene.remove(this._historyObject);
      this._historyObject = null;
    }

    this.environment.scene.add(this.mainObject);
    if (this._isFirstRender || this._fitOnNextRender) {
      this._isFirstRender = false;
      this._fitOnNextRender = false;
      this.fitCamera();
    }
    this.environment.viewDirty = true;
  }

  /** Set history steps metadata. Replaces the old "modelHistory" handler. */
  setHistorySteps(steps) {
    this._historySteps = steps || [];
    this._historyMeshCache = {};
    this._historyCurrentStep = -1;
    this._historyRequestedStep = -1;
    this._updateTimelineDOM();
  }

  /** Fit the camera to frame the current model with a 3/4 elevated view.
   *  Always uses Y-up (the model group's -PI/2 X rotation maps OCC Z-up to Three.js Y-up). */
  fitCamera() {
    if (!this.mainObject && !this._historyObject) return;
    const target = this._historyObject || this.mainObject;
    const box = new THREE.Box3().setFromObject(target);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    // Distance to fit the object in the camera frustum
    const fov = this.environment.camera.fov * (Math.PI / 180);
    const dist = (maxDim / (2 * Math.tan(fov / 2))) * 1.5;

    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3(1, 0.5, 1).normalize();

    this.environment.camera.up.copy(up);
    this.environment.camera.position.copy(center).addScaledVector(dir, dist);
    this.environment.controls.target.copy(center);
    this.environment.camera.lookAt(center);
    this.environment.controls.update();
    this.environment.viewDirty = true;
  }

  /** Set the camera angle using azimuth and elevation (in degrees). */
  setCameraAngle(azimuthDeg, elevationDeg) {
    this.fitCamera();

    const camera = this.environment.camera;
    const controls = this.environment.controls;
    const target = controls.target.clone();
    const dist = camera.position.distanceTo(target);
    const up = camera.up.clone().normalize();

    const az = ((azimuthDeg != null) ? azimuthDeg : 45) * Math.PI / 180;
    const el = ((elevationDeg != null) ? elevationDeg : 30) * Math.PI / 180;

    let temp = Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    let right = new THREE.Vector3().crossVectors(temp, up).normalize();
    let forward = new THREE.Vector3().crossVectors(up, right).normalize();

    const cosEl = Math.cos(el);
    const sinEl = Math.sin(el);
    const dir = new THREE.Vector3()
      .addScaledVector(forward, cosEl * Math.cos(az))
      .addScaledVector(right, cosEl * Math.sin(az))
      .addScaledVector(up, sinEl)
      .normalize();

    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);
    controls.update();
    this.environment.viewDirty = true;
    this.environment.renderer.render(this.environment.scene, camera);
  }

  /** Build a THREE.Group from facelist/edgelist mesh data. */
  async _buildObjectFromMesh(facelist, edgelist) {
    let group = new THREE.Group();
    group.name = "shape";
    group.rotation.x = -Math.PI / 2;

    // Add Triangulated Faces to Object
    let vertexCount = 0, indexCount = 0, uvCount = 0;
    for (const face of facelist) {
      vertexCount += face.vertex_coord.length / 3;
      indexCount += face.tri_indexes.length;
      uvCount += face.uv_coord.length / 2;
    }
    let vertices = new Float32Array(vertexCount * 3);
    let normals = new Float32Array(vertexCount * 3);
    let triangles = new Uint32Array(indexCount);
    let uvs = new Float32Array(uvCount * 2);
    let colors = new Float32Array(vertexCount * 3);
    let vInd = 0, vertexOffset = 0, uvOffset = 0, indexOffset = 0, globalFaceIndex = 0;
    let faceMetadata = {};
    for (let faceListIndex = 0; faceListIndex < facelist.length; faceListIndex++) {
      const face = facelist[faceListIndex];
      const triangleStart = indexOffset;
      vertices.set(face.vertex_coord, vertexOffset * 3);
      normals.set(face.normal_coord, vertexOffset * 3);
      uvs.set(face.uv_coord, uvOffset * 2);

      for (let i = 0; i < face.tri_indexes.length; i++) {
        triangles[indexOffset + i] = face.tri_indexes[i] + vInd;
      }

      const faceVertexCount = face.vertex_coord.length / 3;
      for (let i = 0; i < faceVertexCount; i++) {
        const colorOffset = (vertexOffset + i) * 3;
        colors[colorOffset + 0] = face.face_index;
        colors[colorOffset + 1] = globalFaceIndex;
        colors[colorOffset + 2] = 0;
      }

      const triangleEnd = indexOffset + face.tri_indexes.length - 1;
      faceMetadata[globalFaceIndex] = {
        localFaceIndex: face.face_index,
        globalFaceIndex,
        partIndex: face.partIndex,
        part: face.part,
        info: face,
        triangleStart,
        triangleEnd
      };
      globalFaceIndex++;
      vInd += faceVertexCount;
      vertexOffset += faceVertexCount;
      uvOffset += face.uv_coord.length / 2;
      indexOffset += face.tri_indexes.length;
      if ((faceListIndex & 31) === 31) await this._yieldToMainThread();
    }

    let geometry = new THREE.BufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(triangles, 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('uv2', new THREE.BufferAttribute(uvs, 2));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    let model = new THREE.Mesh(geometry, this.matcapMaterial);
    model.castShadow = true;
    model.name = "Model Faces";
    model.faceMetadata = faceMetadata;
    model.getFaceMetadataAtTriangle = function (triangleFace) {
      if (!triangleFace) return null;
      const globalIndex = this.geometry.attributes.color.getY(triangleFace.a);
      return this.faceMetadata[globalIndex] || null;
    }.bind(model);
    group.add(model);

    // Add Highlightable Edges to Object
    let lineVertexCount = 0;
    for (const edge of edgelist) lineVertexCount += Math.max(0, ((edge.vertex_coord.length / 3) - 1) * 2);
    let lineVertices = new Float32Array(lineVertexCount * 3);
    let globalEdgeIndices = [];
    let lineVertexOffset = 0;
    let curGlobalEdgeIndex = 0;
    let globalEdgeMetadata = {}; globalEdgeMetadata[-1] = { start: -1, end: -1 };
    for (let edgeListIndex = 0; edgeListIndex < edgelist.length; edgeListIndex++) {
      const edge = edgelist[edgeListIndex];
      let edgeMetadata = {};
      edgeMetadata.localEdgeIndex = edge.edge_index;
      edgeMetadata.info = edge;
      edgeMetadata.start = globalEdgeIndices.length;
      for (let i = 0; i < edge.vertex_coord.length - 3; i += 3) {
        lineVertices[lineVertexOffset++] = edge.vertex_coord[i];
        lineVertices[lineVertexOffset++] = edge.vertex_coord[i + 1];
        lineVertices[lineVertexOffset++] = edge.vertex_coord[i + 2];
        lineVertices[lineVertexOffset++] = edge.vertex_coord[i + 3];
        lineVertices[lineVertexOffset++] = edge.vertex_coord[i + 4];
        lineVertices[lineVertexOffset++] = edge.vertex_coord[i + 5];
        globalEdgeIndices.push(curGlobalEdgeIndex);
        globalEdgeIndices.push(curGlobalEdgeIndex);
      }
      edgeMetadata.end = globalEdgeIndices.length - 1;
      globalEdgeMetadata[curGlobalEdgeIndex] = edgeMetadata;
      curGlobalEdgeIndex++;
      if ((edgeListIndex & 63) === 63) await this._yieldToMainThread();
    }

    let lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(lineVertices, 3));
    let lineColors = new Float32Array(lineVertexCount * 3);
    lineGeometry.setAttribute('color', new THREE.BufferAttribute(lineColors, 3));
    let lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff, linewidth: 4, vertexColors: true
    });
    let line = new THREE.LineSegments(lineGeometry, lineMaterial);
    line.globalEdgeIndices = globalEdgeIndices;
    line.name = "Model Edges";
    line.lineColors = lineColors;
    line.globalEdgeMetadata = globalEdgeMetadata;
    line.hoverEdgeIndex = -1;
    line.selectedEdgeIndex = -1;
    line.hoverEdgeMesh = null;
    line.selectedEdgeMesh = null;
    line.edgeOutlineRadius = Math.max(0.08, (geometry.boundingSphere?.radius || 100) * 0.0008);
    line.hoverEdgeMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      depthTest: false,
      depthWrite: false
    });
    line.selectedEdgeMaterial = new THREE.MeshBasicMaterial({
      color: 0x2d6ba6,
      depthTest: false,
      depthWrite: false
    });
    line.updateEdgeColors = function () {
      let hoverMeta = this.globalEdgeMetadata[this.hoverEdgeIndex] || this.globalEdgeMetadata[-1];
      let selectedMeta = this.globalEdgeMetadata[this.selectedEdgeIndex] || this.globalEdgeMetadata[-1];
      for (let i = 0; i < this.lineColors.length; i += 3) {
        let vertexIndex = Math.floor(i / 3);
        let isSelected = vertexIndex >= selectedMeta.start && vertexIndex <= selectedMeta.end;
        let isHover = vertexIndex >= hoverMeta.start && vertexIndex <= hoverMeta.end;
        this.lineColors[i + 0] = isSelected ? 45 / 255 : (isHover ? 0 : 0);
        this.lineColors[i + 1] = isSelected ? 107 / 255 : (isHover ? 1 : 0);
        this.lineColors[i + 2] = isSelected ? 166 / 255 : (isHover ? 1 : 0);
      }
      this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.lineColors, 3));
    }.bind(line);
    line.updateEdgeOutlineMesh = function (edgeIndex, meshProp, material, name) {
      if (this[meshProp]) {
        this.parent?.remove(this[meshProp]);
        this[meshProp].geometry.dispose();
        this[meshProp] = null;
      }
      let meta = this.globalEdgeMetadata[edgeIndex];
      let coords = meta?.info?.vertex_coord;
      if (!coords || coords.length < 6) return;

      let points = [];
      for (let i = 0; i < coords.length; i += 3) {
        points.push(new THREE.Vector3(coords[i], coords[i + 1], coords[i + 2]));
      }
      let curve = points.length === 2
        ? new THREE.LineCurve3(points[0], points[1])
        : new THREE.CatmullRomCurve3(points);
      let tubularSegments = Math.max(8, points.length * 4);
      let tubeGeometry = new THREE.TubeGeometry(curve, tubularSegments, this.edgeOutlineRadius, 8, false);
      this[meshProp] = new THREE.Mesh(tubeGeometry, material);
      this[meshProp].name = name;
      this[meshProp].renderOrder = 999;
      this.parent?.add(this[meshProp]);
    }.bind(line);
    line.highlightEdgeAtLineIndex = function (lineIndex) {
      this.hoverEdgeIndex = lineIndex >= 0 ? this.globalEdgeIndices[lineIndex] : -1;
      this.updateEdgeColors();
      this.updateEdgeOutlineMesh(this.hoverEdgeIndex, 'hoverEdgeMesh', this.hoverEdgeMaterial, "Hover Edge Outline");
    }.bind(line);
    line.updateSelectedEdgeMesh = function () {
      this.updateEdgeOutlineMesh(this.selectedEdgeIndex, 'selectedEdgeMesh', this.selectedEdgeMaterial, "Selected Edge Outline");
    }.bind(line);
    line.selectEdgeAtLineIndex = function (lineIndex) {
      this.selectedEdgeIndex = lineIndex >= 0 ? this.globalEdgeIndices[lineIndex] : -1;
      this.updateEdgeColors();
      this.updateSelectedEdgeMesh();
    }.bind(line);
    line.getEdgeMetadataAtLineIndex = function (lineIndex) {
      return this.globalEdgeMetadata[this.globalEdgeIndices[lineIndex]];
    }.bind(line);
    line.clearHighlights = function () {
      return this.highlightEdgeAtLineIndex(-1);
    }.bind(line);
    group.add(line);

    return group;
  }

  _yieldToMainThread() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  }

  _updateMouseFromEvent(event) {
    const rect = this.environment.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  _clearHoverHighlight() {
    if (this.highlightedObj) {
      this.highlightedObj.material.color.setHex(this.highlightedObj.currentHex);
      if (this.highlightedObj.clearHighlights) { this.highlightedObj.clearHighlights(); }
    }
    if (this._hoverFaceMesh) {
      if (this._hoverFaceMesh.parent) {
        this._hoverFaceMesh.parent.remove(this._hoverFaceMesh);
      } else {
        this.environment.scene.remove(this._hoverFaceMesh);
      }
    }
    this.highlightedObj = null;
    this.highlightedIndex = undefined;
    this._highlightedPartMode = false;
    this._hoverFaceMesh = null;
  }

  _clearSelection() {
    if (this._selectedEdgeLine && this._selectedEdgeLine.selectEdgeAtLineIndex) {
      this._selectedEdgeLine.selectEdgeAtLineIndex(-1);
    }
    if (this._selectedFaceMesh) {
      if (this._selectedFaceMesh.parent) {
        this._selectedFaceMesh.parent.remove(this._selectedFaceMesh);
      } else {
        this.environment.scene.remove(this._selectedFaceMesh);
      }
    }
    if (this._selectedPartMesh) {
      if (this._selectedPartMesh.parent) {
        this._selectedPartMesh.parent.remove(this._selectedPartMesh);
      } else {
        this.environment.scene.remove(this._selectedPartMesh);
      }
    }
    this._selectedEdgeLine = null;
    this._selectedEdgeIndex = -1;
    this._selectedFaceMesh = null;
    this._selectedFaceIndex = -1;
    this._selectedPartMesh = null;
    this._selectedPartIndex = -1;
  }

  _getInteractiveObject() {
    return this._historyObject || (this.mainObject?.visible !== false ? this.mainObject : null);
  }

  _addSelectionMesh(mesh, sourceObject = null) {
    const target = sourceObject?.parent || this._getInteractiveObject();
    if (mesh && target) target.add(mesh);
  }

  async _selectTargetFromEvent(event) {
    const targetObject = this._getInteractiveObject();
    if (!targetObject) return;
    this._updateMouseFromEvent(event);
    this.raycaster.setFromCamera(this.mouse, this.environment.camera);
    const intersects = this.raycaster.intersectObjects(targetObject.children);

    this._clearSelection();

    if (intersects.length === 0) {
      console.log("Selection cleared");
      this.environment.viewDirty = true;
      return;
    }

    const hit = intersects.find((hit) =>
      hit.object.type === "LineSegments" ||
      (hit.object.type === "Mesh" && hit.object.name === "Model Faces")
    );

    if (!hit) {
      console.log("Selection cleared");
      this.environment.viewDirty = true;
      return;
    }

    if (hit.object.type === "LineSegments") {
      const line = hit.object;
      const metadata = line.getEdgeMetadataAtLineIndex(hit.index);
      if (event.altKey && Number.isInteger(metadata.info?.partIndex)) {
        const model = this._getModelFacesObject();
        this._selectedPartIndex = metadata.info.partIndex;
        this._selectedPartMesh = model ? this._buildPartHighlightMesh(model, metadata.info.partIndex, {
          name: "Selected Part",
          color: 0x2d6ba6,
          opacity: 0.35,
          renderOrder: 10
        }) : null;
        this._addSelectionMesh(this._selectedPartMesh, line);
        this._app?.graph?.focusSubshape(metadata.info?.subshapeId, `part #${metadata.info.partIndex}`);
        console.log(await this._formatSelectedPart(metadata.info.partIndex, metadata.info.part || null, metadata.info || {}));
      } else {
        line.selectEdgeAtLineIndex(hit.index);
        this._selectedEdgeLine = line;
        this._selectedEdgeIndex = metadata.localEdgeIndex;
        this._app?.graph?.focusSubshape(metadata.info?.subshapeId, `edge #${metadata.localEdgeIndex}`);
        console.log(await this._formatSelectedEdge(metadata.localEdgeIndex, metadata.info || {}));
      }
    } else {
      const metadata = hit.object.getFaceMetadataAtTriangle(hit.face);
      if (!metadata) return;
      if (event.altKey) {
        this._selectedPartIndex = metadata.partIndex;
        this._selectedPartMesh = this._buildPartHighlightMesh(hit.object, metadata.partIndex, {
          name: "Selected Part",
          color: 0x2d6ba6,
          opacity: 0.35,
          renderOrder: 10
        });
        this._addSelectionMesh(this._selectedPartMesh, hit.object);
        this._app?.graph?.focusSubshape(metadata.info?.subshapeId, `part #${metadata.partIndex}`);
        console.log(await this._formatSelectedPart(metadata.partIndex, metadata.part || metadata.info?.part || null, metadata.info || {}));
      } else {
        this._selectedFaceIndex = metadata.localFaceIndex;
        this._selectedFaceMesh = this._buildFaceHighlightMesh(hit.object, metadata, {
          name: "Selected Face",
          color: 0x2d6ba6,
          opacity: 0.35,
          renderOrder: 10
        });
        this._addSelectionMesh(this._selectedFaceMesh, hit.object);
        this._app?.graph?.focusSubshape(metadata.info?.subshapeId, `face #${metadata.localFaceIndex}`);
        console.log(await this._formatSelectedFace(metadata.localFaceIndex, metadata.info || {}));
      }
    }
    this.environment.viewDirty = true;
  }

  _getModelFacesObject(targetObject = null) {
    const target = targetObject || this._getInteractiveObject();
    return target?.children?.find((child) => child.type === "Mesh" && child.name === "Model Faces") || null;
  }

  _buildFaceHighlightMesh(model, metadata, options = {}) {
    return this._buildFacesHighlightMesh(model, [metadata], options);
  }

  _buildPartHighlightMesh(model, partIndex, options = {}) {
    const metas = Object.values(model.faceMetadata || {}).filter((meta) => meta.partIndex === partIndex);
    return this._buildFacesHighlightMesh(model, metas, options);
  }

  _buildFacesHighlightMesh(model, metadatas, options = {}) {
    const sourceGeometry = model.geometry;
    const index = sourceGeometry.index.array;
    const positions = sourceGeometry.attributes.position.array;
    const normals = sourceGeometry.attributes.normal.array;
    const vertices = [];
    const selectedNormals = [];
    for (const metadata of metadatas || []) {
      for (let i = metadata.triangleStart; i <= metadata.triangleEnd; i++) {
        const vi = index[i];
        vertices.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
        selectedNormals.push(normals[vi * 3], normals[vi * 3 + 1], normals[vi * 3 + 2]);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(selectedNormals, 3));
    const material = new THREE.MeshBasicMaterial({
      color: options.color ?? 0x2d6ba6,
      transparent: true,
      opacity: options.opacity ?? 0.35,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = options.name || "Face Highlight";
    mesh.renderOrder = options.renderOrder ?? 10;
    return mesh;
  }

  _formatSelectionHeader(title) {
    return [title, "─".repeat(title.length)];
  }

  _formatSelectionField(label, value) {
    return `  ${label.padEnd(12, " ")} ${value}`;
  }

  _formatSelectionCodeHistory(lines, source) {
    const history = Array.isArray(source?.history) ? source.history : [];
    const block = history.length ? history : (Array.isArray(source?.codeBlock) ? source.codeBlock : []);
    if (block.length) {
      lines.push("", "Code");
      for (const entry of block) {
        const lineNumber = entry.codeLine ?? entry.lineNumber;
        lines.push(`  ${String(lineNumber).padStart(4, " ")}: ${entry.code}`);
      }
    } else if (source?.code) {
      lines.push("", "Code", `  ${source.code}`);
    }
  }

  async _formatSelectionGraph(lines, subshapeId, label = "selected item") {
    if (!subshapeId || !this._app?.engine?.traceSubshape) return;
    try {
      const trace = await this._app.engine.traceSubshape(subshapeId);
      if (!trace) return;
      lines.push("", "Graph");
      lines.push(this._formatSelectionField("Node", trace.selected?.subshapeId || subshapeId));
      if (trace.selected?.type) lines.push(this._formatSelectionField("Type", trace.selected.type));
      if (trace.selected?.shapeId) lines.push(this._formatSelectionField("Shape", trace.selected.shapeId));
      if (trace.summary) lines.push(`  ${trace.summary}`);
      const chain = Array.isArray(trace.chain) ? trace.chain : [];
      if (chain.length) {
        lines.push("", "  Relationships");
        for (const step of chain) {
          const from = step.from || "new geometry";
          const line = step.codeLine || step.lineNumber || "unknown";
          lines.push(`    ${from} --${step.relation || "related"}/${step.fnName || "unknown"}--> ${step.subshapeId} (line ${line}, ${step.confidence || "unknown"})`);
        }
      }
    } catch (err) {
      lines.push("", "Graph", `  Could not trace ${label}: ${err?.message || err}`);
    }
  }

  async _formatSelectedEdge(edgeIndex, info = {}) {
    const fmtNumber = (value) => Number.isFinite(value) ? Number(value.toFixed(4)).toString() : "unknown";
    const fmtPoint = (point) => Array.isArray(point) ? `[${point.map(fmtNumber).join(", ")}]` : "unknown";
    const lines = [
      ...this._formatSelectionHeader(`Selected edge #${edgeIndex}`),
      "",
      "Geometry",
      this._formatSelectionField("Type", info.type || "unknown"),
      this._formatSelectionField("Length", fmtNumber(info.length))
    ];

    if (info.startPoint || info.endPoint) {
      lines.push(this._formatSelectionField("Start", fmtPoint(info.startPoint)));
      lines.push(this._formatSelectionField("End", fmtPoint(info.endPoint)));
    }

    if (info.type === "Line") {
      lines.push(this._formatSelectionField("Direction", fmtPoint(info.direction)));
    } else {
      lines.push(this._formatSelectionField("Midpoint", fmtPoint(info.midpoint)));
      const vertices = info.vertex_coord || [];
      lines.push(this._formatSelectionField("Segments", Math.max(0, vertices.length / 3 - 1)));
    }

    const createdBy = info.createdBy;
    if (createdBy) {
      lines.push("", "History");
      lines.push(this._formatSelectionField("Created by", createdBy.fnName || "unknown"));
      if (Number.isInteger(createdBy.historyStepIndex)) lines.push(this._formatSelectionField("Step", createdBy.historyStepIndex));
      if (Number.isInteger(createdBy.codeLine)) lines.push(this._formatSelectionField("Line", createdBy.codeLine));
      this._formatSelectionCodeHistory(lines, createdBy);
    }
    await this._formatSelectionGraph(lines, info.subshapeId, `edge #${edgeIndex}`);

    return lines.join("\n");
  }

  async _formatSelectedFace(faceIndex, info = {}) {
    const fmtNumber = (value) => Number.isFinite(value) ? Number(value.toFixed(4)).toString() : "unknown";
    const lines = [
      ...this._formatSelectionHeader(`Selected face #${faceIndex}`),
      "",
      "Geometry",
      this._formatSelectionField("Triangles", info.number_of_triangles || 0)
    ];
    if (Number.isFinite(info.face_index)) lines.push(this._formatSelectionField("Source index", fmtNumber(info.face_index)));
    if (Number.isInteger(info.partIndex)) lines.push(this._formatSelectionField("Part", `#${info.partIndex}`));

    const createdBy = info.createdBy || info.part?.source || null;
    if (createdBy) {
      lines.push("", "History");
      lines.push(this._formatSelectionField("Created by", createdBy.fnName || "unknown"));
      if (Number.isInteger(createdBy.historyStepIndex)) lines.push(this._formatSelectionField("Step", createdBy.historyStepIndex));
      if (Number.isInteger(createdBy.codeLine)) lines.push(this._formatSelectionField("Line", createdBy.codeLine));
      this._formatSelectionCodeHistory(lines, createdBy);
    }
    await this._formatSelectionGraph(lines, info.subshapeId, `face #${faceIndex}`);

    return lines.join("\n");
  }

  async _formatSelectedPart(partIndex, part = {}, info = {}) {
    const source = part?.source || {};
    const lines = [
      ...this._formatSelectionHeader(`Selected part #${partIndex}`),
      "",
      "Geometry",
      this._formatSelectionField("Shape type", Number.isFinite(part?.shapeType) ? part.shapeType : "unknown"),
      "",
      "History",
      this._formatSelectionField("Created by", source.fnName || "unknown")
    ];
    if (Number.isInteger(source.historyStepIndex)) lines.push(this._formatSelectionField("Step", source.historyStepIndex));
    if (Number.isInteger(source.codeLine)) lines.push(this._formatSelectionField("Line", source.codeLine));
    this._formatSelectionCodeHistory(lines, source);
    await this._formatSelectionGraph(lines, info.subshapeId, `part #${partIndex}`);
    return lines.join("\n");
  }

  /** Create the timeline overlay DOM elements. */
  _createTimelineOverlay() {
    this._timelineContainer = document.createElement('div');
    this._timelineContainer.className = 'cs-timeline';
    this._timelineContainer.style.display = 'none';
    this.goldenContainer.element.appendChild(this._timelineContainer);

    // Track container holds the step icons
    this._timelineTrack = document.createElement('div');
    this._timelineTrack.className = 'cs-timeline-track';
    this._timelineContainer.appendChild(this._timelineTrack);

    // Scrubbing state
    this._isScrubbing = false;

    this._timelineTrack.addEventListener('mousedown', (e) => {
      this._isScrubbing = true;
      this._scrubToPosition(e);
    });
    window.addEventListener('mousemove', (e) => {
      if (this._isScrubbing) this._scrubToPosition(e);
    });
    window.addEventListener('mouseup', () => {
      this._isScrubbing = false;
    });
  }

  /** Map a mouse event to the closest timeline step element. */
  _scrubToPosition(e) {
    let children = this._timelineTrack.children;
    if (children.length === 0) return;

    let mouseX = e.clientX;
    let closestIndex = 0;
    let closestDist = Infinity;
    for (let i = 0; i < children.length; i++) {
      let rect = children[i].getBoundingClientRect();
      let centerX = rect.left + rect.width / 2;
      let dist = Math.abs(mouseX - centerX);
      if (dist < closestDist) {
        closestDist = dist;
        closestIndex = i;
      }
    }

    if (closestIndex >= this._historySteps.length) {
      this._showFinalResult();
    } else {
      this._showHistoryStep(closestIndex);
    }
  }

  /** Show the final (fully evaluated) result. */
  _showFinalResult() {
    this._historyRequestedStep = -1;
    if (this._historyCurrentStep === -1) return;
    this._historyCurrentStep = -1;

    if (this._historyObject) {
      this.environment.scene.remove(this._historyObject);
      this._historyObject = null;
    }
    if (this.mainObject) {
      this.mainObject.visible = true;
    }

    this._updateTimelineHighlight();
    this.environment.viewDirty = true;

    if (this._onHistoryStepChange) this._onHistoryStepChange(null);
  }

  /** Show an intermediate history step. Triangulates lazily via engine request. */
  async _showHistoryStep(stepIndex) {
    if (stepIndex < 0 || stepIndex >= this._historySteps.length) {
      this._showFinalResult();
      return;
    }

    this._historyRequestedStep = stepIndex;
    if (stepIndex === this._historyCurrentStep && !this._historyPending) return;
    if (this._historyPending) {
      this._updateTimelineHighlight();
      return;
    }
    this._historyCurrentStep = stepIndex;
    this._updateTimelineHighlight();

    let step = this._historySteps[stepIndex];
    if (this._onHistoryStepChange && step) {
      this._onHistoryStepChange(step.lineNumber);
    }

    if (this.mainObject) {
      this.mainObject.visible = false;
    }

    if (this._historyMeshCache[stepIndex]) {
      await this._displayHistoryMesh(this._historyMeshCache[stepIndex]);
      return;
    }

    if (step && step.shapeCount === 0) {
      await this._displayHistoryMesh(null);
      return;
    }

    const finalPrefixMesh = this._meshPrefixFromFinal(stepIndex, step);
    if (finalPrefixMesh) {
      this._historyMeshCache[stepIndex] = finalPrefixMesh;
      await this._displayHistoryMesh(finalPrefixMesh);
      return;
    }

    // Request triangulation from engine
    this._historyPending = true;
    try {
      let meshData = await this._app.engine.meshHistoryStep(
        stepIndex,
        this._lastSceneOptions.meshRes || 0.1
      );
      this._historyMeshCache[stepIndex] = meshData;
      if (this._historyCurrentStep === stepIndex) {
        await this._displayHistoryMesh(meshData);
      }
    } finally {
      this._historyPending = false;
      if (this._historyRequestedStep !== this._historyCurrentStep) {
        if (this._historyRequestedStep === -1) {
          this._showFinalResult();
        } else {
          this._showHistoryStep(this._historyRequestedStep);
        }
      }
    }
  }

  /** Return final mesh filtered to parts visible at a history step.
   *  Keeps useStepPart/import timeline cheap: same meshes, later parts hidden, selection metadata intact. */
  _meshPrefixFromFinal(stepIndex, step) {
    if (!this._finalMeshData || !step) return null;
    const [faces, edges] = this._finalMeshData;
    if (!Array.isArray(faces) || !Array.isArray(edges)) return null;

    const isVisiblePart = (partIndex, part) => {
      const sourceStep = part?.source?.historyStepIndex;
      if (Number.isInteger(sourceStep)) return sourceStep <= stepIndex;
      if (Number.isInteger(partIndex)) return partIndex < step.shapeCount;
      return false;
    };

    const filteredFaces = faces.filter((face) => isVisiblePart(face.partIndex, face.part));
    if (filteredFaces.length === 0) return null;

    const visibleParts = new Set(filteredFaces
      .map((face) => face.partIndex)
      .filter((partIndex) => Number.isInteger(partIndex)));
    const filteredEdges = edges.filter((edge) => visibleParts.has(edge.partIndex));
    return [filteredFaces, filteredEdges];
  }

  /** Display a pre-triangulated history mesh in the scene. */
  async _displayHistoryMesh(meshData) {
    if (this._historyObject) {
      this.environment.scene.remove(this._historyObject);
      this._historyObject = null;
    }

    if (meshData) {
      let [facelist, edgelist] = meshData;
      if (facelist && facelist.length > 0) {
        this._historyObject = await this._buildObjectFromMesh(facelist, edgelist);
        this.environment.scene.add(this._historyObject);
      }
    }

    this.environment.viewDirty = true;
  }

  /** Update the timeline DOM to reflect current history steps. */
  _updateTimelineDOM() {
    if (this._historySteps.length <= 1) {
      this._timelineContainer.style.display = 'none';
      return;
    }

    this._timelineContainer.style.display = '';
    this._timelineTrack.innerHTML = '';

    const iconMap = {
      'Box': '\u25A1', 'Sphere': '\u25CB', 'Cylinder': '\u25AD',
      'Cone': '\u25B3', 'Polygon': '\u2B23', 'Circle': '\u25EF',
      'BSpline': '\u223F', 'Text3D': 'T', 'Wedge': '\u25C7',
      'Translate': '\u2192', 'Rotate': '\u21BB', 'Mirror': '\u2194', 'Scale': '\u2922',
      'Union': '\u222A', 'Difference': '\u2216', 'Intersection': '\u2229',
      'Extrude': '\u2191', 'Revolve': '\u21BA', 'Offset': '\u29C9',
      'Pipe': '\u2240', 'Loft': '\u22C8', 'Fillet': '\u25E0',
      'Chamfer': '\u25FA', 'Section': '\u2500', 'Shell': '\u25A2',
      'Sketch': '\u270E', 'MakeSolid': '\u25A0', 'MakeWire': '\u2312',
    };

    for (let i = 0; i <= this._historySteps.length; i++) {
      let dot = document.createElement('div');
      dot.className = 'cs-timeline-step';

      if (i < this._historySteps.length) {
        let step = this._historySteps[i];
        const label = step.fnName || 'Step';
        dot.textContent = iconMap[label] || (label.startsWith('Import STEP:') ? '\u21E9' : '\u2022');
        dot.title = `${label}${label.startsWith('Import STEP:') ? '' : '()'} — line ${step.lineNumber} (${step.shapeCount} shape${step.shapeCount !== 1 ? 's' : ''})`;
      } else {
        dot.textContent = '\u2713';
        dot.title = 'Final result';
        dot.classList.add('cs-timeline-final');
      }

      this._timelineTrack.appendChild(dot);
    }

    this._updateTimelineHighlight();
  }

  /** Highlight the current step in the timeline. */
  _updateTimelineHighlight() {
    let steps = this._timelineTrack.children;
    for (let i = 0; i < steps.length; i++) {
      let isActive;
      const activeStep = this._historyPending ? this._historyRequestedStep : this._historyCurrentStep;
      if (activeStep === -1) {
        isActive = (i === steps.length - 1);
      } else {
        isActive = (i === activeStep);
      }
      steps[i].classList.toggle('cs-timeline-active', isActive);
    }
  }

  /** Save the current shape to .step. */
  async saveShapeSTEP() {
    try {
      // showSaveFilePicker must run directly from the user gesture.
      // Pick the destination first, then await worker STEP export.
      if (window.showSaveFilePicker) {
        console.log("Opening native STEP save dialog...");
        const fileHandle = await this._getNewFileHandle("STEP files", "model/step", "step");
        console.log("Exporting STEP...");
        const stepContent = await this._app.engine.exportSTEP();
        await this._writeFile(fileHandle, stepContent);
        console.log("Saved STEP to " + fileHandle.name);
      } else {
        console.error("Native save dialog unavailable: this browser does not support window.showSaveFilePicker. Use Chrome/Edge on localhost/HTTPS, or the browser will download the STEP file instead.");
        const stepContent = await this._app.engine.exportSTEP();
        await this._downloadFile(stepContent, "Untitled", "model/step", "step");
      }
    } catch (e) {
      if (e && e.name === "AbortError") { return; }
      console.error("Failed to export STEP: " + e.message);
    }
  }

  /** Save the current shape to an ASCII .stl. */
  async saveShapeSTL() {
    let stlExporter = new STLExporter();
    let result = stlExporter.parse(this.mainObject);
    if (window.showSaveFilePicker) {
      const fileHandle = await this._getNewFileHandle("STL files", "text/plain", "stl");
      this._writeFile(fileHandle, result).then(() => {
        console.log("Saved STL to " + fileHandle.name);
      });
    } else {
      await this._downloadFile(result, "Untitled", "model/stl", "stl");
    }
  }

  /** Save the current shape to .obj. */
  async saveShapeOBJ() {
    let objExporter = new OBJExporter();
    let result = objExporter.parse(this.mainObject);
    if (window.showSaveFilePicker) {
      const fileHandle = await this._getNewFileHandle("OBJ files", "text/plain", "obj");
      this._writeFile(fileHandle, result).then(() => {
        console.log("Saved OBJ to " + fileHandle.name);
      });
    } else {
      await this._downloadFile(result, "Untitled", "model/obj", "obj");
    }
  }

  /** Clear all transform handles. Delegates to HandleManager. */
  clearTransformHandles() {
    this.handleManager.clearTransformHandles();
  }

  /** Animation loop - handles highlighting and rendering. */
  _animate() {
    if (!this.active) { return; }

    requestAnimationFrame(() => this._animate());

    const targetObject = this._getInteractiveObject();
    if (targetObject) {
      this.raycaster.setFromCamera(this.mouse, this.environment.camera);
      let intersects = this.raycaster.intersectObjects(targetObject.children);
      const hit = intersects.find((hit) =>
        hit.object.type === "LineSegments" ||
        (hit.object.type === "Mesh" && hit.object.name === "Model Faces")
      );
      if (this.environment.controls.state < 0 && hit) {
        let isLine = hit.object.type === "LineSegments";
        let edgeMetadata = isLine ? hit.object.getEdgeMetadataAtLineIndex(hit.index) : null;
        let faceMetadata = !isLine ? hit.object.getFaceMetadataAtTriangle(hit.face) : null;
        let isPartHover = this._altKeyDown && (isLine ? Number.isInteger(edgeMetadata?.info?.partIndex) : true);
        let newIndex = isLine
          ? (isPartHover ? edgeMetadata.info.partIndex : edgeMetadata.localEdgeIndex)
          : (isPartHover ? faceMetadata?.partIndex : hit.object.geometry.attributes.color.getX(hit.face.a));
        if (this.highlightedObj != hit.object || this.highlightedIndex !== newIndex || this._highlightedPartMode !== isPartHover) {
          this._clearHoverHighlight();
          this.highlightedObj = hit.object;
          this.highlightedObj.currentHex = this.highlightedObj.material.color.getHex();
          this.highlightedIndex = newIndex;
          this._highlightedPartMode = isPartHover;
          if (isLine && isPartHover) {
            const model = this._getModelFacesObject(hit.object.parent);
            if (model) {
              this._hoverFaceMesh = this._buildPartHighlightMesh(model, edgeMetadata.info.partIndex, {
                name: "Hovered Part",
                color: 0x00e5ff,
                opacity: 0.55,
                renderOrder: 9
              });
              hit.object.parent?.add(this._hoverFaceMesh);
            }
          } else if (isLine) {
            this.highlightedObj.material.color.setHex(0xffffff);
            this.highlightedObj.highlightEdgeAtLineIndex(hit.index);
          } else if (faceMetadata) {
            this._hoverFaceMesh = isPartHover
              ? this._buildPartHighlightMesh(this.highlightedObj, faceMetadata.partIndex, {
                  name: "Hovered Part",
                  color: 0x00e5ff,
                  opacity: 0.55,
                  renderOrder: 9
                })
              : this._buildFaceHighlightMesh(this.highlightedObj, faceMetadata, {
                  name: "Hovered Face",
                  color: 0x00e5ff,
                  opacity: 0.55,
                  renderOrder: 9
                });
            hit.object.parent?.add(this._hoverFaceMesh);
          }
          this.environment.viewDirty = true;
        }

        let indexHelper = (isLine ? "Edge" : (isPartHover ? "Part" : "Face")) + " Index: " + this.highlightedIndex;
        this.goldenContainer.element.title = indexHelper;
      } else {
        if (this.highlightedObj || this._hoverFaceMesh) {
          this._clearHoverHighlight();
          this.environment.viewDirty = true;
        }
        this.goldenContainer.element.title = "";
      }
    }

    if (this.handles && this.handles.length > 0) {
      for (let i = 0; i < this.handles.length; i++) {
        this.environment.viewDirty = this.handles[i].dragging || this.environment.viewDirty;
      }
    }

    if (this.environment.viewDirty) {
      this.environment.renderer.render(this.environment.scene, this.environment.camera);
      this.environment.viewDirty = false;
    }
  }
}

export { Environment, CascadeEnvironment };
