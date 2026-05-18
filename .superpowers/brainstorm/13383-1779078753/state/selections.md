## Q1: What should “convert STEP to CascadeStudio JS” mean first?
- **Selected:** A — Import wrapper JS + extracted assembly map
- **Why it won (pros):** Most reliable; reuses OCCT STEP reader already in `FileUtils.js`; preserves exact CAD geometry; fits existing `externalShapes` + `sceneShapes.push()` import path.
- **Accepted trade-offs (cons):** Not full parametric reconstruction; large generated projects if STEP is embedded; original CAD feature history remains opaque.
- **Visual reference:** conversion-strategy.html
- **Notes:** Browser selection.

## Q2: Where should the STEP data live in generated JS?
- **Selected:** B — Attach STEP as project external file
- **Why it won (pros):** Fits current `externalShapes[fileName]` app model; keeps generated JS readable; better for larger assemblies; lowest implementation risk by extending current project load/save behavior.
- **Accepted trade-offs (cons):** JS alone is not enough; project must retain attached file data; needs clear missing-file errors; raw code sharing loses geometry.
- **Visual reference:** step-storage.html
- **Notes:** Browser selection.

## Q3: How much assembly structure should converter extract?
- **Selected:** B — Extract named parts/solids into editable manifest
- **Why it won (pros):** Matches user need; preserves exact STEP geometry while making organization editable; enables rename/recolor/visibility/transforms; reliable if fallback preserves original combined shape.
- **Accepted trade-offs (cons):** Needs deeper STEP/XDE label traversal than current `OneShape()` path; some files need stable fallback names; generated code is longer.
- **Visual reference:** assembly-granularity.html
- **Notes:** Browser selection.

## Q4: What should generated CascadeStudio JS look like?
- **Selected:** A — Declarative part manifest + small helper functions
- **Why it won (pros):** Best fit for non-coders; editable names/colors/visibility/transforms in one table; helper can enforce missing-file checks and stable fallbacks; maintainable schema; no new UI required first.
- **Accepted trade-offs (cons):** Some helper boilerplate in generated JS; users must understand simple object fields; complex conditional assemblies still need JS edits.
- **Visual reference:** generated-code-shape.html
- **Notes:** Browser selection.

## Q5: Where should STEP analysis/conversion run?
- **Selected:** A — In-browser worker using OpenCascade.js
- **Why it won (pros):** Fits existing Web Worker + WASM parsing architecture; private/offline; no server dependency; generated code can use current `externalShapes` state immediately.
- **Accepted trade-offs (cons):** Limited by available OpenCascade.js bindings; heavy assembly traversal needs progress/errors; native OCCT/XDE features may be missing.
- **Visual reference:** converter-location.html
- **Notes:** Browser selection.
