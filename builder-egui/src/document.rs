use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const MAX_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectRef {
    Component(usize),
    Markup(usize),
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    pub label: String,
    pub default_size: Size,
    pub default_properties: Value,
    pub project_types: Option<Vec<String>>,
    pub allowed_data_types: Vec<String>,
    pub library: Option<bool>,
}

#[derive(Clone, Deserialize)]
pub struct Size {
    pub width: f32,
    pub height: f32,
}

pub fn catalog() -> BTreeMap<String, Definition> {
    serde_json::from_str(include_str!("../assets/component-catalog.json"))
        .expect("embedded component catalog")
}

pub fn text<'a>(value: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or(fallback)
}

pub fn number(value: &Value, key: &str, fallback: f32) -> f32 {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && (*n as f32).is_finite())
        .map(|n| n as f32)
        .unwrap_or(fallback)
}

fn asset_id(record: &Value) -> Option<&str> {
    record["_id"].as_str().or(record["id"].as_str())
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Position {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Position {
    pub fn read(component: &Value) -> Self {
        let p = &component["position"];
        Self {
            x: number(p, "x", 0.0),
            y: number(p, "y", 0.0),
            width: number(p, "width", 120.0),
            height: number(p, "height", 80.0),
        }
    }

    pub fn transformed(self, delta: [f32; 2], resize: bool, snap: bool, canvas: [f32; 2]) -> Self {
        self.transformed_with_minimum(delta, resize, snap, canvas, [24.0, 16.0])
    }

    pub fn transformed_markup(
        self,
        delta: [f32; 2],
        resize: bool,
        snap: bool,
        canvas: [f32; 2],
    ) -> Self {
        self.transformed_with_minimum(delta, resize, snap, canvas, [1.0, 1.0])
    }

    fn transformed_with_minimum(
        self,
        delta: [f32; 2],
        resize: bool,
        snap: bool,
        canvas: [f32; 2],
        min: [f32; 2],
    ) -> Self {
        let quantize = |v: f32| if snap { (v / 20.0).round() * 20.0 } else { v };
        if resize {
            Self {
                width: quantize(self.width + delta[0])
                    .clamp(min[0], (canvas[0] - self.x).max(min[0])),
                height: quantize(self.height + delta[1])
                    .clamp(min[1], (canvas[1] - self.y).max(min[1])),
                ..self
            }
        } else {
            Self {
                x: quantize(self.x + delta[0]).clamp(0.0, (canvas[0] - self.width).max(0.0)),
                y: quantize(self.y + delta[1]).clamp(0.0, (canvas[1] - self.height).max(0.0)),
                ..self
            }
        }
    }
}

pub struct Document {
    pub root: Value,
    pub source: Option<PathBuf>,
    pub imported_publication: bool,
    pub selected: Option<String>,
    saved: Value,
    past: Vec<Value>,
    future: Vec<Value>,
}

impl Document {
    pub fn from_value(mut root: Value) -> Result<Self, String> {
        let imported_publication = root.pointer("/payload/version/schema").is_some();
        if imported_publication {
            root = json!({ "format": "scamatic-egui-draft/v1", "schema": root["payload"]["version"]["schema"].clone(), "assets": root["payload"]["assets"].clone() });
        }
        let document = Self {
            saved: root.clone(),
            root,
            source: None,
            imported_publication,
            selected: None,
            past: vec![],
            future: vec![],
        };
        let issues = document.structural_issues();
        if !issues.is_empty() {
            return Err(issues.join("\n"));
        }
        Ok(document)
    }

    pub fn open(path: &Path) -> Result<Self, String> {
        let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
        if metadata.len() > MAX_DOCUMENT_BYTES {
            return Err("Project exceeds the 32 MiB prototype limit.".into());
        }
        let content = fs::read(path).map_err(|e| e.to_string())?;
        let mut document = Self::from_value(
            serde_json::from_slice(&content).map_err(|e| format!("Invalid JSON: {e}"))?,
        )?;
        document.source = Some(path.canonicalize().map_err(|e| e.to_string())?);
        Ok(document)
    }

    pub fn demo() -> Self {
        Self::from_value(
            serde_json::from_str(include_str!("../assets/demo-project.json"))
                .expect("embedded demo"),
        )
        .expect("valid demo")
    }

    pub fn iot_demo() -> Self {
        Self::from_value(
            serde_json::from_str(include_str!("../assets/demo-iot-project.json"))
                .expect("embedded IoT example"),
        )
        .expect("valid IoT example")
    }

    pub fn is_iot(&self) -> bool {
        self.schema()["project"]["projectType"] == "iot-dashboard"
    }

    pub fn schema(&self) -> &Value {
        self.root.get("schema").unwrap_or(&self.root)
    }
    pub fn schema_mut(&mut self) -> &mut Value {
        if self.root.get("schema").is_some() {
            &mut self.root["schema"]
        } else {
            &mut self.root
        }
    }
    pub fn components(&self) -> &[Value] {
        self.schema()["components"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
    pub fn markups(&self) -> &[Value] {
        // Markup belongs to the draft envelope, outside the shared runtime schema.
        if self.root.get("schema").is_none() {
            return &[];
        }
        self.root["markup"]["objects"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
    pub fn objects(&self) -> impl Iterator<Item = (ObjectRef, &Value)> {
        self.components()
            .iter()
            .enumerate()
            .map(|(i, v)| (ObjectRef::Component(i), v))
            .chain(
                self.markups()
                    .iter()
                    .enumerate()
                    .map(|(i, v)| (ObjectRef::Markup(i), v)),
            )
    }
    pub fn object(&self, object: ObjectRef) -> &Value {
        match object {
            ObjectRef::Component(i) => &self.components()[i],
            ObjectRef::Markup(i) => &self.markups()[i],
        }
    }
    fn object_mut(&mut self, object: ObjectRef) -> &mut Value {
        match object {
            ObjectRef::Component(i) => &mut self.schema_mut()["components"][i],
            ObjectRef::Markup(i) => &mut self.root["markup"]["objects"][i],
        }
    }
    pub fn selected_object(&self) -> Option<ObjectRef> {
        self.objects()
            .find(|(_, v)| v["id"].as_str() == self.selected.as_deref())
            .map(|(r, _)| r)
    }
    pub fn replace_object(&mut self, object: ObjectRef, value: Value) {
        let before = self.root.clone();
        *self.object_mut(object) = value;
        self.commit(before);
    }

    pub fn add_freehand(&mut self, points: &[eframe::egui::Pos2]) -> Result<(), String> {
        let size = self.canvas();
        if points
            .iter()
            .any(|p| p.x < 0.0 || p.y < 0.0 || p.x > size[0] || p.y > size[1])
        {
            return Err("Freehand points must be inside the canvas.".into());
        }
        let object = crate::markup::freehand(points).ok_or("Invalid freehand stroke.")?;
        self.insert_markup(object)
    }

    pub fn set_object_position(&mut self, object: ObjectRef, p: Position) {
        let position = &mut self.object_mut(object)["position"];
        for (key, value) in [
            ("x", p.x),
            ("y", p.y),
            ("width", p.width),
            ("height", p.height),
        ] {
            if number(position, key, f32::NAN) != value {
                position[key] = json!(value);
            }
        }
    }
    pub fn add_markup(
        &mut self,
        kind: crate::markup::Kind,
        start: [f32; 2],
        end: [f32; 2],
    ) -> Result<(), String> {
        if self.markups().len() >= crate::markup::MAX_OBJECTS {
            return Err("Markup limit reached (2000 objects).".into());
        }
        let size = self.canvas();
        if [start, end].iter().any(|point| {
            point
                .iter()
                .enumerate()
                .any(|(i, n)| !n.is_finite() || *n < 0.0 || *n > size[i])
        }) {
            return Err("Markup points must be finite and inside the canvas.".into());
        }
        self.insert_markup(crate::markup::create(kind, start, end, 0))
    }
    fn insert_markup(&mut self, mut object: Value) -> Result<(), String> {
        if self.markups().len() >= crate::markup::MAX_OBJECTS {
            return Err("Markup limit reached (2000 objects).".into());
        }
        if !crate::markup::valid(&object) {
            return Err("Invalid markup geometry or style.".into());
        }
        let before = self.root.clone();
        let z = self
            .objects()
            .filter_map(|(_, v)| v["zIndex"].as_i64())
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        object["zIndex"] = json!(z);
        object["name"] = json!(format!(
            "{} {}",
            crate::markup::Kind::from_value(&object).unwrap().label(),
            z
        ));
        self.selected = object["id"].as_str().map(str::to_owned);
        if self.root.get("schema").is_none() {
            self.root = json!({"format": "scamatic-egui-draft/v1", "schema": std::mem::take(&mut self.root)});
        }
        if self.root.get("markup").is_none() {
            self.root["markup"] = json!({"format": "scamatic-markup/v1", "objects": []});
        }
        self.root["markup"]["objects"]
            .as_array_mut()
            .expect("validated markup list")
            .push(object);
        self.commit(before);
        Ok(())
    }
    fn deletable_selection(&self) -> Option<ObjectRef> {
        self.selected_object().filter(|object| {
            let value = self.object(*object);
            value["locked"] != true
                && (matches!(object, ObjectRef::Markup(_))
                    || crate::industrial::for_component(value).is_some())
        })
    }

    pub fn can_delete_selected(&self) -> bool {
        self.deletable_selection().is_some()
    }

    pub fn delete_selected(&mut self) {
        let Some(object) = self.deletable_selection() else {
            return;
        };
        let before = self.root.clone();
        match object {
            ObjectRef::Markup(i) => self.root["markup"]["objects"]
                .as_array_mut()
                .unwrap()
                .remove(i),
            ObjectRef::Component(i) => self.schema_mut()["components"]
                .as_array_mut()
                .unwrap()
                .remove(i),
        };
        self.selected = None;
        self.commit(before);
    }
    pub fn canvas(&self) -> [f32; 2] {
        [
            number(&self.schema()["project"]["canvas"], "width", 1200.0).clamp(320.0, 10000.0),
            number(&self.schema()["project"]["canvas"], "height", 760.0).clamp(240.0, 10000.0),
        ]
    }
    pub fn dirty(&self) -> bool {
        self.root != self.saved
    }
    pub fn can_undo(&self) -> bool {
        !self.past.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.future.is_empty()
    }
    #[cfg(test)]
    pub fn selected_index(&self) -> Option<usize> {
        self.components()
            .iter()
            .position(|v| v["id"].as_str() == self.selected.as_deref())
    }

    pub fn commit(&mut self, before: Value) {
        if before != self.root {
            self.past.push(before);
            if self.past.len() > 50 {
                self.past.remove(0);
            }
            self.future.clear();
        }
    }

    pub fn edit(&mut self, action: impl FnOnce(&mut Value)) {
        let before = self.root.clone();
        action(self.schema_mut());
        self.commit(before);
    }

    pub fn undo(&mut self) {
        if let Some(before) = self.past.pop() {
            self.future.push(std::mem::replace(&mut self.root, before));
        }
    }
    pub fn redo(&mut self) {
        if let Some(after) = self.future.pop() {
            self.past.push(std::mem::replace(&mut self.root, after));
        }
    }

    #[cfg(test)]
    pub fn set_position(&mut self, index: usize, p: Position) {
        self.set_object_position(ObjectRef::Component(index), p);
    }

    pub fn add(&mut self, kind: &str, definition: &Definition) {
        let component = self.new_component(kind, definition);
        self.selected = component["id"].as_str().map(str::to_owned);
        self.edit(|schema| schema["components"].as_array_mut().unwrap().push(component));
    }

    fn new_component(&self, kind: &str, definition: &Definition) -> Value {
        let id = format!("egui-{}", uuid::Uuid::new_v4());
        let canvas = self.canvas();
        let width = definition.default_size.width;
        let height = definition.default_size.height;
        let z = self
            .objects()
            .filter_map(|(_, v)| v["zIndex"].as_i64())
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        let mut component = json!({ "id": id, "type": kind, "name": format!("{} {}", definition.label, z), "position": { "x": (canvas[0] - width).max(0.0) / 2.0, "y": (canvas[1] - height).max(0.0) / 2.0, "width": width, "height": height, "rotation": 0 }, "zIndex": z, "visible": true, "locked": false, "binding": { "tagId": null }, "properties": definition.default_properties, "metadata": {} });
        if kind == "control-popup" {
            component["children"] = json!([]);
        }
        if kind == "chart" {
            component["binding"]["tagIds"] = json!([]);
        }
        component
    }

    pub fn add_industrial(
        &mut self,
        symbol: &crate::industrial::Symbol,
        image_definition: &Definition,
    ) -> Result<(), String> {
        if !self.is_iot() {
            return Err("Industrial symbols are available in IoT projects.".into());
        }
        let (id, asset_to_embed) = self.industrial_asset(&symbol.asset)?;

        let mut definition = image_definition.clone();
        let [canvas_width, canvas_height] = self.canvas();
        let size = symbol.size();
        let scale =
            (220.0_f32.min(canvas_width) / size.x).min(160.0_f32.min(canvas_height) / size.y);
        definition.default_size = Size {
            width: size.x * scale,
            height: size.y * scale,
        };
        definition.label.clone_from(&symbol.label);
        definition.default_properties["assetId"] = json!(id);
        definition.default_properties["fileName"] = symbol.asset["metadata"]["fileName"].clone();
        if symbol.stretch {
            definition.default_properties["objectFit"] = json!("fill");
            definition.default_properties["lockAspectRatio"] = json!(false);
        }
        let mut component = self.new_component("design-image", &definition);
        component["metadata"]["grindstoneGenerator"] = json!(symbol.generator);

        // The component and its SVG enter the same draft history step.
        let before = self.root.clone();
        if let Some(asset) = asset_to_embed {
            self.embed_industrial_asset(asset);
        }
        self.selected = component["id"].as_str().map(str::to_owned);
        self.schema_mut()["components"]
            .as_array_mut()
            .unwrap()
            .push(component);
        self.commit(before);
        Ok(())
    }

    pub fn apply_industrial_finish(&mut self, object: ObjectRef) -> Result<(), String> {
        let ObjectRef::Component(index) = object else {
            return Err("Select a Grindstone symbol first.".into());
        };
        let component = self.object(object);
        let symbol = crate::industrial::for_component(component)
            .filter(|symbol| component["locked"] != true && symbol.uses_flat_asset(component))
            .ok_or("Select an unlocked Grindstone symbol with its original finish.")?;
        let (id, asset_to_embed) = self.industrial_asset(&symbol.asset)?;
        let before = self.root.clone();
        if let Some(asset) = asset_to_embed {
            self.embed_industrial_asset(asset);
        }
        self.schema_mut()["components"][index]["properties"]["assetId"] = json!(id);
        self.commit(before);
        Ok(())
    }

    fn industrial_asset(&self, original: &Value) -> Result<(String, Option<Value>), String> {
        let records: &[Value] = match self.root.get("schema").and(self.root.get("assets")) {
            None | Some(Value::Null) => &[],
            Some(Value::Array(records)) => records,
            _ => return Err("Cannot embed an industrial symbol in a malformed asset list.".into()),
        };
        let mut id = asset_id(original).expect("catalog asset ID").to_owned();
        let mut asset = original.clone();
        if let Some(existing) = records
            .iter()
            .find(|record| asset_id(record) == Some(id.as_str()))
        {
            if existing == original {
                return Ok((id, None));
            }
            // A draft can already own this ID. Keep that record intact.
            id = format!("grindstone-{}", uuid::Uuid::new_v4());
            asset["_id"] = json!(id);
        }
        Ok((id, Some(asset)))
    }

    fn embed_industrial_asset(&mut self, asset: Value) {
        if self.root.get("schema").is_none() {
            self.root = json!({"format": "scamatic-egui-draft/v1", "schema": std::mem::take(&mut self.root)});
        }
        if self.root["assets"].is_null() {
            self.root["assets"] = json!([]);
        }
        self.root["assets"].as_array_mut().unwrap().push(asset);
    }

    pub fn svg(&self) -> Option<Vec<u8>> {
        if let Some(svg) = self.root.get("svg").and_then(Value::as_str) {
            return Some(svg.as_bytes().to_vec());
        }
        let id = self.schema()["project"]["svgAssetId"].as_str()?;
        self.asset(id)
    }

    pub fn asset(&self, id: &str) -> Option<Vec<u8>> {
        let record = self
            .root
            .get("assets")?
            .as_array()?
            .iter()
            .find(|v| asset_id(v) == Some(id))?;
        let content = record["content"].as_str()?;
        if record["kind"] == "svg"
            || record.pointer("/metadata/mimeType").and_then(Value::as_str) == Some("image/svg+xml")
        {
            Some(content.as_bytes().to_vec())
        } else {
            STANDARD.decode(content).ok()
        }
    }

    pub fn attach_svg(&mut self, svg: String) {
        let before = self.root.clone();
        if self.root.get("schema").is_none() {
            self.root =
                json!({ "format": "scamatic-egui-draft/v1", "schema": self.root, "svg": svg });
        } else {
            self.root["svg"] = json!(svg);
        }
        self.commit(before);
    }

    pub fn save_copy(&mut self, path: &Path) -> Result<(), String> {
        if path.exists() && self.source.as_ref() == path.canonicalize().ok().as_ref() {
            return Err("Choose a new file name. The imported source is kept intact.".into());
        }
        let issues = self.structural_issues();
        if !issues.is_empty() {
            return Err(issues.join("\n"));
        }
        let folder = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut file = tempfile::NamedTempFile::new_in(folder).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec_pretty(&self.root).map_err(|e| e.to_string())?;
        if bytes.len() as u64 >= MAX_DOCUMENT_BYTES {
            return Err("Saved draft would exceed the 32 MiB prototype limit.".into());
        }
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        file.persist(path).map_err(|e| e.error.to_string())?;
        self.saved = self.root.clone();
        Ok(())
    }

    pub fn structural_issues(&self) -> Vec<String> {
        let schema = self.schema();
        let mut issues = vec![];
        if !schema["schemaVersion"].is_string()
            || !schema["project"].is_object()
            || !schema["tags"].is_array()
            || !schema["dataSources"].is_array()
            || !schema["components"].is_array()
        {
            issues.push("Expected a SCAMATIC project schema, API response with schema, or runtime deployment.json.".into());
            return issues;
        }
        let mut ids = HashSet::new();
        if self.root.get("schema").is_some()
            && let Some(markup) = self.root.get("markup")
        {
            if markup["format"] != "scamatic-markup/v1" || !markup["objects"].is_array() {
                issues.push("Unsupported or malformed markup layer.".into());
            } else if self.markups().len() > crate::markup::MAX_OBJECTS {
                issues.push("Markup layer exceeds 2000 objects.".into());
            }
            for value in self.markups() {
                if !crate::markup::valid(value) {
                    issues.push("Markup has an invalid tool or style.".into());
                }
            }
        }
        for (_, component) in self.objects() {
            let id = text(component, "id", "");
            if id.is_empty() || !ids.insert(id) {
                issues.push("Component IDs must be present and unique.".into());
            }
            for key in ["x", "y", "width", "height", "rotation"] {
                if component["position"][key]
                    .as_f64()
                    .filter(|v| v.is_finite() && (*v as f32).is_finite())
                    .is_none()
                {
                    issues.push(format!("Component {id} has invalid {key}."));
                }
            }
            if number(&component["position"], "width", 0.0) <= 0.0
                || number(&component["position"], "height", 0.0) <= 0.0
            {
                issues.push(format!("Component {id} requires positive dimensions."));
            }
        }
        for (key, min) in [("width", 320.0), ("height", 240.0)] {
            if schema["project"]["canvas"][key]
                .as_f64()
                .filter(|v| v.is_finite() && *v >= min && *v <= 10000.0)
                .is_none()
            {
                issues.push(format!("Canvas {key} must be between {min} and 10000."));
            }
        }
        issues
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applying_arc_finish_to_a_legacy_symbol_preserves_its_geometry_and_undo() {
        let mut doc = Document::iot_demo();
        let symbol = crate::industrial::find("pump.centrifugal").unwrap();
        doc.add_industrial(symbol, &catalog()["design-image"])
            .unwrap();
        let object = doc.selected_object().unwrap();
        let ObjectRef::Component(index) = object else {
            unreachable!()
        };
        doc.schema_mut()["components"][index]["properties"]["assetId"] =
            json!(symbol.flat_asset_id);
        let flat_asset = json!({
            "_id": symbol.flat_asset_id,
            "kind": "design-image",
            "content": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 156 90\"/>",
            "metadata": {"mimeType": "image/svg+xml"},
        });
        doc.root["assets"] = json!([flat_asset]);
        let before = doc.root.clone();
        let mut expected = doc.object(object).clone();
        expected["properties"]["assetId"] = symbol.asset["_id"].clone();

        doc.apply_industrial_finish(object).unwrap();
        assert_eq!(doc.object(object), &expected);
        assert_eq!(doc.root["assets"], json!([flat_asset, symbol.asset]));
        assert!(doc.apply_industrial_finish(object).is_err());
        doc.undo();
        assert_eq!(doc.root, before);
    }

    #[test]
    fn grindstone_symbols_render_and_round_trip_with_embedded_assets() {
        let original = Document::iot_demo().schema().clone();
        let mut doc = Document::from_value(original.clone()).unwrap();
        let catalog = catalog();
        let symbols = crate::industrial::symbols();
        let image = &catalog["design-image"];
        for symbol in symbols {
            doc.add_industrial(symbol, image).unwrap();
            let selected = doc.object(doc.selected_object().unwrap());
            let id = selected["properties"]["assetId"].as_str().unwrap();
            let svg = doc.asset(id).unwrap();
            let pixels = egui_extras::image::load_svg_bytes(&svg, &Default::default()).unwrap();
            assert!(
                pixels.pixels.iter().any(|pixel| pixel.a() > 0),
                "{}",
                symbol.generator
            );
            assert_eq!(svg, symbol.asset["content"].as_str().unwrap().as_bytes());
        }
        doc.add_industrial(&symbols[0], image).unwrap();
        assert_eq!(doc.root["assets"].as_array().unwrap().len(), symbols.len());
        assert_eq!(doc.schema()["tags"], original["tags"]);
        assert_eq!(doc.schema()["project"], original["project"]);
        assert_eq!(
            &doc.components()[..original["components"].as_array().unwrap().len()],
            original["components"].as_array().unwrap()
        );

        let folder = tempfile::tempdir().unwrap();
        let output = folder.path().join("grindstone-draft.json");
        doc.save_copy(&output).unwrap();
        let mut reopened = Document::open(&output).unwrap();
        assert_eq!(reopened.root, doc.root);
        reopened.selected = reopened.components().last().unwrap()["id"]
            .as_str()
            .map(str::to_owned);
        reopened.delete_selected();
        assert_eq!(reopened.components().len() + 1, doc.components().len());
        reopened.undo();
        assert_eq!(reopened.root, doc.root);
    }

    #[test]
    fn markup_wraps_raw_schema_without_changing_it_and_survives_history_and_save() {
        let schema = Document::demo().schema().clone();
        let mut doc = Document::from_value(schema.clone()).unwrap();
        let count = crate::markup::Kind::ALL.len();
        for kind in crate::markup::Kind::ALL {
            doc.add_markup(kind, [300.0, 240.0], [100.0, 80.0]).unwrap();
        }
        assert_eq!(doc.schema(), &schema);
        assert_eq!(doc.markups().len(), count);
        assert!(doc.structural_issues().is_empty());
        let before = doc.root.clone();
        doc.delete_selected();
        assert_eq!(doc.markups().len(), count - 1);
        doc.undo();
        assert_eq!(doc.root, before);
        doc.redo();
        assert_eq!(doc.markups().len(), count - 1);
        doc.undo();
        let folder = tempfile::tempdir().unwrap();
        let output = folder.path().join("markup-draft.json");
        doc.save_copy(&output).unwrap();
        assert_eq!(Document::open(&output).unwrap().root, before);
        for _ in 0..count {
            doc.undo();
        }
        assert_eq!(doc.root, schema);
    }

    #[test]
    fn freehand_save_resize_and_undo_keep_every_point_and_original_schema() {
        use eframe::egui::Pos2;
        let mut doc = Document::demo();
        let original = doc.root.clone();
        let schema = doc.schema().clone();
        doc.add_freehand(&[
            Pos2::new(100.5, 100.0),
            Pos2::new(140.5, 180.0),
            Pos2::new(200.5, 120.0),
            Pos2::new(100.5, 100.0),
        ])
        .unwrap();
        let object = doc.selected_object().unwrap();
        let points = doc.object(object)["properties"]["points"].clone();
        let before_resize = doc.root.clone();
        let p = Position::read(doc.object(object));
        doc.set_object_position(
            object,
            p.transformed_markup([50.0, 40.0], true, false, doc.canvas()),
        );
        doc.commit(before_resize.clone());
        assert_eq!(doc.object(object)["properties"]["points"], points);
        assert_eq!(doc.schema(), &schema);
        let folder = tempfile::tempdir().unwrap();
        let output = folder.path().join("freehand-draft.json");
        doc.save_copy(&output).unwrap();
        assert_eq!(Document::open(&output).unwrap().root, doc.root);
        doc.undo();
        assert_eq!(doc.root, before_resize);
        doc.undo();
        assert_eq!(doc.root, original);
    }

    #[test]
    fn iot_color_edits_survive_save_reopen_and_undo_without_changing_bindings() {
        let mut doc = Document::iot_demo();
        let original = doc.root.clone();
        let object = doc.objects().find(|(_, v)| v["type"] == "chart").unwrap().0;
        let mut value = doc.object(object).clone();
        let binding = value["binding"].clone();
        let position = value["position"].clone();
        value["properties"]["accentColor"] = json!("#e879f9");
        value["properties"]["backgroundColor"] = json!("#123456");
        value["properties"]["seriesColors"] = json!(["#ff8800", "#34d399"]);
        doc.replace_object(object, value);
        let styled = doc.root.clone();
        let folder = tempfile::tempdir().unwrap();
        let output = folder.path().join("colored-dashboard.json");
        doc.save_copy(&output).unwrap();
        let reopened = Document::open(&output).unwrap();
        assert_eq!(reopened.root, styled);
        assert_eq!(doc.object(object)["binding"], binding);
        assert_eq!(doc.object(object)["position"], position);
        assert_eq!(doc.schema()["tags"], original["schema"]["tags"]);
        doc.undo();
        assert_eq!(doc.root, original);
        doc.redo();
        assert_eq!(doc.root, styled);
    }

    #[test]
    fn markup_rejects_malformed_layers_duplicate_ids_and_invalid_styles() {
        let mut doc = Document::demo();
        doc.add_markup(crate::markup::Kind::Line, [10.0, 10.0], [200.0, 10.0])
            .unwrap();
        let valid = doc.root.clone();
        doc.root["markup"]["objects"][0]["properties"]["opacity"] = json!(1.5);
        assert!(Document::from_value(doc.root).is_err());
        let mut duplicate = valid.clone();
        duplicate["markup"]["objects"][0]["id"] =
            duplicate["schema"]["components"][0]["id"].clone();
        assert!(Document::from_value(duplicate).is_err());
        let mut malformed = valid.clone();
        malformed["markup"]["objects"] = json!({});
        assert!(Document::from_value(malformed).is_err());
        let mut doc = Document::from_value(valid).unwrap();
        let before = doc.root.clone();
        assert!(
            doc.add_markup(
                crate::markup::Kind::Arrow,
                [f32::INFINITY, 0.0],
                [20.0, 20.0]
            )
            .is_err()
        );
        assert_eq!(doc.root, before);
        doc.root["markup"]["objects"][0]["locked"] = json!(true);
        doc.selected = doc.markups()[0]["id"].as_str().map(str::to_owned);
        let locked = doc.root.clone();
        doc.delete_selected();
        assert_eq!(doc.root, locked);
    }

    #[test]
    fn edits_preserve_unknown_fields_assets_rotation_and_responsive_layouts() {
        let mut document = Document::demo();
        document.schema_mut()["futureMetadata"] =
            json!({ "nested": { "empty": {} }, "tokenNameOnly": "not-a-secret" });
        document.schema_mut()["components"][0]["position"]["rotation"] = json!(25);
        document.schema_mut()["components"][0]["responsivePositions"] =
            json!({ "mobile": { "x": 5, "y": 10, "width": 200, "height": 50, "rotation": 0 } });
        let before = document.root.clone();
        let p = Position::read(&document.components()[0]);
        document.set_position(
            0,
            p.transformed([40.0, 20.0], false, true, document.canvas()),
        );
        document.commit(before.clone());
        assert_eq!(
            document.schema()["futureMetadata"],
            before["schema"]["futureMetadata"]
        );
        assert_eq!(
            document.schema()["components"][0]["position"]["rotation"],
            25
        );
        assert_eq!(
            document.schema()["components"][0]["responsivePositions"],
            before["schema"]["components"][0]["responsivePositions"]
        );
        assert_eq!(document.root["svg"], before["svg"]);
        document.undo();
        assert_eq!(document.root, before);
        document.redo();
        assert_ne!(document.root, before);
    }

    #[test]
    fn deployment_import_becomes_a_draft_and_keeps_assets() {
        let schema = Document::demo().schema().clone();
        let deployment = json!({ "format": "scamatic-runtime-bundle/v1", "payload": { "version": { "schema": schema }, "assets": [{ "_id": "asset", "content": "unchanged" }] } });
        let document = Document::from_value(deployment.clone()).unwrap();
        assert!(document.imported_publication);
        assert_eq!(
            document.schema(),
            &deployment["payload"]["version"]["schema"]
        );
        assert_eq!(document.root["assets"], deployment["payload"]["assets"]);
        assert_eq!(document.root["format"], "scamatic-egui-draft/v1");
    }

    #[test]
    fn save_is_lossless_and_cannot_overwrite_the_imported_file() {
        let folder = tempfile::tempdir().unwrap();
        let input = folder.path().join("source.json");
        let output = folder.path().join("working-copy.json");
        fs::write(&input, serde_json::to_vec(&Document::demo().root).unwrap()).unwrap();
        let mut document = Document::open(&input).unwrap();
        let expected = document.root.clone();
        assert!(document.save_copy(&input).is_err());
        document.save_copy(&output).unwrap();
        assert_eq!(Document::open(&output).unwrap().root, expected);
    }

    #[test]
    fn geometry_snaps_clamps_and_resizes_without_negative_sizes() {
        let p = Position {
            x: 40.0,
            y: 40.0,
            width: 100.0,
            height: 60.0,
        };
        assert_eq!(
            p.transformed([33.0, -200.0], false, true, [320.0, 240.0]).x,
            80.0
        );
        assert_eq!(
            p.transformed([33.0, -200.0], false, true, [320.0, 240.0]).y,
            0.0
        );
        assert_eq!(
            p.transformed([-500.0, -500.0], true, false, [320.0, 240.0])
                .width,
            24.0
        );
    }

    #[test]
    fn moving_does_not_round_untouched_dimensions() {
        let mut doc = Document::demo();
        doc.schema_mut()["components"][0]["position"]["width"] = json!(333.1234567890123_f64);
        let width = doc.components()[0]["position"]["width"].clone();
        let p = Position::read(&doc.components()[0]);
        doc.set_position(0, p.transformed([40.0, 20.0], false, false, doc.canvas()));
        assert_eq!(doc.components()[0]["position"]["width"], width);
    }
}
