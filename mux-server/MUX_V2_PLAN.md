# Mux 2.0 Plan

## Status

Living tracking doc for the "Mux 2.0" program. Captures what has already landed,
what is in flight, and what is on deck. Owners add/remove checkboxes as work
progresses. Cross-references the narrower sub-plans already in this directory.

Last updated: 2026-04-16.

## What "Mux 2.0" means

Mux 2.0 is the steady-state end-of-migration target for mux-server. It is the
sum of the following shifts, none of which individually is "the" v2:

1. **Transport-only fidelity.** Mux behaves as a dumb transport and leaves all
   channel business logic to the native OpenClaw path. See
   `MUX_FIDELITY_REFACTOR.md`.
2. **Vanilla-parity routing.** Outbound resolution is route-derived, not
   transport-sticky. Legacy session-first compatibility is removed once the
   fleet has migrated. See `PLAN.md`.
3. **Clean DI surface.** Factories take grouped config + DB subsets with direct
   imports for pure helpers. Composition root stays in `server.ts`. Landed in
   `vk/0286-modernize-mux-se` (merged 2026-04-15).
4. **Stable per-instance runtime auth.** Shared register key + per-instance
   runtime JWT + short-lived inbound JWT. See `JWT_INSTANCE_RUNTIME_DESIGN.md`.
5. **Operator-grade observability.** Prometheus + Grafana dashboards with
   low-cardinality hot-path metrics and tenant-scoped debug endpoints. See
   `OBSERVABILITY_GRAFANA_PLAN.md`.
6. **Vanilla-parity pairing scope.** Chat-scoped pairing that does not
   double-prompt inside OpenClaw. See `plan-pairing-scope.md`.

Sub-plans remain the source of truth for their respective details. This doc is
the index and the rollout tracker.

## Landed (2026 Q1 → Q2)

- [x] Transport-only mux ingress + outbound adapters (Telegram / Discord /
      WhatsApp) — `MUX_FIDELITY_REFACTOR.md`.
- [x] Outbound resolver mode `session-first` with request-target fallback.
- [x] Outbound resolver mode `target-first` implementation + round-trip tests.
- [x] Route-derived outbound `sessionKey` across all known production paths
      (direct reply, cron, heartbeat, queue replay, agent deliver, restart
      sentinel, maintenance warning, node/server receipts, message-action).
- [x] Legacy `accountId: "mux"` accepted + normalized to default account path.
- [x] Mux-server negative safety for canonical sessions without safe explicit
      targets.
- [x] Pairing scope change to chat-scoped admission (Telegram DM, group, forum;
      Discord DM, guild channel, thread; WhatsApp direct and group).
- [x] Shared register key + per-instance runtime JWT + short-lived inbound JWT.
- [x] Prometheus `/metrics` endpoint with stable hot-path labels; Grafana
      dashboard structure in place.
- [x] DI redesign: grouped `MuxConfig` + `Pick<PreparedStatements, …>` per
      factory + direct imports for pure helpers. Composition root reduced and
      strongly typed. (`vk/0286-modernize-mux-se`, merged to
      `phala-2026.3.13` 2026-04-15.)
- [x] Mocked integration harness: Telegram DM/group/forum round-trips,
      streaming preview/edit, command menu + callback edits, media (photo,
      voice), restart recovery. Discord DM/guild/thread round-trips. WhatsApp
      DM/group round-trips.
- [x] OpenClaw outbound fallback warning emitted when route derivation misses
      and caller-provided `sessionKey` is used (migration diagnostic).

## In-flight / On deck

### Rollout: session-first → target-first → target-only

- [ ] Flip default resolver mode to `target-first` once warning-rate for
      route-derivation fallback is at or near zero across the production
      fleet. Source of truth: `PLAN.md` "Resolution policy phases".
- [ ] Remove migration-only compatibility branches after `target-first` has
      been the default for one full release cycle without incident.
- [ ] Introduce optional `target-only` resolver mode. Gated on: - zero `outbound_route_fallback` that depended on legacy session binding - persisted bindings audited / migrated where required - no remaining old-OpenClaw nodes in the fleet
- [ ] Switch `MUX_OPENCLAW_ACCOUNT_ID` default back to `default` once no old
      OpenClaw nodes remain (it stays at `mux` during mixed-fleet rollout).

### Test coverage still open

- [ ] Full mux-server negative safety matrix beyond the no-safe-target
      canonical cases (per `PLAN.md` B.3).
- [ ] Remaining sanitized real Telegram payload fixtures for the mocked
      integration harness (poll gated on a real `poll` surface path).
- [ ] Manual release checks executed and signed off for Discord and WhatsApp
      (per `PLAN.md` D.2 / D.3). Telegram manual checks already part of the
      release flow.

### Observability / operator UX

- [ ] Publish the Grafana dashboards called out in `OBSERVABILITY_GRAFANA_PLAN.md`
      as versioned JSON in `mux-server/grafana/` and keep in sync with any
      metric label changes.
- [ ] Confirm blackbox probe + `up`-style signal for `GET /health/ready` in
      every deploy target (Phala, self-hosted, internal).
- [ ] Document the admin snapshot endpoint access model for tenant triage
      (reverse-proxy auth or secure header injection).

### Cleanup (post-migration)

- [ ] Remove `session-first` code paths once `target-first` is the steady
      state and there are no legacy bindings that still need them.
- [ ] Remove `accountId: "mux"` normalization once no caller in the fleet
      emits it.
- [ ] Retire `MUX_OPENCLAW_ACCOUNT_ID=mux` as a supported knob (compat-only
      today, not a steady-state recommendation).
- [ ] Delete stale mux-account docs and tests from the v1 model.

## Acceptance criteria for "Mux 2.0 is done"

Mux 2.0 is done when **all** of the following are true:

1. Default resolver mode is `target-first` (or `target-only`) in production.
2. No `session-first` compatibility branches remain in the code, or they are
   gated behind an explicit opt-in flag with zero active tenants using it.
3. `MUX_OPENCLAW_ACCOUNT_ID=default` is the documented + tested default.
4. `outbound_route_fallback` counter is effectively zero over a release
   cycle. Any non-zero is explainable and investigated.
5. Pairing UX matches `plan-pairing-scope.md` on every channel, verified by
   the mocked harness + at least one real-device release smoke per channel.
6. Grafana dashboards + `/metrics` contract are versioned in-repo and in
   use by the on-call rotation.
7. Runtime JWT rotation model is operator-verified (register, rotate,
   revoke) end to end.
8. DI surface of each factory fits on one screen (grouped `Pick<MuxConfig>`
   - `Pick<PreparedStatements>` + small explicit dep list). No factory
     inflates back past ~10 direct deps on its own.

## References

- `PLAN.md` — routing semantics, resolver modes, migration phases, test plan.
- `MUX_FIDELITY_REFACTOR.md` — transport-only principle + adapter boundaries.
- `JWT_INSTANCE_RUNTIME_DESIGN.md` — register key + runtime JWT model.
- `OBSERVABILITY_GRAFANA_PLAN.md` — metrics contract + dashboards.
- `plan-pairing-scope.md` — pairing scope per channel.
- `~/.claude/plans/shimmering-knitting-moth.md` — DI redesign plan (archive
  copy of the work that landed in `vk/0286-modernize-mux-se`).
