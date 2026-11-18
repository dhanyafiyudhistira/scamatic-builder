use super::*;

pub(super) fn outline(value: &Value) -> (Vec<Pos2>, bool) {
    let props = &value["properties"];
    match Kind::from_value(value) {
        Some(Kind::Pencil) => (
            props["points"]
                .as_array()
                .map(|points| {
                    points
                        .iter()
                        .map(|p| {
                            Pos2::new(
                                p[0].as_f64().unwrap_or(0.0) as f32,
                                p[1].as_f64().unwrap_or(0.0) as f32,
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
            false,
        ),
        Some(Kind::Curve) => (
            (0..=48)
                .map(|i| {
                    let t = i as f32 / 48.0;
                    Pos2::new(t, 1.0 - 4.0 * number(props, "bend", 1.0) * t * (1.0 - t))
                })
                .collect(),
            false,
        ),
        Some(Kind::Triangle) => (polygon(3, None), true),
        Some(Kind::Diamond) => (polygon(4, None), true),
        Some(Kind::Polygon) => (
            polygon(
                props["sides"].as_u64().unwrap_or(6).clamp(3, 12) as usize,
                None,
            ),
            true,
        ),
        Some(Kind::Star) => (
            polygon(
                props["tips"].as_u64().unwrap_or(5).clamp(3, 12) as usize,
                Some(number(props, "innerRatio", 0.45)),
            ),
            true,
        ),
        _ => (vec![], false),
    }
}

fn polygon(sides: usize, inner: Option<f32>) -> Vec<Pos2> {
    let count = if inner.is_some() { sides * 2 } else { sides };
    (0..count)
        .map(|i| {
            let angle =
                std::f32::consts::TAU * i as f32 / count as f32 - std::f32::consts::FRAC_PI_2;
            let radius = if i % 2 == 1 {
                inner.unwrap_or(1.0)
            } else {
                1.0
            } * 0.5;
            Pos2::new(0.5 + radius * angle.cos(), 0.5 + radius * angle.sin())
        })
        .collect()
}

// All supported polygons are star-shaped around their center. A triangle fan
// fills concave stars without painting over their notches or adding inner strokes.
pub(super) fn fill_polygon(painter: &egui::Painter, points: &[Pos2], color: Color32) {
    if points.len() < 3 {
        return;
    }
    let center = Pos2::new(
        points.iter().map(|p| p.x).sum::<f32>() / points.len() as f32,
        points.iter().map(|p| p.y).sum::<f32>() / points.len() as f32,
    );
    let mut mesh = egui::Mesh::default();
    mesh.colored_vertex(center, color);
    for point in points {
        mesh.colored_vertex(*point, color);
    }
    for i in 0..points.len() {
        mesh.add_triangle(0, (i + 1) as u32, ((i + 1) % points.len() + 1) as u32);
    }
    painter.add(egui::Shape::mesh(mesh));
}

pub(super) fn contains(points: &[Pos2], pointer: Pos2) -> bool {
    let mut inside = false;
    for i in 0..points.len() {
        let a = points[i];
        let b = points[(i + 1) % points.len()];
        if (a.y > pointer.y) != (b.y > pointer.y)
            && pointer.x < (b.x - a.x) * (pointer.y - a.y) / (b.y - a.y) + a.x
        {
            inside = !inside;
        }
    }
    inside
}
