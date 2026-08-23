# Packaging the Windows build

Produces a normal Windows app — Start Menu shortcut, uninstaller, no Python
required on the target machine.

## Build

```
python build.py
pyinstaller packaging/MangaTL-Reader.spec --noconfirm --distpath packaging/out --workpath packaging/work
iscc packaging/installer.iss
```

Output: `packaging/Output/MangaTL-Reader-Setup.exe`

[Inno Setup](https://jrsoftware.org/isdl.php) provides `iscc`. Build in a
clean virtualenv that has **only** what the bundle needs — if `torch` is
importable at build time, PyInstaller may pull it in regardless of the
`excludes` list:

```
python -m venv .venv-build
.venv-build/Scripts/activate
pip install pyinstaller flask requests opencv-python-headless numpy pillow rapidocr onnxruntime
```

## What ships

Measured on the real build: **247 MB installed**, of which cv2 is 112 MB,
onnxruntime 36 MB and RapidOCR's ONNX models 31 MB.

| | in the bundle |
|---|---|
| RapidOCR + onnxruntime | yes — models included, works offline immediately |
| Gemini Vision OCR | yes — needs the user's own API key, as always |
| EasyOCR | **no** |
| LaMa AI inpainting (`ai_inpaint`) | **no** — needs torch |
| OpenCV inpaint + flat fill (default erase) | yes |

### Why EasyOCR is excluded

It pulls torch + scipy + scikit-image + torchvision — about 690 MB of a
980 MB full install — and it *still* downloads a 100–400 MB language model on
first use. Bundling it would produce a much larger installer that is not
actually offline. RapidOCR ships its models inside the package, so this build
works the moment it is installed.

The cost is narrow: RapidOCR drops some Vietnamese tone marks, but `vi` (and
CJK, Cyrillic, and the other heavy-diacritic languages) are all in
`VISION_LANGS`, so anyone with a Gemini key is routed to Vision anyway and
sees no difference.

Nothing is hardcoded to know this. `server.py` detects installed engines at
runtime (`AVAILABLE_LOCAL_ENGINES`, `_resolve_local_engine`), so a saved
"easyocr" preference falls back to RapidOCR instead of crashing, and the
engine-recommendation banner won't suggest an engine this build lacks.

## Antivirus

Unsigned PyInstaller output gets flagged by Defender and Avast with some
regularity. This is mitigated but not solved here:

- **onedir, not onefile** — no self-extraction to temp on each launch, which
  is the behaviour heuristics dislike most.
- **UPX disabled** in the spec — compression is a strong FP trigger.
- **An installer** rather than a loose exe.

The real fix is an Authenticode code-signing certificate (~$100–400/yr). Until
then, expect some users to see a SmartScreen warning; reputation improves as
more people install it.

## The models must really be in the bundle

`collect_data_files("rapidocr")` in the spec is load-bearing, and it fails
quietly if it ever stops working. RapidOCR does **not** error when its ONNX
models are missing — it silently falls back to downloading them from
`modelscope.cn` at first use. Observed directly by removing them: `/ocr` then
returns `OCR failed: Failed to download https://www.modelscope.cn/...`.

That is the difference between this build working offline and not, which is
the entire reason it ships RapidOCR rather than EasyOCR. And it is worse on a
CI runner, where the download would probably *succeed* — so OCR would pass on
a bundle that is broken for the offline user.

`smoke_test.py` therefore asserts the `.onnx` files are physically present,
rather than inferring it from OCR working.

## Verified

Run [`smoke_test.py`](smoke_test.py) against the built exe:

```
python packaging/smoke_test.py packaging/out/MangaTL-Reader/MangaTL-Reader.exe
```

It starts the exe, checks the exclusions held and the models are bundled, does
real OCR through it (asserting `ocr_engine: rapidocr` and that two separate
bubbles come back as two regions), exercises `/ocr-crop`, confirms the
cross-origin guard survived freezing, and stops the server. Exits non-zero on
any failure. Nine checks.

CI runs exactly this on demand and on release tags — see
[`.github/workflows/package-smoke.yml`](../.github/workflows/package-smoke.yml).
It is not on every PR because it needs a Windows runner and a multi-minute
build; run it before cutting a release, or after touching this directory,
`server.py`'s engine resolution, or anything lazily imported.
