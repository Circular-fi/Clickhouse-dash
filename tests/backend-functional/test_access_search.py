"""The Resource Search of the PDP for the lists of databases (docs/access.md, "Resource Search").

Instance (the tests skip without it; in the official run, CHDASH_REQUIRE_FIXTURES=1 makes a missing one a failure):
- ACCESS_SEARCH_BASE_URL: tests/config/access.search.hcl (the compose service chdash_access_search): access.pdp.search = true, two hosts.
- ACCESS_SEARCH_PDP_URL: the fake PDP of that instance (compose service access_pdp_search). Its metadata announces the endpoint
  search_resource_endpoint. The fake search ignores the chain and the subject, like a PDP that does not read properties.ancestors.

The default instance of test_access.py has no search: its PDP gives no metadata, so the lists use the evaluations.
"""
from __future__ import annotations

import os
import time

import pytest
import requests

from identity_tokens import Ed25519Key, make_token

BASE_URL = os.environ.get("ACCESS_SEARCH_BASE_URL", "").rstrip("/")
PDP_URL = os.environ.get("ACCESS_SEARCH_PDP_URL", "").rstrip("/")
needs_search = pytest.mark.skipif(not (BASE_URL and PDP_URL), reason="ACCESS_SEARCH_BASE_URL is not set")

ED25519 = Ed25519Key(bytes(range(1, 33)))
ISSUER = "https://access.test"
AUDIENCE = "db"
CACHE_TTL = 1.0
SESSION = requests.Session()
SERVICE = {"type": "service", "id": AUDIENCE}
SEARCH_PATH = "/access/v1/search/resource"
OPTIONS = "/.well-known/procurauth/resources"


def token(sub: str) -> str:
    now = int(time.time())
    return make_token(ED25519, {"iss": ISSUER, "sub": sub, "aud": AUDIENCE, "iat": now - 5, "exp": now + 240})


def call(path: str, sub: str) -> requests.Response:
    return SESSION.get(f"{BASE_URL}{path}", headers={"X-Identity-Token": token(sub)}, timeout=30)


def pdp(path: str, body: dict | None = None) -> dict:
    response = SESSION.get(f"{PDP_URL}{path}", timeout=10) if body is None else SESSION.post(f"{PDP_URL}{path}", json=body, timeout=10)
    response.raise_for_status()
    return response.json()


def answer(**order) -> None:
    """Sets the answers of the fake PDP, then waits for the cache of the server to forget the former ones."""
    pdp("/control/answer", order)
    time.sleep(CACHE_TTL + 0.2)


def received() -> list[dict]:
    return pdp("/control/received")["requests"]


def searches() -> list[dict]:
    return [r["body"] for r in received() if r["path"] == SEARCH_PATH]


def database_questions(subject: str) -> list[dict]:
    """The evaluations that name a database resource for `subject`."""
    out = []
    for request in received():
        if request["path"] == SEARCH_PATH:
            continue
        body = request["body"]
        items = [body] if request["path"].endswith("/evaluation") else [
            {"subject": i.get("subject", body.get("subject")), "action": i.get("action", body.get("action")), "resource": i.get("resource", body.get("resource"))}
            for i in body["evaluations"]]
        out += [i for i in items if i["subject"]["id"] == subject and i["resource"]["type"] == "database"]
    return out


@pytest.fixture(autouse=True)
def fresh_pdp():
    if BASE_URL and PDP_URL:
        pdp("/control/reset", {})
        time.sleep(CACHE_TTL + 0.2)
    yield
    if BASE_URL and PDP_URL:
        pdp("/control/reset", {})


@needs_search
def test_the_options_route_uses_one_search_for_each_action_and_keeps_the_databases_of_the_host():
    # The person holds explorer.read on one database of local, so the host is visible (the match subtree) and a grant on the host is not
    # there (the question of the host with the match node is false). The fake search returns the ids of any host: chdash_ui exists on
    # local, the others do not.
    answer(default=False, allow=["explorer.read@host:local/database:chdash_ui"],
           search={"by_action": {"explorer.read": [["chdash_ui", "no_such_database"], ["another_host_database"]]}})
    response = call(f"{OPTIONS}?parent=host%3Alocal&type=database", "search-tenant")
    assert response.status_code == 200, response.text
    assert [i["id"] for i in response.json()["items"]] == ["chdash_ui"], response.text
    # One search for each action of the type database, with the chain of the host. No evaluation names a database.
    sent = searches()
    assert sorted({s["action"]["name"] for s in sent}) == ["explorer.read", "query.run.read", "query.run.write"], sent
    for s in sent:
        assert s["subject"] == {"type": "user", "id": "search-tenant"}
        assert s["resource"]["type"] == "database" and "id" not in s["resource"]
        assert s["resource"]["properties"]["ancestors"] == [SERVICE, {"type": "host", "id": "local"}]
    assert database_questions("search-tenant") == []


@needs_search
def test_the_catalog_uses_one_search_and_lists_the_databases_that_it_returns():
    answer(default=False, allow=["explorer.read@host:local/database:chdash_ui"],
           search={"by_action": {"explorer.read": [["chdash_ui", "no_such_database"]]}})
    response = call("/api/explorer/catalog?host_id=local", "search-catalog")
    assert response.status_code == 200, response.text
    # The fake PDP also returns a database that does not exist: the intersection with the catalog never adds it.
    assert response.json()["databases"] == ["chdash_ui"], response.text[:300]
    sent = searches()
    assert [s["action"]["name"] for s in sent] == ["explorer.read"], sent
    assert database_questions("search-catalog") == []
    # A request that names a database asks the PDP with an evaluation (the match node), as without the search.
    named = call("/api/explorer/catalog?host_id=local&database=chdash_ui", "search-catalog")
    assert named.status_code == 200, named.text[:300]
    assert any(q["resource"]["id"] == "chdash_ui" for q in database_questions("search-catalog"))


@needs_search
def test_a_grant_on_the_host_needs_no_search_and_lists_every_database():
    answer(default=False, allow=["explorer.read@host:local"], search={"pages": [["chdash_ui"]]})
    response = call("/api/explorer/catalog?host_id=local", "search-host-grant")
    assert response.status_code == 200, response.text
    assert "chdash_ui" in response.json()["databases"], response.text[:300]
    assert searches() == []


@needs_search
def test_a_failed_search_falls_back_to_the_evaluations():
    # The search endpoint answers 500: the lists still work, from the evaluations of each database (never an empty list, never 503).
    answer(default=False, allow=["explorer.read@host:local/database:chdash_ui"], search={"status": 500})
    response = call("/api/explorer/catalog?host_id=local", "search-fallback")
    assert response.status_code == 200, response.text
    assert response.json()["databases"] == ["chdash_ui"], response.text[:300]
    assert searches(), "the search was tried"
    assert any(q["resource"]["id"] == "chdash_ui" for q in database_questions("search-fallback"))
    options = call(f"{OPTIONS}?parent=host%3Alocal&type=database", "search-fallback")
    assert options.status_code == 200 and [i["id"] for i in options.json()["items"]] == ["chdash_ui"], options.text


@needs_search
def test_a_result_that_a_bound_cuts_falls_back_to_the_evaluations():
    # More than 10 pages: ChDash does not trust the beginning of the set. The evaluations decide.
    pages = [[f"db_{i}"] for i in range(12)]
    answer(default=False, allow=["explorer.read@host:local/database:chdash_ui"], search={"by_action": {"explorer.read": pages}})
    response = call("/api/explorer/catalog?host_id=local", "search-cut")
    assert response.status_code == 200 and response.json()["databases"] == ["chdash_ui"], response.text[:300]
    assert any(q["resource"]["id"] == "chdash_ui" for q in database_questions("search-cut"))
