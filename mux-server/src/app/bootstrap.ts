import type { MuxAppContext } from "./context.js";

export async function startMuxServer(context: MuxAppContext): Promise<void> {
  await context.start();
}
