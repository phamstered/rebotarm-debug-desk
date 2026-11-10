//! Application-owned session machinery. Window adapters never own robot sessions.
//! The modules are intentionally independent of WebView scheduling so they can be
//! exercised with slow/disconnected consumers without controlling hardware.
pub mod delivery;
pub mod subscriptions;
pub mod transport;
pub mod windows;
pub mod wire;
