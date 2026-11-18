use super::*;
use crate::iot_style as style;
use std::sync::LazyLock;

static REFERENCE: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../assets/iot-runtime-reference.json"))
        .expect("production IoT skin and gauge reference")
});

fn skin(name: &str) -> Color32 {
    color(text(&REFERENCE["matte"], name, ""), INK)
}

fn tag<'a>(schema: &'a Value, id: &str) -> Option<&'a Value> {
    schema["tags"]
        .as_array()?
        .iter()
        .find(|tag| tag["id"] == id)
}

fn finite(value: &Value, key: &str, fallback: f64) -> f64 {
    value[key]
        .as_f64()
        .filter(|n| n.is_finite())
        .unwrap_or(fallback)
}

fn range_and_unit(value: &Value, schema: &Value) -> (f64, f64, String) {
    let props = &value["properties"];
    let bound = tag(schema, text(&value["binding"], "tagId", ""));
    let engineering = bound.map(|t| &t["engineering"]).unwrap_or(&Value::Null);
    let inherited = text(props, "rangeMode", "inherit") == "inherit";
    let limits = if inherited && value["type"] == "tuning-slider" {
        bound
            .map(|t| &t["writeConstraints"])
            .unwrap_or(&Value::Null)
    } else {
        &Value::Null
    };
    let min = if inherited {
        finite(
            limits,
            "min",
            finite(engineering, "min", finite(props, "min", 0.0)),
        )
    } else {
        finite(props, "min", 0.0)
    };
    let max = if inherited {
        finite(
            limits,
            "max",
            finite(engineering, "max", finite(props, "max", 100.0)),
        )
    } else {
        finite(props, "max", 100.0)
    };
    let suffix = text(props, "suffix", "");
    let unit = if value["type"] == "gauge" {
        if text(props, "unitMode", "inherit") == "inherit" {
            text(engineering, "unit", suffix)
        } else {
            suffix
        }
    } else if !suffix.is_empty() {
        suffix
    } else {
        text(engineering, "unit", "")
    };
    // Numeric calculations stay out of f32 screen space until normalized.
    let max = if max > min && (max - min).is_finite() {
        max
    } else {
        min + 1.0
    };
    if max <= min {
        (0.0, 1.0, unit.to_owned())
    } else {
        (min, max, unit.to_owned())
    }
}

fn angle(ratio: f64) -> f32 {
    (finite(&REFERENCE["gauge"], "startAngle", 150.0)
        + ratio * finite(&REFERENCE["gauge"], "sweepAngle", 240.0)) as f32
}

fn point(center: Pos2, radius: f32, degrees: f32) -> Pos2 {
    let a = degrees.to_radians();
    center + Vec2::new(a.cos(), a.sin()) * radius
}

fn ticks(min: f64, max: f64, count: usize) -> Vec<(f32, String)> {
    let step = (max - min) / count as f64;
    let decimals = if step.fract().abs() < 1e-10 { 0 } else { 2 };
    (0..=count)
        .map(|i| {
            let ratio = i as f64 / count as f64;
            let n = min + (max - min) * ratio;
            let n = if n.abs() < 1e-10 { 0.0 } else { n };
            let label = format!("{n:.decimals$}");
            let label = if decimals > 0 {
                label.trim_end_matches('0').trim_end_matches('.').to_owned()
            } else {
                label
            };
            (angle(ratio), label)
        })
        .collect()
}

fn zones(props: &Value, min: f64, max: f64) -> (f64, f64) {
    // Production resolveGaugeZones falls back both boundaries together.
    let low = props["lowZoneEnd"].as_f64();
    let high = props["highZoneStart"].as_f64();
    if let (Some(low), Some(high)) = (low, high)
        && low.is_finite()
        && high.is_finite()
        && low >= min
        && high <= max
        && low <= high
    {
        ((low - min) / (max - min), (high - min) / (max - min))
    } else {
        (0.3, 0.7)
    }
}

struct Preview {
    p: egui::Painter,
    rect: Rect,
    zoom: f32,
}

impl Preview {
    fn at(&self, x: f32, y: f32) -> Pos2 {
        self.rect.min + self.rect.size() * Vec2::new(x, y)
    }

    fn text(&self, at: Pos2, anchor: Align2, value: &str, size: f32, tint: Color32) {
        self.p.text(
            at,
            anchor,
            value,
            FontId::proportional((size * self.zoom).max(3.0)),
            tint,
        );
    }

    fn panel(&self, fill: Color32, edge: Color32, radius: f32) {
        self.p.rect_filled(
            self.rect.translate(Vec2::splat(2.0 * self.zoom)),
            radius * self.zoom,
            Color32::from_rgb(5, 8, 9),
        );
        self.p.rect(
            self.rect,
            radius * self.zoom,
            fill,
            Stroke::new(self.zoom.max(0.5), edge),
            StrokeKind::Inside,
        );
        // Subtle 4px production matte texture, without colored card wrappers.
        let step = (4.0 * self.zoom).max(3.0);
        let mut y = self.rect.top() + step;
        while y < self.rect.bottom() - step {
            let mut x = self.rect.left() + step;
            while x < self.rect.right() - step {
                self.p.circle_filled(
                    Pos2::new(x, y),
                    0.4 * self.zoom,
                    Color32::from_white_alpha(12),
                );
                x += step;
            }
            y += step;
        }
    }

    fn arc(&self, center: Pos2, radius: f32, from: f64, to: f64, width: f32, tint: Color32) {
        if to <= from {
            return;
        }
        let points = (0..=80)
            .map(|i| point(center, radius, angle(from + (to - from) * i as f64 / 80.0)))
            .collect();
        self.p
            .add(egui::Shape::line(points, Stroke::new(width, tint)));
    }

    fn gauge(&self, props: &Value, label: &str, state: &str, range: (f64, f64, String)) {
        // Same 200 x 200 viewBox and 150° + 240° arc as GaugeComponent.
        let s = self.rect.width().min(self.rect.height()) / 200.0;
        let center = self.rect.center();
        let at = |x: f32, y: f32| center + Vec2::new(x - 100.0, y - 100.0) * s;
        self.p
            .circle_filled(center, 96.0 * s, Color32::from_black_alpha(153));
        self.p.circle(
            center,
            93.0 * s,
            Color32::from_rgb(19, 29, 32),
            Stroke::new(2.0 * s, skin("matte-line")),
        );
        let (min, max, unit) = range;
        let (low, high) = zones(props, min, max);
        self.arc(
            center,
            78.0 * s,
            0.0,
            1.0,
            13.0 * s,
            Color32::from_rgb(41, 56, 61),
        );
        for (from, to, key) in [
            (0.0, low, "lowColor"),
            (low, high, "normalColor"),
            (high, 1.0, "highColor"),
        ] {
            self.arc(
                center,
                78.0 * s,
                from,
                to,
                11.0 * s,
                style::color(props, "gauge", key),
            );
        }
        let count = props["tickCount"].as_u64().unwrap_or(10).clamp(4, 12) as usize;
        for (a, label) in ticks(min, max, count) {
            self.p.line_segment(
                [point(center, 70.0 * s, a), point(center, 84.0 * s, a)],
                Stroke::new(1.2 * s, Color32::from_rgb(125, 143, 151)),
            );
            self.p.text(
                point(center, 59.0 * s, a),
                Align2::CENTER_CENTER,
                label,
                FontId::proportional(7.0 * s),
                INK,
            );
        }
        let caption = |x, y, text: &str, size| {
            self.p.text(
                at(x, y),
                Align2::CENTER_CENTER,
                text,
                FontId::proportional(size * s),
                INK,
            );
        };
        caption(100.0, 81.0, label, 10.0);
        // Missing data leaves the needle at minimum with the original .35 opacity.
        self.p.line_segment(
            [
                point(center, -6.0 * s, angle(0.0)),
                point(center, 63.0 * s, angle(0.0)),
            ],
            Stroke::new(
                5.0 * s,
                style::color(props, "gauge", "needleColor").gamma_multiply(0.35),
            ),
        );
        self.p.circle(
            center,
            8.0 * s,
            Color32::from_rgb(170, 182, 185),
            Stroke::new(1.5 * s, Color32::from_rgb(86, 102, 108)),
        );
        self.p
            .circle_filled(center, 4.5 * s, Color32::from_rgb(126, 141, 146));
        caption(100.0, 132.0, &unit, 10.0);
        if props["showDigital"] != false {
            self.p.rect(
                Rect::from_min_size(at(67.0, 143.0), Vec2::new(66.0, 24.0) * s),
                4.0 * s,
                skin("matte"),
                Stroke::new(s, skin("matte-line")),
                StrokeKind::Inside,
            );
            self.p.text(
                at(100.0, 155.0),
                Align2::CENTER_CENTER,
                text(props, "fallback", "--"),
                FontId::monospace(11.0 * s),
                INK,
            );
        }
        caption(100.0, 181.0, state, 6.0);
    }
}

// Native adaptation of RuntimeCanvas.jsx and its mode-iot-dashboard CSS skin.
// Passive editor surfaces: no telemetry, audio, RPC or runtime menus.
pub fn component(ui: &egui::Ui, rect: Rect, value: &Value, zoom: f32, schema: &Value) {
    let v = Preview {
        p: ui.painter().with_clip_rect(rect.intersect(ui.clip_rect())),
        rect,
        zoom,
    };
    let props = &value["properties"];
    let kind = text(value, "type", "");
    let label = text(props, "label", text(value, "name", "Widget"));
    let bound = tag(schema, text(&value["binding"], "tagId", ""));
    let state = if bound.is_some() {
        "MISSING"
    } else {
        "UNBOUND"
    };
    let muted = skin("matte-muted");
    match kind {
        "text-label" => {
            if props["transparentBackground"] == false {
                v.p.rect_filled(rect, 0, style::color(props, kind, "backgroundColor"));
            }
            let inner = rect.shrink2(rect.size() * 0.03);
            let align = match text(props, "textAlign", "left") {
                "center" => egui::Align::Center,
                "right" => egui::Align::Max,
                _ => egui::Align::Min,
            };
            let family = if text(props, "fontFamily", "sans-serif").contains("mono") {
                egui::FontFamily::Monospace
            } else {
                egui::FontFamily::Proportional
            };
            let mut format = egui::TextFormat::simple(
                FontId::new(
                    number(props, "fontSize", 32.0).clamp(6.0, 300.0) * zoom,
                    family,
                ),
                style::color(props, kind, "textColor"),
            );
            format.italics = text(props, "fontStyle", "normal") == "italic";
            let mut job = egui::text::LayoutJob::single_section(
                text(props, "text", "Text").to_owned(),
                format,
            );
            job.wrap.max_width = inner.width();
            job.halign = align;
            let galley = v.p.layout_job(job);
            let y = match text(props, "verticalAlign", "middle") {
                "top" => inner.top(),
                "bottom" => inner.bottom() - galley.size().y,
                _ => inner.center().y - galley.size().y / 2.0,
            };
            let x = match align {
                egui::Align::Center => inner.center().x,
                egui::Align::Max => inner.right(),
                _ => inner.left(),
            };
            v.p.galley(Pos2::new(x, y), galley, INK);
        }
        "gauge" => v.gauge(props, label, state, range_and_unit(value, schema)),
        "indicator-lamp" => {
            let size = (rect.width() * 0.52).min(rect.height() * 0.60);
            let lens = Rect::from_center_size(v.at(0.5, 0.36), Vec2::splat(size));
            let radius = match text(props, "shape", "circle") {
                "square" => size * 0.2,
                "rectangle" => size * 0.08,
                _ => size * 0.5,
            };
            v.p.rect(
                lens,
                radius,
                style::mix(skin("matte"), style::color(props, kind, "offColor"), 0.76),
                Stroke::new(2.0 * zoom, Color32::from_rgb(17, 25, 28)),
                StrokeKind::Inside,
            );
            v.p.rect_stroke(
                lens.shrink(2.0 * zoom),
                radius,
                Stroke::new(zoom, Color32::from_white_alpha(20)),
                StrokeKind::Inside,
            );
            v.text(v.at(0.5, 0.77), Align2::CENTER_CENTER, label, 12.0, INK);
            v.text(v.at(0.5, 0.92), Align2::CENTER_CENTER, state, 9.0, muted);
        }
        "value-span" => {
            v.panel(
                style::color(props, kind, "backgroundColor"),
                skin("matte-line"),
                5.0,
            );
            v.text(v.at(0.5, 0.23), Align2::CENTER_CENTER, label, 11.0, muted);
            // Production formatRuntimeValue returns fallback alone for missing data.
            v.p.text(
                v.at(0.5, 0.52),
                Align2::CENTER_CENTER,
                text(props, "fallback", "--"),
                FontId::monospace((rect.width() / zoom * 0.12).clamp(10.0, 28.0) * zoom),
                style::color(props, kind, "textColor"),
            );
            v.text(v.at(0.5, 0.82), Align2::CENTER_CENTER, state, 9.0, muted);
        }
        "alarm" => {
            let area = Rect::from_min_max(v.at(0.28, 0.08), v.at(0.72, 0.65));
            let idle = style::color(props, kind, "idleColor");
            if text(props, "presentation", "lamp") == "buzzer" {
                let at = |x: f32, y: f32| area.min + area.size() * Vec2::new(x / 100.0, y / 80.0);
                v.p.add(egui::Shape::convex_polygon(
                    vec![
                        at(33.0, 31.0),
                        at(55.0, 13.0),
                        at(55.0, 67.0),
                        at(33.0, 49.0),
                    ],
                    idle,
                    Stroke::NONE,
                ));
                v.p.rect_filled(Rect::from_min_max(at(15.0, 31.0), at(33.0, 49.0)), 0, idle);
                for (x, top, bottom, bulge) in [(64.0, 29.0, 51.0, 6.0), (73.0, 19.0, 61.0, 11.0)] {
                    let points = (0..=24)
                        .map(|i| {
                            let t = i as f32 / 24.0;
                            at(
                                x + (t * std::f32::consts::PI).sin() * bulge,
                                top + (bottom - top) * t,
                            )
                        })
                        .collect();
                    v.p.add(egui::Shape::line(points, Stroke::new(3.0 * zoom, idle)));
                }
            } else {
                let part = |x: f32, y: f32, w: f32, h: f32| {
                    Rect::from_min_size(
                        area.min + area.size() * Vec2::new(x, y),
                        area.size() * Vec2::new(w, h),
                    )
                };
                v.p.rect_filled(
                    part(0.36, 0.01, 0.28, 0.09),
                    3.0 * zoom,
                    Color32::from_rgb(70, 85, 90),
                );
                let lens = part(0.11, 0.08, 0.78, 0.70);
                v.p.rect(
                    lens,
                    egui::CornerRadius {
                        nw: (area.width() * 0.35) as u8,
                        ne: (area.width() * 0.35) as u8,
                        sw: (area.width() * 0.10) as u8,
                        se: (area.width() * 0.10) as u8,
                    },
                    style::mix(Color32::from_rgb(20, 28, 31), idle, 0.78),
                    Stroke::new(zoom, Color32::from_rgb(32, 41, 46)),
                    StrokeKind::Inside,
                );
                v.p.rect_filled(
                    part(0.04, 0.74, 0.92, 0.22),
                    4.0 * zoom,
                    Color32::from_rgb(70, 85, 90),
                );
            }
            v.text(v.at(0.5, 0.77), Align2::CENTER_CENTER, label, 11.0, muted);
            v.text(v.at(0.5, 0.90), Align2::CENTER_CENTER, state, 12.0, muted);
        }
        "chart" | "control-popup" | "operation-shifter" | "control-button" => {
            if kind == "control-button" {
                let tint = style::mix(
                    style::color(props, kind, "buttonColor"),
                    Color32::from_gray(128),
                    0.55,
                );
                v.panel(
                    style::mix(Color32::from_rgb(21, 29, 32), tint, 0.48),
                    style::mix(skin("matte"), tint, 0.38),
                    4.0,
                );
            } else {
                v.panel(skin("matte-raised"), skin("matte-line"), 5.0);
            }
            if kind == "chart" {
                v.text(rect.center(), Align2::CENTER_CENTER, "CHART", 14.0, INK);
            } else if kind == "operation-shifter" {
                v.text(v.at(0.07, 0.32), Align2::LEFT_CENTER, label, 12.0, INK);
                v.text(
                    v.at(0.07, 0.72),
                    Align2::LEFT_CENTER,
                    "OFFLINE",
                    10.0,
                    muted,
                );
            } else {
                v.text(
                    v.at(0.5, 0.37),
                    Align2::CENTER_CENTER,
                    if kind == "control-popup" {
                        text(props, "triggerLabel", label)
                    } else {
                        label
                    },
                    13.0,
                    INK,
                );
                let status = if kind == "control-popup" {
                    format!(
                        "{} CONTROLS",
                        value["children"].as_array().map(Vec::len).unwrap_or(0)
                    )
                } else {
                    "OFFLINE".to_owned()
                };
                v.text(v.at(0.5, 0.73), Align2::CENTER_CENTER, &status, 9.0, muted);
            }
        }
        "tuning-slider" => {
            v.panel(skin("matte"), skin("matte-line"), 5.0);
            let (min, max, unit) = range_and_unit(value, schema);
            v.text(v.at(0.06, 0.16), Align2::LEFT_CENTER, label, 11.0, INK);
            v.text(
                v.at(0.06, 0.32),
                Align2::LEFT_CENTER,
                bound
                    .map(|t| text(t, "name", "UNBOUND"))
                    .unwrap_or("UNBOUND"),
                9.0,
                muted,
            );
            // Draft starts at minimum as in TuningSlider; it is not live data.
            let decimals = props["decimals"].as_u64().unwrap_or(0).min(8) as usize;
            v.text(
                v.at(0.94, 0.22),
                Align2::RIGHT_CENTER,
                &format!("{min:.decimals$}{unit}"),
                16.0,
                INK,
            );
            v.p.line_segment(
                [v.at(0.09, 0.55), v.at(0.91, 0.55)],
                Stroke::new(8.0 * zoom, Color32::from_rgb(38, 51, 55)),
            );
            v.p.circle(
                v.at(0.09, 0.55),
                10.0 * zoom,
                style::mix(
                    skin("matte"),
                    style::color(props, kind, "accentColor"),
                    0.28,
                ),
                Stroke::new(2.0 * zoom, Color32::from_rgb(17, 25, 28)),
            );
            v.text(
                v.at(0.06, 0.85),
                Align2::LEFT_CENTER,
                &format!("{min:.decimals$}"),
                9.0,
                muted,
            );
            v.text(
                v.at(0.42, 0.85),
                Align2::CENTER_CENTER,
                &format!("LIVE --{unit}"),
                9.0,
                muted,
            );
            v.text(
                v.at(0.70, 0.85),
                Align2::RIGHT_CENTER,
                &format!("{max:.decimals$}"),
                9.0,
                muted,
            );
            let button = Rect::from_min_max(v.at(0.75, 0.73), v.at(0.95, 0.95));
            v.p.rect(
                button,
                3.0 * zoom,
                skin("matte-raised"),
                Stroke::new(zoom, skin("matte-line")),
                StrokeKind::Inside,
            );
            v.text(
                button.center(),
                Align2::CENTER_CENTER,
                "OFFLINE",
                8.0,
                muted,
            );
        }
        _ => (),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inherited_preview_range_uses_tag_configuration_without_reading_measurements() {
        let doc = crate::document::Document::iot_demo();
        let value = doc
            .components()
            .iter()
            .find(|v| v["type"] == "gauge")
            .unwrap();
        assert_eq!(
            range_and_unit(value, doc.schema()),
            (0.0, 100.0, "%".to_owned())
        );
        let mut custom = value.clone();
        custom["properties"]["unitMode"] = serde_json::json!("custom");
        custom["properties"]["suffix"] = serde_json::json!("");
        assert_eq!(range_and_unit(&custom, doc.schema()).2, "");
        let target = doc
            .components()
            .iter()
            .find(|v| v["type"] == "tuning-slider")
            .unwrap();
        assert_eq!(
            range_and_unit(target, doc.schema()),
            (16.0, 32.0, "°C".to_owned())
        );
    }

    #[test]
    fn gauge_ticks_match_production_javascript_fixtures() {
        for fixture in REFERENCE["gaugeFixtures"].as_array().unwrap() {
            let props = &fixture["properties"];
            let actual = ticks(
                finite(props, "min", 0.0),
                finite(props, "max", 100.0),
                props["tickCount"].as_u64().unwrap() as usize,
            );
            let expected = fixture["ticks"].as_array().unwrap();
            assert_eq!(actual.len(), expected.len());
            for ((angle, label), expected) in actual.iter().zip(expected) {
                assert!((*angle as f64 - expected["angle"].as_f64().unwrap()).abs() < 0.0001);
                assert_eq!(label, expected["label"].as_str().unwrap());
            }
        }
        assert_eq!(angle(0.0), 150.0);
        assert_eq!(angle(1.0), 390.0);
        assert_eq!(
            zones(
                &serde_json::json!({"lowZoneEnd":30,"highZoneStart":70}),
                16.0,
                32.0
            ),
            (0.3, 0.7)
        );
        assert_eq!(
            zones(
                &serde_json::json!({"lowZoneEnd":25,"highZoneStart":75}),
                0.0,
                100.0
            ),
            (0.25, 0.75)
        );
    }
}
