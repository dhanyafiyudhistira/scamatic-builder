use crate::document::{number, text};
use eframe::egui::{self, Rect, Vec2};
use serde::Deserialize;
use serde_json::Value;
use std::sync::LazyLock;

pub const GROUP: &str = "Industrial · Grindstone";

#[derive(Deserialize)]
struct Catalog {
    symbols: Vec<Symbol>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub generator: String,
    pub label: String,
    #[serde(default)]
    pub stretch: bool,
    pub flat_asset_id: String,
    pub asset: Value,
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../assets/grindstone/catalog.json"))
        .expect("embedded Grindstone symbol catalog")
});

pub fn symbols() -> &'static [Symbol] {
    &CATALOG.symbols
}

pub fn find(generator: &str) -> Option<&'static Symbol> {
    symbols()
        .iter()
        .find(|symbol| symbol.generator == generator)
}

pub fn for_component(component: &Value) -> Option<&'static Symbol> {
    if component["type"] == "design-image" {
        find(component["metadata"]["grindstoneGenerator"].as_str()?)
    } else {
        None
    }
}

impl Symbol {
    pub fn uses_flat_asset(&self, component: &Value) -> bool {
        component["properties"]["assetId"] == self.flat_asset_id.as_str()
    }

    pub fn size(&self) -> Vec2 {
        let metadata = &self.asset["metadata"];
        Vec2::new(
            number(metadata, "width", 1.0),
            number(metadata, "height", 1.0),
        )
    }

    pub fn fit(&self, bounds: Rect) -> Rect {
        let size = self.size();
        let scale = (bounds.width() / size.x).min(bounds.height() / size.y);
        Rect::from_center_size(bounds.center(), size * scale)
    }

    pub fn paint_icon(&'static self, ui: &egui::Ui, bounds: Rect) {
        let id = text(&self.asset, "_id", "");
        let svg = text(&self.asset, "content", "");
        egui::Image::from_bytes(format!("bytes://industrial/{id}.svg"), svg.as_bytes())
            .paint_at(ui, self.fit(bounds));
    }
}
