"""Flask routes for ChainPay pages and public blockchain reads."""
import json
import os
import re
from pathlib import Path
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
TX_HASH = re.compile(r"^0x[0-9a-fA-F]{64}$")
ZERO = "0x" + "0" * 40


class APIError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


class RPCClient:
    def __init__(self, url):
        self.url = url

    def batch(self, calls):
        payload = [{"jsonrpc": "2.0", "id": i, "method": method, "params": params}
                   for i, (method, params) in enumerate(calls)]
        req = Request(self.url, json.dumps(payload).encode(),
                      headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(req, timeout=12) as response:
                data = json.load(response)
        except (URLError, HTTPError, TimeoutError, ValueError, OSError):
            raise APIError("Blockchain RPC is unavailable. Check the network and RPC_URL.", 503) from None
        if not isinstance(data, list):
            raise APIError("The RPC server returned an unexpected response.", 502)
        by_id = {item.get("id"): item for item in data if isinstance(item, dict)}
        values = []
        for i in range(len(calls)):
            item = by_id.get(i, {})
            if item.get("error") or "result" not in item:
                raise APIError("Blockchain request failed. Check the contract and transaction inputs.", 502)
            values.append(item["result"])
        return values

    def call(self, method, params):
        return self.batch([(method, params)])[0]


def word(number):
    return f"{int(number):064x}"


def address_word(address):
    return address[2:].lower().rjust(64, "0")


def ether(wei):
    # Integer formatting preserves every wei even above Decimal's default precision.
    whole, fraction = divmod(int(wei), 10**18)
    decimals = f"{fraction:018d}".rstrip("0")
    return f"{whole}.{decimals}" if decimals else str(whole)


def decode_ids(data):
    raw = bytes.fromhex(data[2:])
    start = int.from_bytes(raw[:32], "big")
    count = int.from_bytes(raw[start:start + 32], "big")
    if count > 50 or len(raw) < start + 32 + count * 32:
        raise APIError("Invalid history data from the contract.", 502)
    return [int.from_bytes(raw[start + 32 + i * 32:start + 64 + i * 32], "big")
            for i in range(count)]


def decode_payment(data, payment_id):
    raw = bytes.fromhex(data[2:])
    start = int.from_bytes(raw[:32], "big")
    fields = [raw[start + i * 32:start + (i + 1) * 32] for i in range(6)]
    if any(len(field) != 32 for field in fields):
        raise APIError("Invalid receipt data from the contract.", 502)
    memo_start = start + int.from_bytes(fields[5], "big")
    memo_length = int.from_bytes(raw[memo_start:memo_start + 32], "big")
    if memo_length > 140 or len(raw) < memo_start + 32 + memo_length:
        raise APIError("Invalid memo data from the contract.", 502)
    amount = int.from_bytes(fields[2], "big")
    return {"id": str(payment_id), "sender": "0x" + fields[0][-20:].hex(),
            "recipient": "0x" + fields[1][-20:].hex(), "amountWei": str(amount),
            "amountEth": ether(amount), "timestamp": int.from_bytes(fields[3], "big"),
            "blockNumber": int.from_bytes(fields[4], "big"),
            "memo": raw[memo_start + 32:memo_start + 32 + memo_length].decode("utf-8")}


def create_app(overrides=None):
    app = Flask(__name__)
    network = os.getenv("NETWORK", "sepolia")
    app.config.update(
        NETWORK=network, CHAIN_ID=1337 if network == "local" else 11155111,
        RPC_URL=os.getenv("RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"),
        CONTRACT_ADDRESS=os.getenv("CONTRACT_ADDRESS", ""),
        DEPLOYMENT_FILE=os.getenv("DEPLOYMENT_FILE", str(ROOT / f"data/deployment.{network}.json")),
        MAX_CONTENT_LENGTH=4096,
    )
    if overrides:
        app.config.update(overrides)
    artifact_path = ROOT / "artifacts/ChainPay.json"
    artifact = json.loads(artifact_path.read_text()) if artifact_path.exists() else {}
    app.extensions["chainpay_rpc"] = RPCClient(app.config["RPC_URL"])

    def rpc():
        return app.extensions["chainpay_rpc"]

    def deployment():
        path = Path(app.config["DEPLOYMENT_FILE"])
        result = json.loads(path.read_text()) if path.exists() else {}
        if app.config["CONTRACT_ADDRESS"]:
            result["address"] = app.config["CONTRACT_ADDRESS"]
        return result

    def configured(require_contract=True):
        if not artifact:
            raise APIError("Contract build is unavailable.", 503)
        if int(rpc().call("eth_chainId", []), 16) != app.config["CHAIN_ID"]:
            raise APIError("Backend RPC network does not match the selected network.", 503)
        address = request.args.get("contract", deployment().get("address", ""))
        if require_contract:
            if not ADDRESS.fullmatch(address) or address.lower() == ZERO:
                raise APIError("Choose or deploy a ChainPay contract in the setup section first.", 503)
            if rpc().call("eth_getCode", [address, "latest"]).lower() != artifact["deployedBytecode"].lower():
                raise APIError("Configured contract does not match this ChainPay build.", 503)
        return address

    def eth_call(address, data, block="latest"):
        return rpc().call("eth_call", [{"to": address, "data": data}, block])

    @app.errorhandler(APIError)
    def api_error(error):
        return jsonify(error=error.message), error.status

    @app.errorhandler(413)
    def too_large(_):
        return jsonify(error="Request is too large."), 413

    @app.after_request
    def security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store" if request.path.startswith("/api/") else "no-cache"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; img-src 'self' data:; base-uri 'self'; "
            "frame-ancestors 'none'; form-action 'self'"
        )
        return response

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/health")
    def health():
        return jsonify(status="ok", application="ChainPay")

    @app.get("/api/config")
    def config():
        return jsonify(name="ChainPay", chainId=app.config["CHAIN_ID"],
                       network=app.config["NETWORK"],
                       contractAddress=deployment().get("address", ""), abi=artifact.get("abi", []),
                       compiled=bool(artifact), explorer="https://sepolia.etherscan.io" if app.config["CHAIN_ID"] == 11155111 else "")

    @app.get("/api/overview")
    def overview():
        address = configured()
        block = rpc().call("eth_blockNumber", [])
        count, volume = rpc().batch([
            ("eth_call", [{"to": address, "data": artifact["selectors"][name]}, block])
            for name in ["transferCount", "totalTransferred"]
        ])
        result = {"transferCount": str(int(count, 16)), "totalEth": ether(int(volume, 16)),
                  "blockNumber": int(block, 16)}
        account = request.args.get("account", "")
        if account:
            if not ADDRESS.fullmatch(account):
                raise APIError("Invalid account address.")
            result["balanceEth"] = ether(int(rpc().call("eth_getBalance", [account, block]), 16))
        return jsonify(result)

    @app.get("/api/history")
    def history():
        account = request.args.get("account", "")
        if not ADDRESS.fullmatch(account):
            raise APIError("A valid account address is required.")
        try:
            offset = int(request.args.get("offset", "0"))
            limit = int(request.args.get("limit", "6"))
        except ValueError:
            raise APIError("Invalid pagination.") from None
        if not 0 <= offset < 2**256 or not 1 <= limit <= 20:
            raise APIError("Offset must be nonnegative and page size must be 1 to 20.")
        address = configured()
        block = rpc().call("eth_blockNumber", [])
        total_raw, ids_raw = rpc().batch([
            ("eth_call", [{"to": address, "data": artifact["selectors"]["historyCount"] + address_word(account)}, block]),
            ("eth_call", [{"to": address, "data": artifact["selectors"]["getHistoryIds"] + address_word(account) + word(offset) + word(limit)}, block]),
        ])
        ids = decode_ids(ids_raw)
        payments = []
        if ids:
            encoded = rpc().batch([("eth_call", [{"to": address,
                "data": artifact["selectors"]["getPayment"] + word(i)}, block]) for i in ids])
            payments = [decode_payment(raw, i) for raw, i in zip(encoded, ids)]
            logs = rpc().batch([("eth_getLogs", [{"address": address,
                "fromBlock": hex(p["blockNumber"]), "toBlock": hex(p["blockNumber"]),
                "topics": [artifact["eventTopic"], "0x" + word(int(p["id"]))]}]) for p in payments])
            for payment, events in zip(payments, logs):
                payment["transactionHash"] = events[0]["transactionHash"] if events else ""
        return jsonify(payments=payments, total=str(int(total_raw, 16)), offset=offset,
                       limit=limit, snapshotBlock=int(block, 16))

    @app.get("/api/receipt/<tx_hash>")
    def receipt(tx_hash):
        if not TX_HASH.fullmatch(tx_hash):
            raise APIError("Invalid transaction hash.")
        address = configured()
        data = rpc().call("eth_getTransactionReceipt", [tx_hash])
        if not data:
            return jsonify(status="pending", transactionHash=tx_hash)
        if (data.get("to") or "").lower() != address.lower():
            raise APIError("This transaction is not a payment to the configured ChainPay contract.")
        successful = int(data["status"], 16) == 1
        if successful and not any(
            (event.get("address") or "").lower() == address.lower()
            and (event.get("topics") or [None])[0] == artifact["eventTopic"]
            for event in data.get("logs", [])
        ):
            raise APIError("This transaction contains no confirmed ChainPay payment.")
        latest = int(rpc().call("eth_blockNumber", []), 16)
        return jsonify(status="confirmed" if successful else "failed",
                       transactionHash=tx_hash, blockNumber=int(data["blockNumber"], 16),
                       confirmations=latest - int(data["blockNumber"], 16) + 1,
                       gasUsed=str(int(data["gasUsed"], 16)))

    @app.get("/api/artifact")
    def deployment_artifact():
        if not artifact:
            raise APIError("Contract build is unavailable.", 503)
        return jsonify(abi=artifact["abi"], bytecode=artifact["bytecode"])

    return app


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=int(os.getenv("PORT", "6113")), debug=False)
