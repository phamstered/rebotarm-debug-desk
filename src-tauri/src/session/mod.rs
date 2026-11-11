//! Application-owned session machinery. Window adapters never own robot sessions.
//! The modules are intentionally independent of WebView scheduling so they can be
//! exercised with slow/disconnected consumers without controlling hardware.
pub mod delivery;
pub mod command_queue;
pub mod ipc;
pub mod observations;
pub mod motion_observations;
pub mod resources;
pub mod runtime;
pub mod subscriptions;
pub mod tasks;
pub mod transport;
pub mod windows;
pub mod wire;
pub mod workspace;
pub mod layout;
