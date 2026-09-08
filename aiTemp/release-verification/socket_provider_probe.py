"""Verify native runtime and confinement with explicit TCP transport metadata."""
from pathlib import Path
source=Path('aiTemp/release-verification/runtime_dependency_probe.py').read_text(encoding='utf-8')
prefix=source.split("source=Path('aiTemp/release-verification/runtime_acl_probe.py')",1)[0]
exec(compile(prefix,'dependency_functions','exec'),globals())
base=Path('aiTemp/release-verification/runtime_acl_probe.py').read_text(encoding='utf-8')
base=base.replace("files=[runtime/n for n in names if (runtime/n).is_file()]","files=dependency_closure(runtime,names)")
needle="r'SYSTEM\\CurrentControlSet\\Services\\WinSock\\Parameters']"
assert base.count(needle)==1
base=base.replace(needle,"r'SYSTEM\\CurrentControlSet\\Services\\WinSock\\Parameters', r'SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Winsock', r'SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters\\Winsock']")
# Keep every original positive and negative assertion, including cmd/ver and
# actual loopback denial after proving the host listener is reachable.
exec(compile(base,'tcp_transport_diagnostic','exec'),globals())
