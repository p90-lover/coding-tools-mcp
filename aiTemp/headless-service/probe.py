from pathlib import Path
import subprocess
import sys

root = Path.cwd().resolve()
out = root / "aiTemp/headless-service-probe"
(out / "src").mkdir(parents=True, exist_ok=True)

(out / "Cargo.toml").write_text(
    """[package]
name="coding-tools-headless-contract-probe"
version="0.0.0"
edition="2021"

[dependencies]
axum="0.8"
base64="0.22"
rand="0.9"
reqwest={version="0.12",default-features=false,features=["json","rustls-tls"]}
serde={version="1",features=["derive"]}
serde_json="1"
sha2="0.10"
tokio={version="1",features=["rt-multi-thread","macros","net","sync","time"]}
url="2"
uuid={version="1",features=["v4"]}
""",
    encoding="utf-8",
)

production = root / "rust-core/coding-tools-headless/src/lib.rs"
contracts = root / "aiTemp/headless-service/contracts.rs"
(out / "src/lib.rs").write_text(
    '#[path="' + production.as_posix() + '"]\npub mod headless;\n'
    '#[cfg(test)]\nmod contracts { include!("' + contracts.as_posix() + '"); }\n',
    encoding="utf-8",
)

result = subprocess.run(
    [
        "cargo",
        "test",
        "--manifest-path",
        str(out / "Cargo.toml"),
        "headless_",
        "--",
        "--test-threads=1",
        "--nocapture",
    ]
)
sys.exit(result.returncode)
