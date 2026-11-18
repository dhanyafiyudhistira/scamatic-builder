use super::*;

fn matches_query(kind: &str, label: &str, group: &str, query: &str) -> bool {
    query.is_empty()
        || format!("{kind} {label} {group}")
            .to_lowercase()
            .contains(query)
}

fn widget_icon(ui: &egui::Ui, rect: Rect, kind: &str, tint: Color32) {
    paint_widget_icon(ui, rect, kind, tint, 1.0);
}

pub(super) fn layer_widget_icon(ui: &egui::Ui, rect: Rect, kind: &str, tint: Color32) {
    paint_widget_icon(ui, rect, kind, tint, 1.2);
}

fn paint_widget_icon(ui: &egui::Ui, rect: Rect, kind: &str, tint: Color32, scale: f32) {
    macro_rules! phosphor {
        ($name:literal) => {
            (
                concat!("bytes://phosphor/", $name, ".svg"),
                include_bytes!(concat!("../../../assets/icons/phosphor/", $name, ".svg")),
            )
        };
    }
    let (uri, svg): (&str, &[u8]) = match kind {
        "text-label" => phosphor!("text-t"),
        "value-span" => phosphor!("number-square-one"),
        "indicator-lamp" => phosphor!("lightbulb"),
        "alarm" => phosphor!("warning"),
        "gauge" => phosphor!("gauge"),
        "chart" => phosphor!("chart-line"),
        "control-button" => phosphor!("power"),
        "tuning-slider" => phosphor!("sliders-horizontal"),
        "operation-shifter" => phosphor!("arrows-left-right"),
        "control-popup" => phosphor!("browsers"),
        _ => return icon(ui, rect, kind, tint),
    };
    let size = rect.width().min(rect.height()) * scale;
    let bounds = Rect::from_center_size(rect.center(), Vec2::splat(size));
    egui::Image::from_bytes(uri, svg)
        .tint(tint)
        .paint_at(ui, bounds);
}

fn named_tool(ui: &mut egui::Ui, kind: &str, label: &str, selected: bool) -> Response {
    let (rect, response) =
        ui.allocate_exact_size(Vec2::new(ui.available_width(), 28.0), Sense::click());
    if selected || response.hovered() {
        ui.painter().rect_filled(
            rect.shrink(1.0),
            4,
            if selected {
                Color32::from_rgb(64, 66, 71)
            } else {
                Color32::from_rgb(50, 53, 58)
            },
        );
    }
    widget_icon(
        ui,
        Rect::from_center_size(rect.left_center() + Vec2::new(14.0, 0.0), Vec2::splat(16.0)),
        kind,
        if selected { TEXT } else { MUTED },
    );
    ui.painter()
        .with_clip_rect(rect.intersect(ui.clip_rect()))
        .text(
            rect.left_center() + Vec2::new(32.0, 0.0),
            Align2::LEFT_CENTER,
            label,
            FontId::proportional(12.0),
            TEXT,
        );
    response.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, ui.is_enabled(), label));
    response
        .on_hover_cursor(egui::CursorIcon::PointingHand)
        .on_hover_text(label)
}

impl Builder {
    pub(super) fn add_industrial(&mut self, symbol: &industrial::Symbol) {
        match self
            .doc
            .add_industrial(symbol, &self.catalog["design-image"])
        {
            Ok(()) => {
                self.markup_tool = None;
                self.sketch = None;
                self.status = format!("Added {} · Grindstone Visual Toolkit", symbol.label);
            }
            Err(message) => self.status = message,
        }
    }

    pub(in crate::app) fn iot_chart_tags(
        ui: &mut egui::Ui,
        value: &mut serde_json::Value,
        schema: &serde_json::Value,
    ) {
        ui.label("Chart series");
        let mut ids: Vec<String> = value["binding"]["tagIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        let mut changed = false;
        for tag in schema["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| t["dataType"] == "number" && t["access"] != "write")
        {
            let id = text(tag, "id", "");
            let mut selected = ids.iter().any(|v| v == id);
            if ui
                .add_enabled(
                    selected || ids.len() < 8,
                    egui::Checkbox::new(&mut selected, text(tag, "name", id)),
                )
                .changed()
            {
                if selected {
                    ids.push(id.to_owned());
                } else {
                    ids.retain(|v| v != id);
                }
                changed = true;
            }
        }
        if changed {
            value["binding"]["tagId"] = ids
                .first()
                .map(|id| serde_json::json!(id))
                .unwrap_or(serde_json::Value::Null);
            value["binding"]["tagIds"] = serde_json::json!(ids);
        }
    }

    pub(in crate::app) fn iot_tool_rail(&mut self, ui: &mut egui::Ui, workspace: Rect) {
        let width = if self.palette_expanded { 208.0 } else { 40.0 };
        egui::Area::new(egui::Id::unique("floating-iot-palette"))
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
                        ui.spacing_mut().item_spacing.y = 2.0;
                        ui.horizontal(|ui| {
                            let (kind, label) = if self.palette_expanded {
                                ("collapse", "Collapse IoT palette")
                            } else {
                                ("expand", "Expand IoT palette")
                            };
                            if icon_button(ui, kind, label, false).clicked() {
                                self.set_palette_expanded(!self.palette_expanded);
                            }
                            if self.palette_expanded {
                                ui.label(RichText::new("IoT widgets").strong());
                            }
                        });
                        ui.separator();
                        if self.palette_expanded {
                            ui.add(
                                egui::TextEdit::singleline(&mut self.palette_search)
                                    .hint_text("Search tools and symbols")
                                    .char_limit(64)
                                    .desired_width(width - 14.0),
                            );
                        }
                        let query = if self.palette_expanded {
                            self.palette_search.trim().to_lowercase()
                        } else {
                            String::new()
                        };
                        egui::ScrollArea::vertical()
                            .id_salt("iot-tools-scroll")
                            .max_height((workspace.height() - 112.0).max(80.0))
                            .auto_shrink([false, true])
                            .show(ui, |ui| {
                                let select_clicked = if self.palette_expanded {
                                    named_tool(
                                        ui,
                                        "select",
                                        "Select / move",
                                        self.markup_tool.is_none(),
                                    )
                                    .clicked()
                                } else {
                                    icon_button(
                                        ui,
                                        "select",
                                        "Select / move objects",
                                        self.markup_tool.is_none(),
                                    )
                                    .clicked()
                                };
                                if select_clicked {
                                    self.doc.selected = None;
                                    self.markup_tool = None;
                                    self.sketch = None;
                                }
                                let mut found = 0;
                                for (group, kinds) in IOT_GROUPS {
                                    let tools: Vec<_> = kinds
                                        .iter()
                                        .copied()
                                        .filter(|kind| {
                                            self.component_available(kind)
                                                && matches_query(
                                                    kind,
                                                    iot_label(kind),
                                                    group,
                                                    &query,
                                                )
                                        })
                                        .collect();
                                    found += tools.len();
                                    if tools.is_empty() {
                                        continue;
                                    }
                                    if self.palette_expanded {
                                        egui::CollapsingHeader::new(*group)
                                            .id_salt(("iot-group", group))
                                            .default_open(true)
                                            .open(if query.is_empty() { None } else { Some(true) })
                                            .show(ui, |ui| {
                                                for kind in tools {
                                                    if named_tool(ui, kind, iot_label(kind), false)
                                                        .clicked()
                                                    {
                                                        self.markup_tool = None;
                                                        self.sketch = None;
                                                        self.add_component(kind);
                                                    }
                                                }
                                            });
                                    } else {
                                        ui.separator();
                                        for kind in tools {
                                            if icon_button_with(
                                                ui,
                                                kind,
                                                iot_label(kind),
                                                false,
                                                widget_icon,
                                            )
                                            .clicked()
                                            {
                                                self.markup_tool = None;
                                                self.sketch = None;
                                                self.add_component(kind);
                                            }
                                        }
                                    }
                                }
                                if self.palette_expanded {
                                    let symbols: Vec<_> = industrial::symbols()
                                        .iter()
                                        .filter(|symbol| {
                                            matches_query(
                                                &symbol.generator,
                                                &symbol.label,
                                                industrial::GROUP,
                                                &query,
                                            )
                                        })
                                        .collect();
                                    found += symbols.len();
                                    if !symbols.is_empty() {
                                        egui::CollapsingHeader::new(industrial::GROUP)
                                            .id_salt("iot-industrial-symbols")
                                            .default_open(false)
                                            .open(if query.is_empty() { None } else { Some(true) })
                                            .show(ui, |ui| {
                                                for symbol in symbols {
                                                    if named_tool(
                                                        ui,
                                                        &symbol.generator,
                                                        &symbol.label,
                                                        false,
                                                    )
                                                    .clicked()
                                                    {
                                                        self.add_industrial(symbol);
                                                    }
                                                }
                                            });
                                    }
                                    let tools: Vec<_> = crate::markup::Kind::ALL
                                        .into_iter()
                                        .filter(|kind| {
                                            matches_query(
                                                kind.id(),
                                                kind.label(),
                                                "Decoration markup",
                                                &query,
                                            )
                                        })
                                        .collect();
                                    found += tools.len();
                                    if !tools.is_empty() {
                                        egui::CollapsingHeader::new("Decoration")
                                            .id_salt("iot-decoration")
                                            .default_open(false)
                                            .open(
                                                if !query.is_empty() || self.markup_tool.is_some() {
                                                    Some(true)
                                                } else {
                                                    None
                                                },
                                            )
                                            .show(ui, |ui| {
                                                for kind in tools {
                                                    if named_tool(
                                                        ui,
                                                        kind.id(),
                                                        kind.label(),
                                                        self.markup_tool == Some(kind),
                                                    )
                                                    .clicked()
                                                    {
                                                        self.choose_markup(kind);
                                                    }
                                                }
                                            });
                                    }
                                    if found == 0 {
                                        ui.label(RichText::new("No matching tools").color(MUTED));
                                    }
                                }
                            });
                    });
            });
    }

    pub(in crate::app) fn iot_properties(
        ui: &mut egui::Ui,
        kind: &str,
        value: &mut serde_json::Value,
    ) {
        let props = &mut value["properties"];
        match kind {
            "chart" => {
                ui.separator();
                ui.label("Chart settings (runtime dialog)");
                ui.horizontal(|ui| {
                    ui.label("Window");
                    let mut minutes = crate::document::number(props, "windowMinutes", 60.0);
                    if ui
                        .add(
                            egui::DragValue::new(&mut minutes)
                                .range(1.0..=1440.0)
                                .suffix(" min"),
                        )
                        .changed()
                    {
                        props["windowMinutes"] = serde_json::json!(minutes);
                    }
                });
                let mut legend = props["showLegend"] != false;
                if ui.checkbox(&mut legend, "Show legend").changed() {
                    props["showLegend"] = serde_json::json!(legend);
                }
            }
            "value-span" | "gauge" | "tuning-slider" => {
                ui.separator();
                ui.horizontal(|ui| {
                    ui.label("Decimals");
                    let mut decimals = props["decimals"].as_u64().unwrap_or(1) as u32;
                    if ui
                        .add(egui::DragValue::new(&mut decimals).range(0..=8))
                        .changed()
                    {
                        props["decimals"] = serde_json::json!(decimals);
                    }
                });
                let mut inherit =
                    kind == "gauge" && text(props, "unitMode", "inherit") == "inherit";
                if kind == "gauge" && ui.checkbox(&mut inherit, "Use tag unit").changed() {
                    props["unitMode"] =
                        serde_json::json!(if inherit { "inherit" } else { "custom" });
                }
                ui.label(if kind == "gauge" {
                    "Custom unit"
                } else {
                    "Unit / suffix"
                });
                let mut unit = text(props, "suffix", "").to_owned();
                if ui
                    .add_enabled(
                        !inherit,
                        egui::TextEdit::singleline(&mut unit).char_limit(40),
                    )
                    .changed()
                {
                    props["suffix"] = serde_json::json!(unit);
                    if kind == "gauge" {
                        props["unitMode"] = serde_json::json!("custom");
                    }
                }
                if kind == "gauge" {
                    let mut digital = props["showDigital"] != false;
                    if ui.checkbox(&mut digital, "Show digital value").changed() {
                        props["showDigital"] = serde_json::json!(digital);
                    }
                }
            }
            "control-popup" => {
                ui.label("Button text");
                let mut label = text(props, "triggerLabel", "OPEN CONTROLS").to_owned();
                if ui
                    .add(egui::TextEdit::singleline(&mut label).char_limit(160))
                    .changed()
                {
                    props["triggerLabel"] = serde_json::json!(label);
                }
            }
            "indicator-lamp" | "alarm" => {
                let (key, title, options): (&str, &str, &[&str]) = if kind == "indicator-lamp" {
                    ("shape", "Lamp shape", &["circle", "square", "rectangle"])
                } else {
                    ("presentation", "Alarm presentation", &["lamp", "buzzer"])
                };
                ui.label(title);
                let mut selected = text(props, key, options[0]).to_owned();
                egui::ComboBox::from_id_salt((kind, key))
                    .selected_text(&selected)
                    .show_ui(ui, |ui| {
                        for option in options {
                            ui.selectable_value(&mut selected, (*option).to_owned(), *option);
                        }
                    });
                if selected != text(props, key, options[0]) {
                    props[key] = serde_json::json!(selected);
                }
            }
            _ => (),
        }
    }

    pub(in crate::app) fn iot_colors(ui: &mut egui::Ui, kind: &str, value: &mut serde_json::Value) {
        use crate::iot_style as style;
        let id = text(value, "id", "").to_owned();
        let series_count = value["binding"]["tagIds"]
            .as_array()
            .map(Vec::len)
            .unwrap_or(0)
            .min(8);
        let props = &mut value["properties"];
        egui::CollapsingHeader::new("Colors")
            .id_salt(("iot-colors", id))
            .default_open(false)
            .show(ui, |ui| {
                if matches!(kind, "gauge" | "operation-shifter" | "chart") {
                    ui.label(RichText::new("The IoT matte skin controls fixed surfaces. Mode and series colors apply in runtime dialogs.").small().color(MUTED));
                }
                if kind == "text-label" {
                    let mut transparent = props["transparentBackground"] != false;
                    if ui
                        .checkbox(&mut transparent, "Transparent background")
                        .changed()
                    {
                        props["transparentBackground"] = serde_json::json!(transparent);
                    }
                }
                egui::Grid::new("iot-color-fields")
                    .num_columns(2)
                    .spacing([10.0, 5.0])
                    .show(ui, |ui| {
                        if let Some(fields) = style::defaults(kind).as_object() {
                            for (key, default) in fields {
                                if !default.is_string()
                                    || (kind == "gauge" && matches!(key.as_str(), "faceColor" | "textColor"))
                                    || (kind == "indicator-lamp" && key == "alarmColor")
                                {
                                    continue;
                                }
                                ui.label(style::field_label(key));
                                let color = style::color(props, kind, key);
                                let mut rgb = [color.r(), color.g(), color.b()];
                                ui.push_id(key, |ui| {
                                    ui.add_enabled_ui(
                                        !(kind == "text-label"
                                            && key == "backgroundColor"
                                            && props["transparentBackground"] != false),
                                        |ui| {
                                            if ui.color_edit_button_srgb(&mut rgb).changed() {
                                                props[key] = serde_json::json!(format!(
                                                    "#{:02x}{:02x}{:02x}",
                                                    rgb[0], rgb[1], rgb[2]
                                                ));
                                            }
                                        },
                                    );
                                });
                                ui.end_row();
                            }
                        }
                        if kind == "chart" {
                            for i in 0..series_count {
                                ui.label(format!("Series {}", i + 1));
                                let color = style::series_color(props, i);
                                let mut rgb = [color.r(), color.g(), color.b()];
                                ui.push_id(("series-color", i), |ui| {
                                    if ui.color_edit_button_srgb(&mut rgb).changed() {
                                        let mut colors: Vec<_> = (0..8)
                                            .map(|n| {
                                                let c = style::series_color(props, n);
                                                serde_json::json!(format!(
                                                    "#{:02x}{:02x}{:02x}",
                                                    c.r(),
                                                    c.g(),
                                                    c.b()
                                                ))
                                            })
                                            .collect();
                                        colors[i] = serde_json::json!(format!(
                                            "#{:02x}{:02x}{:02x}",
                                            rgb[0], rgb[1], rgb[2]
                                        ));
                                        props["seriesColors"] = serde_json::json!(colors);
                                    }
                                });
                                ui.end_row();
                            }
                        }
                    });
            });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_matches_labels_types_and_categories() {
        assert!(matches_query(
            "value-span",
            "Value card",
            "Information",
            "value"
        ));
        assert!(matches_query(
            "chart",
            "History chart",
            "Visualization",
            "visualization"
        ));
        assert!(matches_query(
            "markup-pencil",
            "Pencil / freehand",
            "Decoration markup",
            "freehand"
        ));
        assert!(!matches_query(
            "chart",
            "History chart",
            "Visualization",
            "pump"
        ));
    }
}
