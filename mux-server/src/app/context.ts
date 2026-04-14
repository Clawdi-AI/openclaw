import { startMuxServerRuntime } from "../server.js";

export type MuxAppContext = {
  start: () => Promise<void>;
};

export function createMuxAppContext(): MuxAppContext {
  return {
    start: startMuxServerRuntime,
  };
}
