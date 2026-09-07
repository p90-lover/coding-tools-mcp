use super::{error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Target {
    pub window_id: u32,
    pub pid: u32,
    pub title: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
impl Bounds {
    pub fn contains(self, x: i32, y: i32) -> bool {
        let (x, y) = (i64::from(x), i64::from(y));
        x >= i64::from(self.x)
            && y >= i64::from(self.y)
            && x < i64::from(self.x) + i64::from(self.width)
            && y < i64::from(self.y) + i64::from(self.height)
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selector {
    pub name: Option<String>,
    pub automation_id: Option<String>,
    pub role: Option<String>,
    #[serde(default)]
    pub contains: bool,
}
impl Selector {
    pub fn validate(&self) -> Result<()> {
        if [&self.name, &self.automation_id, &self.role]
            .iter()
            .all(|v| v.is_none())
        {
            return Err(error(
                "INVALID_SELECTOR",
                "Specify a name, automation_id or role",
            ));
        }
        for v in [&self.name, &self.automation_id, &self.role]
            .iter()
            .filter_map(|v| v.as_ref())
        {
            if v.is_empty() || v.len() > 256 {
                return Err(error(
                    "INVALID_SELECTOR",
                    "Selector text must contain 1–256 bytes",
                ));
            }
        }
        Ok(())
    }
    pub fn matches(&self, c: &Control) -> bool {
        fn field(expected: &Option<String>, actual: &str, contains: bool) -> bool {
            expected.as_ref().is_none_or(|v| {
                if contains {
                    actual.to_lowercase().contains(&v.to_lowercase())
                } else {
                    actual.eq_ignore_ascii_case(v)
                }
            })
        }
        !c.password
            && field(&self.name, &c.name, self.contains)
            && field(&self.automation_id, &c.automation_id, false)
            && field(&self.role, &c.role, false)
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Control {
    pub name: String,
    pub automation_id: String,
    pub role: String,
    pub enabled: bool,
    pub offscreen: bool,
    pub password: bool,
    pub focused: bool,
    pub bounds: Bounds,
    pub depth: u32,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    Find {
        selector: Selector,
    },
    Click {
        selector: Option<Selector>,
        x: Option<i32>,
        y: Option<i32>,
        snapshot_id: Option<String>,
        #[serde(default = "left")]
        button: String,
    },
    Move {
        x: i32,
        y: i32,
        snapshot_id: String,
    },
    Type {
        text: String,
    },
    Key {
        key: String,
    },
    Scroll {
        amount: i32,
    },
    Wait {
        selector: Selector,
        #[serde(default = "wait_ms")]
        timeout_ms: u64,
    },
    Verify {
        selector: Selector,
    },
}
fn left() -> String {
    "left".into()
}
fn wait_ms() -> u64 {
    5000
}
impl Step {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Find { .. } => "find",
            Self::Click { .. } => "click",
            Self::Move { .. } => "move",
            Self::Type { .. } => "type",
            Self::Key { .. } => "key",
            Self::Scroll { .. } => "scroll",
            Self::Wait { .. } => "wait",
            Self::Verify { .. } => "verify",
        }
    }
    pub fn mutates(&self) -> bool {
        matches!(
            self,
            Self::Click { .. }
                | Self::Move { .. }
                | Self::Type { .. }
                | Self::Key { .. }
                | Self::Scroll { .. }
        )
    }
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Find { selector } | Self::Wait { selector, .. } | Self::Verify { selector } => {
                selector.validate()?
            }
            Self::Click {
                selector,
                x,
                y,
                snapshot_id,
                button,
            } => {
                if !matches!(button.as_str(), "left" | "right" | "double") {
                    return Err(error(
                        "INVALID_INPUT",
                        "button must be left, right or double",
                    ));
                }
                if let Some(sel) = selector {
                    sel.validate()?;
                    if x.is_some() || y.is_some() || snapshot_id.is_some() {
                        return Err(error(
                            "INVALID_INPUT",
                            "Use a selector OR image coordinates, not both",
                        ));
                    }
                } else if x.is_none()
                    || y.is_none()
                    || snapshot_id.as_ref().is_none_or(|v| v.is_empty())
                {
                    return Err(error(
                        "INVALID_INPUT",
                        "Coordinate clicks require x, y and a fresh snapshot_id",
                    ));
                }
            }
            Self::Type { text } => {
                if text.is_empty() || text.len() > 2048 || text.chars().any(|c| c.is_control()) {
                    return Err(error("INVALID_INPUT","Type accepts 1–2048 UTF-8 bytes and no control characters; use a separate key action for Enter/Tab"));
                }
            }
            Self::Key { key } => {
                key_codes(key)?;
            }
            Self::Scroll { amount } => {
                if *amount == 0 || amount.unsigned_abs() > 10 {
                    return Err(error(
                        "INVALID_INPUT",
                        "Scroll amount must be -10..-1 or 1..10 notches",
                    ));
                }
            }
            Self::Move { snapshot_id, .. } => {
                if snapshot_id.is_empty() || snapshot_id.len() > 80 {
                    return Err(error("INVALID_INPUT", "A fresh snapshot_id is required"));
                }
            }
        }
        if let Self::Wait { timeout_ms, .. } = self {
            if *timeout_ms > 15_000 || *timeout_ms == 0 {
                return Err(error("INVALID_INPUT", "Wait timeout must be 1–15000 ms"));
            }
        }
        Ok(())
    }
}
/// Deliberately excludes Win+R, secure attention, Shift+Delete and shell shortcuts.
pub fn key_codes(key: &str) -> Result<Vec<u16>> {
    let normalized = key.to_ascii_lowercase();
    let v = match normalized.as_str() {
        "enter" => vec![0x0D],
        "tab" => vec![0x09],
        "escape" => vec![0x1B],
        "backspace" => vec![0x08],
        "left" => vec![0x25],
        "up" => vec![0x26],
        "right" => vec![0x27],
        "down" => vec![0x28],
        "home" => vec![0x24],
        "end" => vec![0x23],
        "pageup" => vec![0x21],
        "pagedown" => vec![0x22],
        "space" => vec![0x20],
        "shift+tab" => vec![0x10, 0x09],
        "ctrl+a" => vec![0x11, 0x41],
        "ctrl+c" => vec![0x11, 0x43],
        "ctrl+v" => vec![0x11, 0x56],
        "ctrl+z" => vec![0x11, 0x5A],
        "ctrl+y" => vec![0x11, 0x59],
        "ctrl+s" => vec![0x11, 0x53],
        _ => {
            return Err(error(
                "KEY_NOT_ALLOWED",
                "Unsupported shortcut; no Windows/system/deletion shortcuts are exposed",
            ))
        }
    };
    Ok(v)
}
pub fn selector_from(v: &Value) -> Result<Selector> {
    let s: Selector = serde_json::from_value(v.clone())
        .map_err(|_| error("INVALID_SELECTOR", "Invalid selector fields"))?;
    s.validate()?;
    Ok(s)
}
pub fn route(args: &Value) -> Value {
    let selected = if args.get("api_available").and_then(Value::as_bool) == Some(true) {
        "api"
    } else if args.get("specialized_available").and_then(Value::as_bool) == Some(true) {
        "specialized"
    } else if args.get("visual_only").and_then(Value::as_bool) == Some(true) {
        "vision"
    } else {
        "windows_uia"
    };
    json!({"route":selected,"priority":["api","specialized","windows_uia","vision"],"decision":"deterministic routing using caller-provided availability; no action or model invocation", "fallbackRecommended":"Use the smallest necessary vision action, verify the result, then explicitly resume the recorded sequence step."})
}
