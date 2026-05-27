#!/usr/bin/env python3
"""
fitz_extract.py — Extract clean semantic HTML chunks from a PDF using PyMuPDF.

Protocol (stdio):
  argv[1] : absolute path to the PDF file
  stdin   : JSON array of {pageNum: int (1-based), box: [nx1,ny1,nx2,ny2]}
  stdout  : JSON array — one entry per request:
              {html, text, fonts_embedded, fonts_skipped, page_size, clip_rect}
            On per-request error: {error, html: null}
            On PDF-open error:    top-level {"error": "..."} object

Coordinate system: normalized 0-1, top-left origin (same as the frontend canvas).
PyMuPDF also uses top-left origin, so conversion is simple multiplication by page
width/height (in PDF points).
"""

import sys
import json
import re as _re
import html as _html
import fitz  # PyMuPDF

# Text blocks have type==0 in the dict returned by get_text("dict").
_TEXT_BLOCK_TYPE = 0

# Per-line average font size above this threshold → <h2> heading.
_HEADING_SIZE_THRESHOLD = 13.5

# A horizontal drawing segment counts as an underline when its y sits within
# this many points below the span's bottom edge.
# 2 pt keeps genuine underlines (which sit 0-2 pt below the baseline) while
# rejecting table/box borders that appear 3+ pt below the last text line.
_UNDERLINE_Y_TOLERANCE = 2

# Drug-label cross-reference pattern: "[see X]" or "(see X)".
# These spans are always italic+underlined in the PDF but achieve italic via a
# text-matrix shear (not a separate italic font), so no flag or oracle detects
# them.  Matching by text content is the only reliable approach.
_CROSS_REF_RE = _re.compile(r'\[\s*[Ss]ee\b|\(\s*[Ss]ee\b')


# ── Style oracle: parse PyMuPDF's own HTML output for bold/italic/underline ──

def _parse_mupdf_html_styles(html_str):
    """
    Extract per-span style info from PyMuPDF's get_text("html") output.

    PyMuPDF emits CSS classes in a <style> block rather than inline styles.
    This function parses those classes and collects one (text, bold, italic,
    underline) tuple per <span> in document order — parallel to the spans
    returned by get_text("dict"), allowing us to use MuPDF's deeper
    font-metrics italic detection without adopting the absolute-positioned
    layout of the raw HTML output.
    """
    class_styles = {}
    css_block = _re.search(r'<style[^>]*>(.*?)</style>', html_str, _re.DOTALL | _re.I)
    if css_block:
        for m in _re.finditer(r'span\.(\w+)\s*\{([^}]*)\}', css_block.group(1)):
            cls, props = m.group(1), m.group(2)
            p = props.lower().replace(' ', '')
            # PyMuPDF often emits the raw PDF font name in font-family rather than
            # separate font-weight/font-style properties, so check for "bold"/"italic"
            # appearing anywhere in the props string (which catches both the explicit
            # CSS property form and the font-family name form).
            in_family = 'font-family:' in p
            class_styles[cls] = {
                'b': 'font-weight:bold'          in p or (in_family and 'bold'   in p),
                'i': 'font-style:italic'         in p or (in_family and 'italic' in p),
                'u': 'text-decoration:underline' in p,
            }
    items = []
    for m in _re.finditer(r'<span\s+class="(\w+)">(.*?)</span>', html_str, _re.DOTALL):
        cls, inner = m.group(1), m.group(2)
        text = (inner
                .replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
                .replace('&quot;', '"').replace('&#39;', "'").replace('&nbsp;', '\xa0'))
        s = class_styles.get(cls, {})
        items.append((text, s.get('b', False), s.get('i', False), s.get('u', False)))
    return items


# ── Link-annotation detection (italic + underline for cross-references) ──

def _get_link_rects(page, clip):
    """
    Return fitz.Rect objects for every hyperlink annotation whose source rect
    intersects the clip.  In drug-label PDFs these are the cross-reference
    spans ([see Section X]) that are rendered italic+underlined by the PDF
    viewer but whose font glyphs achieve italic via a shear matrix rather than
    a separate italic font file — so neither dict flags nor the HTML oracle
    detect them as italic.  Marking all link-overlapping text as italic+
    underlined matches the consistent styling convention used in these docs.
    """
    rects = []
    for link in page.get_links():
        r = fitz.Rect(link["from"])
        if r.intersects(clip):
            rects.append(r)
    return rects


def _bbox_in_link(bbox, link_rects):
    """True when the span bbox significantly overlaps any link annotation."""
    sr = fitz.Rect(bbox)
    return any(sr.intersects(lr) for lr in link_rects)


# ── Drawing-based underline detection ────────────────────────────────────────

def _get_underline_segs(page, clip):
    """
    Collect horizontal path segments and thin filled rectangles from the page
    drawings within the clip region.  PDF underlines are drawn as separate
    vector objects — not font attributes — so they do not appear in span flags.
    Both "l" (line) and "re" (thin rectangle, height < 3 pt) item types are
    checked; neither is pre-filtered on path["rect"] which can be None.
    Returns list of (x0, y, x1) tuples.
    """
    segs = []
    for path in page.get_drawings():
        for item in path.get('items', []):
            if item[0] == 'l':
                p1, p2 = item[1], item[2]
                if abs(p1.y - p2.y) < 2:
                    y = (p1.y + p2.y) / 2
                    if clip.y0 - 4 <= y <= clip.y1 + 4:
                        segs.append((min(p1.x, p2.x), y, max(p1.x, p2.x)))
            elif item[0] == 're':
                r = item[1]
                if r.height < 3:
                    y = (r.y0 + r.y1) / 2
                    if clip.y0 - 4 <= y <= clip.y1 + 4:
                        segs.append((r.x0, y, r.x1))
    return segs


def _seg_underlines_bbox(bbox, segs):
    sx0, sy0, sx1, sy1 = bbox
    span_w = max(sx1 - sx0, 1)
    for ux0, uy, ux1 in segs:
        if sy1 - 2 <= uy <= sy1 + _UNDERLINE_Y_TOLERANCE and ux0 < sx1 and ux1 > sx0:
            # Reject segments >3× wider than the span — those are table/box borders,
            # not per-word underlines.
            if (ux1 - ux0) > span_w * 3:
                continue
            return True
    return False


def _line_all_bold(line):
    """
    Return True when every non-whitespace span in the line is bold.
    Used to detect inline section headings (e.g. "5.6 Hypoglycemia") that are
    the same font size as body text and therefore miss the size threshold.
    """
    spans = [s for s in line.get("spans", []) if s.get("text", "").strip()]
    if not spans:
        return False
    return all(
        bool(s.get("flags", 0) & 16) or "bold" in s.get("font", "").lower()
        for s in spans
    )


# ── Core semantic HTML builder ────────────────────────────────────────────────

def _build_semantic_html(page, clip):
    """
    Extract text from the clipped region and return a semantic HTML fragment
    plus a plain-text string.

    Style detection (layered, all results OR-ed together):
      1. Cross-reference pattern — span text matching "[see X]" / "(see X)" is
         marked italic+underlined.  These spans use a text-matrix shear for
         italic (not a separate italic font) so no other method detects them.
      2. Link annotations — spans overlapping a PDF hyperlink rect are also
         marked italic+underlined (catches linked cross-refs).
      3. HTML oracle — get_text("html") CSS classes via MuPDF's font-metrics.
      4. Dict flags — flags & 16 (bold), flags & 2 (italic).
      5. Font name  — "bold"/"italic"/"oblique" substrings.
      6. Drawing segs — horizontal path/rect objects for PDF-drawn underlines.

    Heading detection uses two rules:
      • Per-line size: avg font size > 13.5 pt → <h2>.
      • All-bold first line: if a block's first line is entirely bold and the
        second line is not, the first line is an inline section heading (e.g.
        "5.6 Hypoglycemia") → <h3>, remaining lines → <p>.

    Returns (html_fragment, plain_text).
    """
    # Use no clip here so PyMuPDF returns real (untruncated) span bboxes.
    # get_text("dict", clip=...) clips the reported bboxes to the clip rect,
    # so spans just outside the boundary appear to have their center inside —
    # defeating the center-point filter.  We filter manually below instead.
    page_dict  = page.get_text("dict")
    link_rects = _get_link_rects(page, clip)
    underlines = _get_underline_segs(page, clip)
    oracle     = _parse_mupdf_html_styles(
        page.get_text("html", clip=clip, flags=1 | 2)
    )
    ora_idx = 0

    def _span_to_html(span):
        nonlocal ora_idx
        raw = span.get("text", "")
        esc = _html.escape(raw)
        if not raw:
            return esc

        bbox = span.get("bbox", (0, 0, 0, 0))

        # 1. Cross-reference text pattern (highest-priority italic source).
        is_cross_ref = bool(_CROSS_REF_RE.search(raw))

        # 2. Link annotation.
        is_link = _bbox_in_link(bbox, link_rects)

        # 3. HTML oracle.
        ob = oi = ou = False
        for look in range(5):
            idx = ora_idx + look
            if idx >= len(oracle):
                break
            ot, ob2, oi2, ou2 = oracle[idx]
            if raw.strip() == ot.strip() or (not raw.strip() and not ot.strip()):
                ob, oi, ou = ob2, oi2, ou2
                ora_idx = idx + 1
                break

        # Strict clip filter: include only spans whose center lies strictly
        # inside the drawn box (no tolerance — block pre-filter already removed
        # blocks with zero overlap, so any remaining ambiguity should be excluded).
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2
        if not (clip.x0 <= cx <= clip.x1 and clip.y0 <= cy <= clip.y1):
            return ""

        # 4+5. Dict flags and font name.
        flags    = span.get("flags", 0)
        raw_font = span.get("font", "")
        font     = raw_font.lower()
        is_bold  = ob or bool(flags & 16) or "bold" in font or "-bd" in font or "+bd" in font

        # 6b. Text-matrix shear: check both b (index 1) and c (index 2) components.
        tm = span.get("transform", (1, 0, 0, 1, 0, 0))
        is_shear_italic = len(tm) >= 3 and (abs(tm[1]) > 0.05 or abs(tm[2]) > 0.05)

        # Linotype/Helvetica oblique convention: font name ends with a capital O
        # after the style abbreviation, e.g. HelveticaNeueLTPro-CnO (Condensed Oblique),
        # HelveticaNeueLTStd-BdCnO (Bold Condensed Oblique). The 'O' is not present
        # in non-oblique weights so false positives are negligible.
        is_oblique_suffix = bool(_re.search(r'-[A-Za-z]*O$', raw_font))

        is_italic = (is_cross_ref or is_link or oi or bool(flags & 2) or
                     "italic" in font or "oblique" in font or "-it" in font or
                     is_shear_italic or is_oblique_suffix)
        # 6. Drawing segments.
        # is_link is intentionally excluded here: PDF hyperlinks that have no
        # drawn underline segment should not get <u> styling. _seg_underlines_bbox
        # already catches links that ARE drawn with an underline.
        is_underline = is_cross_ref or ou or _seg_underlines_bbox(bbox, underlines)

        if is_bold:      esc = f"<b>{esc}</b>"
        if is_italic:    esc = f"<i>{esc}</i>"
        if is_underline: esc = f"<u>{esc}</u>"
        return esc

    html_parts  = []
    plain_parts = []
    para_html   = []
    para_plain  = []

    def _flush_para():
        if para_html:
            joined = "<br>".join(line for line in para_html if line)
            html_parts.append(f'<p style="margin:0 0 4px;">{joined}</p>')
            plain_parts.append(" ".join(para_plain))
            para_html.clear()
            para_plain.clear()

    def _line_to_html_plain(line):
        spans = line.get("spans", [])
        lh = lp = ""
        sizes = []
        for s in spans:
            lh += _span_to_html(s)  # advances oracle; returns "" if outside clip
            bbox = s.get("bbox", (0, 0, 0, 0))
            cx = (bbox[0] + bbox[2]) / 2
            cy = (bbox[1] + bbox[3]) / 2
            if clip.x0 <= cx <= clip.x1 and clip.y0 <= cy <= clip.y1:
                lp += s.get("text", "")
                sizes.append(s.get("size", 0))
        return lh.strip(), lp.strip(), sizes

    for block in page_dict.get("blocks", []):
        if block.get("type") != _TEXT_BLOCK_TYPE:
            continue
        # Skip blocks whose bounding box has zero overlap with the clip region.
        # This eliminates whole paragraphs/tables from other page columns before
        # the span-level center-point filter even runs.
        if (fitz.Rect(block.get("bbox", (0, 0, 0, 0))) & clip).is_empty:
            continue

        lines = block.get("lines", [])
        body_start = 0

        # All-bold first-line rule: if the block's first line is entirely bold
        # and the second line is not, treat the first line as an <h3> heading.
        if (len(lines) >= 2
                and _line_all_bold(lines[0])
                and not _line_all_bold(lines[1])):
            lh, lp, _ = _line_to_html_plain(lines[0])
            if lp:
                _flush_para()
                html_parts.append(f'<h3 style="font-weight:bold;margin:0 0 2px;">{lh}</h3>')
                plain_parts.append(lp)
            body_start = 1

        for line in lines[body_start:]:
            lh, lp, sizes = _line_to_html_plain(line)
            if not lp:
                continue
            avg_size = sum(sizes) / len(sizes) if sizes else 0
            if avg_size > _HEADING_SIZE_THRESHOLD:
                _flush_para()
                html_parts.append(f'<h2 style="font-weight:bold;margin:0 0 2px;">{lh}</h2>')
                plain_parts.append(lp)
            else:
                para_html.append(lh)
                para_plain.append(lp)
        _flush_para()  # one <p> per PDF block (paragraph), lines joined with <br>

    inner    = "\n".join(html_parts)
    fragment = (
        f'<div>\n'
        f'{inner}\n'
        f'</div>'
    )
    return fragment, "\n".join(plain_parts)


def _extract_chunk_html(doc, page, W, H, nx1, ny1, nx2, ny2):
    """
    Render the clipped PDF region as a full HTML document.

    Main content: clean semantic HTML (<h2>/<p>/<b>/<i>/<u>) built from
    get_text("dict") with link-annotation, HTML-oracle, flag, and drawing-
    segment style detection.


    Returns:
        html          : str   — full HTML document
        text          : str   — plain-text version of the extracted content
        fonts_embedded: list  — always []
        fonts_skipped : list  — always []
        clip          : fitz.Rect
    """
    clip = fitz.Rect(nx1 * W, ny1 * H, nx2 * W, ny2 * H) & page.rect

    if clip.is_empty:
        return (
            '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>'
            '<body><!-- empty chunk --></body></html>',
            "", [], [], clip
        )

    semantic_fragment, plain_text = _build_semantic_html(page, clip)

    html_doc = (
        '<!DOCTYPE html>\n'
        '<html lang="en">\n'
        '<head>\n'
        '<meta charset="UTF-8">\n'
        '</head>\n'
        '<body>\n'
        f'{semantic_fragment}\n'
        '</body>\n'
        '</html>\n'
    )

    return html_doc, plain_text, [], [], clip


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: fitz_extract.py <pdf_path>"}))
        sys.exit(1)

    pdf_path = sys.argv[1]

    try:
        raw = sys.stdin.read()
        requests = json.loads(raw)
    except Exception as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        print(json.dumps({"error": f"Cannot open PDF: {e}"}))
        sys.exit(1)

    results = []
    for req in requests:
        try:
            pn   = int(req["pageNum"]) - 1   # 0-based in PyMuPDF
            if pn < 0:
                raise ValueError(f"pageNum must be >= 1, got {req['pageNum']}")
            box  = req["box"]                # [nx1, ny1, nx2, ny2]
            page = doc[pn]
            W, H = page.rect.width, page.rect.height
            html, text, embedded, skipped, clip = _extract_chunk_html(doc, page, W, H, *box)
            results.append({
                "html": html,
                "text": text,
                "fonts_embedded": embedded,
                "fonts_skipped": skipped,
                "page_size": {"w": round(W, 2), "h": round(H, 2)},
                "clip_rect": {
                    "x": round(clip.x0, 2), "y": round(clip.y0, 2),
                    "w": round(clip.width, 2), "h": round(clip.height, 2),
                },
            })
        except Exception as e:
            results.append({"error": str(e), "html": None})

    doc.close()
    print(json.dumps(results))


if __name__ == "__main__":
    main()
