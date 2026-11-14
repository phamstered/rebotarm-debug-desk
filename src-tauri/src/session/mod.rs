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
pub mod migration;
pub mod monitor;
pub mod documents;

pub mod local_tasks;

pub mod motor_task;

pub mod controller_task;

pub mod controller_journal;

pub mod controller_stop;
pub mod bag_operation;

pub mod arm_operation;

pub mod collection_operation;

pub mod trajectory_task;

pub mod joint4_task;

pub mod bag_receipt;
pub mod bag_recovery;
pub mod recovery_file;
pub mod collection_recovery;

pub mod activity;
