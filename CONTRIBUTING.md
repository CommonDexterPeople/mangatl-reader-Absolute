# Contributing

Thanks for looking. This file is the architecture tour — what lives where, and
the handful of things that will bite you if you don't know them first. For
installing and running the tool, see [README.md](README.md).

The source is split into readable files, not one multi-thousand-line blob:

```bash
git clone https://github.com/CommonDexterPeople/mangatl-reader-Absolute.git
cd mangatl-reader-Absolute
pip install -r requirements.txt   # or just run it — server.py installs what's missing
python server.py
```

Edit anything under `static/` and refresh your browser — no restart needed.
Editing `server.py` does need one.

Run the tests before opening a PR. They're plain scripts, no pytest:

```bash
for t in test_*.py; do python "$t" || break; done
```

CI runs all of them on every PR against `main`, plus a syntax check of every
JS and Python file and a `build.py` smoke test.

---

## Project layout

```
.
├── server.py           Flask backend — routes, OCR pipeline, translation providers
├── mtl/                Modules split out of server.py
│   ├── config.py          Constants shared by server.py and the modules below
│   ├── security.py        SSRF allowlist, image-body loading, exposure guard
│   ├── geometry.py        Panel borders, bubble components, fused-bubble waist veto
│   ├── merge.py           Grouping OCR fragments into one region per bubble
│   └── inpaint.py         Text erasure: LaMa, OpenCV inpainting, flat fill, smudge pass
├── static/
│   ├── index.html         Page markup only
│   ├── style.css          All styling
│   └── js/                ES modules, one per concern: chapter pipeline,
│                           correction UI, export, MangaDex auth, etc.
│                           main.js is the entry point; chapter-source.js
│                           defines the Chapter shape every source produces.
├── packaging/          PyInstaller spec + Inno Setup script for the Windows
│                         build — see packaging/README.md for what it ships
│                         and, more importantly, what it deliberately leaves out
├── requirements.txt    Explicit dependency install, for a venv/container/CI.
│                         Not needed for the normal path — server.py installs
│                         what's missing on first run
├── SECURITY.md         Threat model: what is defended, and what is not
└── build.py            Reassembles everything into one distributable .py file
```

`mtl/` exists because `server.py` had grown to ~6,100 lines with the first route
around line 4,600. The modules there are ordinary imports, so the tests import and
call the real functions rather than scraping source text. `build.py` **inlines**
them into the single-file build rather than importing them — so a module in `mtl/`
may import from an earlier one in `config → security → geometry → merge → inpaint`
order, but never from `server.py` itself, and CI checks the built file has no `mtl`
imports left.

`merge.py` is the one module worth reading before you touch it. It was a single
739-line `_merge_bubble_regions()` whose margin math, union-find, vetoes, column
detection and line clustering were all closures — testable only by running the
whole pipeline and inferring from the region count which stage had broken. Each
stage is now a module-level function taking explicit arguments; its module
docstring lists them in the order they run. The algorithm did not change in the
split (verified by running the old and new implementations against identical
inputs, including real pages, and diffing the outputs).

One consequence worth knowing: the structural vetoes are reached through a
`VetoSet`, not called by name. Tests that need to disable exactly one veto — to
prove the symptom it prevents still reproduces without it — pass an override
instead of monkeypatching. Monkeypatching cannot work here, because `merge.py`
binds those functions into its own namespace at import, and it would still
*appear* to work in the single-file build, where `build.py` flattens every module
into one shared namespace.

`static/js/` is ES modules. Each file declares what it imports, so load order is
no longer something you maintain by hand — `index.html` loads exactly one entry
point (`main.js`) and a new module just needs importing wherever it's used.

`main.js` also holds the **global bridge**: `index.html` and a lot of
JS-generated markup call functions straight from inline `onclick="…"`
attributes, which resolve against the global scope at click time. Module scope
isn't global, so `main.js` re-publishes every module's exports onto `window`.
That is one `Object.assign` over all 26 module namespaces, so **all 443
exports** end up global — of which about 103 are actually called from inline
handlers. The gap between those two numbers is the shim, not the target state.
To shrink it: convert inline handlers to `addEventListener` or event
delegation, then drop modules from that `Object.assign` as nothing in the
markup calls into them.

**Adding a chapter source** (a fourth alongside MangaDex, Suwayomi, and local
folder/CBZ) means writing one loader in `chapter-source.js` that returns a
`Chapter`, then registering it on each screen. It used to mean writing it twice —
once for the reader and once, near-identically, for the Erase Tool. The `Chapter`
shape is documented at the top of `chapter-source.js`; note `cacheable`, which is
what encodes "local pages don't survive a reload" as data rather than prose.

Three consequences worth knowing before editing `static/js/`:

- **You can't assign to another module's binding.** Imports are read-only. Shared
  mutable state goes through setters (`setCancelled()` in
  `state-and-constants.js`), and behaviour is added to another module's function
  by subscribing to a hook it exposes (`onAfterPageRender()` in `page-render.js`),
  never by reassigning it.
- **Prefer `export function` over `export const fn = …`.** Both work under ES
  modules, but the single-file build flattens everything into one classic script,
  where a top-level `const` is a lexical global (reachable from inline handlers,
  but not a `window` property) while a function declaration is both. Declarations
  keep `window.X` resolving identically in either build.
- **Top-level names must stay unique across all of `static/js/`.** Modules
  themselves don't require that, but `build.py` flattens them into one scope for
  the single-file build, where a collision is a redeclaration. The build fails
  loudly if two modules export the same name.

Run `python build.py` to produce `dist/MangaTL-Reader.py` — this is exactly what gets attached to a GitHub Release for the "just double-click it" crowd. Don't hand-edit the built file: fixes belong in `server.py`/`static/`, then re-run the build.
