// EditorManager.js - Monaco editor management

const monaco = window.monaco;

/** Manages the Monaco code editor instance, mode switching, and code evaluation. */
class EditorManager {
  constructor(app) {
    this._app = app;
    this.editor = null;
    this.mode = 'cascadestudio';
    this._extraLibs = [];
    this._codeContainer = null;
    this._openscadProviders = [];
    this._autoEvaluateTimer = null;
    this._pendingEvaluate = false;
    this._suppressAutoEvaluate = false;
    this._changeDisposable = null;
  }

  /** Initialize the editor panel inside a DockviewContainer. */
  initPanel(container, state) {
    // Set the Monaco Language Options
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      allowNonTsExtensions: true,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    });
    monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);

    // Import Typescript Intellisense Definitions
    const isBuilt = typeof ESBUILD !== 'undefined';
    let prefix = window.location.href.startsWith("https://zalo.github.io/") ? "/CascadeStudio/" : "";
    const ocDtsPath = isBuilt ? 'typedefs/cascadestudio.d.ts' : prefix + 'node_modules/opencascade.js/dist/cascadestudio.d.ts';
    const threeDtsPath = isBuilt ? 'typedefs/three.d.ts' : prefix + 'node_modules/@types/three/index.d.ts';
    const libDtsPath = isBuilt ? 'typedefs/StandardLibraryIntellisense.ts' : prefix + 'js/StandardLibraryIntellisense.ts';
    Promise.all([
      fetch(ocDtsPath).then(r => r.text()),
      fetch(threeDtsPath).then(r => r.text()),
      fetch(libDtsPath).then(r => r.text()),
    ]).then(([ocDts, threeDts, libDts]) => {
      this._extraLibs = [
        { content: ocDts, filePath: 'file://' + ocDtsPath },
        { content: threeDts, filePath: 'file://' + threeDtsPath },
        { content: libDts, filePath: 'file://' + libDtsPath },
      ];
      monaco.editor.createModel("", "typescript");
      monaco.languages.typescript.typescriptDefaults.setExtraLibs(this._extraLibs);
    }).catch(error => console.log("Error loading type definitions: " + error.message));

    // Check for code serialization as an array
    this._codeContainer = container;
    if (EditorManager._isArrayLike(state.code)) {
      let codeString = "";
      for (let i = 0; i < state.code.length; i++) {
        codeString += state.code[i] + "\n";
      }
      codeString = codeString.slice(0, -1);
      state.code = codeString;
      container.setState({ code: codeString });
    }

    // Initialize the Monaco Code Editor
    const isMobile = window.innerHeight > window.innerWidth;
    const editor = monaco.editor.create(container.element, {
      value: state.code,
      language: "typescript",
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      cursorStyle: 'line',
      cursorWidth: 2,
      wordWrap: isMobile ? 'on' : 'off',
      ...(isMobile && {
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 0,
        lineNumbersMinChars: 0,
        lineNumbers: 'off',
        padding: { top: 0, bottom: 0 }
      })
    });
    this.editor = editor;
    window.monacoEditor = editor;

    editor.onDidChangeModelContent(() => {
      if (this.editor !== editor || this._suppressAutoEvaluate) { return; }
      this.scheduleEvaluate(true, 600);
    });
    container.on('active', () => {
      this.editor = editor;
      this._codeContainer = container;
      window.monacoEditor = editor;
    });

    // Collapse all top-level functions in the Editor
    this._collapseTopLevelFunctions(state.code, editor);

    // Set up keyboard shortcuts
    this._setupKeyboardShortcuts(container, editor);
  }

  /** Legacy: Register the dockable Monaco Code Editor component with Golden Layout.
   *  Now delegates to initPanel. */
  registerComponent(layout) {
    layout.registerComponent('codeEditor', (container, state) => {
      this.initPanel(container, state);
    });
  }

  /** Get the current code from the editor. */
  getCode() {
    return this.editor ? this.editor.getValue() : '';
  }

  /** Set the code in the editor. */
  setCode(code) {
    if (this.editor) {
      this._suppressAutoEvaluate = true;
      this.editor.setValue(code);
      this._suppressAutoEvaluate = false;
    }
  }

  /** Schedule an evaluation, debounced for editor/UI changes. */
  scheduleEvaluate(saveToURL = false, delay = 0) {
    this._pendingEvaluate = true;
    clearTimeout(this._autoEvaluateTimer);
    this._autoEvaluateTimer = setTimeout(() => {
      this._autoEvaluateTimer = null;
      if (!this._pendingEvaluate) { return; }
      this._pendingEvaluate = false;
      this.evaluateCode(saveToURL);
    }, delay);
  }

  /** Evaluate the current code: transpile if OpenSCAD, then send to worker via engine. */
  evaluateCode(saveToURL = false, { preserveConsole = false } = {}) {
    if (window.workerWorking) {
      this._pendingEvaluate = true;
      return;
    }
    if (!this._app.engine || !this._app.engine.isReady) { return; }
    window.workerWorking = true;

    monaco.languages.typescript.typescriptDefaults.setExtraLibs(this._extraLibs);
    let newCode = this.editor.getValue();
    monaco.editor.setModelMarkers(this.editor.getModel(), 'test', []);

    // Clear console and refresh the GUI Panel
    if (!preserveConsole) { this._app.console.clear(); }
    this._app.gui.reset();
    if (this._app.viewport) this._app.viewport.clearTransformHandles();

    // Transpile OpenSCAD if needed
    let codeToEval = newCode;
    if (this.mode === 'openscad' && this._app._openscadTranspiler) {
      try {
        codeToEval = this._app._openscadTranspiler.transpile(newCode);
      } catch (e) {
        console.error("OpenSCAD transpile error: " + e.message);
        window.workerWorking = false;
        return;
      }
    }

    // Use CascadeEngine to evaluate and get mesh data
    this._app.engine.evaluate(codeToEval, {
      guiState: this._app.gui.state,
    }).then((result) => {
      if (this._app.viewport && result.meshData) {
        this._app.viewport.renderMeshData(result.meshData, result.sceneOptions);
      }
    }).catch((err) => {
      console.error("Evaluation error: " + err.message);
    }).finally(() => {
      window.workerWorking = false;
      if (this._pendingEvaluate) {
        this.scheduleEvaluate(saveToURL, 0);
      }
    });

    this._codeContainer.setState({ code: newCode });

    if (saveToURL) {
      const AppClass = this._app.constructor;
      console.log("Saved to URL!");
      window.history.replaceState({}, 'Cascade Studio',
        new URL(
          location.pathname + "?code=" + AppClass.encode(newCode) +
          "&gui=" + AppClass.encode(JSON.stringify(this._app.gui.state)),
          location.href
        ).href
      );
    }

    console.log("Generating Model");
  }

  /** Set editor mode: 'cascadestudio' or 'openscad'. */
  setMode(newMode) {
    if (newMode === this.mode) return;

    // Swap starter code if current content matches the other mode's starter
    const currentCode = this.editor.getValue();
    const csStarter = this._app.constructor.STARTER_CODE;
    const osStarter = this._app.constructor.OPENSCAD_STARTER_CODE;
    if (newMode === 'openscad' && osStarter && currentCode === csStarter) {
      this.setCode(osStarter);
    } else if (newMode === 'cascadestudio' && currentCode === osStarter) {
      this.setCode(csStarter);
    }

    // Fit camera on the next render after a mode switch
    if (this._app.viewport) {
      this._app.viewport._fitOnNextRender = true;
    }

    this.mode = newMode;

    // Dispose existing OpenSCAD providers
    this._openscadProviders.forEach(d => d.dispose());
    this._openscadProviders = [];

    if (newMode === 'openscad') {
      // Switch to OpenSCAD language
      const model = this.editor.getModel();
      monaco.editor.setModelLanguage(model, 'openscad');

      // Register OpenSCAD providers if available
      if (this._app._openscadMonaco) {
        this._openscadProviders = this._app._openscadMonaco.registerProviders(this.editor);
      }
    } else {
      // Switch back to TypeScript
      const model = this.editor.getModel();
      monaco.editor.setModelLanguage(model, 'typescript');
      monaco.languages.typescript.typescriptDefaults.setExtraLibs(this._extraLibs);
    }
  }

  /** Get the container for the code editor. */
  get container() {
    return this._codeContainer;
  }

  /** Collapse all top-level functions in the editor. */
  _collapseTopLevelFunctions(code, editor = this.editor) {
    let codeLines = code.split(/\r\n|\r|\n/);
    let collapsed = []; let curCollapse = null;
    for (let li = 0; li < codeLines.length; li++) {
      if (codeLines[li].startsWith("function")) {
        curCollapse = { "startLineNumber": (li + 1) };
      } else if (codeLines[li].startsWith("}") && curCollapse !== null) {
        curCollapse["endLineNumber"] = (li + 1);
        collapsed.push(curCollapse);
        curCollapse = null;
      }
    }
    let mergedViewState = Object.assign(editor.saveViewState(), {
      "contributionsState": {
        "editor.contrib.folding": {
          "collapsedRegions": collapsed,
          "lineCount": codeLines.length,
          "provider": "indent"
        },
        "editor.contrib.wordHighlighter": false
      }
    });
    editor.restoreViewState(mergedViewState);
  }

  /** Set up keyboard shortcuts for evaluation and save. */
  _setupKeyboardShortcuts(container, editor = this.editor) {
    document.onkeydown = (e) => {
      if (e.code === 'F5') {
        e.preventDefault();
        this.scheduleEvaluate(true, 0);
        return false;
      }
      if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this._app.saveProject();
        this.scheduleEvaluate(true, 0);
      }
      return true;
    };

    document.onkeyup = (e) => {
      if (!this._app.file.handle || e.which === 0) { return true; }
      if (this.editor !== editor) { return true; }
      if (this._app.file.content == editor.getValue()) {
        container.setTitle(this._app.file.handle.name);
      } else {
        container.setTitle('* ' + this._app.file.handle.name);
      }
      return true;
    };
  }

  static _isArrayLike(item) {
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

export { EditorManager };
