"""python -m unittest facebook/test_fb_poster.py"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fb_poster as fb  # noqa: E402


def queue(*posts):
    return {"page_id": "123", "default_hashtags": ["#A"], "posts": list(posts)}


def post(pid, at, approved=True, **extra):
    return {"id": pid, "publish_at": at, "title": pid, "approved": approved,
            "text": "hello", **extra}


class DueTests(unittest.TestCase):
    now = fb.parse_time("2026-10-10 12:00")

    def test_only_approved_unposted_past_posts(self):
        q = queue(post("late", "2026-10-09 10:00"),
                  post("draft", "2026-10-09 10:00", approved=False),
                  post("done", "2026-10-08 10:00", posted_id="1_2"),
                  post("future", "2026-10-11 10:00"))
        self.assertEqual([p["id"] for p in fb.due_posts(q, self.now, 5)], ["late"])

    def test_limit_takes_oldest_first(self):
        q = queue(post("b", "2026-10-09 10:00"), post("a", "2026-10-08 10:00"))
        self.assertEqual([p["id"] for p in fb.due_posts(q, self.now, 1)], ["a"])

    def test_hashtags(self):
        q = queue()
        self.assertEqual(fb.compose_message(post("x", "2026-10-09 10:00"), q), "hello\n\n#A")
        own = post("x", "2026-10-09 10:00", hashtags=[])
        self.assertEqual(fb.compose_message(own, q), "hello")


class PublishTests(unittest.TestCase):
    def test_text_post_goes_to_feed(self):
        with mock.patch.object(fb, "graph_request", return_value={"id": "123_9"}) as req:
            pid = fb.publish(post("x", "2026-10-09 10:00"), queue(), "123", "tok", "v23.0")
        self.assertEqual(pid, "123_9")
        self.assertEqual(req.call_args.args[1], "123/feed")
        self.assertEqual(req.call_args.args[4]["message"], "hello\n\n#A")

    def test_image_url_goes_to_photos(self):
        p = post("x", "2026-10-09 10:00", image="https://example.com/a.jpg")
        with mock.patch.object(fb, "graph_request",
                               return_value={"id": "5", "post_id": "123_5"}) as req:
            self.assertEqual(fb.publish(p, queue(), "123", "tok", "v23.0"), "123_5")
        self.assertEqual(req.call_args.args[1], "123/photos")

    def test_multipart_contains_fields_and_file(self):
        body, ctype = fb.encode_multipart({"caption": "сайн"}, {"source": __file__})
        self.assertIn("boundary=", ctype)
        self.assertIn("сайн".encode(), body)
        self.assertIn(b'filename="test_fb_poster.py"', body)


class QueueFileTests(unittest.TestCase):
    def test_real_queue_is_valid(self):
        q = fb.load_queue()
        ids = [p["id"] for p in q["posts"]]
        self.assertEqual(len(ids), len(set(ids)))
        for p in q["posts"]:
            fb.parse_time(p["publish_at"])
            self.assertTrue(p["text"].strip())
            self.assertLessEqual(len(fb.compose_message(p, q)), 63206)


if __name__ == "__main__":
    unittest.main()
