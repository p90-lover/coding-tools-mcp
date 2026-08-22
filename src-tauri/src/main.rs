// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::OsStr;

fn cli_response<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut args = args.into_iter();
    args.next()?;
    let flag = args.next()?;
    if flag.as_ref() != OsStr::new("--version") || args.next().is_some() {
        return None;
    }
    Some(format!(
        "coding-tools-mcp-desktop {}",
        env!("CARGO_PKG_VERSION")
    ))
}

fn main() {
    if let Some(response) = cli_response(std::env::args_os()) {
        println!("{response}");
        return;
    }
    coding_tools_mcp_desktop_lib::run()
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_flag_returns_binary_and_package_version() {
        assert_eq!(
            super::cli_response(["coding-tools-mcp-desktop", "--version"]),
            Some(format!(
                "coding-tools-mcp-desktop {}",
                env!("CARGO_PKG_VERSION")
            ))
        );
    }
}
