mod connected;
mod runtime_stream;

use connected::{DesktopApi, DesktopApiRequest, DesktopApiResponse, DesktopInfo};
use runtime_stream::{DesktopRuntimeStreams, DesktopStreamEvent, DesktopStreamRequest};
use tauri::State;
use tauri::ipc::Channel;

#[tauri::command]
fn desktop_info(api: State<'_, DesktopApi>) -> DesktopInfo {
    api.info()
}

#[tauri::command]
async fn desktop_api_request(
    api: State<'_, DesktopApi>,
    request: DesktopApiRequest,
) -> Result<DesktopApiResponse, String> {
    api.request(request).await
}

#[tauri::command]
async fn desktop_asset_data_url(
    api: State<'_, DesktopApi>,
    path: String,
) -> Result<String, String> {
    api.asset_data_url(&path).await
}

#[tauri::command]
async fn desktop_runtime_connect(
    api: State<'_, DesktopApi>,
    streams: State<'_, DesktopRuntimeStreams>,
    request: DesktopStreamRequest,
    events: Channel<DesktopStreamEvent>,
) -> Result<String, String> {
    streams.connect(api.inner(), request, events).await
}

#[tauri::command]
async fn desktop_runtime_disconnect(
    streams: State<'_, DesktopRuntimeStreams>,
    connection_id: String,
) -> Result<bool, String> {
    Ok(streams.disconnect(&connection_id).await)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let api = DesktopApi::from_environment()
        .unwrap_or_else(|error| panic!("invalid SCAMATIC desktop server configuration: {error}"));
    tauri::Builder::default()
        .manage(api)
        .manage(DesktopRuntimeStreams::default())
        .invoke_handler(tauri::generate_handler![
            desktop_info,
            desktop_api_request,
            desktop_asset_data_url,
            desktop_runtime_connect,
            desktop_runtime_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SCAMATIC Desktop");
}
