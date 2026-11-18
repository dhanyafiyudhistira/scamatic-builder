use super::Builder;
mod iot;
use crate::{
    document::{self, text},
    industrial, paint,
};
use eframe::egui::{
    self, Align, Align2, Color32, FontId, Layout, Margin, Rect, Response, RichText, Sense, Stroke,
    StrokeKind, Vec2,
};

pub(super) const BACKDROP: Color32 = Color32::from_rgb(29, 30, 33);
pub(super) const PALETTE_GUTTER: f32 = 64.0;
const PANEL: Color32 = Color32::from_rgb(40, 42, 46);
const BAR: Color32 = Color32::from_rgb(45, 47, 51);
const EDGE: Color32 = Color32::from_rgb(61, 64, 69);
const TEXT: Color32 = Color32::from_rgb(222, 225, 230);
const MUTED: Color32 = Color32::from_rgb(157, 163, 172);

const TOOLS: &[&str] = &[
    "text-label",
    "indicator-lamp",
    "value-span",
    "gauge",
    "chart",
    "alarm",
    "pump",
    "valve",
    "motor",
    "fan",
    "pipe",
    "control-button",
    "tuning-slider",
    "operation-shifter",
    "control-popup",
];

pub(super) const IOT_GROUPS: &[(&str, &[&str])] = &[
    (
        "Information",
        &["text-label", "value-span", "indicator-lamp", "alarm"],
    ),
    ("Visualization", &["gauge", "chart"]),
    (
        "Controls",
        &[
            "control-button",
            "tuning-slider",
            "operation-shifter",
            "control-popup",
        ],
    ),
];

pub(super) fn iot_label(kind: &str) -> &str {
    match kind {
        "text-label" => "Text",
        "value-span" => "Value Span",
        "indicator-lamp" => "Indicator Lamp",
        "alarm" => "Alarm",
        "gauge" => "Gauge",
        "chart" => "Chart",
        "control-button" => "Control Button",
        "tuning-slider" => "Tuning Slider",
        "operation-shifter" => "Operation Shifter",
        "control-popup" => "Control Pop-up",
        _ => kind,
    }
}

pub(super) fn configure(ctx: &egui::Context) {
    ctx.set_visuals(egui::Visuals::dark());
    ctx.style_mut_of(egui::Theme::Dark, |style| {
        style.spacing.item_spacing = Vec2::new(7.0, 7.0);
        style.spacing.button_padding = Vec2::new(8.0, 4.0);
        style.spacing.interact_size.y = 25.0;
        style.spacing.slider_width = 100.0;
        style
            .text_styles
            .insert(egui::TextStyle::Body, FontId::proportional(12.0));
        style
            .text_styles
            .insert(egui::TextStyle::Button, FontId::proportional(12.0));
        style
            .text_styles
            .insert(egui::TextStyle::Small, FontId::proportional(10.5));
        style
            .text_styles
            .insert(egui::TextStyle::Heading, FontId::proportional(16.0));
        let visuals = &mut style.visuals;
        visuals.override_text_color = Some(TEXT);
        visuals.panel_fill = PANEL;
        visuals.window_fill = PANEL;
        visuals.extreme_bg_color = Color32::from_rgb(30, 32, 35);
        visuals.faint_bg_color = BAR;
        visuals.selection.bg_fill = Color32::from_rgb(68, 70, 74);
        visuals.selection.stroke = Stroke::new(1.0, paint::ACCENT);
        visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, EDGE);
        visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, MUTED);
        visuals.widgets.inactive.bg_fill = Color32::from_rgb(32, 34, 38);
        visuals.widgets.inactive.weak_bg_fill = Color32::from_rgb(51, 54, 59);
        visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, Color32::from_rgb(71, 75, 81));
        visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, TEXT);
        visuals.widgets.hovered.bg_fill = Color32::from_rgb(62, 66, 72);
        visuals.widgets.hovered.weak_bg_fill = Color32::from_rgb(62, 66, 72);
        visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, Color32::from_rgb(99, 108, 118));
        visuals.widgets.active.bg_fill = Color32::from_rgb(66, 68, 73);
        visuals.widgets.active.weak_bg_fill = Color32::from_rgb(66, 68, 73);
        visuals.widgets.active.bg_stroke = Stroke::new(1.0, paint::ACCENT);
        for widget in [
            &mut visuals.widgets.inactive,
            &mut visuals.widgets.hovered,
            &mut visuals.widgets.active,
            &mut visuals.widgets.open,
        ] {
            widget.corner_radius = 2.into();
            widget.expansion = 0.0;
        }
    });
}

fn frame(fill: Color32, horizontal: i8, vertical: i8) -> egui::Frame {
    egui::Frame::new().fill(fill).inner_margin(Margin {
        left: horizontal,
        right: horizontal,
        top: vertical,
        bottom: vertical,
    })
}

fn section(ui: &mut egui::Ui, name: &str, detail: &str) {
    let result = frame(BAR, 12, 7).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new(name).size(12.0).strong());
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.label(RichText::new(detail).size(10.0).color(MUTED));
            });
        });
    });
    ui.painter().hline(
        result.response.rect.x_range(),
        result.response.rect.bottom(),
        Stroke::new(1.0, EDGE),
    );
}

fn icon_button(ui: &mut egui::Ui, kind: &str, label: &str, selected: bool) -> Response {
    icon_button_with(ui, kind, label, selected, icon)
}

fn icon_button_with(
    ui: &mut egui::Ui,
    kind: &str,
    label: &str,
    selected: bool,
    draw_icon: fn(&egui::Ui, Rect, &str, Color32),
) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(26.0), Sense::click());
    if selected || response.hovered() {
        ui.painter().rect_filled(
            rect.shrink(1.0),
            5,
            if selected {
                Color32::from_rgb(66, 68, 73)
            } else {
                Color32::from_rgb(59, 62, 68)
            },
        );
    }
    if selected {
        ui.painter().rect_stroke(
            rect.shrink(1.0),
            5,
            Stroke::new(1.0, paint::ACCENT.gamma_multiply(0.6)),
            StrokeKind::Inside,
        );
    }
    draw_icon(
        ui,
        rect.shrink(5.0),
        kind,
        if selected {
            paint::ACCENT
        } else if response.hovered() {
            TEXT
        } else {
            MUTED
        },
    );
    response.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, ui.is_enabled(), label));
    response
        .on_hover_cursor(egui::CursorIcon::PointingHand)
        .on_hover_text(label)
}

// Small vector icons keep the desktop chrome crisp at different display scales.
fn icon(ui: &egui::Ui, rect: Rect, kind: &str, color: Color32) {
    if let Some(symbol) = industrial::find(kind) {
        symbol.paint_icon(ui, rect.expand(2.0));
        return;
    }
    let svg_icon: Option<(&str, &[u8])> = match kind {
        "text-label" => Some((
            "bytes://iconoir/text-size.svg",
            include_bytes!("../../assets/icons/iconoir/text-size.svg"),
        )),
        "markup-text" => Some((
            "bytes://iconoir/text-box.svg",
            include_bytes!("../../assets/icons/iconoir/text-box.svg"),
        )),
        "eye" => Some((
            "bytes://iconoir/eye.svg",
            include_bytes!("../../assets/icons/iconoir/eye.svg"),
        )),
        "hidden" => Some((
            "bytes://iconoir/eye-closed.svg",
            include_bytes!("../../assets/icons/iconoir/eye-closed.svg"),
        )),
        _ => None,
    };
    if let Some((uri, bytes)) = svg_icon {
        egui::Image::from_bytes(uri, bytes)
            .tint(color)
            .paint_at(ui, rect);
        return;
    }
    let p = ui.painter();
    let point = |x: f32, y: f32| rect.min + Vec2::new(rect.width() * x, rect.height() * y);
    let line = |a: [f32; 2], b: [f32; 2]| {
        p.line_segment(
            [point(a[0], a[1]), point(b[0], b[1])],
            Stroke::new(1.2, color),
        );
    };
    let outline = |min: [f32; 2], max: [f32; 2]| {
        p.rect_stroke(
            Rect::from_min_max(point(min[0], min[1]), point(max[0], max[1])),
            1,
            Stroke::new(1.2, color),
            StrokeKind::Inside,
        );
    };
    match kind {
        "expand" | "collapse" => {
            let (a, b) = if kind == "expand" {
                (0.25, 0.55)
            } else {
                (0.75, 0.45)
            };
            for offset in [0.0, if kind == "expand" { 0.3 } else { -0.3 }] {
                line([a + offset, 0.2], [b + offset, 0.5]);
                line([b + offset, 0.5], [a + offset, 0.8]);
            }
        }
        "markup-line" | "markup-arrow" | "markup-double-arrow" => {
            line([0.1, 0.85], [0.85, 0.15]);
            if kind != "markup-line" {
                line([0.85, 0.15], [0.45, 0.18]);
                line([0.85, 0.15], [0.82, 0.55]);
            }
            if kind == "markup-double-arrow" {
                line([0.1, 0.85], [0.13, 0.45]);
                line([0.1, 0.85], [0.50, 0.82]);
            }
        }
        "markup-rectangle" | "markup-rounded" => {
            p.rect_stroke(
                rect.shrink(1.0),
                if kind == "markup-rounded" { 4 } else { 0 },
                Stroke::new(1.2, color),
                StrokeKind::Inside,
            );
        }
        "markup-ellipse" => {
            p.add(egui::Shape::ellipse_stroke(
                rect.center(),
                rect.size() * 0.45,
                Stroke::new(1.2, color),
            ));
        }
        "markup-pencil" => {
            p.add(egui::Shape::closed_line(
                vec![
                    point(0.1, 0.9),
                    point(0.17, 0.62),
                    point(0.73, 0.08),
                    point(0.92, 0.27),
                    point(0.38, 0.83),
                ],
                Stroke::new(1.2, color),
            ));
            line([0.17, 0.62], [0.38, 0.83]);
            line([0.65, 0.16], [0.84, 0.35]);
        }
        "markup-curve" => {
            let points = (0..=20)
                .map(|i| {
                    let t = i as f32 / 20.0;
                    point(0.08 + t * 0.84, 0.85 - 2.8 * t * (1.0 - t))
                })
                .collect();
            p.add(egui::Shape::line(points, Stroke::new(1.2, color)));
        }
        "markup-triangle" | "markup-diamond" | "markup-polygon" | "markup-star" => {
            let sides = match kind {
                "markup-triangle" => 3,
                "markup-diamond" => 4,
                "markup-polygon" => 6,
                _ => 10,
            };
            let points = (0..sides)
                .map(|i| {
                    let angle = std::f32::consts::TAU * i as f32 / sides as f32
                        - std::f32::consts::FRAC_PI_2;
                    let radius = if kind == "markup-star" && i % 2 == 1 {
                        0.2
                    } else {
                        0.46
                    };
                    point(0.5 + angle.cos() * radius, 0.5 + angle.sin() * radius)
                })
                .collect();
            p.add(egui::Shape::closed_line(points, Stroke::new(1.2, color)));
        }
        "select" => {
            p.add(egui::Shape::closed_line(
                vec![
                    point(0.15, 0.05),
                    point(0.80, 0.60),
                    point(0.51, 0.64),
                    point(0.37, 0.95),
                    point(0.15, 0.05),
                ],
                Stroke::new(1.2, color),
            ));
        }
        "indicator-lamp" => {
            p.circle_stroke(rect.center(), rect.width() * 0.34, Stroke::new(1.3, color));
            p.circle_filled(rect.center(), rect.width() * 0.12, color);
        }
        "valve" => {
            p.add(egui::Shape::closed_line(
                vec![
                    point(0.05, 0.25),
                    point(0.95, 0.8),
                    point(0.95, 0.25),
                    point(0.05, 0.8),
                ],
                Stroke::new(1.2, color),
            ));
            line([0.5, 0.5], [0.5, 0.05]);
            line([0.3, 0.05], [0.7, 0.05]);
        }
        "pump" | "motor" | "fan" => {
            p.circle_stroke(rect.center(), rect.width() * 0.37, Stroke::new(1.2, color));
            if kind == "pump" {
                p.add(egui::Shape::closed_line(
                    vec![point(0.35, 0.25), point(0.73, 0.5), point(0.35, 0.75)],
                    Stroke::new(1.2, color),
                ));
            } else {
                p.text(
                    rect.center(),
                    Align2::CENTER_CENTER,
                    if kind == "motor" { "M" } else { "F" },
                    FontId::proportional(10.0),
                    color,
                );
            }
        }
        "pipe" => {
            line([0.05, 0.4], [0.95, 0.4]);
            line([0.05, 0.65], [0.95, 0.65]);
            line([0.15, 0.2], [0.15, 0.85]);
            line([0.85, 0.2], [0.85, 0.85]);
        }
        "alarm" => {
            p.add(egui::Shape::closed_line(
                vec![point(0.5, 0.05), point(0.95, 0.9), point(0.05, 0.9)],
                Stroke::new(1.2, color),
            ));
            line([0.5, 0.32], [0.5, 0.57]);
            p.circle_filled(point(0.5, 0.73), 0.8, color);
        }
        "value-span" => {
            p.text(
                rect.center(),
                Align2::CENTER_CENTER,
                "123",
                FontId::monospace(9.0),
                color,
            );
        }
        "gauge" => {
            let points = (0..=20)
                .map(|i| {
                    let a = std::f32::consts::PI * (1.0 + i as f32 / 20.0);
                    point(0.5 + a.cos() * 0.43, 0.72 + a.sin() * 0.5)
                })
                .collect();
            p.add(egui::Shape::line(points, Stroke::new(1.2, color)));
            line([0.5, 0.72], [0.73, 0.30]);
        }
        "chart" => {
            line([0.1, 0.05], [0.1, 0.9]);
            line([0.1, 0.9], [0.95, 0.9]);
            p.add(egui::Shape::line(
                vec![
                    point(0.2, 0.7),
                    point(0.4, 0.4),
                    point(0.6, 0.6),
                    point(0.9, 0.15),
                ],
                Stroke::new(1.2, color),
            ));
        }
        "tuning-slider" => {
            line([0.05, 0.5], [0.95, 0.5]);
            outline([0.35, 0.2], [0.6, 0.8]);
        }
        "operation-shifter" => {
            outline([0.05, 0.2], [0.95, 0.8]);
            line([0.5, 0.2], [0.5, 0.8]);
            p.circle_filled(point(0.27, 0.5), 1.8, color);
        }
        "control-popup" => {
            outline([0.05, 0.2], [0.8, 0.95]);
            outline([0.35, 0.05], [0.95, 0.65]);
        }
        "control-button" => {
            outline([0.05, 0.22], [0.95, 0.78]);
            p.circle_filled(rect.center(), 1.6, color);
        }
        "lock" => {
            outline([0.2, 0.43], [0.8, 0.95]);
            p.add(egui::Shape::line(
                vec![
                    point(0.3, 0.43),
                    point(0.3, 0.15),
                    point(0.7, 0.15),
                    point(0.7, 0.43),
                ],
                Stroke::new(1.1, color),
            ));
        }
        "fit" => {
            outline([0.05, 0.05], [0.95, 0.95]);
            outline([0.27, 0.27], [0.73, 0.73]);
        }
        _ => {
            outline([0.1, 0.1], [0.9, 0.9]);
        }
    }
}

impl Builder {
    fn choose_open(&mut self, ctx: &egui::Context) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("SCAMATIC JSON", &["json"])
            .pick_file()
        {
            if self.doc.dirty() {
                self.pending = Some(super::Pending::Open(path));
            } else {
                self.open(path, ctx);
            }
        }
    }

    fn import_svg(&mut self, ctx: &egui::Context) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("SVG background", &["svg"])
            .pick_file()
        {
            match std::fs::metadata(&path) {
                Ok(meta) if meta.len() <= document::MAX_DOCUMENT_BYTES => {
                    match std::fs::read_to_string(path) {
                        Ok(svg) => {
                            self.doc.attach_svg(svg);
                            self.refresh_images(ctx);
                            self.status = "SVG attached to working copy.".into();
                        }
                        Err(error) => self.status = error.to_string(),
                    }
                }
                Ok(_) => self.status = "SVG exceeds 32 MiB limit.".into(),
                Err(error) => self.status = error.to_string(),
            }
        }
    }

    fn history(&mut self, ctx: &egui::Context, redo: bool) {
        if let Some(drag) = self.drag.take() {
            self.doc.root = drag.before;
        }
        self.sketch = None;
        if redo {
            self.doc.redo();
        } else {
            self.doc.undo();
        }
        self.refresh_images(ctx);
    }

    pub(super) fn component_available(&self, kind: &str) -> bool {
        let project_type = text(&self.doc.schema()["project"], "projectType", "scada");
        self.catalog.get(kind).is_some_and(|def| {
            def.library != Some(false)
                && def
                    .project_types
                    .as_ref()
                    .is_none_or(|types| types.iter().any(|t| t == project_type))
        })
    }

    pub(super) fn add_component(&mut self, kind: &str) {
        if !self.component_available(kind) {
            return;
        }
        if let Some(definition) = self.catalog.get(kind) {
            let mut definition = definition.clone();
            if self.doc.is_iot() {
                let canvas = self.doc.canvas();
                definition.default_size.width = definition.default_size.width.min(canvas[0]);
                definition.default_size.height = definition.default_size.height.min(canvas[1]);
            }
            self.doc.add(kind, &definition);
        }
    }

    pub(super) fn toolbar(&mut self, ui: &mut egui::Ui) {
        let ctx = ui.ctx().clone();
        egui::Panel::top("menu-bar").frame(frame(PANEL, 10, 2)).show(ui, |ui| {
            egui::MenuBar::new().ui(ui, |ui| {
                ui.menu_button("File", |ui| {
                    if ui.button("Open JSON…").clicked() { ui.close(); self.choose_open(&ctx); }
                    ui.menu_button("Open example", |ui| {
                        if ui.button("IoT dashboard").clicked() { ui.close(); self.request_example(true, &ctx); }
                        if ui.button("SCADA schematic").clicked() { ui.close(); self.request_example(false, &ctx); }
                    });
                    if ui.button("Import SVG…").clicked() { ui.close(); self.import_svg(&ctx); }
                    ui.separator();
                    if ui.button("Save copy…").clicked() { ui.close(); self.save(); }
                });
                ui.menu_button("Edit", |ui| {
                    if ui.button("Move / Select").clicked() { self.doc.selected = None; self.markup_tool = None; self.sketch = None; ui.close(); }
                    ui.separator();
                    if ui.add_enabled(self.doc.can_undo(), egui::Button::new("Undo    Ctrl+Z")).clicked() { ui.close(); self.history(&ctx, false); }
                    if ui.add_enabled(self.doc.can_redo(), egui::Button::new("Redo    Ctrl+Y")).clicked() { ui.close(); self.history(&ctx, true); }
                    ui.separator();
                    if ui.add_enabled(self.doc.can_delete_selected(), egui::Button::new("Delete selected    Del")).clicked() { self.doc.delete_selected(); ui.close(); }
                });
                ui.menu_button("Insert", |ui| {
                    if self.doc.is_iot() {
                        for (group, kinds) in IOT_GROUPS { ui.menu_button(*group, |ui| {
                            for kind in *kinds { if self.component_available(kind) && ui.button(iot_label(kind)).clicked() { self.add_component(kind); ui.close(); } }
                        }); }
                        ui.menu_button(industrial::GROUP, |ui| {
                            for symbol in industrial::symbols() {
                                if ui.button(&symbol.label).clicked() { self.add_industrial(symbol); ui.close(); }
                            }
                        });
                    } else { for kind in TOOLS {
                        if self.component_available(kind) && ui.button(&self.catalog[*kind].label).clicked() { self.add_component(kind); ui.close(); }
                    } }
                    ui.separator();
                    ui.menu_button("Markup", |ui| {
                        for kind in crate::markup::Kind::ALL {
                            if ui.button(kind.label()).clicked() { self.set_palette_expanded(true); self.choose_markup(kind); ui.close(); }
                        }
                    });
                });
                ui.menu_button("View", |ui| {
                    ui.label("Zoom");
                    ui.scope(|ui| {
                        ui.spacing_mut().slider_width = 88.0;
                        ui.spacing_mut().interact_size.y = 16.0;
                        ui.spacing_mut().slider_rail_height = 4.0;
                        ui.add(egui::Slider::new(&mut self.zoom, 0.25..=1.5)
                            .handle_shape(egui::style::HandleShape::Rect { aspect_ratio: 0.6 })
                            .fixed_decimals(2).suffix("×"));
                    });
                    if ui.button("Fit canvas").clicked() { self.fit = true; ui.close(); }
                    ui.separator();
                    ui.checkbox(&mut self.grid, "Show grid");
                    ui.checkbox(&mut self.snap, "Snap to grid (20 px)");
                    ui.separator();
                    let mut expanded = self.palette_expanded;
                    if ui.checkbox(&mut expanded, if self.doc.is_iot() { "Expand widget palette" } else { "Expand markup tools" }).changed() { self.set_palette_expanded(expanded); }
                });
                ui.menu_button("Help", |ui| {
                    ui.label(RichText::new(concat!("Canvas Lab ", env!("CARGO_PKG_VERSION"))).strong());
                    ui.label("Select and drag objects. Resize with the corner handle.");
                    ui.label("Use Insert or the left toolbar to add a component.");
                    ui.label("Save copy keeps the imported file intact.");
                    ui.separator();
                    ui.label("Local layout prototype · live data and publishing use the main Builder.");
                });
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    ui.label(RichText::new(concat!("Canvas Lab  /  ", env!("CARGO_PKG_VERSION"))).size(11.0).color(MUTED));
                });
            });
        });
    }

    pub(super) fn tool_rail(&mut self, ui: &mut egui::Ui, workspace: Rect) {
        if self.doc.is_iot() {
            self.iot_tool_rail(ui, workspace);
            return;
        }
        let width = if self.palette_expanded { 74.0 } else { 40.0 };
        egui::Area::new(egui::Id::unique("floating-component-palette"))
            .order(egui::Order::Middle)
            .anchor(Align2::LEFT_CENTER, Vec2::new(12.0, 0.0))
            .default_size(Vec2::new(width, (workspace.height() - 24.0).max(100.0)))
            .movable(false)
            .constrain_to(workspace)
            .show(ui.ctx(), |ui| {
                ui.set_max_height((workspace.height() - 24.0).max(100.0));
                ui.set_max_width(width);
                frame(PANEL, 6, 6)
                    .corner_radius(8)
                    .stroke(Stroke::new(1.0, EDGE))
                    .shadow(egui::epaint::Shadow {
                        offset: [0, 3],
                        blur: 12,
                        spread: 0,
                        color: Color32::from_black_alpha(110),
                    })
                    .show(ui, |ui| {
                        ui.set_width(width - 14.0);
                        ui.spacing_mut().item_spacing.y = 1.0;
                        ui.horizontal(|ui| {
                            let (kind, label) = if self.palette_expanded {
                                ("collapse", "Collapse markup tools")
                            } else {
                                ("expand", "Expand markup tools")
                            };
                            if icon_button(ui, kind, label, false).clicked() {
                                self.set_palette_expanded(!self.palette_expanded);
                            }
                            if self.palette_expanded {
                                ui.add_space(4.0);
                                ui.label(RichText::new("Draw").size(9.0).color(MUTED));
                            }
                        });
                        ui.separator();
                        egui::ScrollArea::vertical()
                            .id_salt("component-tools")
                            .max_height((workspace.height() - 80.0).max(26.0))
                            .auto_shrink([false, true])
                            .show(ui, |ui| {
                                ui.horizontal_top(|ui| {
                                    ui.vertical(|ui| {
                                        ui.set_width(26.0);
                                        if icon_button(
                                            ui,
                                            "select",
                                            "Select / move objects",
                                            self.markup_tool.is_none(),
                                        )
                                        .clicked()
                                        {
                                            self.doc.selected = None;
                                            self.markup_tool = None;
                                            self.sketch = None;
                                        }
                                        ui.separator();
                                        for kind in TOOLS {
                                            if !self.component_available(kind) {
                                                continue;
                                            }
                                            if *kind == "pump" || *kind == "control-button" {
                                                ui.add_space(3.0);
                                                ui.separator();
                                            }
                                            let label =
                                                format!("Add {}", self.catalog[*kind].label);
                                            if icon_button(ui, kind, &label, false).clicked() {
                                                self.markup_tool = None;
                                                self.sketch = None;
                                                self.add_component(kind);
                                            }
                                        }
                                    });
                                    if self.palette_expanded {
                                        ui.add_space(7.0);
                                        ui.vertical(|ui| {
                                            ui.set_width(26.0);
                                            for kind in crate::markup::Kind::ALL {
                                                if icon_button(
                                                    ui,
                                                    kind.id(),
                                                    &format!("{} · draw on canvas", kind.label()),
                                                    self.markup_tool == Some(kind),
                                                )
                                                .clicked()
                                                {
                                                    self.choose_markup(kind);
                                                }
                                            }
                                        });
                                    }
                                });
                            });
                    });
            });
    }

    pub(super) fn sidebar(&mut self, ui: &mut egui::Ui) {
        egui::Panel::right("properties-and-layers")
            .exact_size(276.0)
            .resizable(false)
            .frame(frame(PANEL, 0, 0))
            .show(ui, |ui| {
                ui.spacing_mut().item_spacing.y = 0.0;
                let properties_height = (ui.available_height() * 0.56).clamp(270.0, 430.0);
                ui.allocate_ui_with_layout(
                    Vec2::new(ui.available_width(), properties_height),
                    Layout::top_down(Align::Min),
                    |ui| {
                        ui.set_min_height(properties_height);
                        section(ui, "Properties", "DESKTOP");
                        frame(PANEL, 14, 12).show(ui, |ui| {
                            ui.spacing_mut().item_spacing.y = 4.0;
                            ui.spacing_mut().interact_size.y = 23.0;
                            ui.style_mut().spacing.text_edit_width = ui.available_width();
                            egui::ScrollArea::vertical()
                                .id_salt("properties-content")
                                .max_height(properties_height - 60.0)
                                .auto_shrink([false, false])
                                .show(ui, |ui| self.inspector(ui));
                        });
                    },
                );
                section(ui, "Layers", &self.doc.objects().count().to_string());
                egui::ScrollArea::vertical()
                    .id_salt("layers-scroll")
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        let mut selected = self.doc.selected.clone();
                        let layer_icon: fn(&egui::Ui, Rect, &str, Color32) = if self.doc.is_iot() {
                            iot::layer_widget_icon
                        } else {
                            icon
                        };
                        let mut components: Vec<_> = self.doc.objects().map(|(_, v)| v).collect();
                        components
                            .sort_by_key(|c| std::cmp::Reverse(c["zIndex"].as_i64().unwrap_or(0)));
                        for component in components {
                            let id = text(component, "id", "");
                            let name = text(component, "name", "Object");
                            let kind = industrial::for_component(component)
                                .map(|symbol| symbol.generator.as_str())
                                .unwrap_or_else(|| text(component, "type", "unknown"));
                            let (rect, response) = ui.allocate_exact_size(
                                Vec2::new(ui.available_width(), 34.0),
                                Sense::click(),
                            );
                            let is_selected = selected.as_deref() == Some(id);
                            if is_selected || response.hovered() {
                                ui.painter().rect_filled(
                                    rect,
                                    0,
                                    if is_selected {
                                        Color32::from_rgb(64, 66, 70)
                                    } else {
                                        Color32::from_rgb(49, 52, 57)
                                    },
                                );
                            }
                            if is_selected {
                                ui.painter().rect_filled(
                                    Rect::from_min_size(rect.min, Vec2::new(2.0, rect.height())),
                                    0,
                                    paint::ACCENT,
                                );
                            }
                            let tint = if component["visible"] == false {
                                Color32::from_rgb(109, 115, 124)
                            } else {
                                MUTED
                            };
                            icon(
                                ui,
                                Rect::from_center_size(
                                    rect.left_center() + Vec2::new(16.0, 0.0),
                                    Vec2::splat(15.0),
                                ),
                                if component["visible"] == false {
                                    "hidden"
                                } else {
                                    "eye"
                                },
                                tint,
                            );
                            let thumbnail = Rect::from_center_size(
                                rect.left_center() + Vec2::new(43.0, 0.0),
                                Vec2::new(24.0, 23.0),
                            );
                            ui.painter().rect_filled(thumbnail, 2, BACKDROP);
                            layer_icon(ui, thumbnail.shrink(5.0), kind, tint);
                            let name_rect = Rect::from_min_max(
                                rect.min + Vec2::new(62.0, 0.0),
                                rect.max - Vec2::new(29.0, 0.0),
                            );
                            ui.painter()
                                .with_clip_rect(name_rect.intersect(ui.clip_rect()))
                                .text(
                                    name_rect.left_center(),
                                    Align2::LEFT_CENTER,
                                    name,
                                    FontId::proportional(12.0),
                                    if component["visible"] == false {
                                        MUTED
                                    } else {
                                        TEXT
                                    },
                                );
                            if component["locked"] == true {
                                icon(
                                    ui,
                                    Rect::from_center_size(
                                        rect.right_center() - Vec2::new(16.0, 0.0),
                                        Vec2::splat(12.0),
                                    ),
                                    "lock",
                                    MUTED,
                                );
                            }
                            if response.clicked() {
                                selected = Some(id.to_owned());
                                self.markup_tool = None;
                                self.sketch = None;
                            }
                            response.widget_info(|| {
                                egui::WidgetInfo::selected(
                                    egui::Role::Button,
                                    ui.is_enabled(),
                                    is_selected,
                                    name,
                                )
                            });
                            response.on_hover_text(format!("{name} · {kind}"));
                        }
                        self.doc.selected = selected;
                    });
            });
    }

    pub(super) fn status_bar(&self, ui: &mut egui::Ui) {
        egui::Panel::bottom("status")
            .frame(frame(PANEL, 10, 4))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new(format!("{:.0}%", self.zoom * 100.0)).size(11.0));
                    ui.separator();
                    let canvas = self.doc.canvas();
                    ui.label(
                        RichText::new(format!("{:.0} × {:.0} px", canvas[0], canvas[1]))
                            .size(11.0)
                            .color(MUTED),
                    );
                    ui.separator();
                    ui.label(
                        RichText::new(format!("{} layers", self.doc.objects().count()))
                            .size(11.0)
                            .color(MUTED),
                    );
                    ui.separator();
                    let status_width = (ui.available_width() - 105.0).max(40.0);
                    let dirty = self.doc.dirty();
                    let status = if dirty {
                        format!("Unsaved changes · {}", self.status)
                    } else {
                        self.status.clone()
                    };
                    ui.add_sized(
                        [status_width, 16.0],
                        egui::Label::new(RichText::new(&status).size(11.0).color(if dirty {
                            TEXT
                        } else {
                            MUTED
                        }))
                        .truncate(),
                    )
                    .on_hover_text(&status);
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(RichText::new("LOCAL PROTOTYPE").size(9.0).color(MUTED));
                    });
                });
            });
    }
}
