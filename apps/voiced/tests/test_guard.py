from voiced.guard import given_token, refusal

TOKEN = "t" * 43
HOST = {"host": "127.0.0.1:4752"}


def test_lets_the_host_in_with_a_bearer_or_subprotocol_token():
    assert refusal({**HOST, "authorization": f"Bearer {TOKEN}"}, TOKEN, 4752) is None
    protocols = f"localdot.v1, localdot.token.{TOKEN}"
    assert refusal({"host": "localhost:4752", "sec-websocket-protocol": protocols}, TOKEN, 4752) is None


def test_refuses_a_wrong_token_a_browser_origin_or_a_foreign_host():
    assert refusal({**HOST, "authorization": "Bearer nope"}, TOKEN, 4752).status == 401
    assert refusal(HOST, TOKEN, 4752).close_code == 4401
    origin = {**HOST, "authorization": f"Bearer {TOKEN}", "origin": "http://127.0.0.1:4753"}
    assert refusal(origin, TOKEN, 4752).status == 403
    rebound = {"host": "attacker.example:4752", "authorization": f"Bearer {TOKEN}"}
    assert refusal(rebound, TOKEN, 4752).close_code == 4403


def test_reads_only_the_token_subprotocol():
    assert given_token({"sec-websocket-protocol": "localdot.v1, chat"}) is None
    assert given_token({"sec-websocket-protocol": f"xlocaldot.token.{TOKEN}"}) is None
