"""An address that has no page is redirected with a marker (docs/ui-foundations.md, UI-008): /observability/<unknown> and
/system/<unknown> carry ?redirected_from=<the path asked for>, the moves that are not mistakes carry none, and the marker cannot
hold markup or a long text.

API_BASE_URL is an instance of tests/config/CH_HOSTS.local.hcl.
"""

from __future__ import annotations

import os

import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})


def redirect(path: str) -> requests.Response:
    return SESSION.get(BASE_URL + path, allow_redirects=False, timeout=30)


def test_an_address_that_has_no_page_is_redirected_with_a_marker():
    for path, expected in (
        ("/observability/nope", "traces?redirected_from=%2Fobservability%2Fnope"),
        ("/observability/nope/deeper?x=1", "../traces?x=1&redirected_from=%2Fobservability%2Fnope%2Fdeeper"),
        ("/system/no-such-section", "../system?redirected_from=%2Fsystem%2Fno-such-section"),
        ("/system/no-such-section?host_id=local", "../system?host_id=local&redirected_from=%2Fsystem%2Fno-such-section"),
    ):
        response = redirect(path)
        assert response.status_code == 302, (path, response.status_code)
        assert response.headers["Location"] == expected, (path, response.headers["Location"])


def test_a_move_that_is_not_a_mistake_has_no_marker():
    for path, expected in (("/observability", "observability/traces"), ("/observability/", "traces"), ("/observability?x=1", "observability/traces?x=1")):
        response = redirect(path)
        assert response.status_code == 302 and response.headers["Location"] == expected, (path, response.headers.get("Location"))
    assert "redirected_from" not in redirect("/explorer/").headers["Location"]


def test_the_marker_cannot_carry_markup_or_a_long_text():
    from urllib.parse import unquote

    response = redirect("/observability/" + "<script>" + "/".join(["a" * 20] * 10))
    location = response.headers["Location"]
    assert "<" not in location and ">" not in location, location
    marker = location.split("redirected_from=", 1)[1]
    # The path is cut to 200 characters before it is encoded.
    assert len(unquote(marker)) == 200, len(unquote(marker))
    assert unquote(marker).startswith("/observability/<script>")
