#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod document;
mod industrial;
mod iot_style;
mod markup;
mod paint;

use document::{Document, Position};
use std::path::{Path, PathBuf};

fn execute() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--add-markup") if args.len() == 8 => {
            let mut doc = Document::open(Path::new(&args[1]))?;
            let kind = markup::Kind::ALL
                .into_iter()
                .find(|k| k.id() == args[3])
                .ok_or("Unknown markup tool")?;
            let points: Vec<f32> = args[4..]
                .iter()
                .map(|s| s.parse().map_err(|_| "Invalid markup coordinate"))
                .collect::<Result<_, _>>()?;
            doc.add_markup(kind, [points[0], points[1]], [points[2], points[3]])?;
            doc.save_copy(Path::new(&args[2]))?;
            return Ok(());
        }
        Some("--validate") if args.len() == 2 => {
            Document::open(Path::new(&args[1]))?;
            println!("Project structure is valid. Full validation remains in the main Builder.");
            return Ok(());
        }
        Some("--roundtrip") if args.len() == 3 => {
            Document::open(Path::new(&args[1]))?.save_copy(Path::new(&args[2]))?;
            return Ok(());
        }
        Some("--transform") if args.len() == 6 || args.len() == 7 => {
            let mut doc = Document::open(Path::new(&args[1]))?;
            let object = doc
                .objects()
                .find(|(_, c)| c["id"].as_str() == Some(&args[3]))
                .map(|(r, _)| r)
                .ok_or("Object ID not found")?;
            let dx: f32 = args[4].parse().map_err(|_| "Invalid delta X")?;
            let dy: f32 = args[5].parse().map_err(|_| "Invalid delta Y")?;
            if !dx.is_finite() || !dy.is_finite() {
                return Err("Deltas must be finite".into());
            }
            let position = Position::read(doc.object(object));
            let resize = args.get(6).is_some_and(|s| s == "resize");
            let position = if matches!(object, document::ObjectRef::Markup(_)) {
                position.transformed_markup([dx, dy], resize, false, doc.canvas())
            } else {
                position.transformed([dx, dy], resize, false, doc.canvas())
            };
            doc.set_object_position(object, position);
            doc.save_copy(Path::new(&args[2]))?;
            return Ok(());
        }
        _ => (),
    }
    let markup_preview = args.first().is_some_and(|s| s == "--capture-markup");
    let iot_preview = args.first().is_some_and(|s| s == "--capture-iot");
    let capture = if args
        .first()
        .is_some_and(|s| s == "--capture" || s == "--capture-markup" || s == "--capture-iot")
        && (2..=3).contains(&args.len())
    {
        Some(PathBuf::from(&args[1]))
    } else {
        None
    };
    let mut doc = if iot_preview || args.is_empty() || args == ["--iot"] {
        Document::iot_demo()
    } else if capture.is_some() || args == ["--scada"] {
        Document::demo()
    } else if args.len() == 1 && !args[0].starts_with('-') {
        Document::open(Path::new(&args[0]))?
    } else {
        return Err("Usage: scamatic-egui-builder [project.json] | --iot | --scada | --validate input | --roundtrip input output | --transform input output id dx dy [resize] | --add-markup input output tool x1 y1 x2 y2 | --capture output.png [object-id] | --capture-iot output.png [object-id] | --capture-markup output.png".into());
    };
    if markup_preview {
        doc.add_markup(
            markup::Kind::RoundedRectangle,
            [55.0, 155.0],
            [760.0, 640.0],
        )?;
        doc.add_markup(markup::Kind::Arrow, [130.0, 170.0], [225.0, 255.0])?;
        doc.add_markup(markup::Kind::Text, [90.0, 115.0], [420.0, 150.0])?;
        let last = doc.markups().len() - 1;
        doc.root["markup"]["objects"][last]["properties"]["text"] =
            serde_json::json!("FEED SYSTEM / DESIGN NOTES");
        doc.root["markup"]["objects"][last]["properties"]["fontSize"] = serde_json::json!(18);
        doc.add_freehand(&[
            eframe::egui::pos2(95.0, 655.0),
            eframe::egui::pos2(150.0, 645.0),
            eframe::egui::pos2(205.0, 655.0),
            eframe::egui::pos2(260.0, 645.0),
        ])?;
        doc.add_markup(markup::Kind::Curve, [375.0, 585.0], [650.0, 630.0])?;
        doc.add_markup(markup::Kind::Star, [1020.0, 80.0], [1095.0, 155.0])?;
        let star = doc.markups().len() - 1;
        doc.root["markup"]["objects"][star]["properties"]["filled"] = serde_json::json!(true);
        let mut ready = Document::from_value(doc.root)?;
        ready.selected = ready
            .markups()
            .first()
            .and_then(|v| v["id"].as_str())
            .map(str::to_owned);
        doc = ready;
    }
    if capture.is_some()
        && let Some(id) = args.get(2)
    {
        if !doc
            .objects()
            .any(|(_, component)| component["id"].as_str() == Some(id))
        {
            return Err("Preview component ID not found".into());
        }
        doc.selected = Some(id.clone());
    }
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title(concat!(
                "SCAMATIC Canvas Lab · egui prototype ",
                env!("CARGO_PKG_VERSION")
            ))
            .with_inner_size([1440.0, 940.0])
            .with_min_inner_size([1120.0, 700.0])
            .with_visible(capture.is_none()),
        renderer: eframe::Renderer::Glow,
        centered: true,
        ..Default::default()
    };
    eframe::run_native(
        "SCAMATIC Canvas Lab",
        options,
        Box::new(move |cc| {
            Ok(Box::new(app::Builder::new(
                cc,
                doc,
                capture,
                markup_preview,
            )))
        }),
    )
    .map_err(|e| e.to_string())
}

fn main() {
    if let Err(error) = execute() {
        eprintln!("{error}");
        // Console-less release builds still show actionable file errors to a desktop user.
        if !std::env::args().any(|arg| arg.starts_with("--")) {
            rfd::MessageDialog::new()
                .set_title("SCAMATIC Canvas Lab")
                .set_description(&error)
                .set_level(rfd::MessageLevel::Error)
                .show();
        }
        std::process::exit(1);
    }
}
