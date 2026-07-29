import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");

export const paths = {
  projectRoot: PROJECT_ROOT,
  database:
    process.env.HANDY_PROMPTS_DB ??
    resolve(PROJECT_ROOT, "data", "handy-prompts.sqlite"),
  handyHistory:
    process.env.HANDY_HISTORY_DB ??
    resolve(
      homedir(),
      "Library",
      "Application Support",
      "com.pais.handy",
      "history.db"
    ),
  lmStudioHome:
    process.env.LM_STUDIO_HOME ?? resolve(homedir(), ".lmstudio"),
};

export const lmStudioConfig = {
  baseUrl: (process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234").replace(
    /\/+$/,
    ""
  ),
  apiToken: process.env.LM_STUDIO_API_TOKEN ?? "",
  timeoutMs: Number(process.env.LM_STUDIO_TIMEOUT_MS ?? 120_000),
};

export const defaults = {
  annotationBatchSize: 20,
  holdoutFraction: 0.2,
};
