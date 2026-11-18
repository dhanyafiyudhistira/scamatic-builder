# SCAMATIC Canvas Lab — egui prototype 0.1.17

A separate native Rust layout editor for evaluating egui. The React/Tauri Builder and its 0.2.18 installer remain the main application. This prototype has its own executable, Cargo workspace and lockfile; it does not change the production dependency graph.

## Run on Windows

Build with Rust 1.95 or newer, the MSVC build tools, and the existing Node environment:

```powershell
npm run egui:build
```

Open `target/egui-builder/SCAMATIC-Canvas-Lab_0.1.17_x64.exe` after packaging, or `target/egui-builder/release/scamatic-egui-builder.exe` after a local build. The prototype starts with the embedded IoT dashboard example; no server, database or account is needed. The app requires an OpenGL-capable desktop. The executable is portable and separate from the production installer.

For development: `npm run egui:dev`. For Rust tests and compatibility checks against the original JavaScript schema validator: `npm run egui:test`. Generated component definitions and the sample project come from `scripts/prepare-egui-builder.js`, which reads the shared schema and component registry.

For native screenshot QA, run the executable with `--capture preview.png`. An optional component ID, such as `--capture preview.png pump`, selects that demo object to inspect the Properties panel. Capture mode runs in a hidden window and exits after saving the PNG. Use `--capture-markup preview.png` for a fixture with an expanded toolbar, annotation text, an arrow and a rounded frame.

## Try the editor

1. Select a component on the canvas or in Layers. Drag to move; drag the bottom-right handle to resize. Use View → Snap to grid (20 px) for grid alignment. Locked layers cannot be moved or resized.
2. Edit the name, geometry, label/text or compatible tag binding in the right Properties panel. Add components from the left icon toolbar (hover for names) or the Insert menu. The Layers list sits below Properties. Undo/Redo and Ctrl+Z/Ctrl+Y restore edits; Escape cancels a drag.
3. Use File → Open JSON for a raw project schema, an API response with a top-level `schema`, a saved draft, or the `deployment.json` inside an exported hosted-runtime package. File → Import SVG adds a background to the working copy.
4. Save copy writes a new JSON file atomically. The currently imported file is protected from overwrite. Opening another project or closing with unsaved edits offers Save copy, Keep editing or Discard edits.

Version 0.1.8 removes the SCAMATIC label before File and distinguishes the two text tools with Iconoir Text Size for SCADA labels and Iconoir Text Box for markup annotations. The workspace has a compact menu bar, a centered artboard, stacked Properties/Layers and a compact status bar. Version 0.1.5 centers the floating palette vertically within the workspace, reduces the zoom slider and its handle, and starts the Label/Text input at one row while retaining multiline editing. The informational document strip above the canvas is removed. The project name appears in the native window title; an asterisk in that title and an Unsaved changes message in the status bar mark unsaved edits. Closing or opening another document still checks for unsaved work. File contains opening/importing/saving, Edit contains Move / Select and Undo/Redo, and View contains zoom, Fit canvas, grid display and snapping. The compact floating component palette keeps its narrow single column, with a soft shadow and a corner radius of 20% of its width (8 logical pixels). Icons retain their 16-point drawing size. The palette stays anchored on the left; its component list scrolls on shorter windows. A reserved gutter keeps the artboard clear of the palette. Chrome, selection indicators and the built-in example use a neutral charcoal/gray/white palette. Imported project colors and asset content remain as configured in their files.

Grid display starts hidden and can be enabled in View; snap keeps its existing setting. The current zoom percentage remains visible in the status bar. Multi-document tabs, rulers, panning tools and advanced transforms are future work.

## Grindstone industrial symbols (0.1.12)

In an IoT project, expand **Industrial · Grindstone** in the left palette or open the same group under **Insert**. Choose a pump, valve, motor, tank, conveyor, heat exchanger, blower, compressor, static mixer, instrument, or pipe fitting. Search matches both the visible name and generator ID. The symbols can be moved, resized, renamed, hidden, locked, or deleted. Save copy embeds the SVGs in the draft and repeated placements share an asset.

The symbols are static SVGs in the normal state. Canvas Lab v0.1.14 adds a skeuomorphic 2.5D finish with curved highlights, soft bevels, and muted colors over the original Grindstone geometry. Select a stock symbol from an earlier draft and use **Properties → Apply 2.5D finish** to update its appearance in place. Undo restores its original SVG.

The geometry comes from [upstream commit b690775](https://github.com/Grindstone-Systems/visual-toolkit/tree/b690775a09afcaaf6b61b4afed59d3aacf24196c). The exported catalog and upstream license are in `assets/grindstone/`. To regenerate it from that source archive, run `node --experimental-transform-types scripts/prepare-grindstone-symbols.js <extracted-source-directory>` from the repository root.

Version 0.1.13 adds **Straight Pipe**, a separate preset for Grindstone's straight spool with welded ends. Adjust **W** in Properties to change its length independently of **H**.

## Original IoT component designs (0.1.11)

Canvas Lab uses Phosphor Regular icons for the ten IoT widgets in the expanded and compact palettes (v0.1.15) and in Layers (v0.1.16). The Layers icons render 20% larger in v0.1.17. See `assets/icons/phosphor/` for the source and MIT license.

The native IoT renderer now follows the components in `src/platform/RuntimeCanvas.jsx` and the effective `mode-iot-dashboard` matte skin in `src/builder.css`: a circular analog gauge with ticks, three zones, needle and digital fallback; transparent indicator lamps; vertical beacon/buzzer alarms; centered numeric values; compact command buttons; a CHART launcher; operation-mode and control-pop-up launchers; and the original header/track/footer slider layout. Generic colored card wrappers and inline placeholder charts are removed. This is a native adaptation of the original design, not embedded React/CSS or pixel-identical rendering.

New widgets use the original shared registry's names, sizes and properties. The prepare script generates color defaults from that registry, matte variables from the production CSS, and gauge geometry/tick fixtures from `shared/gauge.js`. Imported geometry, bindings, responsive layout and unknown properties are retained without migration. The original IoT skin intentionally fixes some surfaces and gauge face/text colors; configured zone, needle, lamp, alarm, numeric, button and slider colors retain their role. Properties offers lamp shape and alarm presentation, and Colors uses the original property fields. Color edits still support Save copy and Undo/Redo. Chart series/mode colors are retained for runtime dialogs; those dialogs are not active in this editor. SCADA rendering is unchanged.

Missing readings show MISSING/UNBOUND and the configured fallback; command controls show OFFLINE. The slider draft starts at its configured minimum, separately from its missing live reading. No measurements, alarm activity, sound or commands are synthesized. Chart and control-pop-up buttons remain selectable design objects, matching the original Builder's passive editing behavior. The production runtime still handles live interactions.

Layers uses the Iconoir Eye and Eye Closed SVGs for visible/hidden objects in both editor contexts. The icons are bundled locally with the existing Iconoir license and pinned source references in assets/icons/iconoir/.

## IoT palette and widget previews (0.1.9)

The trial opens the IoT example by default. File → Open example offers IoT dashboard and SCADA schematic; changing examples with unsaved edits uses the existing Save copy / Keep editing / Discard dialog. JSON imports choose their palette from project.projectType. CLI --iot and --scada open the corresponding example. For native QA, --capture-iot output.png [object-id] captures IoT; --capture and --capture-markup keep their SCADA fixtures.

The IoT palette starts expanded and groups its ten widgets into Information (text, value, status and alarm), Visualization (gauge and history chart), and Controls (command button, setpoint slider, operation selector and control pop-up). Decoration contains the existing thirteen markup tools. Search matches names, types and categories; the chevron collapses the palette to a slim core-widget column. Insert uses the same categories. SCADA retains its existing component and markup toolbar.

New IoT widgets use registry desktop bounds, clamped when necessary to fit the current canvas. Imported positions, responsive layout metadata, bindings and properties remain intact. Gauge/setpoint ranges use tag engineering configuration when inherited. Charts expose numeric readable tag series, legend display and a 1–1440 minute runtime window; numeric values expose decimals and unit suffixes; gauges offer inherited/custom units and digital display; pop-ups expose their trigger label.

Widgets remain selectable, movable and resizable with the shared undo/save workflow. Commands are painted previews and do not execute RPC. Authentication, telemetry subscriptions, responsive breakpoint editing and production-runtime/deployment integration remain outside this prototype phase.

## Markup tools (0.1.7)

Use the double-chevron button at the top of the floating toolbar, or View → Expand markup tools, to open a second column. The first column keeps the original SCADA tools. The second offers thirteen tools: Line, Arrow, Rectangle, Rounded rectangle, Ellipse, Annotation text, Pencil/freehand, Curve, Double arrow, Triangle, Diamond, Polygon and Star. Hover each icon for its name; the same tools are available under Insert → Markup.

Choose a markup tool and drag on the artboard to draw. Text can also be placed with a click. Geometric drawing honors View → Snap to grid. Pencil captures freehand samples without grid snapping, including strokes that return to their starting point. Long strokes are resampled to stay within 4096 points; their points are stored relative to their bounds for later move/resize. Escape returns to Select and cancels an unfinished stroke. Select an object on the canvas or in Layers, then move or resize it with the existing corner handle. Hollow frames leave their interiors available for selecting equipment. Properties edits stroke color/width, fill, opacity, corner radius and annotation text/font size. Polygon has 3–12 sides; Star has 3–12 tips and an adjustable inner radius; Curve has an adjustable arch height. Scroll Properties for the To back, To front and Delete buttons. Delete also works from Edit or the Delete key when a markup object is selected and text input is inactive. Locked markup cannot be moved, resized, restyled or deleted. Creation, edits, ordering and deletion participate in Undo/Redo.

Markup is stored in the draft envelope as `markup: { format: "scamatic-markup/v1", objects: [...] }`, outside `schema.components`. Adding markup to a raw schema wraps that schema in a draft without changing its content. All thirteen object types survive Save copy and reopening, along with existing SVG/assets and unknown metadata. Line endpoints are normalized to their own bounds so reverse-direction arrows keep their direction when resized. There is a 2000-object markup limit and a 32 MiB saved-draft limit.

This release supports markup in the standalone prototype. Rendering these ornaments in the production runtime or hosted deployment still requires a format/rendering adapter. Pressure-sensitive brushes, editable Bézier handles, groups and advanced transforms are future work.


The two text tools use distinct Iconoir icons: Text Size (Tt) for SCADA labels and Text Box (framed text) for markup annotations, including their Layers thumbnails. The vendored SVGs use white strokes for egui tinting and embeds the upstream MIT notice; its pinned source and license are in `assets/icons/iconoir/`. Source: https://github.com/iconoir-icons/iconoir/blob/d73b7282ddd57caec341a6990c8456b911186e9b/icons/regular/text-box.svg

## Data contract

Raw schema and API-envelope input retain all original fields. Editing desktop geometry changes only `x`, `y`, `width` and `height`; rotation, tag definitions, command mappings, metadata, unknown fields, and tablet/mobile positions are retained. Embedded SVG and assets travel with draft envelopes.

Published runtime deployments are imported into a **draft**, not edited in place. Their original version, checksum, authentication and deployment envelope are intentionally not carried into an editable publication. The new file uses this wrapper:

```json
{
  "format": "scamatic-egui-draft/v1",
  "schema": { "schemaVersion": "1.8.0" },
  "assets": []
}
```

The `schema` shown above is abbreviated; real files contain the complete project. An optional `svg` string can override the preview background without changing the published asset reference. Imports are limited to 32 MiB, with canvas dimensions between 320 × 240 and 10000 × 10000.

## Phase-one limits

This is an offline layout study, not a second production Builder. It has no login/API synchronization, database writes, publishing, deployment export, telemetry evaluation, device commands, performance benchmark or parity guarantee. A saved draft is an evaluation artifact; importing it into the main Builder through a new UI has not been implemented.

The SCADA desktop canvas retains its simplified previews for lamps, process equipment, values, gauges and text, with placeholders for charts, alarms and controls. IoT projects use original-design passive native previews for all ten available widget types. They remain selectable/editable while retaining their full JSON settings. Rotation is retained but drawn unrotated; popup children and responsive layouts are retained but not edited. No live values or active command controls are shown. Embedded assets can render; remote asset fetching and full image import are not implemented. Font rendering, texture/shadow details and equipment drawing remain native approximations.

The Rust loader checks structure and geometry. Complete domain validation remains in the shared JavaScript validator and the main Builder. `verify-egui-builder.js` checks both SCADA and IoT round trips and transformed copies with that validator, including metadata, responsive layouts, source-file integrity and deployment-to-draft conversion.

The next decision is whether native canvas interaction is comfortable enough to justify an authenticated API draft-save adapter. Existing React runtime rendering and hosted deployment should stay shared regardless of that decision.
