"""One-time OAuth login (auth code + PKCE) for the Wispr Flow MCP; writes token.json in the cwd.

Run: python3 probe/login.py, open the printed URL in any browser, log in, then paste the
http://localhost:33418/callback?... URL the browser lands on (the page itself fails to load; that is fine).
The device_code grant is advertised but its browser step fails with "Missing external_auth_id" (2026-11-11).
"""
import base64, hashlib, json, secrets, urllib.parse, urllib.request
AUTH, MCP, REDIRECT = "https://mcp-auth.wisprflow.com", "https://api.wisprflow.ai/connect/mcp", "http://localhost:33418/callback"
def post(path, data, ctype):
    return json.loads(urllib.request.urlopen(urllib.request.Request(AUTH + path, data, {"Content-Type": ctype}), timeout=20).read())
client = post("/oauth2/register", json.dumps({"client_name": "wisprflow4agents probe", "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"], "token_endpoint_auth_method": "none", "redirect_uris": [REDIRECT]}).encode(), "application/json")
verifier, state = secrets.token_urlsafe(64), secrets.token_urlsafe(16)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
print(AUTH + "/oauth2/authorize?" + urllib.parse.urlencode({"response_type": "code", "client_id": client["client_id"],
    "redirect_uri": REDIRECT, "scope": "openid offline_access", "state": state, "code_challenge": challenge,
    "code_challenge_method": "S256", "resource": MCP}))
q = urllib.parse.parse_qs(urllib.parse.urlparse(input("callback URL: ").strip()).query)
assert q["state"][0] == state, "state mismatch"
tok = post("/oauth2/token", urllib.parse.urlencode({"grant_type": "authorization_code", "code": q["code"][0], "redirect_uri": REDIRECT,
    "client_id": client["client_id"], "code_verifier": verifier, "resource": MCP}).encode(), "application/x-www-form-urlencoded")
with open("token.json", "w") as f: json.dump(tok, f)
print("token.json written; access token expires in", tok.get("expires_in"), "s")
