import { describe } from "vitest";
import { defineTelegramMuxRoundTripTest } from "./telegram.mux-roundtrip.shared.js";

describe("mux Telegram integration (target-first)", () => {
  defineTelegramMuxRoundTripTest("target-first");
});
