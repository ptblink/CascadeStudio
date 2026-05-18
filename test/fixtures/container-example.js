// Welcome to Cascade Studio!  A Browser-Based CAD Modeling Environment.
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
console.log("Volume:  " + Math.abs(Volume(tray)).toFixed(0) + " mm\u00B3");
console.log("Surface: " + SurfaceArea(tray).toFixed(0) + " mm\u00B2");
let com = CenterOfMass(tray);
console.log("Center:  [" + com.map(v => v.toFixed(1)).join(", ") + "]");
