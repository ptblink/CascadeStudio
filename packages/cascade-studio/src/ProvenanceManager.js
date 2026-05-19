// ProvenanceManager.js - live provenance graph viewer

import cytoscape from 'cytoscape';

class ProvenanceManager {
  constructor(app) {
    this._app = app;
    this._container = null;
    this._graphEl = null;
    this._details = null;
    this._status = null;
    this._cy = null;
    this._lastGraph = null;
    this._updateToken = 0;
    this._resizeObserver = null;
    this._pendingRefresh = null;
  }

  initPanel(container) {
    container.element.innerHTML = '';
    container.element.style.position = 'relative';
    container.element.style.overflow = 'hidden';
    container.element.style.background = '#1e1e1e';
    container.element.style.color = '#d4d4d4';
    container.element.style.fontFamily = 'Menlo, Monaco, Consolas, "Liberation Mono", monospace';

    this._container = document.createElement('div');
    this._container.className = 'cs-provenance';
    this._container.style.position = 'absolute';
    this._container.style.inset = '0';
    this._container.style.display = 'flex';
    this._container.style.flexDirection = 'column';
    container.element.appendChild(this._container);

    const toolbar = document.createElement('div');
    toolbar.style.height = '26px';
    toolbar.style.flex = '0 0 26px';
    toolbar.style.display = 'flex';
    toolbar.style.alignItems = 'center';
    toolbar.style.gap = '8px';
    toolbar.style.padding = '0 8px';
    toolbar.style.borderBottom = '1px solid #333';
    toolbar.style.background = '#252526';
    this._container.appendChild(toolbar);

    this._status = document.createElement('span');
    this._status.textContent = 'Provenance graph: waiting for model';
    this._status.style.fontSize = '12px';
    this._status.style.color = '#cccccc';
    toolbar.appendChild(this._status);

    const fit = document.createElement('button');
    fit.textContent = 'Fit';
    fit.style.marginLeft = 'auto';
    fit.style.fontSize = '12px';
    fit.onclick = () => this._cy?.fit(undefined, 24);
    toolbar.appendChild(fit);

    const refresh = document.createElement('button');
    refresh.textContent = 'Refresh';
    refresh.style.fontSize = '12px';
    refresh.onclick = () => this.refresh();
    toolbar.appendChild(refresh);

    const body = document.createElement('div');
    body.style.flex = '1 1 auto';
    body.style.minHeight = '0';
    body.style.display = 'flex';
    this._container.appendChild(body);

    this._graphEl = document.createElement('div');
    this._graphEl.style.flex = '1 1 auto';
    this._graphEl.style.minWidth = '0';
    this._graphEl.style.position = 'relative';
    body.appendChild(this._graphEl);

    this._details = document.createElement('pre');
    this._details.style.margin = '0';
    this._details.style.padding = '8px';
    this._details.style.flex = '0 0 320px';
    this._details.style.overflow = 'auto';
    this._details.style.whiteSpace = 'pre-wrap';
    this._details.style.wordBreak = 'break-word';
    this._details.style.fontSize = '11px';
    this._details.style.borderLeft = '1px solid #333';
    this._details.style.background = '#181818';
    this._details.textContent = 'Run code to populate graph.';
    body.appendChild(this._details);

    this._resizeObserver?.disconnect();
    this._resizeObserver = new ResizeObserver(() => {
      const rect = this._graphEl?.getBoundingClientRect();
      if (rect?.width > 0 && rect?.height > 0 && !this._cy) {
        this._scheduleRefresh(0);
      }
    });
    this._resizeObserver.observe(this._graphEl);

    this._scheduleRefresh(0);
  }

  _initGraph() {
    if (!this._graphEl) { return false; }
    const rect = this._graphEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      if (this._status) { this._status.textContent = 'Provenance graph: waiting for panel layout'; }
      this._scheduleRefresh(100);
      return false;
    }
    this._cy?.destroy();
    try {
      this._cy = cytoscape({
      container: this._graphEl,
      elements: [],
      minZoom: 0.08,
      maxZoom: 3,
      wheelSensitivity: 0.18,
      style: [
        { selector: 'node', style: { 'background-color': '#6a9955', 'border-color': '#d4d4d4', 'border-width': 1, 'color': '#d4d4d4', 'font-size': 9, 'label': 'data(label)', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 78, 'width': 46, 'height': 46 } },
        { selector: 'node[type = "op"]', style: { 'background-color': '#569cd6', 'shape': 'round-rectangle', 'width': 74, 'height': 34 } },
        { selector: 'node[type = "shape"]', style: { 'background-color': '#c586c0', 'shape': 'diamond' } },
        { selector: 'node[type = "FACE"]', style: { 'background-color': '#dcdcaa', 'color': '#1e1e1e' } },
        { selector: 'node[type = "EDGE"]', style: { 'background-color': '#ce9178', 'color': '#1e1e1e' } },
        { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': '#777', 'target-arrow-color': '#777', 'width': 1.2, 'label': 'data(label)', 'font-size': 8, 'color': '#aaaaaa', 'text-rotation': 'autorotate' } },
        { selector: 'edge[relation = "created"]', style: { 'line-color': '#6a9955', 'target-arrow-color': '#6a9955' } },
        { selector: 'edge[relation = "modified"]', style: { 'line-color': '#d7ba7d', 'target-arrow-color': '#d7ba7d' } },
        { selector: 'edge[relation = "copied"]', style: { 'line-color': '#569cd6', 'target-arrow-color': '#569cd6' } },
        { selector: ':selected', style: { 'border-width': 3, 'border-color': '#ffffff', 'line-color': '#ffffff', 'target-arrow-color': '#ffffff' } }
        ]
      });
    } catch (err) {
      this._cy = null;
      if (this._status) { this._status.textContent = 'Provenance graph: renderer unavailable'; }
      if (this._details) { this._details.textContent = err?.message || String(err); }
      console.warn('Provenance renderer failed to initialize', err);
      return false;
    }
    this._cy.on('tap', 'node, edge', (event) => {
      this._details.textContent = JSON.stringify(event.target.data('raw') || event.target.data(), null, 2);
    });
    this._cy.on('tap', (event) => {
      if (event.target === this._cy) { this._details.textContent = this._summaryText(this._lastGraph); }
    });
    return true;
  }

  _scheduleRefresh(delay = 0) {
    if (this._pendingRefresh) { return; }
    this._pendingRefresh = setTimeout(() => {
      this._pendingRefresh = null;
      requestAnimationFrame(() => this.refresh());
    }, delay);
  }

  async refresh() {
    if (!this._graphEl || !this._app.engine?.getProvenanceGraph) { return; }
    if (!this._cy && !this._initGraph()) { return; }
    const token = ++this._updateToken;
    this._status.textContent = 'Provenance graph: loading...';
    try {
      const graph = await this._app.engine.getProvenanceGraph();
      if (token !== this._updateToken) { return; }
      this._lastGraph = graph || null;
      this._render(graph);
    } catch (err) {
      if (token !== this._updateToken) { return; }
      this._status.textContent = 'Provenance graph: error';
      this._details.textContent = err?.message || String(err);
    }
  }

  clear() {
    this._lastGraph = null;
    if (this._status) { this._status.textContent = 'Provenance graph: waiting for model'; }
    if (this._details) { this._details.textContent = 'Run code to populate graph.'; }
    this._cy?.elements().remove();
  }

  _render(graph) {
    if (!graph) {
      this.clear();
      return;
    }
    const elements = this._toCytoscapeElements(graph);
    const ops = graph.ops ? Object.keys(graph.ops).length : 0;
    const shapes = graph.shapes ? Object.keys(graph.shapes).length : 0;
    const subshapes = graph.subshapes ? Object.keys(graph.subshapes).length : 0;
    const edges = Array.isArray(graph.edges) ? graph.edges.length : 0;
    this._status.textContent = `Provenance graph: ${ops} ops, ${shapes} shapes, ${subshapes} subshapes, ${edges} links`;
    this._details.textContent = this._summaryText(graph);

    if (!this._cy && !this._initGraph()) { return; }
    this._cy.batch(() => {
      this._cy.elements().remove();
      this._cy.add(elements);
      this._cy.layout({ name: 'breadthfirst', directed: true, padding: 30, spacingFactor: 1.25, animate: false }).run();
    });
    requestAnimationFrame(() => this._cy?.fit(undefined, 24));
  }

  _toCytoscapeElements(graph) {
    const elements = [];
    const hasNode = new Set();
    let nodeIndex = 0;
    const addNode = (id, label, type, raw) => {
      if (!id || hasNode.has(id)) { return; }
      hasNode.add(id);
      const index = nodeIndex++;
      elements.push({
        data: { id, label, type, raw },
        // Give every node a distinct safe position before layout runs. Cytoscape
        // validates edge endpoints immediately on add(); overlapping default
        // positions can emit noisy "invalid endpoints" warnings for valid graphs.
        position: { x: (index % 32) * 120, y: Math.floor(index / 32) * 90 }
      });
    };
    const addEdge = (source, target, label, relation, raw) => {
      if (!source || !target || !hasNode.has(source) || !hasNode.has(target)) { return; }
      elements.push({ data: { id: `${source}->${target}:${elements.length}`, source, target, label, relation, raw } });
    };

    for (const op of Object.values(graph.ops || {})) {
      addNode(op.opId, `${op.fnName}\nline ${op.lineNumber ?? '?'}`, 'op', op);
    }
    for (const shape of Object.values(graph.shapes || {})) {
      addNode(shape.shapeId, `shape ${shape.shapeIndex}\nstep ${shape.historyStepIndex}`, 'shape', shape);
      addEdge(shape.opId, shape.shapeId, 'emits', 'emits', shape);
    }
    for (const subshape of Object.values(graph.subshapes || {})) {
      const shortHash = subshape.hash ? String(subshape.hash).slice(0, 8) : '';
      addNode(subshape.subshapeId, `${subshape.type} ${subshape.index}\n${shortHash}`, subshape.type, subshape);
      addEdge(subshape.shapeId, subshape.subshapeId, 'contains', 'contains', subshape);
    }
    for (const edge of graph.edges || []) {
      if (edge.from) { addEdge(edge.from, edge.to, edge.relation, edge.relation, edge); }
      else { addEdge(edge.opId, edge.to, edge.relation, edge.relation, edge); }
    }
    return elements;
  }

  _summaryText(graph) {
    if (!graph) { return 'Run code to populate graph.'; }
    return JSON.stringify({
      version: graph.version,
      ops: Object.keys(graph.ops || {}).length,
      shapes: Object.keys(graph.shapes || {}).length,
      subshapes: Object.keys(graph.subshapes || {}).length,
      edges: Array.isArray(graph.edges) ? graph.edges.length : 0,
      hint: 'Click nodes/edges for raw provenance data. Drag to pan, scroll to zoom.'
    }, null, 2);
  }
}

export { ProvenanceManager };
