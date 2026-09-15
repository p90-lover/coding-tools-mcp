use coding_tools_core::CoreState;
use coding_tools_headless::{HeadlessService, ServiceConfig};
use std::sync::Arc;

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to create headless runtime");
    if let Err(error) = runtime.block_on(run()) {
        eprintln!("HEADLESS_START_FAILED: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let command = std::env::args().nth(1).unwrap_or_else(|| "serve".into());
    if command != "serve" {
        return Err(format!("unsupported command: {command}"));
    }
    let config = ServiceConfig::from_env()?;
    let core = Arc::new(CoreState::load().map_err(|error| error.to_string())?);
    let service = HeadlessService::start_with_core(config, core).await?;
    let shutdown = service.shutdown_handle();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            shutdown.request("local-signal");
        }
    });
    service.wait().await
}
