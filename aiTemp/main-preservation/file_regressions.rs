//! Persistent fixtures: never delete caller files, including on a failed test.
use crate::tools::{context::ToolContext, file, patch};
use serde_json::json;
use std::{fs, path::PathBuf};

fn context() -> (PathBuf, ToolContext) {
    let base = std::env::current_dir()
        .unwrap()
        .join("aiTemp/audit-fixtures")
        .join(uuid::Uuid::new_v4().to_string());
    let root = base.join("workspace");
    fs::create_dir_all(&root).unwrap();
    let ctx = ToolContext::for_test(root, base.join("harness")).unwrap();
    (base, ctx)
}
fn add(path: &str) -> serde_json::Value {
    json!({"patch":format!("*** Begin Patch\n*** Add File: {path}\n+replacement\n*** End Patch\n")})
}
#[test]
fn audit_patch_must_not_follow_internal_staging_links() {
    // Test both internal control directories, not just caller-supplied target paths.
    for internal in ["aiTemp/staging", "aiTemp/Trash"] {
        let (base, ctx) = context();
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let link = ctx.workspace.root().join(internal);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let plain = |p: &std::path::Path| {
                p.to_string_lossy()
                    .replace('/', r"\")
                    .trim_start_matches(r"\\?\")
                    .to_string()
            };
            let result = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(plain(&link))
                .arg(plain(&outside))
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "Non-admin junction fixture failed: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        fs::write(ctx.workspace.root().join("ordinary.txt"), "original\n").unwrap();
        let result = patch::apply_patch(&ctx, &add("ordinary.txt"));
        assert!(
            result.is_err(),
            "AUDIT_INTERNAL_LINK_ESCAPED: {internal}: {result:?}"
        );
        assert_eq!(
            fs::read_to_string(ctx.workspace.root().join("ordinary.txt")).unwrap(),
            "original\n"
        );
        assert!(
            fs::read_dir(&outside).unwrap().next().is_none(),
            "Outside storage was modified"
        );
    }
}
#[test]
fn audit_patch_cannot_replace_a_directory_with_a_file() {
    let (_, ctx) = context();
    let dir = ctx.workspace.root().join("source-tree");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("preserved.txt"), "preserve all contents").unwrap();
    let result = patch::apply_patch(&ctx, &add("source-tree"));
    assert!(result.is_err(), "AUDIT_DIRECTORY_REPLACED: {result:?}");
    assert_eq!(
        fs::read_to_string(dir.join("preserved.txt")).unwrap(),
        "preserve all contents"
    );
    // A valid add/update still works and recovery retains the original bytes.
    let good = ctx.workspace.root().join("good.txt");
    fs::write(&good, "before\n").unwrap();
    assert!(patch::apply_patch(&ctx, &add("good.txt")).is_ok());
    assert_eq!(fs::read_to_string(&good).unwrap(), "replacement\n");
    let preserved = walkdir::WalkDir::new(ctx.workspace.root().join("aiTemp/Trash"))
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .any(|e| fs::read(e.path()).unwrap() == b"before\n");
    assert!(
        preserved,
        "Original must remain recoverable, not be permanently removed"
    );
}
#[test]
fn audit_text_read_must_bound_input_not_only_output() {
    let (_, ctx) = context();
    let file = ctx.workspace.root().join("oversized.txt");
    fs::File::create(&file)
        .unwrap()
        .set_len(16 * 1024 * 1024 + 1)
        .unwrap();
    let err = file::read_file(
        &ctx.workspace,
        &json!({"path":"oversized.txt","max_bytes":1}),
    )
    .unwrap_err();
    assert_eq!(
        err.code(),
        "FILE_TOO_LARGE",
        "AUDIT_UNBOUNDED_READ: size must be rejected before reading or decoding"
    );
    fs::write(
        ctx.workspace.root().join("utf8.txt"),
        "first\n香港文字\nthird\n",
    )
    .unwrap();
    let v = file::read_file(
        &ctx.workspace,
        &json!({"path":"utf8.txt","start_line":2,"end_line":2,"max_bytes":7}),
    )
    .unwrap();
    assert_eq!(v["content"], "香港");
    assert_eq!(v["truncated"], true);
    assert_eq!(v["total_lines"], 3);
}
