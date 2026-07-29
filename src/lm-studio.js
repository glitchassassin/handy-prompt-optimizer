import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { scoreTranscript } from "./normalize.js";

function slugTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeModelKey(modelKey) {
  const normalized = String(modelKey ?? "").trim().replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    !/^[a-zA-Z0-9._@/+:-]+$/.test(normalized)
  ) {
    throw new Error(`Unsafe LM Studio model key: ${modelKey}`);
  }
  return normalized;
}

function cleanObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
}

export function renderPrompt(template, rawTranscript) {
  const prompt = String(template ?? "");
  const raw = String(rawTranscript ?? "");
  if (!prompt.includes("${output}")) {
    throw new Error(
      'Handy prompt templates must include the literal "${output}" placeholder.'
    );
  }
  return prompt.split("${output}").join(raw);
}

export function normalizeCandidateSettings(settings = {}) {
  return cleanObject({
    temperature:
      settings.temperature === undefined ? 0 : Number(settings.temperature),
    maxTokens:
      settings.maxTokens === undefined ? 512 : Number(settings.maxTokens),
    topP: settings.topP === undefined ? undefined : Number(settings.topP),
    topK: settings.topK === undefined ? undefined : Number(settings.topK),
    minP: settings.minP === undefined ? undefined : Number(settings.minP),
    repeatPenalty:
      settings.repeatPenalty === undefined
        ? undefined
        : Number(settings.repeatPenalty),
  });
}

function chatRequest(candidate, model) {
  const settings = normalizeCandidateSettings(candidate.settings);
  return cleanObject({
    model,
    messages: [
      {
        // Handy's legacy/custom-provider path renders ${output} into the
        // configured prompt and sends the complete result as the user message.
        role: "user",
        content: candidate.renderedPrompt,
      },
    ],
    stream: false,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    top_p: settings.topP,
    top_k: settings.topK,
    min_p: settings.minP,
    repeat_penalty: settings.repeatPenalty,
    // Handy 0.9.0 sends this exact top-level field for its custom provider.
    reasoning_effort: "none",
  });
}

export class LmStudioClient {
  constructor({ baseUrl, apiToken = "", timeoutMs = 120_000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiToken = apiToken;
    this.timeoutMs = timeoutMs;
  }

  headers() {
    return {
      "content-type": "application/json",
      ...(this.apiToken
        ? { authorization: `Bearer ${this.apiToken}` }
        : {}),
    };
  }

  async request(path, { method = "GET", body, timeoutMs } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      throw new Error(
        `LM Studio ${method} ${path} failed (${response.status}): ${
          typeof payload === "string" ? payload : JSON.stringify(payload)
        }`
      );
    }
    return payload;
  }

  async listModels() {
    const payload = await this.request("/api/v1/models");
    return Array.isArray(payload?.models) ? payload.models : [];
  }

  async loadModel(model, config = {}) {
    return this.request("/api/v1/models/load", {
      method: "POST",
      body: cleanObject({
        model,
        context_length: config.context_length,
        eval_batch_size: config.eval_batch_size,
        flash_attention: config.flash_attention,
        num_experts: config.num_experts,
        offload_kv_cache_to_gpu: config.offload_kv_cache_to_gpu,
        echo_load_config: true,
      }),
      timeoutMs: Math.max(this.timeoutMs, 300_000),
    });
  }

  async unloadModel(instanceId) {
    return this.request("/api/v1/models/unload", {
      method: "POST",
      body: { instance_id: instanceId },
      timeoutMs: Math.max(this.timeoutMs, 300_000),
    });
  }

  findModel(models, requested) {
    return models.find(
      (model) =>
        model.key === requested ||
        model.selected_variant === requested ||
        model.variants?.includes(requested) ||
        model.loaded_instances?.some((instance) => instance.id === requested)
    );
  }

  async withExclusiveModel(modelKey, callback) {
    const requested = safeModelKey(modelKey);
    const models = await this.listModels();
    const target = this.findModel(models, requested);
    if (!target || target.type !== "llm") {
      throw new Error(
        `LM Studio model is not downloaded or is not an LLM: ${requested}`
      );
    }

    const originallyLoaded = models
      .filter((model) => model.type === "llm")
      .flatMap((model) =>
        (model.loaded_instances ?? []).map((instance) => ({
          model: model.key,
          instanceId: instance.id,
          config: instance.config ?? {},
        }))
      );
    let targetInstance =
      target.loaded_instances?.find((instance) => instance.id === requested) ??
      target.loaded_instances?.[0] ??
      null;

    for (const loaded of originallyLoaded) {
      if (loaded.instanceId !== targetInstance?.id) {
        await this.unloadModel(loaded.instanceId);
      }
    }

    let loadedForRun = false;
    if (!targetInstance) {
      const loaded = await this.loadModel(requested);
      targetInstance = { id: loaded.instance_id, config: loaded.load_config };
      loadedForRun = true;
    }

    let callbackError = null;
    try {
      return await callback(targetInstance.id);
    } catch (error) {
      callbackError = error;
      throw error;
    } finally {
      const restoreErrors = [];
      try {
        const currentModels = await this.listModels();
        const currentInstances = currentModels.flatMap((model) =>
          (model.loaded_instances ?? []).map((instance) => instance.id)
        );

        if (
          loadedForRun &&
          currentInstances.includes(targetInstance.id) &&
          !originallyLoaded.some(
            (loaded) => loaded.instanceId === targetInstance.id
          )
        ) {
          await this.unloadModel(targetInstance.id);
        }

        const afterUnload = await this.listModels();
        const remaining = new Set(
          afterUnload.flatMap((model) =>
            (model.loaded_instances ?? []).map((instance) => instance.id)
          )
        );
        for (const original of originallyLoaded) {
          if (!remaining.has(original.instanceId)) {
            try {
              await this.loadModel(original.model, original.config);
            } catch (error) {
              restoreErrors.push(
                `${original.model}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }
        }
      } catch (error) {
        restoreErrors.push(error instanceof Error ? error.message : String(error));
      }

      if (restoreErrors.length && !callbackError) {
        throw new Error(
          `Evaluation completed, but LM Studio model restoration failed: ${restoreErrors.join("; ")}`
        );
      }
    }
  }

  async complete({ candidate, modelInstanceId, rawTranscript }) {
    const renderedPrompt = renderPrompt(candidate.prompt, rawTranscript);
    const requestBody = chatRequest(
      { ...candidate, renderedPrompt },
      modelInstanceId
    );
    const started = performance.now();
    const response = await this.request("/v1/chat/completions", {
      method: "POST",
      body: requestBody,
    });
    const latencyMs = performance.now() - started;
    const outputText = response?.choices?.[0]?.message?.content ?? "";
    return {
      outputText,
      latencyMs,
      promptTokens: response?.usage?.prompt_tokens ?? null,
      completionTokens: response?.usage?.completion_tokens ?? null,
      stats: response?.stats ?? null,
    };
  }

  async evaluate({ store, candidate, dataset, split }) {
    const examples = store.listDatasetExamples(dataset.id, split, {
      limit: 200,
    });
    const runId = store.startEvalRun({
      candidateId: candidate.id,
      datasetId: dataset.id,
      split,
    });

    let runError = null;
    try {
      await this.withExclusiveModel(candidate.model, async (modelInstanceId) => {
        for (const { record } of examples) {
          try {
            const completion = await this.complete({
              candidate,
              modelInstanceId,
              rawTranscript: record.raw,
            });
            const score = scoreTranscript(
              completion.outputText,
              record.corrected
            );
            store.addEvalResult(runId, {
              recordId: record.id,
              outputText: completion.outputText,
              normalizedOutput: score.normalizedActual,
              normalizedExpected: score.normalizedExpected,
              rawExact: score.rawExact,
              normalizedExact: score.normalizedExact,
              latencyMs: completion.latencyMs,
              promptTokens: completion.promptTokens,
              completionTokens: completion.completionTokens,
              diagnostics: score.diagnostics,
            });
          } catch (error) {
            store.addEvalResult(runId, {
              recordId: record.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    }
    return store.finishEvalRun(runId, runError);
  }
}

const PROMOTABLE_SETTINGS = {
  temperature: "llm.prediction.temperature",
  maxTokens: "llm.prediction.maxPredictedTokens",
  topP: "llm.prediction.topPSampling",
  topK: "llm.prediction.topKSampling",
  minP: "llm.prediction.minPSampling",
  repeatPenalty: "llm.prediction.repeatPenalty",
};

export function modelDefaultConfigPath(lmStudioHome, modelKey) {
  const safe = safeModelKey(modelKey);
  return resolve(
    lmStudioHome,
    ".internal",
    "user-concrete-model-default-config",
    `${safe}.json`
  );
}

export function planModelDefaults(lmStudioHome, modelKey, settings) {
  const configPath = modelDefaultConfigPath(lmStudioHome, modelKey);
  const normalized = normalizeCandidateSettings(settings);
  const fields = Object.entries(PROMOTABLE_SETTINGS)
    .filter(([setting]) => normalized[setting] !== undefined)
    .map(([setting, key]) => ({ key, value: normalized[setting] }));
  const warnings = [];
  warnings.push(
    "Handy 0.9.0 sends reasoning_effort=none for its custom provider; any model-specific LM Studio thinking toggle remains unchanged."
  );
  return { configPath, fields, warnings };
}

export function applyModelDefaults(lmStudioHome, modelKey, settings) {
  const plan = planModelDefaults(lmStudioHome, modelKey, settings);
  mkdirSync(dirname(plan.configPath), { recursive: true });

  let config = {
    preset: "",
    operation: { fields: [] },
    load: { fields: [] },
  };
  if (existsSync(plan.configPath)) {
    config = JSON.parse(readFileSync(plan.configPath, "utf8"));
  }
  config.operation ??= { fields: [] };
  config.operation.fields ??= [];
  config.load ??= { fields: [] };
  config.load.fields ??= [];

  const promotedKeys = new Set(plan.fields.map((field) => field.key));
  config.operation.fields = [
    ...config.operation.fields.filter((field) => !promotedKeys.has(field.key)),
    ...plan.fields,
  ];

  const backupPath = existsSync(plan.configPath)
    ? `${plan.configPath}.backup-${slugTimestamp()}`
    : null;
  if (backupPath) copyFileSync(plan.configPath, backupPath);

  const temporaryPath = `${plan.configPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, plan.configPath);

  return {
    ...plan,
    backupPath,
    config,
  };
}
