# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the packaged Windows build.

WHAT THIS BUILDS
  A onedir bundle of dist/MangaTL-Reader.py — the single-file build, which
  already has index.html, style.css, every JS module and rates.json inlined
  into it by build.py. That is why there is no --add-data for static/ here:
  there is no static/ to ship.

  Build it with:
      python build.py                                   (refresh dist/)
      pyinstaller packaging/MangaTL-Reader.spec --noconfirm

WHY RAPIDOCR ONLY
  easyocr pulls torch + scipy + scikit-image + torchvision: ~690MB of a
  ~980MB full install. Worse, it is not even self-contained — easyocr
  downloads its language model (~100-400MB) on first use, so bundling it
  produces a huge installer that STILL needs a download before it can read
  a page. RapidOCR ships its ONNX models inside the package (~32MB), so
  this build actually works offline the moment it is installed.

  What that costs, precisely:
    - Vietnamese/CJK/Cyrillic tone-mark accuracy for users with NO Gemini
      key. Those languages are all in VISION_LANGS, so anyone with a key is
      already routed to Gemini Vision and is unaffected.
    - The opt-in LaMa AI inpainting (ai_inpaint), which needs torch.
      _get_lama_engine() already raises _AiInpaintUnavailable with a
      plain-language message, so this degrades to a clear error rather than
      a traceback. The DEFAULT erase path (OpenCV inpaint + flat fill) is
      untouched.

  server.py detects this at runtime rather than being told: see
  AVAILABLE_LOCAL_ENGINES / _resolve_local_engine(). A user whose saved
  preference says "easyocr" falls back to RapidOCR instead of crashing.
"""

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

# RapidOCR loads its ONNX models and YAML config by PATH at runtime, so they
# have to be shipped as data — PyInstaller's import analysis cannot see them.
# Without this the exe builds fine and then fails on the first page.
rapidocr_datas = collect_data_files("rapidocr")

# onnxruntime's native .dll/.pyd payload. collect_dynamic_libs is what pulls
# the actual inference runtime rather than just the Python wrapper.
onnx_binaries = collect_dynamic_libs("onnxruntime")

a = Analysis(
    ["../dist/MangaTL-Reader.py"],
    pathex=[],
    binaries=onnx_binaries,
    datas=rapidocr_datas,
    # Every OCR/inpaint import in this app is deliberately lazy (inside
    # _get_reader / _get_rapidocr_engine / _get_lama_engine), so PyInstaller's
    # static analysis sees NONE of them. Anything the frozen build must
    # actually be able to import has to be named here.
    hiddenimports=[
        "rapidocr",
        "onnxruntime",
        "onnxruntime.capi",
        "onnxruntime.capi._pybind_state",
        "cv2",
        "PIL",
        "PIL._tkinter_finder",
        "flask",
        "jinja2",
        "werkzeug",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # The whole point of this build. torch is 522MB on its own; scipy and
        # scikit-image come along as easyocr dependencies.
        "torch", "torchvision", "easyocr", "scipy", "skimage", "sklearn",
        # rapidocr ships a pytorch inference backend alongside the onnxruntime
        # one. Leave it in and PyInstaller follows it straight back to torch,
        # undoing everything above.
        "rapidocr.inference_engine.pytorch",
        # Not used by the server, but commonly dragged in by numpy/PIL and
        # each worth tens of MB.
        "matplotlib", "pandas", "tkinter", "PyQt5", "PySide2", "notebook",
        "IPython", "pytest", "setuptools", "pip",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,     # onedir: see COLLECT below
    name="MangaTL-Reader",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                 # UPX compression is a major antivirus
                               # false-positive trigger; not worth it.
    console=True,              # The server prints its URL and progress here.
                               # Set False only after adding a real GUI/tray,
                               # or the app becomes silent on failure.
)

# onedir, not onefile. At this bundle size onefile re-extracts everything to a
# temp dir on EVERY launch (slow start, double disk use) and is the form
# antivirus flags hardest. The Inno Setup script in this folder wraps this
# directory into a normal Windows installer with a Start Menu shortcut, which
# is what a non-technical user actually expects.
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="MangaTL-Reader",
)
