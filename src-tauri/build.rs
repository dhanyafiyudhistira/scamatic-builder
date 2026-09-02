fn main() {
    println!("cargo:rerun-if-env-changed=SCAMATIC_DESKTOP_SERVER_ORIGIN");
    tauri_build::build()
}
