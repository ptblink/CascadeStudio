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
    this._copyButton = null;
    this._copyButtonResetTimer = null;
    this._evaluateButton = null;
    this._clearButton = null;
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
    container.element.style.position = container.element.style.position || 'relative';
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

    this._evaluateButton = this._createToolbarButton('Evaluate', 'Evaluate code', '108px');
    this._evaluateButton.addEventListener('click', () => this.scheduleEvaluate(true, 0));
    container.element.appendChild(this._evaluateButton);

    this._copyButton = this._createToolbarButton('Copy', 'Copy code', '56px');
    this._copyButton.addEventListener('click', () => this.copyCode());
    container.element.appendChild(this._copyButton);

    this._clearButton = this._createToolbarButton('Clear', 'Clear code', '6px');
    this._clearButton.addEventListener('click', () => this.clearCode());
    container.element.appendChild(this._clearButton);

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

  /** Copy current editor code to clipboard. */
  async copyCode() {
    const text = this.getCode();
    try {
      await navigator.clipboard.writeText(text);
      this._flashCopyButton('Copied');
    } catch (err) {
      this._fallbackCopyText(text);
      this._flashCopyButton('Copied');
    }
  }

  /** Clear current editor code. */
  clearCode() {
    this.setCode('');
    if (this._codeContainer) {
      this._codeContainer.setState({ code: '' });
    }
    if (this.editor) {
      this.editor.focus();
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
      return Promise.resolve(false);
    }
    if (!this._app.engine || !this._app.engine.isReady) { return Promise.resolve(false); }

    monaco.languages.typescript.typescriptDefaults.setExtraLibs(this._extraLibs);
    let newCode = this.editor.getValue();
    monaco.editor.setModelMarkers(this.editor.getModel(), 'test', []);

    // Clear console and refresh the GUI Panel
    if (!preserveConsole) { this._app.console.clear(); }
    this._app.gui.reset();
    if (this._app.viewport) this._app.viewport.clearTransformHandles();

    if (!newCode.trim()) {
      if (!preserveConsole) { this._app.console.showWelcome(true); }
      this._app.graph?.clear();
      this._codeContainer.setState({ code: newCode });
      return Promise.resolve(false);
    }

    window.workerWorking = true;
    this._app.console.startSpinner('model', 'Generating Model', 'starting', { percent: 0 });

    // Transpile OpenSCAD if needed
    let codeToEval = newCode;
    if (this.mode === 'openscad' && this._app._openscadTranspiler) {
      try {
        codeToEval = this._app._openscadTranspiler.transpile(newCode);
      } catch (e) {
        console.error("OpenSCAD transpile error: " + e.message);
        window.workerWorking = false;
        this._app.console.stopSpinner('model', { detail: 'failed', level: 'error' });
        return Promise.resolve(false);
      }
    }

    // Use CascadeEngine to evaluate and get mesh data
    const evaluationPromise = this._app.engine.evaluate(codeToEval, {
      guiState: this._app.gui.state,
    }).then(async (result) => {
      if (this._app.viewport && result.meshData) {
        await this._app.viewport.renderMeshData(result.meshData, result.sceneOptions);
      }
      this._app.graph?.refresh();
      return true;
    }).catch((err) => {
      console.error("Evaluation error: " + err.message);
      this._app.console.stopSpinner('model', { detail: 'failed', level: 'error' });
      return false;
    }).finally(() => {
      window.workerWorking = false;
      this._app.console.stopSpinner('model', { detail: 'done' });
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

    // Spinner owns the live "Generating Model" console line.
    return evaluationPromise;
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
  _createToolbarButton(label, title, right) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.style.position = 'absolute';
    button.style.top = '4px';
    button.style.right = right;
    button.style.zIndex = '1';
    button.style.padding = '2px 8px';
    button.style.fontFamily = 'var(--cs-font-ui, sans-serif)';
    button.style.fontSize = '11px';
    button.style.color = 'var(--cs-text-primary, #f2f2f2)';
    button.style.background = 'var(--cs-bg-elevated, #404040)';
    button.style.border = '1px solid var(--cs-border, #333)';
    button.style.borderRadius = 'var(--cs-radius, 4px)';
    button.style.cursor = 'pointer';
    return button;
  }

  _fallbackCopyText(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  _flashCopyButton(label) {
    if (!this._copyButton) return;
    const oldLabel = this._copyButton.textContent;
    this._copyButton.textContent = label;
    clearTimeout(this._copyButtonResetTimer);
    this._copyButtonResetTimer = setTimeout(() => {
      if (this._copyButton) this._copyButton.textContent = oldLabel;
    }, 1000);
  }

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
