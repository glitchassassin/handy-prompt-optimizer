import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { PromptLabStore } from "../src/db.js";
import { readHandyHistory } from "../src/handy.js";
import {
  applyModelDefaults,
  LmStudioClient,
  renderPrompt,
} from "../src/lm-studio.js";
import { normalizeTranscript, scoreTranscript } from "../src/normalize.js";

const ROOT = resolve(import.meta.dirname, "..");

function temporaryDirectory(t) {
  const directory = mkdtempSync(resolve(tmpdir(), "handy-prompts-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createHandyFixture(path, rows) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE transcription_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      saved BOOLEAN NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      transcription_text TEXT NOT NULL,
      post_processed_text TEXT,
      post_process_prompt TEXT,
      post_process_requested BOOLEAN NOT NULL DEFAULT 0
    )
  `);
  const insert = db.prepare(`
    INSERT INTO transcription_history (
      id, file_name, timestamp, saved, title, transcription_text,
      post_processed_text, post_process_prompt, post_process_requested
    ) VALUES (?, ?, ?, 0, ?, ?, ?, NULL, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.fileName,
      row.timestamp,
      row.title,
      row.raw,
      row.handyOutput ?? null,
      row.handyOutput ? 1 : 0
    );
  }
  db.close();
}

async function connectClient(t, { historyRows } = {}) {
  const directory = temporaryDirectory(t);
  const historyPath = resolve(directory, "history.db");
  const databasePath = resolve(directory, "prompt-lab.sqlite");
  createHandyFixture(
    historyPath,
    historyRows ?? [
      {
        id: 1,
        fileName: "handy-100.wav",
        timestamp: 100,
        title: "Older",
        raw: "hello world period",
      },
      {
        id: 2,
        fileName: "handy-200.wav",
        timestamp: 200,
        title: "Newer",
        raw: "what time is it question mark",
      },
    ]
  );

  const client = new Client(
    {
      name: "handy-optimized-prompts-test",
      version: "0.2.0",
    },
    {
      capabilities: {
        elicitation: { form: {} },
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
    }
  );
  client.setRequestHandler(ElicitRequestSchema, async () => ({
    action: "accept",
    content: { decision: "cancel" },
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(ROOT, "src/server.js"), "--stdio"],
    env: {
      ...process.env,
      HANDY_PROMPTS_DB: databasePath,
      HANDY_HISTORY_DB: historyPath,
      LM_STUDIO_HOME: resolve(directory, ".lmstudio"),
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, directory, historyPath, databasePath };
}

test("normalizes only encoding and whitespace artifacts", () => {
  assert.equal(
    normalizeTranscript("  Cafe\u0301\u00a0  test \r\nnext\t line  "),
    "Café test\nnext line"
  );
  assert.notEqual(normalizeTranscript("Hello."), normalizeTranscript("hello."));
  assert.notEqual(normalizeTranscript("Hello—world"), normalizeTranscript("Hello-world"));

  const score = scoreTranscript("Hello  world.", "Hello world.");
  assert.equal(score.rawExact, false);
  assert.equal(score.normalizedExact, true);
});

test("reads Handy history without using post-processed text", (t) => {
  const directory = temporaryDirectory(t);
  const historyPath = resolve(directory, "history.db");
  createHandyFixture(historyPath, [
    {
      id: 7,
      fileName: "handy-7.wav",
      timestamp: 700,
      title: "Fixture",
      raw: "raw words period",
      handyOutput: "This output must be ignored.",
    },
  ]);
  const rows = readHandyHistory(historyPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transcription_text, "raw words period");
  assert.equal("post_processed_text" in rows[0], false);
  assert.equal(rows[0].source_key.length, 64);
});

test("stores proposals, approvals, and a chronological holdout", (t) => {
  const directory = temporaryDirectory(t);
  const historyPath = resolve(directory, "history.db");
  createHandyFixture(
    historyPath,
    Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      fileName: `handy-${index + 1}.wav`,
      timestamp: 100 + index,
      title: `Record ${index + 1}`,
      raw: `record ${index + 1} period`,
    }))
  );

  const store = new PromptLabStore(resolve(directory, "lab.sqlite"));
  t.after(() => store.close());
  assert.equal(store.importHandyRows(readHandyHistory(historyPath)).imported, 10);
  assert.equal(store.importHandyRows(readHandyHistory(historyPath)).imported, 0);

  const page = store.listNeedingProposals({ limit: 20 });
  assert.equal(page.records.length, 10);
  store.saveProposals(
    page.records.map((record) => ({
      recordId: record.id,
      proposedText: `Record ${record.handyHistoryId}.`,
    }))
  );
  for (const record of page.records) {
    store.saveAnnotation({
      recordId: record.id,
      correctedText: `Record ${record.handyHistoryId}.`,
      status: "approved",
    });
  }

  const dataset = store.createDataset({ holdoutFraction: 0.2 });
  assert.equal(dataset.developmentCount, 8);
  assert.equal(dataset.holdoutCount, 2);
  assert.equal(store.getWorkflowPhase(), "optimization");

  const development = store.listDatasetExamples(
    dataset.id,
    "development",
    { limit: 20 }
  );
  const holdout = store.listDatasetExamples(dataset.id, "holdout", {
    limit: 20,
  });
  assert.deepEqual(
    holdout.map(({ record }) => record.handyHistoryId),
    [9, 10]
  );
  assert.equal(development.at(-1).record.handyHistoryId, 8);
});

test("MCP workflow syncs, saves proposals, and drives widget navigation", async (t) => {
  const { client } = await connectClient(t);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.ok(names.includes("sync_handy_history"));
  assert.ok(names.includes("list_transcripts_needing_proposals"));
  assert.ok(names.includes("show_annotation_lab"));
  assert.ok(names.includes("prepare_optimization_dataset"));
  assert.ok(names.includes("run_holdout_eval"));

  const sync = await client.callTool({
    name: "sync_handy_history",
    arguments: {},
  });
  assert.equal(sync.structuredContent.imported, 2);

  const pending = await client.callTool({
    name: "list_transcripts_needing_proposals",
    arguments: { limit: 20 },
  });
  assert.equal(pending.structuredContent.records.length, 2);
  const [first, second] = pending.structuredContent.records;

  const saved = await client.callTool({
    name: "save_correction_proposals",
    arguments: {
      proposals: [
        { recordId: first.id, proposedText: "Hello world." },
        { recordId: second.id, proposedText: "What time is it?" },
      ],
    },
  });
  assert.equal(saved.structuredContent.saved.length, 2);

  const opened = await client.callTool({
    name: "show_annotation_lab",
    arguments: {},
  });
  assert.equal(opened.structuredContent.progress.total, 2);
  assert.equal(opened.structuredContent.record.id, first.id);
  const batchId = opened.structuredContent.batchId;

  const next = await client.callTool({
    name: "save_annotation_and_next",
    arguments: {
      batchId,
      recordId: first.id,
      correctedText: "Hello world.",
      status: "approved",
      notes: "",
    },
  });
  assert.equal(next.structuredContent.record.id, second.id);

  const complete = await client.callTool({
    name: "save_annotation_and_next",
    arguments: {
      batchId,
      recordId: second.id,
      correctedText: "What time is it?",
      status: "approved",
      notes: "",
    },
  });
  assert.equal(complete.structuredContent.progress.complete, true);
  assert.equal(complete.structuredContent.record, null);

  const dataset = await client.callTool({
    name: "prepare_optimization_dataset",
    arguments: {
      freshTaskConfirmation: "I am in a fresh optimization task",
      holdoutFraction: 0.2,
    },
  });
  assert.equal(dataset.structuredContent.developmentCount, 1);
  assert.equal(dataset.structuredContent.holdoutCount, 1);

  const examples = await client.callTool({
    name: "get_development_examples",
    arguments: {},
  });
  assert.equal(examples.structuredContent.examples.length, 1);
  assert.equal(examples.structuredContent.examples[0].recordId, first.id);

  const blocked = await client.callTool({
    name: "list_transcripts_needing_proposals",
    arguments: {},
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.structuredContent.error, /Current phase: optimization/);
});

test("serves the production annotation widget without model-context updates", async (t) => {
  const { client } = await connectClient(t);
  const result = await client.readResource({
    uri: "ui://handy-optimized-prompts/annotation-lab-v2.html",
  });
  const html = result.contents[0].text;
  assert.equal(result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(html, /Handy transcript annotations/);
  assert.match(html, /save_annotation_and_next/);
  assert.match(html, /load_annotation_record/);
  assert.doesNotMatch(html, /ui\/update-model-context/);
});

test("LM Studio evaluation restores the initially loaded model", async (t) => {
  const directory = temporaryDirectory(t);
  const state = {
    models: [
      {
        type: "llm",
        key: "model-a",
        display_name: "Model A",
        loaded_instances: [],
      },
      {
        type: "llm",
        key: "model-b",
        display_name: "Model B",
        loaded_instances: [
          { id: "model-b", config: { context_length: 4096 } },
        ],
      },
    ],
    events: [],
    chatRequests: [],
  };
  class FakeLmStudioClient extends LmStudioClient {
    constructor() {
      super({ baseUrl: "http://lm-studio.test", timeoutMs: 5000 });
    }

    async request(path, { body = {} } = {}) {
      if (path === "/api/v1/models") {
        return { models: state.models };
      }
      if (path === "/api/v1/models/unload") {
        state.events.push(`unload:${body.instance_id}`);
        for (const model of state.models) {
          model.loaded_instances = model.loaded_instances.filter(
            (instance) => instance.id !== body.instance_id
          );
        }
        return { instance_id: body.instance_id };
      }
      if (path === "/api/v1/models/load") {
        state.events.push(`load:${body.model}`);
        const model = state.models.find((item) => item.key === body.model);
        model.loaded_instances = [
          {
            id: body.model,
            config: { context_length: body.context_length ?? 4096 },
          },
        ];
        return {
          type: "llm",
          instance_id: body.model,
          status: "loaded",
          load_config: model.loaded_instances[0].config,
        };
      }
      if (path === "/v1/chat/completions") {
        state.events.push(`chat:${body.model}`);
        state.chatRequests.push(body);
        const text = body.messages[0].content;
        return {
          choices: [{ message: { role: "assistant", content: text } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        };
      }
      throw new Error(`Unexpected fake LM Studio request: ${path}`);
    }
  }

  const historyPath = resolve(directory, "history.db");
  createHandyFixture(historyPath, [
    {
      id: 1,
      fileName: "one.wav",
      timestamp: 1,
      title: "One",
      raw: "Exact target.",
    },
  ]);
  const store = new PromptLabStore(resolve(directory, "lab.sqlite"));
  t.after(() => store.close());
  store.importHandyRows(readHandyHistory(historyPath));
  const record = store.listNeedingProposals({ limit: 1 }).records[0];
  store.saveProposals([
    { recordId: record.id, proposedText: "Exact target." },
  ]);
  store.saveAnnotation({
    recordId: record.id,
    correctedText: "Exact target.",
    status: "approved",
  });
  const dataset = store.createDataset({ holdoutFraction: 0 });
  const candidate = store.createCandidate({
    name: "Exact",
    prompt: "${output}",
    model: "model-a",
    settings: { temperature: 0, maxTokens: 64 },
  });
  const client = new FakeLmStudioClient();
  const run = await client.evaluate({
    store,
    candidate,
    dataset,
    split: "development",
  });
  assert.equal(run.passed, 1);
  assert.equal(state.chatRequests[0].reasoning_effort, "none");
  assert.equal("reasoning" in state.chatRequests[0], false);
  assert.deepEqual(state.chatRequests[0].messages, [
    { role: "user", content: "Exact target." },
  ]);
  assert.equal(state.chatRequests[0].temperature, 0);
  assert.equal(state.chatRequests[0].max_tokens, 64);
  assert.deepEqual(state.events, [
    "unload:model-b",
    "load:model-a",
    "chat:model-a",
    "unload:model-a",
    "load:model-b",
  ]);
  assert.equal(state.models[1].loaded_instances[0].id, "model-b");
});

test("backs up and updates LM Studio per-model defaults", (t) => {
  const directory = temporaryDirectory(t);
  const configPath = resolve(
    directory,
    ".internal",
    "user-concrete-model-default-config",
    "google",
    "gemma-4-e2b.json"
  );
  const parent = resolve(configPath, "..");
  // applyModelDefaults creates parent directories, so seed through a first write.
  const first = applyModelDefaults(directory, "google/gemma-4-e2b", {
    temperature: 0.2,
    maxTokens: 200,
  });
  assert.equal(first.backupPath, null);
  const seeded = JSON.parse(readFileSync(configPath, "utf8"));
  seeded.operation.fields.push({
    key: "ext.virtualModel.customField.google.gemma4E2b.enableThinking",
    value: false,
  });
  writeFileSync(configPath, `${JSON.stringify(seeded, null, 2)}\n`);

  const applied = applyModelDefaults(directory, "google/gemma-4-e2b", {
    temperature: 0,
    maxTokens: 512,
    topK: 20,
  });
  assert.ok(applied.backupPath);
  assert.equal(existsSync(applied.backupPath), true);
  const updated = JSON.parse(readFileSync(configPath, "utf8"));
  const fields = Object.fromEntries(
    updated.operation.fields.map((field) => [field.key, field.value])
  );
  assert.equal(fields["llm.prediction.temperature"], 0);
  assert.equal(fields["llm.prediction.maxPredictedTokens"], 512);
  assert.equal(fields["llm.prediction.topKSampling"], 20);
  assert.equal(
    fields["ext.virtualModel.customField.google.gemma4E2b.enableThinking"],
    false
  );
  assert.equal(parent.endsWith("google"), true);
});

test("renders Handy prompt templates", () => {
  assert.equal(
    renderPrompt("Clean:\n${output}", "hello period"),
    "Clean:\nhello period"
  );
  assert.throws(
    () => renderPrompt("Clean this", "hello period"),
    /must include the literal "\$\{output\}" placeholder/
  );
});
