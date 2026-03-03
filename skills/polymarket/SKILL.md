---
name: polymarket
description: "Polymarket prediction market trading and data. Use when: interacting with Polymarket CLOB API, placing orders, reading market prices, building trading bots or signal monitors, querying Gamma API for market discovery, or debugging Polymarket 403/auth errors. Also use when the user mentions prediction markets, event contracts, or binary outcome trading on Polymarket."
metadata: { "openclaw": { "emoji": "📊" } }
---

# Polymarket Skill

## Rule #1: Use the CLOB Proxy

This environment exits through US IP addresses. Polymarket geoblocks order placement (`POST /order` → 403) from US IPs. Read endpoints happen to work, but use the proxy for everything to stay consistent and avoid surprises.

**Proxied CLOB endpoint (use this for all CLOB requests):**

```
https://polymarket-clob-proxy.clawdi.ai
```

**Do not use `https://clob.polymarket.com` directly** — it will fail on writes.

### Examples

```python
# Python (py-clob-client)
from py_clob_client.client import ClobClient
host = "https://polymarket-clob-proxy.clawdi.ai"
client = ClobClient(host, chain_id=137, key=private_key, signature_type=2, funder=safe_address)
```

```javascript
// JavaScript
const HOST = "https://polymarket-clob-proxy.clawdi.ai";
const client = new ClobClient(HOST, CHAIN_ID, signer);
```

### Updating existing code

If you find code that references `https://clob.polymarket.com`, replace it:

```bash
grep -r "clob.polymarket.com" .
# Replace all with: https://polymarket-clob-proxy.clawdi.ai
```

## When to Use / Not Use This Skill

**Use this skill when:**

- Placing or cancelling Polymarket orders
- Reading market prices, order books, or trade history
- Building trading bots, signal monitors, or strategy scripts
- Querying the Gamma API for market discovery
- Debugging 403, 400, or auth errors related to Polymarket
- Setting up Polymarket API credentials (L1/L2 auth, Builder Program)

**Don't use this skill when:**

- General cryptocurrency trading (Binance, Coinbase, etc.) — different APIs entirely
- Non-Polymarket prediction markets (Kalshi, Manifold, etc.)
- On-chain Polygon transactions unrelated to Polymarket contracts

## Endpoint Map

| Service                        | URL                                          | Proxied? |
| ------------------------------ | -------------------------------------------- | -------- |
| CLOB API (orders, auth, books) | `https://polymarket-clob-proxy.clawdi.ai`    | **Yes**  |
| Gamma API (market discovery)   | `https://gamma-api.polymarket.com`           | No       |
| Relayer API (gasless txns)     | `https://relayer-v2.polymarket.com`          | No       |
| WebSocket (live data)          | `wss://ws-subscriptions-clob.polymarket.com` | No       |

## Authentication

Polymarket uses a two-layer auth scheme:

1. **L1 auth** — sign an EIP-712 message with your wallet private key. This proves you own the address.
2. **Derive API key** — call `GET /auth/derive-api-key` with L1 headers. Returns L2 credentials (`api_key`, `secret`, `passphrase`).
3. **L2 auth** — use the derived credentials for all authenticated requests (orders, trades, positions).

The `py-clob-client` SDK handles this automatically via `create_or_derive_api_creds()`. Note: `POST /auth/api-key` returns 400 if the key already exists — this is normal. The SDK falls back to `derive` on failure.

## Key CLOB Endpoints

| Method | Endpoint                         | Auth         | Description               |
| ------ | -------------------------------- | ------------ | ------------------------- |
| GET    | `/last-trade-price?token_id=...` | No           | Last trade price          |
| GET    | `/book?token_id=...`             | No           | Order book                |
| GET    | `/tick-size?token_id=...`        | No           | Minimum price increment   |
| GET    | `/auth/derive-api-key`           | L1           | Derive L2 API credentials |
| POST   | `/order`                         | L2 + Builder | Place order               |
| DELETE | `/order`                         | L2           | Cancel order              |
| DELETE | `/cancel-all`                    | L2           | Cancel all orders         |
| GET    | `/data/orders`                   | L2           | List open orders          |
| GET    | `/data/trades`                   | L2           | Trade history             |

## Market Discovery (Gamma API)

The Gamma API is the easiest way to find active markets. It's not geoblocked.

```python
import urllib.request, json

url = "https://gamma-api.polymarket.com/markets?closed=false&limit=50"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
markets = json.loads(urllib.request.urlopen(req, timeout=20).read())
```

## Key Concepts

- **Chain ID 137** — Polygon mainnet. All Polymarket contracts live here.
- **Signature type 2** — Gnosis Safe signatures, used by Polymarket proxy wallets.
- **Token IDs** — ERC-1155 identifiers for YES/NO outcomes. Each market has two.
- **Prices** — 0 to 1, representing probability. A YES token at 0.65 means 65% implied probability.
- **USDC** — Settlement currency, 6 decimal places.
- **Minimum order size** — 5 units.
- **Builder Program** — Provides gasless trading via HMAC-authenticated requests to the Relayer API. Credentials: `POLY_BUILDER_API_KEY`, `POLY_BUILDER_API_SECRET`, `POLY_BUILDER_API_PASSPHRASE`.

## Risk Guidance

When building trading bots, consider implementing:

- **Position sizing** — cap per-trade exposure relative to total capital
- **Daily loss limits** — stop trading if cumulative losses exceed a threshold
- **Settlement buffer** — avoid opening positions close to market expiry (high slippage, low liquidity)
- **Observation mode** — run signal-only before enabling live execution, so you can validate strategy logic without risking funds
- **Liquidity checks** — verify 24h volume before trading a market

These parameters should be set by the user based on their risk tolerance and capital.

## Common Errors

| Error                                   | Cause                                  | Fix                                                    |
| --------------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| `403 Trading restricted in your region` | Hitting `clob.polymarket.com` directly | Switch to proxy                                        |
| `400 Could not create api key`          | Key already exists                     | Use `derive_api_key()` or `create_or_derive_api_key()` |
| `400 Size lower than the minimum: 5`    | Order size too small                   | Use size >= 5                                          |
| `400 the orderbook does not exist`      | Market ended/settled                   | Fetch a current market from Gamma API                  |
