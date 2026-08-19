"""
Text erasure: removing the original lettering from a page before the
translation is drawn back on top.

Three strategies, routed per region by the callers in server.py:

  - AI inpainting via a LaMa (Fast Fourier Convolution) checkpoint finetuned
    on anime/manga art. Best quality on textured or shaded bubbles, but needs
    torch and a ~200 MB download, so it degrades to the classical path rather
    than being a hard requirement — see _AiInpaintUnavailable.
  - Classical OpenCV inpainting, for textured regions without torch.
  - A cheap flat fill, for plain white/pale bubbles where inpainting would be
    strictly more work for an identical result (_region_is_flat_light picks it).

Plus the post-pass that catches what those miss: _detect_residual_smudge finds
leftover glyph fragments just outside the box the OCR reported, and
_reerase_smudged_regions widens and re-erases them.

The LaMa checkpoint is downloaded on demand into _MODEL_CACHE_DIR (a models/
folder next to server.py) and MD5-verified. That directory is gitignored — the
checkpoint is a runtime cache, never a committed asset.
"""

import importlib.util
import os
import subprocess
import sys
import threading

import cv2
import numpy as np
from PIL import Image, ImageDraw

def _ring_region(cv_img: np.ndarray, x1: int, y1: int, x2: int, y2: int, ring: int = 10):
    """Shared sampling step for _region_texture_variance / _region_is_flat_light:
    returns (gray, ring_mask) for the `ring`-px padding donut around a box —
    gray is the padded crop converted to grayscale (kept as a normal 2-D
    array, not pre-flattened, so cv2.Laplacian still sees real pixel
    neighbours at every point); ring_mask is a same-shape boolean array
    that's True everywhere in that crop EXCEPT the box's own interior.

    BUG THIS FIXES: both callers run before the box's original text has been
    erased, so the interior still contains the source-language glyphs. The
    previous version measured variance/range/brightness over the WHOLE
    padded box — interior included — despite both docstrings already
    claiming to sample "a ring just outside the box". In practice that meant
    any box snugly fit around real text (i.e. almost every OCR box) scored
    huge variance and near-black-to-white range from the glyphs themselves,
    so _region_is_flat_light returned False for ordinary flat-white speech
    bubbles almost every time — they'd go through cv2.inpaint instead of the
    cheap flat-fill path, and inpainting a "hole" whose own boundary ring
    still has the text's ink in it produces a visible grayish smudge/cloud
    even though the bubble is genuinely flat. Callers should compute their
    filter over the full `gray` array (real neighbours for the Laplacian
    kernel) and apply `ring_mask` only when reducing to a scalar statistic —
    never index gray down to the ring before filtering, or the 2nd-derivative
    kernel loses its real neighbours at the mask boundary.

    Returns (None, None) if the padded box falls outside the image.
    """
    h, w = cv_img.shape[:2]
    rx1, ry1 = max(0, x1 - ring), max(0, y1 - ring)
    rx2, ry2 = min(w, x2 + ring), min(h, y2 + ring)
    if rx2 <= rx1 or ry2 <= ry1:
        return None, None
    crop = cv_img[ry1:ry2, rx1:rx2]
    if crop.size == 0:
        return None, None
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    mask = np.ones(gray.shape, dtype=bool)
    iy1, iy2 = max(0, y1 - ry1), min(gray.shape[0], y2 - ry1)
    ix1, ix2 = max(0, x1 - rx1), min(gray.shape[1], x2 - rx1)
    mask[iy1:iy2, ix1:ix2] = False
    return gray, mask

def _region_texture_variance(cv_img: np.ndarray, x1: int, y1: int, x2: int, y2: int) -> float:
    """Estimate how textured the area just around a box is (screentone /
    gradient background vs. a flat bubble fill), by looking at the Laplacian
    variance of a ring just outside the box. Flat fills → near-zero variance;
    halftone/screentone or gradient art → noticeably higher.

    Used to choose between INPAINT_NS and INPAINT_TELEA per-region: TELEA
    (fast marching) tends to reproduce sharp structure/edges better, while NS
    (Navier-Stokes) tends to preserve smooth gradients and continuous texture
    better. Neither is uniformly best — picking per-region based on measured
    texture beats hardcoding one for the whole page."""
    gray, ring_mask = _ring_region(cv_img, x1, y1, x2, y2)
    if gray is None or not ring_mask.any():
        return 0.0
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    return float(lap[ring_mask].var())

# Texture-variance threshold separating "flat/smooth background" from
# "screentone/halftone/gradient background" for inpaint-method selection.
# Chosen empirically against typical manga page screentone density —
# flat bubble fills and clean gradients sit well under this, dot-pattern
# screentone sits well over it.
_TEXTURE_VARIANCE_THRESHOLD = 120.0

# erase_mode="auto" routing threshold: how much of the ring just outside a
# box has to sit within _FLATTEN_TONE_TOLERANCE of one dominant tone before
# that box is treated as flat-fillable instead of inpainted.
#
# This replaced a stricter Laplacian-variance + min/max-range check that
# looked good against a clean synthetic test image but was wrong for real
# input: actual scanlation raws carry JPEG/WebP recompression noise, faint
# rescan dithering, and antialiasing right at a bubble's own printed
# outline — plenty to blow a strict "near-zero variance, <20 gray-level
# range" bar even on a bubble that is, for every practical purpose, one
# flat color. That pushed real flat bubbles into cv2.inpaint, which then
# has nothing to reconstruct but noise, and visibly smudges.
#
# The fix asks a more forgiving question: not "is this ring perfectly
# uniform" but "does one dominant tone cover most of it". Take the ring's
# median as the dominant tone (median, not mean, for the same reason
# _erase_region_flatten already uses it — robust to the minority of ring
# pixels that are still text ink) and require _FLATTEN_COVERAGE_THRESHOLD
# of ring pixels to land within _FLATTEN_TONE_TOLERANCE gray levels of it.
# Scan noise nudges individual pixels by a few levels but doesn't change
# what the dominant tone *is* or how much of the ring matches it, so this
# stays robust where the old variance check wasn't. Real screentone/
# gradient/multi-region rings still correctly fail: halftone dots alone
# typically cover 20-50%+ of a ring in a different tone, well under the
# coverage bar.
_FLATTEN_TONE_TOLERANCE = 18     # gray levels; ring pixels within this of

                                  # the dominant tone count as "matching" it
_FLATTEN_COVERAGE_THRESHOLD = 0.85  # fraction of the ring that must match

def _region_is_flat_light(cv_img: np.ndarray, x1: int, y1: int, x2: int, y2: int) -> bool:
    """True if the area around this box is dominated by one consistent
    tone (see _FLATTEN_TONE_TOLERANCE / _FLATTEN_COVERAGE_THRESHOLD above).
    Used by erase_mode="auto" to route a region to the cheap flat-fill path
    instead of cv2.inpaint.

    No longer requires that dominant tone to be *light*. The old version
    gated on ring brightness >= 200 on the theory that a flat dark region
    was more likely intentional shading, worth inpainting rather than
    painting over blind. But _erase_region_flatten already samples
    whatever color the ring actually is (not hardcoded white), and
    _region_text_color already switches to white text automatically when
    the erased result comes out dark — so a solid black caption box is
    just as valid a flatten target as a white bubble, and routing it
    through inpaint instead bought nothing but inpaint-artifact risk.

    Reuses _region_texture_variance's ring-sampling approach (same
    _ring_region helper — the box's own interior, which still has the
    original text in it at this point, is excluded)."""
    gray, ring_mask = _ring_region(cv_img, x1, y1, x2, y2)
    if gray is None or not ring_mask.any():
        return False
    ring_px = gray[ring_mask]
    dominant = float(np.median(ring_px))
    matches = np.abs(ring_px.astype(np.int16) - dominant) <= _FLATTEN_TONE_TOLERANCE
    return float(np.mean(matches)) >= _FLATTEN_COVERAGE_THRESHOLD

# ─── AI (LaMa) inpaint — optional, heavier alternative to NS/TELEA ───────────
# Classical cv2.inpaint (NS/TELEA, below) is PDE-based diffusion: it
# extrapolates fill pixels from the mask boundary inward using local
# pixel-intensity gradients. That works fine for flat fills and simple
# gradients, but it has no concept of "this is hair" or "this screentone
# repeats" or "this line continues on the other side of the box" — on
# genuinely textured/baked-in-art regions it tends to smear rather than
# reconstruct (see this file's own texture-routing comments above
# _TEXTURE_VARIANCE_THRESHOLD). LaMa (a learned inpainting model) has actual
# priors over image structure/texture continuation, so it can do meaningfully
# better on exactly that class of region — at real cost: a ~200MB one-time
# model download, and CPU inference that's on the order of several seconds
# per page (not per box — see _erase_region_ai_inpaint's docstring), vs.
# near-instant for cv2.inpaint.
#
# UNVALIDATED CLAIM, same standard this file holds every other quality claim
# to: LaMa's advantage was NOT confirmed here against a real manga page with
# real baked-in art (hair/screentone/linework under a bubble) — only
# against a synthetic diagonal-hatching test image, where classical NS
# actually looked visually cleaner (a smooth gray smudge vs. LaMa's faint
# warm-toned ghost-of-the-mask-rectangle). Simple periodic low-contrast
# hatching is exactly the kind of texture classical inpainting already
# handles reasonably — it is NOT a stand-in for the irregular, semantically
# structured art (hair strands, crowd backgrounds, non-repeating linework)
# this feature is actually meant to help with. DO NOT treat this as "LaMa
# tested worse, don't bother" — the test was a bad proxy, not a real
# verdict — but also do not ship UI copy claiming "AI inpaint looks better"
# until it's actually been checked against a real scanlation page with real
# textured art under text, the same bar RapidOCR's per-language
# recommendations and every threshold in this file were held to before
# being trusted.
#
# Lazy singleton, mirrors _get_rapidocr_engine()'s pattern: import torch and
# download the model only on first actual use of this feature, not at server
# startup, so a person who never enables this setting never pays its cost.
_lama_engine = None

_lama_engine_lock = threading.Lock()

_lama_infer_lock  = threading.Lock()   # serialises PyTorch inference

# Long-edge cap (px) for the image actually handed to LaMa's forward pass.
# LaMa's own paper trains at 256x256 and demonstrates the model generalises
# WITHOUT further training up to 1536x1536; the paper's broader claim is good
# results to roughly ~2k. Past that there's no evidence of a quality payoff,
# only more CPU time -- exactly the wrong trade on the low-end hardware this
# project targets. MangaDex pages are already web-sized and rarely hit this,
# but local-folder/CBZ mode has no pixel-dimension ceiling (only the 25MB
# encoded-payload cap in _load_image_bytes, which a well-compressed high-DPI
# raw scan can clear easily) -- so this only matters for that source, but
# matters a lot when it applies. Classical cv2.inpaint does NOT get this
# treatment: its cost is dominated by mask area, not image size, and it's
# already fast regardless of page resolution.
_LAMA_MAX_DIM = 1536

# Where downloaded model checkpoints get cached locally, so re-launching the
# app doesn't re-download a ~200MB file every time. Didn't already exist
# anywhere in this file (checked -- only precedent was rates.json using
# __file__-relative pathing, no dedicated model-cache dir), so defined here
# following that same pattern rather than inventing a second convention.
# A "models" subfolder next to server.py -- gets created on first use if
# missing (see _download_lama_checkpoint's os.makedirs call).
_MODEL_CACHE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "models"
)

# Anime/manga-finetuned big-lama checkpoint, ~300k manga+anime training
# images -- same weights IOPaint ships as --model=anime-lama.
#
# IMPORTANT: this is Sanster/models' pre-converted TorchScript .pt, NOT
# dreMaz/AnimeMangaInpainting's raw lama_large_512px.ckpt on Hugging Face.
# Same underlying weights, different file format:
#   - dreMaz's .ckpt on HF is a raw training state_dict (keyed under
#     "gen_state_dict") -- CONFIRMED BROKEN for this loader: torch.jit.load
#     fails on it with "failed locating file constants.pkl". Using it would
#     need the original advimman/lama model class to reconstruct the module,
#     load_state_dict onto it, then script/trace it -- extra work, and not
#     what's used below.
#   - Sanster/models' anime-manga-big-lama.pt IS a real TorchScript archive
#     -- CONFIRMED by unzipping it directly: root contains constants.pkl,
#     data.pkl, version, and a code/ tree with the actual scripted
#     saicinpainting.training.modules.ffc (Fast Fourier Convolution) module
#     graph, i.e. LaMa's real architecture, serialized whole. This is what
#     IOPaint's own --model=anime-lama loads via load_jit_model -- same
#     packaging as vanilla big-lama.pt, just different weights. MD5 of a
#     verified download matches IOPaint's own declared checksum exactly.
#
# Same forward-pass signature (image, mask) -> image either way -- no other
# code in _erase_region_ai_inpaint needs to change, only which weights load.
_ANIME_MANGA_LAMA_URL = (
    "https://github.com/Sanster/models/releases/download/"
    "AnimeMangaInpainting/anime-manga-big-lama.pt"
)

_ANIME_MANGA_LAMA_MD5 = "29f284f36a0a510bcacf39ecf4c4d54f"

_ANIME_MANGA_LAMA_LOCAL_PATH = os.path.join(
    _MODEL_CACHE_DIR, "anime-manga-big-lama.pt"
)

# Threshold (0-255) for treating a page as grayscale before deciding whether
# to strip color from LaMa's output (see the neutralisation step in
# _erase_region_ai_inpaint below). Measured directly against a real B&W manga
# page: legitimate JPEG chroma noise on an actually-grayscale scan tops out
# around 12-18 at the 99th percentile (edge-ringing near sharp black/white
# transitions, not real color); a genuinely colored page would show far more
# pervasive channel difference than that, not just occasional edge outliers.
# 20 leaves comfortable margin above the noise floor without being so loose it
# would misclassify real color content. Only checked against ONE sample page
# so far, though -- same standard as every other threshold in this file: sanity-
# check it against a few more real pages (including an actual color/manhwa
# page if this project ever handles those) before fully trusting it.
_GRAYSCALE_CHANNEL_TOLERANCE = 20

class _AiInpaintUnavailable(Exception):
    """Raised when AI inpaint was requested but the model/dependency isn't
    available (missing package, download failure, etc.) — kept as its own
    exception type (rather than a bare Exception) so the /export-page route
    can surface this as a specific, actionable 503 instead of folding it
    into the generic 422 'Typesetting failed' every other typesetting error
    returns. A person who opted into this feature and hits a missing-
    dependency case needs to know THAT'S what happened, not just that
    typesetting failed for some unspecified reason."""
    pass

def _download_lama_checkpoint(url: str, dest_path: str, expected_md5: str = None,
                               chunk_size: int = 1 << 20) -> None:
    """Stream-download a LaMa checkpoint to dest_path, verifying its MD5 if
    given. Raises _AiInpaintUnavailable on any failure (network error,
    checksum mismatch, etc.) rather than leaving a corrupt/partial file
    behind for the next call to trip over silently.

    Downloads to a .part sibling file first and renames on success, so a
    failed/interrupted download never leaves something at dest_path that
    os.path.exists() would treat as "already cached" on the next call.
    """
    import hashlib
    import urllib.request

    tmp_path = dest_path + ".part"
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    try:
        md5 = hashlib.md5() if expected_md5 else None
        with urllib.request.urlopen(url, timeout=60) as resp, \
             open(tmp_path, "wb") as f:
            while True:
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                if md5 is not None:
                    md5.update(chunk)

        if expected_md5 is not None:
            actual = md5.hexdigest()
            if actual.lower() != expected_md5.lower():
                raise _AiInpaintUnavailable(
                    f"Downloaded LaMa checkpoint failed MD5 verification "
                    f"(expected {expected_md5}, got {actual}) -- the "
                    f"download was likely corrupted or interrupted. Try "
                    f"again; if this keeps happening the upstream file may "
                    f"have changed."
                )

        os.replace(tmp_path, dest_path)  # atomic on same filesystem
    except _AiInpaintUnavailable:
        raise
    except Exception as e:
        raise _AiInpaintUnavailable(
            f"Failed to download LaMa checkpoint from {url}: {e}"
        )
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

def _get_lama_engine():
    """Lazily construct and cache the LaMa inpainting engine. First call
    triggers a torch import and (if not already cached locally by the
    underlying library) a ~200MB model download — both deliberately deferred
    to here rather than server startup, matching _get_rapidocr_engine()'s
    same "don't cost anyone who doesn't use this feature" reasoning.

    Raises _AiInpaintUnavailable on failure (missing package, download
    failure, corrupt cache, etc.) with a plain-language message — caller is
    responsible for turning that into a user-facing error, not swallowing
    it, since a silent fallback to classical inpaint would defeat the point
    of the person having explicitly opted into this mode.

    DELIBERATELY NOT in _REQUIRED / _bootstrap() above: this needs
    torch, which is a real multi-hundred-MB install on top of the LaMa
    model weights themselves — adding it to the mandatory first-run
    bootstrap would slow down and bloat the install for every single user
    of this tool, including the (likely large) majority who will never
    touch this optional feature. Auto-installed here instead, lazily, only
    for someone who actually flips this setting on — same one-time-cost-
    only-if-you-use-it shape as the model download itself.
    """
    global _lama_engine
    if _lama_engine is not None:
        return _lama_engine
    with _lama_engine_lock:
        if _lama_engine is not None:
            return _lama_engine
        try:
            if importlib.util.find_spec("simple_lama_inpainting") is None:
                print("  [AI inpaint] First use — installing "
                      "simple-lama-inpainting (pulls in torch if not "
                      "already present; this can take a few minutes and "
                      "is a one-time cost)...")
                subprocess.check_call(
                    [sys.executable, "-m", "pip", "install", "--quiet",
                     "--break-system-packages", "simple-lama-inpainting"]
                )
            # Download the manga/anime-finetuned checkpoint if it isn't
            # already cached locally. NOTE: condition is "does NOT exist" --
            # we only need to fetch it once, ever, per machine.
            if not os.path.exists(_ANIME_MANGA_LAMA_LOCAL_PATH):
                print("  [AI inpaint] First use — downloading manga/anime "
                      "LaMa checkpoint (~200MB, one-time)...")
                _download_lama_checkpoint(
                    _ANIME_MANGA_LAMA_URL,
                    _ANIME_MANGA_LAMA_LOCAL_PATH,
                    expected_md5=_ANIME_MANGA_LAMA_MD5,
                )

            # simple_lama_inpainting's actual source (models/model.py) reads
            # the LAMA_MODEL env var for its checkpoint override -- NOT
            # LAMA_CHECKPOINT_PATH, which it does not recognise and would
            # silently ignore, leaving it to fall back to its own default
            # vanilla checkpoint. Confirmed against the library's real source
            # on GitHub before relying on this, rather than assumed.
            os.environ["LAMA_MODEL"] = _ANIME_MANGA_LAMA_LOCAL_PATH

            from simple_lama_inpainting import SimpleLama
            _lama_engine = SimpleLama()
            print("  [AI inpaint] LaMa model ready.")
            return _lama_engine
        except subprocess.CalledProcessError as e:
            raise _AiInpaintUnavailable(
                "AI inpaint's dependencies failed to auto-install. Run "
                "manually: pip install simple-lama-inpainting"
            ) from e
        except ImportError as e:
            raise _AiInpaintUnavailable(
                "AI inpaint isn't installed. Run: pip install "
                "simple-lama-inpainting (see README)."
            ) from e
        except Exception as e:
            raise _AiInpaintUnavailable(
                f"AI inpaint model failed to load: {e}"
            ) from e

def _erase_region_ai_inpaint(cv_img: np.ndarray, boxes_px: list,
                              blend_base_img: np.ndarray = None) -> np.ndarray:
    """LaMa counterpart to _erase_region_inpaint — same batched-mask,
    safety-margin, and feathering approach, only the fill algorithm differs.

    blend_base_img: what the final feather-blend (bottom of this function)
    falls back to OUTSIDE the mask. Defaults to cv_img itself — the normal
    case, where the caller wants everywhere outside the mask left exactly
    as they gave it to us. Only _reerase_smudged_regions' retry path passes
    something different: it wants LaMa's own reconstruction to see the true
    ORIGINAL source pixels as `cv_img` (not the first pass's already-erased/
    gray-filled pixels, which would bias the reconstruction toward whatever
    the first pass produced) while still wanting the outside-mask fallback
    to be the ALREADY-ERASED page from the first pass. Those are two
    different concerns that used to be conflated into one `cv_img`
    parameter: passing orig_cv_img for both meant the blend fell back to
    the pristine, un-erased original everywhere outside the retry boxes —
    silently reverting every previously-erased region on the page back to
    raw source pixels, with translated text then drawn on top of it by the
    typeset step. See _reerase_smudged_regions' docstring for the confirmed
    bug this parameter exists to fix.

    Deliberately does NOT do the NS-vs-TELEA texture-variance split
    _erase_region_inpaint uses: that split exists because classical inpaint
    needs a different algorithm depending on local texture (flat vs.
    gradient/structured). A single learned model doesn't have that same
    per-method weakness, so every masked region here goes through one LaMa
    call regardless of its own texture — simpler, and there's no evidence
    (yet) that a texture-aware split would help a learned model the way it
    helps the two classical methods.

    One inference call per page (all regions batched into a single mask),
    not one per region — LaMa's cost is dominated by the forward pass
    itself, not mask area, so batching everything on the page into one call
    is the only sane way to keep this from scaling linearly with region
    count. Still measured at ~8s/page on CPU for a small test image during
    development — see the module-level comment above this function for full
    context; expect real full-resolution manga pages to cost more, not less.

    Pages whose long edge exceeds _LAMA_MAX_DIM are downscaled before this
    call and the RESULT upscaled back to (h, w) afterward (see below) --
    caps worst-case CPU/memory cost on an oversized local-folder/CBZ scan
    without touching quality on the typical page, which is already well
    under the cap. See _LAMA_MAX_DIM's own comment for why 1536 specifically.
    """
    if blend_base_img is None:
        blend_base_img = cv_img

    _ERASE_SAFETY_MARGIN = 2
    h, w = cv_img.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    for (x1, y1, x2, y2) in boxes_px:
        m = _ERASE_SAFETY_MARGIN
        ey1, ey2 = max(0, y1 - m), min(h, y2 + m)
        ex1, ex2 = max(0, x1 - m), min(w, x2 + m)
        mask[ey1:ey2, ex1:ex2] = 255

    engine = _get_lama_engine()

    # Downscale image+mask together (same scale factor, so they stay pixel-
    # aligned) if the page exceeds _LAMA_MAX_DIM on its long edge -- INTER_AREA
    # for the image (best for shrinking photographic/screentoned content),
    # INTER_NEAREST for the mask (must stay strictly binary 0/255; any
    # interpolation that produces in-between values would hand the "binary
    # mask" library a mask that isn't one -- see simple-lama-inpainting's own
    # docs). `mask` and `cv_img` themselves are left untouched here: the
    # feather blend at the bottom of this function still needs the ORIGINAL
    # full-resolution versions of both.
    scale = min(1.0, _LAMA_MAX_DIM / max(h, w))
    if scale < 1.0:
        sw, sh = max(1, round(w * scale)), max(1, round(h * scale))
        infer_img  = cv2.resize(cv_img, (sw, sh), interpolation=cv2.INTER_AREA)
        infer_mask = cv2.resize(mask, (sw, sh), interpolation=cv2.INTER_NEAREST)
    else:
        infer_img, infer_mask = cv_img, mask

    img_pil = Image.fromarray(cv2.cvtColor(infer_img, cv2.COLOR_BGR2RGB))
    mask_pil = Image.fromarray(infer_mask)
    # Serialised: LaMa's forward pass goes through the same PyTorch
    # thread-safety concern _infer_lock already documents for EasyOCR --
    # threaded=True means two requests (e.g. the export panel running
    # while the Erase Tool is used in another tab) could otherwise call
    # into the model at once. Costs nothing on a single request, same as
    # the other two inference locks.
    with _lama_infer_lock:
        result_pil = engine(img_pil, mask_pil)
    result = cv2.cvtColor(np.array(result_pil), cv2.COLOR_RGB2BGR)

    # LaMa's public checkpoint is trained on natural color photographs, and can
    # invent small amounts of real (non-JPEG-noise) chroma in a reconstructed
    # patch even when the rest of the page carries none -- observed directly on
    # a real test page as faint colored specks in an otherwise pure-grayscale
    # scan. There's no legitimate reason for an inpainted patch to carry color
    # the source page never had, so on a page that's grayscale to begin with,
    # force the model's output back to match it. Checked against the ORIGINAL
    # page (cv_img), not the model's result -- classifying "is this page
    # grayscale" from pristine pixels rather than from what the model just
    # produced. Skipped entirely on a genuinely color source (manhwa/colored
    # webtoons): forcibly desaturating the model's output there would be a
    # worse bug than the one this fixes.
    src_b, src_g, src_r = (cv_img[..., i].astype(np.int16) for i in range(3))
    chroma_p99 = max(
        np.percentile(np.abs(src_r - src_g), 99),
        np.percentile(np.abs(src_g - src_b), 99),
        np.percentile(np.abs(src_r - src_b), 99),
    )
    if chroma_p99 <= _GRAYSCALE_CHANNEL_TOLERANCE:
        result = cv2.cvtColor(cv2.cvtColor(result, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)

    # Restores (h, w) two ways at once: the intentional case (we downscaled
    # above, so result always comes back at (sw, sh) and needs upscaling to
    # match the original page for the feather blend below) and the
    # incidental case (some LaMa builds return a slightly different size
    # than whatever they were given -- internal padding to a stride
    # multiple, not always cropped back perfectly). Same fix either way, so
    # one unconditional shape check covers both rather than needing to know
    # which case actually happened.
    if result.shape[:2] != (h, w):
        result = cv2.resize(result, (w, h), interpolation=cv2.INTER_LANCZOS4)

    # Same feathering as _erase_region_inpaint — algorithm-agnostic: it just
    # blends "new pixels" against "original pixels" at the mask edge,
    # regardless of which method produced the new pixels.
    feather_px = 5
    soft_mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=feather_px / 2)
    alpha = (soft_mask.astype(np.float32) / 255.0)[..., None]
    blended = (result.astype(np.float32) * alpha +
               blend_base_img.astype(np.float32) * (1 - alpha))
    return blended.astype(np.uint8)

def _erase_region_inpaint(cv_img: np.ndarray, boxes_px: list) -> np.ndarray:
    """Erase all given pixel boxes at once via inpainting, then feather the
    inpainted patch back into the original image at the mask edges so the
    boundary isn't a visible hard-edged rectangle.

    Two things changed from a single fixed-method whole-page approach:

    1. Per-region method choice (NS vs TELEA). cv2.inpaint's cost scales
       with mask area, not call count, so batching every region into one
       mask + one inpaint call is still right — but a single inpaint method
       isn't a great fit for a whole page at once, since a page can easily
       mix flat speech-bubble fills with heavily screentoned background art
       behind a caption box. We measure local texture variance per region
       (see _region_texture_variance) and split regions into two mask
       groups — smooth (TELEA, better at preserving sharp local structure)
       and textured (NS, better at continuing smooth gradients/texture) —
       each inpainted separately, then composited back together.

    2. Feathered compositing. cv2.inpaint's own output already has a hard
       mask boundary; naive compositing can leave a faint seam exactly at
       the old text-box edge. We blur the mask before using it as an alpha
       blend, so the transition between "erased" and "original" pixels is
       gradual over a few pixels rather than a hard cut.

    BUG FIXED HERE: this used to shrink the erase rect a few percent inward
    from the OCR box before building `mask`, on the assumption that OCR
    boxes are always a bit looser than the actual glyph ink. In practice
    OCR/manual boxes are often snug — ascenders, descenders, and serifs
    routinely touch or nearly touch the box edge — so that shrink regularly
    left a thin un-erased margin with real glyph ink still in it. Feathering
    then made it worse: it blurred *that same shrunk mask* and alpha-blended
    back toward `cv_img` — the untouched original, text and all — which
    means the blend-back-to-original zone started at the shrunk boundary,
    i.e. *inside* the nominal OCR box, exactly where remaining glyph ink was
    most likely to be. Net effect: fragments of the original-language text
    could visibly survive right at the edge of an "erased" region.

    Fix: erase the box exactly as given plus a small OUTWARD safety margin
    (2px — see _ERASE_SAFETY_MARGIN below), instead of shrinking it, and
    feather using that same expanded mask, so the blur's alpha ramp is
    centered on the *expanded* boundary and only blends back toward the
    original in a thin ring past that — real bubble/panel background the
    OCR box already decided wasn't part of the text — never inside the
    box where ink could still be.

    The outward margin matters on its own, separately from the shrink bug:
    debugging this against a glyph pixel sitting exactly one px past the
    nominal box (a realistic OCR-undershoot case) showed cv2.inpaint pulls
    real color from *just outside* the mask, since that pixel is valid
    unmasked boundary data as far as the algorithm's concerned — a stray
    edge pixel right outside an exact-fit mask still visibly bleeds inward.
    A couple of extra masked px is cheap insurance against that; it costs
    nothing on a box that was already generous.
    """
    _ERASE_SAFETY_MARGIN = 2
    mask = np.zeros(cv_img.shape[:2], dtype=np.uint8)
    smooth_mask = np.zeros(cv_img.shape[:2], dtype=np.uint8)
    textured_mask = np.zeros(cv_img.shape[:2], dtype=np.uint8)
    h, w = cv_img.shape[:2]

    for (x1, y1, x2, y2) in boxes_px:
        m = _ERASE_SAFETY_MARGIN
        ey1, ey2 = max(0, y1 - m), min(h, y2 + m)
        ex1, ex2 = max(0, x1 - m), min(w, x2 + m)
        mask[ey1:ey2, ex1:ex2] = 255
        variance = _region_texture_variance(cv_img, x1, y1, x2, y2)
        if variance >= _TEXTURE_VARIANCE_THRESHOLD:
            textured_mask[ey1:ey2, ex1:ex2] = 255
        else:
            smooth_mask[ey1:ey2, ex1:ex2] = 255

    result = cv_img.copy()
    if np.any(smooth_mask):
        result = cv2.inpaint(result, smooth_mask, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
    if np.any(textured_mask):
        result = cv2.inpaint(result, textured_mask, inpaintRadius=7, flags=cv2.INPAINT_NS)

    # Feather: blur the (full, unshrunk) mask so the alpha blend between
    # inpainted and original pixels ramps smoothly over ~5px straddling the
    # box boundary, instead of cutting hard at the mask edge. This is a
    # cosmetic seam fix, not a correctness one now — the ramp's "toward
    # original" half falls outside the erased box, not inside it.
    feather_px = 5
    soft_mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=feather_px / 2)
    alpha = (soft_mask.astype(np.float32) / 255.0)[..., None]
    blended = (result.astype(np.float32) * alpha +
               cv_img.astype(np.float32) * (1 - alpha))
    return blended.astype(np.uint8)

def _erase_region_flatten(pil_img: Image.Image, x1: int, y1: int, x2: int, y2: int) -> None:
    """Cheaper erase: sample the box's border pixels for a fill color and
    paint a solid rectangle. Mutates pil_img in place. Good for flat-white
    bubbles; the caller picks this vs. inpaint via erase_mode.

    Paints a couple px past the given box (same _ERASE_SAFETY_MARGIN
    reasoning as _erase_region_inpaint) rather than exactly to it — an OCR
    box that slightly undershoots the real glyph extent would otherwise
    leave a sliver of original ink sitting just outside a "flattened"
    rectangle, same failure mode as the inpaint path had."""
    draw = ImageDraw.Draw(pil_img)
    # Sample a thin ring just outside the box (clamped to image bounds) to
    # estimate the bubble's fill color without including the text itself.
    w, h = pil_img.size
    margin = 2
    ring_box = (max(0, x1 - 2), max(0, y1 - 2), min(w, x2 + 2), min(h, y2 + 2))
    ring = pil_img.crop(ring_box)
    ring_arr = np.array(ring)
    if ring_arr.size:
        # Median is robust against the dark text pixels still present in the ring.
        fill = tuple(int(v) for v in np.median(ring_arr.reshape(-1, ring_arr.shape[-1]), axis=0)[:3])
    else:
        fill = (255, 255, 255)
    draw.rectangle([max(0, x1 - margin), max(0, y1 - margin),
                    min(w, x2 + margin), min(h, y2 + margin)], fill=fill)

# ─── Post-erase smudge detection & escalation ────────────────────────────────
# Neither erase path (_erase_region_inpaint/_erase_region_ai_inpaint's
# batched cv2/LaMa fill, or _erase_region_flatten's solid rectangle) can
# tell on its own whether it actually finished the job. An OCR (or manual)
# box that undershoots the real glyph extent — snug boxes routinely do,
# ascenders/descenders/serifs right at the edge, a bubble whose text sits
# close to its own outline — leaves a fragment of original-language ink
# sitting just outside the erased rectangle: a visible dark smudge, or in
# mild cases a recognizable leftover letter. This is checked for AFTER
# erase, per-region, against the PRISTINE pre-erase page (not the erased
# output alone — see _detect_residual_smudge's docstring for why that
# distinction matters), and any region that still shows real leftover ink
# is escalated: its own erase box is widened to the true extent of the
# glyph run that was missed, then that widened box alone is re-erased
# through AI inpaint (LaMa) if available, since a second pass with the
# same algorithm on a still-too-small box would very often just leave the
# same problem shifted rather than solved.
_SMUDGE_DARK_DELTA = 45          # gray-level deviation from the region's own

                                  # reference tone before a pixel counts as
                                  # "still has real content", not noise
_SMUDGE_DARK_RATIO_THRESHOLD = 0.006   # fraction of the box interior that

                                        # must deviate before flagging
_SMUDGE_MIN_BLOB_PX = 12         # OR: one compact deviating blob at least

                                  # this big — catches a small corner-clipped
                                  # letter even when it's a tiny fraction of
                                  # a large box's total area
_GLYPH_EXPAND_MAX_PX = 60         # how far _expand_box_to_glyph_extent's

def _detect_residual_smudge(orig_cv_img: np.ndarray, erased_cv_img: np.ndarray,
                             x1: int, y1: int, x2: int, y2: int,
                             bubble_label_map=None) -> tuple:
    """True if this box still shows real leftover source-page content after
    erase — i.e. the erase undershot and a smudge or letter fragment
    survived. Returns (is_smudged, dark_fraction, largest_blob_px).

    Compares the erased box's interior against the PRISTINE pre-erase page
    at the same coordinates, not against a reference color inferred from
    context alone. This is the difference that makes the check reliable:
    an earlier version tried to infer whether erased pixels were "too dark"
    purely from the erased image plus a ring/bubble-median reference color,
    and that reliably false-positived on a real, different defect —
    cv2.inpaint bleeding a few pixels of a bubble's own black outline
    inward when a box's safety margin happens to reach the outline, even
    though the box had zero real text-ink content to begin with. That
    outline-bleed and genuine leftover glyph ink both look like "dark
    pixels in the erased box" from the erased image alone; only the
    ORIGINAL page can tell them apart. A pixel counts as residual smudge
    only if it deviated from the region's reference tone in the ORIGINAL
    (i.e. real content — ink or an outline sliver — was actually there)
    AND still deviates after erase (i.e. it wasn't actually removed).
    Pixels that are newly dark only in the erased output (inpaint's own
    output artifacts) are deliberately not counted — a separate, real, but
    much less common defect class not handled by this check.

    Deviation is measured with abs(), so this catches both directions —
    dark ink left on a light bubble AND light/white ink left un-erased on
    a dark caption box (that class of box also exists — see
    _region_is_flat_light's own note that flat-fill no longer requires
    light backgrounds).

    Reference tone: same bubble-interior sampling _detect_residual_smudge's
    caller already has available via bubble_label_map (the connected-
    component "flat + light" segmentation _find_bubble_components computes
    for OCR merging — reused here rather than recomputed), falling back to
    a ring around the box when the box doesn't fall inside any detected
    bubble component (e.g. a caption box, which is deliberately excluded
    from that light-only segmentation, or a manual Erase Tool box drawn
    outside any auto-detected bubble).
    """
    h, w = erased_cv_img.shape[:2]
    gray_new = cv2.cvtColor(erased_cv_img, cv2.COLOR_BGR2GRAY) if erased_cv_img.ndim == 3 else erased_cv_img
    gray_old = cv2.cvtColor(orig_cv_img, cv2.COLOR_BGR2GRAY) if orig_cv_img.ndim == 3 else orig_cv_img

    ref_val = None
    if bubble_label_map is not None:
        cy, cx = (y1 + y2) // 2, (x1 + x2) // 2
        cy, cx = min(max(cy, 0), h - 1), min(max(cx, 0), w - 1)
        label = bubble_label_map[cy, cx]
        if label != 0:
            bubble_mask = (bubble_label_map == label)
            excl = np.zeros((h, w), dtype=bool)
            m = 4
            excl[max(0, y1 - m):min(h, y2 + m), max(0, x1 - m):min(w, x2 + m)] = True
            ref_pixels = gray_new[bubble_mask & ~excl]
            if ref_pixels.size >= 50:
                ref_val = float(np.median(ref_pixels))
    if ref_val is None:
        ring = 12
        rx1, ry1 = max(0, x1 - ring), max(0, y1 - ring)
        rx2, ry2 = min(w, x2 + ring), min(h, y2 + ring)
        crop = gray_new[ry1:ry2, rx1:rx2]
        ring_mask = np.ones(crop.shape, dtype=bool)
        iy1, iy2 = max(0, y1 - ry1), min(crop.shape[0], y2 - ry1)
        ix1, ix2 = max(0, x1 - rx1), min(crop.shape[1], x2 - rx1)
        ring_mask[iy1:iy2, ix1:ix2] = False
        ring_px = crop[ring_mask]
        ref_val = float(np.median(ring_px)) if ring_px.size else 255.0

    new_interior = gray_new[y1:y2, x1:x2]
    old_interior = gray_old[y1:y2, x1:x2]
    if new_interior.size == 0:
        return False, 0.0, 0

    was_off_ref   = np.abs(old_interior.astype(np.int16) - ref_val) >= _SMUDGE_DARK_DELTA
    still_off_ref = np.abs(new_interior.astype(np.int16) - ref_val) >= _SMUDGE_DARK_DELTA
    residual_mask = (was_off_ref & still_off_ref).astype(np.uint8)

    dark_fraction = float(np.mean(residual_mask))
    largest_blob = 0
    if residual_mask.any():
        n, _, stats, _ = cv2.connectedComponentsWithStats(residual_mask, connectivity=8)
        if n > 1:
            largest_blob = int(stats[1:, cv2.CC_STAT_AREA].max())

    is_smudged = (dark_fraction >= _SMUDGE_DARK_RATIO_THRESHOLD) or (largest_blob >= _SMUDGE_MIN_BLOB_PX)
    return is_smudged, dark_fraction, largest_blob

def _expand_box_to_glyph_extent(gray_orig: np.ndarray, x1: int, y1: int, x2: int, y2: int,
                                 dark_floor: int = 200) -> tuple:
    """Given a box that _detect_residual_smudge flagged, find how far the
    text run it partially covers actually extends on the PRISTINE original
    page, so the retry erase can cover it in one shot instead of chasing
    leftover fragments across repeated passes (tried first — see this
    feature's design notes: re-erasing only the same undersized box through
    a different algorithm, or growing it by a fixed margin/percentage,
    both left visible fragments in testing against a real undershoot case).

    Method: threshold the original page for dark content, dilate it a
    little horizontally (bridges the gap between adjacent letters in the
    same word/line — most manga fonts leave a few px of whitespace between
    glyphs, comfortably smaller than the gap between separate words or
    unrelated dark content), then connected-label the dilated mask. Any
    label the ORIGINAL box already overlaps is treated as "the same text
    run this box was trying to cover" and the return box grows to fully
    contain it. Labels the box doesn't touch (a bubble's outline three
    words over, unrelated background art) are never pulled in, since nei-
    ther touches the box being expanded — this is what keeps the expansion
    targeted instead of ballooning toward every dark pixel on the page.

    Falls back to a modest fixed-pixel grow (same shape as
    _ERASE_SAFETY_MARGIN, just larger) if the box doesn't overlap any dark
    label on the original at all — can happen for the outline-bleed case
    _detect_residual_smudge's docstring describes, which reaches this
    function only if it also happens to clear the dark-ratio/blob bar on
    its own merits; a fixed grow is a reasonable, safe default when there's
    no real glyph run to size the expansion against.

    BOUNDED SEARCH WINDOW (fixes a confirmed runaway-expansion bug): the
    connected-component search below is run against a crop centered on the
    box, padded by _GLYPH_EXPAND_MAX_PX in every direction — NOT the whole
    page. A real missed glyph run (ascender/descender/serif/short word
    fragment right at a box's edge) never extends more than a few px past
    a box that already mostly covered it, so this window is already very
    generous for the legitimate case. Without this bound, connectedComponents
    ran on the FULL page: manga panel borders and dense edge-to-edge line
    art are routinely one single connected component spanning nearly the
    entire page, so a box that merely touched one pixel of a border (a
    bubble tail, a caption box, text near a panel edge — all common)
    inherited that component's full page-spanning bounding box, and the
    "retry" erase wiped almost the whole page. Cropping first means the
    search can never see, and therefore can never claim, anything outside
    the window — capping the worst-case growth structurally regardless of
    how connected the rest of the page's art happens to be.
    """
    h, w = gray_orig.shape[:2]

    m = _GLYPH_EXPAND_MAX_PX
    wx1, wy1 = max(0, x1 - m), max(0, y1 - m)
    wx2, wy2 = min(w, x2 + m), min(h, y2 + m)
    window = gray_orig[wy1:wy2, wx1:wx2]

    dark_full = (window < dark_floor).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 3))
    dilated = cv2.dilate(dark_full, kernel)
    _, labels = cv2.connectedComponents(dilated, connectivity=8)

    # Box coords translated into window-local space for indexing labels/dark_full.
    lx1, ly1 = x1 - wx1, y1 - wy1
    lx2, ly2 = x2 - wx1, y2 - wy1

    box_labels = set(np.unique(labels[ly1:ly2, lx1:lx2]).tolist()) - {0}
    if not box_labels:
        pad = 6
        return (max(0, x1 - pad), max(0, y1 - pad), min(w, x2 + pad), min(h, y2 + pad))

    extend_mask = np.isin(labels, list(box_labels)) & (dark_full > 0)
    ys, xs = np.where(extend_mask)
    # Translate back out of window-local space to full-page coords.
    ex1, ey1 = int(xs.min()) + wx1, int(ys.min()) + wy1
    ex2, ey2 = int(xs.max()) + 1 + wx1, int(ys.max()) + 1 + wy1

    pad = 3
    nx1 = max(0, min(x1, ex1) - pad)
    ny1 = max(0, min(y1, ey1) - pad)
    nx2 = min(w, max(x2, ex2) + pad)
    ny2 = min(h, max(y2, ey2) + pad)
    return (nx1, ny1, nx2, ny2)

def _reerase_smudged_regions(orig_cv_img: np.ndarray, cv_img: np.ndarray,
                              boxes_px: list, bubble_label_map=None) -> np.ndarray:
    """Post-erase pass: checks every already-erased box for leftover ink
    (_detect_residual_smudge) and, for any that still show real content,
    widens that box to the missed glyph run's true extent
    (_expand_box_to_glyph_extent) and re-erases just those widened boxes —
    batched into one mask/one call the same way the first pass is, so a
    page with several smudged regions still costs one extra inpaint call,
    not one per region.

    Always escalates to AI inpaint (LaMa) for the retry when it's
    available, regardless of what erased the page the first time (classical
    inpaint, flatten, or AI inpaint itself under a still-too-small box) —
    a flagged region has already demonstrated the cheaper/faster method
    wasn't enough, so this is exactly the "double check bubbles [for]
    smudge, then hand the task to AI-inpaint" behavior this feature exists
    for. Falls back to classical NS on the widened box when LaMa isn't
    installed/available (_AiInpaintUnavailable) — a widened box through
    classical inpaint is still very likely to succeed where the original
    undersized box didn't, since covering the real glyph extent was the
    actual fix in testing, not the choice of algorithm; AI inpaint is the
    better retry when available, not the only thing that can work.

    Mutates nothing in place; returns a new array. `cv_img` is the page
    AFTER the first erase pass (what gets patched); `orig_cv_img` is the
    untouched source page (what _detect_residual_smudge and
    _expand_box_to_glyph_extent both need to tell real leftover content
    apart from inpaint's own artifacts — see their docstrings).
    """
    gray_orig = cv2.cvtColor(orig_cv_img, cv2.COLOR_BGR2GRAY)
    retry_boxes = []
    for (x1, y1, x2, y2) in boxes_px:
        is_smudged, _frac, _blob = _detect_residual_smudge(
            orig_cv_img, cv_img, x1, y1, x2, y2, bubble_label_map)
        if is_smudged:
            retry_boxes.append(_expand_box_to_glyph_extent(gray_orig, x1, y1, x2, y2))

    if not retry_boxes:
        return cv_img

    try:
        # orig_cv_img: LaMa reconstructs from true source pixels, not the
        # first pass's already-erased/gray-filled ones (see
        # _erase_region_ai_inpaint's blend_base_img docstring). cv_img as
        # blend_base_img: the feather-blend fallback outside the retry
        # boxes must be the ALREADY-ERASED page, not the pristine original
        # — otherwise every region that wasn't flagged as smudged reverts
        # back to un-erased source text under the composite.
        return _erase_region_ai_inpaint(orig_cv_img, retry_boxes, blend_base_img=cv_img)
    except _AiInpaintUnavailable:
        # Composite the classical retry over the existing (already-erased)
        # cv_img rather than re-running from orig_cv_img wholesale — the
        # rest of the page (regions that weren't smudged) is already
        # correctly erased and shouldn't be touched a second time.
        _ERASE_SAFETY_MARGIN = 2
        h, w = cv_img.shape[:2]
        mask = np.zeros((h, w), dtype=np.uint8)
        for (x1, y1, x2, y2) in retry_boxes:
            m = _ERASE_SAFETY_MARGIN
            mask[max(0, y1 - m):min(h, y2 + m), max(0, x1 - m):min(w, x2 + m)] = 255
        patched = cv2.inpaint(orig_cv_img, mask, inpaintRadius=7, flags=cv2.INPAINT_NS)
        feather_px = 5
        soft_mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=feather_px / 2)
        alpha = (soft_mask.astype(np.float32) / 255.0)[..., None]
        blended = patched.astype(np.float32) * alpha + cv_img.astype(np.float32) * (1 - alpha)
        return blended.astype(np.uint8)