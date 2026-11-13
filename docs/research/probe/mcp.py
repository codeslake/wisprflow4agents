"""Minimal MCP streamable-HTTP client. Needs token.json from login.py in the cwd.

Run: python3 probe/mcp.py tools/list
     python3 probe/mcp.py tools/call '{"name": "search_meetings", "arguments": {"limit": 2}}'
On a network that blocks api.wisprflow.ai direct, route it through a proxy (HTTPS_PROXY is honoured).
"""
import json, os, sys, urllib.request
URL = "https://api.wisprflow.ai/connect/mcp"
TOK = json.load(open("token.json"))["access_token"]
def post(msg, sid=None):
    h = {"Authorization": "Bearer " + TOK, "Content-Type": "application/json",
         "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"}
    if sid: h["Mcp-Session-Id"] = sid
    r = urllib.request.urlopen(urllib.request.Request(URL, json.dumps(msg).encode(), h), timeout=60)
    body = r.read().decode()
    if "text/event-stream" in r.headers.get("Content-Type", ""):
        body = "\n".join(l[5:].strip() for l in body.splitlines() if l.startswith("data:"))
    return r.headers.get("Mcp-Session-Id"), (json.loads(body) if body.strip() else None)
sid, init = post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "cc-wispr-probe", "version": "0"}}})
post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
method = sys.argv[1]
if method == "initialize": print(json.dumps(init, indent=1)); sys.exit()
params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
print(json.dumps(post({"jsonrpc": "2.0", "id": 2, "method": method, "params": params}, sid)[1], indent=1, ensure_ascii=False))
