mod listener;
// Shared diagnostics and their tests use the same protocol constants and RPC
// dispatcher as the listener. Keep this internal to the application crate.
pub(crate) mod server;

pub use listener::{spawn_listener, ShutdownSender};
