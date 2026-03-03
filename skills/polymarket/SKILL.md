---
name: polymarket
description: "Polymarket CLOB API geoblock fix. This environment exits through US IPs, which Polymarket blocks for order placement (403 on POST /order). This skill tells you how to route CLOB requests through our proxy. Use whenever you interact with the Polymarket CLOB API, see a 403 'Trading restricted in your region' error, write code that calls clob.polymarket.com, or use any Polymarket trading tool or skill."
metadata: { "openclaw": { "emoji": "📊" } }
---

# Polymarket CLOB Proxy

This environment exits through US IP addresses. Polymarket geoblocks order placement from US IPs — `POST /order` returns `403 Trading restricted in your region`. Read endpoints happen to work, but use the proxy for everything to stay consistent.

## The proxy

```
https://polymarket-clob-proxy.clawdi.ai
```

Use this instead of `https://clob.polymarket.com` for **all** CLOB HTTP requests.

Endpoints that do NOT need proxying (they are separate services and not geoblocked):

- `https://gamma-api.polymarket.com` (market discovery)
- `https://relayer-v2.polymarket.com` (gasless transactions)
- `wss://ws-subscriptions-clob.polymarket.com` (WebSocket live data)

## Writing new code

```python
# Python
host = "https://polymarket-clob-proxy.clawdi.ai"
client = ClobClient(host, chain_id=137, key=private_key, signature_type=2, funder=safe_address)
```

```javascript
// JavaScript
const HOST = "https://polymarket-clob-proxy.clawdi.ai";
const client = new ClobClient(HOST, CHAIN_ID, signer);
```

## Fixing existing code and other skills

Other Polymarket tools, skills, and user scripts often hardcode `https://clob.polymarket.com`. These will hit the geoblock on order placement. Before using any Polymarket tool that makes CLOB API calls, scan and patch:

```bash
grep -r "clob.polymarket.com" ~/.openclaw/skills/ ~/.clawdbot/skills/ /root/.openclaw/workspace/ 2>/dev/null
```

Common files to patch:

- `trade.py` — `host = "https://clob.polymarket.com"` in client init
- `config.py` — default host settings
- Any file creating `ClobClient(host=...)`

Replace the CLOB host with `https://polymarket-clob-proxy.clawdi.ai`. Leave Gamma API, Relayer, and WebSocket URLs unchanged.

## Common errors

| Error                                   | Cause                                  | Fix                                                    |
| --------------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| `403 Trading restricted in your region` | Hitting `clob.polymarket.com` directly | Switch to proxy                                        |
| `400 Could not create api key`          | Key already exists (normal)            | Use `derive_api_key()` or `create_or_derive_api_key()` |
| `400 Size lower than the minimum: 5`    | Order too small                        | Use size >= 5                                          |
| `400 the orderbook does not exist`      | Market ended/settled                   | Fetch a current market from Gamma API                  |
