"""MCP bridge: the one door an artifact has into this computer.

WHY THIS EXISTS, AND WHY IT IS NOT AN HTTP API

A published artifact cannot make outbound network calls. Measured, not
assumed: fetches to api.github.com, cloudflare.com and a Supabase REST URL all
fail in under a millisecond, which is a Content Security Policy refusal rather
than a timeout. So an artifact cannot reach this helper over http://127.0.0.1,
and cannot reach a cloud database either.

The single sanctioned route from an artifact to a local program is the `mcp`
capability with a `host:<name>` server — a local MCP server on the viewer's own
device, in the Claude desktop app. This is that server.

    Amazon Seller Central
        |  Playwright, in worker/seller_central.py
        v
    the helper  ->  parsed dataset on disk  ->  THIS MCP SERVER
                                                     |
                                                     v
                                        the artifact, as a viewer

READ ONLY, ON PURPOSE

Every tool here reads. Nothing downloads, requests, deletes or spends. An
artifact is a viewer; the decision to fetch from Amazon stays with the person
in the local app. A read-only surface also means a page cannot be talked into
doing something expensive by text it happens to render.

NO CREDENTIALS CROSS THIS BOUNDARY. The Amazon session lives in
worker/profile/ and is never read here; the helper token is never exposed.
Only figures already parsed from your own reports are served.

PROTOCOL

JSON-RPC 2.0 over stdin/stdout, newline delimited — the MCP stdio transport.
Written directly rather than against an SDK so the package keeps its single
dependency (Playwright) and so the wire format is inspectable here.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA_PATH = HERE / "data" / "dataset.json"

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "amazon-cash-bridge"
SERVER_VERSION = "1.0.0"


# ── the stored snapshot ─────────────────────────────────────────────────────

def load_dataset() -> dict:
    """The dataset the local app last pushed.

    The app parses reports in JavaScript — the same parsers that are already
    tested — and pushes the result here after each import. Parsing again in
    Python would mean two implementations of the fee hierarchy, and eventually
    two different answers."""
    try:
        return json.loads(DATA_PATH.read_text("utf-8"))
    except Exception:
        return {}


def _no_data(what: str) -> dict:
    return {
        "available": False,
        "what": what,
        "reason": "No data has been pushed from the local app yet.",
        "fix": "Open the local app at http://127.0.0.1:8765, import or download "
               "a report, and it will publish a snapshot here automatically.",
    }


def _money(cents):
    """Figures cross this boundary as both cents and a formatted string, so a
    reader cannot accidentally treat cents as dollars."""
    if cents is None:
        return None
    return {"cents": cents, "formatted": "${:,.2f}".format(cents / 100.0)}


# ── tools ───────────────────────────────────────────────────────────────────

def tool_get_status(_args: dict) -> dict:
    ds = load_dataset()
    if not ds:
        return _no_data("status")
    return {
        "available": True,
        "pushedAt": ds.get("pushedAt"),
        "helperVersion": ds.get("helperVersion"),
        "hasForecast": bool((ds.get("forecast") or {}).get("present")),
        "hasActual": bool((ds.get("actual") or {}).get("present")),
        "imports": [
            {
                "name": i.get("name"),
                "family": i.get("family"),
                "coverage": i.get("coverage"),
                "marketplace": i.get("marketplace"),
                "rows": i.get("rowCount"),
                "source": i.get("source") or "manual-upload",
                "fetchedAt": i.get("fetchedAt"),
            }
            for i in (ds.get("imports") or [])
        ],
        "note": "Freshness is the moment the report was fetched, not the moment "
                "this was read.",
    }


def tool_get_forecast(_args: dict) -> dict:
    ds = load_dataset()
    f = (ds or {}).get("forecast") or {}
    if not f.get("present"):
        return _no_data("forecast")
    return {
        "available": True,
        "origin": "AMAZON FORECAST",
        "period": f.get("period"),
        "marketplace": f.get("store"),
        "currency": f.get("currency"),
        "products": f.get("skuCount"),
        "unitsSold": (f.get("units") or {}).get("sold"),
        "netSales": _money(f.get("netSales")),
        "amazonFees": _money(f.get("feeTotal")),
        "advertising": _money(f.get("advertising")),
        "storage": _money(f.get("storage")),
        "netReceivable": _money(f.get("netReceivable")),
        "partialPeriod": f.get("partial"),
        "note": "Amazon's own estimate for the report period. Not money held, "
                "and not a payout. Fee parents only — components are never added "
                "on top of their parent.",
    }


def tool_get_expenses(_args: dict) -> dict:
    ds = load_dataset()
    a = (ds or {}).get("actual") or {}
    if not a.get("present"):
        return _no_data("actual expenses")
    return {
        "available": True,
        "origin": "ACTUAL",
        "period": a.get("period"),
        "rows": a.get("rowCount"),
        "netRevenue": _money(a.get("netRevenue")),
        "grossCharges": _money(a.get("grossCharges")),
        "credits": _money(a.get("credits")),
        "netCost": _money(a.get("netCost")),
        "categories": [
            {
                "name": c.get("name"),
                "charges": _money(c.get("debit")),
                "credits": _money(c.get("credit")),
                "net": _money(c.get("net")),
                "rows": c.get("rows"),
            }
            for c in (a.get("categories") or [])[:25]
        ],
        "note": "Charges and credits are reported separately: a reversal is not "
                "the absence of a charge.",
    }


def tool_get_readiness(_args: dict) -> dict:
    ds = load_dataset()
    if not ds:
        return _no_data("readiness")
    return {
        "available": True,
        "features": ds.get("readiness") or [],
        "note": "Each entry says whether a calculation is possible and, when it "
                "is not, exactly which input is missing.",
    }


TOOLS = [
    {
        "name": "get_status",
        "description": "What Amazon data the desktop bridge currently holds: "
                       "which reports were imported or downloaded, what dates "
                       "they cover, and when each was actually fetched.",
        "inputSchema": {"type": "object", "properties": {}},
        "handler": tool_get_status,
    },
    {
        "name": "get_forecast",
        "description": "Amazon's own forecast figures from the Fees & Economics "
                       "Preview: net sales, units, fees, advertising, storage "
                       "and net receivable for the report period.",
        "inputSchema": {"type": "object", "properties": {}},
        "handler": tool_get_forecast,
    },
    {
        "name": "get_expenses",
        "description": "Actual Amazon charges from the Payments transaction "
                       "export, broken down by category with charges and "
                       "credits kept separate.",
        "inputSchema": {"type": "object", "properties": {}},
        "handler": tool_get_expenses,
    },
    {
        "name": "get_readiness",
        "description": "Which figures can be calculated from what is loaded, "
                       "and precisely which input each blocked one needs.",
        "inputSchema": {"type": "object", "properties": {}},
        "handler": tool_get_readiness,
    },
]

BY_NAME = {t["name"]: t for t in TOOLS}


# ── JSON-RPC plumbing ───────────────────────────────────────────────────────

def _send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _result(rid, payload: dict) -> None:
    _send({"jsonrpc": "2.0", "id": rid, "result": payload})


def _error(rid, code: int, message: str) -> None:
    _send({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})


def handle(msg: dict) -> None:
    method = msg.get("method")
    rid = msg.get("id")

    if method == "initialize":
        _result(rid, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
        return

    # Notifications carry no id and expect no reply.
    if rid is None:
        return

    if method == "tools/list":
        _result(rid, {"tools": [
            {k: t[k] for k in ("name", "description", "inputSchema")} for t in TOOLS
        ]})
        return

    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        tool = BY_NAME.get(name)
        if not tool:
            _error(rid, -32602, "Unknown tool: %r" % name)
            return
        try:
            payload = tool["handler"](params.get("arguments") or {})
        except Exception as exc:                       # noqa: BLE001
            _error(rid, -32603, "%s failed: %s" % (name, exc))
            return
        # MCP returns content blocks; JSON goes in a text block so any client
        # can read it, with structuredContent for those that understand it.
        _result(rid, {
            "content": [{"type": "text", "text": json.dumps(payload, indent=2)}],
            "structuredContent": payload,
            "isError": False,
        })
        return

    if method == "ping":
        _result(rid, {})
        return

    _error(rid, -32601, "Method not found: %r" % method)


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        try:
            handle(msg)
        except Exception as exc:                       # noqa: BLE001
            # Never die on one bad message: the client would see the whole
            # bridge vanish rather than one failed call.
            if isinstance(msg, dict) and msg.get("id") is not None:
                _error(msg.get("id"), -32603, str(exc))


if __name__ == "__main__":
    main()
