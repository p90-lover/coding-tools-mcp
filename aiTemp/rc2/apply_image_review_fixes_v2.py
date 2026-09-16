from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[2]
MEDIA_TYPES = ROOT / "src/lib/provider-media.ts"
ORIGINAL = Path(__file__).with_name("apply_image_review_fixes.py")

spaced_old = "  media_type: string;\n  byte_length: number;\n"
compact_old = "  media_type:string;\n  byte_length:number;\n"
compact_new = "  media_type:string;\n  preview_data_url:string|null;\n  byte_length:number;\n"
spaced_new = "  media_type: string;\n  preview_data_url: string | null;\n  byte_length: number;\n"

text = MEDIA_TYPES.read_text(encoding="utf-8")
if spaced_new not in text and compact_new not in text:
    count = text.count(spaced_old)
    if count != 1:
        raise SystemExit(f"typescript preview compatibility anchor: expected one match, found {count}")
    MEDIA_TYPES.write_text(text.replace(spaced_old, compact_old, 1), encoding="utf-8")

runpy.run_path(str(ORIGINAL), run_name="__main__")

text = MEDIA_TYPES.read_text(encoding="utf-8")
if compact_new in text:
    MEDIA_TYPES.write_text(text.replace(compact_new, spaced_new, 1), encoding="utf-8")
elif spaced_new not in text:
    raise SystemExit("typescript preview field was not materialized")

print("IMAGE_REVIEW_FIXES_V2_OK")
