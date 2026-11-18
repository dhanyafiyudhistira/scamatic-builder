use crate::document::{number, text};
use eframe::egui::{self, Align2, Color32, FontId, Pos2, Rect, Stroke, StrokeKind, Vec2};
use serde_json::Value;
mod iot;
pub use iot::component as iot_component;

pub const ACCENT: Color32 = Color32::from_rgb(218, 220, 224);
pub const MUTED: Color32 = Color32::from_rgb(155, 158, 164);
const INK: Color32 = Color32::from_rgb(222, 224, 229);

pub fn color(value: &str, fallback: Color32) -> Color32 {
    let hex = value.trim_start_matches('#');
    if hex.len() == 6
        && let Ok(rgb) = u32::from_str_radix(hex, 16)
    {
        return Color32::from_rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8);
    }
    fallback
}

// Designer previews deliberately show no live telemetry or enabled controls.
pub fn component(ui: &egui::Ui, rect: Rect, value: &Value, zoom: f32) {
    let painter = ui.painter().with_clip_rect(rect.intersect(ui.clip_rect()));
    let props = &value["properties"];
    let kind = text(value, "type", "unknown");
    let label = text(props, "label", text(value, "name", kind));
    let caption = |at: Pos2, anchor: Align2, content: &str, size: f32, tint: Color32| {
        painter.text(
            at,
            anchor,
            content,
            FontId::proportional((size * zoom).max(7.0)),
            tint,
        );
    };
    let body = Rect::from_min_max(
        rect.min + Vec2::splat(5.0 * zoom),
        rect.max - Vec2::new(5.0, 28.0) * zoom,
    );
    let mid = body.center();
    let radius = (body.width().min(body.height()) * 0.35).max(2.0);
    let stroke = Stroke::new((2.0 * zoom).max(1.0), MUTED);
    if kind == "text-label" {
        caption(
            rect.left_center(),
            Align2::LEFT_CENTER,
            text(props, "text", "Text"),
            number(props, "fontSize", 24.0),
            color(text(props, "textColor", ""), INK),
        );
        return;
    }
    match kind {
        "indicator-lamp" => {
            painter.circle_filled(
                mid,
                radius,
                color(text(props, "offColor", ""), MUTED).gamma_multiply(0.5),
            );
            painter.circle_stroke(mid, radius, stroke);
        }
        "pump" | "motor" | "fan" => {
            painter.circle_filled(mid, radius, Color32::from_rgb(42, 44, 48));
            painter.circle_stroke(mid, radius, stroke);
            if kind == "pump" {
                painter.add(egui::Shape::convex_polygon(
                    vec![
                        mid + Vec2::new(-0.4, -0.6) * radius,
                        mid + Vec2::new(0.7, 0.0) * radius,
                        mid + Vec2::new(-0.4, 0.6) * radius,
                    ],
                    MUTED,
                    Stroke::NONE,
                ));
                painter.line_segment(
                    [
                        mid + Vec2::new(radius, 0.0),
                        mid + Vec2::new(radius * 1.6, 0.0),
                    ],
                    stroke,
                );
            } else {
                caption(
                    mid,
                    Align2::CENTER_CENTER,
                    if kind == "motor" { "M" } else { "F" },
                    29.0,
                    INK,
                );
            }
        }
        "valve" => {
            let half = Vec2::new(body.width() * 0.34, body.height() * 0.30);
            painter.add(egui::Shape::convex_polygon(
                vec![mid - half, mid, mid + Vec2::new(-half.x, half.y)],
                Color32::from_rgb(42, 44, 48),
                stroke,
            ));
            painter.add(egui::Shape::convex_polygon(
                vec![mid + Vec2::new(half.x, -half.y), mid, mid + half],
                Color32::from_rgb(42, 44, 48),
                stroke,
            ));
            painter.line_segment([mid, mid - Vec2::new(0.0, half.y * 1.5)], stroke);
        }
        "pipe" => {
            painter.line_segment(
                [body.left_center(), body.right_center()],
                Stroke::new(9.0 * zoom, MUTED),
            );
        }
        "gauge" => {
            painter.circle_stroke(
                mid,
                radius,
                Stroke::new(7.0 * zoom, Color32::from_rgb(50, 52, 56)),
            );
            caption(mid, Align2::CENTER_CENTER, "—", 33.0, INK);
            caption(
                mid + Vec2::new(0.0, radius * 0.65),
                Align2::CENTER_CENTER,
                "NO LIVE DATA",
                9.0,
                MUTED,
            );
        }
        "value-span" => {
            painter.rect_filled(body, 5, Color32::from_rgb(35, 37, 40));
            caption(mid, Align2::CENTER_CENTER, "—", 30.0, INK);
        }
        _ => {
            painter.rect_filled(body, 5, Color32::from_rgb(35, 37, 40));
            painter.rect_stroke(
                body,
                5,
                Stroke::new(1.0, Color32::from_rgb(63, 65, 69)),
                StrokeKind::Inside,
            );
            caption(mid, Align2::CENTER_CENTER, kind, 12.0, MUTED);
        }
    }
    caption(
        rect.center_bottom() - Vec2::new(0.0, 9.0 * zoom),
        Align2::CENTER_CENTER,
        label,
        12.0,
        INK,
    );
}
