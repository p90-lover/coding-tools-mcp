fn main() {
    embed_snapshot_helper();
    tauri_build::build()
}

// Preserve the already-shipped Windows helper in ordinary release builds, not
// only in the older bespoke release workflow. This compiles existing local C++
// source; it does not run the helper, grant consent, elevate or download tools.
fn embed_snapshot_helper() {
    use std::{env, path::PathBuf};
    println!("cargo:rerun-if-env-changed=CODING_TOOLS_SNAPSHOT_HELPER");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || env::var_os("CARGO_FEATURE_NATIVE_SNAPSHOT").is_none()
    {
        return;
    }
    if let Some(path) = env::var_os("CODING_TOOLS_SNAPSHOT_HELPER") {
        let path = PathBuf::from(path);
        assert!(
            path.is_absolute() && path.is_file(),
            "explicit snapshot helper is missing"
        );
        println!("cargo:rerun-if-changed={}", path.display());
        return;
    }
    let source = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest"))
        .join("../native-helpers/app-container/main.cpp");
    println!("cargo:rerun-if-changed={}", source.display());
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    let exe = out.join("coding-tools-appcontainer.exe");
    let compiler = cc::Build::new()
        .cpp(true)
        .static_crt(true)
        .opt_level(2)
        .get_compiler();
    assert!(
        compiler.is_like_msvc(),
        "Windows snapshot helper requires an MSVC-compatible compiler"
    );
    let status = compiler
        .to_command()
        .current_dir(&out)
        .args([
            "/nologo",
            "/std:c++17",
            "/EHsc",
            "/W4",
            "/WX",
            "/permissive-",
            "/DUNICODE",
            "/D_UNICODE",
            "/DWIN32_LEAN_AND_MEAN",
            "/DNOMINMAX",
            "/D_WIN32_WINNT=0x0A00",
        ])
        .arg(format!("/Fo{}", out.join("snapshot-helper.obj").display()))
        .arg(format!("/Fe{}", exe.display()))
        .arg(&source)
        .args([
            "/link",
            "userenv.lib",
            "advapi32.lib",
            "shell32.lib",
            "pathcch.lib",
            "/DYNAMICBASE",
            "/NXCOMPAT",
            "/HIGHENTROPYVA",
        ])
        .status()
        .expect("launch the installed C++ compiler");
    assert!(
        status.success() && exe.is_file(),
        "snapshot helper build failed; refusing an incomplete release"
    );
    println!(
        "cargo:rustc-env=CODING_TOOLS_SNAPSHOT_HELPER={}",
        exe.display()
    );
}
