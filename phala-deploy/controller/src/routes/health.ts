import type { Context, Hono } from "hono";

export type ControllerState =
  | { state: "starting" }
  | { state: "ready" }
  | { state: "degraded"; error: string };

export type ControllerStateRef = { current: ControllerState };

export function registerHealthRoute(app: Hono, stateRef: ControllerStateRef): void {
  // /_clawdi/health: detailed controller state. Always HTTP 200 so k8s/Fly
  // probes stay happy even when the gateway is down.
  app.get("/_clawdi/health", (c: Context) => {
    const s = stateRef.current;
    return c.json({ status: "ok", ...s });
  });

  // Bare /health for generic probes — minimal response.
  app.get("/health", (c: Context) => c.json({ status: "ok" }));
}
