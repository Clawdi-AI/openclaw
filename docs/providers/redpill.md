---
summary: "Use Redpill AI GPU TEE models in OpenClaw"
read_when:
  - You want privacy-focused inference with hardware-backed isolation
  - You want Redpill AI setup guidance
  - You want to use GPU TEE models from OpenClaw
title: "Redpill AI"
---

# Redpill AI

Redpill AI provides access to models running in GPU-based trusted execution environments. OpenClaw uses the `redpill` provider through Redpill's OpenAI-compatible `/v1` API.

## Why Redpill in OpenClaw

- Hardware-backed isolation for prompts and responses
- Cryptographic attestation and encrypted GPU memory
- A curated GPU TEE model catalog across multiple infrastructure providers
- OpenAI-compatible endpoints, so setup fits the standard OpenClaw provider flow

## Quick start

1. Create a Redpill API key in the [Redpill dashboard](https://redpill.ai).
2. Run onboarding:

```bash
openclaw onboard --auth-choice redpill-api-key
```

3. Or use a pre-set environment variable:

```bash
export REDPILL_API_KEY="rp_xxxxxxxxxxxx"
openclaw onboard --auth-choice redpill-api-key
```

4. Non-interactive setup:

```bash
openclaw onboard --non-interactive \
  --auth-choice redpill-api-key \
  --redpill-api-key "$REDPILL_API_KEY"
```

## Default model

OpenClaw sets the default Redpill model to:

```text
redpill/deepseek/deepseek-v3.2
```

Change it at any time:

```bash
openclaw models set redpill/deepseek/deepseek-v3.2
openclaw models set redpill/deepseek/deepseek-r1-0528
openclaw models set redpill/qwen/qwen3-coder-480b-a35b-instruct
```

List all detected Redpill models:

```bash
openclaw models list | grep redpill
```

## Recommended models

| Use case               | Model                                         | Why                                       |
| ---------------------- | --------------------------------------------- | ----------------------------------------- |
| General default        | `redpill/deepseek/deepseek-v3.2`              | Strong general model with GPU TEE privacy |
| Deep reasoning         | `redpill/deepseek/deepseek-r1-0528`           | Reasoning-focused                         |
| Long-context reasoning | `redpill/moonshotai/kimi-k2-thinking`         | Large context and reasoning               |
| Coding                 | `redpill/qwen/qwen3-coder-480b-a35b-instruct` | Code-oriented model                       |
| Vision                 | `redpill/qwen/qwen3-vl-30b-a3b-instruct`      | Vision input support                      |

## Current catalog highlights

The built-in Redpill catalog on this branch includes:

- Phala-hosted models like `deepseek/deepseek-v3.2`, `qwen/qwen3-vl-30b-a3b-instruct`, and `openai/gpt-oss-120b`
- Tinfoil-hosted models like `deepseek/deepseek-r1-0528` and `moonshotai/kimi-k2-thinking`
- Chutes-hosted models like `moonshotai/kimi-k2.5`
- Near-AI-hosted models like `qwen/qwen3-30b-a3b-instruct-2507`

See `openclaw models list | grep redpill` for the full live catalog wired into OpenClaw.

## Config snippet

```json5
{
  env: { REDPILL_API_KEY: "rp_..." },
  agents: {
    defaults: {
      model: { primary: "redpill/deepseek/deepseek-v3.2" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      redpill: {
        baseUrl: "https://api.redpill.ai/v1",
        apiKey: "REDPILL_API_KEY",
        api: "openai-completions",
      },
    },
  },
}
```

## Troubleshooting

### API key not found

Check that `REDPILL_API_KEY` is available to the process running the Gateway:

```bash
echo "$REDPILL_API_KEY"
openclaw models list | grep redpill
```

### Model not showing up

Redpill models are registered from OpenClaw's built-in catalog for this branch. If the provider is configured but no models appear, confirm the provider auth profile or env var exists.

### Connectivity issues

The provider base URL is:

```text
https://api.redpill.ai/v1
```

If your network blocks outbound HTTPS, model discovery and inference will fail.

## More information

- [Redpill AI](https://redpill.ai)
- [Model providers](/concepts/model-providers)
