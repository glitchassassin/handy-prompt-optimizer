#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { defaults, lmStudioConfig, paths } from "./config.js";
import { PromptLabStore } from "./db.js";
import { readHandyHistory } from "./handy.js";
import {
  applyModelDefaults,
  LmStudioClient,
  normalizeCandidateSettings,
  planModelDefaults,
} from "./lm-studio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDGET_URI = "ui://handy-optimized-prompts/annotation-lab-v2.html";
const ABOUT_URI = "handy-prompts://about";
const VERSION = "0.2.0";
const widgetHtml = readFileSync(resolve(HERE, "widget.html"), "utf8");

const readOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
};

const writeAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
};

function textResult(text, structuredContent, meta) {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

function errorResult(title, error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `${title}: ${message}` }],
    structuredContent: {
      error: message,
      ...extra,
    },
  };
}

function assertPhase(store, expected) {
  const actual = store.getWorkflowPhase();
  if (actual !== expected) {
    throw new Error(
      `This operation is only available during the ${expected} phase. Current phase: ${actual}.`
    );
  }
}

function annotationPayload(record) {
  if (!record) return null;
  return {
    id: record.id,
    title: record.title,
    timestamp: record.timestamp,
    raw: record.raw,
    proposed: record.proposed,
    corrected: record.corrected,
    status: record.status,
    notes: record.notes,
    proposalAuthor: record.proposalAuthor,
  };
}

function batchPayload(store, batch, index) {
  const safeIndex = Math.max(0, Math.min(index, Math.max(0, batch.ids.length - 1)));
  const record = batch.ids.length
    ? annotationPayload(store.getRecord(batch.ids[safeIndex]))
    : null;
  return {
    batchId: batch.id,
    record,
    progress: {
      index: record ? safeIndex + 1 : 0,
      total: batch.ids.length,
      remaining: record ? batch.ids.length - safeIndex - 1 : 0,
      complete: !record,
    },
    summary: store.annotationSummary(),
  };
}

function capabilitySnapshot(server) {
  const protocol = server.server;
  return {
    observedAt: new Date().toISOString(),
    clientInfo: protocol.getClientVersion?.() ?? null,
    clientCapabilities: protocol.getClientCapabilities?.() ?? null,
  };
}

export function createHandyPromptServer({
  databasePath = paths.database,
  handyHistoryPath = paths.handyHistory,
  lmStudioHome = paths.lmStudioHome,
  lmClient = new LmStudioClient(lmStudioConfig),
} = {}) {
  const store = new PromptLabStore(databasePath);
  const batches = new Map();
  const server = new McpServer(
    {
      name: "handy-optimized-prompts",
      version: VERSION,
    },
    {
      instructions: [
        "This server builds a user-approved evaluation corpus from Handy's local raw transcript history and evaluates local LM Studio post-processing prompts.",
        "Annotation workflow: call sync_handy_history, list_transcripts_needing_proposals, generate conservative corrections yourself, save_correction_proposals, then show_annotation_lab.",
        "Generate proposals in batches of at most 20. A proposal is never an approved target; only widget approval creates an evaluation target.",
        "End the annotation task after review. Start a fresh Codex task before calling prepare_optimization_dataset so holdout transcripts are absent from prompt-revision context.",
        "Optimization workflow: call prepare_optimization_dataset with the exact fresh-task confirmation, inspect development examples, create candidates, and run development evals.",
        "Holdout evals expose aggregates only. Never attempt to access annotation tools during optimization; the server phase lock enforces this.",
        "Handy's history and settings are read-only. LM Studio defaults may change only through promote_candidate_to_lm_studio after elicitation approval and a backup.",
      ].join("\n"),
      capabilities: {
        logging: {},
      },
    }
  );

  registerAppResource(
    server,
    "handy-annotation-lab",
    WIDGET_URI,
    {
      title: "Handy transcript annotation",
      description:
        "Review Codex proposals and save user-approved transcript targets.",
    },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
            },
            "openai/widgetDescription":
              "Review Codex transcript corrections, edit them, and save approved targets.",
          },
        },
      ],
    })
  );

  server.registerTool(
    "capability_report",
    {
      title: "Report MCP client capabilities",
      description:
        "Reports client information and capabilities advertised to this MCP server.",
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      const report = capabilitySnapshot(server);
      return textResult(JSON.stringify(report, null, 2), report);
    }
  );

  server.registerTool(
    "sync_handy_history",
    {
      title: "Sync raw Handy transcript history",
      description:
        "Reads Handy's local history database without modifying it and imports new raw transcripts into the prompt lab.",
      inputSchema: {},
      annotations: writeAnnotations,
    },
    async () => {
      try {
        assertPhase(store, "annotation");
        const result = store.importHandyRows(readHandyHistory(handyHistoryPath));
        const payload = {
          ...result,
          historyPath: handyHistoryPath,
          summary: store.annotationSummary(),
        };
        return textResult(
          `Handy sync found ${result.discovered} usable transcripts and imported ${result.imported}.`,
          payload
        );
      } catch (error) {
        return errorResult("Handy history sync failed", error);
      }
    }
  );

  server.registerTool(
    "list_transcripts_needing_proposals",
    {
      title: "List transcripts needing Codex proposals",
      description:
        "Returns a bounded batch of raw transcripts. Generate a conservative corrected transcript for every record, then call save_correction_proposals.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(defaults.annotationBatchSize),
        cursor: z.string().optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ limit, cursor }) => {
      try {
        assertPhase(store, "annotation");
        const page = store.listNeedingProposals({ limit, cursor });
        const payload = {
          records: page.records.map((record) => ({
            id: record.id,
            timestamp: record.timestamp,
            title: record.title,
            raw: record.raw,
          })),
          remaining: page.remaining,
          nextCursor: page.nextCursor,
          proposalInstructions:
            "Fix punctuation, capitalization, spoken punctuation, number formatting, filler words, and obvious transcription errors. Preserve meaning and word order. Return only the corrected transcript for each record.",
        };
        return textResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return errorResult("Could not list transcripts", error);
      }
    }
  );

  server.registerTool(
    "save_correction_proposals",
    {
      title: "Save Codex correction proposals",
      description:
        "Stores Codex-generated proposals for later user review. Proposals do not enter the evaluation set until the user approves them.",
      inputSchema: {
        proposals: z
          .array(
            z.object({
              recordId: z.string(),
              proposedText: z.string().min(1),
            })
          )
          .min(1)
          .max(50),
        author: z.string().default("Codex"),
      },
      annotations: writeAnnotations,
    },
    async ({ proposals, author }) => {
      try {
        assertPhase(store, "annotation");
        const result = store.saveProposals(proposals, author);
        return textResult(
          `Saved ${result.saved.length} correction proposals.`,
          {
            ...result,
            summary: store.annotationSummary(),
          }
        );
      } catch (error) {
        return errorResult("Could not save proposals", error);
      }
    }
  );

  registerAppTool(
    server,
    "show_annotation_lab",
    {
      title: "Show Handy annotation lab",
      description:
        "Opens a widget for editing and approving a batch of Codex transcript proposals.",
      inputSchema: {
        recordIds: z.array(z.string()).min(1).max(50).optional(),
        limit: z.number().int().min(1).max(50).default(defaults.annotationBatchSize),
      },
      annotations: readOnlyAnnotations,
      _meta: {
        ui: {
          resourceUri: WIDGET_URI,
          visibility: ["model", "app"],
        },
        "openai/outputTemplate": WIDGET_URI,
        "openai/toolInvocation/invoking": "Opening Handy annotations…",
        "openai/toolInvocation/invoked": "Handy annotations ready",
      },
    },
    async ({ recordIds, limit }) => {
      try {
        assertPhase(store, "annotation");
        const records = recordIds
          ? store
              .getRecords(recordIds)
              .filter(
                (record) => record.proposed && !["approved", "edited", "skipped"].includes(record.status)
              )
          : store.listProposed({ limit });
        const batch = {
          id: `batch-${randomUUID()}`,
          ids: records.map((record) => record.id),
        };
        batches.set(batch.id, batch);
        const payload = batchPayload(store, batch, 0);
        return textResult(
          records.length
            ? `Opened an annotation batch with ${records.length} records.`
            : "No proposed transcripts are waiting for annotation.",
          payload
        );
      } catch (error) {
        return errorResult("Could not open annotation lab", error);
      }
    }
  );

  server.registerTool(
    "annotation_summary",
    {
      title: "Summarize annotation progress",
      description:
        "Returns counts for imported, proposed, approved, edited, and skipped transcripts.",
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      const summary = {
        phase: store.getWorkflowPhase(),
        ...store.annotationSummary(),
      };
      return textResult(JSON.stringify(summary, null, 2), summary);
    }
  );

  registerAppTool(
    server,
    "load_annotation_record",
    {
      title: "Load annotation record",
      description:
        "Loads a record from the current annotation widget batch.",
      inputSchema: {
        batchId: z.string(),
        index: z.number().int().min(0),
      },
      annotations: readOnlyAnnotations,
      _meta: {
        ui: {
          resourceUri: WIDGET_URI,
          visibility: ["app"],
        },
      },
    },
    async ({ batchId, index }) => {
      try {
        assertPhase(store, "annotation");
        const batch = batches.get(batchId);
        if (!batch) throw new Error(`Unknown annotation batch: ${batchId}`);
        return textResult("Annotation record loaded.", batchPayload(store, batch, index));
      } catch (error) {
        return errorResult("Could not load annotation record", error);
      }
    }
  );

  registerAppTool(
    server,
    "save_annotation_and_next",
    {
      title: "Save annotation and load next",
      description:
        "Saves a user-reviewed transcript target, then returns the next record in the widget batch.",
      inputSchema: {
        batchId: z.string(),
        recordId: z.string(),
        correctedText: z.string(),
        status: z.enum(["approved", "edited", "skipped"]),
        notes: z.string().optional(),
      },
      annotations: writeAnnotations,
      _meta: {
        ui: {
          resourceUri: WIDGET_URI,
          visibility: ["app"],
        },
      },
    },
    async ({ batchId, recordId, correctedText, status, notes }) => {
      try {
        assertPhase(store, "annotation");
        const batch = batches.get(batchId);
        if (!batch) throw new Error(`Unknown annotation batch: ${batchId}`);
        const index = batch.ids.indexOf(recordId);
        if (index < 0) throw new Error("Record is not part of this annotation batch.");
        if (status !== "skipped" && !correctedText.trim()) {
          throw new Error("Approved and edited annotations require corrected text.");
        }
        const saved = store.saveAnnotation({
          recordId,
          correctedText,
          status,
          notes,
        });
        const nextIndex = index + 1;
        const payload =
          nextIndex < batch.ids.length
            ? batchPayload(store, batch, nextIndex)
            : {
                batchId,
                record: null,
                progress: {
                  index: batch.ids.length,
                  total: batch.ids.length,
                  remaining: 0,
                  complete: true,
                },
                summary: store.annotationSummary(),
              };
        payload.saved = {
          recordId: saved.id,
          status: saved.status,
        };
        return textResult(
          `Saved ${recordId} as ${status}.`,
          payload
        );
      } catch (error) {
        return errorResult("Could not save annotation", error);
      }
    }
  );

  server.registerTool(
    "prepare_optimization_dataset",
    {
      title: "Seal an optimization dataset",
      description:
        "Creates a chronological development/holdout split and locks annotation access. Call only from a fresh Codex task that has not seen transcript proposals.",
      inputSchema: {
        freshTaskConfirmation: z.literal(
          "I am in a fresh optimization task"
        ),
        holdoutFraction: z.number().min(0).max(0.5).default(defaults.holdoutFraction),
      },
      annotations: writeAnnotations,
    },
    async ({ holdoutFraction }) => {
      try {
        assertPhase(store, "annotation");
        const dataset = store.createDataset({ holdoutFraction });
        return textResult(
          `Created ${dataset.id} with ${dataset.developmentCount} development and ${dataset.holdoutCount} sealed holdout records.`,
          dataset
        );
      } catch (error) {
        return errorResult("Could not prepare optimization dataset", error);
      }
    }
  );

  server.registerTool(
    "get_development_examples",
    {
      title: "Get prompt-development examples",
      description:
        "Returns approved raw/target pairs from the development split. Holdout records are never returned.",
      inputSchema: {
        datasetId: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ datasetId, limit, offset }) => {
      try {
        assertPhase(store, "optimization");
        const dataset = store.getDataset(datasetId);
        if (!dataset) throw new Error("No active optimization dataset exists.");
        const examples = store
          .listDatasetExamples(dataset.id, "development", { limit, offset })
          .map(({ record, ordinal }) => ({
            recordId: record.id,
            ordinal,
            raw: record.raw,
            expected: record.corrected,
          }));
        const payload = {
          dataset,
          examples,
          nextOffset:
            offset + examples.length < dataset.developmentCount
              ? offset + examples.length
              : null,
        };
        return textResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return errorResult("Could not get development examples", error);
      }
    }
  );

  server.registerTool(
    "list_lm_studio_models",
    {
      title: "List local LM Studio models",
      description:
        "Lists downloaded local models and loaded instances from LM Studio. It does not download or change models.",
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        const models = (await lmClient.listModels()).map((model) => ({
          key: model.key,
          displayName: model.display_name,
          type: model.type,
          format: model.format,
          quantization: model.quantization,
          params: model.params_string,
          loadedInstances: model.loaded_instances ?? [],
          reasoning: model.capabilities?.reasoning ?? null,
        }));
        return textResult(JSON.stringify(models, null, 2), { models });
      } catch (error) {
        return errorResult("Could not reach LM Studio", error, {
          baseUrl: lmClient.baseUrl,
        });
      }
    }
  );

  server.registerTool(
    "create_prompt_candidate",
    {
      title: "Create a versioned prompt candidate",
      description:
        "Stores an immutable Handy-compatible prompt template, model, and inference settings for evaluation. The prompt must contain ${output}.",
      inputSchema: {
        name: z.string().min(1),
        prompt: z
          .string()
          .min(1)
          .refine((value) => value.includes("${output}"), {
            message: 'Prompt must include the literal "${output}" placeholder.',
          }),
        model: z.string().min(1),
        settings: z
          .object({
            temperature: z.number().min(0).max(2).default(0),
            maxTokens: z.number().int().min(1).max(8192).default(512),
            topP: z.number().min(0).max(1).optional(),
            topK: z.number().int().min(0).optional(),
            minP: z.number().min(0).max(1).optional(),
            repeatPenalty: z.number().min(0).optional(),
          })
          .default({
            temperature: 0,
            maxTokens: 512,
          }),
      },
      annotations: writeAnnotations,
    },
    async ({ name, prompt, model, settings }) => {
      try {
        assertPhase(store, "optimization");
        const candidate = store.createCandidate({
          name,
          prompt,
          model,
          settings: normalizeCandidateSettings(settings),
        });
        return textResult(`Created prompt candidate ${candidate.id}.`, candidate);
      } catch (error) {
        return errorResult("Could not create prompt candidate", error);
      }
    }
  );

  server.registerTool(
    "run_development_eval",
    {
      title: "Run prompt candidate on development set",
      description:
        "Sequentially evaluates a candidate against development examples, recording exact-match and latency metrics. LM Studio's prior model state is restored afterward.",
      inputSchema: {
        candidateId: z.string(),
        datasetId: z.string().optional(),
      },
      annotations: writeAnnotations,
    },
    async ({ candidateId, datasetId }) => {
      try {
        assertPhase(store, "optimization");
        const candidate = store.getCandidate(candidateId);
        const dataset = store.getDataset(datasetId);
        if (!candidate) throw new Error(`Unknown candidate: ${candidateId}`);
        if (!dataset) throw new Error("No active optimization dataset exists.");
        const run = await lmClient.evaluate({
          store,
          candidate,
          dataset,
          split: "development",
        });
        return textResult(JSON.stringify(run, null, 2), run);
      } catch (error) {
        return errorResult("Development evaluation failed", error);
      }
    }
  );

  server.registerTool(
    "get_development_failures",
    {
      title: "Get failed development cases",
      description:
        "Returns detailed failed examples for a development evaluation. Holdout evaluation details are never exposed.",
      inputSchema: {
        runId: z.string(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ runId, limit }) => {
      try {
        assertPhase(store, "optimization");
        const run = store.getEvalRun(runId);
        if (!run) throw new Error(`Unknown evaluation run: ${runId}`);
        if (run.split !== "development") {
          throw new Error("Detailed holdout failures are sealed.");
        }
        const failures = store.listEvalFailures(runId, {
          limit,
          includeText: true,
        });
        return textResult(JSON.stringify(failures, null, 2), {
          run,
          failures,
        });
      } catch (error) {
        return errorResult("Could not get development failures", error);
      }
    }
  );

  server.registerTool(
    "freeze_prompt_candidate",
    {
      title: "Freeze prompt candidate",
      description:
        "Freezes a candidate before sealed holdout evaluation.",
      inputSchema: {
        candidateId: z.string(),
      },
      annotations: writeAnnotations,
    },
    async ({ candidateId }) => {
      try {
        assertPhase(store, "optimization");
        const candidate = store.freezeCandidate(candidateId);
        if (!candidate) throw new Error(`Unknown candidate: ${candidateId}`);
        return textResult(`Frozen ${candidate.id}.`, candidate);
      } catch (error) {
        return errorResult("Could not freeze candidate", error);
      }
    }
  );

  server.registerTool(
    "run_holdout_eval",
    {
      title: "Run sealed holdout evaluation",
      description:
        "Evaluates a frozen candidate on the sealed holdout. Returns aggregate metrics only.",
      inputSchema: {
        candidateId: z.string(),
        datasetId: z.string().optional(),
      },
      annotations: writeAnnotations,
    },
    async ({ candidateId, datasetId }) => {
      try {
        assertPhase(store, "optimization");
        const candidate = store.getCandidate(candidateId);
        const dataset = store.getDataset(datasetId);
        if (!candidate) throw new Error(`Unknown candidate: ${candidateId}`);
        if (!candidate.frozenAt) {
          throw new Error("Freeze the candidate before holdout evaluation.");
        }
        if (!dataset) throw new Error("No active optimization dataset exists.");
        if (dataset.holdoutCount === 0) {
          throw new Error("This dataset has no holdout records.");
        }
        const run = await lmClient.evaluate({
          store,
          candidate,
          dataset,
          split: "holdout",
        });
        const sealed = {
          id: run.id,
          candidateId: run.candidateId,
          datasetId: run.datasetId,
          split: run.split,
          status: run.status,
          total: run.total,
          passed: run.passed,
          failed: run.failed,
          normalizedExactRate: run.normalizedExactRate,
          rawExactRate: run.rawExactRate,
          averageLatencyMs: run.averageLatencyMs,
          error: run.error,
        };
        return textResult(JSON.stringify(sealed, null, 2), sealed);
      } catch (error) {
        return errorResult("Holdout evaluation failed", error);
      }
    }
  );

  server.registerTool(
    "plan_lm_studio_promotion",
    {
      title: "Plan LM Studio defaults update",
      description:
        "Shows the exact LM Studio per-model defaults file and fields that would be changed for a candidate. Makes no changes.",
      inputSchema: {
        candidateId: z.string(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ candidateId }) => {
      try {
        assertPhase(store, "optimization");
        const candidate = store.getCandidate(candidateId);
        if (!candidate) throw new Error(`Unknown candidate: ${candidateId}`);
        const plan = planModelDefaults(
          lmStudioHome,
          candidate.model,
          candidate.settings
        );
        return textResult(JSON.stringify(plan, null, 2), {
          candidateId,
          model: candidate.model,
          settings: candidate.settings,
          ...plan,
        });
      } catch (error) {
        return errorResult("Could not plan LM Studio promotion", error);
      }
    }
  );

  server.registerTool(
    "promote_candidate_to_lm_studio",
    {
      title: "Promote candidate settings to LM Studio",
      description:
        "After form confirmation, backs up and updates LM Studio's per-model defaults for a frozen candidate that completed holdout evaluation. Handy remains read-only.",
      inputSchema: {
        candidateId: z.string(),
      },
      annotations: writeAnnotations,
    },
    async ({ candidateId }) => {
      try {
        assertPhase(store, "optimization");
        const candidate = store.getCandidate(candidateId);
        if (!candidate) throw new Error(`Unknown candidate: ${candidateId}`);
        if (!candidate.frozenAt) throw new Error("Candidate is not frozen.");
        if (!store.hasCompletedHoldoutEval(candidateId)) {
          throw new Error("Candidate has not completed a holdout evaluation.");
        }
        const plan = planModelDefaults(
          lmStudioHome,
          candidate.model,
          candidate.settings
        );
        const confirmation = await server.server.elicitInput({
          mode: "form",
          message:
            "Apply this candidate's inference settings as LM Studio per-model defaults? The existing file will be backed up. Handy's prompt and history will not be modified.",
          requestedSchema: {
            type: "object",
            properties: {
              decision: {
                type: "string",
                title: "Promotion decision",
                enum: ["apply", "cancel"],
                enumNames: ["Apply settings", "Cancel"],
                default: "cancel",
              },
              model: {
                type: "string",
                title: "LM Studio model",
                default: candidate.model,
                readOnly: true,
              },
              configPath: {
                type: "string",
                title: "Configuration file",
                default: plan.configPath,
                readOnly: true,
              },
            },
            required: ["decision"],
          },
        });
        if (
          confirmation.action !== "accept" ||
          confirmation.content?.decision !== "apply"
        ) {
          return textResult("LM Studio promotion was cancelled.", {
            applied: false,
            action: confirmation.action,
          });
        }
        const applied = applyModelDefaults(
          lmStudioHome,
          candidate.model,
          candidate.settings
        );
        const promotion = store.recordPromotion({
          candidateId,
          modelKey: candidate.model,
          configPath: applied.configPath,
          backupPath: applied.backupPath,
          settings: candidate.settings,
        });
        return textResult(
          `Applied LM Studio defaults for ${candidate.model}. Reload the model before Handy-parity verification.`,
          {
            applied: true,
            promotion,
            configPath: applied.configPath,
            backupPath: applied.backupPath,
            fields: applied.fields,
            warnings: applied.warnings,
            promptForHandy: candidate.prompt,
          }
        );
      } catch (error) {
        return errorResult("Could not promote candidate", error);
      }
    }
  );

  server.registerTool(
    "begin_annotation_cycle",
    {
      title: "Begin a new annotation cycle",
      description:
        "Unlocks annotation access for newly collected Handy transcripts after explicit confirmation. Use from a fresh annotation task.",
      inputSchema: {},
      annotations: writeAnnotations,
    },
    async () => {
      try {
        if (store.getWorkflowPhase() === "annotation") {
          return textResult("Annotation phase is already active.", {
            phase: "annotation",
          });
        }
        const confirmation = await server.server.elicitInput({
          mode: "form",
          message:
            "Begin a new annotation cycle? End the current optimization task before using the newly exposed transcripts.",
          requestedSchema: {
            type: "object",
            properties: {
              decision: {
                type: "string",
                title: "Decision",
                enum: ["begin", "cancel"],
                enumNames: ["Begin annotation cycle", "Cancel"],
                default: "cancel",
              },
            },
            required: ["decision"],
          },
        });
        if (
          confirmation.action !== "accept" ||
          confirmation.content?.decision !== "begin"
        ) {
          return textResult("Annotation cycle was not started.", {
            phase: store.getWorkflowPhase(),
          });
        }
        store.setWorkflowPhase("annotation");
        return textResult("Annotation phase is active.", {
          phase: "annotation",
        });
      } catch (error) {
        return errorResult("Could not begin annotation cycle", error);
      }
    }
  );

  server.registerResource(
    "handy-prompts-about",
    ABOUT_URI,
    {
      title: "Handy optimized prompts",
      description: "Current workflow, paths, and privacy boundaries.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              name: "handy-optimized-prompts",
              version: VERSION,
              databasePath,
              handyHistoryPath,
              handyHistoryAccess: "read-only",
              lmStudioBaseUrl: lmClient.baseUrl,
              workflowPhase: store.getWorkflowPhase(),
              widgetUri: WIDGET_URI,
            },
            null,
            2
          ),
        },
      ],
    })
  );

  server.registerPrompt(
    "propose-handy-correction",
    {
      title: "Propose a Handy transcript correction",
      description:
        "Conservative instructions for generating a user-reviewable correction.",
      argsSchema: {
        rawTranscript: z.string(),
      },
    },
    async ({ rawTranscript }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Correct this raw dictation transcript.",
              "Fix spelling, capitalization, punctuation, spoken punctuation, number formatting, filler words, and obvious transcription errors.",
              "Preserve exact meaning and word order. Do not paraphrase.",
              "Return only the corrected transcript.",
              "",
              rawTranscript,
            ].join("\n"),
          },
        },
      ],
    })
  );

  return { server, store };
}

async function main() {
  const unsupportedArgs = process.argv
    .slice(2)
    .filter((argument) => argument !== "--stdio");
  if (unsupportedArgs.length) {
    throw new Error(`Unsupported argument: ${unsupportedArgs.join(", ")}`);
  }
  const created = createHandyPromptServer();
  const transport = new StdioServerTransport();
  await created.server.connect(transport);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}
