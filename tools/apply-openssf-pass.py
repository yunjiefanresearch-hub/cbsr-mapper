#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply.py — build the deployable cbsr.io and cbsr-mapper bundles.

Every edit below traces to a specific OpenSSF Best Practices criterion that the
badge submission now ASSERTS. The badge answers are commitments; this script
makes the artifacts honour them.

  documentation_current      the sites published v0.10.1 / "46 citable" while the
                             register had retracted both -> runtime binding
  documentation_achievements badge must be linked from the project front page
  description_good/interact  site must say what it does and how to report bugs
  accessibility_best_practices skip link, landmarks, reduced motion
  internationalization       figures must survive the EN/ZH swap
  small_tasks (Gold)         verification worklist surfaced as itemised tasks
  hardened_site (Gold)       CSP/referrer/permissions meta, partial
  sites_password_security    the maintain.html form posts off-site -> CSP form-action

Idempotent: every patch asserts its anchor is present before editing and refuses
to run twice.
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

SRC = Path("/home/claude/work")
OUT = Path("/home/claude/work/dist")
ASSETS = Path("/home/claude/work/out")

BADGE_MD = (
    "[![OpenSSF Best Practices]"
    "(https://www.bestpractices.dev/projects/14172/badge)]"
    "(https://www.bestpractices.dev/projects/14172)"
)
BADGE_HTML = (
    '<a class="badge-ossf" href="https://www.bestpractices.dev/projects/14172" '
    'target="_blank" rel="noreferrer">'
    '<img src="https://www.bestpractices.dev/projects/14172/badge" '
    'alt="OpenSSF Best Practices badge status for CBSR" width="200" height="20" '
    'loading="lazy" decoding="async"></a>'
)

problems: list[str] = []


def edit(path: Path, old: str, new: str, label: str, count: int = 1) -> None:
    text = path.read_text(encoding="utf-8")
    found = text.count(old)
    if found == 0:
        problems.append(f"{path.name}: anchor missing for {label}")
        return
    if count != -1 and found != count:
        problems.append(f"{path.name}: expected {count} of {label}, found {found}")
        return
    path.write_text(text.replace(old, new), encoding="utf-8")


# ===========================================================================
# 1. cbsr.io
# ===========================================================================

def build_site() -> Path:
    site = OUT / "cbsr.io"
    if site.exists():
        shutil.rmtree(site)
    shutil.copytree(SRC / "cbsr_io-v3" / "cbsr.io", site)

    # --- new assets ------------------------------------------------------
    shutil.copy(ASSETS / "cbsr_io" / "cbsr-live.js", site / "assets" / "cbsr-live.js")

    css = site / "assets" / "cbsr.css"
    additions = (ASSETS / "cbsr_io" / "cbsr-additions.css").read_text(encoding="utf-8")
    css.write_text(
        css.read_text(encoding="utf-8")
        + "\n\n/* ==== appended by the v0.11.0 pass — see cbsr-additions.css ==== */\n"
        + additions
        + SITE_EXTRA_CSS,
        encoding="utf-8",
    )

    pages = sorted(p for p in site.glob("*.html"))

    for page in pages:
        # -- security + privacy headers (hardened_site, partial) -----------
        edit(
            page,
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            + SECURITY_META,
            "security meta",
        )

        # -- runtime figure binding (documentation_current) ---------------
        edit(
            page,
            '<link rel="stylesheet" href="assets/cbsr.css">',
            '<link rel="stylesheet" href="assets/cbsr.css">\n'
            '<script src="assets/cbsr-live.js" defer></script>',
            "cbsr-live include",
        )

        # -- skip link (accessibility_best_practices) ---------------------
        edit(
            page,
            "<body>",
            '<body>\n<a class="skip" href="#main">Skip to content</a>',
            "skip link",
        )

        # -- the nav version stamp is a register figure, not markup -------
        edit(
            page,
            '<span class="ver">v0.10.1</span>',
            '<span class="ver" data-live="version" data-live-prefix="v">v0.11.0</span>',
            "nav version",
        )

        # -- footer: version + badge (documentation_achievements) ---------
        edit(
            page,
            "<span>Cross-Border Stablecoin Register · v0.10.1</span>",
            '<span>Cross-Border Stablecoin Register · '
            '<span data-live="version" data-live-prefix="v">v0.11.0</span></span>',
            "footer version",
        )
        edit(
            page,
            "<span>© 2026 Yunjie Fan</span>",
            "<span>© 2026 Yunjie Fan</span>\n    " + BADGE_HTML,
            "footer badge",
        )

        # -- <main> landmark around the content wrap ----------------------
        text = page.read_text(encoding="utf-8")
        if "</header>\n\n<div class=\"wrap\">" in text:
            text = text.replace(
                "</header>\n\n<div class=\"wrap\">",
                "</header>\n\n<main id=\"main\" class=\"wrap\">",
                1,
            )
            # the matching close is the last </div> before <footer>
            marker = text.rfind("</div>", 0, text.find("<footer>"))
            if marker != -1:
                text = text[:marker] + "</main>" + text[marker + len("</div>"):]
            page.write_text(text, encoding="utf-8")

    # --- prose figures ----------------------------------------------------
    # The header/footer sweep above only reached the shell. These are the
    # sentences that state a figure in running text, and they are the ones that
    # matter most: three of them assert the retracted "46 citable as binding
    # law" claim in the register's own strictest words.
    for page_name, old, new, label in PROSE_FIXES:
        edit(site / page_name, old, new, label)

    # --- index.html: hero + record section --------------------------------
    patch_index(site / "index.html")

    # --- maintain.html: the verification worklist (small_tasks) -----------
    patch_maintain(site / "maintain.html")

    # --- README ------------------------------------------------------------
    readme = site / "README.md"
    readme.write_text(
        readme.read_text(encoding="utf-8").replace(
            "# ", f"{BADGE_MD}\n\n# ", 1
        ),
        encoding="utf-8",
    )
    (site / "DEPLOY.md").write_text(SITE_DEPLOY, encoding="utf-8")
    return site


def patch_index(index: Path) -> None:
    text = index.read_text(encoding="utf-8")
    start = text.find('  <!-- HERO -->')
    if start == -1:
        problems.append("index.html: hero marker missing")
        return
    end = text.find('<hr class="rule">', start)
    if end == -1:
        problems.append("index.html: end of hero missing")
        return

    hero = (ASSETS / "cbsr_io" / "index.hero.html").read_text(encoding="utf-8")
    # strip the instruction comment block at the top of the fragment
    hero = hero[hero.find("<!-- ============================================================ HERO"):]
    hero = "\n".join("  " + line if line.strip() else line for line in hero.splitlines())

    index.write_text(text[:start] + hero + "\n\n  " + text[end:], encoding="utf-8")


def patch_maintain(page: Path) -> None:
    edit(
        page,
        '  <section id="howread">',
        WORKLIST_SECTION + '\n  <section id="howread">',
        "worklist section",
    )


# ===========================================================================
# 2. cbsr-mapper
# ===========================================================================

def build_mapper() -> Path:
    mapper = OUT / "cbsr-mapper"
    if mapper.exists():
        shutil.rmtree(mapper)
    shutil.copytree(SRC / "2-cbsr-mapper" / "cbsr-mapper", mapper)

    src = mapper / "src"
    for name in ("data.snapshot.js", "policyMirror.js", "EvidenceAxes.jsx", "EvaluateView.jsx"):
        shutil.copy(ASSETS / "mapper" / name, src / name)
    (mapper / "tools").mkdir(exist_ok=True)
    shutil.copy(ASSETS / "build_mapper_snapshot.py", mapper / "tools" / "build_mapper_snapshot.py")

    app = src / "App.jsx"
    text = app.read_text(encoding="utf-8")

    # -- replace the 280k-character pasted snapshot with the import --------
    match = re.search(r"^const DATA = \{.*\};$", text, flags=re.M)
    if not match:
        problems.append("App.jsx: DATA literal not found")
    else:
        text = text[: match.start()] + DATA_IMPORT_NOTE + text[match.end():]

    # imports go at the top, after React
    anchor = 'import React'
    idx = text.find(anchor)
    if idx == -1:
        problems.append("App.jsx: React import not found")
    else:
        line_end = text.find("\n", idx) + 1
        text = text[:line_end] + MAPPER_IMPORTS + text[line_end:]

    app.write_text(text, encoding="utf-8")

    # -- the same too-loose gate lived in the live-sync path ---------------
    edit(
        app,
        '          rec.citable = rec.claim_class === "tier1_legal" && rec.evidence_tier === '
        '"resolution_text" && rec.status === "in_force" && rec.binding_status === "in_force_enacted";',
        LIVE_SYNC_GATE,
        "live-sync gate",
    )
    edit(
        app,
        "        DATA.meta.citable_count = DATA.records.filter((r) => r.citable).length;",
        LIVE_SYNC_COUNTS,
        "live-sync counts",
    )

    # -- evaluate view first ------------------------------------------------
    edit(
        app,
        'const VIEWS = ["map", "corridors", "substrate", "forward", "structure", "agents"];',
        'const VIEWS = ["evaluate", "map", "corridors", "substrate", "forward", "structure", "agents"];',
        "VIEWS",
    )
    edit(
        app,
        "      <style>{CSS}</style>",
        "      <style>{CSS + EVIDENCE_AXES_CSS + EVALUATE_VIEW_CSS}</style>",
        "CSS injection",
    )
    edit(
        app,
        '      {view === "map" && (<>',
        VIEW_DISPATCH + '      {view === "map" && (<>',
        "view dispatch",
    )

    # -- a public deployment should not default to demo mode ---------------
    edit(
        app,
        "const DEMO_MODE = (() => {",
        DEMO_NOTE + "const DEMO_MODE = (() => {",
        "DEMO_MODE note",
    )

    # -- the invariant checker read DATA out of App.jsx; it now lives in its
    #    own generated module, and the checker gains the invariant that matters
    #    most now: a single "citable" figure must never be derivable again.
    inv = mapper / "scripts" / "check-invariants.mjs"
    edit(
        inv,
        'const APP = path.join(ROOT, "src", "App.jsx");',
        'const APP = path.join(ROOT, "src", "App.jsx");\n'
        'const SNAPSHOT = path.join(ROOT, "src", "data.snapshot.js");',
        "checker snapshot path",
    )
    edit(inv, INV_EXTRACT_OLD, INV_EXTRACT_NEW, "checker extract")
    edit(inv, INV_COUNTS_OLD, INV_COUNTS_NEW, "checker counts")

    # -- CI gate against snapshot drift ------------------------------------
    pkg = mapper / "package.json"
    edit(
        pkg,
        '"check": "node scripts/check-invariants.mjs"',
        '"check": "node scripts/check-invariants.mjs && npm run check:snapshot",\n'
        '    "check:snapshot": "python3 tools/build_mapper_snapshot.py '
        '--register ../cross-border-stablecoin-register --out src/data.snapshot.js --check"',
        "package check script",
    )

    # -- security meta on the shell ----------------------------------------
    edit(
        mapper / "index.html",
        '<meta name="viewport"',
        MAPPER_META + '    <meta name="viewport"',
        "mapper meta",
    )

    readme = mapper / "README.md"
    readme.write_text(
        readme.read_text(encoding="utf-8").replace("# ", f"{BADGE_MD}\n\n# ", 1),
        encoding="utf-8",
    )
    (mapper / "DEPLOY.md").write_text(MAPPER_DEPLOY, encoding="utf-8")
    return mapper


# ===========================================================================
# fragments
# ===========================================================================

LIVE_READY = '<span data-live="decision_ready">0</span>'
LIVE_STRUCT = '<span data-live="structural_candidates">46</span>'
LIVE_RECORDS = '<span data-live="records">152</span>'
LIVE_VER = '<span data-live="version" data-live-prefix="v">v0.11.0</span>'
LIVE_ASOF = '<span data-live="as_of" data-live-format="date">20 August 2026</span>'


def in_attr(markup: str) -> str:
    """
    The Chinese text on this site lives in a `data-zh="..."` ATTRIBUTE, and
    cbsr.js swaps it into innerHTML on toggle. A bound figure therefore has to
    be written into that attribute too — but an unescaped `data-live="records"`
    inside a double-quoted attribute closes it early and silently corrupts the
    element. (It did, on five pages, before this function existed.)

    The browser decodes &quot; when the attribute is read, so cbsr.js still
    receives well-formed markup to assign.
    """
    return markup.replace('"', "&quot;")


ZH_READY = in_attr(LIVE_READY)
ZH_STRUCT = in_attr(LIVE_STRUCT)
ZH_RECORDS = in_attr(LIVE_RECORDS)
ZH_VER = in_attr(LIVE_VER)
ZH_ASOF = in_attr(LIVE_ASOF)

PROSE_FIXES = [
    # ---- the retracted claim, stated three times in running text ----------
    (
        "index.html",
        '<li data-zh="152 条溯源记录，46 条可作为约束性法律引用">152 sourced records, 46 citable as binding law</li>',
        f'<li data-zh="{ZH_RECORDS} 条溯源记录 · {ZH_STRUCT} 条结构性候选 · '
        f'{ZH_READY} 条可作决策依据">{LIVE_RECORDS} sourced records &middot; '
        f'{LIVE_STRUCT} structural candidates &middot; {LIVE_READY} decision-ready</li>',
        "index citable claim",
    ),
    (
        "index.html",
        "登记册对这个代价是诚实的：152 条溯源记录里，46 条通过完整的可引用门槛，其余的作为逐格待办清单公开，而不是含糊抹平。",
        f"登记册对这个代价是诚实的：{ZH_RECORDS} 条溯源记录里，{ZH_STRUCT} 条通过结构性筛选，"
        f"而今天有 {ZH_READY} 条通过六轴全部门槛、可作决策依据。其余作为逐格待办清单公开，而不是含糊抹平。",
        "index cost paragraph zh",
    ),
    (
        "index.html",
        "The register is honest about what that costs: of 152 sourced records, 46 clear the full citable bar, and the rest are published as a per-cell worklist rather than smoothed over.",
        f"The register is honest about what that costs: of {LIVE_RECORDS} sourced records, "
        f"{LIVE_STRUCT} pass the structural filter and {LIVE_READY} clear all six axes today. "
        f"The rest are published as a per-cell worklist rather than smoothed over.",
        "index cost paragraph en",
    ),
    (
        "about.html",
        "152 条溯源记录里 46 条通过完整的可引用门槛，其余作为逐格待办清单公开。",
        f"{ZH_RECORDS} 条溯源记录里，{ZH_STRUCT} 条通过结构性筛选，{ZH_READY} 条可作决策依据；"
        f"其余作为逐格待办清单公开。",
        "about cost zh",
    ),
    (
        "about.html",
        "Of 152 sourced records, 46 clear the full citable bar and the rest are published as a per-cell worklist.",
        f"Of {LIVE_RECORDS} sourced records, {LIVE_STRUCT} pass the structural filter and "
        f"{LIVE_READY} are decision-ready; the rest are published as a per-cell worklist.",
        "about cost en",
    ),
    (
        "standards.html",
        "<b>支撑记录</b>：全部 152 条记录及其 schema；可引用子集的 46 条；公开的逐格待办清单。",
        f"<b>支撑记录</b>：全部 {ZH_RECORDS} 条记录及其 schema；{ZH_STRUCT} 条结构性候选中 "
        f"{ZH_READY} 条可作决策依据；公开的逐格待办清单。",
        "standards evidence zh",
    ),
    # ---- citation blocks: version and dateline ---------------------------
    (
        "about.html",
        "<i>Cross-Border Stablecoin Register</i> (v0.10.1) [数据集]",
        f"<i>Cross-Border Stablecoin Register</i> ({ZH_VER}) [数据集]",
        "about citation zh",
    ),
    (
        "about.html",
        "<i>Cross-Border Stablecoin Register</i> (v0.10.1) [Data set]",
        f"<i>Cross-Border Stablecoin Register</i> ({LIVE_VER}) [Data set]",
        "about citation en",
    ),
    (
        "about.html",
        "<b>数据截止日</b> &nbsp;2026-06-30",
        f"<b>数据截止日</b> &nbsp;{ZH_ASOF}",
        "about dateline zh",
    ),
    (
        "about.html",
        "<b>Dateline</b> &nbsp;30 June 2026",
        f"<b>Dateline</b> &nbsp;{LIVE_ASOF}",
        "about dateline en",
    ),
    (
        "research.html",
        "<i>Cross-Border Stablecoin Register</i> (v0.10.1) [数据集]",
        f"<i>Cross-Border Stablecoin Register</i> ({ZH_VER}) [数据集]",
        "research citation zh",
    ),
    (
        "research.html",
        "<i>Cross-Border Stablecoin Register</i> (v0.10.1) [Data set]",
        f"<i>Cross-Border Stablecoin Register</i> ({LIVE_VER}) [Data set]",
        "research citation en",
    ),
    (
        "research.html",
        "<b>数据截止日</b> &nbsp;2026-06-30",
        f"<b>数据截止日</b> &nbsp;{ZH_ASOF}",
        "research dateline zh",
    ),
    (
        "research.html",
        "<b>Dateline</b> &nbsp;30 June 2026",
        f"<b>Dateline</b> &nbsp;{LIVE_ASOF}",
        "research dateline en",
    ),
    # ---- corridor page kicker and caption ---------------------------------
    (
        "corridors.html",
        '<p class="kick" data-zh="通道层 &nbsp;·&nbsp; v0.10.1">the corridor layer &nbsp;·&nbsp; v0.10.1</p>',
        f'<p class="kick" data-zh="通道层 &nbsp;·&nbsp; {ZH_VER}">the corridor layer '
        f'&nbsp;·&nbsp; {LIVE_VER}</p>',
        "corridors kicker",
    ),
    (
        "corridors.html",
        "运行于 v0.10.1 快照，数据截至 2026 年 6 月 30 日。每一条通道都由登记册现算得出，没有一处写死。",
        f"运行于 {ZH_VER} 快照，数据截至 {ZH_ASOF}。每一条通道都由登记册现算得出，没有一处写死。",
        "corridors caption zh",
    ),
    (
        "corridors.html",
        "Runs on the v0.10.1 snapshot, as of 30 June 2026. Every corridor is recomputed from the register.",
        f"Runs on the {LIVE_VER} snapshot, as of {LIVE_ASOF}. Every corridor is recomputed from the register.",
        "corridors caption en",
    ),
    # ---- illustrative API samples ------------------------------------------
    # Static by design (they show shape, not state) but a sample that quotes a
    # retracted version teaches the reader the wrong version.
    (
        "agents.html",
        '// compose(origin="EU", destination="US", as_of="2026-06-30")',
        '// compose(origin="EU", destination="US", as_of="2026-08-20")',
        "agents sample call",
    ),
    (
        "agents.html",
        '<span class="s">"2026-06-30"</span>,',
        '<span class="s">"2026-08-20"</span>,',
        "agents sample as_of",
    ),
    (
        "agents.html",
        '<span class="s">"v0.10.1"</span>,',
        '<span class="s">"v0.11.0"</span>,',
        "agents sample version",
    ),
    (
        "standards.html",
        '<span class="s">"2026-06-30"</span>',
        '<span class="s">"2026-08-20"</span>',
        "standards sample as_of",
    ),
]

SECURITY_META = """<meta name="referrer" content="strict-origin-when-cross-origin">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; \
script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; \
font-src https://fonts.gstatic.com; img-src 'self' data: https://www.bestpractices.dev; \
connect-src 'self' https://yunjiefanresearch-hub.github.io; \
form-action https://formsubmit.co; frame-ancestors 'none'; base-uri 'none'">"""

SITE_EXTRA_CSS = """

/* --------------------------------------------------- accessibility ------
   A skip link is the cheapest real accessibility win on a page with a nine-item
   nav: without it a keyboard user tabs the whole masthead on every page. */
.skip{position:absolute;left:-9999px;top:0;z-index:100;background:var(--ink);color:#fff;
  padding:10px 16px;font-family:var(--mono);font-size:13px}
.skip:focus{left:0;color:#fff}

/* The OpenSSF badge is an image of record, not decoration: it must stay legible
   and must not be stretched by the footer's flex layout. */
.badge-ossf{display:inline-flex;align-items:center;line-height:0;flex:none}
.badge-ossf img{display:block;height:20px;width:auto}

/* ----------------------------------------------------- the worklist -----
   Rendered from the register at run time. Each row is one bounded task a new
   contributor can finish alone — which is what OpenSSF `small_tasks` asks for
   and, more importantly, what the reviewer programme actually needs. */
.wl{border:1px solid var(--line-strong);background:var(--surface);margin:20px 0 0}
.wl-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;
  padding:11px 16px;border-bottom:1px solid var(--line);background:var(--surface-2);
  font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--ink-2)}
.wl-count{letter-spacing:0;text-transform:none;color:var(--muted)}
.wl-list{list-style:none;margin:0;padding:0;max-height:420px;overflow:auto}
.wl-list li{display:grid;grid-template-columns:minmax(0,90px) 1fr minmax(0,150px);gap:14px;
  padding:9px 16px;border-top:1px solid var(--line);align-items:baseline}
.wl-list li:first-child{border-top:0}
.wl-cell{font-family:var(--mono);font-size:11px;color:var(--ink)}
.wl-what{font-size:13px;line-height:1.5;color:var(--ink-2);min-width:0}
.wl-need{font-family:var(--mono);font-size:10.5px;color:var(--gate);text-align:right}
.wl-state{padding:14px 16px;margin:0;font-size:13px;color:var(--muted)}
@media(max-width:640px){.wl-list li{grid-template-columns:1fr;gap:3px}
  .wl-need{text-align:left}}
"""

WORKLIST_SECTION = """
  <section id="worklist">
    <p class="kick" data-zh="公开工作清单">the open worklist</p>
    <h2 class="h-sec" data-zh="每一格都是一个有边界、可独立完成的任务。">Every cell is a bounded task one person can finish alone.</h2>
    <p class="lead" data-zh="下面这张表直接读自登记册的 verification_worklist.json。它不是「有空来帮忙」，而是逐格列出：哪个法域、哪个维度、缺的是什么、需要什么语言能力。完成一格，你的名字带 ORCID 进入该记录，并出现在 CITATION.cff 的贡献者名单里。">The table below is read straight from the register's verification_worklist.json. It is not a call for general help: it names, cell by cell, the jurisdiction, the dimension, exactly what is missing, and the language needed. Complete one and your name enters that record with your ORCID, and appears in CITATION.cff.</p>

    <div class="wl">
      <div class="wl-h">
        <span data-zh="待核验格位">cells awaiting verification</span>
        <span class="wl-count" id="wl-count">—</span>
      </div>
      <ul class="wl-list" id="wl-list"></ul>
      <p class="wl-state" id="wl-state" data-zh="正在从登记册读取…">Reading from the register…</p>
    </div>

    <p class="meta" data-zh="同一份清单也可以由 agent 通过 MCP 工具 verification_worklist() 读取。">The same list is readable by an agent through the MCP tool verification_worklist().</p>
  </section>
"""

SITE_DEPLOY = """# Deploying cbsr.io

Static site. No build step, no dependencies, no bundler.

## Local

    cd cbsr.io
    python3 -m http.server 8080
    # open http://localhost:8080

`file://` will not work: `assets/cbsr-live.js` fetches the register over
`fetch()`, and the Content-Security-Policy meta tag needs an http origin.

## Pointing at a register

Figures on every page are bound at run time from the register's `api/meta.json`.
By default the binder reads:

    https://yunjiefanresearch-hub.github.io/cross-border-stablecoin-register/api

To point somewhere else, add this before the `cbsr-live.js` tag on each page:

    <script>window.__CBSR_REGISTER_API__ = "https://.../api";</script>

If you change the origin, also update `connect-src` in the CSP meta tag,
otherwise the browser will block the fetch and every page will fall back to its
build-time figures (labelled as such — see below).

## What happens when the register is unreachable

The page marks itself `data-cbsr-live="offline"` and every `[data-live-stamp]`
element says "build-time snapshot — figures may be stale". The figures in the
markup are the fallback. A stale figure that says it is stale is acceptable; an
unlabelled wrong one is not, and that distinction is the reason this file exists.

## Verifying before you publish

    node tools/test-site.mjs

## Publishing

`.github/workflows/deploy.yml` publishes to GitHub Pages on push. `sync-shell.py`
propagates the shared header and footer across pages; run it after editing either.
"""

MAPPER_META = """    <meta name="referrer" content="strict-origin-when-cross-origin">
"""

DATA_IMPORT_NOTE = """/* The bundled register snapshot used to live here as a hand-pasted object
   literal. It drifted: the mapper shipped register v0.10.1 and published
   `citable_count: 46` for weeks after the register had retracted that number
   (v0.11.0 reports 0 decision-ready records; 46 is only the count of STRUCTURAL
   CANDIDATES). The literal is now generated, and `npm run check` fails the build
   if the committed snapshot and the register disagree.

     python3 tools/build_mapper_snapshot.py \\
       --register ../cross-border-stablecoin-register --out src/data.snapshot.js

   The generated module also keeps the legacy `citable` key, REDEFINED to the
   strict six-axis gate, so every one of the ~20 legacy call sites below reports
   the honest number without needing to be rewritten one at a time. */"""

MAPPER_IMPORTS = """import { DATA } from "./data.snapshot.js";
import EvaluateView, { EVALUATE_VIEW_CSS } from "./EvaluateView.jsx";
import { EvidenceLedger, EVIDENCE_AXES_CSS } from "./EvidenceAxes.jsx";
"""

LIVE_SYNC_GATE = """          /* The live-sync path carried the same too-loose gate the bundled
             snapshot did: four axes, not six. A record that is tier1_legal,
             in force, and read against resolution text is a STRUCTURAL
             CANDIDATE — it is not yet something the register will project as
             citable current law. Two more axes have to pass first: the source
             must be official, the review must be current, and an independent
             second reviewer must have reconciled it.

             If the fetched projection lacks those three fields they read as
             undefined and `decision_ready` is false. That direction of failure
             is the safe one, and it is deliberate. */
          rec.structural_candidate =
            rec.claim_class === "tier1_legal" &&
            rec.status === "in_force" &&
            rec.evidence_tier === "resolution_text";
          rec.decision_ready =
            rec.structural_candidate &&
            rec.source_disposition === "official" &&
            rec.review_status === "current" &&
            rec.review_stage === "reconciled";
          rec.citable = rec.decision_ready;"""

LIVE_SYNC_COUNTS = """        DATA.meta.structural_candidate_count = DATA.records.filter((r) => r.structural_candidate).length;
        DATA.meta.decision_ready_count = DATA.records.filter((r) => r.decision_ready).length;
        DATA.meta.citable_count = DATA.meta.decision_ready_count;"""

VIEW_DISPATCH = """      {/* The lead view. The other six tour the register's layers; this one is
          the only surface that takes a proposed agent action and returns a
          decision, a receipt, and the evidence the decision rested on. */}
      {view === "evaluate" && <EvaluateView DATA={DATA} ui={ui} />}

"""

DEMO_NOTE = """// NOTE: a public deployment should ship with DEMO_MODE off. A register that
// defaults to demo mode is telling the reader it is a demo. The deterministic
// evaluate view carries the front page without any model call, so the AI branch
// is no longer load-bearing — see DEPLOY.md.
"""

INV_EXTRACT_OLD = """function extract(name) {
  const line = src.split("\\n").find((l) => l.startsWith(`const ${name} = `));
  if (!line) throw new Error(`invariant checker: could not find "const ${name} = " in src/App.jsx`);
  return JSON.parse(line.replace(new RegExp(`^const ${name} = `), "").replace(/;\\s*$/, ""));
}

const DATA = extract("DATA");
const COMPUTE = extract("COMPUTE");"""

INV_EXTRACT_NEW = """function extract(name) {
  const line = src.split("\\n").find((l) => l.startsWith(`const ${name} = `));
  if (!line) throw new Error(`invariant checker: could not find "const ${name} = " in src/App.jsx`);
  return JSON.parse(line.replace(new RegExp(`^const ${name} = `), "").replace(/;\\s*$/, ""));
}

/* DATA no longer lives in App.jsx. It is generated from the register into
   src/data.snapshot.js by tools/build_mapper_snapshot.py, precisely so that the
   figure this checker guards cannot be edited by hand into disagreeing with the
   register. Read it from there. */
function extractSnapshot() {
  const text = fs.readFileSync(SNAPSHOT, "utf8");
  const body = text.split("export const DATA = ")[1];
  if (!body) throw new Error("invariant checker: src/data.snapshot.js has no DATA export");
  return JSON.parse(body.replace(/;\\s*export default DATA;\\s*$/, "").trim());
}

const DATA = extractSnapshot();
const COMPUTE = extract("COMPUTE");"""

INV_COUNTS_OLD = """const actualRecords = DATA.records.length;
const actualCitable = DATA.records.filter((r) => r.citable === true).length;

if (DATA.meta.record_count !== actualRecords)
  fail(`meta.record_count says ${DATA.meta.record_count}, data holds ${actualRecords}`);
else pass(`record_count matches data (${actualRecords})`);

if (DATA.meta.citable_count !== actualCitable)
  fail(`meta.citable_count says ${DATA.meta.citable_count}, data holds ${actualCitable}`);
else pass(`citable_count matches data (${actualCitable})`);"""

INV_COUNTS_NEW = """const actualRecords = DATA.records.length;
const actualReady = DATA.records.filter((r) => r.decision_ready === true).length;
const actualStructural = DATA.records.filter((r) => r.structural_candidate === true).length;

if (DATA.meta.record_count !== actualRecords)
  fail(`meta.record_count says ${DATA.meta.record_count}, data holds ${actualRecords}`);
else pass(`record_count matches data (${actualRecords})`);

if (DATA.meta.decision_ready_count !== actualReady)
  fail(`meta.decision_ready_count says ${DATA.meta.decision_ready_count}, data holds ${actualReady}`);
else pass(`decision_ready_count matches data (${actualReady})`);

if (DATA.meta.structural_candidate_count !== actualStructural)
  fail(
    `meta.structural_candidate_count says ${DATA.meta.structural_candidate_count}, ` +
      `data holds ${actualStructural}`
  );
else pass(`structural_candidate_count matches data (${actualStructural})`);

/* ── The invariant this project needed and did not have ──────────────────────
   The mapper shipped `citable_count: 46` for weeks after the register had
   retracted it: 46 is the count of STRUCTURAL CANDIDATES, and the number of
   records the register will project as citable current law was 0. The defect
   was possible because one boolean, `citable`, stood for two different ideas.

   So: the legacy key survives for compatibility, but it must equal the STRICT
   gate. If anyone ever redefines it back to the loose one, the build stops. */
if (DATA.meta.citable_count !== undefined && DATA.meta.citable_count !== actualReady)
  fail(
    `legacy meta.citable_count says ${DATA.meta.citable_count} but the strict gate ` +
      `holds ${actualReady}. That key must mean decision-ready, never structural candidates.`
  );
else pass(`legacy citable_count is pinned to the strict gate (${actualReady})`);

const looseCitable = DATA.records.filter((r) => r.citable === true).length;
if (looseCitable !== actualReady)
  fail(
    `${looseCitable} records carry citable=true but only ${actualReady} are decision-ready`
  );
else pass(`per-record citable matches decision_ready (${actualReady})`);

if (actualStructural < actualReady)
  fail("structural candidates cannot be fewer than decision-ready records");
else pass("structural candidates >= decision-ready (gate ordering holds)");"""

MAPPER_DEPLOY = """# Deploying the CBSR mapper

## Local

    npm install
    npm run dev        # http://localhost:5173
    npm run check      # invariants + snapshot drift
    npm run build

## The snapshot is generated, not pasted

`src/data.snapshot.js` is produced from the register and must not be hand-edited:

    python3 tools/build_mapper_snapshot.py \\
      --register ../cross-border-stablecoin-register \\
      --out src/data.snapshot.js

`npm run check` runs the same command with `--check` and exits 3 if the committed
snapshot and the register disagree. That gate is the point: the mapper shipped a
number the register had already retracted, and a generated-plus-verified snapshot
removes that whole class of defect rather than the one instance.

The generator also cross-checks its own gate against the register's reported
counts and aborts with `GATE DRIFT` if they diverge, so silently widening the
filter on either side fails loudly.

## Two numbers, never one

`meta.decision_ready_count` is the public gate (0 on the 2026-08-20 snapshot).
`meta.structural_candidate_count` is an inventory filter (46). The legacy
`citable` key is kept but redefined to the strict gate, so old call sites report
the honest number. Do not reintroduce a single "citable" figure into the UI.

## DEMO_MODE and the AI branch

`DEMO_MODE` should be `false` for a public deployment. The evaluate view is fully
deterministic: `src/policyMirror.js` reproduces the Python engine's gate order and
calls no model and no network. If you keep the AI branch, it must never be able
to write `source`, `pinpoint`, `evidence_tier`, or any gate field — CHARTER.md
commits the project to no tool inferring a citation.

## Pointing at a live register

Set `REGISTER_API` at the top of `src/App.jsx` to a deployed `api/` directory.
Make sure it serves `api/records.json`, which carries `source_disposition`,
`review_status` and `review_stage`; without those three the strict gate reads
undefined and every record is treated as not decision-ready. That failure
direction is safe, but it will hide real state.
"""


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    site = build_site()
    mapper = build_mapper()

    if problems:
        print("PATCH PROBLEMS:")
        for p in problems:
            print("  -", p)
        return 1

    print("built:", site, "and", mapper)
    return 0


if __name__ == "__main__":
    sys.exit(main())
