use crate::{
    document::{Position, number, text},
    paint,
};
use eframe::egui::{self, Color32, FontId, Pos2, Rect, Stroke, StrokeKind, Vec2};
use serde_json::{Value, json};

mod geometry;

pub const MAX_OBJECTS: usize = 2000;
pub const MAX_STROKE_POINTS: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Line,
    Arrow,
    Rectangle,
    RoundedRectangle,
    Ellipse,
    Text,
    Pencil,
    Curve,
    DoubleArrow,
    Triangle,
    Diamond,
    Polygon,
    Star,
}

impl Kind {
    pub const ALL: [Self; 13] = [
        Self::Line,
        Self::Arrow,
        Self::Rectangle,
        Self::RoundedRectangle,
        Self::Ellipse,
        Self::Text,
        Self::Pencil,
        Self::Curve,
        Self::DoubleArrow,
        Self::Triangle,
        Self::Diamond,
        Self::Polygon,
        Self::Star,
    ];
    pub fn id(self) -> &'static str {
        match self {
            Self::Line => "markup-line",
            Self::Arrow => "markup-arrow",
            Self::Rectangle => "markup-rectangle",
            Self::RoundedRectangle => "markup-rounded",
            Self::Ellipse => "markup-ellipse",
            Self::Text => "markup-text",
            Self::Pencil => "markup-pencil",
            Self::Curve => "markup-curve",
            Self::DoubleArrow => "markup-double-arrow",
            Self::Triangle => "markup-triangle",
            Self::Diamond => "markup-diamond",
            Self::Polygon => "markup-polygon",
            Self::Star => "markup-star",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Line => "Line",
            Self::Arrow => "Arrow",
            Self::Rectangle => "Rectangle",
            Self::RoundedRectangle => "Rounded rectangle",
            Self::Ellipse => "Ellipse",
            Self::Text => "Annotation text",
            Self::Pencil => "Pencil / freehand",
            Self::Curve => "Curve",
            Self::DoubleArrow => "Double arrow",
            Self::Triangle => "Triangle",
            Self::Diamond => "Diamond",
            Self::Polygon => "Polygon",
            Self::Star => "Star",
        }
    }
    pub fn from_value(value: &Value) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| value["type"] == kind.id())
    }
    pub fn is_line(self) -> bool {
        matches!(self, Self::Line | Self::Arrow | Self::DoubleArrow)
    }
    pub fn supports_fill(self) -> bool {
        !self.is_line() && !matches!(self, Self::Pencil | Self::Curve | Self::Text)
    }
}

pub fn create(kind: Kind, start: [f32; 2], end: [f32; 2], z: i64) -> Value {
    let x = start[0].min(end[0]);
    let y = start[1].min(end[1]);
    let width = (end[0] - start[0]).abs().max(1.0);
    let height = (end[1] - start[1]).abs().max(1.0);
    let normalized = |point: [f32; 2]| json!([(point[0] - x) / width, (point[1] - y) / height]);
    let mut value = json!({
        "id": format!("markup-{}", uuid::Uuid::new_v4()), "type": kind.id(),
        "name": format!("{} {}", kind.label(), z), "visible": true, "locked": false, "zIndex": z,
        "position": {"x": x, "y": y, "width": width, "height": height, "rotation": 0},
        "properties": {"strokeColor": "#c9ccd2", "strokeWidth": 2.0, "fillColor": "#35383e", "filled": false,
            "opacity": 1.0, "cornerRadius": 12.0, "text": "Annotation", "fontSize": 24.0,
            "start": normalized(start), "end": normalized(end)}
    });
    match kind {
        Kind::Pencil => value["properties"]["points"] = json!([normalized(start), normalized(end)]),
        Kind::Curve => value["properties"]["bend"] = json!(1.0),
        Kind::Polygon => value["properties"]["sides"] = json!(6),
        Kind::Star => {
            value["properties"]["tips"] = json!(5);
            value["properties"]["innerRatio"] = json!(0.45);
        }
        _ => (),
    }
    value
}

pub fn freehand(points: &[Pos2]) -> Option<Value> {
    if !(2..=MAX_STROKE_POINTS).contains(&points.len())
        || points.iter().any(|p| !p.x.is_finite() || !p.y.is_finite())
    {
        return None;
    }
    let bounds = Rect::from_points(points);
    let mut value = create(
        Kind::Pencil,
        [bounds.min.x, bounds.min.y],
        [bounds.max.x, bounds.max.y],
        0,
    );
    let size = bounds.size().max(Vec2::splat(1.0));
    value["properties"]["points"] = json!(
        points
            .iter()
            .map(|p| [(p.x - bounds.min.x) / size.x, (p.y - bounds.min.y) / size.y])
            .collect::<Vec<_>>()
    );
    Some(value)
}

pub fn sample_freehand(points: &mut Vec<Pos2>, point: Pos2) {
    if points
        .last()
        .is_some_and(|last| last.distance(point) < 1.25)
    {
        return;
    }
    if points.len() >= MAX_STROKE_POINTS {
        let mut index = 0;
        points.retain(|_| {
            let keep = index % 2 == 0;
            index += 1;
            keep
        });
    }
    points.push(point);
}

pub fn valid(value: &Value) -> bool {
    let props = &value["properties"];
    let bounded = |key: &str, min: f64, max: f64| {
        props[key]
            .as_f64()
            .is_some_and(|v| v.is_finite() && (min..=max).contains(&v))
    };
    let color = |key: &str| {
        props[key].as_str().is_some_and(|s| {
            s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
        })
    };
    let Some(kind) = Kind::from_value(value) else {
        return false;
    };
    let normalized_point = |p: &Value| {
        p.as_array().is_some_and(|p| {
            p.len() == 2
                && p.iter().all(|v| {
                    v.as_f64()
                        .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
                })
        })
    };
    let integer = |key: &str| props[key].as_u64().is_some_and(|n| (3..=12).contains(&n));
    let geometry_valid = match kind {
        Kind::Pencil => props["points"].as_array().is_some_and(|p| {
            (2..=MAX_STROKE_POINTS).contains(&p.len()) && p.iter().all(normalized_point)
        }),
        Kind::Curve => bounded("bend", 0.0, 1.0),
        Kind::Polygon => integer("sides"),
        Kind::Star => integer("tips") && bounded("innerRatio", 0.15, 0.85),
        _ => true,
    };
    geometry_valid
        && value["visible"].is_boolean()
        && value["locked"].is_boolean()
        && value["zIndex"].as_i64().is_some()
        && props["filled"].is_boolean()
        && color("strokeColor")
        && color("fillColor")
        && bounded("strokeWidth", 0.5, 32.0)
        && bounded("opacity", 0.0, 1.0)
        && bounded("cornerRadius", 0.0, 200.0)
        && bounded("fontSize", 8.0, 160.0)
        && props["text"].as_str().is_some_and(|s| s.len() <= 8192)
        && ["start", "end"].iter().all(|key| {
            props[*key].as_array().is_some_and(|p| {
                p.len() == 2
                    && p.iter().all(|v| {
                        v.as_f64()
                            .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
                    })
            })
        })
}

pub fn bounds(value: &Value, canvas: Rect, zoom: f32) -> Rect {
    let p = Position::read(value);
    Rect::from_min_size(
        canvas.min + Vec2::new(p.x, p.y) * zoom,
        Vec2::new(p.width, p.height) * zoom,
    )
}

fn endpoints(value: &Value, rect: Rect) -> [Pos2; 2] {
    ["start", "end"].map(|key| {
        let p = &value["properties"][key];
        rect.min
            + rect.size()
                * Vec2::new(
                    p[0].as_f64().unwrap_or(0.0) as f32,
                    p[1].as_f64().unwrap_or(1.0) as f32,
                )
    })
}

fn arrow_head(start: Pos2, end: Pos2, zoom: f32) -> [Pos2; 3] {
    let delta = end - start;
    let direction = delta.normalized();
    let side = Vec2::new(-direction.y, direction.x);
    let length = (12.0 * zoom).min(delta.length() * 0.4);
    [
        end - direction * length + side * length * 0.45,
        end,
        end - direction * length - side * length * 0.45,
    ]
}

pub fn render(ui: &egui::Ui, canvas: Rect, value: &Value, zoom: f32) {
    if value["visible"] == false {
        return;
    }
    let Some(kind) = Kind::from_value(value) else {
        return;
    };
    let rect = bounds(value, canvas, zoom);
    let painter = ui
        .painter()
        .with_clip_rect(canvas.intersect(ui.clip_rect()));
    let props = &value["properties"];
    let opacity = number(props, "opacity", 1.0).clamp(0.0, 1.0);
    let stroke_color =
        paint::color(text(props, "strokeColor", ""), paint::ACCENT).gamma_multiply(opacity);
    let stroke = Stroke::new(number(props, "strokeWidth", 2.0) * zoom, stroke_color);
    let fill = if props["filled"] == true {
        paint::color(text(props, "fillColor", ""), Color32::TRANSPARENT).gamma_multiply(opacity)
    } else {
        Color32::TRANSPARENT
    };
    match kind {
        Kind::Line | Kind::Arrow | Kind::DoubleArrow => {
            let [start, end] = endpoints(value, rect);
            painter.line_segment([start, end], stroke);
            if kind != Kind::Line {
                painter.add(egui::Shape::line(
                    arrow_head(start, end, zoom).to_vec(),
                    stroke,
                ));
            }
            if kind == Kind::DoubleArrow {
                painter.add(egui::Shape::line(
                    arrow_head(end, start, zoom).to_vec(),
                    stroke,
                ));
            }
        }
        Kind::Rectangle | Kind::RoundedRectangle => {
            let radius = if kind == Kind::RoundedRectangle {
                number(props, "cornerRadius", 12.0) * zoom
            } else {
                0.0
            };
            painter.rect(
                rect,
                radius.min(rect.width().min(rect.height()) / 2.0),
                fill,
                stroke,
                StrokeKind::Inside,
            );
        }
        Kind::Ellipse => {
            painter.add(egui::Shape::ellipse_filled(
                rect.center(),
                rect.size() / 2.0,
                fill,
            ));
            painter.add(egui::Shape::ellipse_stroke(
                rect.center(),
                rect.size() / 2.0,
                stroke,
            ));
        }
        Kind::Text => {
            // Layout wraps and clips long annotations to their editable bounds.
            let galley = painter.layout(
                text(props, "text", "").to_owned(),
                FontId::proportional(number(props, "fontSize", 24.0) * zoom),
                stroke_color,
                rect.width(),
            );
            painter
                .with_clip_rect(rect.intersect(painter.clip_rect()))
                .galley(rect.min, galley, stroke_color);
        }
        Kind::Pencil
        | Kind::Curve
        | Kind::Triangle
        | Kind::Diamond
        | Kind::Polygon
        | Kind::Star => {
            let (points, closed) = geometry::outline(value);
            let points: Vec<_> = points
                .into_iter()
                .map(|p| rect.min + rect.size() * p.to_vec2())
                .collect();
            if closed {
                if fill != Color32::TRANSPARENT {
                    geometry::fill_polygon(&painter, &points, fill);
                }
                painter.add(egui::Shape::closed_line(points, stroke));
            } else {
                painter.add(egui::Shape::line(points, stroke));
            }
        }
    }
}

fn distance(point: Pos2, start: Pos2, end: Pos2) -> f32 {
    let delta = end - start;
    let t = if delta.length_sq() > 0.0 {
        ((point - start).dot(delta) / delta.length_sq()).clamp(0.0, 1.0)
    } else {
        0.0
    };
    point.distance(start + delta * t)
}

pub fn hit_test(value: &Value, canvas: Rect, zoom: f32, pointer: Pos2) -> bool {
    let Some(kind) = Kind::from_value(value) else {
        return false;
    };
    let rect = bounds(value, canvas, zoom);
    let tolerance = 5.0 + number(&value["properties"], "strokeWidth", 2.0) * zoom / 2.0;
    if !rect.expand(tolerance).contains(pointer) {
        return false;
    }
    if kind.is_line() {
        let [start, end] = endpoints(value, rect);
        if distance(pointer, start, end) <= tolerance {
            return true;
        }
        let [a, b, c] = arrow_head(start, end, zoom);
        if kind != Kind::Line
            && (distance(pointer, a, b) <= tolerance || distance(pointer, b, c) <= tolerance)
        {
            return true;
        }
        let [a, b, c] = arrow_head(end, start, zoom);
        return kind == Kind::DoubleArrow
            && (distance(pointer, a, b) <= tolerance || distance(pointer, b, c) <= tolerance);
    }
    if kind == Kind::Text {
        return rect.contains(pointer);
    }
    if matches!(
        kind,
        Kind::Pencil | Kind::Curve | Kind::Triangle | Kind::Diamond | Kind::Polygon | Kind::Star
    ) {
        let (points, closed) = geometry::outline(value);
        let mut points: Vec<_> = points
            .into_iter()
            .map(|p| rect.min + rect.size() * p.to_vec2())
            .collect();
        if closed && value["properties"]["filled"] == true && geometry::contains(&points, pointer) {
            return true;
        }
        if closed && let Some(first) = points.first().copied() {
            points.push(first);
        }
        return points
            .windows(2)
            .any(|edge| distance(pointer, edge[0], edge[1]) <= tolerance);
    }
    if kind == Kind::Ellipse {
        let radii = rect.size() / 2.0;
        let normalized = (pointer - rect.center()) / radii;
        if value["properties"]["filled"] == true {
            return normalized.length_sq() <= 1.0;
        }
        return (normalized.length() - 1.0).abs() * radii.x.min(radii.y) <= tolerance;
    }
    if value["properties"]["filled"] == true {
        return rect.contains(pointer);
    }
    // Hollow ornaments do not block selecting equipment inside them.
    rect.expand(tolerance).contains(pointer) && !rect.shrink(tolerance).contains(pointer)
}

pub fn drawn_points(start: Pos2, end: Pos2, canvas: [f32; 2], snap: bool) -> [[f32; 2]; 2] {
    [start, end].map(|point| {
        let quantize = |value: f32, max: f32| {
            (if snap {
                (value / 20.0).round() * 20.0
            } else {
                value
            })
            .clamp(0.0, max)
        };
        [quantize(point.x, canvas[0]), quantize(point.y, canvas[1])]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_polygon_and_path_styles_validate_and_hit_their_visible_shapes() {
        let canvas = Rect::from_min_size(Pos2::ZERO, Vec2::splat(500.0));
        for kind in Kind::ALL {
            let mut value = create(kind, [10.0, 10.0], [210.0, 210.0], 1);
            assert!(valid(&value), "{}", kind.label());
            if kind.supports_fill()
                && !matches!(
                    kind,
                    Kind::Rectangle | Kind::RoundedRectangle | Kind::Ellipse
                )
            {
                value["properties"]["filled"] = json!(true);
                assert!(hit_test(&value, canvas, 1.0, Pos2::new(110.0, 110.0)));
                assert!(!hit_test(&value, canvas, 1.0, Pos2::new(200.0, 20.0)));
            }
        }
        for (kind, key, value) in [
            (Kind::Polygon, "sides", json!(2.5)),
            (Kind::Star, "innerRatio", json!(0.01)),
            (Kind::Curve, "bend", json!(2)),
            (Kind::Pencil, "points", json!([[0, 0], [1, 2]])),
        ] {
            let mut object = create(kind, [10.0, 10.0], [210.0, 210.0], 1);
            object["properties"][key] = value;
            assert!(!valid(&object));
        }
    }

    #[test]
    fn freehand_is_bounded_resizable_and_does_not_select_empty_bounding_box_areas() {
        let points = [
            Pos2::new(100.0, 100.0),
            Pos2::new(120.0, 180.0),
            Pos2::new(200.0, 100.0),
        ];
        let value = freehand(&points).unwrap();
        assert!(valid(&value));
        for (actual, expected) in value["properties"]["points"]
            .as_array()
            .unwrap()
            .iter()
            .zip([[0.0, 0.0], [0.2, 1.0], [1.0, 0.0]])
        {
            for i in 0..2 {
                assert!((actual[i].as_f64().unwrap() - expected[i]).abs() < 1e-6);
            }
        }
        let canvas = Rect::from_min_size(Pos2::ZERO, Vec2::splat(500.0));
        assert!(hit_test(&value, canvas, 1.0, points[1]));
        assert!(!hit_test(&value, canvas, 1.0, Pos2::new(180.0, 170.0)));
        let mut samples = vec![Pos2::ZERO];
        for i in 1..5000 {
            sample_freehand(&mut samples, Pos2::new(i as f32 * 2.0, 20.0));
        }
        assert!(samples.len() <= MAX_STROKE_POINTS);
        assert_eq!(samples[0], Pos2::ZERO);
        assert_eq!(samples.last(), Some(&Pos2::new(9998.0, 20.0)));
    }

    #[test]
    fn reverse_arrow_keeps_its_direction_after_move_and_resize() {
        let mut value = create(Kind::Arrow, [300.0, 180.0], [100.0, 80.0], 1);
        assert!(valid(&value));
        let rect = Rect::from_min_size(Pos2::new(20.0, 30.0), Vec2::new(400.0, 200.0));
        let [start, end] = endpoints(&value, rect);
        assert_eq!(start, rect.max);
        assert_eq!(end, rect.min);
        value["properties"]["end"] = json!([2, 0]);
        assert!(!valid(&value));
    }
    #[test]
    fn thin_lines_and_hollow_shapes_have_precise_hit_targets() {
        let canvas = Rect::from_min_size(Pos2::ZERO, Vec2::splat(500.0));
        let line = create(Kind::Line, [10.0, 10.0], [200.0, 200.0], 1);
        assert!(hit_test(&line, canvas, 1.0, Pos2::new(100.0, 103.0)));
        assert!(!hit_test(&line, canvas, 1.0, Pos2::new(20.0, 180.0)));
        let shape = create(Kind::Rectangle, [10.0, 10.0], [200.0, 200.0], 2);
        assert!(!hit_test(&shape, canvas, 1.0, Pos2::new(100.0, 100.0)));
        assert!(hit_test(&shape, canvas, 1.0, Pos2::new(10.0, 100.0)));
    }
}
