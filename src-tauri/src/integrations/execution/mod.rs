//! Typed execution subsystem. A caller must enforce authenticated workspace
//! authority, local provider consent and durable write-ahead persistence before
//! sending a reserved action. This module never starts a daemon or infers that
//! a successful transport response means a reviewed task is complete.
pub mod model;
pub mod protocol;
pub mod transport;
