#!/usr/bin/env python3
"""
MangaTL-Reader  —  Manga translation tool (server)
===================================================

Translates any MangaDex chapter that has a non-English translation
(Vietnamese, Korean, Indonesian, etc.) into English or your chosen language
using OCR (EasyOCR / Gemini Vision) + AI translation (Gemini / DeepSeek).

This is the Flask backend. The frontend lives in static/ (index.html,
style.css, js/*.js) and is served from disk — nothing frontend-related is
embedded in this file. See build.py if you want to reassemble everything
into a single distributable .py file (e.g. for sharing with someone who
just wants to download one file and run it).

USAGE
  python server.py                — starts the server and opens the browser
  (Windows) double-click run.py   — same, if Python is installed

FIRST RUN
  Packages install automatically (Flask, EasyOCR, OpenCV …).
  EasyOCR downloads a ~100–400 MB language model — this takes 2-5 minutes.
  The browser opens as soon as the server is ready.

REQUIREMENTS
  Python 3.9+  ·  Internet connection  ·  A Gemini or DeepSeek API key

API KEYS (free options)
  Gemini  → https://aistudio.google.com/app/apikey  (free tier, no credit card)
  DeepSeek → https://platform.deepseek.com           (~$0.02–0.05 / chapter)
"""

# ─── Auto-install missing dependencies ───────────────────────────────────────
# Runs before every other import so we can guarantee packages exist.
# On first run this takes a few minutes; subsequent runs skip instantly.

import sys
import subprocess
import importlib.util

_REQUIRED = {
    "flask":                  "flask",
    "requests":               "requests",
    "easyocr":                "easyocr",
    "rapidocr":                "rapidocr",   # optional 2nd local OCR engine — see
                                              # _run_rapidocr_detection docstring for
                                              # why this exists alongside EasyOCR
                                              # rather than replacing it.
    "pillow":                 "PIL",
    "numpy":                  "numpy",
    "opencv-python-headless": "cv2",
}

def _bootstrap():
    missing = [pkg for pkg, mod in _REQUIRED.items()
               if importlib.util.find_spec(mod) is None]
    if not missing:
        return

    print()
    print("  ╔══════════════════════════════════════════════╗")
    print("  ║      MangaTL — First-Time Setup              ║")
    print("  ╚══════════════════════════════════════════════╝")
    print()
    print(f"  Installing {len(missing)} missing package(s):")
    for p in missing:
        print(f"    •  {p}")
    print()
    print("  EasyOCR includes a language model (~100–400 MB).")
    print("  RapidOCR bundles a small default model in the package itself")
    print("  (~30 MB) — no separate download for most languages.")
    print("  This may take 2–5 minutes. Please wait.")
    print("  The browser will open automatically when ready.")
    print()

    # --break-system-packages is needed on modern Debian/Ubuntu systems but is
    # silently ignored on Windows and macOS — safe to pass unconditionally.
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--quiet",
             "--break-system-packages"] + missing
        )
        print("  ✓  Setup complete!\n")
    except subprocess.CalledProcessError:
        print()
        print("  ✗  Auto-install failed.")
        print("  Run this manually, then try again:")
        print("     pip install " + " ".join(missing))
        sys.exit(1)

# Only auto-install when this file is RUN, not when it's imported. Importing
# server.py must never shell out to pip as a side effect — that side effect is
# exactly what forced test_ssrf_guard.py and test_deepseek_rescue.py to regex
# their functions-under-test out of this file's source text and exec() them
# rather than just importing them.
#
# Running the script directly is unaffected: __name__ is "__main__" here, so
# the bootstrap still completes before the imports below — the only ordering
# constraint that ever mattered.
#
# An importer must therefore already have the module-scope dependencies
# (flask, requests, cv2, numpy, PIL — imported just below). easyocr, rapidocr
# and torch are deliberately NOT among them: those load lazily inside
# _get_reader() / _get_rapidocr_engine() / _get_lama_engine(), so a test that
# only touches geometry or parsing never pays their install/import cost.
if __name__ == "__main__":
    _bootstrap()

# ─── All other imports (safe after bootstrap) ─────────────────────────────────

import io
import base64
import os
import platform
import socket
import threading
import time
import webbrowser
import zipfile
from pathlib import Path

import cv2
import numpy as np
import requests
from flask import Flask, Response, abort, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException
from PIL import Image, ImageDraw, ImageFont

HOST         = "127.0.0.1"
# Overridable so you can run a second instance, or slot in behind a tool that
# assigns a port, without editing this file. Matches how MTL_SUWAYOMI_HOST and
# MTL_ALLOW_EXPOSED are already handled. 8080 stays the default everything
# else (README, the browser auto-open below) assumes.
PORT         = int(os.environ.get("PORT") or 8080)

MANGADEX_API  = "https://api.mangadex.org"
MANGADEX_AUTH = "https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token"
DEEPSEEK_API  = "https://api.deepseek.com/v1/chat/completions"
GEMINI_API    = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

# ─── BEGIN local modules (build.py inlines these) ────────────────────────────
# These live in mtl/ so this file stays about routing and orchestration.
# build.py replaces this whole block — sentinels included — with the modules'
# source text when it produces the single-file dist build, so the ORDER here
# is also the inlining order and must stay dependency-correct.
from mtl.config import USER_AGENT
from mtl.security import (
    SUWAYOMI_HOST,
    _check_exposure_or_exit,
    _is_allowed_image_host,
    _load_image_bytes,
    _validate_image_url,
)
from mtl.inpaint import (
    _AiInpaintUnavailable,
    _erase_region_ai_inpaint,
    _erase_region_flatten,
    _erase_region_inpaint,
    _region_is_flat_light,
    _reerase_smudged_regions,
)
# ─── END local modules ───────────────────────────────────────────────────────


# Languages routed through Gemini Vision when vision_mode='smart'.
# Organised by the reason EasyOCR struggles:
#
#   Complex / vertical scripts  (EasyOCR wasn't built for these)
#     ja, zh, zh-hk, ko, ar, th
#
#   Cyrillic scripts  (sparse training data for manga fonts)
#     ru (Russian), uk (Ukrainian), bg (Bulgarian)
#
#   Latin with heavy diacritics  (stylised manga fonts break EasyOCR's
#   confidence scores on stacked / uncommon diacritic combinations)
#     vi  — stacked tone + vowel marks (ầ, ướ, ặ…)
#     pl  — ą ę ź ż ś ć ń
#     cs  — á č ď ě ř š ť ů ž
#     sk  — ľ ĺ ŕ ô dz dž
#     hr  — š đ č ž ć
#     ro  — ș ț ă â î  (cedilla variants frequently confused)
#     hu  — double-acute ő ű misread as ö ü
#     lt  — ą č ę ė į š ų ū ž
#     lv  — ā ē ģ ī ķ ļ ņ ū ž
#
# Intentionally left to EasyOCR (handles them fine):
#   en, es, fr, it, pt, pt-br, nl, de, sv, da, fi, no, id, ms, tr
#
# vision_mode='all' bypasses this set entirely.
VISION_LANGS = {
    # Complex / vertical scripts
    'ja', 'zh', 'zh-hk', 'ko', 'ar', 'th',
    # Cyrillic
    'ru', 'uk', 'bg',
    # Latin with heavy diacritics
    'vi', 'pl', 'cs', 'sk', 'hr', 'ro', 'hu', 'lt', 'lv',
}

app = Flask(__name__, static_folder="static", static_url_path="/static")
# Local-folder/CBZ pages post image bytes straight in the request body
# (image_b64) instead of a URL the server fetches itself. Cap the whole
# request, not just the decoded-image check in _load_image_bytes, so an
# oversized body is rejected before Flask/Werkzeug bothers buffering and
# JSON-parsing it.
app.config["MAX_CONTENT_LENGTH"] = 40 * 1024 * 1024  # 40MB — base64 overhead + JSON framing headroom

# ─── MangaDex language code → EasyOCR language list ──────────────────────────
_LANG_MAP = {
    'vi':    ['vi'],      'it':    ['it'],      'pt':    ['pt'],
    'pt-br': ['pt'],      'ru':    ['ru'],      'fr':    ['fr'],
    'es':    ['es'],      'es-la': ['es'],      'de':    ['de'],      'pl':    ['pl'],
    'nl':    ['nl'],      'tr':    ['tr'],      'id':    ['id'],
    'ko':    ['ko'],      'ja':    ['ja'],      'zh':    ['ch_sim'],
    'zh-hk': ['ch_tra'],  'th':    ['th'],      'ar':    ['ar'],
    'uk':    ['uk'],      'cs':    ['cs'],      'hu':    ['hu'],
    'ro':    ['ro'],      'sv':    ['sv'],      'da':    ['da'],
    'fi':    ['fi'],      'no':    ['no'],      'ms':    ['ms'],
    'hr':    ['hr'],      'sk':    ['sk'],      'bg':    ['bg'],
    'lt':    ['lt'],      'lv':    ['lv'],      'en':    ['en'],
}

def _easyocr_langs(chapter_lang: str) -> list:
    primary = _LANG_MAP.get(chapter_lang.lower(), ['en'])
    # Always add English as secondary so SFX / onomatopoeia get picked up
    if primary != ['en']:
        return primary + ['en']
    return primary


# ─── Per-language OCR confidence thresholds ───────────────────────────────────
# Languages with complex diacritics (Vietnamese) tend to produce more false
# positives at low confidence, while dense-script languages (Korean hangul)
# can score lower on genuine text.
_MIN_CONF_MAP = {
    'vi':    0.40,   # tonal diacritics inflate false positives
    'ko':    0.30,   # dense hangul blocks can score lower but still be correct
    'zh':    0.35,
    'zh-hk': 0.35,
    'th':    0.38,   # Thai vowel marks cause similar issues to Vietnamese
    'ar':    0.38,
    # Note: no 'es' override here. An earlier version of this map lowered
    # Spanish to 0.15 after a real chapter page showed stylized mixed-case
    # manga fonts scoring correctly-recognized text as low as 0.159 —
    # but that was a blunt fix (also loosens filtering for isolated,
    # possibly-genuine-noise Spanish fragments). _merge_bubble_regions'
    # cluster-aware confidence filtering (see its docstring) now handles
    # this same case directly — a low-confidence fragment merging with
    # confident neighbours gets a relaxed floor, an isolated one doesn't —
    # which is a more precise fix that doesn't require knowing about this
    # specific font/language combination in advance, so the override was
    # removed once the underlying mechanism existed.
}

# Confidence floor for very short (<=2 character, after stripping) OCR
# fragments — deliberately much lower than _MIN_CONF_MAP's per-language
# floors. Verified against real EasyOCR output: standalone short function
# words that are entirely legitimate ("A" as in Spanish/Hungarian "a/the",
# French "a" as in "has") scored as low as 0.155-0.156 confidence — well
# below the default 0.35 floor — and were being silently discarded,
# truncating the start of otherwise-correct sentences. A short fragment is
# inherently harder for the recognition model to score confidently (little
# surrounding context to disambiguate), so low confidence alone isn't as
# strong a noise signal for short text as it is for longer text.
#
# Used in two places with two different roles:
#   - _run_easyocr_detection applies it as a hard floor (not deferred to
#     _merge_bubble_regions' cluster-aware filtering) because a stray 1-2
#     character noise blob sitting near real text is a real risk the
#     cluster-adjacency trust signal doesn't protect against the same way
#     it does for longer, more distinctive fragments. It's also passed in
#     as _merge_bubble_regions' clustered_floor for confident-neighbour
#     fragments — see that function's docstring.
#   - /ocr-crop (via _easyocr_readtext_primary) applies it directly since
#     a single-region crop has no merge step to defer to.
SHORT_WORD_MIN_CONF = 0.12

# ─── Language-specific translation hints ──────────────────────────────────────
# Appended to the DeepSeek system prompt so the model understands
# cultural/linguistic quirks of each source language.
_LANG_HINTS = {
    'vi':    "Vietnamese comics use honorifics like 'anh/em/chị/bạn' to signal relationships and age hierarchy — preserve these dynamics in the English translation rather than flattening everyone to 'you'.",
    'ko':    "Korean webtoons use distinct speech levels (합쇼체 formal / 해요체 polite / 반말 casual). Reflect the character's social register in the English tone — formal characters should sound formal, casual characters casual.",
    'zh':    "Chinese manga may include chengyu (four-character idioms) and cultural references. Translate idioms by meaning rather than literally; add brief inline context only if the meaning would otherwise be lost.",
    'zh-hk': "This is Cantonese (Traditional Chinese). Cantonese slang and particles differ significantly from Mandarin. Prioritise natural idiomatic English over a literal rendering.",
    'id':    "Indonesian comics may use Javanese loanwords or regional slang (e.g. 'aku/gue', 'kamu/lo'). 'Gue/lo' signals casual Jakarta speech — keep dialogue informal where appropriate.",
    'th':    "Thai comics use politeness particles (ครับ for male speakers, ค่ะ/นะ for female). Reflect the speaker's politeness level and gender in the English tone where natural.",
    'ru':    "Russian manga often uses diminutives and expressive suffixes for names and nouns. Preserve endearment or mockery implied by diminutive forms rather than using the base name.",
    'fr':    "French comics distinguish 'tu' (informal) and 'vous' (formal/plural). Reflect the intimacy or formality of address in the English translation.",
    'es':    "Castilian Spanish (Spain). Distinguishes informal 'tú' from formal 'usted' — same shape as French tu/vous. Plural also splits by formality: informal 'vosotros' vs. formal 'ustedes' (Latin American Spanish does not make this plural distinction — see 'es-la'). Reflect the formality/intimacy of address in the English translation.",
    'es-la': "Latin American Spanish. Distinguishes informal address from formal 'usted', but which informal pronoun appears varies by the writer's region: 'tú' (most of Latin America), or 'vos' (Argentina, Uruguay, Paraguay, and used informally in parts of Central America/Colombia) — 'vos' is not a typo or an unusual formal register, it's simply the informal 'you' in those dialects, with its own verb conjugation (e.g. 'vos tenés' = 'tú tienes'). The plural 'ustedes' covers both formal and informal in Latin American Spanish (unlike Spain's tú/vosotros vs. usted/ustedes split). Reflect the underlying formality level in English regardless of which informal pronoun is used.",
    'de':    "German comics use 'du' (informal) vs 'Sie' (formal). Preserve the formality level in English dialogue.",
    'pl':    "Polish uses grammatical gender and case extensively in dialogue — pay attention to whether the speaker refers to themselves as male or female when choosing English phrasing.",
    'tr':    "Turkish distinguishes formal 'siz' from informal 'sen', and verb suffixes encode the speaker's certainty/evidentiality (e.g. -mış for hearsay or surprise). Reflect the address formality in English, and render evidential surprise with natural English cues ('apparently', 'turns out') rather than dropping it.",
    'hu':    "Hungarian dialogue relies on verb conjugation and suffixes rather than pronouns for formality (e.g. 'maga/ön' formal vs 'te' informal address is often implied, not stated outright). Infer and preserve the formality level in English phrasing rather than defaulting to neutral 'you' throughout.",
    'pt':    "European Portuguese: 'tu' is the default informal address (used with family, friends, peers); 'você' reads as formal-to-distant and can sound cold or corrective when used with someone the speaker is on familiar terms with — do not treat 'você' as neutral. 'O senhor'/'a senhora' is more deferential still. Reflect this formality gradient in the English translation rather than flattening everyone to 'you'.",
    'pt-br': "Brazilian Portuguese: 'você' is the default, near-universal address across both informal and formal contexts — it does not itself signal formality the way 'você' does in European Portuguese. Genuine formality is instead carried by 'o senhor'/'a senhora', or regionally by 'tu' (esp. southern Brazil, informal). Don't read 'você' as implying distance or politeness; look to word choice, honorifics, and context for the actual register.",
}


# ─── Image preprocessing ──────────────────────────────────────────────────────

def _is_colored_page(arr: np.ndarray) -> bool:
    """
    Return True if the page contains significant color (i.e. is not pure B&W).

    Checks the HSV saturation channel at 1/4 resolution for speed.
    A B&W manga page has near-zero saturation throughout. Colored panels push
    saturation up noticeably. Threshold: >5% of pixels with S > 20 (out of 255).
    Conservative enough to ignore JPEG chroma noise on B&W scans.
    """
    h, w  = arr.shape[:2]
    small = cv2.resize(arr, (max(32, w // 4), max(32, h // 4)),
                       interpolation=cv2.INTER_AREA)
    sat   = cv2.cvtColor(small, cv2.COLOR_RGB2HSV)[:, :, 1]
    return float(np.mean(sat > 20)) > 0.05


def _preprocess_for_ocr(arr: np.ndarray) -> np.ndarray:
    """
    Adaptive preprocessing: fast path for B&W pages, smart path for colored.

    B&W path  — original 3-step pipeline (grayscale → CLAHE 2.0 → denoise).
                Fast, screentone-safe, already well-tuned for classic manga.

    Colored path — 7-channel selection + adaptive inversion + CLAHE 3.0 + denoise.
                   Tries luminance gray, L* (LAB), V (HSV), S (HSV), R, G, B
                   and picks whichever channel has the most Laplacian edge variance
                   (= sharpest text edges) at 1/4 resolution.
                   Then inverts if background looks dark (border-ring sample).
                   Only triggered when _is_colored_page() returns True, so all
                   the colored-path risks (screentone scoring, border misfire)
                   are completely avoided on normal B&W content.
    """
    if not _is_colored_page(arr):
        # ── Fast B&W path (unchanged from original) ───────────────────────────
        gray     = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        clahe    = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        denoised = cv2.fastNlMeansDenoising(enhanced, h=10)
        return cv2.cvtColor(denoised, cv2.COLOR_GRAY2RGB)

    # ── Colored path ──────────────────────────────────────────────────────────
    h, w = arr.shape[:2]

    # 1. Generate 7 candidate single-channel representations
    gray_lum = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    lab      = cv2.cvtColor(arr, cv2.COLOR_RGB2LAB)
    gray_l   = lab[:, :, 0]
    hsv      = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
    gray_v   = hsv[:, :, 2]
    gray_s   = hsv[:, :, 1]
    r_ch     = arr[:, :, 0].copy()
    g_ch     = arr[:, :, 1].copy()
    b_ch     = arr[:, :, 2].copy()
    candidates = [gray_lum, gray_l, gray_v, gray_s, r_ch, g_ch, b_ch]

    # 2. Score each by Laplacian edge variance at 1/4 resolution (~1 ms)
    sh, sw = max(64, h // 4), max(64, w // 4)
    def _score(img):
        return float(cv2.Laplacian(
            cv2.resize(img, (sw, sh), interpolation=cv2.INTER_AREA),
            cv2.CV_64F).var())
    best = max(candidates, key=_score)

    # 3. Adaptive inversion — sample border ring to estimate background
    bw, bh = max(4, w // 20), max(4, h // 20)
    border = np.concatenate([best[:bh,:].ravel(), best[-bh:,:].ravel(),
                             best[:,:bw].ravel(), best[:,-bw:].ravel()])
    if float(np.median(border)) < 127 or float(np.median(best)) < 90:
        best = cv2.bitwise_not(best)

    # 4. CLAHE + denoise
    enhanced = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(best)
    denoised = cv2.fastNlMeansDenoising(enhanced, h=10)
    return cv2.cvtColor(denoised, cv2.COLOR_GRAY2RGB)


# ─── Typesetting engine — burn translated text onto a page ──────────────────
#
# Takes the same {text, t, x, y, box, tl} region shape the reader already
# produces (box is a percentage rect [x1,y1,x2,y2], 0-100) and an image, and
# returns a flattened image with each region's original text erased and its
# translation drawn in its place — i.e. what a human typesetter would hand in.
#
# Three erase strategies:
#   "auto" (default) — decides per region. Most boxes on a manga page are
#     plain speech bubbles sitting on flat white/pale fill, where a full
#     inpaint just reconstructs flat color at ~10x the cost of a flood-fill.
#     Each region is measured (_region_is_flat_light — flat + light ring
#     around the box) and routed individually: flat/light → "flatten" path
#     below, anything else (screentone, gradients, shaded/dark bubbles) →
#     the "inpaint" path below. This is a routing decision only — it doesn't
#     change how either underlying method works, just which boxes reach the
#     expensive one.
#   "inpaint" — fills the erased area by blending in nearby pixels, then
#     feathers the patch edge back into the original image so the erase-box
#     boundary isn't a visible hard-edged rectangle. The inpaint method is
#     chosen per-region rather than fixed for the whole page: regions over a
#     flat/smooth background use INPAINT_TELEA (better at reproducing sharp
#     local structure), regions over a screentoned/textured background use
#     INPAINT_NS (better at continuing gradients and texture) — see
#     _region_texture_variance. This is the right default for manga, where
#     most bubbles are flat but panels/SFX can sit inside colored/
#     screentoned art, sometimes both on the same page.
#   "flatten" — samples the box's corner pixels and fills with a solid color.
#     Cheaper and gives perfectly clean edges on flat-white speech bubbles,
#     but looks wrong (visible rectangle) on anything with texture behind it.
#   "auto" is just "inpaint" and "flatten" applied selectively per box, using
#   a stricter flatness threshold than the NS/TELEA choice above — see
#   _FLATTEN_VARIANCE_THRESHOLD vs. _TEXTURE_VARIANCE_THRESHOLD.
#
# Text color: chosen per-region ("auto", the default) from the erased
# region's own background brightness, so translated text stays readable on
# dark caption/narration boxes instead of always drawing black.
#
# Font sizing: binary-search the largest font size (bounded) whose wrapped
# text still fits the box, using PIL's built-in scalable default font unless
# a real TTF/OTF was picked (see _discover_system_fonts below) — either way,
# no external network fetch is required. A person can also skip the auto-fit
# entirely and pin an explicit size per box (see typeset_manual_page's
# font_size handling) for when the auto-fit guesses smaller than they'd like.

from PIL import ImageDraw, ImageFont


# ─── System font discovery ────────────────────────────────────────────────────
# Lets the person pick a real installed font (instead of always drawing with
# PIL's built-in bitmap-ish default) for typeset text. We scan common OS font
# directories once at first use and cache the result — there's no reliable
# cross-platform "list installed fonts" API without extra dependencies, but
# walking the well-known directories covers the vast majority of real systems
# (Windows/macOS/Linux) without adding one.
_FONT_DIRS = {
    "Windows": [
        r"C:\Windows\Fonts",
    ],
    "Darwin": [
        "/System/Library/Fonts",
        "/System/Library/Fonts/Supplemental",
        "/Library/Fonts",
        str(Path.home() / "Library" / "Fonts"),
    ],
    "Linux": [
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        str(Path.home() / ".fonts"),
        str(Path.home() / ".local" / "share" / "fonts"),
    ],
}

_FONT_EXTS = (".ttf", ".otf", ".ttc")

_font_cache = None          # list of {"name": str, "path": str}, built lazily
_font_cache_lock = threading.Lock()


def _discover_system_fonts() -> list:
    """Scan this OS's standard font directories for .ttf/.otf/.ttc files and
    return a sorted list of {"name", "path"} dicts, one per unique display
    name. Cached after first call — fonts don't change while the server is
    running, and a full-disk walk on every /fonts request would be wasteful.

    "name" is derived from the filename (not parsed from the font's internal
    name table, which would mean loading every single file with PIL just to
    list them) — good enough for a picker UI, and always matches something
    _load_typeset_font can actually open since it's the same file's own name.
    Duplicate display names (e.g. the same font shipped in two directories)
    keep only the first path found.
    """
    global _font_cache
    if _font_cache is not None:
        return _font_cache

    with _font_cache_lock:
        if _font_cache is not None:  # re-check inside the lock
            return _font_cache

        system = platform.system()
        dirs = _FONT_DIRS.get(system, [])
        # Always also try the Linux paths as a fallback (covers WSL, some
        # Docker base images, etc. that report a different platform.system()
        # but still keep fonts under /usr/share/fonts).
        if system != "Linux":
            dirs = dirs + _FONT_DIRS["Linux"]

        seen_names = set()
        fonts = []
        for d in dirs:
            root = Path(d)
            if not root.is_dir():
                continue
            try:
                for path in root.rglob("*"):
                    if path.suffix.lower() not in _FONT_EXTS:
                        continue
                    if not path.is_file():
                        continue
                    name = path.stem.replace("-", " ").replace("_", " ").strip()
                    if not name or name.lower() in seen_names:
                        continue
                    seen_names.add(name.lower())
                    fonts.append({"name": name, "path": str(path)})
            except (PermissionError, OSError):
                # Some system font dirs (or subfolders within them) can be
                # unreadable depending on OS/permissions — skip, don't crash
                # font discovery over one bad directory.
                continue

        fonts.sort(key=lambda f: f["name"].lower())
        _font_cache = fonts
        return _font_cache


def _load_typeset_font(font_path: str, size: int) -> "ImageFont.FreeTypeFont":
    """Load a TTF/OTF font at the given pixel size, falling back to PIL's
    built-in scalable default if font_path is empty, not one of the fonts
    _discover_system_fonts found, or fails to load for any reason (corrupt
    file, unsupported format, etc.) — a bad font choice should never break
    typesetting, just silently fall back to the same default used before
    font selection existed."""
    if font_path:
        try:
            return ImageFont.truetype(font_path, size=size)
        except Exception:
            pass
    return ImageFont.load_default(size=size)


def _region_box_px(region: dict, img_w: int, img_h: int):
    """Convert a region's percentage box [x1,y1,x2,y2] (0-100) to clamped
    pixel ints. Falls back to a small box around (cx,cy) if box is missing —
    matches the same fallback the frontend uses when box is absent."""
    box = region.get("box")
    if not box or len(box) != 4:
        cx, cy = region.get("x", region.get("cx", 50)), region.get("y", region.get("cy", 50))
        box = [cx - 8, cy - 5, cx + 8, cy + 5]
    x1 = max(0, min(img_w - 1, round(box[0] / 100 * img_w)))
    y1 = max(0, min(img_h - 1, round(box[1] / 100 * img_h)))
    x2 = max(x1 + 1, min(img_w, round(box[2] / 100 * img_w)))
    y2 = max(y1 + 1, min(img_h, round(box[3] / 100 * img_h)))
    return x1, y1, x2, y2


                                        # (not thread-safe) -- same
                                        # reasoning as _infer_lock /
                                        # _rapidocr_infer_lock above;
                                        # missing here before this fix,
                                        # unlike every other PyTorch/
                                        # onnxruntime call in this file.


                                  # connected-component search is allowed to
                                  # look past a flagged box's own edge, in
                                  # any direction. Real undershoot (a
                                  # clipped ascender/descender/serif) is a
                                  # few px; this is already generous. Exists
                                  # to structurally cap runaway growth when
                                  # a box touches a page-spanning panel
                                  # border's connected component — see that
                                  # function's docstring.


def _region_text_color(pil_img: Image.Image, x1: int, y1: int, x2: int, y2: int) -> tuple:
    """Pick black or white text based on the erased region's own background
    brightness, instead of always drawing black. A hardcoded black looks
    fine on typical white speech bubbles but is unreadable on dark bubbles/
    caption boxes (common for narration, flashbacks, or SFX-adjacent boxes
    with a black or heavily-inked fill) — the previous behaviour just drew
    black text on black background in that case.

    Samples the box's own erased interior (not a ring outside it, since by
    the time this runs the interior has already been cleaned to whatever
    the erase step produced) and uses the standard perceptual luminance
    formula to decide. Returns (0,0,0) for light backgrounds, (255,255,255)
    for dark ones.
    """
    crop = pil_img.crop((x1, y1, x2, y2))
    arr = np.array(crop)
    if arr.size == 0:
        return (0, 0, 0)
    flat = arr.reshape(-1, arr.shape[-1])[:, :3].astype(np.float32)
    # Rec. 601 luma weights — good enough for a light/dark decision, no need
    # for a more expensive perceptual color-space conversion here.
    luma = flat @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    mean_luma = float(np.mean(luma))
    return (255, 255, 255) if mean_luma < 128 else (0, 0, 0)


def _fit_font_and_wrap(draw: "ImageDraw.ImageDraw", text: str, box_w: int, box_h: int,
                        max_size: int = 64, min_size: int = 9, font_path: str = ""):
    """Binary-search the largest font size where `text`, word-wrapped to fit
    box_w, still fits within box_h. Returns (font, wrapped_lines). Falls back
    to min_size (still wrapped, may overflow slightly) if nothing fits — we'd
    rather show slightly-too-big text than silently drop it.

    font_path: optional path to a TTF/OTF (see _discover_system_fonts) to use
    instead of PIL's built-in default. Invalid/missing paths silently fall
    back to the default via _load_typeset_font."""
    def wrap_for_size(size):
        font = _load_typeset_font(font_path, size)
        words = text.split()
        if not words:
            return font, [""]
        lines, cur = [], words[0]
        for w in words[1:]:
            trial = f"{cur} {w}"
            if draw.textlength(trial, font=font) <= box_w:
                cur = trial
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
        return font, lines

    def total_height(font, lines):
        # textbbox gives tighter metrics than font.getsize (deprecated); use
        # a representative "Ay" sample plus line spacing rather than measuring
        # each line's own bbox, so lines with only descenders/ascenders don't
        # under/overestimate line height inconsistently.
        bbox = draw.textbbox((0, 0), "Aygj", font=font)
        line_h = (bbox[3] - bbox[1]) * 1.25
        return line_h * len(lines)

    lo, hi = min_size, max_size
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        font, lines = wrap_for_size(mid)
        widths_ok = all(draw.textlength(l, font=font) <= box_w for l in lines)
        if widths_ok and total_height(font, lines) <= box_h:
            best = (font, lines)
            lo = mid + 1
        else:
            hi = mid - 1
    if best:
        return best
    return wrap_for_size(min_size)


def typeset_page(image_bytes: bytes, regions: list, erase_mode: str = "auto",
                  text_color="auto", skip_types: tuple = ("sfx",),
                  erase_only: bool = False, ai_inpaint: bool = False,
                  smudge_check: bool = True) -> bytes:
    """
    Core export function: erase original text and draw translations for one
    page. Returns PNG bytes.

    regions: list of {text, t, x/cx, y/cy, box:[x1,y1,x2,y2] (0-100 pct), tl}
             — the same shape the reader already stores per page.
    erase_mode: "auto" (default) routes each region individually — flat/
                light regions (see _region_is_flat_light) skip straight to
                the flatten fast path, everything else goes through the
                full per-region NS/TELEA inpaint (or LaMa — see ai_inpaint
                below). "inpaint" and "flatten" force that single method for
                every region on the page.
    ai_inpaint: opt-in, default False. When True, whatever would have gone
                through classical NS/TELEA inpaint (the non-flat-fill
                boxes under "auto", or every box under "inpaint") is routed
                to _erase_region_ai_inpaint (LaMa) instead of
                _erase_region_inpaint. Does NOT change which boxes take the
                flat-fill fast path under "auto" — flat/light regions are
                already well-served by the cheap flood-fill regardless of
                this flag, so this only affects the textured-region
                minority where classical inpaint is weakest. First call
                triggers a one-time model download and is meaningfully
                slower per page than classical inpaint — see
                _erase_region_ai_inpaint's docstring and the module-level
                comment above it for real measured cost and an honest
                caveat about unconfirmed quality-vs-classical claims.
    text_color: "auto" (default) picks black or white per-region based on
                the erased region's own background brightness (see
                _region_text_color) — handles dark caption/narration boxes
                correctly instead of always drawing black-on-black. Pass an
                explicit (r,g,b) tuple to force one color for every region
                on the page instead (previous behaviour).
    skip_types: region types to leave untouched (default: sound effects,
                which are usually hand-drawn/stylized and a plain text overlay
                looks worse than leaving the original — same reasoning a human
                typesetter applies).
    erase_only: used by the standalone Erase Tool. Normal typeset export
                treats a region with no translation (tl empty/"—") as
                nothing-to-do — it's never even erased, since erasing text
                with nothing to replace it with would just leave a blank
                hole in the middle of a translated page. The Erase Tool has
                the opposite goal (clean the page, draw nothing back), so
                when this is True every region in `regions` is erased
                regardless of its `tl`, and the draw-translation step below
                is skipped entirely.
    smudge_check: opt-out, default True. After the erase pass(es) above,
                every region is re-checked against the PRISTINE source page
                for leftover ink an undersized/misaligned box left behind
                (see _detect_residual_smudge) — a real, observed failure
                mode independent of erase_mode/ai_inpaint: a snug OCR or
                manual box that undershoots real glyph extent (ascenders/
                descenders/serifs at the edge, or text sitting close to a
                bubble's own outline) can leave a dark smudge or a
                recognizable leftover letter no matter which erase method
                ran. Any flagged region gets its box widened to the missed
                glyph run's real extent (_expand_box_to_glyph_extent) and
                re-erased through AI inpaint (falling back to a stronger
                classical pass if LaMa isn't installed) — see
                _reerase_smudged_regions. Cheap when nothing is flagged
                (pure numpy/cv2 comparison against pixels already in
                memory, no model call) — the extra cost only shows up on
                pages that actually need the retry. Exists as a parameter
                mainly so callers/tests can turn it off to inspect a raw
                first-pass erase without the second pass masking it.
    """
    pil = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = pil.size

    if erase_only:
        drawable = [r for r in regions if r.get("t", "speech") not in skip_types]
    else:
        drawable = [r for r in regions
                    if (r.get("tl") or "").strip() not in ("", "—")
                    and r.get("t", "speech") not in skip_types]
    if not drawable:
        buf = io.BytesIO()
        pil.save(buf, format="PNG")
        return buf.getvalue()

    boxes_px = [_region_box_px(r, w, h) for r in drawable]
    _inpaint_fn = _erase_region_ai_inpaint if ai_inpaint else _erase_region_inpaint

    # Pristine pre-erase page, kept around for smudge_check below — every
    # erase branch overwrites `pil`/derives a `cv_img` from it, so this has
    # to be captured before any of them run.
    orig_cv_img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR) if smudge_check else None

    if erase_mode == "auto":
        # Per-region routing: flat/light regions (plain white/pale bubbles —
        # the large majority of boxes on a typical page) go straight to the
        # cheap flood-fill, since a full inpaint would just reconstruct flat
        # white anyway. Everything else (screentone, gradients, shaded
        # bubbles, dark caption boxes) still goes through the full inpaint
        # pipeline below — classical or LaMa depending on ai_inpaint. This
        # only changes *which* boxes reach the inpaint step and *which*
        # inpaint function they reach, not the flat-fill fast path itself.
        cv_img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
        flat_boxes, inpaint_boxes = [], []
        for box in boxes_px:
            (flat_boxes if _region_is_flat_light(cv_img, *box) else inpaint_boxes).append(box)
        if inpaint_boxes:
            cv_img = _inpaint_fn(cv_img, inpaint_boxes)
        if flat_boxes:
            pil = Image.fromarray(cv2.cvtColor(cv_img, cv2.COLOR_BGR2RGB))
            for (x1, y1, x2, y2) in flat_boxes:
                _erase_region_flatten(pil, x1, y1, x2, y2)
            cv_img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    elif erase_mode == "inpaint":
        cv_img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
        cv_img = _inpaint_fn(cv_img, boxes_px)
    else:
        cv_img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
        for (x1, y1, x2, y2) in boxes_px:
            _erase_region_flatten(pil, x1, y1, x2, y2)
        cv_img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)

    if smudge_check:
        gray_orig = cv2.cvtColor(orig_cv_img, cv2.COLOR_BGR2GRAY)
        bubble_label_map = _find_bubble_components(gray_orig, w, h)
        cv_img = _reerase_smudged_regions(orig_cv_img, cv_img, boxes_px, bubble_label_map)

    pil = Image.fromarray(cv2.cvtColor(cv_img, cv2.COLOR_BGR2RGB))

    if erase_only:
        buf = io.BytesIO()
        pil.save(buf, format="PNG")
        return buf.getvalue()

    draw = ImageDraw.Draw(pil)
    for region, (x1, y1, x2, y2) in zip(drawable, boxes_px):
        text = (region.get("tl") or "").strip()
        if not text:
            continue
        fill = (_region_text_color(pil, x1, y1, x2, y2)
                if text_color == "auto" else text_color)
        box_w, box_h = max(4, x2 - x1 - 4), max(4, y2 - y1 - 4)
        font, lines = _fit_font_and_wrap(draw, text, box_w, box_h)
        bbox = draw.textbbox((0, 0), "Aygj", font=font)
        line_h = (bbox[3] - bbox[1]) * 1.25
        total_h = line_h * len(lines)
        cur_y = y1 + max(0, (y2 - y1 - total_h) / 2)
        for line in lines:
            line_w = draw.textlength(line, font=font)
            cur_x = x1 + max(0, (x2 - x1 - line_w) / 2)
            draw.text((cur_x, cur_y), line, font=font, fill=fill)
            cur_y += line_h

    buf = io.BytesIO()
    pil.save(buf, format="PNG")
    return buf.getvalue()


def _draw_legend(pil_img: Image.Image, entries: list, layout: str) -> Image.Image:
    """Append a numbered translation legend to the page for boxes flagged
    'outside' (text sits on art/signage the person can't cleanly paint over,
    so instead of cramming a translation into a tiny in-image box, the
    translation is printed outside the page and the badge on the image just
    shows a number pointing to it).

    entries: [{"num": int, "tl": str}]
    layout: "below" — footnote strip appended under the image (default)
            "sidebar" — strip appended to the right of the image
            "both" — both strips shown
    Returns a new PIL image (original page + legend strip(s)); does not
    mutate pil_img in place since the canvas size changes.
    """
    if not entries:
        return pil_img

    w, h = pil_img.size
    pad = 14
    font_size = max(14, min(22, w // 40))
    font = ImageFont.load_default(size=font_size)

    # Wrap each legend line to a given text width, return list of lines.
    def wrap_line(text, max_w, draw):
        words = text.split()
        if not words:
            return [""]
        lines, cur = [], words[0]
        for wd in words[1:]:
            trial = f"{cur} {wd}"
            if draw.textlength(trial, font=font) <= max_w:
                cur = trial
            else:
                lines.append(cur)
                cur = wd
        lines.append(cur)
        return lines

    scratch = ImageDraw.Draw(pil_img)
    line_h = int((scratch.textbbox((0, 0), "Aygj", font=font)[3]) * 1.4)

    do_below   = layout in ("below", "both")
    do_sidebar = layout in ("sidebar", "both")

    below_lines = []   # list of (text, is_header)
    if do_below:
        below_w = w - 2 * pad - 24
        for e in entries:
            header = f"{e['num']}."
            wrapped = wrap_line(e["tl"], below_w, scratch)
            below_lines.append((f"{header} {wrapped[0]}", True))
            for extra in wrapped[1:]:
                below_lines.append((extra, False))
    below_h = (pad * 2 + len(below_lines) * line_h) if below_lines else 0

    sidebar_w = max(180, w // 4) if do_sidebar else 0
    sidebar_lines = []
    if do_sidebar:
        side_text_w = sidebar_w - 2 * pad - 24
        for e in entries:
            header = f"{e['num']}."
            wrapped = wrap_line(e["tl"], side_text_w, scratch)
            sidebar_lines.append((f"{header} {wrapped[0]}", True))
            for extra in wrapped[1:]:
                sidebar_lines.append((extra, False))
    sidebar_h_needed = pad * 2 + len(sidebar_lines) * line_h

    new_w = w + sidebar_w
    new_h = max(h + below_h, h) if not do_sidebar else max(h + below_h, sidebar_h_needed + below_h)
    canvas = Image.new("RGB", (new_w, new_h), (255, 255, 255))
    canvas.paste(pil_img, (0, 0))
    draw = ImageDraw.Draw(canvas)

    if do_sidebar:
        draw.line([(w, 0), (w, new_h)], fill=(210, 210, 210), width=1)
        y = pad
        x = w + pad
        for text, is_header in sidebar_lines:
            draw.text((x, y), text, font=font, fill=(20, 20, 20))
            y += line_h

    if do_below:
        draw.line([(0, h), (w, h)], fill=(210, 210, 210), width=1)
        y = h + pad
        for text, is_header in below_lines:
            draw.text((pad, y), text, font=font, fill=(20, 20, 20))
            y += line_h

    return canvas


def _apply_paint_mask(pil_img: Image.Image, x1: int, y1: int, x2: int, y2: int,
                       mask_b64: str) -> None:
    """Paste a person-painted white-out patch (data URL/base64 PNG, drawn
    client-side on the erase-tool canvas) into pil_img at the given box,
    mutating pil_img in place. This is the pre-erase "paint white yourself"
    pass: it runs BEFORE the box's normal erase step, so a person can white
    out stray pixels (ink smudges, a glyph poking outside the drawn box, a
    torn scan edge, etc.) that the OCR-derived box didn't quite cover, and
    have the server's own erase (inpaint/flatten) skip touching that box's
    interior afterward — see typeset_manual_page's `pre_painted` handling.

    The incoming image is resized to the box's exact pixel dimensions if it
    doesn't already match (the browser canvas is natural-resolution, so this
    is normally a no-op resize, but protects against any mismatch)."""
    try:
        raw = base64.b64decode(mask_b64.split(",", 1)[-1])  # tolerate a data: URL prefix
        patch = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        return  # a malformed mask should never break the whole export
    box_w, box_h = x2 - x1, y2 - y1
    if box_w <= 0 or box_h <= 0:
        return
    if patch.size != (box_w, box_h):
        patch = patch.resize((box_w, box_h))
    pil_img.paste(patch, (x1, y1))


def typeset_manual_page(image_bytes: bytes, boxes: list, erase_mode: str = "auto",
                         text_color="auto", legend_layout: str = "below",
                         font_path: str = "", font_size: int = 0,
                         ai_inpaint: bool = False) -> bytes:
    """
    Manual-Erase-Tool typeset: unlike typeset_page (which draws into every
    region the OCR pipeline found), this ONLY touches the exact boxes the
    person drew by hand. Nothing else on the page is erased or written to —
    so anything not boxed (SFX, background text, whatever) is left exactly
    as-is with zero extra logic needed to "detect and skip" it.

    boxes: [{"box":[x1,y1,x2,y2] (0-100 pct), "tl": str, "outside": bool,
             "pre_paint": "data:image/png;base64,..." (optional),
             "pre_painted": bool (optional), "font_path": str (optional),
             "font_size": int (optional)}]
           box   — always erased (unless pre_painted — see below).
           tl    — translation text. If blank, the box is erased only
                   (same as the old erase_only behaviour) — lets someone
                   erase-without-filling for a box they never matched/typed
                   a translation for.
           outside — if true, the box is left completely untouched — NOT
                   erased and NOT written into (the text there is usually
                   on art/signage that's hard to letter over cleanly, or
                   worth keeping visible as-is). Its translation instead
                   goes into the numbered legend appended outside the page,
                   and a small number badge is drawn in the box's corner so
                   the reader can find which legend entry it corresponds to.
                   Since nothing here is erased, `pre_paint`/`pre_painted`
                   are meaningless for an `outside` box and are ignored.
           pre_paint — a base64 PNG (box_w x box_h pixels once decoded, or
                   resized to fit) the person painted client-side over the
                   original page before erase ran. Pasted in BEFORE this
                   box's own erase step, so any leftover ink the server's
                   inpaint/flatten misses (or that a person just wants full
                   manual control over) is already gone by the time erase
                   touches that spot. Compatible with all three erase_mode
                   values — think of it as "pre-clean this box's source
                   pixels", not a replacement for the erase step itself.
           pre_painted — if true, this box's normal server-side erase step
                   (inpaint/flatten) is skipped ENTIRELY; the box is assumed
                   to already be fully whited-out (typically because
                   pre_paint above covered the whole box, or a person just
                   wants to hand-paint a spot outside any bubble with no
                   server erase touching it at all — e.g. a small SFX-
                   adjacent smudge sitting on textured background art where
                   inpaint tends to guess wrong). Translation text (if any)
                   is still drawn on top exactly as for any other box.
    font_path — page-level default font (a path from _discover_system_fonts)
                used for every box's translation text unless that box sets
                its own "font_path". Empty/invalid falls back to PIL's
                built-in default via _load_typeset_font.
    font_size — page-level default explicit point size. 0 (default) means
                "auto-fit" (binary-search the largest size that fits the
                box, as before). A box's own "font_size" overrides this.
                An explicit size is NOT re-fit to the box — if the text
                overflows at that size it's simply drawn overflowing, since
                the whole point of a manual size is the person choosing to
                override the auto-fit's guess.
    legend_layout: "below" | "sidebar" | "both" — where flagged-outside
           translations get printed. Ignored if no box is flagged outside.
    ai_inpaint: same meaning as typeset_page's — routes whatever would have
           gone through classical NS/TELEA to LaMa instead. See
           _erase_region_ai_inpaint's docstring for cost/quality caveats.
    """
    pil = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = pil.size

    if not boxes:
        buf = io.BytesIO()
        pil.save(buf, format="PNG")
        return buf.getvalue()

    boxes_px = [_region_box_px(b, w, h) for b in boxes]

    # ── Pre-paint pass: apply any client-painted white-out BEFORE erase ────
    # Runs first so the erase step below (inpaint/flatten) samples/erases
    # from the already-cleaned pixels, not the original ink.
    # Skipped for `outside` boxes — see erase_targets note below; a
    # pre-paint patch would still be a modification to a box the person
    # asked to leave untouched, so we never even apply it there.
    for box, (x1, y1, x2, y2) in zip(boxes, boxes_px):
        if box.get("outside"):
            continue
        mask = box.get("pre_paint")
        if mask:
            _apply_paint_mask(pil, x1, y1, x2, y2, mask)

    # ── Erase every box (same per-region routing as typeset_page), except:
    #      - boxes flagged pre_painted — assumed already fully clean
    #        (typically because pre_paint above covered them), so server
    #        erase would be redundant at best and could stomp a hand-painted
    #        spot at worst.
    #      - boxes flagged outside — the whole point of "outside" is that
    #        the original pixels stay exactly as printed and only a legend
    #        entry + corner badge get added (see typeset_manual_page's
    #        docstring). Erasing first and drawing nothing back was the old
    #        behaviour and always left a blank hole under the badge; that's
    #        never what "outside" was meant to do, so these boxes are now
    #        excluded from erase_targets entirely, same as pre_painted ones.
    erase_targets = [
        (b, box) for b, box in zip(boxes, boxes_px)
        if not b.get("pre_painted") and not b.get("outside")
    ]
    if erase_targets:
        erase_boxes_px = [box for _, box in erase_targets]
        _inpaint_fn = _erase_region_ai_inpaint if ai_inpaint else _erase_region_inpaint
        if erase_mode == "auto":
            cv_img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
            flat_boxes, inpaint_boxes = [], []
            for box in erase_boxes_px:
                (flat_boxes if _region_is_flat_light(cv_img, *box) else inpaint_boxes).append(box)
            if inpaint_boxes:
                cv_img = _inpaint_fn(cv_img, inpaint_boxes)
                pil = Image.fromarray(cv2.cvtColor(cv_img, cv2.COLOR_BGR2RGB))
            for (x1, y1, x2, y2) in flat_boxes:
                _erase_region_flatten(pil, x1, y1, x2, y2)
        elif erase_mode == "inpaint":
            cv_img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
            cv_img = _inpaint_fn(cv_img, erase_boxes_px)
            pil = Image.fromarray(cv2.cvtColor(cv_img, cv2.COLOR_BGR2RGB))
        else:
            for (x1, y1, x2, y2) in erase_boxes_px:
                _erase_region_flatten(pil, x1, y1, x2, y2)

    # ── Draw translations into in-page boxes; collect outside-flagged ones ──
    draw = ImageDraw.Draw(pil)
    legend_entries = []
    legend_num = 0
    for box, (x1, y1, x2, y2) in zip(boxes, boxes_px):
        text = (box.get("tl") or "").strip()
        if not text:
            continue  # erased-only box, nothing to write

        if box.get("outside"):
            legend_num += 1
            legend_entries.append({"num": legend_num, "tl": text})
            # Small numbered badge in the box's corner so the reader can
            # match the erased spot back to its legend entry.
            badge_r = max(9, min(16, (x2 - x1) // 6))
            bx, by = x1 + badge_r + 2, y1 + badge_r + 2
            draw.ellipse([bx - badge_r, by - badge_r, bx + badge_r, by + badge_r],
                         fill=(255, 58, 58))
            badge_font = ImageFont.load_default(size=max(11, int(badge_r * 1.1)))
            num_text = str(legend_num)
            ntw = draw.textlength(num_text, font=badge_font)
            draw.text((bx - ntw / 2, by - badge_r * 0.7), num_text,
                      font=badge_font, fill=(255, 255, 255))
            continue

        fill = (_region_text_color(pil, x1, y1, x2, y2)
                if text_color == "auto" else text_color)
        box_w, box_h = max(4, x2 - x1 - 4), max(4, y2 - y1 - 4)
        box_font_path = box.get("font_path") or font_path
        box_font_size = int(box.get("font_size") or font_size or 0)

        if box_font_size > 0:
            # Explicit size (page default or per-box override): skip the
            # auto-fit binary search entirely and just wrap at that size,
            # even if it overflows the box — the person asked for this size.
            font = _load_typeset_font(box_font_path, box_font_size)
            words = text.split()
            lines = [words[0]] if words else [""]
            for wd in words[1:]:
                trial = f"{lines[-1]} {wd}"
                if draw.textlength(trial, font=font) <= box_w:
                    lines[-1] = trial
                else:
                    lines.append(wd)
        else:
            font, lines = _fit_font_and_wrap(draw, text, box_w, box_h, font_path=box_font_path)

        bbox = draw.textbbox((0, 0), "Aygj", font=font)
        line_h = (bbox[3] - bbox[1]) * 1.25
        total_h = line_h * len(lines)
        cur_y = y1 + max(0, (y2 - y1 - total_h) / 2)
        for line in lines:
            line_w = draw.textlength(line, font=font)
            cur_x = x1 + max(0, (x2 - x1 - line_w) / 2)
            draw.text((cur_x, cur_y), line, font=font, fill=fill)
            cur_y += line_h

    if legend_entries:
        pil = _draw_legend(pil, legend_entries, legend_layout)

    buf = io.BytesIO()
    pil.save(buf, format="PNG")
    return buf.getvalue()


# ─── OCR engine — lazy-loaded, per-key events prevent blocking on download ────
#
#  FIX #3: the old code held _reader_lock for the entire model download
#  (potentially minutes).  Now we use a per-key threading.Event so that
#  concurrent requests for the same language wait without blocking other langs.
#
_readers       = {}   # tuple(langs) → EasyOCR reader (once loaded)
_reader_events = {}   # tuple(langs) → threading.Event (set when load complete/failed)
_reader_lock   = threading.Lock()
_infer_lock    = threading.Lock()   # serialises PyTorch inference (not thread-safe)

# RapidOCR: unlike EasyOCR, one shared engine instance covers every language
# we've tested it against (es/pt/vi/tr all read correctly from the same
# default-config engine — see Devlog "RapidOCR: second local OCR engine").
# No per-language variants, so no keyed dict/event map needed — just a
# single lazily-loaded singleton behind a lock.
_rapidocr_engine = None
_rapidocr_lock   = threading.Lock()
_rapidocr_infer_lock = threading.Lock()   # serialises onnxruntime inference,
                                           # matching _infer_lock's caution for
                                           # EasyOCR even though onnxruntime is
                                           # generally more thread-safe than
                                           # raw PyTorch — costs nothing since
                                           # OCR calls are already serialised
                                           # per-page.

def _get_reader(chapter_lang: str):
    import easyocr                # lazy — no import cost at startup
    langs = _easyocr_langs(chapter_lang)
    key   = tuple(langs)

    # Fast path + loader/waiter decision in a single critical section.
    # Merging the two avoids a race window where a concurrent thread could
    # finish loading between the fast-path check and the loader decision,
    # causing a second (redundant) model download.
    with _reader_lock:
        if key in _readers:
            return _readers[key]
        if key not in _reader_events:
            evt       = threading.Event()
            _reader_events[key] = evt
            is_loader = True
        else:
            evt       = _reader_events[key]
            is_loader = False

    if not is_loader:
        # Wait until the loader thread finishes (or fails)
        evt.wait()
        reader = _readers.get(key)
        if reader is None:
            raise RuntimeError(f"OCR model {langs} failed to load — retry the page.")
        return reader

    # ── We are the loader thread ──────────────────────────────────────────────
    try:
        print(f"  [OCR] Loading model for {langs}  (first run may download ~100–400 MB)…")
        reader = easyocr.Reader(langs, gpu=False, verbose=False)
        print(f"  [OCR] {langs} ready.")
        with _reader_lock:
            _readers[key] = reader
        return reader
    except Exception:
        # Remove the event so the next request can attempt loading again
        with _reader_lock:
            _reader_events.pop(key, None)
        raise
    finally:
        evt.set()   # always unblock any waiters, even on failure


def _get_rapidocr_engine():
    """
    Lazily load the single shared RapidOCR engine instance.

    No chapter_lang parameter, unlike _get_reader() — RapidOCR's default
    bundled model (PP-OCRv6, ~30 MB, ships inside the pip package itself)
    already covers a single unified multi-language character set that
    includes every language we've tested it against (es, pt, vi, tr, plus
    en/ch). One instance serves all of them; there's nothing to key on.

    This is *why* RapidOCR handled the language-mismatch test case (a
    Portuguese page inside a chapter declared Spanish) with no accuracy
    loss, while EasyOCR — bound to whatever language set _get_reader()
    picked for the chapter — degraded on that page's SFX text. See Devlog
    entry "RapidOCR: second local OCR engine" for the test that found this.

    Languages RapidOCR's default model does NOT cover (ko, th, ar, ru/uk
    Cyrillic, and others) would need an explicit per-language model fetch
    from RapidOCR's own model catalog (hosted on modelscope.cn) — not
    implemented here. Those languages already route to Gemini Vision via
    VISION_LANGS regardless of which local engine is selected, so this
    doesn't currently limit anything in practice; flagged here so it's not
    a surprise if RapidOCR is ever pointed at a language outside that set.
    """
    global _rapidocr_engine
    if _rapidocr_engine is not None:
        return _rapidocr_engine
    with _rapidocr_lock:
        if _rapidocr_engine is None:
            from rapidocr import RapidOCR
            print("  [OCR] Loading RapidOCR engine (first run may download "
                  "~30 MB)…")
            _rapidocr_engine = RapidOCR()
            print("  [OCR] RapidOCR ready.")
    return _rapidocr_engine


# ─── Gemini Vision OCR ───────────────────────────────────────────────────────

_VISION_LANG_NAMES = {
    # CJK / complex scripts (original Vision langs)
    'ja':    'Japanese',
    'zh':    'Chinese (Simplified)',
    'zh-hk': 'Chinese (Traditional / Cantonese)',
    # Korean — EasyOCR is notoriously shaky on hangul in manga
    'ko':    'Korean',
    # Southeast Asian scripts
    'vi':    'Vietnamese',
    'th':    'Thai',
    'id':    'Indonesian',
    'ms':    'Malay',
    # Arabic / right-to-left
    'ar':    'Arabic',
    # European languages
    'en':    'English',
    'fr':    'French',
    'es':    'Spanish',
    'es-la': 'Spanish (Latin American)',
    'de':    'German',
    'pt':    'Portuguese',
    'pt-br': 'Portuguese (Brazilian)',
    'it':    'Italian',
    'ru':    'Russian',
    'uk':    'Ukrainian',
    'pl':    'Polish',
    'nl':    'Dutch',
    'tr':    'Turkish',
    'cs':    'Czech',
    'hu':    'Hungarian',
    'ro':    'Romanian',
    'sv':    'Swedish',
    'da':    'Danish',
    'fi':    'Finnish',
    'no':    'Norwegian',
    'hr':    'Croatian',
    'sk':    'Slovak',
    'bg':    'Bulgarian',
    'lt':    'Lithuanian',
    'lv':    'Latvian',
}

def _ocr_gemini_vision(image_bytes: bytes, lang: str, key: str, model: str) -> tuple:
    """
    Send a manga page image to Gemini Vision and ask it to extract all text
    regions with approximate centre positions.

    Returns: (regions, fallback_reason, usage)
      - regions        : list of dicts matching EasyOCR output schema
                         [{"text":"…","cx":45.2,"cy":23.1,"box":[x1%,y1%,x2%,y2%]}]
                         Empty list on any failure.
      - fallback_reason: None on success; otherwise one of:
                         "quota"   — 429 rate-limit / quota exhausted
                         "error"   — other HTTP error from Gemini API
                         "network" — connection / timeout error
                         "parse"   — response arrived but JSON could not be parsed
                         "empty"   — Vision returned OK but found no text on page
      - usage          : {"prompt_tokens", "completion_tokens", "total_tokens"}
                         for the cost tracker (see cost-tracker.js), or None
                         when no HTTP response was ever received (network/
                         connection-level failures, or a non-2xx status —
                         Gemini doesn't bill for those, so there's nothing to
                         report). Present even on a "parse"/"empty" outcome,
                         since Gemini still billed for a completed request in
                         those cases even though we couldn't use the result.
    """
    import base64, json as _json, re as _re

    lang_name = _VISION_LANG_NAMES.get(lang, 'the source language')

    # ── Resize before encoding to cut image-token cost ───────────────────────
    # A flat (800, 1200) box is tuned for a normal manga page's aspect ratio
    # (~1.5:1). thumbnail() picks ONE scale factor that satisfies BOTH target
    # dimensions — for a tall webtoon strip (e.g. 800x6000, ~7.5:1) that means
    # the factor gets dragged all the way down to whatever the 1200 height cap
    # demands, crushing the WIDTH along with it even though the width alone
    # was already comfortably within its own 800 budget. Net effect: a strip
    # could come out ~160px wide, well past the point of legible text — while
    # a normal page (aspect < 2) is untouched by this and behaves exactly as
    # before.
    #
    # Fix: let the height budget grow with the page's own aspect ratio once
    # it's clearly not a normal page, so the scale factor stays close to 1 for
    # a page that's merely "tall" rather than being squished purely because
    # 1200 was sized for a normal page. Still capped (4800) so a pathological,
    # uncut mega-strip gets bounded image-token cost rather than growing
    # unboundedly — it'll still lose some width at that point, but nowhere
    # near as badly as the flat 1200 cap did.
    try:
        _img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        _src_w, _src_h = _img.size
        _aspect = _src_h / max(_src_w, 1)
        _max_h  = min(int(800 * _aspect), 4800) if _aspect > 2.0 else 1200
        _img.thumbnail((800, _max_h), Image.LANCZOS)
        _buf = io.BytesIO()
        _img.save(_buf, format="JPEG", quality=85)
        image_bytes = _buf.getvalue()
        mime = "image/jpeg"
    except Exception:
        mime = "image/png" if image_bytes[:4] == b'\x89PNG' else "image/jpeg"

    b64 = base64.b64encode(image_bytes).decode()

    # ── Vision OCR prompt ────────────────────────────────────────────────────
    # KEY DESIGN NOTES
    # • Do NOT use responseMimeType:"application/json" — that locks Flash-Lite
    #   into a constrained generation mode where it outputs syntactically-valid
    #   JSON without actually reasoning about pixel positions, producing a
    #   hallucinated cx ≈ 97 for every item regardless of real bubble location.
    # • Do NOT set thinkingBudget:0 — Flash-Lite with zero thinking budget
    #   cannot perform the spatial reasoning needed to estimate cx/cy accurately.
    #   A small positive budget (512 tokens) is enough for coordinate estimation.
    #   For models that don't support thinking, the parameter is silently ignored.
    # • The prompt gives explicit coordinate semantics with spatial examples so
    #   that even a small/budget model can follow the expected output format.
    prompt = (
        f"You are a manga OCR engine. Carefully examine the image and extract "
        f"ALL visible text from this manga page. The text is in {lang_name}.\n"
        f"Many speech bubbles use VERTICAL text — read top-to-bottom, output as one string.\n\n"
        f"Return ONLY a JSON array (no markdown fences, no explanation):\n"
        f'[{{"text":"exact text","type":"speech|thought|sfx|narration|sign",'
        f'"cx":<0-100>,"cy":<0-100>,'
        f'"x1":<0-100>,"y1":<0-100>,"x2":<0-100>,"y2":<0-100>}},...]\n\n'
        f"COORDINATE RULES — read carefully:\n"
        f"  cx = distance from the LEFT edge of the image, as a percentage (0–100).\n"
        f"       cx=0 → leftmost pixel.  cx=50 → image centre.  cx=100 → rightmost pixel.\n"
        f"  cy = distance from the TOP edge of the image, as a percentage (0–100).\n"
        f"       cy=0 → top pixel.       cy=50 → image middle.  cy=100 → bottom pixel.\n"
        f"  x1/y1 = top-left corner of the bounding box (same 0-100 % scale).\n"
        f"  x2/y2 = bottom-right corner of the bounding box.\n\n"
        f"  Spatial examples:\n"
        f"    Top-left bubble  → cx≈20, cy≈15, x1≈10,y1≈8, x2≈35,y2≈25\n"
        f"    Top-right bubble → cx≈75, cy≈12, x1≈60,y1≈5, x2≈90,y2≈22\n"
        f"    Centre bubble    → cx≈50, cy≈50, x1≈35,y1≈42,x2≈65,y2≈58\n"
        f"    Bottom-left SFX  → cx≈18, cy≈85, x1≈5, y1≈80,x2≈30,y2≈92\n\n"
        f"  IMPORTANT: cx > 90 should be RARE — only for text literally at the right border.\n"
        f"  LOOK at where each speech bubble is in the image and estimate realistically.\n\n"
        f"OTHER RULES:\n"
        f"- Do NOT translate. Keep original characters exactly as printed.\n"
        f"- One entry per speech bubble / caption box / sound effect / sign.\n"
        f"- Skip panels with no text. Skip decorative lines and panel borders."
    )

    payload = {
        "contents": [{
            "role": "user",
            "parts": [
                {"inline_data": {"mime_type": mime, "data": b64}},
                {"text": prompt},
            ]
        }],
        "generationConfig": {
            "temperature":     0.1,
            "maxOutputTokens": 2048,
            # Allow a small thinking budget so the model can reason about
            # spatial positions. Models without thinking support ignore this.
            "thinkingConfig":  {"thinkingBudget": 512},
            # Do NOT set responseMimeType:"application/json" here — see note above.
        },
    }

    url = GEMINI_API.format(model=model) + f"?key={key}"
    try:
        r = requests.post(
            url, json=payload,
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
            timeout=60,
        )
        if not r.ok:
            if r.status_code == 429:
                print(
                    f"  [Vision OCR] Rate-limited (429) — falling back to EasyOCR. "
                    f"Free tier quota may be exhausted."
                )
                return [], "quota", None
            else:
                print(f"  [Vision OCR] Gemini error {r.status_code}: {r.text[:200]}")
                return [], "error", None
        gemini_resp = r.json()
        # Usage IS meaningful even on a request that otherwise fails to parse
        # below (a "parse"/"empty" outcome still consumed real input+output
        # tokens — Gemini billed for them whether or not our regex found a
        # usable JSON array in the response) — so grab it here, once, right
        # after we have gemini_resp, and thread it through every return path
        # below rather than only the success path.
        usage_meta = gemini_resp.get("usageMetadata")
        usage = None
        if isinstance(usage_meta, dict):
            usage = {
                "prompt_tokens":     usage_meta.get("promptTokenCount", 0),
                "completion_tokens": usage_meta.get("candidatesTokenCount", 0),
                "total_tokens":      usage_meta.get("totalTokenCount", 0),
            }
        cand  = (gemini_resp.get("candidates") or [{}])[0]
        parts = cand.get("content", {}).get("parts", [])
        text = ""
        for part in parts:
            if not part.get("thought", False):
                candidate = part.get("text", "")
                if candidate.strip():
                    text = candidate
                    break
        if not text and parts:
            text = parts[0].get("text", "")
        clean = text.replace("```json", "").replace("```", "").strip()
        match = _re.search(r"\[[\s\S]*\]", clean)
        if not match:
            return [], "parse", usage
        items = _json.loads(match.group(0))
        out = []
        for item in items:
            if not isinstance(item, dict):
                continue
            t  = str(item.get("text", "")).strip()
            cx = float(item.get("cx", 50))
            cy = float(item.get("cy", 50))
            if not t:
                continue
            x1 = item.get("x1")
            y1 = item.get("y1")
            x2 = item.get("x2")
            y2 = item.get("y2")
            if None not in (x1, y1, x2, y2):
                try:
                    box = [float(x1), float(y1), float(x2), float(y2)]
                except (TypeError, ValueError):
                    box = None   # sentinel — compute from cx/cy after normalization
            else:
                box = None       # sentinel — compute from cx/cy after normalization
            out.append({"text": t, "cx": cx, "cy": cy, "box": box,
                        # Capture model-supplied type hint (new prompt asks for it)
                        "vision_type": str(item.get("type", "")).lower().strip()})

        # ── Normalize 0-1 / 0-1000 → 0-100 if model returned non-percentage coords ──
        # Different Gemini tiers fail in different, mutually-exclusive ways:
        #
        #  A) ALL fractional  — every cx/cy is 0–1    (max_coord < 2.0)
        #                       Mostly Flash-Lite.  Fix: multiply entire batch by 100.
        #
        #  B) MIXED           — most values are 0–1 fractions but one or two
        #                       items (e.g. a page-credit sign near an edge)
        #                       are already 0–100 percentages.  A single large
        #                       outlier makes max_coord >> 2, so the all-or-
        #                       nothing guard in Case A never fires, leaving
        #                       all other badges stuck at <2 % — invisible.
        #
        #                       Detection: if ANY value >= 5 (unambiguously a
        #                       percentage) AND ANY value < 2 (unambiguously a
        #                       fraction) coexist in the same batch, it is
        #                       definitively mixed regardless of batch size.
        #                       Fix: rescale only the sub-2 values by × 100.
        #
        #  C) NATIVE 0-1000   — the whole batch is on Gemini's standard object-
        #                       detection/grounding scale (0-1000) instead of
        #                       the 0-100 scale asked for in the prompt.  Seen
        #                       almost exclusively on the larger/flagship
        #                       models (3.5 Flash, 3.1 Pro) — their stronger
        #                       built-in spatial-grounding prior overrides the
        #                       prompt's custom scale more often than
        #                       Flash-Lite's does. Previously this fell through
        #                       both Case A and B untouched (nothing here is
        #                       <2, and there's no small straggler to pair a
        #                       large value with) straight into the safety
        #                       clamp below, which pins any value >99 down to
        #                       99 — since almost no real manga text sits in
        #                       the literal top-left 10% of the page, nearly
        #                       every badge collapsed into the bottom-right
        #                       corner, and every box clamped into a
        #                       near-full-page rectangle.
        #                       Detection: a MAJORITY of values in the batch
        #                       are unambiguously >100 (impossible on a
        #                       correctly-scaled 0-100 batch).  Fix: divide
        #                       the entire batch by 10.
        #
        # Real manga text is never at the very image edge, so:
        #   • a legitimate 2 % coordinate essentially never occurs in practice
        #   • anything < 2 when something else is > 5 is always a stray fraction
        if out:
            # Debug: dump raw model coords before any normalization/fallback
            # so we can tell from server logs whether cx, cy, or both are
            # being hallucinated / mis-scaled.
            print("  [Vision OCR] raw coords: " +
                  ", ".join(f"({o['cx']:.1f},{o['cy']:.1f})" for o in out))

            all_vals  = [v for o in out for v in (o["cx"], o["cy"])]
            max_coord = max(all_vals)

            has_large    = any(v >= 5.0  for v in all_vals)   # clearly percentage
            has_small    = any(v <  2.0  for v in all_vals)   # clearly fractional
            over100_frac = sum(1 for v in all_vals if v > 100.0) / len(all_vals)

            if max_coord < 2.0:
                # Case A — all fractional
                print(f"  [Vision OCR] All-fractional coords (max={max_coord:.3f}) — rescaling to 0-100")
                for o in out:
                    o["cx"]  = round(o["cx"]  * 100, 1)
                    o["cy"]  = round(o["cy"]  * 100, 1)
                    if o["box"] is not None:
                        o["box"] = [round(v * 100, 1) for v in o["box"]]
            elif over100_frac >= 0.5:
                # Case C — native 0-1000 grounding scale
                print(f"  [Vision OCR] 0-1000-scale coords (max={max_coord:.1f}, "
                      f"{over100_frac:.0%} of values >100) — rescaling ÷10 to 0-100")
                for o in out:
                    o["cx"]  = round(o["cx"]  / 10, 1)
                    o["cy"]  = round(o["cy"]  / 10, 1)
                    if o["box"] is not None:
                        o["box"] = [round(v / 10, 1) for v in o["box"]]
            elif has_large and has_small:
                # Case B — mixed format, fix per-item stragglers
                stragglers = [o for o in out if o["cx"] < 2.0 or o["cy"] < 2.0]
                print(f"  [Vision OCR] Mixed-format coords (max={max_coord:.1f}) "
                      f"— rescaling {len(stragglers)} straggler(s) to 0-100")
                for o in stragglers:
                    if o["cx"] < 2.0:
                        o["cx"] = round(o["cx"] * 100, 1)
                    if o["cy"] < 2.0:
                        o["cy"] = round(o["cy"] * 100, 1)
                    if o["box"] is not None:
                        o["box"] = [round(v * 100, 1) if v < 2.0 else round(v, 1)
                                    for v in o["box"]]

            # Safety clamp — no badge should escape the visible image area
            for o in out:
                o["cx"] = max(1.0, min(99.0, o["cx"]))
                o["cy"] = max(1.0, min(99.0, o["cy"]))
                if o["box"] is not None:
                    o["box"] = [max(0.0, min(100.0, v)) for v in o["box"]]

            # ── Extreme-cluster fallback ─────────────────────────────────────
            # Flash-Lite with no thinking budget sometimes hallucinates cx ≈ 97
            # for every single item regardless of actual bubble position.
            # This is detectable: if >= 70 % of cx values are > 85 % (right
            # edge where speech bubbles never live), the cx half of the batch
            # is garbage.
            #
            # cy is hallucinated far less often than cx, so instead of
            # throwing it away too, we KEEP the model's cy estimates — they
            # usually still track each bubble's vertical position — and only
            # override cx, pinning every badge into a thin LEFT-margin column
            # so the numbered circles stay legible and line up with the
            # bubble each one actually belongs to.
            #
            # Only if cy is ALSO clustered/degenerate (span < 10 %, i.e. the
            # model dumped every item near the same point) do we fall back to
            # spreading badges evenly down the left margin in model order —
            # that's the old "garbage in, garbage out" behaviour, kept as a
            # last resort.
            if len(out) >= 2:
                cx_vals    = [o["cx"] for o in out]
                right_frac = sum(1 for v in cx_vals if v > 85) / len(cx_vals)
                if right_frac >= 0.70:
                    n       = len(out)
                    cy_vals = [o["cy"] for o in out]
                    cy_span = max(cy_vals) - min(cy_vals)

                    if cy_span >= 10.0:
                        print(
                            f"  [Vision OCR] Extreme right-cluster ({right_frac:.0%} have cx>85) "
                            f"— cy spread looks usable (span={cy_span:.1f}%), "
                            f"keeping model cy, moving {n} badge(s) to left margin"
                        )
                        for o in out:
                            o["cx"] = 8.0
                            o["box"] = [3.0, max(1.0, o["cy"] - 3.5),
                                        13.0, min(99.0, o["cy"] + 3.5)]
                    else:
                        step = 90.0 / max(n - 1, 1)
                        print(
                            f"  [Vision OCR] Extreme right-cluster ({right_frac:.0%} have cx>85) "
                            f"AND cy is also clustered (span={cy_span:.1f}%) "
                            f"— redistributing {n} badge(s) evenly down left margin"
                        )
                        for i, o in enumerate(out):
                            o["cx"] = 8.0
                            o["cy"] = round(5.0 + i * step, 1)
                            o["box"] = [3.0, o["cy"] - 3.5, 13.0, o["cy"] + 3.5]

        # ── Fill fallback boxes from the now-normalised cx/cy ─────────────────
        # Done AFTER normalisation so the ±8/±5 offsets are in the 0-100 %
        # space regardless of whether the model used fractions or percentages.
        for o in out:
            if o["box"] is None:
                o["box"] = [o["cx"] - 8.0, o["cy"] - 5.0,
                            o["cx"] + 8.0, o["cy"] + 5.0]

        if not out:
            return [], "empty", usage
        return out, None, usage

    except requests.exceptions.ConnectionError:
        # Not "falling back to EasyOCR" — this function doesn't know which
        # local engine is configured (no local_engine param here). ocr_page()
        # logs the real engine name right after this returns.
        print(f"  [Vision OCR] Network error — falling back to local OCR")
        return [], "network", None
    except requests.exceptions.Timeout:
        print(f"  [Vision OCR] Timeout — falling back to local OCR")
        return [], "network", None
    except Exception as e:
        print(f"  [Vision OCR] failed: {e}")
        return [], "error", None


# ─── Panel border detection ───────────────────────────────────────────────────

def _find_panel_borders(gray: np.ndarray, img_w: int, img_h: int):
    """
    Detect horizontal and vertical panel border lines in a manga page.

    Strategy: morphological OPEN with a long thin kernel.  A feature only
    survives the OPEN if it spans at least 40 % of the image dimension, which
    reliably captures panel borders while ignoring speech bubble outlines,
    character art, and screentone patterns.

    Returns:
        h_borders — sorted list of y-coordinates (pixel) of horizontal borders
        v_borders — sorted list of x-coordinates (pixel) of vertical borders
    """
    _, binary = cv2.threshold(gray, 50, 255, cv2.THRESH_BINARY_INV)

    # ── Horizontal borders ────────────────────────────────────────────────────
    min_h_span = max(1, int(img_w * 0.40))
    h_kernel   = cv2.getStructuringElement(cv2.MORPH_RECT, (min_h_span, 1))
    h_img      = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kernel)

    # ── Vertical borders ──────────────────────────────────────────────────────
    min_v_span = max(1, int(img_h * 0.40))
    v_kernel   = cv2.getStructuringElement(cv2.MORPH_RECT, (1, min_v_span))
    v_img      = cv2.morphologyEx(binary, cv2.MORPH_OPEN, v_kernel)

    def _cluster(indices, gap: int = 6) -> list:
        """Collapse a run of consecutive pixel indices into a single midpoint."""
        if not len(indices):
            return []
        borders, run_start, prev = [], int(indices[0]), int(indices[0])
        for idx in indices[1:]:
            idx = int(idx)
            if idx - prev > gap:
                borders.append((run_start + prev) // 2)
                run_start = idx
            prev = idx
        borders.append((run_start + prev) // 2)
        return borders

    h_rows = np.where(np.any(h_img > 0, axis=1))[0]
    v_cols = np.where(np.any(v_img > 0, axis=0))[0]

    return _cluster(h_rows), _cluster(v_cols)


def _crosses_border(
    box_a: tuple, box_b: tuple,
    h_borders: list, v_borders: list,
) -> bool:
    """
    Return True if a direct path from box_a to box_b must cross a panel border.

    We check whether any detected border line falls strictly inside the gap
    between the two boxes — not inside either box itself.
    """
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b

    # Vertical gap (potential horizontal border between them)
    gap_top    = min(ay2, by2)   # bottom of the higher box
    gap_bottom = max(ay1, by1)   # top  of the lower  box
    if gap_bottom > gap_top:
        for y in h_borders:
            if gap_top < y < gap_bottom:
                return True

    # Horizontal gap (potential vertical border between them)
    gap_left  = min(ax2, bx2)   # right edge of the left  box
    gap_right = max(ax1, bx1)   # left  edge of the right box
    if gap_right > gap_left:
        for x in v_borders:
            if gap_left < x < gap_right:
                return True

    return False


# ─── Bubble contour detection ─────────────────────────────────────────────────
#
# STATUS: validated against real pages — genuinely helps in some cases, had a
# known, understood blind spot in others that a later fix attempt (below)
# targets directly. Read this before "fixing" it.
#
# CONFIRMED WORKING: a compact dialogue region fused with a large, distant,
# differently-shaped block (e.g. a chapter title / logo bar spanning most of
# the page width) — the veto correctly separates them, with zero observed
# regressions across every other region on the same page, including a
# legitimate same-bubble "staggered lettering" region that was the main
# regression risk (two sub-columns of ONE sentence, zigzagging down a single
# narrow bubble — see _detect_column_split's docstring for that pattern).
#
# PREVIOUSLY CONFIRMED NOT WORKING (root-caused, fix attempted below — see
# "OUTLINE-TRACING FIX ATTEMPT"): two separate bubbles that are visually
# adjacent, similarly sized, and similarly shaped (e.g. two roughly-equal-
# width text columns side by side, a common two-characters-talking layout)
# — confirmed by eye against the source art to be genuinely two different
# bubbles, but the merge still fused them; the veto never fired. This is the
# same underlying gap as KNOWN_ISSUES_DRAFT.md's "Confirmed, blocking:
# _merge_bubble_regions over-merges adjacent bubbles on RapidOCR's fragment
# output" entry (Brazil_raw.jpg) — RapidOCR's denser fragmentation just made
# it easier to reach in practice; the gap itself predates RapidOCR and isn't
# engine-specific.
#
# WHY THE GAP EXISTS (confirmed, not just theorized — see below): the
# failing case and the working case differ in more than just "two bubbles vs
# one" — the working case has a large size/shape asymmetry between the two
# blocks, while the failing case has two similarly-sized adjacent blobs. Two
# same-sized bubbles sitting close together have their flat-white fill
# regions blur into the SAME connected component during segmentation —
# especially when the ink outline between them is thin or low-contrast,
# which is exactly the kind of edge the flatness box-filter (ksize 9x9) is
# prone to smoothing over: the 9x9 window mostly sees flat fill on both
# sides of a thin line, so the averaged variance can still land under
# _BUBBLE_FLATNESS_THRESHOLD directly on top of the line. This is a
# limitation of "segment the whole page into flat blobs via smoothed
# variance" as a strategy, not a bug in _crosses_bubble_boundary's sampling
# logic (that part was tested and corrected separately — see its
# docstring): the label MAP itself was wrong (one label where there should
# be two), so no amount of correct sampling of that map could recover the
# missing boundary.
#
# OUTLINE-TRACING FIX ATTEMPT (_bubble_outline_mask, called from
# _find_bubble_components): closing this gap for real meant explicitly
# detecting thin ink lines between adjacent similarly-shaped regions rather
# than tuning _BUBBLE_FLATNESS_THRESHOLD / _BUBBLE_LIGHTNESS_FLOOR — as
# anticipated below, a genuinely separate piece of image-processing work,
# not a constant to nudge. Implemented via per-pixel adaptive thresholding
# (compares each pixel to its own local neighbourhood mean, unlike the
# page-wide-calibrated flatness filter) to catch faint/thin lines the
# flatness filter's averaging smooths away, and subtracts them from the
# flat+light candidate mask before connected-components runs — carving a
# real topological gap at the boundary instead of trying to detect the
# absence of one after the fact. Margin-based fixes (HORIZONTAL_GAP_FACTOR,
# in _merge_bubble_regions) were tried FIRST and proven mathematically
# incapable of closing this gap on the real page that motivated it (the
# real illegitimate gap there, 1px, is tighter than the real legitimate
# gap a same-bubble merge needs to preserve, 5px) — this is why the fix
# lives in segmentation, not in the merge margins.
#
# STATUS OF THE FIX: implemented, and TESTED AGAINST THE REAL Brazil_raw.jpg
# PAGE — result: does NOT resolve it. The exact reported symptom still
# reproduces verbatim on that page with this fix applied (confirmed via
# byte-identical output to the fix disabled — this code is inert on that
# page, not harmful, just ineffective there). Root cause, confirmed by
# rendering the actual label map against the source art: on that page the
# two bubbles aren't divided by a thin/faint ink line this can detect —
# there is NO ink of any kind in the gap (pure 255 white, verified by
# reading the real pixels). They're drawn as one fused "double-bubble"
# silhouette with no internal dividing wall at all — a materially
# different failure mode than "a boundary too faint to detect," which is
# all adaptive thresholding (or any per-pixel ink signal) can ever help
# with. Full writeup, including a follow-up shape-based (distance-
# transform/watershed) attempt that ALSO didn't naively work and why, is
# in KNOWN_ISSUES_DRAFT.md under "Fix attempt #3 verification result."
# Left in place because it's confirmed harmless and may still help a page
# where the boundary is genuinely faint rather than absent — that case
# hasn't actually been confirmed on a real page yet, only synthesized.
# Do not describe this fix as resolving the confirmed-blocking bug; it
# does not, on the page that defines what "resolving" it means.
#
# WHAT ACTUALLY RESOLVED THAT BUG: the fused double-bubble "waist" veto —
# see the "Fused double-bubble (waist) detection" section further down
# this file, and KNOWN_ISSUES_DRAFT.md's "RESOLVED (verified on the real
# page)" entry. Short version: on that page the two bubbles are one fused
# silhouette with no separator of any kind between them, so both the
# distance-based and the ink-based approaches were looking for something
# that isn't there; the signal that works is the SHAPE's constriction
# between the two lobes. That fix is verified on the real page and
# regression-checked on 3 more pages across both engines.
#
# The correction UI (✏ CORRECT — see box-overlay.js / correction-ui.js)
# remains the fallback for what neither catches — notably vertically-
# stacked fused bubbles, which the waist veto deliberately does not
# handle (see its scope notes).
#
# Note for whoever verifies this: reading two column halves back as
# English and judging whether each "sounds like a complete sentence" is
# NOT a valid test for whether they're one bubble or two — both a genuine
# two-bubble split AND a single bubble with a two-clause sentence can read
# as fully grammatical either combined or split. This was tried during
# development here and produced confident-sounding false conclusions in
# both directions before being caught by checking the actual source art.
#
# ORIGINAL DESIGN RATIONALE (still accurate — why this exists at all):
#
# _find_panel_borders deliberately REQUIRES a feature to
# span >=40% of the image dimension before it counts as a border — that
# floor exists specifically so speech-bubble outlines (which are much
# smaller) don't get mistaken for panel borders. That means it structurally
# cannot be reused or "loosened" to find bubble outlines; lowering the 40%
# floor would start picking up character linework and screentone edges
# too. A bubble boundary needs a different detection strategy entirely.
#
# Strategy: rather than trying to trace a drawn outline (which fails for
# "borderless" bubbles — common in some art styles, where the only signal
# is a flat-white blob against textured/dark background, no ink outline at
# all), segment the page into connected components of "flat, light"
# pixels. This reuses the same flatness intuition _region_texture_variance
# already relies on elsewhere in this file (bubble fills read as low
# Laplacian-variance flat regions; screentone/gradient art does not) but
# applies it page-wide as a one-time segmentation instead of a per-box
# ring sample. Two OCR fragments are "in the same bubble" if they fall
# inside the same connected flat-light component; two fragments in
# DIFFERENT components must belong to different bubbles (or one is inside
# a bubble and the other is sitting on bare page background/art), and
# should never be merged regardless of how small the pixel gap between
# their boxes is.
#
# This deliberately does NOT try to distinguish "a real bubble" from "a
# blank panel background" or "a page gutter" by shape — it doesn't need
# to. All _crosses_bubble_boundary needs to know is "are these two
# fragments in the SAME flat-light blob or not"; a fragment sitting in
# bare white background rather than a drawn bubble will still get its own
# connected-component id, and two fragments in that same background blob
# merging is no worse than today's behaviour (today they'd merge purely
# on pixel distance with no bubble-awareness at all). The only NEW
# guarantee this adds is: fragments in two DIFFERENT flat-light blobs
# never merge, which is exactly the two-bubble-fusion bug this is meant
# to fix.
def _bubble_outline_mask(gray: np.ndarray) -> np.ndarray:
    """
    Detect thin, low-contrast ink strokes — specifically the kind of 1-3px
    dividing line that separates two adjacent, similarly-bright speech
    bubbles — using LOCAL adaptive thresholding rather than the page-wide
    flatness filter _find_bubble_components otherwise relies on.

    WHY THIS EXISTS (see KNOWN_ISSUES_DRAFT.md, "Confirmed, blocking:
    _merge_bubble_regions over-merges adjacent bubbles on RapidOCR's
    fragment output" for the full real-page writeup this fixes):
    _find_bubble_components' flatness test box-filters squared Laplacian
    over a 9x9 window before thresholding. That's deliberately coarse —
    cheap, page-wide, tuned for "is this whole area bubble fill" — but a
    thin, faint dividing line gets diluted by that averaging: the window
    mostly sees flat white fill on both sides of the line, so the averaged
    variance can land under _BUBBLE_FLATNESS_THRESHOLD even directly on
    top of the line itself. That silently bridges what should be two
    separate flat-light components into one — confirmed on Brazil_raw.jpg,
    where two bubbles fused into a single connected component despite a
    real ink line between them (closest measured real-pixel gap: 1.0px).
    Splitting the merge MARGIN (HORIZONTAL_GAP_FACTOR, in
    _merge_bubble_regions) was tried first and proven mathematically
    unable to fix this: the real illegitimate gap on that page (1px) is
    tighter than the real legitimate gap a same-bubble merge needs
    (5px), so no geometric threshold can separate the two cases. This
    function targets the actual root cause instead — the SEGMENTATION
    missing the line — rather than trying to compensate for it downstream.

    Adaptive thresholding asks a different question than the flatness
    filter: not "how much does intensity vary in a neighbourhood" but "is
    this pixel darker than its OWN local neighbourhood's mean" — which is
    exactly what an ink line is, no matter how faint, as long as it's
    genuinely darker than the paper immediately around it. This is a
    deliberately separate, more sensitive signal, used only to carve
    barriers into the flatness mask — never to replace it (large areas of
    genuine texture/screentone would trip adaptive thresholding constantly
    and are already correctly excluded by the flatness+lightness test).

    Returns a uint8 0/255 mask, same shape as `gray`: 255 = "this pixel
    sits on a locally-dark line/stroke and should never be treated as
    bubble-fill, regardless of what the flatness filter says." The mask is
    dilated by 1px so the barrier is topologically solid against
    8-connected flood fill — a bare 1-pixel-wide diagonal chain can still
    leak through 8-connectivity at the corners; dilating closes that gap
    and also bridges small anti-aliasing breaks along the line.

    UNVALIDATED STARTING VALUES (block_size=15, C=7) — same caveat as
    every other threshold in this file: chosen to react to a 1-3px line's
    own local contrast without being swamped by a whole bubble's-worth of
    surrounding white, and tested against synthetic data reproducing the
    reported line thinness/faintness (see test_bubble_outline_tracing.py),
    not yet checked against the real Brazil_raw.jpg page.
    """
    if gray.size == 0:
        return np.zeros(gray.shape, dtype=np.uint8)

    block_size = 15  # must be odd; local neighbourhood adaptiveThreshold compares each pixel against
    C          = 7   # subtracted from the local mean; small positive value so flat paper / scan noise isn't flagged as "line"

    outline = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV,
        block_size, C,
    )

    # Close small anti-aliasing gaps along the line and guarantee the
    # barrier is solid against 8-connectivity flood fill (see docstring).
    kernel  = np.ones((3, 3), np.uint8)
    outline = cv2.dilate(outline, kernel, iterations=1)
    return outline


def _find_bubble_components(gray: np.ndarray, img_w: int, img_h: int):
    """
    Segment the page into connected components of flat, light regions —
    the same "flat bubble fill" signal _region_texture_variance samples
    locally, applied once, page-wide, as a full segmentation.

    Returns a label map: a 2-D int32 array the same shape as `gray`, where
    label_map[y, x] is the connected-component id at that pixel (0 = not
    flat/light — i.e. background art, screentone, text ink itself, or a
    detected bubble-outline stroke — see _bubble_outline_mask), or None if
    the page is too small/degenerate to segment usefully.

    Deliberately conservative about what counts as "flat": a small
    Laplacian-variance box filter, thresholded well below
    _TEXTURE_VARIANCE_THRESHOLD (which was calibrated for "flat enough to
    skip inpainting" — a looser bar than we want here, since we need
    actual bubble-interior flatness, not merely "flatter than screentone").
    A pixel also has to be light (bubble fills are white/near-white in the
    overwhelming majority of cases) to count, which is what keeps large
    flat DARK areas (e.g. a night-sky panel background, a black gutter)
    from being treated as one giant bubble blob alongside real bubbles.

    OUTLINE CARVING (see _bubble_outline_mask docstring for the full
    real-page bug this addresses): the flatness+lightness mask above is,
    on its own, blind to thin/faint dividing lines between two adjacent
    bubbles — averaging smooths them away. Before connected-components
    runs, pixels flagged by _bubble_outline_mask's more sensitive, purely
    local adaptive-threshold check are explicitly excluded from the
    candidate mask, regardless of what the flatness test alone would have
    said. This carves a real topological gap into the mask wherever a
    detectable ink line exists, so connectedComponents naturally reports
    two separate labels for two bubbles divided by a line too thin/faint
    for the flatness filter to see on its own — without needing the
    flatness thresholds themselves to be re-tuned per page.
    """
    if gray.size == 0 or img_w < 8 or img_h < 8:
        return None

    # Local flatness: box-filtered Laplacian variance, computed once for
    # the whole page (cheap — a single filter pass, not per-fragment).
    lap        = cv2.Laplacian(gray, cv2.CV_64F)
    lap_sq     = lap * lap
    local_var  = cv2.boxFilter(lap_sq, ddepth=-1, ksize=(9, 9))

    # Deliberately stricter than _TEXTURE_VARIANCE_THRESHOLD (120.0) — that
    # constant answers "flat enough to flood-fill instead of inpaint",
    # which tolerates more texture than we want here. This threshold is
    # UNVALIDATED — needs checking against a real page (see STATUS above)
    # rather than assumed correct by analogy to the inpainting constant.
    _BUBBLE_FLATNESS_THRESHOLD = 40.0
    _BUBBLE_LIGHTNESS_FLOOR    = 200  # 0-255; bubble fill treated as "light"

    flat_mask  = (local_var < _BUBBLE_FLATNESS_THRESHOLD)
    light_mask = (gray > _BUBBLE_LIGHTNESS_FLOOR)
    bubble_candidate = (flat_mask & light_mask).astype(np.uint8)

    # NEW — carve out thin/faint ink-outline barriers the coarse flatness
    # filter smooths over. See _bubble_outline_mask docstring and
    # KNOWN_ISSUES_DRAFT.md's "Confirmed, blocking" entry for the real
    # page this targets. Applied unconditionally (not opt-in) since this
    # can only ever REMOVE candidate pixels — it narrows components, it
    # can never merge two that the flatness test alone would have kept
    # separate, so there's no new failure mode symmetric to the one this
    # fixes.
    outline_mask = _bubble_outline_mask(gray)
    bubble_candidate[outline_mask > 0] = 0

    # Connected components on the flat+light mask. 8-connectivity so a
    # bubble whose fill has a few stray antialiased pixels doesn't
    # fragment into multiple components at its own edges.
    num_labels, label_map = cv2.connectedComponents(bubble_candidate, connectivity=8)
    if num_labels <= 1:
        # Nothing on the page was flat+light enough to form a component —
        # degenerate page (e.g. all-screentone, no bubbles) or the
        # thresholds above are wrong for this page's contrast/exposure.
        return None
    return label_map


def _crosses_bubble_boundary(
    box_a: tuple, box_b: tuple,
    label_map,
) -> bool:
    """
    Return True if a direct path from box_a to box_b passes through two
    DIFFERENT flat-light components (per _find_bubble_components) —
    meaning a merge between them should be refused regardless of pixel
    distance, because they belong to different bubbles.

    CORRECTED VERSION — see inline note at the bottom of this docstring
    for what was wrong with the first attempt and why; this replaces it,
    not just tunes it.

    Approach: sample a short line of points between box_a's center and
    box_b's center (not each box's own interior — see below for why), and
    look at which flat-light component each sampled point falls in.
    Points that don't land on a flat-light pixel at all (label 0 — could
    be gap background, ink, or genuine non-bubble art) are skipped, not
    treated as a bail-out signal; we only need a *few* informative points
    along the path to get a confident read on "which bubble(s) does this
    path pass through", since a path between two word-fragments crosses
    much more open bubble-fill than either fragment's own tightly-cropped
    box does.

    If the informative points along the path resolve to a SINGLE
    component throughout → same bubble → merge allowed (returns False).
    If they resolve to two or more DIFFERENT components → path leaves one
    bubble and enters another → merge refused (returns True). If there
    aren't enough informative points to say anything (e.g. the whole gap
    is dark background with no flat-light pixels at all — ambiguous, or a
    literal same-pixel/zero-length gap) → inconclusive → returns False,
    matching "no bubble-boundary signal available, fall back to today's
    pixel-distance-only behaviour" — same conservative default as before,
    just reached without the flaw described below.

    label_map is None if _find_bubble_components couldn't segment the
    page — always returns False in that case.

    WHAT WAS WRONG WITH THE FIRST VERSION, for the record: it looked at
    each box's OWN interior and required a clear majority (>=60%) of that
    interior to land in one component, treating anything less — including
    "zero flat-light pixels found at all" — as inconclusive. That sounds
    conservative, but it silently made the veto never fire in practice:
    an OCR box is snugly cropped around actual glyphs, so a realistic box
    is dominated by dark ink strokes, not the surrounding flat-white
    bubble fill. Tested against a synthetic box with just 40% ink
    coverage (a modest, realistic figure — nowhere near an extreme case),
    BOTH boxes came back with zero flat-light pixels detected at all,
    so the function bailed out to "don't block" every time — which
    matches the real-world symptom: this veto was live in the merge loop
    across several confirmed two-bubble-merge cases (ch4/NAMORADO/
    OPORTUNIDADE pages) and none of them were caught. Sampling the PATH
    BETWEEN the boxes instead of each box's own cramped interior fixes
    this, because that path passes through the actual open bubble-fill
    around each fragment (which is flat-light), not just the ink-dense
    text itself.
    """
    if label_map is None:
        return False

    h, w = label_map.shape

    def _center(box):
        x1, y1, x2, y2 = box
        return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)

    def _sample(px: float, py: float, radius: int = 3):
        """Look at a small neighbourhood around (px, py) rather than a
        single pixel, and return the most common non-zero label there (or
        None if the whole neighbourhood is label 0 / off-image). A small
        neighbourhood is far more likely to catch a flat-light pixel near
        a sampled point than the exact single pixel would, without being
        so large it blurs across a real nearby boundary."""
        ix, iy = int(round(px)), int(round(py))
        x1, y1 = max(0, ix - radius), max(0, iy - radius)
        x2, y2 = min(w, ix + radius + 1), min(h, iy + radius + 1)
        if x2 <= x1 or y2 <= y1:
            return None
        patch = label_map[y1:y2, x1:x2]
        nonzero = patch[patch > 0]
        if nonzero.size == 0:
            return None
        vals, counts = np.unique(nonzero, return_counts=True)
        return int(vals[np.argmax(counts)])

    ax, ay = _center(box_a)
    bx, by = _center(box_b)

    # Sample points along the straight line between the two centers,
    # INCLUDING the endpoints — a fragment's own center often already
    # sits in its bubble's flat fill just outside the densest ink, even
    # though the fragment's full bounding box (checked in the old,
    # replaced version) does not.
    n_samples = 9
    components_seen = []
    for k in range(n_samples):
        t = k / (n_samples - 1)
        px = ax + t * (bx - ax)
        py = ay + t * (by - ay)
        comp = _sample(px, py)
        if comp is not None:
            components_seen.append(comp)

    distinct = set(components_seen)
    if len(distinct) < 2:
        # Either everything informative along the path agreed on one
        # component (same bubble), or nothing informative was found at
        # all (ambiguous) — either way, don't block the merge.
        return False
    return True


# ─── Fused double-bubble ("waist") detection ──────────────────────────────────
#
# WHY THIS EXISTS — the case _crosses_bubble_boundary structurally cannot
# catch, confirmed against the real Brazil_raw.jpg page:
#
# _crosses_bubble_boundary answers "are these two fragments in DIFFERENT
# flat-light components". That's the right question when two adjacent
# bubbles are genuinely separated by *something* — an ink outline, panel
# background, anything that breaks the flat-light mask between them. It is
# useless when they aren't, and on real manga pages they frequently aren't:
# a very common art convention draws two adjacent speech bubbles as ONE
# fused silhouette — a single continuous outer contour pinched into a
# figure-8/peanut shape, with NO internal dividing wall at all. Verified
# directly on Brazil_raw.jpg: the pixels between the two bubbles' text are
# pure 255 white, no ink of any kind, and rendering the label map confirms
# both bubbles are one single connected component wall to wall.
#
# Two prior fix attempts failed on exactly this, and both failed for
# reasons that generalize — worth recording so neither gets retried:
#   1. Margin tuning (HORIZONTAL_GAP_FACTOR, in _merge_bubble_regions):
#      mathematically cannot work here. On this page the real gap between
#      DIFFERENT bubbles' fragments (1px) is TIGHTER than the real gap a
#      legitimate SAME-bubble merge must preserve (5px, staggered
#      lettering). No geometric distance threshold separates 1 < 5.
#   2. Ink-line detection (_bubble_outline_mask, adaptive thresholding):
#      cannot work here either. It finds faint/thin lines that exist; on
#      this shape there is no line to find. (That code is retained — it's
#      confirmed harmless and targets a different, real failure mode — but
#      it is inert on fused bubbles.)
#
# WHAT ACTUALLY SEPARATES THE TWO CASES: shape, not distance and not ink.
# A fused double-bubble has a genuine geometric CONSTRICTION (a "waist")
# between its two lobes — that's what makes it read as two bubbles to a
# human eye despite having one outline. A single bubble containing two
# columns of text (the legitimate "staggered lettering" pattern this must
# NOT break) has no such constriction: it's one convex-ish blob whose
# width profile varies smoothly.
#
# Measured on the real page, per-column vertical extent of the component:
#   fused double-bubble : 183px (left lobe) → 136px (waist) → 183px (right
#                         lobe)                        → ratio 0.74
#   five genuine single bubbles on the SAME page       → ratios 1.00-1.05
#                         (i.e. no interior local minimum at all)
# That is a clean, well-separated signal, not a marginal one.
#
# DELIBERATELY NARROW SCOPE — this is a veto that can only ever *prevent*
# merges, so a false positive splits a bubble that should have stayed
# whole, which is exactly the regression risk the whole file worries
# about. Three constraints keep the blast radius small:
#   - Only consulted for pairs already in the SAME component (different
#     components are _crosses_bubble_boundary's job, and it handles them).
#   - Only for PREDOMINANTLY HORIZONTAL pairs (|dx| > |dy|). Side-by-side
#     is the confirmed real-world case. The vertical analogue (two bubbles
#     stacked into a vertical figure-8) is deliberately NOT enabled: the
#     vertical direction is the hot path — every ordinary line-to-line
#     pair inside every normal bubble is vertically separated — so a false
#     positive there would shatter ordinary multi-line dialogue, and there
#     is no confirmed real page to validate a threshold against. Do not
#     enable it without one.
#   - The constriction is measured strictly BETWEEN the two fragments' own
#     x-centers, not "anywhere in the component" — a waist somewhere else
#     in the blob says nothing about whether THESE two fragments are in
#     different lobes.

# Ratio of (narrowest extent between the two fragments) to (the narrower
# of the two fragments' own local extents) below which the shape is
# treated as genuinely pinched. Measured separation on real pages:
# 0.74 for the confirmed fused double-bubble vs 1.00-1.05 for confirmed
# single bubbles, so this sits well clear of both. UNVALIDATED beyond the
# pages in eval_samples/ — same caveat as every other constant here.
_WAIST_RATIO_THRESHOLD = 0.85

# Below this many pixels between the two x-centers there aren't enough
# columns to read a profile from, and any "minimum" is noise.
_WAIST_MIN_SPAN_PX = 12


def _component_column_extents(label_map, comp_label: int, cache: dict):
    """
    Per-column vertical EXTENT (bottom-most minus top-most mask pixel) of
    one connected component, plus the x offset the array starts at.

    Extent, not pixel count, is the point: a bubble's interior is riddled
    with text-shaped holes (glyphs are dark, so they're excluded from the
    flat-light mask), which makes a raw per-column pixel COUNT track how
    much text is in that column rather than how tall the bubble is there.
    Extent measures the outer silhouette and ignores interior holes
    entirely, which is what "how pinched is the shape here" needs.

    Cached per component — the merge loop is O(n^2) over fragment pairs
    and many pairs share a component, so this is computed at most once per
    component per _merge_bubble_regions call.
    """
    if comp_label in cache:
        return cache[comp_label]
    blob = (label_map == comp_label)
    cols = np.where(blob.any(axis=0))[0]
    if cols.size == 0:
        cache[comp_label] = (None, 0)
        return cache[comp_label]
    x1, x2 = int(cols.min()), int(cols.max())
    sub = blob[:, x1:x2 + 1]
    any_col = sub.any(axis=0)
    first   = np.argmax(sub, axis=0)
    last    = sub.shape[0] - 1 - np.argmax(sub[::-1], axis=0)
    ext = np.where(any_col, last - first + 1, 0).astype(np.float64)
    cache[comp_label] = (ext, x1)
    return cache[comp_label]


def _dominant_component_for_box(label_map, box: tuple, pad: int = 14) -> int:
    """
    Which flat-light component does this OCR fragment sit in?

    Sampled from the box PADDED OUTWARD, not the box itself: an OCR box is
    cropped snugly around glyphs, so its interior is mostly dark ink —
    which is label 0 (excluded from the mask) — and sampling it directly
    returns "no component" for a fragment that's plainly inside a bubble.
    This is the same trap documented in _crosses_bubble_boundary's
    docstring, which is why that function samples the path BETWEEN boxes
    rather than either box's interior. Padding outward reaches the open
    bubble fill immediately around the text. Returns 0 if nothing.
    """
    h, w = label_map.shape
    x1 = max(0, int(box[0]) - pad); y1 = max(0, int(box[1]) - pad)
    x2 = min(w, int(box[2]) + pad); y2 = min(h, int(box[3]) + pad)
    if x2 <= x1 or y2 <= y1:
        return 0
    patch = label_map[y1:y2, x1:x2]
    nz = patch[patch > 0]
    if nz.size == 0:
        return 0
    vals, counts = np.unique(nz, return_counts=True)
    return int(vals[np.argmax(counts)])


def _waist_separates_boxes(box_a: tuple, box_b: tuple, label_map, cache: dict) -> bool:
    """
    Return True if box_a and box_b sit in two different LOBES of one fused
    double-bubble — i.e. the component they share is visibly pinched
    between them — meaning the merge should be refused even though
    _crosses_bubble_boundary (correctly) reports them as one component.

    See the section comment above for why this exists, what it's measured
    against, and why it's scoped to horizontal pairs only. Returns False
    for anything it can't confidently measure — this is a veto layered on
    top of existing behaviour, so "not sure" must mean "don't block",
    matching every other conservative default in this file.
    """
    if label_map is None:
        return False

    acx = (int(box_a[0]) + int(box_a[2])) // 2
    acy = (int(box_a[1]) + int(box_a[3])) // 2
    bcx = (int(box_b[0]) + int(box_b[2])) // 2
    bcy = (int(box_b[1]) + int(box_b[3])) // 2

    # Horizontal pairs only — see section comment ("DELIBERATELY NARROW
    # SCOPE"). Vertically-separated pairs are the ordinary line-to-line
    # case and must not be touched.
    if abs(bcx - acx) <= abs(bcy - acy):
        return False
    if abs(bcx - acx) < _WAIST_MIN_SPAN_PX:
        return False

    la = _dominant_component_for_box(label_map, box_a)
    lb = _dominant_component_for_box(label_map, box_b)
    # Different components (or none) → not this function's case;
    # _crosses_bubble_boundary already decides those.
    if la == 0 or la != lb:
        return False

    ext, off = _component_column_extents(label_map, la, cache)
    if ext is None:
        return False

    i_a, i_b = sorted((acx - off, bcx - off))
    i_a = max(0, i_a)
    i_b = min(len(ext) - 1, i_b)
    if i_b - i_a < _WAIST_MIN_SPAN_PX:
        return False

    span = ext[i_a:i_b + 1]
    waist = float(span.min())
    # Compare against the narrower of the two fragments' OWN local extents,
    # not the component's global maximum: a lobe that is legitimately
    # smaller than its neighbour shouldn't read as "pinched" just for being
    # small, and a tall unrelated part of the same component elsewhere
    # shouldn't set the bar either.
    ends = min(float(ext[i_a]), float(ext[i_b]))
    if ends <= 0:
        return False
    return (waist / ends) <= _WAIST_RATIO_THRESHOLD


# ─── Bubble region merging ────────────────────────────────────────────────────

def _merge_bubble_regions(
    boxes,
    img_w: int,
    img_h: int,
    h_borders:    list | None  = None,
    v_borders:    list | None  = None,
    margin_scale: float        = 0.5,
    confidences:  list | None  = None,
    min_conf:     float | None = None,
    clustered_floor: float     = 0.0,
    bubble_label_map            = None,
    gray                        = None,
):
    """
    Group OCR bounding boxes that belong to the same speech bubble, then merge
    each group into a single region with combined text.

    Algorithm:
      1. Expand every box by MERGE_MARGIN pixels on all sides.
      2. Any two expanded boxes that overlap → same bubble (union-find),
         UNLESS a panel border line falls in the gap between them.
      3. If confidences/min_conf were supplied, drop low-confidence boxes
         UNLESS they share a group with at least one confident box (see
         "Confidence-aware filtering" below) — otherwise keep everything
         (caller is responsible for pre-filtering, as before).
      4. Within each group sort fragments top-to-bottom then left-to-right
         (natural reading order inside the bubble) and join their text.
      5. Return one {text, cx, cy, box, confidence} per group, centred on the
         merged bounding box. `confidence` is the min recognition confidence
         across the group's fragments (None if `confidences` wasn't supplied).

    Confidence-aware filtering (confidences / min_conf / clustered_floor):
      `confidences` is a list PARALLEL to `boxes` (confidences[i] is boxes[i]'s
      recognition confidence), not embedded in the box tuple itself — this is
      deliberate. Extending the 5-element box tuple to 6 elements would silently
      break any existing `x1, y1, x2, y2, text = box`-style unpacking elsewhere
      in this function (there's one such line) or anywhere a caller does the
      same; a parallel list sidesteps that entirely since every other access
      pattern in this function already reads boxes[i][idx], which tolerates
      unrelated data living alongside it in a separate list just fine.

      When both `confidences` and `min_conf` are given, a box normally needs
      confidences[i] >= min_conf to survive — UNLESS it shares a merge group
      with at least one box that clears min_conf on its own, in which case
      confidences[i] >= clustered_floor is enough. Rationale: a low-confidence
      fragment adjacent to (and merging with) confident neighbours in the same
      bubble is much more likely to be real, correctly-recognised text that
      merely scored low (seen in practice with stylised mixed-case manga
      fonts) than an isolated low-confidence fragment with no such support,
      which is more likely genuine noise. clustered_floor still guards against
      pure noise happening to fall inside a real bubble's expanded margin.

      If `confidences` is None (the default), no confidence filtering happens
      here at all — behaves exactly as before for any caller that doesn't
      pass it.

    bubble_label_map (NEW, UNVALIDATED — see "Bubble contour detection"
      section above _find_bubble_components): output of
      _find_bubble_components, a page-wide connected-components label map
      over flat/light regions. When supplied, two boxes whose expanded
      rects overlap are STILL refused a merge if _crosses_bubble_boundary
      says they sit in two different flat-light components — this is
      checked alongside (not instead of) the existing _crosses_border
      panel-border veto. None (the default) disables this check entirely
      and behaves exactly as before for any caller that doesn't pass it —
      same opt-in pattern as `confidences`.

    MERGE_MARGIN is content-adaptive and computed PER-BOX, not page-wide:
      margin(i) = height(box i) x margin_scale

      Each box is expanded using its OWN height, not a single page-wide
      median. Two boxes are candidates to merge if their expanded rects
      overlap — which succeeds if EITHER box's own margin is enough to
      bridge the gap, so a box only needs to "reach" as far as its own
      text size implies is reasonable for its own line spacing.

      This fixes a real bug in the old page-wide-median approach: a page
      mixing small incidental text (SFX, panel labels — low height) with
      one or more large, wide-line-spacing bubbles would compute a small
      global margin from the page's small-text median, which was then far
      too small to bridge the large bubble's own (proportionally larger)
      line gaps — silently splitting one bubble's sentence into multiple
      disconnected regions with no error or warning anywhere downstream.
      Per-box margins mean a bubble's own line height governs whether its
      own lines merge, independent of what else is on the page.

      margin_scale (default 0.5) is the user-tunable sensitivity knob.

      Webtoon strips (img_h / img_w > 2) use 60 % of the normal scale to
      avoid bridging vertically-stacked panels on tall narrow canvases.

      A small absolute floor still applies (4px) so degenerate zero/near-zero
      height boxes (stray noise) don't get an unreasonably tiny margin.

      Line-height note: the gap BETWEEN two lines of text ("leading") is
      typically wider than either line's own glyph height — measured
      against real EasyOCR output on manga-style multi-line bubbles, gaps
      of ~1.5x the box height are normal, not an outlier. A margin of
      0.5x each box's height (i.e. 1.0x combined between two adjacent
      boxes) was found to still be too small to bridge genuine same-bubble
      line gaps, so the per-box margin is scaled by a LINE_GAP_FACTOR on
      top of margin_scale — margin_scale remains the user-facing slider
      (unchanged range/meaning), LINE_GAP_FACTOR is the calibration
      constant that makes the default (1.0) actually bridge normal
      same-bubble line spacing.

      LINE_GAP_FACTOR is a FIRST-PASS distance estimate only, not the
      final word on whether two vertically-stacked fragments merge — it
      decides which pairs are even considered (via expanded-box overlap).
      For any pair that clears that bar, _profile_confirms_gap additionally
      checks the real pixels in the gap band: a horizontal ink-density
      profile that shows continuous ink (no whitespace valley) vetoes the
      merge even though the fixed multiplier said "close enough". This
      means a manga with unusually tight or loose leading is no longer
      solely at the mercy of one global constant — LINE_GAP_FACTOR only
      needs to be generous enough to admit true same-bubble pairs as
      CANDIDATES; the profile check is what actually confirms or rejects
      each one against that page's real spacing. The veto is one-directional
      (can only block a distance-approved merge, never force one distance
      would refuse) — see _profile_confirms_gap's docstring for why that's
      the safe default when the profile itself is inconclusive.

      HORIZONTAL_GAP_FACTOR (NEW) is the horizontal counterpart to
      LINE_GAP_FACTOR — margin(i) is now actually TWO values per box,
      margin_v(i) = height(i) x margin_scale x LINE_GAP_FACTOR and
      margin_h(i) = height(i) x margin_scale x HORIZONTAL_GAP_FACTOR,
      expanding each box by margin_v vertically and margin_h horizontally
      rather than one shared value in every direction. HORIZONTAL_GAP_FACTOR
      is deliberately much smaller than LINE_GAP_FACTOR: the only legitimate
      same-bubble reason to bridge a horizontal gap is staggered/zigzag
      lettering inside one narrow bubble, whose real gap is tight same-
      bubble spacing, not line-height. Unlike the vertical case,
      _profile_confirms_gap's ink-valley technique CANNOT do double duty
      here as a secondary check — a clean gap reads identically whether
      it's a normal word-space inside one bubble or open panel background
      between two different bubbles — so horizontal reach has to stay
      tight geometrically instead of leaning on a pixel-content veto to
      catch mistakes after the fact. See the constant's own comment above
      for the specific bug this fixes and its current (unvalidated)
      starting value.

    Panel border guard (h_borders / v_borders):
      Even if two expanded boxes overlap, they will NOT be merged if a detected
      panel border line lies in the gap between them.  This prevents speech
      bubbles from adjacent panels being collapsed into one region, which is the
      most common cause of incoherent translations.
    """
    if not boxes:
        return [], []

    h_borders = h_borders or []
    v_borders = v_borders or []

    # Calibration constant — NOT the user-facing slider. Chosen so that two
    # adjacent same-bubble lines (combined margin = 2 x own_margin) reliably
    # bridge a ~1.5x-box-height gap, which real EasyOCR output on manga-style
    # bubbles showed is normal line spacing, not an outlier.
    LINE_GAP_FACTOR = 1.6

    # NEW — separate, tighter calibration for HORIZONTAL reach. See
    # KNOWN_ISSUES_DRAFT.md, "Confirmed, blocking: _merge_bubble_regions
    # over-merges adjacent bubbles on RapidOCR's fragment output" for the
    # real-page bug this addresses.
    #
    # Until now, horizontal and vertical reach shared one LINE_GAP_FACTOR-
    # derived margin. That's correct for genuine same-bubble LINE-to-LINE
    # (vertical) gaps — what LINE_GAP_FACTOR was tuned against — but the
    # only legitimate reason this function ever needs to bridge a HORIZONTAL
    # gap is the "staggered lettering" pattern (two sub-columns of one
    # sentence zigzagging down a single narrow bubble — see the stacked-pair
    # comment below), and that pattern's real horizontal gap is tight
    # same-bubble spacing, nothing like a full line-height. Reusing the
    # line-spacing constant for horizontal reach meant it could ALSO bridge
    # the real physical gap between two separate, adjacent bubbles —
    # bubble-fill padding + border ink + the other bubble's own padding —
    # which is exactly the confirmed RapidOCR bug. RapidOCR's smaller, more
    # numerous fragments made this likelier to get hit in practice (more
    # fragment pairs land near the boundary), but the underlying issue — one
    # factor doing two jobs with different real-world scales — isn't
    # engine-specific, so this fix applies to both engines' margins alike.
    #
    # NOTE: this is deliberately a GEOMETRIC fix, not a pixel-content one.
    # The obvious first idea — reuse _profile_confirms_gap's ink-valley
    # technique for horizontal gaps the way it already works for vertical
    # ones — does NOT work here: a clean whitespace gap looks pixel-
    # identical whether it's a normal word-space INSIDE one bubble or page/
    # panel background BETWEEN two different adjacent bubbles. Ink density
    # can't tell those apart; only the gap's SIZE relative to normal
    # same-bubble spacing can, which is what this constant controls.
    #
    # UNVALIDATED STARTING VALUE — chosen conservatively small relative to
    # LINE_GAP_FACTOR, not yet measured against real pages. Needs checking
    # against (a) the RapidOCR Brazil_raw.jpg case (confirm the two bubbles
    # no longer merge) and (b) a real staggered-lettering page (confirm that
    # legitimate merge still succeeds) before this is trusted — same bar
    # every other constant in this file is held to.
    HORIZONTAL_GAP_FACTOR = 0.5

    is_webtoon  = (img_h / max(img_w, 1)) > 2.0
    eff_scale_v = margin_scale * LINE_GAP_FACTOR       * (0.6 if is_webtoon else 1.0)
    eff_scale_h = margin_scale * HORIZONTAL_GAP_FACTOR * (0.6 if is_webtoon else 1.0)

    # Per-box margin: each box reaches only as far as its OWN height implies,
    # rather than every box on the page sharing one page-wide median-derived
    # value. See docstring above for why this matters. Split into vertical/
    # horizontal components (NEW) so the two directions use their own
    # calibration; both still scale off the box's own HEIGHT in either case
    # (not width) since height is what tracks font size / line spacing
    # regardless of which direction reach is being measured in.
    margins_v = [max(4, int((boxes[i][3] - boxes[i][1]) * eff_scale_v))
                 for i in range(len(boxes))]
    margins_h = [max(4, int((boxes[i][3] - boxes[i][1]) * eff_scale_h))
                 for i in range(len(boxes))]

    # ── Union-Find ────────────────────────────────────────────────────────────
    n      = len(boxes)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x         = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    # Absolute ink/background thresholds — same convention as
    # _find_panel_borders' cv2.threshold(gray, 50, ...): ink on a manga
    # page is genuinely dark in absolute terms, not merely "darker than
    # whatever this specific crop's own local noise floor happens to be".
    # A THRESHOLD DERIVED FROM THE BAND'S OWN min/max (tried first, during
    # development of this function) is unstable: a band of pure paper-grain
    # noise with no real ink at all still spans a normal pixel range, and a
    # midpoint- or percentile-based threshold splits that noise ~50/50,
    # which reads as "every row is half-ink" — silently vetoing merges on
    # perfectly ordinary blank gaps. An absolute threshold anchored to real
    # page brightness conventions doesn't have this failure mode.
    _GAP_INK_ABS_THRESH  = 100   # 0-255; darker than this counts as "ink" (normal polarity)
    _GAP_BG_ABS_THRESH   = 155   # lighter than this counts as "ink" when polarity is inverted

    def _profile_confirms_gap(gray, gap_box: tuple,
                               frag_a_box: tuple, frag_b_box: tuple) -> bool | None:
        """
        Look at the actual ink in the page image between two candidate
        same-bubble fragments and decide whether a real whitespace valley
        separates them — a horizontal projection profile of the gap band,
        not a box-distance heuristic.

        This exists to replace a single global LINE_GAP_FACTOR (which
        assumes one "normal" leading for every manga on every page) with a
        per-gap, ground-truth check: does this SPECIFIC gap actually look
        like the space between two lines of text, or is it dense enough
        that it's more likely still inside one run of text (e.g. a
        descender/ascender-heavy font, or two fragments of the same word
        broken by OCR) — or bridged by something that isn't either
        fragment's text at all (a stray mark, a panel-border sliver,
        unrelated art between two DIFFERENT bubbles).

        gap_box is the (x1,y1,x2,y2) band strictly between the two
        fragments; frag_a_box/frag_b_box are the two ORIGINAL fragment
        boxes themselves, used ONLY to sample polarity (see below) — never
        for geometry.

        THREE THINGS THIS GOT WRONG DURING DEVELOPMENT, kept here because
        each is a real trap worth not re-falling into:

        1. A threshold derived from the gap band's OWN min/max (tried
           first) is unstable: a band of pure paper-grain noise with no
           real ink at all still spans a normal pixel range, and a
           midpoint- or percentile-based threshold splits that noise
           ~50/50 — reading as "every row is half-ink" and vetoing merges
           on perfectly ordinary blank gaps. Fixed by using a fixed
           ABSOLUTE ink threshold instead (same convention as
           _find_panel_borders' cv2.threshold(gray, 50, ...) — ink on a
           manga page is genuinely dark/light in absolute terms).

        2. Inferring polarity from the GAP BAND's own mean brightness
           (tried second) conflates "this band is mostly dark because it's
           mostly ink" with "this band has an inverted dark background" —
           a densely-inked bridge (the exact case that should veto a
           merge) has a low mean for the same reason an inverted-fill
           bubble does, so it got misread as inverted polarity and the
           dense ink was treated as background. Fixed by sampling polarity
           from the FRAGMENT INTERIORS instead (frag_a_box/frag_b_box) —
           we already know those contain real text, so their own bulk
           brightness reveals the bubble's true fill/ink direction without
           depending on how much ink happens to be in THIS gap, which is
           exactly the unknown being measured.

        3. Picking "whichever polarity produces fewer ink pixels" (tried
           third, as a fix for #2) fails for the identical reason #2 did:
           on a densely-inked bridge, the WRONG (inverted) polarity
           produces fewer flagged pixels almost by construction, so
           minority-class selection actively prefers the wrong reading
           exactly when the right answer is "mostly ink, veto".

        4. Even with correct polarity, a single full-width ink band in the
           MIDDLE of an otherwise-clean gap (e.g. a stray screentone fleck,
           a thin panel-border sliver that slipped past _find_panel_borders,
           or real art between two unrelated bubbles) can leave a valley on
           either side individually long enough to clear the length
           threshold below — but a full-width bridge is itself conclusive
           evidence the two fragments aren't connected by clean
           whitespace, regardless of how much clear space flanks it. This
           is checked explicitly, before the valley-length search, rather
           than assumed to be ruled out by requiring one long run.

        Returns:
          True  — profile shows a clear low-ink valley spanning the gap,
                  with no full-width bridge in it; genuine inter-line
                  whitespace, merge is safe.
          False — either a full-width ink bridge crosses the gap, or there's
                  no valley run long enough to trust; merging on distance
                  alone would be risky.
          None  — inconclusive (gap too small/degenerate to profile, no
                  usable fragment-polarity sample, or gray unavailable) —
                  caller falls back to the existing distance-based margin,
                  unchanged.

        Deliberately conservative: only used to VETO a merge that pixel
        distance would otherwise allow, never to force a merge that
        distance-overlap didn't already produce.
        """
        if gray is None:
            return None
        gh, gw = gray.shape[:2]
        gx1, gy1, gx2, gy2 = gap_box
        bx1, by1 = max(0, min(int(gx1), gw - 1)), max(0, min(int(gy1), gh - 1))
        bx2, by2 = max(0, min(int(gx2), gw)),     max(0, min(int(gy2), gh))
        if bx2 - bx1 < 4 or by2 - by1 < 2:
            return None  # band too thin/degenerate to profile meaningfully
        band = gray[by1:by2, bx1:bx2]

        def _frag_mean(box):
            fx1, fy1, fx2, fy2 = (max(0, int(v)) for v in box)
            fx2, fy2 = min(gw, fx2), min(gh, fy2)
            if fx2 <= fx1 or fy2 <= fy1:
                return None
            return float(gray[fy1:fy2, fx1:fx2].mean())

        frag_means = [m for m in (_frag_mean(frag_a_box), _frag_mean(frag_b_box)) if m is not None]
        if not frag_means:
            return None  # no usable polarity sample — inconclusive, don't veto
        frag_mean = sum(frag_means) / len(frag_means)

        # Polarity from the FRAGMENTS (known to contain real text), not
        # the gap band itself — see point 2/3 above for why that distinction
        # is load-bearing, not stylistic.
        is_ink = (band < _GAP_INK_ABS_THRESH) if frag_mean >= 128 else (band > _GAP_BG_ABS_THRESH)
        row_ink_frac = is_ink.mean(axis=1)

        # Full-width bridge veto (point 4 above) — checked before the
        # valley-length search, since it overrides a long valley on either
        # side of it.
        if (row_ink_frac > 0.6).any():
            return False

        # A genuine inter-line valley: at least one contiguous run of rows
        # with near-zero ink spanning a real fraction of the band height —
        # not just a single sparse row, which could be one thin serif/tail.
        valley_rows = row_ink_frac < 0.04
        if valley_rows.sum() == 0:
            return False  # continuous ink the whole way through — no valley at all

        best_run, cur_run = 0, 0
        for is_valley_row in valley_rows:
            cur_run = cur_run + 1 if is_valley_row else 0
            best_run = max(best_run, cur_run)
        band_h = by2 - by1
        return (best_run / band_h) >= 0.25

    def expanded(i):
        x1, y1, x2, y2, _ = boxes[i]
        mv, mh = margins_v[i], margins_h[i]
        return (x1 - mh, y1 - mv, x2 + mh, y2 + mv)

    def overlaps(a, b):
        ax1, ay1, ax2, ay2 = a
        bx1, by1, bx2, by2 = b
        return ax1 <= bx2 and bx1 <= ax2 and ay1 <= by2 and by1 <= ay2

    exp = [expanded(i) for i in range(n)]
    # Per-component extent profiles for the fused-double-bubble ("waist")
    # veto below. Built lazily and reused across all pairs sharing a
    # component — see _component_column_extents.
    waist_cache: dict = {}
    for i in range(n):
        for j in range(i + 1, n):
            if overlaps(exp[i], exp[j]):
                # Even if expanded boxes overlap, refuse to merge them if a
                # panel border separates the original (un-expanded) boxes,
                # OR if they sit in two different flat-light bubble
                # components — see _crosses_bubble_boundary docstring — OR
                # if they sit in two different LOBES of one fused
                # double-bubble (two adjacent bubbles drawn as a single
                # pinched silhouette with no dividing wall, which the
                # component check structurally cannot catch since there IS
                # only one component — see the "Fused double-bubble (waist)
                # detection" section comment). All three are independent
                # vetoes over the same candidate merge; any one blocks it.
                if (_crosses_border(boxes[i][:4], boxes[j][:4],
                                    h_borders, v_borders)
                        or _crosses_bubble_boundary(
                            boxes[i][:4], boxes[j][:4], bubble_label_map)
                        or _waist_separates_boxes(
                            boxes[i][:4], boxes[j][:4], bubble_label_map,
                            waist_cache)):
                    continue

                # Projection-profile veto: only meaningful for a
                # vertically-stacked, genuinely SEPARATED pair (one box
                # cleanly above the other with a real gap between them) —
                # that's the case LINE_GAP_FACTOR's fixed multiplier was
                # approximating with a single constant. Side-by-side
                # fragments on the same line have no "inter-line gap" to
                # profile, so skip those entirely rather than force a
                # vertical-band reading onto a horizontal relationship.
                #
                # CRITICAL, found via testing against a real manga page
                # (not synthetic data — see devlog/session notes): OCR line
                # boxes commonly OVERLAP slightly in y even for genuinely
                # separate, correctly-read lines — tight kerning, a
                # descender/ascender, or a few degrees of page skew are
                # enough. An earlier version of this check had no branch
                # for that case: it always picked SOME pair of edges to
                # treat as "the gap" (via sorted((ay2,by1)) vs
                # sorted((by2,ay1))), and when the boxes overlapped, that
                # produced a band spanning almost the FULL combined height
                # of both boxes — including their actual text ink — rather
                # than a real inter-line gap. The profile check then
                # correctly found "continuous ink" in that band (because it
                # WAS looking at real letters, not whitespace) and vetoed a
                # merge that should have gone through, since there was
                # never a real gap to evaluate. Confirmed on a real page:
                # two lines of one sentence ("PASE DEL" / "PUESTO 188",
                # y-ranges [1042,1079] and [1075,1111] — overlapping by 4px)
                # got permanently split into separate regions this way.
                #
                # Fix: require ay2 <= by1 (or by2 <= ay1) — a genuine,
                # non-overlapping vertical separation — before computing a
                # gap band at all. Overlapping pairs skip the profile check
                # entirely and fall through to the existing distance/border
                # checks only, exactly matching behaviour from before this
                # veto existed for the pairs where a "gap" reading was
                # never a coherent question to ask in the first place.
                ax1, ay1, ax2, ay2 = boxes[i][:4]
                bx1, by1, bx2, by2 = boxes[j][:4]
                stacked = (min(ax2, bx2) - max(ax1, bx1)) > 0  # meaningful x-overlap
                a_above_b = ay2 <= by1
                b_above_a = by2 <= ay1
                if stacked and gray is not None and (a_above_b or b_above_a):
                    gap_y1, gap_y2 = (ay2, by1) if a_above_b else (by2, ay1)
                    gap_x1, gap_x2 = max(ax1, bx1), min(ax2, bx2)
                    if gap_y2 > gap_y1:
                        verdict = _profile_confirms_gap(
                            gray, (gap_x1, gap_y1, gap_x2, gap_y2),
                            boxes[i][:4], boxes[j][:4],
                        )
                        if verdict is False:
                            # Continuous ink across the gap band, or a
                            # full-width bridge inside it (see
                            # _profile_confirms_gap docstring point 4) —
                            # distance math said "close enough" but the
                            # actual pixels show no clean line break here.
                            # Note: we only ever reach this branch for
                            # pairs that already passed overlaps(exp[i],
                            # exp[j]) above, i.e. pairs within the
                            # margin-expanded distance threshold — a gap
                            # too large to plausibly be the same bubble
                            # never reaches this profile check at all, so
                            # there's no separate "is the gap small
                            # enough" condition to enforce here; that
                            # gating already happened via LINE_GAP_FACTOR
                            # margins before this loop runs.
                            continue

                union(i, j)

    # ── Group by root ─────────────────────────────────────────────────────────
    groups: dict = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    # ── Confidence-aware filtering (only if the caller opted in) ───────────────
    # See docstring "Confidence-aware filtering" section for the full rationale.
    if confidences is not None and min_conf is not None:
        filtered_groups: dict = {}
        for root, indices in groups.items():
            has_confident_member = any(confidences[i] >= min_conf for i in indices)
            floor = clustered_floor if has_confident_member else min_conf
            kept = [i for i in indices if confidences[i] >= floor]
            if kept:
                filtered_groups[root] = kept
        groups = filtered_groups

    def _detect_column_split(idxs, min_overlap_frac=0.70, min_fragments=2):
        """
        Detect whether a merged region's fragments actually form TWO
        side-by-side columns of text rather than one multi-line paragraph.

        _line_cluster (below) groups fragments into visual "lines" by
        y-overlap, then reads each line left-to-right — which silently
        assumes single-column text. A genuine two-column bubble (e.g. a
        short aside next to a longer main line of dialogue, both inside
        one speech bubble) breaks that assumption: each column's line N
        sits at roughly the same height as the other column's line N, so
        _line_cluster groups them into the same "row" and interleaves the
        two independent columns word-by-word instead of reading one
        column fully before the other.

        Detection strategy ("vertical river" + "parallel Y-overlap"):
          1. Project all fragment x-ranges onto a 1D axis and find the
             widest completely-empty gap ("river"). No gap of meaningful
             width (>=3% of the region's own width) → not two columns.
          2. Split fragments into left/right of that gap's center. Each
             side needs >= min_fragments fragments, or this is more likely
             noise/a single stray fragment than a real column.
          3. THE KEY CHECK: rather than requiring the shorter side to span
             some fraction of the region's total height (which incorrectly
             rejects a real but short second column — e.g. a 2-line aside
             next to an 8-line main column), check how much of the SHORTER
             side's own height overlaps vertically with the TALLER side's
             height range. A genuine side-by-side column runs parallel to
             its neighbour regardless of how short it is, so this overlap
             is high (near 100%) even for a very short real column. A
             stray trailing line at the bottom of a paragraph, by
             contrast, sits BELOW the paragraph's bottom edge with little
             or no y-overlap — this check correctly rejects that case
             without needing to know anything about its absolute height.

        Returns (left_idxs, right_idxs) if a genuine split is detected,
        else None (caller falls through to normal single-column handling).
        """
        if len(idxs) < min_fragments * 2:
            return None

        region_x0 = min(boxes[i][0] for i in idxs)
        region_x1 = max(boxes[i][2] for i in idxs)
        if region_x1 <= region_x0:
            return None

        # Coarse x-axis occupancy scan to find the widest empty gap.
        RES = 200
        scale = RES / (region_x1 - region_x0)
        occupied = [False] * (RES + 1)
        for i in idxs:
            x1, _, x2, _, _ = boxes[i]
            a = max(int((x1 - region_x0) * scale), 0)
            b = min(int((x2 - region_x0) * scale), RES)
            for k in range(a, b + 1):
                occupied[k] = True

        best_gap = (0, 0)
        run_start = None
        for k in range(RES + 1):
            if not occupied[k]:
                if run_start is None:
                    run_start = k
            else:
                if run_start is not None and (k - run_start) > (best_gap[1] - best_gap[0]):
                    best_gap = (run_start, k)
                run_start = None
        if run_start is not None and (RES + 1 - run_start) > (best_gap[1] - best_gap[0]):
            best_gap = (run_start, RES + 1)

        if (best_gap[1] - best_gap[0]) < RES * 0.03:
            return None  # no meaningful gap — this is one column

        gap_x = region_x0 + (best_gap[0] + best_gap[1]) / 2 / scale
        left  = [i for i in idxs if (boxes[i][0] + boxes[i][2]) / 2 <  gap_x]
        right = [i for i in idxs if (boxes[i][0] + boxes[i][2]) / 2 >= gap_x]
        if len(left) < min_fragments or len(right) < min_fragments:
            return None

        l_min_y = min(boxes[i][1] for i in left);  l_max_y = max(boxes[i][3] for i in left)
        r_min_y = min(boxes[i][1] for i in right); r_max_y = max(boxes[i][3] for i in right)
        l_h, r_h = l_max_y - l_min_y, r_max_y - r_min_y
        if l_h <= r_h:
            shorter_min, shorter_max, shorter_h = l_min_y, l_max_y, l_h
            taller_min,  taller_max              = r_min_y, r_max_y
        else:
            shorter_min, shorter_max, shorter_h = r_min_y, r_max_y, r_h
            taller_min,  taller_max              = l_min_y, l_max_y

        overlap = max(0, min(shorter_max, taller_max) - max(shorter_min, taller_min))
        if shorter_h <= 0 or (overlap / shorter_h) < min_overlap_frac:
            return None  # shorter side doesn't run parallel to the taller one

        return (left, right)


    # ── Merge each group ──────────────────────────────────────────────────────
    regions      = []
    group_raw_ids = []   # parallel list: raw box indices per merged region
    for indices in groups.values():
        # Sort fragments into reading order by first clustering them into
        # visual LINES (by vertical overlap), then ordering lines top-to-
        # bottom and fragments left-to-right within each line.
        #
        # A naive sort by raw (y1, x1) alone is fragile: two words on the
        # same visual line can have slightly different y1 (detection noise,
        # or a short word's box simply not spanning the same vertical range
        # as a taller neighbour), which can push a word out of sequence
        # relative to where it actually reads — e.g. "un" placed after
        # "paseo tranquilo." even though "un" comes first in the sentence,
        # because "un"'s y1 happened to be a few px lower than its
        # same-line neighbour's. Clustering by vertical overlap first is
        # robust to that: two boxes are "the same line" if they share
        # significant vertical extent, regardless of small y1 differences.
        def _line_cluster(idxs):
            items = sorted(idxs, key=lambda i: boxes[i][1])  # seed by top-y
            lines: list[list[int]] = []
            for i in items:
                y1, y2 = boxes[i][1], boxes[i][3]
                placed = False
                for line in lines:
                    # Compare against the line's current vertical extent
                    ly1 = min(boxes[k][1] for k in line)
                    ly2 = max(boxes[k][3] for k in line)
                    overlap = min(y2, ly2) - max(y1, ly1)
                    min_h   = min(y2 - y1, ly2 - ly1)
                    if min_h > 0 and overlap / min_h > 0.4:
                        line.append(i)
                        placed = True
                        break
                if not placed:
                    lines.append([i])
            lines.sort(key=lambda line: min(boxes[k][1] for k in line))
            ordered = []
            for line in lines:
                line.sort(key=lambda i: boxes[i][0])  # left-to-right within line
                ordered.extend(line)
            return ordered

        # If this region's fragments genuinely form two side-by-side
        # columns (see _detect_column_split docstring), cluster+order each
        # column independently and read left column fully, then right
        # column, rather than letting _line_cluster interleave them line
        # by line. Otherwise (the common case), treat as one column as before.
        column_split = _detect_column_split(indices)
        if column_split:
            left_idxs, right_idxs = column_split
            indices = _line_cluster(left_idxs) + _line_cluster(right_idxs)
        else:
            indices = _line_cluster(indices)

        # Re-join fragments split across lines with a trailing hyphen.
        # e.g. ["SHUN-", "PEI."] → "SHUNPEI."
        texts  = [boxes[i][4] for i in indices]
        joined: list[str] = []
        for fragment in texts:
            if joined and joined[-1].endswith('-'):
                joined[-1] = joined[-1][:-1] + fragment
            else:
                joined.append(fragment)
        merged_text = " ".join(joined)
        mx1 = min(boxes[i][0] for i in indices)
        my1 = min(boxes[i][1] for i in indices)
        mx2 = max(boxes[i][2] for i in indices)
        my2 = max(boxes[i][3] for i in indices)

        # Region-level confidence — the MIN across every surviving fragment in
        # this group, not the average. A merged region is only as trustworthy
        # as its weakest fragment: a bubble that reads "PRESIDENTIAL" cleanly
        # except for one garbled "-DENTAL" fragment should still be flagged as
        # low-confidence overall, which an average would dilute away. None
        # when the caller didn't opt into confidence tracking at all (keeps
        # this field absent/None for any caller that never passes `confidences`).
        region_conf = (
            round(min(confidences[i] for i in indices), 3)
            if confidences is not None else None
        )

        regions.append({
            "text": merged_text,
            "cx":   round((mx1 + mx2) / 2 / img_w * 100, 1),
            "cy":   round((my1 + my2) / 2 / img_h * 100, 1),
            # Percentage bounding box so the frontend can overlay correction
            # boxes on the image without knowing the raw pixel dimensions.
            "box":  [
                round(mx1 / img_w * 100, 1), round(my1 / img_h * 100, 1),
                round(mx2 / img_w * 100, 1), round(my2 / img_h * 100, 1),
            ],
            # Recognition confidence, 0-1, min-across-fragments. None if this
            # region's boxes were merged without confidence data (a caller
            # that never passed `confidences`). See translate-client.js's
            # noise filter for how this gates translation.
            "confidence": region_conf,
        })
        group_raw_ids.append(list(indices))

    # Sort final regions top-to-bottom, keeping group_raw_ids in sync.
    if regions:
        paired = sorted(zip(regions, group_raw_ids),
                        key=lambda p: (p[0]["cy"], p[0]["cx"]))
        regions, group_raw_ids = map(list, zip(*paired))
    return regions, group_raw_ids


def _easyocr_readtext_primary(reader, arr, lang: str):
    """
    Run EasyOCR's primary (non-fallback) readtext pass and do the one piece
    of confidence filtering that's identical between both call sites:
    dropping empty strings and the short-word (<=2 char) carve-out.

    Shared by _run_easyocr_detection (the main per-page pipeline) and the
    /ocr-crop route (correction UI's single-region redraw) — these two used
    to hand-duplicate the exact same readtext() parameters and short-word
    threshold, which could silently drift out of sync if one were tuned
    without the other.

    Deliberately NOT shared:
      - The zero-box raw-image retry fallback (see _run_easyocr_detection
        step 4b). That's a page-level heuristic — "we found nothing at all
        on a whole manga page, preprocessing probably hurt us, try again on
        the raw image." It doesn't obviously apply to /ocr-crop, where a
        user hand-drew one small box and a genuinely empty result (e.g. an
        SFX box that's actually blank) is a normal, non-suspicious outcome,
        not evidence preprocessing failed. Forcing that retry onto every
        single-box correction crop would be a behavior change, not a
        refactor, so it stays main-pipeline-only.
      - Cluster-aware confidence filtering (_merge_bubble_regions' min_conf
        deferral). /ocr-crop has no merge step — a crop is already one
        region — so there's nothing to defer filtering to; it applies
        min_conf directly instead. That's an inherent shape difference
        between "OCR one page, then cluster fragments into bubbles" and
        "OCR one already-known bubble," not accidental duplication.

    Returns:
        (fragments, confidences) — parallel lists. fragments is a list of
        (bbox, text) tuples where bbox is EasyOCR's raw four-corner box
        ([[x1,y1],[x2,y1],[x2,y2],[x1,y2]]) and text is already .strip()'d;
        confidences are EasyOCR's raw per-fragment scores. Callers apply
        their own min_conf floor on top of this (they differ deliberately
        — see above).
    """
    raw = reader.readtext(
        arr,
        detail=1,
        paragraph=False,
        contrast_ths=0.1,    # default 0.1 — explicit for clarity
        adjust_contrast=0.5, # auto-boost low-contrast text regions
        text_threshold=0.6,  # slightly more permissive than default 0.7
        min_size=10,         # ignore sub-pixel noise detections
    )
    fragments, confidences = [], []
    for bbox, text, conf in raw:
        text = text.strip()
        if not text:
            continue
        if len(text) <= 2 and conf < SHORT_WORD_MIN_CONF:
            continue
        fragments.append((bbox, text))
        confidences.append(conf)
    return fragments, confidences


def _rapidocr_readtext_primary(engine, arr, lang: str):
    """
    RapidOCR counterpart to _easyocr_readtext_primary() — same contract,
    same short-word carve-out, so _run_rapidocr_detection can hand its
    output to the exact same _merge_bubble_regions() call EasyOCR uses.

    RapidOCR's call/return shape is genuinely different from EasyOCR's
    (engine(arr) -> object with .boxes/.txts/.scores, vs.
    reader.readtext(arr, **tuned_kwargs) -> list of (bbox, text, conf)
    tuples) — there is no equivalent to EasyOCR's contrast_ths /
    adjust_contrast / text_threshold / min_size knobs to pass through here;
    RapidOCR's own detector (DBNet-based, vs. EasyOCR's CRAFT) has a
    different tunable set entirely (box_thresh / unclip_ratio) that we are
    NOT tuning yet — this call uses RapidOCR's library defaults. Revisit
    once the real eval script (see Devlog) has enough data to tune against,
    same as EasyOCR's current thresholds were tuned against real pages
    rather than guessed.

    Returns:
        (fragments, confidences) — same shape as _easyocr_readtext_primary:
        fragments is [(bbox, text), …] with bbox as EasyOCR's four-corner
        convention ([[x1,y1],[x2,y1],[x2,y2],[x1,y2]]) so downstream box
        math (_run_easyocr_detection's box-building step) works unchanged
        for either engine.
    """
    result = engine(arr)
    fragments, confidences = [], []
    if result.boxes is None:
        return fragments, confidences
    for box, text, conf in zip(result.boxes, result.txts, result.scores):
        text = (text or "").strip()
        if not text:
            continue
        if len(text) <= 2 and conf < SHORT_WORD_MIN_CONF:
            continue
        # box is a (4,2) array in the same corner order EasyOCR uses —
        # convert to the same nested-list shape so callers don't need to
        # know which engine produced it.
        bbox = [[float(x), float(y)] for x, y in box]
        fragments.append((bbox, text))
        confidences.append(float(conf))
    return fragments, confidences


def _run_easyocr_detection(image_bytes: bytes, lang: str, margin_scale: float):
    """
    Run the full EasyOCR detection + bubble-merge pipeline on a page image.

    This is the box-DETECTION half of OCR: panel-border detection, CLAHE
    preprocessing, EasyOCR readtext, confidence filtering, and union-find
    bubble merging. It does not care which engine eventually supplies the
    *text* for each region — Gemini Vision results can be matched onto
    these boxes by _match_vision_to_easyocr() below, since EasyOCR's
    bounding boxes come from a real text-detection model and don't suffer
    from the spatial hallucination that small LLMs like Flash-Lite do.

    Returns:
        regions       — [{text, cx, cy, box, confidence, raw_box_ids}, …]
                         (EasyOCR's own recognised text; may be ignored by
                         the caller). confidence is min-across-fragments,
                         0-1, always a real number on this path (EasyOCR
                         always supplies confidences here).
        raw_boxes_out — [{id, text, box, px}, …] per-fragment boxes that
                         regions[i]['raw_box_ids'] index into
    """
    # 2. Decode
    try:
        pil  = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        w, h = pil.size
        arr  = np.array(pil)
    except Exception as e:
        abort(422, f"Image decode error: {e}")

    # 2b. Detect panel borders from the ORIGINAL grayscale image.
    #     Must be done before preprocessing because CLAHE can alter the dark
    #     border lines and make them harder to distinguish from panel content.
    gray_orig         = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    h_borders, v_borders = _find_panel_borders(gray_orig, w, h)
    # NEW, UNVALIDATED (see _find_bubble_components docstring) — computed
    # from the same pre-CLAHE grayscale array and for the same reason:
    # CLAHE's contrast remapping would distort the flatness signal this
    # relies on just as much as it would distort panel border lines.
    bubble_label_map     = _find_bubble_components(gray_orig, w, h)

    # 2c. Preprocess — CLAHE contrast enhancement + mild denoising.
    #     Improves OCR accuracy significantly for text printed over patterned
    #     or gradient backgrounds, and for languages with fine diacritics.
    arr = _preprocess_for_ocr(arr)

    # 3. OCR  (serialised — PyTorch is not thread-safe)
    try:
        reader = _get_reader(lang)
        with _infer_lock:
            fragments, frag_confidences = _easyocr_readtext_primary(reader, arr, lang)
    except Exception as e:
        abort(500, f"OCR failed: {e}")

    # 4. Build the candidate box list. Per-language min_conf is applied
    #    below via _merge_bubble_regions rather than here — see that
    #    function's "Confidence-aware filtering" docstring section for why:
    #    a low-confidence fragment that's spatially adjacent to (and would
    #    merge with) confident neighbours is much more likely to be real
    #    text than an isolated one, and only _merge_bubble_regions knows
    #    which fragments are adjacent. Filtering here, before clustering
    #    happens, can't tell the two cases apart. (The short-word carve-out
    #    is already applied — as a hard floor, not deferred — inside
    #    _easyocr_readtext_primary; see SHORT_WORD_MIN_CONF's module-level
    #    comment for why that one stays undeferred.)
    min_conf = _MIN_CONF_MAP.get(lang, 0.35)
    boxes = []          # each entry: (x1, y1, x2, y2, text)
    confidences = []    # parallel to boxes — see _merge_bubble_regions docstring
    for (bbox, text), conf in zip(fragments, frag_confidences):
        # bbox: [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        boxes.append((min(xs), min(ys), max(xs), max(ys), text))
        confidences.append(conf)

    # 4b. Fallback retry — only when preprocessing returned literally zero boxes.
    #     Threshold is 0, not 2, so wordless art pages (which correctly have no
    #     text) are never double-processed.  We only retry when OCR found nothing
    #     at all, suggesting preprocessing may have hurt rather than helped
    #     (e.g. an unusual panel where the selected channel was counterproductive).
    #     Uses the raw original image + EasyOCR's own max internal contrast boost.
    if len(boxes) == 0:
        print(f"  [OCR] Zero boxes from preprocessed image — retrying on raw "
              f"(lang={lang})")
        try:
            arr_raw = np.array(pil)
            with _infer_lock:
                raw2 = reader.readtext(
                    arr_raw,
                    detail=1,
                    paragraph=False,
                    contrast_ths=0.05,
                    adjust_contrast=1.0,
                    text_threshold=0.5,
                    min_size=8,
                )
            for bbox, text, conf in raw2:
                text = text.strip()
                if not text or conf < max(min_conf - 0.05, 0.20):
                    continue
                xs = [p[0] for p in bbox]
                ys = [p[1] for p in bbox]
                boxes.append((min(xs), min(ys), max(xs), max(ys), text))
                confidences.append(conf)
            if boxes:
                print(f"  [OCR] Raw fallback recovered {len(boxes)} box(es)")
        except Exception as e:
            print(f"  [OCR] Raw fallback failed: {e}")

    # 5. Build raw_box output (percentage + pixel coords) before merging.
    #    The frontend stores these to support the correction UI split feature.
    raw_boxes_out = [
        {
            "id":  idx,
            "text": b[4],
            "box": [
                round(b[0] / w * 100, 1), round(b[1] / h * 100, 1),
                round(b[2] / w * 100, 1), round(b[3] / h * 100, 1),
            ],
            "px":  [int(b[0]), int(b[1]), int(b[2]), int(b[3])],
        }
        for idx, b in enumerate(boxes)
    ]

    # 6. Merge nearby boxes — fragments from the same speech bubble get
    #    clustered together using union-find on expanded bounding boxes,
    #    with panel borders acting as hard merge barriers.
    regions, group_raw_ids = _merge_bubble_regions(
        boxes, w, h, h_borders, v_borders, margin_scale,
        confidences=confidences, min_conf=min_conf, clustered_floor=SHORT_WORD_MIN_CONF,
        bubble_label_map=bubble_label_map,
        # Same pre-CLAHE grayscale used for border/bubble detection above —
        # projection profiling needs real ink density, which CLAHE's
        # contrast remapping would distort just like it would the other
        # two signals (see the comment on gray_orig's first use).
        gray=gray_orig,
    )

    # 7. Attach raw_box_ids so the frontend knows which raw fragments
    #    belong to each merged region (needed for the split correction tool).
    for region, raw_ids in zip(regions, group_raw_ids):
        region["raw_box_ids"] = raw_ids

    # Panel border positions, as percentages of image width/height — same
    # coordinate convention as region cx/cy — so the frontend can do real
    # panel-aware reading-order sorting instead of guessing from cy alone.
    # This data was already being computed (used internally by the merge
    # step above for its panel-border merge guard) but previously discarded
    # before the response was built; nothing new is computed here, it's
    # just no longer thrown away.
    h_borders_pct = [round(y / h * 100, 1) for y in h_borders]
    v_borders_pct = [round(x / w * 100, 1) for x in v_borders]

    return regions, raw_boxes_out, h_borders_pct, v_borders_pct


def _run_rapidocr_detection(image_bytes: bytes, lang: str, margin_scale: float):
    """
    RapidOCR counterpart to _run_easyocr_detection() — identical shape,
    identical return contract, and reuses every shared helper that function
    uses (_find_panel_borders, _find_bubble_components, _preprocess_for_ocr,
    _merge_bubble_regions). Only step 3 (the actual OCR call) and its
    zero-box retry differ, because those are the only genuinely
    engine-specific pieces of the pipeline — see _rapidocr_readtext_primary
    for why the two engines' raw calling conventions don't unify further
    than this.

    Why this exists as a second, mostly-parallel function instead of one
    shared function with an engine parameter: this file's own precedent
    already does it this way — _easyocr_readtext_primary's docstring notes
    it's shared between this function and /ocr-crop, while each of *those*
    keeps its own orchestration. Two engine-specific top-level pipelines
    sharing small primitives is the established pattern here, not a new one.

    Tested (see Devlog "RapidOCR: second local OCR engine") on real
    Spanish/Portuguese/Vietnamese/Turkish manga pages: faster and lighter
    than EasyOCR across the board, more accurate on Portuguese, clearly
    *less* accurate on Vietnamese (systematic diacritic corruption that its
    own confidence score does not flag), and — unlike EasyOCR — unaffected
    by a page's language not matching the chapter's declared language,
    since _get_rapidocr_engine() doesn't key on language at all. None of
    that is encoded as a hard rule inside this function; see
    _recommend_local_engine() for the (currently provisional, single-page
    per language) per-language guidance surfaced to the user instead of
    baked into routing here.

    Returns: identical shape to _run_easyocr_detection — (regions,
    raw_boxes_out, h_borders_pct, v_borders_pct).
    """
    # 1-2c. Decode + panel/bubble detection + CLAHE preprocess — byte-for-byte
    # the same steps _run_easyocr_detection uses, since none of this is
    # EasyOCR-specific. Duplicated here rather than factored into a shared
    # helper for this first pass — see build note in Devlog for the planned
    # follow-up if a third engine ever gets added.
    try:
        pil  = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        w, h = pil.size
        arr  = np.array(pil)
    except Exception as e:
        abort(422, f"Image decode error: {e}")

    gray_orig             = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    h_borders, v_borders  = _find_panel_borders(gray_orig, w, h)
    bubble_label_map      = _find_bubble_components(gray_orig, w, h)
    arr = _preprocess_for_ocr(arr)

    # 3. OCR (serialised — see _rapidocr_infer_lock's comment on why we're
    #    cautious here even though onnxruntime is more thread-safe than
    #    PyTorch)
    try:
        engine = _get_rapidocr_engine()
        with _rapidocr_infer_lock:
            fragments, frag_confidences = _rapidocr_readtext_primary(engine, arr, lang)
    except Exception as e:
        abort(500, f"OCR failed: {e}")

    min_conf = _MIN_CONF_MAP.get(lang, 0.35)
    boxes = []
    confidences = []
    for (bbox, text), conf in zip(fragments, frag_confidences):
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        boxes.append((min(xs), min(ys), max(xs), max(ys), text))
        confidences.append(conf)

    # 4b. Zero-box retry — same rationale as _run_easyocr_detection's
    #     (preprocessing may have hurt rather than helped), but RapidOCR has
    #     no equivalent to EasyOCR's contrast_ths/text_threshold retry knobs,
    #     so this just re-runs on the raw, unpreprocessed image with a
    #     slightly relaxed min_conf floor — same shape of relaxation
    #     (max(min_conf - 0.05, 0.20)) as the EasyOCR path, for consistency.
    if len(boxes) == 0:
        print(f"  [OCR] RapidOCR: zero boxes from preprocessed image — "
              f"retrying on raw (lang={lang})")
        try:
            arr_raw = np.array(pil)
            with _rapidocr_infer_lock:
                fragments2, conf2 = _rapidocr_readtext_primary(engine, arr_raw, lang)
            floor = max(min_conf - 0.05, 0.20)
            for (bbox, text), conf in zip(fragments2, conf2):
                if conf < floor:
                    continue
                xs = [p[0] for p in bbox]
                ys = [p[1] for p in bbox]
                boxes.append((min(xs), min(ys), max(xs), max(ys), text))
                confidences.append(conf)
            if boxes:
                print(f"  [OCR] RapidOCR raw fallback recovered {len(boxes)} box(es)")
        except Exception as e:
            print(f"  [OCR] RapidOCR raw fallback failed: {e}")

    # 5-7. Raw box output, bubble merge, raw_box_ids, border percentages —
    # identical to _run_easyocr_detection from here on.
    raw_boxes_out = [
        {
            "id":  idx,
            "text": b[4],
            "box": [
                round(b[0] / w * 100, 1), round(b[1] / h * 100, 1),
                round(b[2] / w * 100, 1), round(b[3] / h * 100, 1),
            ],
            "px":  [int(b[0]), int(b[1]), int(b[2]), int(b[3])],
        }
        for idx, b in enumerate(boxes)
    ]

    regions, group_raw_ids = _merge_bubble_regions(
        boxes, w, h, h_borders, v_borders, margin_scale,
        confidences=confidences, min_conf=min_conf, clustered_floor=SHORT_WORD_MIN_CONF,
        bubble_label_map=bubble_label_map,
        gray=gray_orig,
    )
    for region, raw_ids in zip(regions, group_raw_ids):
        region["raw_box_ids"] = raw_ids

    h_borders_pct = [round(y / h * 100, 1) for y in h_borders]
    v_borders_pct = [round(x / w * 100, 1) for x in v_borders]

    return regions, raw_boxes_out, h_borders_pct, v_borders_pct


# Provisional per-language local-engine guidance — NOT a hard routing rule.
# Based on one real manga page per language (es/pt/vi/tr), tested manually
# in one session — see Devlog "RapidOCR: second local OCR engine" for the
# actual transcriptions this is based on. This is a starting point to
# surface as a *suggestion* the user can accept or dismiss (see
# _recommend_local_engine below and the frontend banner it powers), not a
# conclusion strong enough to hard-code as automatic routing the way
# VISION_LANGS is. Replace this dict's contents once the planned eval
# script (run across a real folder of sample pages per language, not one
# page each) produces real accept/drop/accuracy numbers — see Devlog.
_LOCAL_ENGINE_RECOMMENDATION = {
    # lang: (recommended_engine, one-line reason shown in the UI banner)
    'vi': ('easyocr',  "RapidOCR tends to drop or swap Vietnamese tone marks "
                        "on stacked diacritics; EasyOCR is more reliable here."),
    'pt': ('rapidocr', "RapidOCR was more accurate and complete on Portuguese "
                        "in our testing; EasyOCR's own confidence filter "
                        "dropped some correctly-read lines."),
    'ko': ('easyocr',  "RapidOCR's bundled model doesn't cover Korean at all "
                        "(unlike Vietnamese, this isn't an accuracy gap — it's "
                        "no coverage) and returns unusable output. This is a "
                        "harder rule than the others: Korean already routes to "
                        "Vision by default (see VISION_LANGS), but if Vision "
                        "ever falls back, the local fallback must be EasyOCR."),
    # id: RapidOCR read a real Indonesian page cleanly (correct on 'AKU',
    # 'KALAU', 'ITU', 'NUANSA'); EasyOCR on the same page introduced a
    # systematic U-misread-as-L/V across most of those same words, but
    # separately got 2-3 isolated harder words right that RapidOCR
    # scrambled ('HOBI', 'kece-plosan'). Leaning RapidOCR but not codified
    # as a recommendation yet — one page isn't enough to call this the way
    # Korean's near-total failure was an obvious call. Worth another page
    # or two before adding an entry here.
    #
    # es, tr, and everything else not listed: too close to call on the
    # sample tested so far — no recommendation is surfaced (see
    # _recommend_local_engine).
}

def _recommend_local_engine(lang: str, current: str):
    """
    Returns (recommended_engine, reason) if there's a real recommendation
    for `lang` AND it differs from what the user currently has selected,
    else None. None means "don't show the banner" — either because we have
    no data for this language yet, or because the user is already on the
    recommended engine.
    """
    rec = _LOCAL_ENGINE_RECOMMENDATION.get(lang)
    if rec is None:
        return None
    engine, reason = rec
    if engine == current:
        return None
    return engine, reason


def _normalize_for_match(s: str) -> str:
    """
    Reduce OCR'd text to a bare lowercase alphanumeric string with no
    diacritics, for fuzzy comparison between Gemini Vision's text and
    EasyOCR's (often noisier) recognition of the same bubble.

    e.g. "Bẩn thật!!" -> "banthat"   "CHO 90 PHÚT ĐI" -> "cho90phutdi"

    Stripping diacritics matters a lot for Vietnamese: EasyOCR frequently
    gets the base letters right but drops/garbles tone marks, while Gemini
    Vision usually gets them right — without normalising, two transcriptions
    of the same bubble can look unrelated even though they're the same text.
    """
    import unicodedata, re as _re2
    s = unicodedata.normalize('NFKD', s or "")
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return _re2.sub(r'[^a-z0-9]+', '', s.lower())


def _rescue_orphaned_vision_regions(vision_regions: list, matched_indices: set,
                                     pil_img: "Image.Image", lang: str,
                                     ai_key: str, ai_model: str,
                                     max_rescues: int = 4) -> dict:
    """
    Automatic micro-crop rescue for Vision items that _match_vision_to_easyocr
    couldn't pair with an EasyOCR box (fuzzy text ratio < 0.45, or no
    EasyOCR boxes at all). These are disproportionately the hardest items
    on the page: the text most likely to need Vision's help in the first
    place (stylised fonts, vertical text, scripts EasyOCR reads poorly) is
    also the text most likely to score a low fuzzy-match ratio against
    EasyOCR's own (noisy) read of the same bubble — so it's exactly the
    population left with Vision's own batch-level rescaled coordinates,
    which is the least-trustworthy coordinate source in the whole pipeline.

    This does NOT try to fix the position via spatial/IoU proximity —
    matching an orphaned box to a nearby EasyOCR box by distance alone
    risks pairing wrong on dense pages (see the discussion this followed:
    "upper right" isn't unique on a 6-panel grid). Instead it re-crops the
    ORIGINAL full-resolution image at Vision's own bounding box for that
    item and fires a second, focused Gemini call scoped to just that
    region — cheap (small crop, maxOutputTokens=512, same call shape as
    the correction UI's manual VISION draw) and sidesteps coordinate
    reconciliation entirely for this item: whatever text comes back
    replaces the original, but the BOX stays exactly what Vision already
    reported (rescue only ever improves text — see below for why it
    doesn't touch position).

    Deliberately conservative:
      - Capped at max_rescues per page (default 4) — a page with many
        orphaned items is more likely mis-detected at a structural level
        (wrong language selected, garbage image) than one where a burst
        of extra API calls will individually fix each item; this caps
        both latency and API spend for that degenerate case.
      - Only fires on items whose box has a plausible area (skips anything
        that collapsed to near-zero width/height — almost certainly a
        garbage box, not worth spending a call on).
      - Does NOT touch box/cx/cy — only vision_regions[i]["text"]. Position
        for orphaned items already comes from _ocr_gemini_vision's own
        normalization+fallback heuristics (see that function), which is a
        real, reasoned estimate; a second Gemini call reading a small crop
        has no better claim on THIS item's absolute page position than the
        first one did — it wasn't asked for coordinates at all, only text.
        Fixing text without touching a possibly-already-decent position is
        a strictly additive change; touching position here would just be
        substituting one guess for another with no verification either way.
      - Silently keeps the original text if a rescue call fails or returns
        empty — never surfaces a rescue failure as a page-level OCR error,
        since the item already has SOME text (Vision's original read) to
        fall back to; this is best-effort improvement, not a new failure
        mode for the page.

    Returns {"rescued": n, "attempted": n} for logging/telemetry — doesn't
    mutate raw_boxes_out since it never changes which raw fragments a
    region maps to, only the text already at vision_regions[i]["text"].
    """
    orphans = [
        vi for vi in range(len(vision_regions))
        if vi not in matched_indices
    ]
    if not orphans or not ai_key:
        return {"rescued": 0, "attempted": 0}

    iw, ih = pil_img.size
    rescued = 0
    attempted = 0
    for vi in orphans[:max_rescues]:
        vr = vision_regions[vi]
        box_pct = vr.get("box")
        if not box_pct or len(box_pct) != 4:
            continue
        x1 = box_pct[0] / 100.0 * iw
        y1 = box_pct[1] / 100.0 * ih
        x2 = box_pct[2] / 100.0 * iw
        y2 = box_pct[3] / 100.0 * ih
        if (x2 - x1) < 6 or (y2 - y1) < 6:
            continue  # collapsed/garbage box — not worth a call

        attempted += 1
        try:
            text, usage = _gemini_crop_ocr_core(pil_img, (x1, y1, x2, y2), lang, ai_key, ai_model)
        except _VisionCropError as e:
            print(f"  [OCR] Micro-crop rescue failed for orphan #{vi} "
                  f"(keeping original text): {e.message}")
            continue

        if text and text.strip():
            print(f"  [OCR] Micro-crop rescue: orphan #{vi} "
                  f"'{vr.get('text','')[:20]}' → '{text[:20]}'")
            vr["text"] = text.strip()
            rescued += 1
        # else: Gemini's second look also found nothing usable — keep the
        # original text rather than blanking a field that already had a
        # (possibly correct) value.

    return {"rescued": rescued, "attempted": attempted}


def _match_vision_to_easyocr(vision_regions: list, easy_regions: list,
                              raw_boxes_out: list, min_ratio: float = 0.45):
    """
    Pair each Gemini-Vision text item with the EasyOCR-detected box whose
    recognised text is the closest fuzzy match, and adopt EasyOCR's
    cx/cy/box for that item. Gemini's text/type/translation are left as-is —
    only the POSITION is replaced. `confidence` is adopted alongside
    cx/cy/box for matched items (same trust rationale); unmatched items get
    confidence=None since Gemini has no comparable per-token score of its own.

    Why: EasyOCR is a dedicated text-DETECTION model. Its boxes come from
    actually finding text on the page, so they don't suffer from the
    cx/cy hallucination that small Vision-LLMs (Flash-Lite) are prone to.
    Gemini is generally better at reading *what* the text says (especially
    stylised fonts, vertical text, SFX), so this keeps each engine doing
    the part it's good at.

    Matching is greedy 1:1 by best fuzzy-match ratio first (difflib on
    diacritic-stripped text — see _normalize_for_match). Vision items with
    no good EasyOCR match (ratio < min_ratio, or no EasyOCR boxes at all)
    keep whatever cx/cy/box _ocr_gemini_vision already computed for them
    (raw model coords, run through its own normalization/fallback heuristics).

    `raw_boxes_out` is the EasyOCR raw-fragment list — mutated in place:
    matched vision regions adopt the matched EasyOCR region's raw_box_ids;
    unmatched vision regions get a synthetic raw_box entry appended so the
    frontend's split-correction tool still has something to index into.

    Returns (matched_count, total_vision_count, matched_vision_indices).
    The third value is the set of vision_regions indices that got an
    EasyOCR position match — callers needing to know which items are
    "orphaned" (e.g. the micro-crop rescue pass in /ocr) use this directly
    instead of recomputing the same fuzzy match a second time.
    """
    import difflib

    total = len(vision_regions)
    if total == 0:
        return 0, 0

    if easy_regions:
        v_norm = [_normalize_for_match(r.get("text", "")) for r in vision_regions]
        e_norm = [_normalize_for_match(r.get("text", "")) for r in easy_regions]

        # Score every plausible (vision, easyocr) pair.
        pairs = []
        for vi, vt in enumerate(v_norm):
            if len(vt) < 3:
                continue
            for ei, et in enumerate(e_norm):
                if len(et) < 3:
                    continue
                ratio = difflib.SequenceMatcher(None, vt, et).ratio()
                if ratio >= min_ratio:
                    pairs.append((ratio, vi, ei))

        # Greedy 1:1 assignment, best matches first.
        pairs.sort(key=lambda p: -p[0])
        used_v, used_e = set(), set()
        for ratio, vi, ei in pairs:
            if vi in used_v or ei in used_e:
                continue
            used_v.add(vi)
            used_e.add(ei)
            vr, er = vision_regions[vi], easy_regions[ei]
            print(f"  [OCR] matched Vision '{vr.get('text','')[:24]}' "
                  f"↔ EasyOCR '{er.get('text','')[:24]}' (ratio={ratio:.2f})")
            vr["cx"]  = er["cx"]
            vr["cy"]  = er["cy"]
            vr["box"] = er["box"]
            # Gemini Vision has no per-token recognition confidence of its own
            # (it's a generative model, not a detection model) — but we're
            # already trusting EasyOCR's box for this item, so its confidence
            # is a reasonable proxy too, same rationale as the position adopt.
            vr["confidence"] = er.get("confidence")
            vr["raw_box_ids"] = er.get("raw_box_ids", [])
    else:
        used_v = set()

    # Unmatched Vision items: keep their existing (heuristic) coords, but
    # still need a raw_box entry for the split-correction tool.
    for vi, vr in enumerate(vision_regions):
        if vi in used_v:
            continue
        # No EasyOCR match to borrow a confidence from, and Gemini itself
        # doesn't produce one — explicit None (not just an absent key) so
        # the frontend's `!== undefined` check behaves the same either way
        # and this state is easy to tell apart from "field never wired up".
        vr["confidence"] = None
        new_id = len(raw_boxes_out)
        raw_boxes_out.append({
            "id": new_id, "text": vr.get("text", ""),
            "box": vr.get("box", [vr["cx"] - 8, vr["cy"] - 5, vr["cx"] + 8, vr["cy"] + 5]),
            "px": [0, 0, 0, 0],
        })
        vr["raw_box_ids"] = [new_id]

    # used_v (the set of matched vision indices) is returned alongside the
    # counts so callers — specifically the micro-crop rescue pass — can
    # identify orphaned items without re-running the fuzzy match.
    return len(used_v), total, used_v


# ─── Routes ───────────────────────────────────────────────────────────────────

# FIX #9 — health endpoint so the frontend can detect "proxy not running"
@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/fonts")
def list_fonts():
    """List TTF/OTF/TTC fonts found on this machine (see
    _discover_system_fonts), for the Erase Tool's font picker.
    Response: { "fonts": [{"name": str, "path": str}, ...] }. "path" is
    what the frontend sends back as font_path; it's re-validated
    server-side against this same list before ever reaching
    ImageFont.truetype (see export_page)."""
    return jsonify({"fonts": _discover_system_fonts()})


# Populated by build.py in the single-file dist build (see get_rates() below);
# empty in the normal split server.py + static/ layout, where rates.json on
# disk is always the real source and this fallback never triggers.
_RATES_DEFAULT = {}


@app.route("/rates")
def get_rates():
    """Serve rates.json (the editable $/1M-token table the cost tracker
    uses to turn usage into a dollar figure — see rates.json's own header
    comment for the full rationale). Read from disk on every request
    rather than cached at import time, same reasoning as index() below:
    editing rates.json takes effect on a normal page refresh, no server
    restart needed, which matters here specifically because this file is
    meant to be hand-edited when a provider changes prices.

    Split layout (server.py + static/): rates.json always exists on disk
    next to server.py — this is the only path that ever runs.

    Single-file dist build (dist/MangaTL-Reader.py): _RATES_DEFAULT is a
    non-empty dict baked in by build.py at build time (same technique as
    the _HTML constant below), so the dist build works out of the box with
    no separate rates.json to lose track of. But the disk file still wins
    if the person running the dist build drops a rates.json next to it —
    same "editable without touching code" promise either way, the dist
    build just also has a working fallback if they never do that.
    """
    import json as _json
    rates_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rates.json")
    try:
        with open(rates_path, "r", encoding="utf-8") as f:
            return jsonify(_json.load(f))
    except (OSError, ValueError) as e:
        if _RATES_DEFAULT:
            return jsonify(_RATES_DEFAULT)
        abort(404, f"rates.json unavailable ({e}); cost tracker will use estimates only.")


# Suppress browser's automatic favicon.ico request. There's no favicon.ico
# in static/ (only index.html/style.css/js), so this avoids a noisy 404 in
# DevTools on every page load without needing to ship a real icon file.
@app.route("/favicon.ico")
def favicon():
    return Response("", status=204)  # 204 No Content — browser stops asking


@app.route("/")
def index():
    # The frontend now lives on disk under static/ instead of an in-memory
    # Python string — send_from_directory reads it fresh each request, so
    # editing static/index.html (or its CSS/JS) takes effect on a normal
    # browser refresh, no server restart needed.
    return send_from_directory(app.static_folder, "index.html")


@app.route("/mangadex/<path:api_path>")
def mangadex_api(api_path):
    url    = f"{MANGADEX_API}/{api_path}"
    params = request.query_string.decode()
    if params:
        url = f"{url}?{params}"
    headers = {"User-Agent": USER_AGENT}
    # Forward auth token if the frontend provided one
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        headers["Authorization"] = auth
    try:
        r = requests.get(url, timeout=15, headers=headers)
        return Response(r.content, status=r.status_code,
                        content_type=r.headers.get("Content-Type", "application/json"))
    except requests.RequestException as e:
        abort(502, f"MangaDex API error: {e}")


# ─── MangaDex OAuth2 login / refresh ─────────────────────────────────────────
# MangaDex uses personal clients (not the public OAuth code flow).
# Users create one at: mangadex.org → Account Settings → API Clients
# Then log in with: client_id + client_secret + username + password.

@app.route("/auth/login", methods=["POST"])
def auth_login():
    """
    POST { username, password, client_id, client_secret }
    Returns { access_token, refresh_token, expires_in }
    """
    body          = request.get_json(force=True, silent=True) or {}
    username      = body.get("username",      "").strip()
    password      = body.get("password",      "").strip()
    client_id     = body.get("client_id",     "").strip()
    client_secret = body.get("client_secret", "").strip()

    if not all([username, password, client_id, client_secret]):
        abort(400, "username, password, client_id and client_secret are all required.")

    try:
        r = requests.post(
            MANGADEX_AUTH,
            data={
                "grant_type":    "password",
                "username":      username,
                "password":      password,
                "client_id":     client_id,
                "client_secret": client_secret,
            },
            headers={"User-Agent": USER_AGENT},
            timeout=15,
        )
    except requests.RequestException as e:
        abort(502, f"MangaDex auth error: {e}")

    if not r.ok:
        return Response(r.content, status=r.status_code,
                        content_type=r.headers.get("Content-Type", "application/json"))

    d = r.json()
    return jsonify({
        "access_token":  d["access_token"],
        "refresh_token": d.get("refresh_token", ""),
        "expires_in":    d.get("expires_in", 900),
    })


@app.route("/auth/refresh", methods=["POST"])
def auth_refresh():
    """
    POST { refresh_token, client_id, client_secret }
    Returns { access_token, refresh_token, expires_in }
    """
    body          = request.get_json(force=True, silent=True) or {}
    refresh_token = body.get("refresh_token", "").strip()
    client_id     = body.get("client_id",     "").strip()
    client_secret = body.get("client_secret", "").strip()

    if not all([refresh_token, client_id, client_secret]):
        abort(400, "refresh_token, client_id and client_secret are required.")

    try:
        r = requests.post(
            MANGADEX_AUTH,
            data={
                "grant_type":    "refresh_token",
                "refresh_token": refresh_token,
                "client_id":     client_id,
                "client_secret": client_secret,
            },
            headers={"User-Agent": USER_AGENT},
            timeout=15,
        )
    except requests.RequestException as e:
        abort(502, f"MangaDex token refresh error: {e}")

    if not r.ok:
        return Response(r.content, status=r.status_code,
                        content_type=r.headers.get("Content-Type", "application/json"))

    d = r.json()
    return jsonify({
        "access_token":  d["access_token"],
        "refresh_token": d.get("refresh_token", ""),
        "expires_in":    d.get("expires_in", 900),
    })


# FIX #12 — /proxy is now actively used by the frontend for all image display
@app.route("/proxy")
def proxy():
    url = request.args.get("url", "").strip()
    _validate_image_url(url)
    try:
        r = requests.get(url, timeout=20, headers={"User-Agent": USER_AGENT})
        r.raise_for_status()
        return Response(r.content, content_type=r.headers.get("Content-Type", "image/jpeg"))
    except requests.RequestException as e:
        abort(502, f"CDN fetch failed: {e}")


# ─── Translation helpers (one per provider) ──────────────────────────────────

def _inject_lang_hint(payload: dict, source_lang: str) -> None:
    """Append a language-specific hint to the system message in-place."""
    lang_hint = _LANG_HINTS.get(source_lang, "")
    if not lang_hint:
        return
    for msg in payload.get("messages", []):
        if isinstance(msg, dict) and msg.get("role") == "system":
            msg["content"] = msg["content"] + f"\n\nLANGUAGE NOTE: {lang_hint}"
            break


def _rescue_json_from_reasoning(rc: str, rescue_key: str = "translations") -> str:
    """Recover a JSON object containing `rescue_key` from a DeepSeek thinking
    model's `reasoning_content`.

    A thinking model sometimes writes its final answer inside the reasoning
    chain when it runs out of output budget, leaving `content` empty. This
    digs that answer back out. Returns the rescued JSON substring, or "" if
    nothing was rescuable.

    Lives here as a module-level function rather than inline in
    _translate_deepseek() so it can be imported and tested directly —
    test_deepseek_rescue.py used to regex this logic out of server.py's
    source text and exec() it, because reaching it any other way meant
    calling _translate_deepseek() and hitting the network.
    """
    import json as _json
    import re as _re

    content = ""

    # Strategy A (primary): find the JSON object that actually
    # ENCLOSES the "translations" key, then parse it with json.loads.
    #
    # FIX (was: KNOWN_ISSUES_DRAFT.md "DeepSeek rescue Strategy A:
    # doesn't handle a nested object before the key") — a single
    # rc.rfind('{', 0, idx) finds the NEAREST '{' before the key,
    # which is wrong whenever a nested object sits between the true
    # enclosing brace and the key itself (e.g.
    # {"model":{"name":"x"},"translations":[...]}  — the naive
    # rfind grabs {"name":"x"}'s brace, not the outer one, and
    # json.loads then chokes on the dangling trailing content).
    # Reproduced directly against this exact shape before this fix
    # landed; see KNOWN_ISSUES_DRAFT.md for the full trace.
    #
    # Correct approach: walk backward from the key counting brace
    # depth (each '}' seen while scanning right-to-left means we've
    # entered one more nested level we need to close before we're
    # back at our own enclosing level; each '{' either closes one
    # of those nested levels or — once depth is back to 0 — IS the
    # enclosing brace we want). This finds the true enclosing brace
    # regardless of how much nesting sits between it and the key.
    #
    # Verified against 10 cases before shipping (see
    # test_deepseek_rescue.py): the original failing case, the
    # plain/common no-nesting case (must still work — this is the
    # hot path), doubly- and deeply-nested objects, nesting both
    # before AND after the key, a duplicated key, unbalanced
    # decoy braces earlier in the string, and three "must
    # correctly return nothing" negative cases (no key present,
    # key present but no valid JSON around it, empty input).
    idx = rc.rfind(f'"{rescue_key}"')
    if idx >= 0:
        brace = -1
        _depth = 0
        _i = idx - 1
        while _i >= 0:
            _c = rc[_i]
            if _c == '}':
                _depth += 1
            elif _c == '{':
                if _depth == 0:
                    brace = _i
                    break
                _depth -= 1
            _i -= 1
        if brace >= 0:
            try:
                m_obj = _json.loads(rc[brace:])
                if isinstance(m_obj, dict) and rescue_key in m_obj:
                    content = rc[brace:]
            except Exception:
                pass
    # Strategy B (fallback): regex — catches malformed JSON that
    # json.loads rejects but still contains a parseable rescue_key array.
    # Only runs when Strategy A found nothing.
    if not content.strip():
        m = _re.search(
            r'\{[^{}]*?"' + _re.escape(rescue_key) + r'"\s*:\s*\[[\s\S]*?\]\s*\}',
            rc
        )
        if m:
            content = m.group(0)

    return content


def _translate_deepseek(api_key: str, payload: dict, rescue_key: str = "translations"):
    """
    Forward an OpenAI-style payload to DeepSeek and return a normalised response.

    DeepSeek V4 models support dual Thinking / Non-Thinking modes.  In thinking
    mode the final answer lands in `choices[0].message.content` as usual, but the
    chain-of-thought appears in `reasoning_content`.  Occasionally (especially
    under heavy load or with certain prompt shapes) `content` comes back as null
    or an empty string while `reasoning_content` contains the actual JSON output.
    Without the normalisation below that silently becomes all-"—" translations.

    `rescue_key` is the top-level JSON key the rescue logic hunts for inside
    `reasoning_content` (default "translations", the full-translate response
    shape) — without this, a thinking-mode run that left valid output sitting
    in reasoning_content instead of content would be missed entirely and fail
    even though the model actually succeeded.
    """
    import json as _json
    try:
        r = requests.post(
            DEEPSEEK_API,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
                "User-Agent":    USER_AGENT,
            },
            timeout=60,
        )
    except requests.RequestException as e:
        abort(502, f"DeepSeek API error: {e}")

    if not r.ok:
        return Response(r.content, status=r.status_code,
                        content_type=r.headers.get("Content-Type", "application/json"))

    # ── Normalise to guaranteed-non-empty content ─────────────────────────────
    try:
        data    = r.json()
        choices = data.get("choices") or []
        msg     = choices[0].get("message", {}) if choices else {}
        content = msg.get("content") or ""
        # Thinking-mode rescue: reasoning_content holds the chain-of-thought, NOT the
        # final answer.  Blindly using it as content causes the frontend to receive
        # thousands of characters of reasoning text that can't be parsed as JSON.
        # Correct behaviour: if content is empty, try to rescue a translations JSON block
        # that the model may have embedded at the very end of its reasoning chain.
        # If no valid JSON is found there either, abort with a helpful error.
        if not content.strip():
            rc = (msg.get("reasoning_content") or "").strip()
            if rc:
                content = _rescue_json_from_reasoning(rc, rescue_key)
            if not content.strip():
                finish = choices[0].get("finish_reason", "") if choices else ""
                abort(422,
                      f"DeepSeek thinking model returned no final JSON output "
                      f"(finish_reason={finish!r}). The model likely exhausted its token "
                      "budget on reasoning before producing an answer. "
                      "Try: (1) raising max_tokens (current: 4000 → try 8000), "
                      "(2) switching to DeepSeek V4 Flash (non-thinking, faster), or "
                      "(3) using Gemini 2.5 Flash which has built-in thinking suppression.")
        if not content.strip():
            finish = choices[0].get("finish_reason", "") if choices else ""
            abort(422,
                  f"DeepSeek returned no content (finish_reason={finish!r}). "
                  "Retry the page.")
        # Preserve usage for the cost tracker (see cost-tracker.js). This was
        # previously dropped here — the function rebuilds a minimal
        # {"choices":[...]} response and usage silently fell off the edge,
        # even though DeepSeek's real response always includes it (prompt_tokens,
        # prompt_cache_hit_tokens, prompt_cache_miss_tokens, completion_tokens,
        # total_tokens — see api-docs.deepseek.com/api/create-chat-completion).
        # `data` here is still the full parsed response from earlier in this
        # function, so `usage` is exactly what DeepSeek sent, untouched.
        resp_body = {"choices": [{"message": {"content": content}}]}
        if isinstance(data.get("usage"), dict):
            resp_body["usage"] = data["usage"]
        return Response(
            _json.dumps(resp_body),
            status=200,
            content_type="application/json",
        )
    except HTTPException:
        # Our own abort(422, ...) calls above are deliberate control flow — let
        # them propagate unchanged so Flask turns them into the intended
        # client-facing error response.
        raise
    except Exception as _exc:
        # Genuinely unexpected shape (e.g. r.json() failed to decode, or
        # choices[0] wasn't a dict). By this point r.ok was already True, so
        # silently returning r.content here would ship the client an HTTP 200
        # whose body doesn't match the {"choices":[...]} contract it expects —
        # a bug in *our* normalisation code disguised as a successful response.
        # Log it and fail loudly with a real error status instead.
        print(f"  [TL] DeepSeek response normalisation failed unexpectedly: {_exc!r}")
        abort(502, f"DeepSeek response parsing failed unexpectedly: {_exc}")


def _translate_gemini(api_key: str, payload: dict):
    """
    Convert an OpenAI-style payload to Gemini's generateContent format,
    call the Gemini API, then normalize the response back to OpenAI format
    so the frontend needs no changes.
    """
    import json as _json

    model       = payload.get("model", "gemini-2.5-flash")
    messages    = payload.get("messages", [])
    temperature = payload.get("temperature", 0.3)
    max_tokens  = payload.get("max_tokens", 3000)

    # Split system instruction from conversation turns
    system_text = ""
    user_text   = ""
    for msg in messages:
        role = msg.get("role", "")
        text = msg.get("content", "")
        if role == "system":
            system_text = text
        elif role == "user":
            user_text = text

    gemini_payload: dict = {
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature":     temperature,
            "maxOutputTokens": max_tokens,
            # Disable thinking mode (Gemini 2.5+).
            # Without this, thinking-capable models return a multi-part response:
            #   parts[0] = {"thought": true, "text": "...8000-char analysis..."}
            #   parts[1] = {"text": "{\"translations\":[...]}"}   ← what we actually need
            # The old parts[0]-only extraction grabbed the analysis instead of the JSON,
            # causing all-"—" translations on every page with enough text to trigger thinking.
            # Setting thinkingBudget=0 requests a direct JSON response on all pages.
            # Models that don't support thinkingConfig silently ignore this field.
            "thinkingConfig": {"thinkingBudget": 0},
            # API-level JSON enforcement (Gemini 1.5+).
            # Even when thinkingBudget=0 is ignored by a model, responseMimeType forces
            # the output to be valid JSON — the model cannot return prose or markdown.
            # This is the definitive fix for "All 3 JSON parse strategies failed" errors
            # caused by the model dumping its reasoning chain as plain text.
            "responseMimeType": "application/json",
        },
    }
    if system_text:
        gemini_payload["system_instruction"] = {
            "parts": [{"text": system_text}]
        }

    url = GEMINI_API.format(model=model) + f"?key={api_key}"

    try:
        r = requests.post(
            url,
            json=gemini_payload,
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
            timeout=60,
        )
    except requests.RequestException as e:
        abort(502, f"Gemini API error: {e}")

    if not r.ok:
        # Surface the Gemini error directly so the frontend can show it
        return Response(r.content, status=r.status_code,
                        content_type=r.headers.get("Content-Type", "application/json"))

    # Normalize to OpenAI-compatible format (choices[0].message.content)
    try:
        gemini_resp = r.json()
        candidates  = gemini_resp.get("candidates") or []
        cand        = candidates[0] if candidates else {}
        # ── Extract text, skipping thought parts ─────────────────────────────
        # Safety net for when thinking is still active despite thinkingBudget=0
        # (e.g. a model that ignores the hint, or thinkingBudget not yet supported).
        # Gemini thinking responses look like:
        #   parts = [{"thought": True, "text": "..."}, {"text": "...JSON..."}]
        # We skip any part flagged as thought and take the first real output part.
        parts = cand.get("content", {}).get("parts", [])
        text  = ""
        for part in parts:
            if not part.get("thought", False):
                candidate = part.get("text", "")
                if candidate.strip():
                    text = candidate
                    break
        # Absolute fallback — should never be reached with thinkingBudget=0
        if not text and parts:
            text = parts[0].get("text", "")
    except Exception:
        abort(502, "Gemini response parse error.")

    # ── Guard: empty text means Gemini produced no output ────────────────────
    # This happens when the safety filter blocks the request (finishReason=SAFETY),
    # the response was truncated (MAX_TOKENS with no partial text), or the model
    # returned a pure-thinking response with no output parts.
    # Without this check the proxy returns HTTP 200 with content="", which the
    # frontend silently treats as a failed parse and falls back to all-"—"
    # translations — indistinguishable from a successful empty-chapter result.
    if not text.strip():
        finish      = cand.get("finishReason", "")
        prompt_fb   = gemini_resp.get("promptFeedback", {})
        block       = prompt_fb.get("blockReason", "")
        if block:
            abort(422, f"Gemini blocked the request ({block}). Try a different model or retry.")
        elif finish and finish != "STOP":
            abort(422, f"Gemini returned no text (finishReason={finish!r}). Retry the page.")
        else:
            abort(422, "Gemini returned an empty response. Check your API key / model and retry.")

    normalized = {"choices": [{"message": {"content": text}}]}
    # Preserve usage for the cost tracker (see cost-tracker.js), normalized to
    # the same {prompt_tokens, completion_tokens, total_tokens} field names
    # DeepSeek's OpenAI-compatible usage object already uses (see
    # _translate_deepseek above) — the field names differ 1:1
    # (promptTokenCount → prompt_tokens, etc.) purely because Gemini's native
    # API uses camelCase where OpenAI-style APIs use snake_case; the actual
    # counts mean the same thing. total_tokens is passed through separately
    # rather than trusting completion_tokens alone to already include any
    # thinking-token cost — belt-and-braces given thinkingBudget=0 is a
    # request, not a guarantee (see the thinking-mode handling above).
    usage_meta = gemini_resp.get("usageMetadata")
    if isinstance(usage_meta, dict):
        normalized["usage"] = {
            "prompt_tokens":     usage_meta.get("promptTokenCount", 0),
            "completion_tokens": usage_meta.get("candidatesTokenCount", 0),
            "total_tokens":      usage_meta.get("totalTokenCount", 0),
        }
    return Response(
        _json.dumps(normalized),
        status=200,
        content_type="application/json",
    )


# ─── /translate  (multi-provider) ────────────────────────────────────────────
@app.route("/translate", methods=["POST"])
def translate():
    """
    POST body:
        {
          "provider":         "gemini" | "deepseek",   # default: deepseek
          "key":              "<api key>",
          "payload":          { ...OpenAI-style chat-completions body... },
          "source_lang":      "vi",                      # optional, for lang hints
          "rescue_key":       "translations",             # optional, DeepSeek only —
                                                            # see _translate_deepseek's
                                                            # docstring / this route's
                                                            # rescue_key comment below
        }

    All providers return an OpenAI-compatible JSON body so the frontend
    only needs to read choices[0].message.content regardless of provider.
    The API key is forwarded server-side and never appears in DevTools.
    """
    body             = request.get_json(force=True, silent=True) or {}
    provider         = body.get("provider", "deepseek").strip().lower()
    api_key          = body.get("key", "").strip()
    payload          = body.get("payload")
    source_lang      = body.get("source_lang", "").strip().lower()
    # Top-level JSON key _translate_deepseek's thinking-mode rescue hunts for
    # inside reasoning_content when `content` comes back empty (see that
    # function's docstring). Defaults to "translations" — the shape
    # translateBatch()/translatePendingRegions()/retranslatePage() all use.
    # Callers whose prompt asks for a DIFFERENT top-level key (the
    # correction UI's single-region retranslate asks for {"tl":...,"t":...},
    # Check Flow asks for {"issues":[...]}) must say so here, or the rescue
    # silently can never find their shape and every thinking-mode empty-
    # content response becomes an unrecoverable 422 instead of a rescued
    # 200 — confirmed as the cause of the correction UI's single-region
    # ↺ retranslate button 422ing whenever DeepSeek's response landed in
    # reasoning_content instead of content.
    rescue_key       = (body.get("rescue_key") or "translations").strip() or "translations"

    if not api_key:
        abort(400, "API key required.")
    if not isinstance(payload, dict):
        abort(400, "payload must be a JSON object.")
    if not isinstance(payload.get("messages"), list) or len(payload["messages"]) < 2:
        abort(400, "payload.messages must include a system and a user turn.")

    # Inject cultural/linguistic hints into the system message
    _inject_lang_hint(payload, source_lang)

    if provider == "gemini":
        return _translate_gemini(api_key, payload)
    else:
        # Default / "deepseek"
        return _translate_deepseek(api_key, payload, rescue_key=rescue_key)


# ─── DeepL  (NOT an LLM provider — kept fully separate from /translate) ──────
#
# DeepL's API takes plain strings in and returns plain translated strings
# out. There's no chat-completions shape, no "classify this as speech vs
# SFX", no JSON-recovery step to parse a model's free-form output — DeepL
# can't return malformed JSON because there's no JSON at all, just a
# translations array of {text, detected_source_language}.
#
# This is why DeepL gets its own routes rather than a third branch inside
# _translate_gemini/_translate_deepseek's shared /translate contract: forcing
# it through that contract would mean either inventing a fake "chat
# completion" wrapper around a plain-string API for no reason, or teaching
# translateBatch()'s JSON-recovery/index-remapping logic about a response
# shape that will never actually need recovering. Two clean, honest routes
# beat one route pretending DeepL is an LLM.
#
# Region "type" classification (speech/thought/sfx/sign) is an LLM-only
# capability — DeepL has no equivalent. translateBatchDeepL() on the
# frontend defaults every region to 'speech' rather than guessing; see that
# function's comment for why.

def _deepl_base_url(api_key: str) -> str:
    """
    DeepL API Free keys are suffixed ':fx' and MUST be called via
    api-free.deepl.com — calling api.deepl.com (the Pro/paid host) with a
    Free key fails outright. This one check is what lets a single /translate-
    deepl route serve both Free and Pro users without asking them which
    plan they're on; the key itself already says.

    CAVEAT (2026-08-02): DeepL retired the API Free/API Pro plans this logic
    was written against — confirmed directly from DeepL's own support docs
    (support.deepl.com/hc/en-us/articles/360021200939-DeepL-API-plans: "The
    DeepL API Free plan can no longer be purchased" / "...API Pro plan can
    no longer be purchased"). New signups now get Developer or Growth
    instead. It has NOT been independently verified whether Developer-tier
    keys still use the ':fx' suffix and still route to api-free.deepl.com,
    or whether that convention changed along with the plan rename. If a
    Developer/Growth key gets routed to the wrong host by this function,
    DeepL's own API error should surface clearly (wrong-host calls fail
    outright rather than silently succeeding) — but this hasn't been
    exercised against a real key from either new plan.
    """
    return "https://api-free.deepl.com" if api_key.strip().endswith(":fx") else "https://api.deepl.com"


@app.route("/translate-deepl", methods=["POST"])
def translate_deepl():
    """
    POST body:
        {
          "key":         "<DeepL API key>",   # ends in ':fx' for Free-tier keys
          "texts":       ["line one", "line two", ...],
          "target_lang": "ES",                  # DeepL ISO code, e.g. from /deepl-languages
          "source_lang": "ja",                  # optional — DeepL auto-detects if omitted
        }
    Response:  { "translations": ["línea uno", "línea dos", ...] }
               (plain strings, parallel to the input "texts" array — no
               classification, no per-item metadata; see module comment above)

    Calls DeepL's real /v2/translate endpoint directly — no LLM prompt
    engineering, no JSON-recovery, because DeepL doesn't need any of that.
    """
    body        = request.get_json(force=True, silent=True) or {}
    api_key     = body.get("key", "").strip()
    texts       = body.get("texts", [])
    target_lang = body.get("target_lang", "").strip()
    source_lang = body.get("source_lang", "").strip()

    if not api_key:
        abort(400, "DeepL API key required.")
    if not isinstance(texts, list) or not texts:
        abort(400, "texts must be a non-empty array of strings.")
    if not target_lang:
        abort(400, "target_lang required (DeepL ISO code, e.g. 'ES', 'PT-BR').")

    deepl_payload = {
        "text":        [str(t) for t in texts],
        "target_lang": target_lang,
    }
    # DeepL auto-detects source language when omitted — genuinely useful here
    # since manga source language is already known from the chapter metadata,
    # but auto-detect is a safe fallback if that's ever missing/wrong.
    #
    # IMPORTANT: DeepL's source_lang has NO regional-variant concept at all —
    # per DeepL's own docs, e.g. "Portuguese (no distinction is made between
    # the varieties) detected as source language" — only TARGET languages
    # have variants like PT-BR/PT-PT, ZH-HANS/ZH-HANT. Source is always the
    # bare 2-letter code. MangaDex's chapter.translatedLanguage field,
    # however, routinely includes a regional suffix (its own docs: codes
    # follow "$language-$region" when the alpha-2 code alone isn't specific
    # enough, e.g. "zh-hk", "pt-br") — a Brazilian Portuguese scanlation is
    # tagged "pt-br" on MangaDex, not "pt". Sending that straight through as
    # source_lang="PT-BR" gets rejected by DeepL outright, since PT-BR isn't
    # a valid source code — only a valid TARGET code. Stripping to the
    # leading 2-letter code before uppercasing fixes this without needing
    # the frontend to know anything about DeepL's source/target asymmetry.
    if source_lang:
        deepl_payload["source_lang"] = source_lang.split("-")[0].upper()

    url = _deepl_base_url(api_key) + "/v2/translate"
    try:
        r = requests.post(
            url,
            json=deepl_payload,
            headers={
                "Authorization": f"DeepL-Auth-Key {api_key}",
                "Content-Type":  "application/json",
                "User-Agent":    USER_AGENT,
            },
            timeout=30,
        )
    except requests.RequestException as e:
        abort(502, f"DeepL API error: {e}")

    if not r.ok:
        # 456 = DeepL's "quota exceeded" code (not a standard HTTP status name,
        # but it's what DeepL actually returns) — worth a clearer message than
        # a raw pass-through, since it's the single most likely error a
        # free-tier user will hit.
        if r.status_code == 456:
            abort(429, "DeepL says you've used up this key's translation allowance. "
                       "DeepL retired the old Free/Pro plans in mid-2026 — current plans "
                       "(Developer/Growth) have different allowance shapes, and some "
                       "don't reset monthly the way the old Free plan did, so this app "
                       "can't tell you exactly when or whether it resets. Check your "
                       "usage and plan details at your DeepL account dashboard, or "
                       "upgrade at deepl.com/pro#developer.")
        # Surface DeepL's own error body otherwise — same pass-through pattern
        # _translate_gemini uses for its upstream errors.
        return Response(r.content, status=r.status_code,
                        content_type=r.headers.get("Content-Type", "application/json"))

    try:
        deepl_resp   = r.json()
        translations = [t.get("text", "") for t in deepl_resp.get("translations", [])]
    except Exception:
        abort(502, "DeepL response parse error.")

    # DeepL is billed per character regardless of success shape below this
    # point, so — same reasoning as Gemini/DeepSeek's usage capture — record
    # what we can even though DeepL's own response has no token/char count
    # field to report back. The cost tracker's DeepL entry in rates.json
    # works off characters sent, not a usage object from the response, so
    # there's nothing to normalize here; the frontend computes it from the
    # request it already built.
    return jsonify({"translations": translations})


@app.route("/deepl-languages", methods=["POST"])
def deepl_languages():
    """
    POST body:  { "key": "<DeepL API key>" }
    Response:   { "languages": [{"code": "ES", "name": "Spanish"}, ...] }

    Proxies DeepL's own /v2/languages?type=target endpoint rather than
    hardcoding a language list in this app. DeepL adds languages over time
    (Thai and Vietnamese are both recent-ish additions) — asking DeepL
    directly is the only way this doesn't quietly go stale. Requires a key
    (same as the Gemini-model-list pattern elsewhere) since /v2/languages is
    an authenticated endpoint.
    """
    body    = request.get_json(force=True, silent=True) or {}
    api_key = body.get("key", "").strip()
    if not api_key:
        abort(400, "DeepL API key required.")

    url = _deepl_base_url(api_key) + "/v2/languages?type=target"
    try:
        r = requests.get(
            url,
            headers={"Authorization": f"DeepL-Auth-Key {api_key}", "User-Agent": USER_AGENT},
            timeout=15,
        )
    except requests.RequestException as e:
        abort(502, f"DeepL API error: {e}")

    if not r.ok:
        return Response(r.content, status=r.status_code,
                        content_type=r.headers.get("Content-Type", "application/json"))

    try:
        langs = r.json()
        out = [{"code": l.get("language", ""), "name": l.get("name", "")} for l in langs]
    except Exception:
        abort(502, "DeepL response parse error.")
    return jsonify({"languages": out})


@app.route("/ocr/recommendation", methods=["GET"])
def ocr_recommendation():
    """
    GET ?lang=vi&local_engine=rapidocr

    Cheap, synchronous lookup — just _recommend_local_engine(), no image
    decoding, no local-engine load, no Vision call, no cost. Exists so the
    frontend can show the engine-recommendation banner BEFORE queuing any
    page's real /ocr work, instead of only finding out after the first
    page's response — which, with runConcurrent's pool of 3, meant up to
    3 pages (and more, as the pool kept pulling from the queue regardless
    of a later banner click) had already run on the wrong engine before the
    user could react. See _runChapterPipeline in pipeline.js for the caller,
    which awaits this before its first runConcurrent(tasks, 3).

    Response: { "local_engine_recommendation": {"engine": ..., "reason": ...} | null }
    """
    lang         = request.args.get("lang", "en").lower()
    local_engine = request.args.get("local_engine", "easyocr").strip().lower()
    if local_engine not in ("easyocr", "rapidocr"):
        local_engine = "easyocr"   # unrecognised value — fail safe to the default, not a 500
    return jsonify({"local_engine_recommendation": _recommend_local_engine(lang, local_engine)})


@app.route("/ocr", methods=["POST"])
def ocr_page():
    """
    POST body:  { "url": "https://cdn…/page.jpg", "lang": "vi",
                  "ai_key": "AIza…",          # optional — enables Gemini Vision OCR
                  "ai_model": "gemini-2.5-flash",
                  "vision_mode": "smart",     # 'smart' | 'all' | 'off'  (default: 'smart')
                  "local_engine": "easyocr" } # 'easyocr' | 'rapidocr'  (default: 'easyocr')
    Response:   { "regions": [{ "text": "…", "cx": 45.2, "cy": 23.1 }, …] }

    local_engine picks which LOCAL engine runs — either as the only OCR
    (vision_mode='off' or no ai_key), or for position-matching /
    Vision-fallback alongside Gemini Vision. See _run_rapidocr_detection's
    docstring for the accuracy/speed/robustness tradeoffs found in testing;
    default stays 'easyocr' so existing installs don't silently change
    behavior. The response includes "local_engine_recommendation" when the
    chapter's language has a real (tested, not guessed) recommendation that
    differs from what was requested — see _recommend_local_engine.

    "url" may be replaced with "image_b64" (raw base64 or a data: URL) for a
    local-folder / CBZ page — see _load_image_bytes(). Everything else about
    the route (OCR routing, Vision fallback, response shape) is identical
    either way; only where the bytes come from differs.

    vision_mode controls when Gemini Vision OCR fires (only when ai_key is present):
      'smart' — only for languages in VISION_LANGS (complex/vertical scripts).
                Best for free-tier users: saves quota for scripts EasyOCR handles well.
      'all'   — Vision OCR for every language. Max quality but doubles API calls.
      'off'   — Always the local_engine choice below, regardless. Zero extra quota used.
    local_engine (EasyOCR vs RapidOCR) is a fully separate choice from which
    service TRANSLATES — this route never even sees a "provider" field.
    DeepSeek/DeepL users can still send an ai_key here via the frontend's
    separate "Gemini key for Vision OCR" field (Vision OCR always calls
    Gemini regardless of who translates — see ocr-client.js's ocrPage()),
    and whether or not they do, local_engine is honored exactly the same as
    it is for a Gemini-translator user: EasyOCR or RapidOCR, whichever the
    Local OCR Engine dropdown/per-language override says. (Was previously
    documented here as "DeepSeek users never send an ai_key so they always
    use EasyOCR" — that predates the separate vision-ocr-key field and was
    wrong on both counts even before then, since it ignored local_engine
    entirely.)
    If Gemini Vision errors or returns empty, falls back to local_engine automatically.

    Micro-crop rescue: when Vision succeeds, any of its items that
    _match_vision_to_easyocr couldn't pair with an EasyOCR box (capped at
    4/page) get a second, focused Gemini call on just that crop — see
    _rescue_orphaned_vision_regions docstring for why this targets
    precisely the population most likely to need it (text EasyOCR read too
    differently to confirm a match). Only replaces text, never position.
    Response includes "rescue": {"rescued": n, "attempted": n} when this
    fired at all.
    """
    body         = request.get_json(force=True, silent=True) or {}
    lang         = body.get("lang", "en").lower()
    margin_scale = max(0.1, min(2.0, float(body.get("margin_scale", 0.5))))
    ai_key       = body.get("ai_key",       "").strip()
    ai_model     = body.get("ai_model",     "gemini-2.5-flash").strip()
    vision_mode  = body.get("vision_mode",  "smart").strip().lower()  # 'smart' | 'all' | 'off'
    local_engine = body.get("local_engine", "easyocr").strip().lower()  # 'easyocr' | 'rapidocr'
    if local_engine not in ("easyocr", "rapidocr"):
        local_engine = "easyocr"   # unrecognised value — fail safe to the default, not a 500
    _run_local_detection = (
        _run_rapidocr_detection if local_engine == "rapidocr" else _run_easyocr_detection
    )
    # Surfaced to the frontend regardless of which branch below actually
    # runs, so the recommendation banner can appear even on a page that
    # ends up using Vision (the user may still want to know for next time
    # Vision isn't used, e.g. quota runs out mid-chapter).
    engine_recommendation = _recommend_local_engine(lang, local_engine)

    # 1. Load bytes — MangaDex CDN url, or a local-folder/CBZ image_b64
    image_bytes = _load_image_bytes(body)

    # ── Gemini Vision routing ─────────────────────────────────────────────────
    # Decide whether to use Vision OCR based on vision_mode:
    #   'all'   → always use Vision (when key present)
    #   'smart' → only for VISION_LANGS (complex/vertical scripts)
    #   'off'   → skip Vision, go straight to EasyOCR
    # Free-tier users should stick with 'smart' — each Vision call costs quota
    # on top of the translation call, so 'all' roughly halves their daily limit.
    use_vision = bool(ai_key) and vision_mode != "off" and (
        vision_mode == "all" or lang in VISION_LANGS
    )
    fallback_reason = None   # set if Vision was attempted but fell back
    vision_usage    = None   # Gemini Vision usage, when Vision was attempted at all
                              # (set even on a fallback — a "parse"/"empty" outcome
                              # still consumed billed tokens, see _ocr_gemini_vision's
                              # docstring)

    if use_vision:
        print(f"  [OCR] Using Gemini Vision for lang={lang} (mode={vision_mode})")
        regions, fallback_reason, vision_usage = _ocr_gemini_vision(image_bytes, lang, ai_key, ai_model)
        if regions:
            # Vision found text — but Flash-Lite's cx/cy/box can still be
            # unreliable even after _ocr_gemini_vision's own normalisation
            # and extreme-cluster fallback. EasyOCR is a real text-DETECTION
            # model, so its boxes don't suffer from that kind of LLM spatial
            # hallucination. Run it here too — purely for POSITIONS — and
            # adopt its box for any Vision item whose text fuzzy-matches an
            # EasyOCR detection. Vision's text/type stay as-is either way;
            # only cx/cy/box may change. Items with no good EasyOCR match
            # keep whatever _ocr_gemini_vision already worked out for them.
            easy_regions, raw_boxes_out, h_borders_pct, v_borders_pct = _run_local_detection(image_bytes, lang, margin_scale)
            matched, total, matched_indices = _match_vision_to_easyocr(regions, easy_regions, raw_boxes_out)
            # local_engine here, not a hardcoded "EasyOCR" — easy_regions holds
            # whichever engine _run_local_detection actually ran (RapidOCR when
            # local_engine == 'rapidocr'); the variable name is legacy from
            # before RapidOCR existed (see ROADMAP.md's "Open questions" on
            # this same naming gap) but the log text shouldn't lie about it.
            engine_label = "RapidOCR" if local_engine == "rapidocr" else "EasyOCR"
            print(f"  [OCR] Vision+{engine_label} position match: {matched}/{total} item(s) "
                  f"used {engine_label} boxes; {total - matched} kept Vision's own coords")

            # Micro-crop rescue: items EasyOCR's text couldn't confirm are
            # disproportionately the hardest text on the page (see
            # _rescue_orphaned_vision_regions docstring) — give each one a
            # second, focused Gemini look before accepting Vision's
            # first-pass read as final. Position is untouched; only text
            # may improve. Best-effort — a rescue-pass failure never fails
            # the page (see docstring's "silently keeps original" note).
            rescue_stats = {"rescued": 0, "attempted": 0}
            if total - matched > 0:
                try:
                    pil_for_rescue = Image.open(io.BytesIO(image_bytes)).convert("RGB")
                    rescue_stats = _rescue_orphaned_vision_regions(
                        regions, matched_indices, pil_for_rescue, lang, ai_key, ai_model
                    )
                    if rescue_stats["rescued"]:
                        print(f"  [OCR] Micro-crop rescue: {rescue_stats['rescued']}/"
                              f"{rescue_stats['attempted']} orphan(s) got improved text")
                except Exception as e:
                    # Never let a rescue-pass bug take down the whole /ocr
                    # response — the page already has a usable result
                    # without it (see docstring: best-effort, not a new
                    # failure mode).
                    print(f"  [OCR] Micro-crop rescue pass errored (ignored): {e}")

            engine = f"vision+{local_engine}" if matched else "vision"
            return jsonify({"regions": regions, "raw_boxes": raw_boxes_out,
                            "ocr_engine": engine,
                            "h_borders": h_borders_pct, "v_borders": v_borders_pct,
                            **({"rescue": rescue_stats} if rescue_stats["attempted"] else {}),
                            **({"usage": vision_usage, "usage_model": ai_model} if vision_usage else {}),
                            **({"local_engine_recommendation":
                                {"engine": engine_recommendation[0], "reason": engine_recommendation[1]}}
                               if engine_recommendation else {})})
        # Vision returned nothing — fall through to the local engine
        # fallback_reason tells the frontend why: "quota" | "error" | "network" | "parse" | "empty"
        print(f"  [OCR] Vision fell back ({fallback_reason}) — using {local_engine}")

    # ── Local OCR path (EasyOCR or RapidOCR, per local_engine) ─────────────────
    regions, raw_boxes_out, h_borders_pct, v_borders_pct = _run_local_detection(image_bytes, lang, margin_scale)

    return jsonify({
        "regions":   regions,
        "raw_boxes": raw_boxes_out,
        "ocr_engine": local_engine,
        "h_borders": h_borders_pct,
        "v_borders": v_borders_pct,
        # Included when Vision was attempted but fell back (quota / error / network / parse).
        # None / absent when Vision was never tried (mode='off', no key, or lang not in VISION_LANGS).
        **({"vision_fallback": fallback_reason} if fallback_reason else {}),
        # Vision may have burned real billed tokens even on a fallback (e.g. a
        # "parse" outcome — Gemini returned a 200, we just couldn't use it) —
        # surface that so the cost tracker doesn't miss it just because the
        # OCR result ultimately came from the local engine instead.
        **({"usage": vision_usage, "usage_model": ai_model} if vision_usage else {}),
        # See _recommend_local_engine — only present when we have a tested
        # recommendation for this language AND it differs from what was used.
        **({"local_engine_recommendation":
            {"engine": engine_recommendation[0], "reason": engine_recommendation[1]}}
           if engine_recommendation else {}),
    })


@app.route("/ocr-crop", methods=["POST"])
def ocr_crop():
    """
    POST body:  { "url": "https://cdn…/page.jpg",   # or "image_b64" — see _load_image_bytes
                  "box": [x1, y1, x2, y2],   # pixel coords
                  "lang": "vi" }
    Response:   { "text": "recognized text" }

    Crops the image to the given pixel box and runs OCR on just that region.
    Called by the correction UI when the user draws a new bounding box.
    """
    body = request.get_json(force=True, silent=True) or {}
    box  = body.get("box", [])
    lang = body.get("lang", "en").lower()

    if len(box) != 4:
        abort(400, "box must be [x1, y1, x2, y2] in pixels.")

    # Load bytes — MangaDex CDN url, or a local-folder/CBZ image_b64
    image_bytes = _load_image_bytes(body)

    # Decode + crop
    try:
        pil      = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        iw, ih   = pil.size
        x1, y1, x2, y2 = (max(0, min(int(v), d - 1))
                           for v, d in zip(box, [iw, ih, iw, ih]))
        if x2 <= x1 or y2 <= y1:
            abort(400, "Crop box has zero area after clamping.")
        crop = pil.crop((x1, y1, x2, y2))
        arr  = _preprocess_for_ocr(np.array(crop))
    except Exception as e:
        abort(422, f"Image decode/crop error: {e}")

    # OCR the crop (serialised)
    try:
        reader = _get_reader(lang)
        with _infer_lock:
            fragments, frag_confidences = _easyocr_readtext_primary(reader, arr, lang)
    except Exception as e:
        abort(500, f"OCR failed: {e}")

    # This route has no merge step (a crop is already one region, nothing
    # to cluster) so min_conf applies directly here rather than being
    # deferred the way _run_easyocr_detection defers it to
    # _merge_bubble_regions. The short-word carve-out was already applied
    # inside _easyocr_readtext_primary.
    min_conf = _MIN_CONF_MAP.get(lang, 0.35)
    texts = [text for (_, text), conf in zip(fragments, frag_confidences)
             if conf >= min_conf or len(text) <= 2]
    return jsonify({"text": " ".join(texts)})


class _VisionCropError(Exception):
    """Raised by _gemini_crop_ocr_core on any failure. status carries the
    HTTP status the original /vision-crop route should abort() with;
    programmatic callers (e.g. the micro-crop rescue pass) catch this
    directly instead of triggering a Flask abort."""
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _gemini_crop_ocr_core(pil_img: "Image.Image", box_px: tuple, lang: str,
                           ai_key: str, ai_model: str) -> tuple:
    """
    Core of Gemini Vision crop-OCR: crop pil_img to box_px, send to Gemini,
    return (text, usage). Shared by the /vision-crop route (a user-drawn
    box in the correction UI) and the automatic micro-crop rescue pass in
    /ocr (orphaned/garbage-text EasyOCR fragments — see that route's
    docstring). Raises _VisionCropError on any failure; callers decide
    whether that means abort()ing an HTTP request or just skipping one
    fragment in an automatic pass.
    """
    iw, ih = pil_img.size
    x1, y1, x2, y2 = (max(0, min(int(v), d - 1))
                       for v, d in zip(box_px, [iw, ih, iw, ih]))
    if x2 <= x1 or y2 <= y1:
        raise _VisionCropError(400, "Crop box has zero area after clamping.")
    crop = pil_img.crop((x1, y1, x2, y2))

    buf = io.BytesIO()
    crop.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    lang_name = _VISION_LANG_NAMES.get(lang, lang)

    prompt = (
        f"This is a cropped region from a manga page. "
        f"The source language is {lang_name}.\n"
        f"Read ALL visible text in this image exactly as printed, in natural reading order "
        f"(right-to-left for Japanese/Korean, left-to-right otherwise). "
        f"Include sound effects (SFX/onomatopoeia) if present.\n"
        f"Return ONLY the raw text with no explanation, no labels, no punctuation added "
        f"by you, and no markdown. If there is no text, return an empty string."
    )

    url = GEMINI_API.format(model=ai_model)
    payload = {
        "contents": [{
            "parts": [
                {"inline_data": {"mime_type": "image/png", "data": b64}},
                {"text": prompt},
            ]
        }],
        "generationConfig": {
            "temperature": 0.0,
            "maxOutputTokens": 512,
        },
    }

    # Flash-Lite sometimes supports thinking; explicitly disable it for crop
    # requests — we want speed and a plain string, not a deliberation block.
    if "lite" in ai_model.lower() or "flash" in ai_model.lower():
        payload["generationConfig"]["thinkingConfig"] = {"thinkingBudget": 0}

    # Crop-OCR is called once per box, often several in a row (hand-drawn
    # boxes, or now the automatic rescue pass firing on multiple orphaned
    # fragments on one page) — a single transient hiccup (network blip,
    # Gemini briefly 5xx-ing) used to surface immediately as a failure and
    # leave that one box permanently stuck with no OCR text. A couple of
    # quick retries absorb most of that transient noise; genuine, persistent
    # failures (bad key, real quota exhaustion, malformed request) still
    # surface — those aren't retried away, just the flaky-network class.
    r = None
    last_exc = None
    for attempt in range(3):
        try:
            r = requests.post(
                f"{url}?key={ai_key}",
                json=payload,
                timeout=20,
                headers={"Content-Type": "application/json"},
            )
            last_exc = None
            if r.status_code >= 500 and attempt < 2:
                time.sleep(0.6 * (attempt + 1))
                continue
            break
        except requests.RequestException as e:
            last_exc = e
            if attempt < 2:
                time.sleep(0.6 * (attempt + 1))
                continue
    if last_exc is not None:
        raise _VisionCropError(502, f"Gemini network error: {last_exc}")

    if r.status_code == 429:
        raise _VisionCropError(429, "Gemini quota exceeded — try again shortly or use EasyOCR Draw instead.")
    if not r.ok:
        raise _VisionCropError(502, f"Gemini Vision error {r.status_code}: {r.text[:200]}")

    try:
        resp  = r.json()
        parts = resp["candidates"][0]["content"]["parts"]
        text  = " ".join(
            p["text"].strip() for p in parts
            if p.get("text") and not p.get("thought")
        ).strip()
    except (KeyError, IndexError, ValueError):
        raise _VisionCropError(502, "Unexpected Gemini Vision response format.")

    usage = None
    usage_meta = resp.get("usageMetadata")
    if isinstance(usage_meta, dict):
        usage = {
            "prompt_tokens":     usage_meta.get("promptTokenCount", 0),
            "completion_tokens": usage_meta.get("candidatesTokenCount", 0),
            "total_tokens":      usage_meta.get("totalTokenCount", 0),
        }
    return text, usage


@app.route("/vision-crop", methods=["POST"])
def vision_crop():
    """
    POST body:  { "url": "https://cdn…/page.jpg",   # or "image_b64" — see _load_image_bytes
                  "box": [x1, y1, x2, y2],   # pixel coords
                  "lang": "vi",
                  "ai_key": "AIza…",
                  "ai_model": "gemini-2.0-flash-lite" }
    Response:   { "text": "recognized text" }

    Crops the image to the given pixel box and sends it to Gemini Vision
    for OCR. Called by the correction UI's ✦ VISION draw mode.

    Compared to /ocr-crop (EasyOCR), this handles:
      - Stylised / decorative manga fonts that stump EasyOCR
      - Vertical text / mixed-script SFX
      - Regions where EasyOCR confidence was too low and the badge was wrong

    This is now a thin wrapper around _gemini_crop_ocr_core — see that
    function's docstring. The automatic micro-crop rescue pass in /ocr
    (orphaned/garbage-text EasyOCR fragments) calls the same core directly.
    """
    body     = request.get_json(force=True, silent=True) or {}
    box      = body.get("box", [])
    lang     = body.get("lang", "en").lower()
    ai_key   = body.get("ai_key", "").strip()
    ai_model = body.get("ai_model", "gemini-2.5-flash").strip()

    if len(box) != 4:
        abort(400, "box must be [x1, y1, x2, y2] in pixels.")
    if not ai_key:
        abort(400, "ai_key is required for Vision crop.")

    image_bytes = _load_image_bytes(body)
    try:
        pil = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as e:
        abort(422, f"Image decode error: {e}")

    try:
        text, usage = _gemini_crop_ocr_core(pil, tuple(box), lang, ai_key, ai_model)
    except _VisionCropError as e:
        abort(e.status, e.message)

    # Usage for the cost tracker (see cost-tracker.js) — small requests
    # still cost real, trackable money at high volume, which is the whole
    # point of tracking "any future paid call", not just the big ones.
    result = {"text": text}
    if usage is not None:
        result["usage"] = usage
        result["usage_model"] = ai_model
    return jsonify(result)


# ─── Startup helpers ──────────────────────────────────────────────────────────

# FIX #10 — check for port conflict before Flask tries to bind
def _port_in_use(port: int) -> bool:
    """Return True if something is already listening on HOST:port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex((HOST, port)) == 0


# FIX #11 — poll the socket instead of using a fixed 1-second sleep,
#            so the browser opens as soon as Flask is actually ready
def _open_when_ready():
    """Poll until the server accepts connections, then open the browser."""
    for _ in range(30):          # up to 3 seconds total
        try:
            with socket.create_connection((HOST, PORT), timeout=0.1):
                webbrowser.open(f"http://{HOST}:{PORT}")
                return
        except OSError:
            time.sleep(0.1)


@app.route("/export-page", methods=["POST"])
def export_page():
    """
    POST body (pipeline / auto-OCR mode — unchanged):
      { "url": "https://cdn…/page.jpg",
        "regions": [ {text, t, x, y, box:[x1,y1,x2,y2] (0-100 pct), tl} ],
        "erase_mode": "auto" | "inpaint" | "flatten"   (optional, default auto),
        "ai_inpaint": bool                     (optional, default false),
        "erase_only": bool                     (optional, default false) }

    POST body (standalone Erase Tool manual mode — new):
      { "url": "https://cdn…/page.jpg",
        "manual": true,
        "boxes": [ {box:[x1,y1,x2,y2] (0-100 pct), tl: str, outside: bool,
                    pre_paint: "data:image/png;base64,..." (optional),
                    pre_painted: bool (optional),
                    font_path: str (optional, must be one _discover_system_fonts returned),
                    font_size: int (optional, explicit pt size — 0/absent = auto-fit)} ],
        "erase_mode": "auto" | "inpaint" | "flatten"   (optional, default auto),
        "ai_inpaint": bool                     (optional, default false),
        "legend_layout": "below" | "sidebar" | "both"  (optional, default below),
        "font_path": str    (optional, page-level default font),
        "font_size": int    (optional, page-level default size, 0 = auto-fit) }

    Response: image/png bytes — the page with translations burned in
              (or, if erase_only / manual box has no tl, just the erased page).

    Single-page typeset export. Used by the "Export this page" action, as
    the per-page worker for /export-chapter's zip build, and by the
    standalone Erase Tool.

    erase_mode "auto" (default): per-region routing — flat/light regions
    (plain bubbles, the majority of boxes on a typical page) are flood-
    filled directly, everything else goes through the full inpaint
    pipeline. "inpaint" and "flatten" force that method for every region
    on the page regardless of what it looks like, for cases where you know
    better than the auto-detection (e.g. the Erase Tool, where a human
    already drew the box and may want a specific behavior).

    ai_inpaint (optional, default False): when true, whichever boxes would
    have gone through classical NS/TELEA inpaint under the erase_mode above
    are routed to LaMa instead (see _erase_region_ai_inpaint) — an opt-in,
    per-request choice, not a server-wide setting, matching this app's
    "bring your own tradeoff" pattern for Vision OCR / translation provider
    choice elsewhere. Meaningfully slower per page than classical inpaint,
    and the first request that ever sets this true triggers a one-time
    ~200MB model download — see that function's docstring for real measured
    cost and an honest caveat about unconfirmed quality-vs-classical claims.
    A missing/failed model load surfaces as a 503 with a plain-language
    message rather than a silent fallback to classical inpaint, since a
    silent downgrade would defeat the point of someone explicitly opting in.

    manual mode only touches the exact boxes given — nothing else on the
    page is erased or written to, so anything the person didn't box (SFX,
    background text, etc.) is left untouched with no extra "skip this type"
    logic needed. A box with outside:true is left completely untouched (not
    erased) and its translation is printed in a numbered legend outside the
    page instead of inside the box (for text sitting on art/signage that's
    hard to cleanly paint over, or worth keeping visible as printed).
    pre_paint / pre_painted are ignored for an outside box, since there's no
    erase step for them to apply to.
    A box with pre_paint gets that patch pasted in before its own erase step
    runs (see typeset_manual_page / _apply_paint_mask); pre_painted:true
    skips server-side erase for that box entirely.
    """
    body       = request.get_json(force=True, silent=True) or {}
    erase_mode = body.get("erase_mode", "auto").strip().lower()
    manual     = bool(body.get("manual", False))
    ai_inpaint = bool(body.get("ai_inpaint", False))

    if erase_mode not in ("auto", "inpaint", "flatten"):
        abort(400, "erase_mode must be 'auto', 'inpaint', or 'flatten'.")

    # "url" (MangaDex CDN) or "image_b64" (local-folder/CBZ page) — see
    # _load_image_bytes. Everything below just needs the bytes; it doesn't
    # care which source they came from.
    image_bytes = _load_image_bytes(body)

    if manual:
        boxes = body.get("boxes", [])
        legend_layout = body.get("legend_layout", "below").strip().lower()
        if not isinstance(boxes, list):
            abort(400, "boxes must be a list.")
        if legend_layout not in ("below", "sidebar", "both"):
            abort(400, "legend_layout must be 'below', 'sidebar', or 'both'.")

        # SECURITY: font_path ends up in ImageFont.truetype(path, ...) — an
        # arbitrary client-supplied path would let anyone reaching this
        # server's HTTP port make it open arbitrary files on disk as a
        # "font" (denial-of-service at minimum). Only accept a path that
        # _discover_system_fonts() itself found and returned to the
        # frontend — never trust the raw string as-is.
        valid_font_paths = {f["path"] for f in _discover_system_fonts()}

        def _clean_font_path(raw: str) -> str:
            raw = (raw or "").strip()
            return raw if raw in valid_font_paths else ""

        def _clean_font_size(raw) -> int:
            try:
                return max(0, min(200, int(raw or 0)))
            except (TypeError, ValueError):
                return 0

        page_font_path = _clean_font_path(body.get("font_path", ""))
        page_font_size = _clean_font_size(body.get("font_size", 0))

        for b in boxes:
            if not isinstance(b, dict):
                continue
            if "font_path" in b:
                b["font_path"] = _clean_font_path(b.get("font_path", ""))
            if "font_size" in b:
                b["font_size"] = _clean_font_size(b.get("font_size", 0))

        try:
            png_bytes = typeset_manual_page(image_bytes, boxes, erase_mode=erase_mode,
                                             legend_layout=legend_layout,
                                             font_path=page_font_path,
                                             font_size=page_font_size,
                                             ai_inpaint=ai_inpaint)
        except _AiInpaintUnavailable as e:
            abort(503, str(e))
        except Exception as e:
            abort(422, f"Typesetting failed: {e}")
        return Response(png_bytes, content_type="image/png")

    regions    = body.get("regions", [])
    erase_only = bool(body.get("erase_only", False))
    if not isinstance(regions, list):
        abort(400, "regions must be a list.")

    try:
        png_bytes = typeset_page(image_bytes, regions, erase_mode=erase_mode,
                                  erase_only=erase_only, ai_inpaint=ai_inpaint)
    except _AiInpaintUnavailable as e:
        abort(503, str(e))
    except Exception as e:
        abort(422, f"Typesetting failed: {e}")

    return Response(png_bytes, content_type="image/png")


@app.route("/export-chapter", methods=["POST"])
def export_chapter():
    """
    POST body: { "pages": [ { "url": "...", "regions": [...] }, ... ],
                 "erase_mode": "auto" | "inpaint" | "flatten"   (optional, default auto),
                 "chapter_label": "ch12"                (optional, used for filenames) }
    Response: application/zip — one PNG per page, named 001.png, 002.png, ...

    Each page's "url" may be "image_b64" instead (see _load_image_bytes) —
    e.g. for a locally-sourced (folder/CBZ) chapter exported by a script
    that never went through MangaDex at all.

    Whole-chapter typeset export. Pages are processed serially (typesetting
    is CPU-bound via cv2.inpaint; the OCR/translate work was already done by
    the reader, so this route does no network calls except the page-image
    downloads themselves and no AI calls at all — it's just image processing).

    See export_page() above for what erase_mode "auto" does.
    """
    body       = request.get_json(force=True, silent=True) or {}
    pages      = body.get("pages", [])
    erase_mode = body.get("erase_mode", "auto").strip().lower()
    label      = "".join(c for c in body.get("chapter_label", "chapter")
                          if c.isalnum() or c in "-_") or "chapter"

    if not isinstance(pages, list) or not pages:
        abort(400, "pages must be a non-empty list.")
    if erase_mode not in ("auto", "inpaint", "flatten"):
        abort(400, "erase_mode must be 'auto', 'inpaint', or 'flatten'.")
    if len(pages) > 500:
        abort(400, "Too many pages in one export (max 500).")

    import zipfile
    buf = io.BytesIO()
    errors = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, page in enumerate(pages):
            if not isinstance(page, dict):
                errors.append(f"page {i}: not an object")
                continue
            regions = page.get("regions", [])
            try:
                image_bytes = _load_image_bytes(page)
                png_bytes = typeset_page(image_bytes, regions if isinstance(regions, list) else [],
                                          erase_mode=erase_mode)
                zf.writestr(f"{label}_{i+1:03d}.png", png_bytes)
            except HTTPException as e:
                errors.append(f"page {i}: {e.description}")
            except Exception as e:
                errors.append(f"page {i}: {e}")

        if errors:
            zf.writestr("_export_errors.txt",
                        "Some pages failed to export:\n\n" + "\n".join(errors))

    buf.seek(0)
    return Response(buf.getvalue(), content_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{label}_typeset.zip"'})


if __name__ == "__main__":
    # FIX #10 — friendly error instead of a cryptic socket traceback
    if _port_in_use(PORT):
        print(f"\n  ✗  Port {PORT} is already in use.")
        print(f"     Stop the other process, or change PORT at the top of this script.\n")
        sys.exit(1)

    _check_exposure_or_exit(HOST)

    addr = f"http://{HOST}:{PORT}"
    print(f"\n  MangaTL  →  {addr}")
    print(  "  Ctrl+C to stop\n")
    threading.Thread(target=_open_when_ready, daemon=True).start()
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
