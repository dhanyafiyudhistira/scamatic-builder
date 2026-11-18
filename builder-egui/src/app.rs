mod markup_tools;
mod workspace;

use crate::{
    document::{self, Document, ObjectRef, Position, number, text},
    markup::{self, Kind},
    paint,
};
use eframe::egui::{self, Color32, Pos2, Rect, RichText, Sense, Stroke, StrokeKind, Vec2};
use image::ImageEncoder;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};

struct Drag {
    object: ObjectRef,
    origin: Pos2,
    position: Position,
    resize: bool,
    before: Value,
}
enum Pending {
    Open(PathBuf),
    Example(bool),
    Close,
}

pub struct Builder {
    doc: Document,
    catalog: BTreeMap<String, document::Definition>,
    zoom: f32,
    fit: bool,
    snap: bool,
    grid: bool,
    palette_expanded: bool,
    palette_search: String,
    markup_tool: Option<Kind>,
    sketch: Option<markup_tools::SketchDrag>,
    drag: Option<Drag>,
    status: String,
    window_title: String,
    pending: Option<Pending>,
    allow_close: bool,
    svg: Option<egui::load::Bytes>,
    image_revision: u64,
    capture: Option<PathBuf>,
    frames: usize,
    capture_requested: bool,
    canvas_rect: Rect,
}

impl Builder {
    pub fn new(
        cc: &eframe::CreationContext<'_>,
        doc: Document,
        capture: Option<PathBuf>,
        expanded: bool,
    ) -> Self {
        egui_extras::install_image_loaders(&cc.egui_ctx);
        workspace::configure(&cc.egui_ctx);
        let mut app = Self::from_document(doc, capture);
        app.palette_expanded = expanded || app.doc.is_iot();
        app
    }

    fn from_document(doc: Document, capture: Option<PathBuf>) -> Self {
        let svg = doc.svg().map(Into::into);
        let palette_expanded = doc.is_iot();
        Self {
            doc,
            catalog: document::catalog(),
            zoom: 0.75,
            fit: true,
            snap: true,
            grid: false,
            palette_expanded,
            palette_search: String::new(),
            markup_tool: None,
            sketch: None,
            drag: None,
            status: "Ready · local design preview".into(),
            window_title: String::new(),
            pending: None,
            allow_close: false,
            svg,
            image_revision: 0,
            capture,
            frames: 0,
            capture_requested: false,
            canvas_rect: Rect::NOTHING,
        }
    }

    fn refresh_images(&mut self, ctx: &egui::Context) {
        ctx.forget_all_images();
        self.image_revision += 1;
        self.svg = self.doc.svg().map(Into::into);
    }

    fn open(&mut self, path: PathBuf, ctx: &egui::Context) {
        match Document::open(&path) {
            Ok(doc) => {
                self.install_document(doc, ctx);
                self.status = if self.doc.imported_publication {
                    "Published snapshot imported as an editable draft copy.".into()
                } else {
                    format!("Opened {}", path.display())
                };
            }
            Err(error) => self.status = error,
        }
    }

    fn install_document(&mut self, doc: Document, ctx: &egui::Context) {
        self.doc = doc;
        self.drag = None;
        self.sketch = None;
        self.markup_tool = None;
        self.palette_expanded = self.doc.is_iot();
        self.palette_search.clear();
        self.fit = true;
        self.refresh_images(ctx);
    }

    fn request_example(&mut self, iot: bool, ctx: &egui::Context) {
        if self.doc.dirty() {
            self.pending = Some(Pending::Example(iot));
        } else {
            self.load_example(iot, ctx);
        }
    }

    fn load_example(&mut self, iot: bool, ctx: &egui::Context) {
        self.install_document(
            if iot {
                Document::iot_demo()
            } else {
                Document::demo()
            },
            ctx,
        );
        self.status = if iot {
            "IoT dashboard example · local design preview"
        } else {
            "SCADA example · local design preview"
        }
        .into();
    }

    fn save(&mut self) {
        let source_name = self
            .doc
            .source
            .as_ref()
            .and_then(|p| p.file_stem())
            .and_then(|s| s.to_str())
            .unwrap_or("canvas");
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("JSON project", &["json"])
            .set_file_name(format!("{source_name}-egui-draft.json"))
            .save_file()
        {
            self.status = match self.doc.save_copy(&path) {
                Ok(()) => format!("Saved copy: {}", path.display()),
                Err(error) => error,
            };
        }
    }

    fn inspector(&mut self, ui: &mut egui::Ui) {
        let Some(object) = self.doc.selected_object() else {
            ui.heading("Project");
            ui.label(text(&self.doc.schema()["project"], "name", "Untitled"));
            let canvas = self.doc.canvas();
            ui.label(format!("{} × {} · desktop", canvas[0], canvas[1]));
            ui.add_space(18.0);
            ui.label("Select an object to edit its position, size, label and tag binding.");
            ui.add_space(16.0);
            ui.label(
                RichText::new("Local design preview.\nLive controls are inactive.")
                    .color(paint::MUTED),
            );
            return;
        };
        let mut component = self.doc.object(object).clone();
        let kind = text(&component, "type", "unknown").to_owned();
        let industrial = crate::industrial::for_component(&component);
        let mut apply_finish = false;
        ui.heading(if let Some(symbol) = industrial {
            symbol.label.as_str()
        } else if self.doc.is_iot() && matches!(object, ObjectRef::Component(_)) {
            workspace::iot_label(&kind)
        } else {
            self.catalog
                .get(&kind)
                .map(|d| d.label.as_str())
                .unwrap_or_else(|| {
                    Kind::from_value(&component)
                        .map(Kind::label)
                        .unwrap_or(&kind)
                })
        });
        ui.scope(|ui| {
            ui.label("Name");
            let mut name = text(&component, "name", "").to_owned();
            if ui.text_edit_singleline(&mut name).changed() {
                component["name"] = json!(name);
            }
            ui.horizontal(|ui| {
                let mut visible = component["visible"] != false;
                let mut locked = component["locked"] == true;
                if ui.checkbox(&mut visible, "Visible").changed() {
                    component["visible"] = json!(visible);
                }
                if ui.checkbox(&mut locked, "Locked").changed() {
                    component["locked"] = json!(locked);
                }
            });
            ui.separator();
            ui.label(
                RichText::new("DESKTOP GEOMETRY")
                    .size(10.0)
                    .color(paint::MUTED),
            );
            let locked = component["locked"] == true;
            ui.add_enabled_ui(!locked, |ui| {
                egui::Grid::new("geometry")
                    .num_columns(4)
                    .spacing([8.0, 5.0])
                    .show(ui, |ui| {
                        for (field, (key, label, minimum)) in [
                            ("x", "X", 0.0),
                            ("y", "Y", 0.0),
                            ("width", "W", 1.0),
                            ("height", "H", 1.0),
                        ]
                        .into_iter()
                        .enumerate()
                        {
                            ui.label(label);
                            let mut value = number(&component["position"], key, 0.0);
                            if ui
                                .add(
                                    egui::DragValue::new(&mut value)
                                        .speed(1.0)
                                        .range(minimum..=10000.0),
                                )
                                .changed()
                            {
                                component["position"][key] = json!(value);
                            }
                            if field % 2 == 1 {
                                ui.end_row();
                            }
                        }
                    });
            });
            if number(&component["position"], "rotation", 0.0) != 0.0 {
                ui.label(
                    RichText::new(
                        "Rotation is preserved in JSON; this preview uses an unrotated outline.",
                    )
                    .small()
                    .color(paint::MUTED),
                );
            }
            ui.separator();
            if matches!(object, ObjectRef::Markup(_)) {
                ui.add_enabled_ui(!locked, |ui| Self::markup_properties(ui, &mut component));
                return;
            }
            if let Some(symbol) = industrial {
                ui.label(
                    RichText::new("Grindstone Visual Toolkit · SVG symbol")
                        .small()
                        .color(paint::MUTED),
                );
                if symbol.uses_flat_asset(&component) {
                    apply_finish = ui
                        .add_enabled(!locked, egui::Button::new("Apply 2.5D finish"))
                        .clicked();
                }
                if ui
                    .add_enabled(!locked, egui::Button::new("Delete symbol"))
                    .clicked()
                {
                    self.doc.delete_selected();
                }
                return;
            }
            let key = if kind == "text-label" {
                "text"
            } else {
                "label"
            };
            if component["properties"][key].is_string() {
                ui.label(if key == "text" { "Text" } else { "Label" });
                let mut label = text(&component["properties"], key, "").to_owned();
                if ui
                    .add(
                        egui::TextEdit::multiline(&mut label)
                            .desired_rows(1)
                            .margin(egui::Margin::symmetric(6, 3)),
                    )
                    .changed()
                {
                    component["properties"][key] = json!(label);
                }
            }
            if kind == "text-label" {
                ui.label("Font size");
                let mut size = number(&component["properties"], "fontSize", 24.0);
                if ui
                    .add(egui::DragValue::new(&mut size).range(8.0..=160.0))
                    .changed()
                {
                    component["properties"]["fontSize"] = json!(size);
                }
            }
            if self.doc.is_iot() {
                ui.add_enabled_ui(!locked, |ui| Self::iot_colors(ui, &kind, &mut component));
            }
            if self.doc.is_iot() && kind == "chart" {
                ui.add_enabled_ui(!locked, |ui| {
                    Self::iot_chart_tags(ui, &mut component, self.doc.schema())
                });
            } else {
                ui.label("Tag binding");
                let current = component["binding"]["tagId"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                let mut selected = current.clone();
                let tags = self.doc.schema()["tags"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let name = tags
                    .iter()
                    .find(|tag| tag["id"] == current)
                    .map(|tag| text(tag, "name", &current))
                    .unwrap_or(if current.is_empty() {
                        "Unbound"
                    } else {
                        &current
                    });
                egui::ComboBox::from_id_salt("tag-binding")
                    .selected_text(name)
                    .width(195.0)
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut selected, String::new(), "Unbound");
                        for tag in &tags {
                            if self.doc.is_iot() {
                                let command = matches!(
                                    kind.as_str(),
                                    "control-button" | "tuning-slider" | "operation-shifter"
                                );
                                if (command
                                    && !matches!(
                                        tag["access"].as_str(),
                                        Some("write" | "read-write")
                                    ))
                                    || (!command && tag["access"] == "write")
                                {
                                    continue;
                                }
                            }
                            if self.catalog.get(&kind).is_some_and(|def| {
                                !def.allowed_data_types.is_empty()
                                    && !def
                                        .allowed_data_types
                                        .iter()
                                        .any(|data_type| tag["dataType"] == *data_type)
                            }) {
                                continue;
                            }
                            ui.selectable_value(
                                &mut selected,
                                text(tag, "id", "").to_owned(),
                                text(tag, "name", "Tag"),
                            );
                        }
                    });
                if selected != current {
                    component["binding"]["tagId"] = if selected.is_empty() {
                        Value::Null
                    } else {
                        json!(selected)
                    };
                }
            }
            if self.doc.is_iot() {
                ui.add_enabled_ui(!locked, |ui| {
                    Self::iot_properties(ui, &kind, &mut component)
                });
            }
        });
        if self.doc.selected_object() == Some(object) && component != *self.doc.object(object) {
            self.doc.replace_object(object, component);
        }
        if apply_finish {
            self.status = match self.doc.apply_industrial_finish(object) {
                Ok(()) => "Applied 2.5D finish".into(),
                Err(error) => error,
            };
        }
        if matches!(object, ObjectRef::Markup(_)) {
            self.markup_actions(ui);
        }
    }

    fn canvas(&mut self, ui: &mut egui::Ui) {
        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(workspace::BACKDROP).inner_margin(0))
            .show(ui, |ui| {
                ui.spacing_mut().item_spacing.y = 0.0;
                let workspace_rect = ui.available_rect_before_wrap();
                let gutter = self.palette_gutter();
                let size = self.doc.canvas();
                if self.fit {
                    self.zoom = ((ui.available_width() - gutter - 60.0) / size[0])
                        .min((ui.available_height() - 60.0) / size[1])
                        .clamp(0.25, 1.5);
                    self.fit = false;
                }
                egui::ScrollArea::both()
                    .id_salt("canvas-scroll")
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        let artboard_size = Vec2::new(size[0], size[1]) * self.zoom;
                        let available = ui.available_size();
                        let padding = Vec2::new(
                            ((available.x - gutter - artboard_size.x) * 0.5).max(24.0),
                            ((available.y - artboard_size.y) * 0.5).max(24.0),
                        );
                        let (surround, _) = ui.allocate_exact_size(
                            artboard_size + padding * 2.0 + Vec2::new(gutter, 0.0),
                            Sense::hover(),
                        );
                        let rect = Rect::from_min_size(
                            surround.min + padding + Vec2::new(gutter, 0.0),
                            artboard_size,
                        );
                        let response = ui.interact(
                            rect,
                            ui.scope_id().with("canvas-artboard"),
                            Sense::click_and_drag(),
                        );
                        self.canvas_rect = rect;
                        let background = paint::color(
                            text(
                                &self.doc.schema()["project"]["canvas"],
                                "background",
                                "#151719",
                            ),
                            Color32::from_rgb(21, 23, 25),
                        );
                        ui.painter().rect_filled(
                            rect.translate(Vec2::new(0.0, 3.0)).expand(2.0),
                            0,
                            Color32::from_black_alpha(65),
                        );
                        ui.painter().rect_filled(rect, 0, background);
                        if self.grid {
                            let spacing = 20.0 * self.zoom;
                            let grid = Color32::from_rgb(48, 50, 54);
                            let visible = rect.intersect(ui.clip_rect());
                            let start = (visible.min - rect.min) / spacing;
                            let end = (visible.max - rect.min) / spacing;
                            let grid_painter = ui.painter().with_clip_rect(visible);
                            for x in start.x.max(0.0).floor() as i32..=end.x.ceil() as i32 {
                                for y in start.y.max(0.0).floor() as i32..=end.y.ceil() as i32 {
                                    grid_painter.circle_filled(
                                        rect.min + Vec2::new(x as f32, y as f32) * spacing,
                                        0.6,
                                        grid,
                                    );
                                }
                            }
                        }
                        if let Some(svg) = &self.svg {
                            egui::Image::from_bytes(
                                format!("bytes://background-{}.svg", self.image_revision),
                                svg.clone(),
                            )
                            .fit_to_exact_size(rect.size())
                            .paint_at(ui, rect);
                        }
                        self.scene(ui, rect, &response, size);
                        ui.painter().rect_stroke(
                            rect,
                            0,
                            Stroke::new(1.0, Color32::from_rgb(60, 62, 66)),
                            StrokeKind::Inside,
                        );
                    });
                self.tool_rail(ui, workspace_rect);
            });
    }
}

impl eframe::App for Builder {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if self.capture.is_some() {
            ctx.send_viewport_cmd(egui::ViewportCommand::RequestPaintWhileHidden);
            ctx.request_repaint();
        }
        if ctx.input(|i| i.viewport().close_requested()) && self.doc.dirty() && !self.allow_close {
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
            self.pending = Some(Pending::Close);
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        if ctx.input(|i| i.key_pressed(egui::Key::Escape)) && !ctx.egui_wants_keyboard_input() {
            if let Some(drag) = self.drag.take() {
                self.doc.root = drag.before;
            }
            self.sketch = None;
            self.markup_tool = None;
            self.status = "Select / move objects".into();
        }
        if self.drag.is_none() && self.sketch.is_none() && !ctx.egui_wants_keyboard_input() {
            if ctx.input(|i| i.key_pressed(egui::Key::Delete)) {
                self.doc.delete_selected();
            }
            if ctx.input_mut(|i| i.consume_key(egui::Modifiers::CTRL, egui::Key::Z)) {
                self.doc.undo();
                self.refresh_images(&ctx);
            }
            if ctx.input_mut(|i| i.consume_key(egui::Modifiers::CTRL, egui::Key::Y)) {
                self.doc.redo();
                self.refresh_images(&ctx);
            }
        }
        self.toolbar(ui);
        self.status_bar(ui);
        self.sidebar(ui);
        self.canvas(ui);
        if self.pending.is_some() {
            egui::Modal::new(egui::Id::unique("unsaved")).show(&ctx, |ui| {
                ui.heading("Unsaved changes");
                ui.label("Save a copy before continuing, or discard the current edits.");
                ui.horizontal(|ui| {
                    if ui.button("Keep editing").clicked() {
                        self.pending = None;
                    }
                    if ui.button("Save copy").clicked() {
                        self.save();
                        if !self.doc.dirty() {
                            self.finish_pending(&ctx);
                        }
                    }
                    if ui.button("Discard edits").clicked() {
                        self.finish_pending(&ctx);
                    }
                });
            });
        }
        let title = format!(
            "{}{} — SCAMATIC Canvas Lab {}",
            text(&self.doc.schema()["project"], "name", "Untitled"),
            if self.doc.dirty() { " *" } else { "" },
            env!("CARGO_PKG_VERSION")
        );
        if title != self.window_title {
            ctx.send_viewport_cmd(egui::ViewportCommand::Title(title.clone()));
            self.window_title = title;
        }
        self.frames += 1;
        if self.capture.is_some() && self.frames >= 12 && !self.capture_requested {
            let path = self.capture.clone().unwrap();
            let callback_ctx = ctx.clone();
            self.allow_close = true;
            ctx.request_screenshot(move |image| {
                let rgba: Vec<u8> = image.pixels.iter().flat_map(|p| p.to_array()).collect();
                // UI previews contain large flat areas; avoid costly adaptive PNG filtering.
                let saved = (|| -> Result<(), Box<dyn std::error::Error>> {
                    let output = std::io::BufWriter::new(std::fs::File::create(&path)?);
                    image::codecs::png::PngEncoder::new_with_quality(
                        output,
                        image::codecs::png::CompressionType::Level(1),
                        image::codecs::png::FilterType::NoFilter,
                    )
                    .write_image(
                        &rgba,
                        image.width() as u32,
                        image.height() as u32,
                        image::ExtendedColorType::Rgba8,
                    )?;
                    Ok(())
                })();
                if let Err(error) = saved {
                    eprintln!("Screenshot failed: {error}");
                    std::process::exit(1);
                }
                callback_ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            });
            self.capture_requested = true;
        }
    }
}

impl Builder {
    fn finish_pending(&mut self, ctx: &egui::Context) {
        match self.pending.take() {
            Some(Pending::Open(path)) => self.open(path, ctx),
            Some(Pending::Example(iot)) => self.load_example(iot, ctx),
            Some(Pending::Close) => {
                self.allow_close = true;
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
            None => (),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(app: &mut Builder, ctx: &egui::Context, events: Vec<egui::Event>) {
        let input = egui::RawInput {
            screen_rect: Some(Rect::from_min_size(Pos2::ZERO, Vec2::new(1600.0, 1100.0))),
            events,
            ..Default::default()
        };
        let mut output = ctx.run_ui(input, |ui| app.canvas(ui));
        output.textures_delta.clear();
    }

    fn setup() -> (Builder, egui::Context) {
        let mut app = Builder::from_document(Document::demo(), None);
        app.fit = false;
        app.zoom = 1.0;
        app.snap = false;
        app.svg = None;
        let ctx = egui::Context::default();
        egui_extras::install_image_loaders(&ctx);
        frame(&mut app, &ctx, vec![]);
        frame(&mut app, &ctx, vec![]);
        (app, ctx)
    }

    fn drag(app: &mut Builder, ctx: &egui::Context, from: Pos2, to: Pos2) {
        frame(app, ctx, vec![egui::Event::PointerMoved(from)]);
        frame(
            app,
            ctx,
            vec![egui::Event::PointerButton {
                pos: from,
                button: egui::PointerButton::Primary,
                pressed: true,
                modifiers: Default::default(),
            }],
        );
        frame(app, ctx, vec![egui::Event::PointerMoved(to)]);
        frame(
            app,
            ctx,
            vec![egui::Event::PointerButton {
                pos: to,
                button: egui::PointerButton::Primary,
                pressed: false,
                modifiers: Default::default(),
            }],
        );
    }

    #[test]
    fn iot_palette_covers_the_catalog_and_presets_keep_schema_metadata() {
        let mut app = Builder::from_document(Document::iot_demo(), None);
        let kinds: Vec<_> = workspace::IOT_GROUPS
            .iter()
            .flat_map(|(_, kinds)| kinds.iter().copied())
            .collect();
        let unique: std::collections::HashSet<_> = kinds.iter().copied().collect();
        assert_eq!(unique.len(), 10);
        assert_eq!(kinds.len(), unique.len());
        for (kind, definition) in &app.catalog {
            if definition.library != Some(false)
                && definition
                    .project_types
                    .as_ref()
                    .is_none_or(|types| types.iter().any(|v| v == "iot-dashboard"))
            {
                assert!(unique.contains(kind.as_str()));
            }
        }
        let original = app.doc.root.clone();
        for kind in kinds {
            app.add_component(kind);
            let value = app.doc.components().last().unwrap();
            assert_eq!(value["type"], kind);
            let p = Position::read(value);
            assert!(p.width <= app.doc.canvas()[0] && p.height <= app.doc.canvas()[1]);
            let definition = &app.catalog[kind];
            assert_eq!(
                [p.width, p.height],
                [
                    definition.default_size.width,
                    definition.default_size.height
                ]
            );
            assert_eq!(value["properties"], definition.default_properties);
            assert_eq!(workspace::iot_label(kind), definition.label);
            assert_eq!(
                app.doc.schema()["project"]["dashboardLayout"],
                original["schema"]["project"]["dashboardLayout"]
            );
            assert_eq!(app.doc.schema()["tags"], original["schema"]["tags"]);
            app.doc.undo();
            assert_eq!(app.doc.root, original);
        }
        app.add_component("pump");
        assert_eq!(app.doc.root, original);
        assert!(!app.component_available("pump"));
        assert!(!app.component_available("design-image"));
    }

    #[test]
    fn switching_examples_preserves_dirty_work_until_discard_is_chosen() {
        let (mut app, ctx) = setup();
        app.doc
            .edit(|schema| schema["components"][0]["name"] = json!("Unsaved heading"));
        let dirty = app.doc.root.clone();
        app.request_example(true, &ctx);
        assert!(matches!(app.pending, Some(Pending::Example(true))));
        assert_eq!(app.doc.root, dirty);
        app.pending = None;
        assert_eq!(app.doc.root, dirty);
        app.request_example(true, &ctx);
        app.finish_pending(&ctx);
        assert!(app.doc.is_iot());
        assert!(!app.doc.dirty());
        assert!(app.palette_expanded);
        app.palette_search = "chart".into();
        app.request_example(false, &ctx);
        assert!(!app.doc.is_iot());
        assert!(!app.palette_expanded);
        assert!(app.palette_search.is_empty());
        assert_eq!(app.doc.root, Document::demo().root);
    }

    fn iot_frame(app: &mut Builder, ctx: &egui::Context) -> egui::FullOutput {
        let mut output = ctx.run_ui(
            egui::RawInput {
                screen_rect: Some(Rect::from_min_size(Pos2::ZERO, Vec2::new(1600.0, 1100.0))),
                ..Default::default()
            },
            |ui| app.canvas(ui),
        );
        output.textures_delta.clear();
        output
    }

    fn text_position(shapes: &[egui::epaint::ClippedShape], label: &str) -> Option<Pos2> {
        fn find(shape: &egui::Shape, label: &str) -> Option<Pos2> {
            match shape {
                egui::Shape::Text(text) if text.galley.text() == label => {
                    Some(text.pos + text.galley.size() / 2.0)
                }
                egui::Shape::Vec(shapes) => shapes.iter().find_map(|s| find(s, label)),
                _ => None,
            }
        }
        shapes.iter().find_map(|shape| find(&shape.shape, label))
    }

    #[test]
    fn iot_search_and_widget_click_add_a_chart_that_undo_can_remove() {
        let mut app = Builder::from_document(Document::iot_demo(), None);
        app.fit = false;
        app.zoom = 1.0;
        app.snap = false;
        let ctx = egui::Context::default();
        egui_extras::install_image_loaders(&ctx);
        iot_frame(&mut app, &ctx);
        iot_frame(&mut app, &ctx);
        let original = app.doc.root.clone();
        app.palette_search = "chart".into();
        iot_frame(&mut app, &ctx);
        let output = iot_frame(&mut app, &ctx);
        assert!(text_position(&output.shapes, "Value Span").is_none());
        let button = text_position(&output.shapes, "Chart").expect("filtered chart button");
        drag(&mut app, &ctx, button, button);
        assert_eq!(
            app.doc.components().len(),
            Document::iot_demo().components().len() + 1
        );
        assert_eq!(app.doc.components().last().unwrap()["type"], "chart");
        app.doc.undo();
        assert_eq!(app.doc.root, original);
    }

    #[test]
    fn iot_palette_places_straight_pipe_separately_from_pipe_fitting() {
        let mut app = Builder::from_document(Document::iot_demo(), None);
        app.fit = false;
        app.zoom = 1.0;
        let ctx = egui::Context::default();
        egui_extras::install_image_loaders(&ctx);
        ctx.all_styles_mut(|style| style.animation_time = 0.0);
        iot_frame(&mut app, &ctx);
        iot_frame(&mut app, &ctx);
        let original = app.doc.root.clone();
        app.palette_search = "pipe".into();
        iot_frame(&mut app, &ctx);
        let output = iot_frame(&mut app, &ctx);
        assert!(text_position(&output.shapes, "Pipe fitting").is_some());
        let button =
            text_position(&output.shapes, "Straight Pipe").expect("Straight Pipe in search");
        drag(&mut app, &ctx, button, button);

        let selected = app
            .doc
            .object(app.doc.selected_object().expect(&app.status));
        assert_eq!(selected["type"], "design-image");
        assert_eq!(selected["metadata"]["grindstoneGenerator"], "pipe.straight");
        assert_eq!(selected["properties"]["objectFit"], "fill");
        assert_eq!(selected["properties"]["lockAspectRatio"], false);
        assert!(
            app.doc
                .asset(selected["properties"]["assetId"].as_str().unwrap())
                .is_some()
        );
        assert!(app.doc.can_delete_selected());
        app.doc.undo();
        assert_eq!(app.doc.root, original);
    }

    #[test]
    fn iot_canvas_preview_is_passive_and_preserves_layout_when_moving_a_card() {
        let mut app = Builder::from_document(Document::iot_demo(), None);
        app.fit = false;
        app.zoom = 1.0;
        app.snap = false;
        let ctx = egui::Context::default();
        egui_extras::install_image_loaders(&ctx);
        let original = app.doc.root.clone();
        iot_frame(&mut app, &ctx);
        let output = iot_frame(&mut app, &ctx);
        assert_eq!(app.doc.root, original);
        assert!(!app.doc.dirty());
        assert!(text_position(&output.shapes, "CHART").is_some());
        assert!(text_position(&output.shapes, "MISSING").is_some());
        let from = app.canvas_rect.min + Vec2::new(80.0, 180.0);
        drag(&mut app, &ctx, from, from + Vec2::new(40.0, 20.0));
        assert_eq!(app.doc.selected.as_deref(), Some("iot-temperature"));
        let p = Position::read(app.doc.object(app.doc.selected_object().unwrap()));
        assert_eq!([p.x, p.y], [72.0, 148.0]);
        assert_eq!(
            app.doc.schema()["project"]["dashboardLayout"],
            original["schema"]["project"]["dashboardLayout"]
        );
        app.doc.undo();
        assert_eq!(app.doc.root, original);
    }

    #[test]
    fn pencil_records_a_closed_stroke_even_when_grid_snap_is_enabled() {
        let (mut app, ctx) = setup();
        let original = app.doc.root.clone();
        app.snap = true;
        app.choose_markup(Kind::Pencil);
        let origin = app.canvas_rect.min;
        let from = origin + Vec2::new(400.5, 180.5);
        frame(&mut app, &ctx, vec![egui::Event::PointerMoved(from)]);
        frame(
            &mut app,
            &ctx,
            vec![egui::Event::PointerButton {
                pos: from,
                button: egui::PointerButton::Primary,
                pressed: true,
                modifiers: Default::default(),
            }],
        );
        for delta in [
            Vec2::new(120.0, 0.0),
            Vec2::new(120.0, 80.0),
            Vec2::new(0.0, 80.0),
            Vec2::ZERO,
        ] {
            frame(
                &mut app,
                &ctx,
                vec![egui::Event::PointerMoved(from + delta)],
            );
        }
        frame(
            &mut app,
            &ctx,
            vec![egui::Event::PointerButton {
                pos: from,
                button: egui::PointerButton::Primary,
                pressed: false,
                modifiers: Default::default(),
            }],
        );
        assert_eq!(app.doc.markups().len(), 1);
        let value = &app.doc.markups()[0];
        assert_eq!(value["properties"]["points"].as_array().unwrap().len(), 5);
        assert_eq!(Position::read(value).x, 400.5);
        assert_eq!(Position::read(value).height, 80.0);
        assert!(app.doc.structural_issues().is_empty());
        let drawn = app.doc.root.clone();
        app.doc.undo();
        assert_eq!(app.doc.root, original);
        app.doc.redo();
        assert_eq!(app.doc.root, drawn);
    }

    #[test]
    fn additional_geometric_tools_draw_valid_editable_objects() {
        for kind in [
            Kind::Curve,
            Kind::DoubleArrow,
            Kind::Triangle,
            Kind::Diamond,
            Kind::Polygon,
            Kind::Star,
        ] {
            let (mut app, ctx) = setup();
            app.choose_markup(kind);
            let start = app.canvas_rect.min + Vec2::new(400.0, 180.0);
            drag(&mut app, &ctx, start, start + Vec2::new(220.0, 160.0));
            assert_eq!(app.doc.markups()[0]["type"], kind.id());
            assert!(app.doc.structural_issues().is_empty());
        }
    }

    #[test]
    fn toolbar_button_expands_and_collapses_the_markup_column() {
        let (mut app, ctx) = setup();
        let palette = || {
            egui::AreaState::load(&ctx, egui::Id::unique("floating-component-palette"))
                .unwrap()
                .rect()
        };
        let initial_width = palette().width();
        let button = palette().min + Vec2::splat(20.0);
        drag(&mut app, &ctx, button, button);
        frame(&mut app, &ctx, vec![]);
        frame(&mut app, &ctx, vec![]);
        assert!(app.palette_expanded);
        assert!(palette().width() > initial_width);
        app.choose_markup(Kind::Ellipse);
        let button = palette().min + Vec2::splat(20.0);
        drag(&mut app, &ctx, button, button);
        frame(&mut app, &ctx, vec![]);
        frame(&mut app, &ctx, vec![]);
        assert!(!app.palette_expanded);
        assert!(app.markup_tool.is_none());
        assert_eq!(palette().width(), initial_width);
        assert!(app.doc.markups().is_empty());
    }

    #[test]
    fn markup_pointer_drawing_move_resize_and_undo_preserve_scada_schema() {
        let (mut app, ctx) = setup();
        let original = app.doc.root.clone();
        let schema = app.doc.schema().clone();
        app.choose_markup(Kind::Rectangle);
        let start = app.canvas_rect.min + Vec2::new(400.0, 180.0);
        drag(&mut app, &ctx, start, start + Vec2::new(220.0, 160.0));
        assert_eq!(app.doc.markups().len(), 1);
        assert_eq!(app.doc.schema(), &schema);
        let object = app.doc.selected_object().unwrap();
        assert_eq!(
            Position::read(app.doc.object(object)),
            Position {
                x: 400.0,
                y: 180.0,
                width: 220.0,
                height: 160.0
            }
        );
        let drawn = app.doc.root.clone();
        app.doc.undo();
        assert_eq!(app.doc.root, original);
        app.doc.redo();
        assert_eq!(app.doc.root, drawn);
        app.markup_tool = None;
        let edge = app.canvas_rect.min + Vec2::new(400.0, 220.0);
        drag(&mut app, &ctx, edge, edge + Vec2::new(30.0, 20.0));
        let moved = Position::read(app.doc.object(object));
        assert_eq!([moved.x, moved.y], [430.0, 200.0]);
        let corner = app.canvas_rect.min + Vec2::new(moved.x + moved.width, moved.y + moved.height);
        drag(&mut app, &ctx, corner, corner + Vec2::new(40.0, 30.0));
        let resized = Position::read(app.doc.object(object));
        assert_eq!([resized.width, resized.height], [260.0, 190.0]);
        assert_eq!(app.doc.schema(), &schema);
        app.doc.undo();
        assert_eq!(Position::read(app.doc.object(object)), moved);
    }

    #[test]
    fn collapsed_palette_cancels_markup_mode_and_locked_markup_cannot_move() {
        let (mut app, ctx) = setup();
        app.set_palette_expanded(true);
        app.choose_markup(Kind::Arrow);
        app.set_palette_expanded(false);
        assert!(app.markup_tool.is_none());
        assert_eq!(app.palette_gutter(), workspace::PALETTE_GUTTER);
        app.doc
            .add_markup(Kind::Line, [400.0, 180.0], [620.0, 180.0])
            .unwrap();
        app.doc.root["markup"]["objects"][0]["locked"] = json!(true);
        let before = app.doc.root.clone();
        let start = app.canvas_rect.min + Vec2::new(450.0, 180.0);
        drag(&mut app, &ctx, start, start + Vec2::new(20.0, 40.0));
        assert_eq!(app.doc.root, before);
        app.doc.delete_selected();
        assert_eq!(app.doc.root, before);
    }

    #[test]
    fn canvas_pointer_moves_object_and_undo_restores_the_document() {
        let (mut app, ctx) = setup();
        let original = app.doc.root.clone();
        let from = app.canvas_rect.min + Vec2::new(270.0, 300.0);
        drag(&mut app, &ctx, from, from + Vec2::new(40.0, 20.0));
        assert_eq!(app.doc.selected.as_deref(), Some("pump"));
        let index = app.doc.selected_index().unwrap();
        assert_eq!(Position::read(&app.doc.components()[index]).x, 210.0);
        assert_eq!(Position::read(&app.doc.components()[index]).y, 250.0);
        assert!(app.doc.can_undo());
        app.doc.undo();
        assert_eq!(app.doc.root, original);
    }

    #[test]
    fn canvas_corner_handle_resizes_without_moving_the_object() {
        let (mut app, ctx) = setup();
        app.doc.selected = Some("pump".into());
        let from = app.canvas_rect.min + Vec2::new(370.0, 375.0);
        drag(&mut app, &ctx, from, from + Vec2::new(50.0, 30.0));
        let p = Position::read(&app.doc.components()[app.doc.selected_index().unwrap()]);
        assert_eq!(
            p,
            Position {
                x: 170.0,
                y: 230.0,
                width: 250.0,
                height: 175.0
            }
        );
    }

    #[test]
    fn locked_layers_cannot_be_dragged() {
        let (mut app, ctx) = setup();
        app.doc.schema_mut()["components"][1]["locked"] = json!(true);
        let before = app.doc.root.clone();
        let from = app.canvas_rect.min + Vec2::new(270.0, 300.0);
        drag(&mut app, &ctx, from, from + Vec2::new(40.0, 20.0));
        assert_eq!(app.doc.selected.as_deref(), Some("pump"));
        assert_eq!(app.doc.root, before);
        assert!(!app.doc.can_undo());
    }
}
