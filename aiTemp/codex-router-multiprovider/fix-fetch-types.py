from pathlib import Path

source = Path("runtime-web/src/routed-providers.ts")
source_text = source.read_text(encoding="utf-8")
old_fetch = "type FetchLike = typeof fetch;"
new_fetch = "type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;"
if old_fetch in source_text:
    source_text = source_text.replace(old_fetch, new_fetch, 1)
elif new_fetch not in source_text:
    raise SystemExit("FetchLike anchor missing")
source.write_text(source_text, encoding="utf-8")

test = Path("runtime-web/tests/routed-providers.test.ts")
test_text = test.read_text(encoding="utf-8")
test_text = test_text.replace(
    "const fetchImpl: typeof fetch = async input => {",
    "const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {",
    1,
)
test_text = test_text.replace(
    "expect(models.slice(0, 2)).toEqual(snapshot.models);",
    "expect(models.slice(0, 2)).toEqual(snapshot.models as Array<Record<string, unknown>>);",
    1,
)
test_text = test_text.replace(
    "const fetchImpl: typeof fetch = async (input, init) => {",
    "const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {",
    1,
)
if "const fetchImpl: typeof fetch" in test_text:
    raise SystemExit("stale typeof fetch test mock remains")
test.write_text(test_text, encoding="utf-8")
print("ROUTED_PROVIDER_FETCH_TYPES_PATCH_OK")
