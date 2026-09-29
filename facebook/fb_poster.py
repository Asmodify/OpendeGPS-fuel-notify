#!/usr/bin/env python3
"""Open Development Facebook page auto-poster.

Reads the post queue in posts.json and publishes the posts that are due, approved
and not yet posted, through the Meta Graph API. Standard library only.

    python facebook/fb_poster.py list            # queue status
    python facebook/fb_poster.py check           # verify the page token
    python facebook/fb_poster.py run             # dry run: show what would be posted
    python facebook/fb_poster.py run --live      # really post
    python facebook/fb_poster.py preview         # write preview.html for review

Environment:
    FB_PAGE_ID         page id (default: the id in posts.json)
    FB_PAGE_TOKEN      Page access token with pages_manage_posts + pages_read_engagement
    FB_GRAPH_VERSION   Graph API version (default v23.0)
    FB_LIVE=1          same as --live
"""

import argparse
import html
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
QUEUE = HERE / "posts.json"
UB = timezone(timedelta(hours=8))  # Ulaanbaatar time
GRAPH = "https://graph.facebook.com"


def load_queue(path=QUEUE):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_queue(queue, path=QUEUE):
    tmp = Path(str(path) + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(queue, f, ensure_ascii=False, indent=2)
        f.write("\n")
    tmp.replace(path)


def parse_time(value):
    """'2026-10-05 10:00' in Ulaanbaatar time -> aware datetime."""
    return datetime.strptime(value, "%Y-%m-%d %H:%M").replace(tzinfo=UB)


def post_state(post, now):
    if post.get("posted_id"):
        return "posted"
    if not post.get("approved"):
        return "draft"
    return "due" if parse_time(post["publish_at"]) <= now else "scheduled"


def due_posts(queue, now, limit):
    """Approved, unposted posts whose time has come, oldest first, at most `limit`."""
    due = [p for p in queue["posts"] if post_state(p, now) == "due"]
    due.sort(key=lambda p: parse_time(p["publish_at"]))
    return due[:limit]


def compose_message(post, queue):
    text = post["text"].strip()
    tags = post.get("hashtags", queue.get("default_hashtags", []))
    if tags:
        text += "\n\n" + " ".join(tags)
    return text


# --- Graph API -------------------------------------------------------------

class GraphError(Exception):
    pass


def graph_request(method, path, token, version, fields=None, files=None):
    url = f"{GRAPH}/{version}/{path.lstrip('/')}"
    fields = dict(fields or {})
    fields["access_token"] = token
    headers = {}
    data = None
    if method == "GET":
        url += "?" + urllib.parse.urlencode(fields)
    elif files:
        data, content_type = encode_multipart(fields, files)
        headers["Content-Type"] = content_type
    else:
        data = urllib.parse.urlencode(fields).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            err = json.loads(body)["error"]
            msg = f"{err.get('type')} {err.get('code')}: {err.get('message')}"
        except (ValueError, KeyError):
            msg = body[:500]
        raise GraphError(f"HTTP {e.code} {msg}") from None


def encode_multipart(fields, files):
    boundary = uuid.uuid4().hex
    out = bytearray()
    for name, value in fields.items():
        out += f"--{boundary}\r\n".encode()
        out += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        out += str(value).encode() + b"\r\n"
    for name, path in files.items():
        path = Path(path)
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        out += f"--{boundary}\r\n".encode()
        out += (f'Content-Disposition: form-data; name="{name}"; '
                f'filename="{path.name}"\r\n').encode()
        out += f"Content-Type: {ctype}\r\n\r\n".encode()
        out += path.read_bytes() + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def publish(post, queue, page_id, token, version):
    """Publish one post. Returns the new Facebook post id."""
    message = compose_message(post, queue)
    image = post.get("image")
    if image:
        if image.startswith("http"):
            res = graph_request("POST", f"{page_id}/photos", token, version,
                                {"url": image, "caption": message})
        else:
            res = graph_request("POST", f"{page_id}/photos", token, version,
                                {"caption": message}, files={"source": HERE / image})
        return res.get("post_id") or res["id"]
    fields = {"message": message}
    if post.get("link"):
        fields["link"] = post["link"]
    return graph_request("POST", f"{page_id}/feed", token, version, fields)["id"]


# --- commands ----------------------------------------------------------------

def settings(queue):
    page_id = os.environ.get("FB_PAGE_ID") or queue["page_id"]
    token = os.environ.get("FB_PAGE_TOKEN", "")
    version = os.environ.get("FB_GRAPH_VERSION", "v23.0")
    return page_id, token, version


def cmd_list(queue, now, _args):
    counts = {}
    for p in queue["posts"]:
        state = post_state(p, now)
        counts[state] = counts.get(state, 0) + 1
        print(f"{p['id']:<24} {p['publish_at']}  {state:<9} {p['title']}")
    print("\n" + ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())))
    return 0


def cmd_check(queue, _now, _args):
    page_id, token, version = settings(queue)
    if not token:
        print("FB_PAGE_TOKEN is not set.")
        return 1
    page = graph_request("GET", page_id, token, version, {"fields": "id,name"})
    print(f"Token works for page: {page['name']} ({page['id']})")
    return 0


def cmd_run(queue, now, args):
    page_id, token, version = settings(queue)
    live = args.live or os.environ.get("FB_LIVE") == "1"
    if live and not token:
        print("Live run needs FB_PAGE_TOKEN; nothing posted.")
        return 1
    todo = due_posts(queue, now, args.max)
    if not todo:
        print("Nothing due.")
        return 0
    failed = 0
    for post in todo:
        if not live:
            print(f"[dry run] would post {post['id']}:\n{compose_message(post, queue)}\n")
            continue
        try:
            post_id = publish(post, queue, page_id, token, version)
        except GraphError as e:
            failed += 1
            print(f"FAILED {post['id']}: {e}")
            continue
        post["posted_id"] = post_id
        post["posted_at"] = datetime.now(UB).strftime("%Y-%m-%d %H:%M")
        save_queue(queue)
        print(f"Posted {post['id']} -> https://www.facebook.com/{post_id}")
    return 1 if failed else 0


def cmd_preview(queue, now, _args):
    cards = []
    for p in sorted(queue["posts"], key=lambda p: p["publish_at"]):
        state = post_state(p, now)
        body = html.escape(compose_message(p, queue)).replace("\n", "<br>")
        cards.append(
            f'<article><header><b>{html.escape(p["publish_at"])}</b>'
            f'<span class="s {state}">{state}</span></header>'
            f'<h2>{html.escape(p["title"])}</h2><p>{body}</p></article>')
    out = HERE / "preview.html"
    out.write_text(
        "<!doctype html><meta charset=utf-8><title>Post queue</title>"
        "<style>body{font:15px system-ui;max-width:640px;margin:24px auto;padding:0 16px}"
        "article{border:1px solid #ccc;border-radius:8px;padding:12px 16px;margin:12px 0}"
        "header{display:flex;justify-content:space-between}.s{font-size:12px}"
        "h2{font-size:16px;margin:8px 0}</style>" + "".join(cards),
        encoding="utf-8")
    print(f"Wrote {out}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sub.add_parser("check")
    sub.add_parser("preview")
    run = sub.add_parser("run")
    run.add_argument("--live", action="store_true", help="really post (default: dry run)")
    run.add_argument("--max", type=int, default=1, help="max posts per run (default 1)")
    args = ap.parse_args(argv)
    queue = load_queue()
    now = datetime.now(UB)
    cmds = {"list": cmd_list, "check": cmd_check, "run": cmd_run, "preview": cmd_preview}
    try:
        return cmds[args.cmd](queue, now, args)
    except GraphError as e:
        print(f"Graph API error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
