#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectory = mkdtempSync(
  resolve(tmpdir(), "handy-prompts-smoke-")
);
const client = new Client(
  { name: "handy-optimized-prompts-smoke-test", version: "0.2.0" },
  {
    capabilities: {
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    },
  }
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, "src/server.js"), "--stdio"],
  env: {
    ...process.env,
    HANDY_PROMPTS_DB: resolve(temporaryDirectory, "smoke.sqlite"),
  },
  stderr: "inherit",
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const resources = await client.listResources();
  const prompts = await client.listPrompts();
  const widget = await client.readResource({
    uri: "ui://handy-optimized-prompts/annotation-lab-v2.html",
  });
  const sync = await client.callTool({
    name: "sync_handy_history",
    arguments: {},
  });
  const pending = await client.callTool({
    name: "list_transcripts_needing_proposals",
    arguments: { limit: 20 },
  });

  console.log(
    JSON.stringify(
      {
        server: client.getServerVersion(),
        toolNames: tools.tools.map((tool) => tool.name),
        resources: resources.resources.map((resource) => resource.uri),
        prompts: prompts.prompts.map((prompt) => prompt.name),
        widgetMimeType: widget.contents[0].mimeType,
        widgetBytes: widget.contents[0].text.length,
        sync: sync.structuredContent,
        pendingRecords: pending.structuredContent.records.length,
      },
      null,
      2
    )
  );
} finally {
  await client.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
