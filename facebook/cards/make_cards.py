#!/usr/bin/env python3
"""Render a 1080x1080 branded image card for every post in posts.json.

    python facebook/cards/make_cards.py            # all posts
    python facebook/cards/make_cards.py 2026-10-07-drivers

Needs chrome-headless-shell for an exact 1080x1080 viewport (full Chrome's headless
mode cuts the bottom off). Get it with `npx @puppeteer/browsers install chrome-headless-shell`
and point CHROME at the binary if it isn't found automatically.
Re-run after changing a post's card, the phone number, or the design below.
"""

import glob
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import fb_poster as fb  # noqa: E402

CSS = """
@font-face{font-family:Onest;font-weight:900;src:url(fonts/Onest-900.ttf)}
@font-face{font-family:Manrope;font-weight:700;src:url(fonts/Manrope-700.ttf)}
@font-face{font-family:Manrope;font-weight:800;src:url(fonts/Manrope-800.ttf)}
:root{--coal:#141619;--coal2:#1f2328;--hivis:#ff6b1a;--white:#f4f5f6;--grey:#9aa1a9}
*{margin:0;box-sizing:border-box}
html,body{width:1080px;height:1080px;overflow:hidden}
body{background:
  radial-gradient(circle at 85% 12%,#2a2f35 0,transparent 45%),
  repeating-linear-gradient(115deg,rgba(255,255,255,.018) 0 2px,transparent 2px 9px),
  var(--coal);
  color:var(--white);font-family:Manrope,sans-serif;display:flex;flex-direction:column}
.main{flex:1;padding:84px 84px 0;display:flex;flex-direction:column;gap:44px}
.kicker{font:700 26px Manrope;letter-spacing:.16em;text-transform:uppercase;color:var(--hivis);
  display:flex;align-items:center;gap:18px}
.kicker:before{content:"";width:56px;height:8px;background:var(--hivis)}
h1{font:900 118px/1 Onest;letter-spacing:-.02em;text-wrap:balance;max-width:900px}
h1.long{font-size:96px}
ul{list-style:none;display:grid;gap:22px;margin-top:auto;padding-bottom:56px}
li{font:800 44px/1.2 Manrope;display:flex;gap:24px;align-items:baseline}
li:before{content:"";flex:none;width:22px;height:22px;background:var(--hivis);transform:translateY(-4px)}
.fill{border:3px dashed var(--hivis);color:var(--hivis);padding:0 10px;border-radius:6px}
.bar{height:150px;background:var(--coal2);display:flex;align-items:center;justify-content:space-between;
  padding:0 84px;position:relative}
.bar:before{content:"";position:absolute;left:0;right:0;top:0;height:14px;
  background:repeating-linear-gradient(135deg,var(--hivis) 0 22px,var(--coal) 22px 44px)}
.brand{font:900 34px Onest;letter-spacing:.02em;line-height:1}
.brand small{display:block;font:700 18px Manrope;letter-spacing:.2em;color:var(--grey);margin-top:10px}
.phone{font:900 46px Onest;color:var(--white);text-align:right}
.phone small{display:block;font:700 18px Manrope;letter-spacing:.2em;color:var(--grey);margin-bottom:8px}
"""


def mark_fill(text):
    text = html.escape(text)
    return re.sub(r"\[\[(.+?)\]\]", r'<span class="fill">\1</span>', text)


def card_html(post, queue):
    card = post["card"]
    phone = queue.get("contact", {}).get("phone")
    phone_html = html.escape(phone) if phone else '<span class="fill">УТАС</span>'
    headline = card["headline"]
    lines = "".join(f"<li>{mark_fill(l)}</li>" for l in card["lines"])
    return f"""<!doctype html><meta charset="utf-8"><style>{CSS}</style>
<div class="main">
  <div class="kicker">{html.escape(post.get("series", ""))}</div>
  <h1 class="{'long' if len(headline) > 16 else ''}">{mark_fill(headline)}</h1>
  <ul>{lines}</ul>
</div>
<div class="bar">
  <div class="brand">OPEN DEVELOPMENT<small>НҮҮРС ТЭЭВЭР</small></div>
  <div class="phone"><small>ЗАЛГАХ</small>{phone_html}</div>
</div>"""


def find_chrome():
    candidates = [os.environ.get("CHROME"), "chrome-headless-shell", "headless_shell"]
    candidates += sorted(glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell"))
    for c in candidates:
        if c and (shutil.which(c) or Path(c).exists()):
            return shutil.which(c) or c
    sys.exit("chrome-headless-shell not found; set CHROME=/path/to/chrome-headless-shell")


def render(post, queue, chrome):
    out = HERE / f"{post['id']}.png"
    with tempfile.NamedTemporaryFile("w", suffix=".html", dir=HERE, delete=False,
                                     encoding="utf-8") as f:
        f.write(card_html(post, queue))
        page = Path(f.name)
    try:
        subprocess.run([chrome, "--no-sandbox", "--disable-gpu",
                        "--hide-scrollbars", "--force-device-scale-factor=1",
                        "--window-size=1080,1080", f"--screenshot={out}",
                        "--virtual-time-budget=3000", page.as_uri()],
                       check=True, capture_output=True, timeout=60)
    finally:
        page.unlink()
    print(f"Wrote {out.relative_to(HERE.parent)}")


def main(ids):
    queue = fb.load_queue()
    chrome = find_chrome()
    for post in queue["posts"]:
        if "card" in post and (not ids or post["id"] in ids):
            render(post, queue, chrome)


if __name__ == "__main__":
    main(sys.argv[1:])
