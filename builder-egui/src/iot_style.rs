use crate::{document::text, paint};
use eframe::egui::Color32;
use serde_json::Value;
use std::sync::LazyLock;

static DEFAULTS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/iot-style-defaults.json"))
        .expect("IoT color defaults")
});

pub fn defaults(kind: &str) -> &'static Value {
    &DEFAULTS[kind]
}

pub fn color(props: &Value, kind: &str, key: &str) -> Color32 {
    let fallback = if key == "backgroundColor" || key == "faceColor" {
        Color32::from_rgb(34, 36, 40)
    } else {
        Color32::from_rgb(222, 224, 229)
    };
    paint::color(text(props, key, text(defaults(kind), key, "")), fallback)
}

pub fn mix(base: Color32, accent: Color32, amount: f32) -> Color32 {
    let channel = |a: u8, b: u8| (a as f32 * (1.0 - amount) + b as f32 * amount).round() as u8;
    Color32::from_rgb(
        channel(base.r(), accent.r()),
        channel(base.g(), accent.g()),
        channel(base.b(), accent.b()),
    )
}

pub fn series_color(props: &Value, index: usize) -> Color32 {
    let palette = &defaults("chart")["seriesColors"];
    let fallback = palette
        .as_array()
        .and_then(|v| v.get(index % v.len()))
        .and_then(Value::as_str)
        .unwrap_or("#60a5fa");
    paint::color(
        props["seriesColors"][index].as_str().unwrap_or(fallback),
        Color32::from_rgb(96, 165, 250),
    )
}

pub fn field_label(key: &str) -> &str {
    match key {
        "backgroundColor" => "Background",
        "faceColor" => "Gauge background",
        "textColor" => "Text",
        "accentColor" => "Accent",
        "buttonColor" => "Button",
        "onColor" => "On / accent",
        "offColor" => "Off / unknown",
        "alarmColor" => "Alarm",
        "activeColor" => "Alarm accent",
        "idleColor" => "Idle",
        "lowColor" => "Low zone",
        "normalColor" => "Normal zone",
        "highColor" => "High zone",
        "needleColor" => "Needle",
        "manualColor" => "Manual",
        "autoColor" => "Auto",
        "resetColor" => "Reset",
        _ => key,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn imported_colors_are_honored_without_filling_in_missing_properties() {
        let props = json!({"buttonColor":"#f6b73c"});
        let before = props.clone();
        assert_eq!(
            color(&props, "control-button", "buttonColor"),
            Color32::from_rgb(246, 183, 60)
        );
        assert_eq!(props, before);
        let explicit = json!({"accentColor":"#e879f9","backgroundColor":"#123456","textColor":"#aabbcc","seriesColors":["#ff8800"]});
        assert_eq!(
            color(&explicit, "chart", "accentColor"),
            Color32::from_rgb(232, 121, 249)
        );
        assert_eq!(
            color(&explicit, "chart", "backgroundColor"),
            Color32::from_rgb(18, 52, 86)
        );
        assert_eq!(series_color(&explicit, 0), Color32::from_rgb(255, 136, 0));
        assert_ne!(series_color(&explicit, 1), series_color(&explicit, 0));
    }

    #[test]
    fn all_iot_palette_types_have_valid_color_defaults() {
        let catalog = crate::document::catalog();
        let mut count = 0;
        for (kind, definition) in catalog {
            if definition.library == Some(false)
                || definition
                    .project_types
                    .as_ref()
                    .is_some_and(|p| !p.iter().any(|v| v == "iot-dashboard"))
            {
                continue;
            }
            count += 1;
            let fields = defaults(&kind)
                .as_object()
                .expect("IoT appearance defaults");
            for (key, value) in fields {
                if key != "seriesColors" {
                    assert_eq!(value, &definition.default_properties[key], "{kind}.{key}");
                }
                let valid = |s: &str| {
                    s.len() == 7
                        && s.starts_with('#')
                        && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
                };
                if let Some(s) = value.as_str() {
                    assert!(valid(s));
                } else {
                    let colors = value.as_array().unwrap();
                    assert!(!colors.is_empty());
                    assert!(colors.iter().all(|v| v.as_str().is_some_and(valid)));
                }
            }
        }
        assert_eq!(count, 10);
    }
}
