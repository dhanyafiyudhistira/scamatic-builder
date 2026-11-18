use super::*;

pub(super) struct SketchDrag {
    kind: Kind,
    start: Pos2,
    end: Pos2,
    points: Vec<Pos2>,
}

impl Builder {
    pub(super) fn palette_gutter(&self) -> f32 {
        if self.doc.is_iot() && self.palette_expanded {
            return 232.0;
        }
        workspace::PALETTE_GUTTER + if self.palette_expanded { 34.0 } else { 0.0 }
    }

    pub(super) fn set_palette_expanded(&mut self, expanded: bool) {
        self.palette_expanded = expanded;
        if !expanded {
            self.markup_tool = None;
            self.sketch = None;
        }
    }

    pub(super) fn choose_markup(&mut self, kind: Kind) {
        self.markup_tool = Some(kind);
        self.sketch = None;
        self.drag = None;
        self.status = format!(
            "{} · drag on the canvas · Esc returns to Select",
            kind.label()
        );
    }

    pub(super) fn markup_properties(ui: &mut egui::Ui, value: &mut Value) {
        let Some(kind) = Kind::from_value(value) else {
            return;
        };
        let props = &mut value["properties"];
        if kind == Kind::Text {
            ui.label("Text");
            let mut content = text(props, "text", "").to_owned();
            if ui
                .add(
                    egui::TextEdit::multiline(&mut content)
                        .desired_rows(1)
                        .char_limit(2048)
                        .margin(egui::Margin::symmetric(6, 3)),
                )
                .changed()
            {
                props["text"] = json!(content);
            }
            ui.horizontal(|ui| {
                ui.label("Font size");
                let mut size = number(props, "fontSize", 24.0);
                if ui
                    .add(egui::DragValue::new(&mut size).range(8.0..=160.0))
                    .changed()
                {
                    props["fontSize"] = json!(size);
                }
            });
        }
        ui.horizontal(|ui| {
            ui.label(if kind == Kind::Text {
                "Text color"
            } else {
                "Stroke"
            });
            Self::markup_color(ui, props, "strokeColor");
            if kind != Kind::Text {
                let mut width = number(props, "strokeWidth", 2.0);
                if ui
                    .add(
                        egui::DragValue::new(&mut width)
                            .speed(0.25)
                            .range(0.5..=32.0)
                            .suffix(" px"),
                    )
                    .changed()
                {
                    props["strokeWidth"] = json!(width);
                }
            }
        });
        if kind.supports_fill() {
            ui.horizontal(|ui| {
                let mut fill = props["filled"] == true;
                if ui.checkbox(&mut fill, "Fill").changed() {
                    props["filled"] = json!(fill);
                }
                ui.add_enabled_ui(fill, |ui| Self::markup_color(ui, props, "fillColor"));
            });
        }
        if kind == Kind::RoundedRectangle {
            ui.horizontal(|ui| {
                ui.label("Corner radius");
                let mut radius = number(props, "cornerRadius", 12.0);
                if ui
                    .add(
                        egui::DragValue::new(&mut radius)
                            .range(0.0..=200.0)
                            .suffix(" px"),
                    )
                    .changed()
                {
                    props["cornerRadius"] = json!(radius);
                }
            });
        }
        match kind {
            Kind::Polygon | Kind::Star => {
                let (key, label, default) = if kind == Kind::Polygon {
                    ("sides", "Sides", 6)
                } else {
                    ("tips", "Star points", 5)
                };
                ui.horizontal(|ui| {
                    ui.label(label);
                    let mut count = props[key].as_u64().unwrap_or(default) as u32;
                    if ui
                        .add(egui::DragValue::new(&mut count).range(3..=12))
                        .changed()
                    {
                        props[key] = json!(count);
                    }
                });
                if kind == Kind::Star {
                    let mut ratio = number(props, "innerRatio", 0.45);
                    ui.label("Inner radius");
                    if ui.add(egui::Slider::new(&mut ratio, 0.15..=0.85)).changed() {
                        props["innerRatio"] = json!(ratio);
                    }
                }
            }
            Kind::Curve => {
                ui.label("Arch height");
                let mut bend = number(props, "bend", 1.0);
                if ui.add(egui::Slider::new(&mut bend, 0.0..=1.0)).changed() {
                    props["bend"] = json!(bend);
                }
            }
            _ => (),
        }
        ui.label("Opacity");
        let mut opacity = number(props, "opacity", 1.0) * 100.0;
        ui.scope(|ui| {
            ui.spacing_mut().interact_size.y = 16.0;
            if ui
                .add(
                    egui::Slider::new(&mut opacity, 0.0..=100.0)
                        .suffix("%")
                        .fixed_decimals(0),
                )
                .changed()
            {
                props["opacity"] = json!(opacity / 100.0);
            }
        });
    }

    fn markup_color(ui: &mut egui::Ui, props: &mut Value, key: &str) {
        let color = paint::color(text(props, key, ""), paint::ACCENT);
        let mut rgb = [color.r(), color.g(), color.b()];
        if ui.color_edit_button_srgb(&mut rgb).changed() {
            props[key] = json!(format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2]));
        }
    }

    pub(super) fn markup_actions(&mut self, ui: &mut egui::Ui) {
        let Some(object @ ObjectRef::Markup(_)) = self.doc.selected_object() else {
            return;
        };
        ui.add_enabled_ui(self.doc.object(object)["locked"] != true, |ui| {
            ui.separator();
            ui.horizontal(|ui| {
                if ui.button("To back").clicked() {
                    self.reorder_markup(false);
                }
                if ui.button("To front").clicked() {
                    self.reorder_markup(true);
                }
                if ui.button("Delete").clicked() {
                    self.doc.delete_selected();
                }
            });
        });
    }

    fn reorder_markup(&mut self, front: bool) {
        let Some(object @ ObjectRef::Markup(_)) = self.doc.selected_object() else {
            return;
        };
        if self.doc.object(object)["locked"] == true {
            return;
        }
        let indices = self
            .doc
            .objects()
            .map(|(_, v)| v["zIndex"].as_i64().unwrap_or(0));
        let z = if front {
            indices.max().unwrap_or(0).saturating_add(1)
        } else {
            indices.min().unwrap_or(0).saturating_sub(1)
        };
        let mut value = self.doc.object(object).clone();
        value["zIndex"] = json!(z);
        self.doc.replace_object(object, value);
    }

    pub(super) fn scene(
        &mut self,
        ui: &egui::Ui,
        canvas: Rect,
        response: &egui::Response,
        size: [f32; 2],
    ) {
        let mut objects: Vec<ObjectRef> = self.doc.objects().map(|(r, _)| r).collect();
        objects.sort_by_key(|r| self.doc.object(*r)["zIndex"].as_i64().unwrap_or(0));
        for object in &objects {
            let value = self.doc.object(*object);
            if value["visible"] == false {
                continue;
            }
            let bounds = markup::bounds(value, canvas, self.zoom);
            if matches!(object, ObjectRef::Markup(_)) {
                markup::render(ui, canvas, value, self.zoom);
            } else {
                let asset = if value["type"] == "design-image" {
                    value["properties"]["assetId"]
                        .as_str()
                        .and_then(|id| self.doc.asset(id).map(|bytes| (id, bytes)))
                } else {
                    None
                };
                if let Some((id, bytes)) = asset {
                    let bounds = crate::industrial::for_component(value)
                        .filter(|_| value["properties"]["objectFit"] != "fill")
                        .map_or(bounds, |symbol| symbol.fit(bounds));
                    let suffix = if bytes.starts_with(b"<") {
                        "svg"
                    } else {
                        "png"
                    };
                    egui::Image::from_bytes(
                        format!("bytes://asset-{}-{}.{}", self.image_revision, id, suffix),
                        bytes,
                    )
                    .fit_to_exact_size(bounds.size())
                    .paint_at(ui, bounds);
                } else {
                    if self.doc.is_iot() {
                        paint::iot_component(ui, bounds, value, self.zoom, self.doc.schema());
                    } else {
                        paint::component(ui, bounds, value, self.zoom);
                    }
                }
            }
            if self.doc.selected.as_deref() == value["id"].as_str() {
                let painter = ui
                    .painter()
                    .with_clip_rect(canvas.intersect(ui.clip_rect()));
                painter.rect_stroke(
                    bounds.expand(3.0),
                    2,
                    Stroke::new(1.3, paint::ACCENT),
                    StrokeKind::Outside,
                );
                if value["locked"] != true {
                    painter.rect_filled(
                        Rect::from_center_size(bounds.max, Vec2::splat(9.0)),
                        1,
                        paint::ACCENT,
                    );
                }
            }
        }
        if self.markup_tool.is_some() {
            response
                .clone()
                .on_hover_cursor(egui::CursorIcon::Crosshair);
        }
        let pointer = response.interact_pointer_pos();
        if ui.input(|i| i.pointer.primary_pressed())
            && response.hovered()
            && let Some(pointer) = pointer
        {
            if let Some(kind) = self.markup_tool {
                if self.doc.markups().len() >= markup::MAX_OBJECTS {
                    self.status = "Markup limit reached (2000 objects).".into();
                } else {
                    let point = ((pointer - canvas.min) / self.zoom)
                        .clamp(Vec2::ZERO, Vec2::new(size[0], size[1]));
                    self.sketch = Some(SketchDrag {
                        kind,
                        start: Pos2::new(point.x, point.y),
                        end: Pos2::new(point.x, point.y),
                        points: vec![Pos2::new(point.x, point.y)],
                    });
                }
            } else {
                let resize = self.doc.selected_object().filter(|r| {
                    let v = self.doc.object(*r);
                    v["visible"] != false
                        && v["locked"] != true
                        && Rect::from_center_size(
                            markup::bounds(v, canvas, self.zoom).max,
                            Vec2::splat(20.0),
                        )
                        .contains(pointer)
                });
                let hit = resize.or_else(|| {
                    objects.iter().rev().copied().find(|r| {
                        let value = self.doc.object(*r);
                        value["visible"] != false
                            && if matches!(r, ObjectRef::Markup(_)) {
                                markup::hit_test(value, canvas, self.zoom, pointer)
                            } else {
                                markup::bounds(value, canvas, self.zoom).contains(pointer)
                            }
                    })
                });
                self.doc.selected = hit.map(|r| text(self.doc.object(r), "id", "").to_owned());
                if let Some(object) = hit
                    && self.doc.object(object)["locked"] != true
                {
                    self.drag = Some(Drag {
                        object,
                        origin: pointer,
                        position: Position::read(self.doc.object(object)),
                        resize: resize.is_some(),
                        before: self.doc.root.clone(),
                    });
                }
            }
        }
        if let Some(sketch) = &mut self.sketch {
            if let Some(pointer) = ui.input(|i| i.pointer.interact_pos()) {
                let point = (pointer - canvas.min) / self.zoom;
                sketch.end = Pos2::new(point.x.clamp(0.0, size[0]), point.y.clamp(0.0, size[1]));
                if sketch.kind == Kind::Pencil {
                    markup::sample_freehand(&mut sketch.points, sketch.end);
                }
            }
            let [start, mut end] = markup::drawn_points(sketch.start, sketch.end, size, self.snap);
            if sketch.kind == Kind::Text && sketch.start.distance(sketch.end) < 4.0 {
                end = [
                    (start[0] + 240.0).min(size[0]),
                    (start[1] + 40.0).min(size[1]),
                ];
            }
            let preview = if sketch.kind == Kind::Pencil {
                markup::freehand(&sketch.points)
                    .unwrap_or_else(|| markup::create(sketch.kind, start, end, 0))
            } else {
                markup::create(sketch.kind, start, end, 0)
            };
            markup::render(ui, canvas, &preview, self.zoom);
            if ui.input(|i| i.pointer.primary_released()) {
                let kind = sketch.kind;
                let points = std::mem::take(&mut sketch.points);
                self.sketch = None;
                let drawn = if kind == Kind::Pencil {
                    points.windows(2).map(|p| p[0].distance(p[1])).sum::<f32>() >= 4.0
                } else {
                    Vec2::new(end[0] - start[0], end[1] - start[1]).length() >= 4.0
                };
                if drawn {
                    let result = if kind == Kind::Pencil {
                        self.doc.add_freehand(&points)
                    } else {
                        self.doc.add_markup(kind, start, end)
                    };
                    self.status = match result {
                        Ok(()) => format!("{} added · Select to move or resize", kind.label()),
                        Err(error) => error,
                    };
                }
            }
        }
        if let Some(drag) = &self.drag {
            if let Some(pointer) = ui.input(|i| i.pointer.interact_pos()) {
                let delta = (pointer - drag.origin) / self.zoom;
                if delta.length_sq() > 0.1 {
                    let position = if matches!(drag.object, ObjectRef::Markup(_)) {
                        drag.position.transformed_markup(
                            [delta.x, delta.y],
                            drag.resize,
                            self.snap,
                            size,
                        )
                    } else {
                        drag.position
                            .transformed([delta.x, delta.y], drag.resize, self.snap, size)
                    };
                    self.doc.set_object_position(drag.object, position);
                }
            }
            if ui.input(|i| i.pointer.primary_released())
                && let Some(drag) = self.drag.take()
            {
                self.doc.commit(drag.before);
            }
        }
    }
}
