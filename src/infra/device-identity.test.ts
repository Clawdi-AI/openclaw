import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  deriveDeviceIdFromPublicKey,
  loadOrCreateDeviceIdentity,
  normalizeDevicePublicKeyBase64Url,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
} from "./device-identity.js";

async function withIdentity(
  run: (identity: ReturnType<typeof loadOrCreateDeviceIdentity>) => void,
) {
  await withTempDir("openclaw-device-identity-", async (dir) => {
    const identity = loadOrCreateDeviceIdentity(path.join(dir, "device.json"));
    run(identity);
  });
}

describe("device identity crypto helpers", () => {
  it("derives the same canonical raw key and device id from pem and encoded public keys", async () => {
    await withIdentity((identity) => {
      const publicKeyRaw = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
      const paddedBase64 = `${publicKeyRaw.replaceAll("-", "+").replaceAll("_", "/")}==`;

      expect(normalizeDevicePublicKeyBase64Url(identity.publicKeyPem)).toBe(publicKeyRaw);
      expect(normalizeDevicePublicKeyBase64Url(paddedBase64)).toBe(publicKeyRaw);
      expect(deriveDeviceIdFromPublicKey(identity.publicKeyPem)).toBe(identity.deviceId);
      expect(deriveDeviceIdFromPublicKey(publicKeyRaw)).toBe(identity.deviceId);
    });
  });

  it("signs payloads that verify against pem and raw public key forms", async () => {
    await withIdentity((identity) => {
      const payload = JSON.stringify({
        action: "system.run",
        ts: 1234,
      });
      const signature = signDevicePayload(identity.privateKeyPem, payload);
      const publicKeyRaw = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);

      expect(verifyDeviceSignature(identity.publicKeyPem, payload, signature)).toBe(true);
      expect(verifyDeviceSignature(publicKeyRaw, payload, signature)).toBe(true);
      expect(verifyDeviceSignature(publicKeyRaw, `${payload}!`, signature)).toBe(false);
    });
  });

  it("fails closed for invalid public keys and signatures", async () => {
    await withIdentity((identity) => {
      const payload = "hello";
      const signature = signDevicePayload(identity.privateKeyPem, payload);

      expect(normalizeDevicePublicKeyBase64Url("-----BEGIN PUBLIC KEY-----broken")).toBeNull();
      expect(deriveDeviceIdFromPublicKey("%%%")).toBeNull();
      expect(verifyDeviceSignature("%%%invalid%%%", payload, signature)).toBe(false);
      expect(verifyDeviceSignature(identity.publicKeyPem, payload, "%%%invalid%%%")).toBe(false);
    });
  });

  it("derives a stable identity from MASTER_KEY on first create", async () => {
    await withTempDir("openclaw-device-identity-", async (dir) => {
      const identityPath = path.join(dir, "device.json");

      await withEnvAsync({ MASTER_KEY: "test-master-key" }, async () => {
        const first = loadOrCreateDeviceIdentity(identityPath);
        const second = loadOrCreateDeviceIdentity(identityPath);

        expect(second).toEqual(first);
      });

      await withEnvAsync({ MASTER_KEY: "test-master-key" }, async () => {
        const third = loadOrCreateDeviceIdentity(identityPath);
        expect(third).toEqual(loadOrCreateDeviceIdentity(identityPath));
      });
    });
  });

  it("overwrites stale device.json when MASTER_KEY derivation differs", async () => {
    await withTempDir("openclaw-device-identity-", async (dir) => {
      const identityPath = path.join(dir, "device.json");

      // Create a random identity without MASTER_KEY (simulates pre-fix state)
      const random = loadOrCreateDeviceIdentity(identityPath);

      // Now load with MASTER_KEY — should replace the random identity
      await withEnvAsync({ MASTER_KEY: "test-master-key" }, async () => {
        const derived = loadOrCreateDeviceIdentity(identityPath);
        expect(derived.deviceId).not.toBe(random.deviceId);

        // Reload should return the same derived identity
        const reloaded = loadOrCreateDeviceIdentity(identityPath);
        expect(reloaded).toEqual(derived);
      });
    });
  });
});
