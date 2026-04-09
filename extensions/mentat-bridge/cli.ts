import type { MentatClient } from "./client.js";

type PluginApi = {
  registerCli: (
    registrar: (ctx: { program: CliProgram }) => void,
    opts?: { commands?: string[] },
  ) => void;
};

type CliProgram = {
  command: (name: string) => CliCommand;
};

type CliCommand = {
  description: (desc: string) => CliCommand;
  argument: (name: string, desc?: string) => CliCommand;
  option: (flags: string, desc?: string, defaultValue?: string) => CliCommand;
  action: (fn: (...args: unknown[]) => void | Promise<void>) => CliCommand;
  command: (name: string) => CliCommand;
};

export function registerMentatCli(api: PluginApi, client: MentatClient) {
  api.registerCli(
    ({ program }) => {
      const mentat = program.command("mentat").description("Mentat RAG bridge commands");

      mentat
        .command("status")
        .description("Show Mentat server status and statistics")
        .action(async () => {
          const healthy = await client.checkHealth();
          console.log(
            `Mentat server: ${healthy ? "healthy" : "unreachable"} (${client.isHealthy() ? "UP" : "DOWN"})`,
          );
          if (!healthy) return;

          const stats = await client.getStats();
          if (stats) {
            console.log(`  Documents: ${stats.total_docs}`);
            console.log(`  Chunks: ${stats.total_chunks}`);
            console.log(`  Collections: ${stats.total_collections}`);
            if (stats.pending_tasks != null) {
              console.log(`  Pending tasks: ${stats.pending_tasks}`);
            }
          }
        });

      mentat
        .command("search")
        .description("Search indexed documents")
        .argument("<query>", "Search query")
        .option("--top-k <n>", "Max results", "5")
        .option("--grouped", "Group by document")
        .option("--collection <name>", "Scope to collection")
        .action(async (...args: unknown[]) => {
          const query = args[0] as string;
          const opts = (args[1] ?? {}) as { topK?: string; grouped?: boolean; collection?: string };
          if (!client.isHealthy()) {
            console.log("Mentat server is not available.");
            return;
          }

          const topK = parseInt(opts.topK ?? "5", 10);

          if (opts.grouped) {
            const results = await client.searchGrouped({
              query,
              top_k: topK,
              collection: opts.collection,
            });
            if (!results || results.length === 0) {
              console.log("No results found.");
              return;
            }
            for (const doc of results) {
              console.log(`\n📄 ${doc.filename} (${doc.doc_id})`);
              if (doc.brief_intro) console.log(`   ${doc.brief_intro}`);
              for (const chunk of doc.chunks) {
                console.log(`   - [${chunk.section}] ${chunk.content?.slice(0, 100) ?? ""}`);
              }
            }
          } else {
            const results = await client.search({
              query,
              top_k: topK,
              collection: opts.collection,
            });
            if (!results || results.length === 0) {
              console.log("No results found.");
              return;
            }
            console.log(
              JSON.stringify(
                results.map((r) => ({
                  doc_id: r.doc_id,
                  filename: r.filename,
                  section: r.section,
                  score: r.score,
                  content: r.content?.slice(0, 200),
                })),
                null,
                2,
              ),
            );
          }
        });

      mentat
        .command("collections")
        .description("List all collections")
        .action(async () => {
          if (!client.isHealthy()) {
            console.log("Mentat server is not available.");
            return;
          }
          const collections = await client.listCollections();
          if (!collections || collections.length === 0) {
            console.log("No collections.");
            return;
          }
          for (const c of collections) {
            const meta = c.metadata ? ` (${JSON.stringify(c.metadata)})` : "";
            console.log(`  ${c.name}: ${c.doc_count} docs${meta}`);
          }
        });

      mentat
        .command("stats")
        .description("Show detailed indexing statistics")
        .action(async () => {
          if (!client.isHealthy()) {
            console.log("Mentat server is not available.");
            return;
          }
          const stats = await client.getStats();
          console.log(JSON.stringify(stats, null, 2));
        });
    },
    { commands: ["mentat"] },
  );
}
