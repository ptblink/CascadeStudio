// CascadeMain.js - ES Module
// This script governs the layout and initialization of all of the sub-windows

import { createDockview } from '../lib/dockview-core/dockview-core.js';
import { CascadeEnvironment } from './CascadeView.js';
import { CascadeEngine, OpenSCADTranspiler } from 'cascade-core';
import { EditorManager } from './EditorManager.js';
import { ConsoleManager } from './ConsoleManager.js';
import { ProvenanceManager } from './ProvenanceManager.js';
import { GUIManager } from './GUIManager.js';
import { OpenSCADMonaco } from './openscad/OpenSCADMonaco.js';
import { CascadeAPI } from './CascadeAPI.js';
import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';

/** Adapter that wraps a dockview panel to provide a Golden-Layout-compatible container API.
 *  This minimizes changes needed in EditorManager, ConsoleManager, and CascadeView. */
class DockviewContainer {
  constructor(element, panelApi) {
    this.element = element;
    this._panelApi = panelApi;
    this._state = {};
    this._resizeCallbacks = [];

    panelApi.onDidDimensionsChange(() => {
      this._resizeCallbacks.forEach(cb => cb());
    });
    panelApi.onDidActiveChange((event) => {
      if (event.isActive) {
        this._activeCallbacks?.forEach(cb => cb());
      }
    });
    this._activeCallbacks = [];
  }

  get width()  { return this.element.offsetWidth; }
  get height() { return this.element.offsetHeight; }

  setState(obj) { this._state = obj; }
  getState()    { return this._state; }
  setTitle(title) { this._panelApi.setTitle(title); }

  on(event, callback) {
    if (event === 'resize') {
      this._resizeCallbacks.push(callback);
    } else if (event === 'active') {
      this._activeCallbacks.push(callback);
    }
  }

  // Stub for CascadeView's layoutManager access
  get layoutManager() {
    return {
      eventHub: { emit: () => {} },
      updateSize: () => {}
    };
  }
}

/** Main application class for Cascade Studio.
 *  Manages layout, editor, worker, and UI state. */
class CascadeStudioApp {
  constructor() {
    this.myLayout = null;
    this._dockviewApi = null;
    this.engine = null;
    this.editor = null;
    this.console = null;
    this.provenance = null;
    this.gui = null;
    this.viewport = null;
    this.api = null;
    this.startup = null;
    this.file = {};

    // OpenSCAD support
    this._openscadTranspiler = new OpenSCADTranspiler();
    this._openscadMonaco = new OpenSCADMonaco();

    window.workerWorking = false;
  }

  // Backward compatibility: messageBus accessor via engine
  get messageBus() { return this.engine ? this.engine.messageBus : null; }

  /** Start the application: create the engine, wire up events, and initialize. */
  start() {
    // Create the CascadeEngine (wraps Worker + MessageBus)
    const workerPath = typeof ESBUILD !== 'undefined' ? './cascade-worker.js' : './js/CADWorker/CascadeStudioMainWorker.js';
    this.engine = new CascadeEngine({ workerUrl: workerPath });

    // Create subsystem managers
    this.editor = new EditorManager(this);
    this.console = new ConsoleManager(this);
    this.provenance = new ProvenanceManager(this);
    this.gui = new GUIManager(this);

    // Backward compatibility: expose functions to window for inline HTML event handlers
    window.cascadeApp = this;
    window.saveProject = () => this.saveProject();
    window.loadProject = () => this.loadProject();
    window.loadFiles = (id) => this.loadFiles(id);
    window.clearExternalFiles = () => this.clearExternalFiles();
    window.saveSTEP = () => {
      console.log("Save STEP clicked.");
      if (!this.viewport) {
        console.error("Save STEP failed: viewport is not ready yet.");
        return;
      }
      return this.viewport.saveShapeSTEP();
    };
    window.generateSTEPImportCode = (fileName) => this.generateSTEPImportCode(fileName);

    // Install the programmatic API
    this.api = new CascadeAPI(this);
    this.api.install();

    // Register OpenSCAD language with Monaco (for syntax highlighting)
    this._openscadMonaco.registerLanguage();

    // Test fixture dropdown — load selected JavaScript fixture into current editor tab
    const fixtureSelect = document.getElementById('testFixtureSelect');
    if (fixtureSelect) {
      this._initFixtureSelect(fixtureSelect);
    }

    // Initialize the engine (loads worker + WASM), then start the layout
    this.engine.init().then(() => {
      // The engine is ready — register event handlers and initialize the UI

      // Wire up engine events for GUI controls
      this.gui.registerHandlers(this.engine);

      // Wire up engine events for console (log, error, progress)
      this.engine.on('log', (payload) => { console.log(payload); });
      this.engine.on('error', (payload) => {
        window.workerWorking = false;
        console.error(payload);
      });
      this.engine.on('Progress', (payload) => {
        this.console.updateProgress('model', 'Generating Model', payload.opType || '', null, { spinner: payload.opNumber });
      });
      this.engine.on('importProgress', (payload) => {
        this.console.updateProgress('import', payload.label || 'Importing files', payload.detail || '', payload.percent, payload);
      });
      this.engine.on('resetWorking', () => { window.workerWorking = false; });

      // Wire up engine events for viewport
      this.engine.on('modelHistory', (steps) => {
        if (this.viewport) {
          this.viewport.setHistorySteps(steps);
        }
      });

      // Wire up file loading callback
      this.engine.on('loadFiles', (extFiles) => {
        console.log("Storing loaded files!");
        this.console.goldenContainer.setState(extFiles);
      });

      // Wire up automatic STEP JS generation after import.
      this.engine.on('generatedSTEPImportCode', ({ fileName, code }) => {
        if (code) {
          this.openCodeTab(code, fileName + ' import');
          console.log("Opened new editor tab for imported STEP file " + fileName);
          console.log("Calculating geometry from imported STEP tab...");
          setTimeout(() => this.editor.evaluateCode(false, { preserveConsole: true }), 0);
        }
      });

      // Wire up file saving callback
      this.engine.on('saveFile', (payload) => {
        let link = document.createElement("a");
        link.href = payload.fileURL;
        link.download = payload.filename;
        link.click();
      });

      // Wire up transform handle creation
      this.engine.on('createTransformHandle', (payload) => {
        if (this.viewport && this.viewport.handleManager) {
          this.viewport.handleManager.createTransformHandle(payload);
        }
      });

      // Backward compat: expose messageHandlers to window
      window.messageHandlers = this.engine.messageBus.handlers;

      // Start the application with startup callback behavior
      this.startup = () => {
        let curState = this.console.goldenContainer?.getState();
        if (curState && Object.keys(curState).length > 0) {
          this.engine.loadPrexistingExternalFiles(curState);
        }
        this.editor.evaluateCode();
      };
      this.startup();
    });

    // Initialize the layout immediately (don't wait for WASM)
    this.initialize();
  }

  /** Initialize the layout and load project content. */
  initialize(projectContent = null) {
    let searchParams = new URLSearchParams(window.location.search || window.location.hash.substr(1));
    let loadFromURL = searchParams.has("code");

    let codeStr = CascadeStudioApp.EMPTY_CODE;
    this.gui.state = {};

    if (projectContent) {
      // Load from saved project — extract code and state from the serialized layout
      try {
        let parsed = JSON.parse(projectContent);
        if (parsed._cascadeState) {
          // New Dockview project format
          codeStr = parsed._cascadeState.code || codeStr;
          this.gui.state = parsed._cascadeState.guiState || {};
        } else if (parsed.content || parsed.root) {
          // Legacy GoldenLayout project format — extract code from componentState
          let code = this._extractLegacyCode(parsed);
          if (code) { codeStr = code; }
        }
      } catch (e) {
        console.error("Failed to parse project:", e);
      }
    } else if (loadFromURL) {
      codeStr = CascadeStudioApp.decode(searchParams.get("code"));
      this.gui.state = JSON.parse(CascadeStudioApp.decode(searchParams.get("gui")));
    }

    // Dispose previous layout
    if (this._dockviewApi) {
      this._dockviewApi.dispose();
      this._dockviewApi = null;
    }

    const appBody = document.getElementById("appbody");
    appBody.innerHTML = '';

    // Set layout height
    const topnavHeight = document.getElementById('topnav').offsetHeight;
    appBody.style.height = (window.innerHeight - topnavHeight) + 'px';

    this._dockviewApi = createDockview(appBody, {
      className: 'dockview-theme-dark',
      disableFloatingGroups: true,
      createLeftHeaderActionComponent: (group) => this._createCodeTabAddButton(group),
      createComponent: (options) => {
        const element = document.createElement('div');
        element.style.width = '100%';
        element.style.height = '100%';
        element.style.overflow = 'hidden';

        return {
          element,
          init: (params) => {
            const container = new DockviewContainer(element, params.api);

            switch (options.name) {
              case 'codeEditor':
                container.setState({ code: params.params?.code || codeStr });
                this.editor.initPanel(container, container.getState());
                break;
              case 'cascadeView':
                container.setState(params.params?.guiState || this.gui.state);
                this._initCascadeView(container, container.getState());
                break;
              case 'console':
                this.console.initPanel(container);
                break;
              case 'provenance':
                try {
                  this.provenance.initPanel(container);
                } catch (err) {
                  element.textContent = `Provenance failed to load: ${err?.message || err}`;
                  element.style.padding = '12px';
                  element.style.color = '#f48771';
                  console.error('Provenance failed to load', err);
                }
                break;
            }
          }
        };
      }
    });

    // Add panels — use vertical stack on mobile, side-by-side on desktop
    const isMobile = window.innerHeight > window.innerWidth;

    if (isMobile) {
      // Mobile: cascadeView on top, editor below, console at bottom
      const viewPanel = this._dockviewApi.addPanel({
        id: 'cascadeView',
        component: 'cascadeView',
        title: 'CAD View',
        params: { guiState: this.gui.state }
      });

      this._dockviewApi.addPanel({
        id: 'codeEditor',
        component: 'codeEditor',
        title: '* Untitled',
        params: { code: codeStr },
        position: { referencePanel: 'cascadeView', direction: 'below' }
      });

      const consolePanel = this._dockviewApi.addPanel({
        id: 'console',
        component: 'console',
        title: 'Console',
        position: { referencePanel: 'codeEditor', direction: 'below', index: 1 }
      });

      this._dockviewApi.addPanel({
        id: 'provenance',
        component: 'provenance',
        title: 'Provenance',
        position: { referencePanel: 'console', direction: 'within', index: 0 },
        inactive: true
      });
      consolePanel.api.setActive();

      // Set proportions after dockview grid initializes
      setTimeout(() => {
        try {
          const h = appBody.offsetHeight;
          viewPanel.group.api.setSize({ height: Math.floor(h * 0.25) });
          consolePanel.group.api.setSize({ height: Math.floor(h * 0.05) });
        } catch (e) { /* ignore */ }
      }, 50);
    } else {
      // Desktop: editor left, cascadeView right, console below view
      const editorPanel = this._dockviewApi.addPanel({
        id: 'codeEditor',
        component: 'codeEditor',
        title: '* Untitled',
        params: { code: codeStr }
      });

      const viewPanel = this._dockviewApi.addPanel({
        id: 'cascadeView',
        component: 'cascadeView',
        title: 'CAD View',
        params: { guiState: this.gui.state },
        position: { referencePanel: 'codeEditor', direction: 'right' }
      });

      const consolePanel = this._dockviewApi.addPanel({
        id: 'console',
        component: 'console',
        title: 'Console',
        position: { referencePanel: 'cascadeView', direction: 'below', index: 1 }
      });

      this._dockviewApi.addPanel({
        id: 'provenance',
        component: 'provenance',
        title: 'Provenance',
        position: { referencePanel: 'console', direction: 'within', index: 0 },
        inactive: true
      });
      consolePanel.api.setActive();

      // Set initial proportions (editor ~50%, view+console ~50%, console 15% height)
      setTimeout(() => {
        try {
          const editorGroup = editorPanel.group;
          const viewGroup = viewPanel.group;
          if (editorGroup && viewGroup) {
            editorGroup.api.setSize({ width: Math.floor(appBody.offsetWidth * 0.5) });
          }
          consolePanel.group.api.setSize({ height: Math.floor(appBody.offsetHeight * 0.15) });
        } catch (e) { /* setSize may not be available on initial render */ }
      }, 50);
    }

    // Resize the layout when the browser resizes
    if (this._updateLayoutSize) {
      window.removeEventListener('resize', this._updateLayoutSize);
      window.removeEventListener('orientationchange', this._updateLayoutSize);
    }
    this._updateLayoutSize = () => {
      const h = window.innerHeight - document.getElementById('topnav').offsetHeight;
      appBody.style.height = h + 'px';
    };
    window.addEventListener('resize', this._updateLayoutSize);
    window.addEventListener('orientationchange', this._updateLayoutSize);
    requestAnimationFrame(this._updateLayoutSize);
  }

  /** Populate test fixture dropdown and load fixtures into the current editor tab. */
  async _initFixtureSelect(select) {
    try {
      const response = await fetch('fixture-manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
      const fixtures = await response.json();
      for (const name of fixtures) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
      }
      select.addEventListener('change', async () => {
        const name = select.value;
        if (!name) return;
        try {
          let fixture = await fetch('fixtures/' + encodeURIComponent(name), { cache: 'no-store' });
          if (!fixture.ok) {
            fixture = await fetch('test/fixtures/' + encodeURIComponent(name), { cache: 'no-store' });
          }
          if (!fixture.ok) throw new Error(fixture.status + ' ' + fixture.statusText);
          const code = await fixture.text();
          this.editor.setMode('cascadestudio');
          this.editor.setCode(code);
          this.editor.container?.setTitle(name);
          if (this.viewport) { this.viewport._fitOnNextRender = true; }
          this.editor.evaluateCode();
        } catch (error) {
          console.error('Failed to load test fixture ' + name + ': ' + error.message);
        } finally {
          select.value = '';
        }
      });
    } catch (error) {
      console.error('Failed to load test fixture list: ' + error.message);
      select.disabled = true;
    }
  }

  /** Initialize the Three.js 3D Viewport. */
  _initCascadeView(container, state) {
    this.gui.state = state;
    container.setState(this.gui.state);

    if (this.viewport) {
      this.viewport.active = false;
      this.viewport = null;
    }

    let floatingGUIContainer = document.createElement("div");
    floatingGUIContainer.className = 'gui-panel';
    floatingGUIContainer.id = "guiPanel";
    container.element.appendChild(floatingGUIContainer);

    this.viewport = new CascadeEnvironment(
      container, this,
      CascadeStudioApp.getNewFileHandle, CascadeStudioApp.writeFile, CascadeStudioApp.downloadFile
    );
    window.threejsViewport = this.viewport;

    // Wire timeline step changes to editor line highlighting
    this._historyDecorations = [];
    this.viewport._onHistoryStepChange = (lineNumber) => {
      let editor = window.monacoEditor;
      if (!editor) return;
      if (lineNumber && lineNumber > 0) {
        this._historyDecorations = editor.deltaDecorations(this._historyDecorations, [{
          range: new monaco.Range(lineNumber, 1, lineNumber, 1),
          options: {
            isWholeLine: true,
            className: 'cs-history-line-highlight',
            glyphMarginClassName: 'cs-history-glyph'
          }
        }]);
        editor.revealLineInCenter(lineNumber);
      } else {
        this._historyDecorations = editor.deltaDecorations(this._historyDecorations, []);
      }
    };
  }

  /** Serialize the project's current state into a .json file and save it. */
  async saveProject() {
    let currentCode = this.editor.getCode();
    if (!this.file.handle) {
      this.file.handle = await CascadeStudioApp.getNewFileHandle(
        "Cascade Studio project files", "application/json", "json"
      );
    }

    // Save as a custom format with layout + cascade state
    let projectData = {
      _cascadeState: {
        code: currentCode,
        guiState: this.gui.state,
        externalFiles: this.console.goldenContainer.getState()
      }
    };
    if (this._dockviewApi) {
      projectData._dockviewLayout = this._dockviewApi.toJSON();
    }

    CascadeStudioApp.writeFile(this.file.handle, JSON.stringify(projectData, null, 2)).then(() => {
      this.editor.container.setTitle(this.file.handle.name);
      console.log("Saved project to " + this.file.handle.name);
      this.file.content = currentCode;
    });
  }

  /** Load a .json file as the current project. */
  async loadProject() {
    if (window.workerWorking) { return; }

    [this.file.handle] = await CascadeStudioApp.getNewFileHandle(
      'Cascade Studio project files', 'application/json', 'json', true
    );
    let fileSystemFile = await this.file.handle.getFile();
    let jsonContent = await fileSystemFile.text();
    window.history.replaceState({}, 'Cascade Studio', '?');
    this.initialize(jsonContent);
    this.editor.container.setTitle(this.file.handle.name);
    this.file.content = this.editor.getCode();
  }

  /** Trigger the CAD WebWorker to load one or more .stl, .step, or .iges files. */
  loadFiles(fileElementID = "files") {
    let files = document.getElementById(fileElementID).files;
    this.engine.importFiles(files);
  }

  /** Create the + button shown after code editor tabs. */
  _createCodeTabAddButton(group) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'cs-add-code-tab-button';
    element.textContent = '+';
    element.title = 'New code tab';
    element.setAttribute('aria-label', 'New code tab');

    const isCodeGroup = () => group.panels?.some(panel => panel.id === 'codeEditor' || panel.id?.startsWith('codeEditor-'));
    const updateVisibility = () => { element.style.display = isCodeGroup() ? '' : 'none'; };

    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openCodeTab(CascadeStudioApp.EMPTY_CODE, '* Untitled');
    });

    updateVisibility();
    const disposable = this._dockviewApi?.onDidLayoutChange?.(() => updateVisibility());

    return {
      element,
      init: updateVisibility,
      dispose: () => disposable?.dispose?.()
    };
  }

  /** Open code in a new editor tab and make it active. */
  openCodeTab(code, title = '* Untitled') {
    if (!this._dockviewApi) {
      this.editor.setCode(code);
      return null;
    }
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_');
    const id = 'codeEditor-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const referencePanel = this._dockviewApi.getPanel?.('codeEditor') || this._dockviewApi.activePanel;
    const panel = this._dockviewApi.addPanel({
      id,
      component: 'codeEditor',
      title: safeTitle,
      params: { code },
      position: referencePanel ? { referencePanel, direction: 'within' } : undefined
    });
    panel.api.setActive();
    return panel;
  }

  /** Generate CascadeStudio JS for an imported STEP file and place it in a new editor tab. */
  async generateSTEPImportCode(fileName) {
    let files = this.console.goldenContainer.getState() || {};
    let stepFiles = Object.keys(files).filter(name => /\.(step|stp)$/i.test(name));
    if (!stepFiles.length && this.engine.getExternalFileNames) {
      let importedNames = await this.engine.getExternalFileNames();
      stepFiles = (importedNames || []).filter(name => /\.(step|stp)$/i.test(name));
    }
    let target = fileName || stepFiles[0];
    if (!target) {
      console.error("No imported STEP file found. Import a .step/.stp file first; STEP JS generates automatically after import.");
      return null;
    }
    let code = await this.engine.generateSTEPImportCode(target);
    if (code) {
      this.openCodeTab(code, target + ' import');
      console.log("Opened new editor tab for imported STEP file " + target);
    }
    return code;
  }

  /** Clear all externally loaded files from the `externalFiles` dict. */
  clearExternalFiles() {
    this.engine.clearExternalFiles();
    this.console.goldenContainer.setState({});
  }

  /** Extract code from a legacy GoldenLayout project file. */
  _extractLegacyCode(parsed) {
    // Recursively search for componentState.code in GoldenLayout config
    function findCode(obj) {
      if (!obj || typeof obj !== 'object') return null;
      if (obj.componentState && obj.componentState.code) return obj.componentState.code;
      for (let key of ['content', 'root', 'children']) {
        if (Array.isArray(obj[key])) {
          for (let child of obj[key]) {
            let result = findCode(child);
            if (result) return result;
          }
        }
      }
      return null;
    }
    return findCode(parsed);
  }

  // --- Static utility methods ---

  /** Get a new file handle via the File System Access API. */
  static async getNewFileHandle(desc, mime, ext, open = false) {
    const options = {
      types: [{
        description: desc,
        accept: { [mime]: ['.' + ext] },
      }],
    };
    if (open) {
      return await window.showOpenFilePicker(options);
    } else {
      return await window.showSaveFilePicker(options);
    }
  }

  /** Write contents to a file handle. */
  static async writeFile(fileHandle, contents) {
    const writable = await fileHandle.createWritable();
    await writable.write(contents);
    await writable.close();
  }

  /** Download data as a file via a temporary anchor element. */
  static async downloadFile(data, name, mime, ext) {
    const blob = new Blob([data], { type: mime });
    const a = document.createElement("a");
    a.download = name + "." + ext;
    a.style.display = "none";
    a.href = window.URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(a.href);
  }

  /** Decode a base64+compressed string to the original. Uses fflate. */
  static decode(string) {
    const compressed = Uint8Array.from(atob(decodeURIComponent(string)), c => c.charCodeAt(0));
    return strFromU8(inflateSync(compressed));
  }

  /** Encode a string to a base64+compressed version. Uses fflate. */
  static encode(string) {
    const compressed = deflateSync(strToU8(string));
    // Build binary string in chunks to avoid stack overflow with large data
    let binaryStr = '';
    const chunkSize = 8192;
    for (let i = 0; i < compressed.length; i += chunkSize) {
      binaryStr += String.fromCharCode.apply(null, compressed.subarray(i, i + chunkSize));
    }
    return encodeURIComponent(btoa(binaryStr));
  }

  /** Returns true if item is indexable like an array. */
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
}

/** Empty code used for new editor tabs. */
CascadeStudioApp.EMPTY_CODE = '';

/** Example starter code retained for URL/project fixtures and mode switching. */
CascadeStudioApp.STARTER_CODE =
`// Welcome to Cascade Studio!  A Browser-Based CAD Modeling Environment.
// Adjust these sliders to modify the model in real time:
let width     = Slider("Width",      80, 40, 120);
let depth     = Slider("Depth",      60, 30, 100);
let height    = Slider("Height",     30, 15, 50);
let wall      = Slider("Wall",        3,  2,  8);
let filletR   = Slider("Fillet",       6,  1, 15);
let showLabel = Checkbox("Label",   true);

// --- Base Tray (Sketch + Extrude) ---
// Sketch: Draw a rounded-rectangle, then extrude it into a solid
let outerFace = new Sketch([-width/2, -depth/2])
  .LineTo([ width/2, -depth/2]).Fillet(filletR)
  .LineTo([ width/2,  depth/2]).Fillet(filletR)
  .LineTo([-width/2,  depth/2]).Fillet(filletR)
  .LineTo([-width/2, -depth/2]).Fillet(filletR)
  .End(true).Face();
let tray = Extrude(outerFace, [0, 0, height], true);  // keepFace: reuse for Offset below

// Offset: Create inner profile while outerFace is still intact
let innerFace = Offset(outerFace, -wall);

// FilletEdges + Selector: Round the top rim edges
let topEdges = Edges(tray).max([0,0,1]).indices();
tray = FilletEdges(tray, wall * 0.4, topEdges);

// Difference: Hollow out to create a tray
let cavity = Translate([0, 0, wall], Extrude(innerFace, [0, 0, height]));
tray = Difference(tray, [cavity]);

// --- Divider (Box + Union) ---
let divider = Translate([-wall/2, -(depth - wall*2)/2, wall],
  Box(wall, depth - wall*2, height - wall*2));
tray = Union([tray, divider]);

// --- Pen Holder (Revolve + ChamferEdges) ---
// Revolve an L-shaped profile around Z to create a hollow cup in one step
let penR = depth / 4;
let penH = height * 1.6;
let penX = width/2 + penR + 3;
let cupProfile = Polygon([
  [0, 0, 0], [penR, 0, 0], [penR, 0, penH],
  [penR - wall, 0, penH], [penR - wall, 0, wall], [0, 0, wall]
]);
let holder = Revolve(cupProfile, 360, [0, 0, 1]);
let chamferEdges = Edges(holder).max([0,0,1]).ofType("Circle").indices();
holder = ChamferEdges(holder, wall * 0.3, chamferEdges);
Translate([penX, 0, 0], holder);

// --- Decorative Cutout (Sphere + Boolean + Mirror) ---
let cutR = Math.min(8, height * 0.25);
let cutout = Translate([0, -depth/2, height * 0.5], Sphere(cutR));
tray = Difference(tray, [cutout]);
// Mirror: Matching cutout on the back wall
tray = Difference(tray, [Mirror([0, 1, 0], cutout)]);

// --- RotatedExtrude: Decorative twisted accent ---
let spiralWire = Translate([3, 0, 0], Circle(1.5, true));
let spiral = RotatedExtrude(spiralWire, 12, 180);
Translate([-width/2 - 6, -depth/4, 0], spiral);

// --- 3D Text Label ---
if (showLabel) {
  let label = Text3D("CS", 10, wall * 0.2, "Consolas");
  Translate([width/4, -depth/2 - wall * 0.2, height * 0.3], label);
}

// --- Measurements ---
console.log("Volume:  " + Math.abs(Volume(tray)).toFixed(0) + " mm\\u00B3");
console.log("Surface: " + SurfaceArea(tray).toFixed(0) + " mm\\u00B2");
let com = CenterOfMass(tray);
console.log("Center:  [" + com.map(v => v.toFixed(1)).join(", ") + "]");`;

/** Default OpenSCAD starter code shown when switching to OpenSCAD mode. */
CascadeStudioApp.OPENSCAD_STARTER_CODE =
`// Parametric Bolt and Nut
// Demonstrates modules, intersection, difference, and transforms

hex_r = 10;
hex_h = 6;
bore_r = 5;
shaft_r = 4.8;
shaft_h = 25;

// Hex prism: three intersecting boxes
module hex(r, h) {
  intersection() {
    cube([r * 2, r * 1.73, h], center = true);
    rotate([0, 0, 60])
      cube([r * 2, r * 1.73, h], center = true);
    rotate([0, 0, -60])
      cube([r * 2, r * 1.73, h], center = true);
  }
}

// Bolt head
hex(hex_r, hex_h);

// Shaft
translate([0, 0, hex_h / 2])
  cylinder(h = shaft_h, r = shaft_r);

// Washer
translate([0, 0, shaft_h])
  difference() {
    cylinder(h = 2, r = hex_r - 1);
    cylinder(h = 3, r = bore_r);
  }

// Nut with bore hole
translate([0, 0, shaft_h + 2])
  difference() {
    hex(hex_r, hex_h);
    cylinder(h = hex_h + 1, r = bore_r, center = true);
  }
`;

export { CascadeStudioApp };
