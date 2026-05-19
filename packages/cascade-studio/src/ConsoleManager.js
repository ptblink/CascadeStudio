// ConsoleManager.js - Console output management and log capture

import { Terminal } from '@xterm/xterm';

const monaco = window.monaco;

/** Manages the console panel, captures logs/errors for programmatic access. */
class ConsoleManager {
  constructor(app) {
    this._app = app;
    this.logs = [];
    this.errors = [];
    this._consoleContainer = null;
    this._terminalHost = null;
    this._copyButton = null;
    this._copyButtonResetTimer = null;
    this._clearButton = null;
    this._consoleGolden = null;
    this._terminal = null;
    this._resizeObserver = null;
    this._realConsoleLog = null;
    this._realConsoleError = null;
    this._realConsoleWarn = null;
    this._realConsoleInfo = null;
    this._progressLines = new Map();
    this._activeProgressId = null;
    this._initialized = false;
  }

  /** Initialize the console panel inside a DockviewContainer. */
  initPanel(container) {
    this._consoleGolden = container;
    container.element.innerHTML = '';
    container.element.style.position = 'relative';
    container.element.style.overflow  = 'hidden';
    container.element.style.boxShadow = "inset 0px 0px 3px rgba(0,0,0,0.75)";

    this._consoleContainer = document.createElement("div");
    this._consoleContainer.className = 'cs-console';
    this._consoleContainer.style.position = 'absolute';
    this._consoleContainer.style.inset = '0';
    this._consoleContainer.style.overflow = 'hidden';
    container.element.appendChild(this._consoleContainer);

    this._terminalHost = document.createElement("div");
    this._terminalHost.className = 'cs-console-terminal';
    this._terminalHost.style.position = 'absolute';
    this._terminalHost.style.left = '0';
    this._terminalHost.style.right = '0';
    this._terminalHost.style.top = '26px';
    this._terminalHost.style.bottom = '0';
    this._terminalHost.style.overflow = 'hidden';
    this._consoleContainer.appendChild(this._terminalHost);

    this._terminal = new Terminal({
      convertEol: true,
      scrollback: 5000,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      lineHeight: 1.25,
      cursorBlink: false,
      disableStdin: true,
      scrollOnUserInput: false,
      theme: {
        background: '#1e1e1e',
        foreground: '#eeeeee',
        cursor: '#eeeeee',
        black: '#000000',
        red: '#f44747',
        green: '#b5cea8',
        yellow: '#dcdcaa',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#9cdcfe',
        white: '#eeeeee',
        brightBlack: '#808080',
        brightRed: '#f44747',
        brightGreen: '#b5cea8',
        brightYellow: '#dcdcaa',
        brightBlue: '#569cd6',
        brightMagenta: '#c586c0',
        brightCyan: '#9cdcfe',
        brightWhite: '#ffffff'
      }
    });
    this._terminal.open(this._terminalHost);
    this._resizeTerminal();
    this._resizeObserver = new ResizeObserver(() => this._resizeTerminal());
    this._resizeObserver.observe(this._terminalHost);

    this._copyButton = this._createToolbarButton('Copy', 'Copy console output', '56px');
    this._copyButton.addEventListener('click', () => this.copyDisplayedText());
    container.element.appendChild(this._copyButton);

    this._clearButton = this._createToolbarButton('Clear', 'Clear console', '6px');
    this._clearButton.addEventListener('click', () => this.clear());
    container.element.appendChild(this._clearButton);

    if (!this._initialized) {
      this._initialized = true;
      this._setupConsoleOverrides();

      window.onerror = (err, url, line, colno, errorObj) => {
        let errorText = JSON.stringify(err, ConsoleManager._circularReplacer());
        if (errorText.startsWith('"')) { errorText = errorText.slice(1, -1); }

        this.errors.push("Line " + line + ": " + errorText);

        this._writeConsoleLine("error", "Line " + line + ": " + errorText);

        if (!errorObj || !(errorObj.stack.includes("wasm-function"))) {
          const editor = this._app.editor.editor;
          if (editor) {
            monaco.editor.setModelMarkers(editor.getModel(), 'test', [{
              startLineNumber: line,
              startColumn: colno,
              endLineNumber: line,
              endColumn: 1000,
              message: JSON.stringify(err, ConsoleManager._circularReplacer()),
              severity: monaco.MarkerSeverity.Error
            }]);
          }
        }
      };

      this.showWelcome(false);
    }
  }

  /** Get all logs since last clear. */
  getLogs() { return this.logs.slice(); }

  /** Get all errors since last clear. */
  getErrors() { return this.errors.slice(); }

  /** Copy all text currently held by xterm (visible buffer + scrollback). */
  async copyDisplayedText() {
    const text = this.getDisplayedText();
    try {
      await navigator.clipboard.writeText(text);
      this._flashCopyButton('Copied');
    } catch (err) {
      this._fallbackCopyText(text);
      this._flashCopyButton('Copied');
    }
  }

  /** Get all text currently held by xterm (visible buffer + scrollback). */
  getDisplayedText() {
    if (!this._terminal) return '';
    this._finishActiveProgressLine();
    const buffer = this._terminal.buffer.active;
    const lineCount = buffer.baseY + buffer.cursorY + 1;
    let lines = [];
    for (let i = 0; i < lineCount; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) || '');
    }
    return lines.join('\n').replace(/[\s\n]*$/, '');
  }

  /** Clear logs, errors, and the visual console. */
  clear() {
    this.logs = [];
    this.errors = [];
    this._progressLines.clear();
    this._activeProgressId = null;
    if (this._terminal) {
      this._terminal.clear();
      this._terminal.reset();
    }
  }

  /** Display idle startup message without evaluating geometry. */
  showWelcome(kernelReady = true) {
    console.log("Welcome to Cascade Studio!");
    console.log(kernelReady ? "CAD Kernel ready. Import STEP file or choose from existing parametrised fixtures." : "Loading CAD Kernel...");
  }

  /** Get the container (for state persistence of imported files). */
  get goldenContainer() { return this._consoleGolden; }

  /** Update or create a CLI-style progress line. */
  updateProgress(id, label, detail = '', percent = null, options = {}) {
    if (!this._terminal) return;

    const width = 28;
    let normalized = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
    let filled = normalized === null ? (options.spinner || 0) % width : Math.round((normalized / 100) * width);
    let bar = '';
    for (let i = 0; i < width; i++) {
      if (normalized === null) {
        bar += (i === filled) ? '>' : '-';
      } else {
        bar += (i < filled) ? '#' : '-';
      }
    }

    let pct = normalized === null ? ' --%' : String(Math.round(normalized)).padStart(3, ' ') + '%';
    let text = `${label} [${bar}] ${pct}` + (detail ? `  ${detail}` : '');

    this._writeProgressLine(id, (options.done || normalized === 100) ? "success" : "progress", text, options.done || normalized === 100);
  }

  /** Override browser console methods and mirror them into xterm.js. */
  _setupConsoleOverrides() {
    this._realConsoleLog = console.log;
    this._realConsoleError = console.error;
    this._realConsoleWarn = console.warn;
    this._realConsoleInfo = console.info;
    const self = this;

    console.log = function (...args) {
      const messageText = ConsoleManager._stringifyArgs(args);
      self.logs.push(messageText);
      self._writeConsoleLine("log", messageText);
      self._realConsoleLog.apply(console, args);
    };

    console.info = function (...args) {
      const messageText = ConsoleManager._stringifyArgs(args);
      self.logs.push(messageText);
      self._writeConsoleLine("info", messageText);
      self._realConsoleInfo.apply(console, args);
    };

    console.warn = function (...args) {
      const messageText = ConsoleManager._stringifyArgs(args);
      self.logs.push(messageText);
      self._writeConsoleLine("warn", messageText);
      self._realConsoleWarn.apply(console, args);
    };

    console.error = function (...args) {
      const messageText = ConsoleManager._stringifyArgs(args);
      self.errors.push(messageText);
      self._writeConsoleLine("error", messageText);
      self._realConsoleError.apply(console, args);
    };
  }

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

  _resizeTerminal() {
    if (!this._terminal || !this._terminalHost) return;
    const rect = this._terminalHost.getBoundingClientRect();
    const dimensions = this._terminal._core?._renderService?.dimensions;
    const cellWidth = dimensions?.css?.cell?.width || 8.4;
    const cellHeight = dimensions?.css?.cell?.height || 17.5;
    const cols = Math.max(20, Math.floor((rect.width - 16) / cellWidth));
    const rows = Math.max(2, Math.floor((rect.height - 10) / cellHeight));
    this._terminal.resize(cols, rows);
  }

  _writeConsoleLine(level, text) {
    if (!this._terminal) return;
    this._finishActiveProgressLine();
    this._terminal.write(this._formatTerminalRecord(level, text) + '\r\n');
    this._terminal.scrollToBottom();
  }

  _writeProgressLine(id, level, text, done = false) {
    if (!this._terminal) return;
    if (this._activeProgressId && this._activeProgressId !== id) {
      this._terminal.write('\r\n');
    }
    this._activeProgressId = done ? null : id;
    this._terminal.write('\r\x1b[2K' + this._formatTerminalRecord(level, text));
    if (done) this._terminal.write('\r\n');
    this._terminal.scrollToBottom();
  }

  _finishActiveProgressLine() {
    if (!this._activeProgressId) return;
    this._terminal.write('\r\n');
    this._activeProgressId = null;
  }

  _formatTerminalRecord(level, text) {
    const colors = {
      log: '\x1b[37m',
      info: '\x1b[36m',
      warn: '\x1b[33m',
      error: '\x1b[31m',
      progress: '\x1b[36m',
      success: '\x1b[32m'
    };
    const prefix = level === "error" ? "! " : level === "warn" ? "⚠ " : "› ";
    const color = colors[level] || colors.log;
    const body = this._escapeForTerminal(String(text)).replace(/\r?\n/g, '\r\n  ');
    return `${color}${prefix}${body}\x1b[0m`;
  }

  _escapeForTerminal(text) {
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  }

  static _stringifyArgs(args) {
    if (args.length === 0) return "";
    return args.map(arg => {
      if (arg === undefined) return "undefined";
      if (typeof arg === "string") return arg;
      let s = JSON.stringify(arg, ConsoleManager._circularReplacer());
      if (s && s.startsWith('"')) { s = s.slice(1, -1); }
      return s;
    }).join(' ');
  }

  static _circularReplacer() {
    let seen = new WeakSet();
    return (key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) { return; }
        seen.add(value);
      }
      return value;
    };
  }
}

export { ConsoleManager };
