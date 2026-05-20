// GraphManager.js - live graph viewer

import cytoscape from 'cytoscape';

class GraphManager {
  constructor(app) {
    this._app = app;
    this._container = null;
    this._graphEl = null;
    this._details = null;
    this._status = null;
    this._cy = null;
    this._lastGraph = null;
    this._focusSubshapeId = null;
    this._focusLabel = null;
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
    this._container.className = 'cs-graph';
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
    this._status.textContent = 'Graph: waiting for model';
    this._status.style.fontSize = '12px';
    this._status.style.color = '#cccccc';
    toolbar.appendChild(this._status);

    const fit = document.createElement('button');
    fit.textContent = 'Fit';
    fit.style.marginLeft = 'auto';
    fit.style.fontSize = '12px';
    fit.onclick = () => this._cy?.fit(undefined, 24);
    toolbar.appendChild(fit);

    const showAll = document.createElement('button');
    showAll.textContent = 'Show all';
    showAll.style.fontSize = '12px';
    showAll.onclick = () => this.showAll();
    toolbar.appendChild(showAll);

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
      if (this._status) { this._status.textContent = 'Graph: waiting for panel layout'; }
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
      if (this._status) { this._status.textContent = 'Graph: renderer unavailable'; }
      if (this._details) { this._details.textContent = err?.message || String(err); }
      console.warn('Graph renderer failed to initialize', err);
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
    this._status.textContent = 'Graph: loading...';
    try {
      const graph = await this._app.engine.getProvenanceGraph();
      if (token !== this._updateToken) { return; }
      this._lastGraph = graph || null;
      if (this._focusSubshapeId) {
        await this._renderFocusedGraph(this._focusSubshapeId, this._focusLabel);
      } else {
        this._render(graph);
      }
    } catch (err) {
      if (token !== this._updateToken) { return; }
      this._status.textContent = 'Graph: error';
      this._details.textContent = err?.message || String(err);
    }
  }

  clear() {
    this._lastGraph = null;
    this._focusSubshapeId = null;
    this._focusLabel = null;
    if (this._status) { this._status.textContent = 'Graph: waiting for model'; }
    if (this._details) { this._details.textContent = 'Run code to populate graph.'; }
    this._cy?.elements().remove();
  }

  showAll() {
    this._focusSubshapeId = null;
    this._focusLabel = null;
    if (this._lastGraph) this._render(this._lastGraph);
    else this.refresh();
  }

  async focusSubshape(subshapeId, label = 'selection') {
    if (!subshapeId) { return; }
    this._focusSubshapeId = subshapeId;
    this._focusLabel = label;
    if (!this._lastGraph) await this.refresh();
    else await this._renderFocusedGraph(subshapeId, label);
  }

  async _renderFocusedGraph(subshapeId, label = 'selection') {
    if (!this._lastGraph) { return; }
    try {
      const trace = await this._app.engine.traceSubshape(subshapeId);
      const focused = this._filterGraphForTrace(this._lastGraph, trace, subshapeId);
      this._render(focused, { label, trace, sourceGraph: this._lastGraph });
    } catch (err) {
      if (this._status) { this._status.textContent = 'Graph: trace error'; }
      if (this._details) { this._details.textContent = err?.message || String(err); }
    }
  }

  _filterGraphForTrace(graph, trace, subshapeId) {
    const nodeIds = new Set([subshapeId]);
    const edgeKeys = new Set();
    const addEdgeKey = (edge) => edgeKeys.add(`${edge.from || ''}->${edge.to || ''}:${edge.opId || ''}:${edge.relation || ''}`);

    for (const step of trace?.chain || []) {
      if (step.subshapeId) nodeIds.add(step.subshapeId);
      if (step.from) nodeIds.add(step.from);
      if (step.opId) nodeIds.add(step.opId);
    }

    for (const edge of graph.edges || []) {
      if (nodeIds.has(edge.to) || (edge.from && nodeIds.has(edge.from))) {
        if (edge.opId) nodeIds.add(edge.opId);
        if (edge.to) nodeIds.add(edge.to);
        if (edge.from) nodeIds.add(edge.from);
        addEdgeKey(edge);
      }
    }

    for (const subshapeId of [...nodeIds]) {
      const subshape = graph.subshapes?.[subshapeId];
      if (subshape?.shapeId) nodeIds.add(subshape.shapeId);
    }
    for (const shapeId of [...nodeIds]) {
      const shape = graph.shapes?.[shapeId];
      if (shape?.opId) nodeIds.add(shape.opId);
    }

    return {
      version: graph.version,
      ops: Object.fromEntries(Object.entries(graph.ops || {}).filter(([id]) => nodeIds.has(id))),
      shapes: Object.fromEntries(Object.entries(graph.shapes || {}).filter(([id]) => nodeIds.has(id))),
      subshapes: Object.fromEntries(Object.entries(graph.subshapes || {}).filter(([id]) => nodeIds.has(id))),
      edges: (graph.edges || []).filter((edge) => edgeKeys.has(`${edge.from || ''}->${edge.to || ''}:${edge.opId || ''}:${edge.relation || ''}`))
    };
  }

  _render(graph, focus = null) {
    if (!graph) {
      this.clear();
      return;
    }
    const elements = this._toCytoscapeElements(graph);
    const ops = graph.ops ? Object.keys(graph.ops).length : 0;
    const shapes = graph.shapes ? Object.keys(graph.shapes).length : 0;
    const subshapes = graph.subshapes ? Object.keys(graph.subshapes).length : 0;
    const edges = Array.isArray(graph.edges) ? graph.edges.length : 0;
    const prefix = focus ? `Graph: ${focus.label} trace` : 'Graph';
    this._status.textContent = `${prefix}: ${ops} ops, ${shapes} shapes, ${subshapes} subshapes, ${edges} links`;
    this._details.textContent = focus ? this._traceSummaryText(focus.trace, graph) : this._summaryText(graph);

    if (!this._cy && !this._initGraph()) { return; }
    this._applyLayeredPositions(elements);
    this._cy.batch(() => {
      this._cy.elements().remove();
      this._cy.add(elements);
      this._cy.layout({ name: 'preset', fit: true, padding: 24, animate: false }).run();
    });
    requestAnimationFrame(() => this._cy?.fit(undefined, 24));
  }

  _applyLayeredPositions(elements) {
    const nodes = elements.filter((el) => el.data && !el.data.source);
    const edges = elements.filter((el) => el.data?.source && el.data?.target);
    if (nodes.length === 0) { return; }

    const byId = new Map(nodes.map((node) => [node.data.id, node]));
    const outgoing = new Map(nodes.map((node) => [node.data.id, []]));
    const incomingCount = new Map(nodes.map((node) => [node.data.id, 0]));
    for (const edge of edges) {
      const source = edge.data.source;
      const target = edge.data.target;
      if (!byId.has(source) || !byId.has(target)) { continue; }
      outgoing.get(source).push(target);
      incomingCount.set(target, incomingCount.get(target) + 1);
    }
    for (const children of outgoing.values()) {
      children.sort((a, b) => this._nodeSortKey(byId.get(a)).localeCompare(this._nodeSortKey(byId.get(b))));
    }

    const roots = nodes
      .filter((node) => (incomingCount.get(node.data.id) || 0) === 0)
      .sort((a, b) => this._nodeSortKey(a).localeCompare(this._nodeSortKey(b)))
      .map((node) => node.data.id);
    const assigned = new Set();
    const rowRoots = roots.length ? roots : [];
    for (const node of nodes.sort((a, b) => this._nodeSortKey(a).localeCompare(this._nodeSortKey(b)))) {
      if (!rowRoots.includes(node.data.id)) { rowRoots.push(node.data.id); }
    }

    const depthGap = 150;
    const leafGap = 150;
    const rootGap = 220;
    const leftPad = 90;
    const topPad = 70;
    const rowGap = 120;
    const graphWidth = Math.max(600, this._graphEl?.clientWidth || 0);
    const maxRowWidth = Math.max(leafGap * 2, graphWidth - leftPad * 2);

    const measureSubtree = (id, visiting = new Set()) => {
      if (visiting.has(id)) { return { leaves: 1, depth: 0 }; }
      visiting.add(id);
      const children = outgoing.get(id) || [];
      if (children.length === 0) {
        visiting.delete(id);
        return { leaves: 1, depth: 0 };
      }
      let leaves = 0;
      let depth = 0;
      for (const child of children) {
        const childSpan = measureSubtree(child, visiting);
        leaves += childSpan.leaves;
        depth = Math.max(depth, childSpan.depth + 1);
      }
      visiting.delete(id);
      return { leaves: Math.max(1, leaves), depth };
    };

    const rowBounds = new Map();
    const trackRowBounds = (rowTop, xPos) => {
      const bounds = rowBounds.get(rowTop) || { min: Infinity, max: -Infinity };
      bounds.min = Math.min(bounds.min, xPos);
      bounds.max = Math.max(bounds.max, xPos);
      rowBounds.set(rowTop, bounds);
    };

    // Horizontal tree layout: roots/parents spread left-to-right. Children go
    // downward. When subtrees fill the visible graph width, later parent/root
    // nodes wrap to a new row so the graph grows in pages instead of one long line.
    // Shared/cyclic nodes are placed once; later links point to that existing position.
    const placeSubtree = (id, depth, cursor, rowTop, visiting = new Set()) => {
      if (assigned.has(id)) { return { left: cursor, right: cursor, placed: false }; }
      if (visiting.has(id)) { return { left: cursor, right: cursor, placed: false }; }

      visiting.add(id);
      assigned.add(id);

      const children = (outgoing.get(id) || []).filter((child) => !assigned.has(child) && !visiting.has(child));
      let left = cursor;
      let right = cursor;

      if (children.length === 0) {
        right = cursor + leafGap;
      } else {
        let childCursor = cursor;
        for (const child of children) {
          const childSpan = placeSubtree(child, depth + 1, childCursor, rowTop, visiting);
          if (childSpan.placed) {
            childCursor = childSpan.right;
          }
        }
        right = Math.max(cursor + leafGap, childCursor);
      }

      const node = byId.get(id);
      if (node) {
        const xPos = (left + right) / 2;
        node.position = { x: xPos, y: rowTop + topPad + depth * depthGap };
        node._layoutRowTop = rowTop;
        trackRowBounds(rowTop, xPos);
      }

      visiting.delete(id);
      return { left, right, placed: true };
    };

    let x = leftPad;
    let rowTop = 0;
    let rowDepth = 0;
    let rowHasNodes = false;
    for (const root of rowRoots) {
      if (assigned.has(root)) { continue; }
      const measured = measureSubtree(root);
      const estimatedWidth = measured.leaves * leafGap;
      const usedWidth = x - leftPad;
      if (rowHasNodes && usedWidth + estimatedWidth > maxRowWidth) {
        rowTop += topPad + (rowDepth + 1) * depthGap + rowGap;
        x = leftPad;
        rowDepth = 0;
        rowHasNodes = false;
      }
      const span = placeSubtree(root, 0, x, rowTop);
      if (span.placed) {
        rowDepth = Math.max(rowDepth, measured.depth);
        rowHasNodes = true;
      }
      x = Math.max(x + leafGap, span.right) + rootGap;
    }

    const targetCenter = leftPad + maxRowWidth / 2;
    for (const [rowTop, bounds] of rowBounds.entries()) {
      if (!Number.isFinite(bounds.min) || !Number.isFinite(bounds.max)) { continue; }
      const rowCenter = (bounds.min + bounds.max) / 2;
      const offset = targetCenter - rowCenter;
      for (const node of nodes) {
        if (node._layoutRowTop === rowTop && node.position) {
          node.position.x += offset;
          delete node._layoutRowTop;
        }
      }
    }
  }

  _nodeSortKey(node) {
    const raw = node.data?.raw || {};
    return `${node.data?.type || ''}:${raw.lineNumber ?? raw.historyStepIndex ?? raw.shapeIndex ?? raw.index ?? ''}:${node.data?.id || ''}`;
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

  _traceSummaryText(trace, graph) {
    if (!trace) { return 'No graph trace for selection.'; }
    return JSON.stringify({
      selected: trace.selected?.subshapeId || null,
      type: trace.selected?.type || null,
      shape: trace.selected?.shapeId || null,
      summary: trace.summary || '',
      visibleGraph: {
        ops: Object.keys(graph.ops || {}).length,
        shapes: Object.keys(graph.shapes || {}).length,
        subshapes: Object.keys(graph.subshapes || {}).length,
        edges: Array.isArray(graph.edges) ? graph.edges.length : 0
      },
      chain: trace.chain || [],
      hint: 'Filtered to nodes/edges that created or mutated selected item. Click Show all to restore full graph.'
    }, null, 2);
  }

  _summaryText(graph) {
    if (!graph) { return 'Run code to populate graph.'; }
    return JSON.stringify({
      version: graph.version,
      ops: Object.keys(graph.ops || {}).length,
      shapes: Object.keys(graph.shapes || {}).length,
      subshapes: Object.keys(graph.subshapes || {}).length,
      edges: Array.isArray(graph.edges) ? graph.edges.length : 0,
      hint: 'Click nodes/edges for raw graph data. Drag to pan, scroll to zoom.'
    }, null, 2);
  }
}

export { GraphManager };
