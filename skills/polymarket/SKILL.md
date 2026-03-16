---
name: polymarket
description: "Polymarket CLOB API geoblock fix. This environment exits through US IPs, which Polymarket blocks for order placement (403 on POST /order). This skill tells you how to route CLOB requests through our proxy. Use whenever you interact with the Polymarket CLOB API, see a 403 'Trading restricted in your region' error, write code that calls clob.polymarket.com, or use any Polymarket trading tool or skill."
metadata: { "openclaw": { "emoji": "📊" } }
---

# Polymarket CLOB Proxy

This environment exits through US IP addresses. Polymarket geoblocks order placement from US IPs, so use the proxy for all CLOB HTTP requests.

## Proxy

```text
https://polymarket-clob-proxy.clawdi.ai
```

Use this instead of `https://clob.polymarket.com` for all CLOB HTTP requests.

Endpoints that do not need proxying:

- `https://gamma-api.polymarket.com`
- `https://relayer-v2.polymarket.com`
- `wss://ws-subscriptions-clob.polymarket.com`

## Writing New Code

```python
host = "https://polymarket-clob-proxy.clawdi.ai"
client = ClobClient(host, chain_id=137, key=private_key, signature_type=2, funder=safe_address)
```

```javascript
const HOST = "https://polymarket-clob-proxy.clawdi.ai";
const client = new ClobClient(HOST, CHAIN_ID, signer);
```

## Fix Existing Code

Scan for hardcoded `clob.polymarket.com`:

```bash
grep -r "clob.polymarket.com" ~/.openclaw/skills/ ~/.clawdbot/skills/ /root/.openclaw/workspace/ 2>/dev/null
```

Common places:

- `trade.py`
- `config.py`
- any file creating `ClobClient(host=...)`

Leave Gamma API, Relayer, and WebSocket URLs unchanged.

## Common Errors

| Error                                   | Cause                                  | Fix                                                    |
| --------------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| `403 Trading restricted in your region` | Hitting `clob.polymarket.com` directly | Switch to proxy                                        |
| `400 Could not create api key`          | Key already exists                     | Use `derive_api_key()` or `create_or_derive_api_key()` |
| `400 Size lower than the minimum: 5`    | Order too small                        | Use size >= 5                                          |
| `400 the orderbook does not exist`      | Market ended or settled                | Fetch a current market from Gamma API                  |
