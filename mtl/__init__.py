"""
mtl — MangaTL-Reader's internal modules.
========================================

server.py used to be one ~6,100-line file in a single namespace: SSRF
validation, LaMa inpainting, bubble geometry, OCR adapters, translation
providers and the Flask routes all interleaved, with the first @app.route
appearing around line 4,600. These modules peel that apart along the seams
that were already there.

BUILD NOTE
  build.py produces a single-file distributable (dist/MangaTL-Reader.py).
  It inlines each module in this package directly into that file, replacing
  server.py's `from mtl.… import …` block — see the BEGIN/END sentinels in
  server.py and _inline_local_modules() in build.py. That means:

    - modules here must be importable in dependency order (config, then
      security, then inpaint) with no cycles, since inlining is just
      concatenation; and
    - a module here may import from an EARLIER module in that order, but
      never from server.py itself — server.py imports from these, not the
      reverse.
"""
