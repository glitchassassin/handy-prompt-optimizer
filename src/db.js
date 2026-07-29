import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

function now() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function recordFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceKey: row.source_key,
    handyHistoryId: Number(row.handy_history_id),
    fileName: row.file_name,
    timestamp: Number(row.timestamp),
    title: row.title,
    raw: row.raw_text,
    proposed: row.proposal_text ?? "",
    proposalAuthor: row.proposal_author ?? "",
    proposedAt: row.proposed_at,
    corrected: row.annotation_text ?? row.proposal_text ?? "",
    status: row.annotation_status ?? (row.proposal_text ? "proposed" : "pending"),
    notes: row.notes ?? "",
    annotatedAt: row.annotated_at,
  };
}

export class PromptLabStore {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        handy_history_id INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        title TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        proposal_text TEXT,
        proposal_author TEXT,
        proposed_at TEXT,
        annotation_text TEXT,
        annotation_status TEXT CHECK (
          annotation_status IS NULL OR
          annotation_status IN ('approved', 'edited', 'skipped')
        ),
        notes TEXT NOT NULL DEFAULT '',
        annotated_at TEXT
      );

      CREATE INDEX IF NOT EXISTS records_timestamp_idx
        ON records(timestamp, handy_history_id);
      CREATE INDEX IF NOT EXISTS records_annotation_status_idx
        ON records(annotation_status, proposed_at);

      CREATE TABLE IF NOT EXISTS dataset_versions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
        record_count INTEGER NOT NULL,
        development_count INTEGER NOT NULL,
        holdout_count INTEGER NOT NULL,
        holdout_fraction REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dataset_members (
        dataset_id TEXT NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE RESTRICT,
        split TEXT NOT NULL CHECK (split IN ('development', 'holdout')),
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (dataset_id, record_id)
      );

      CREATE INDEX IF NOT EXISTS dataset_members_split_idx
        ON dataset_members(dataset_id, split, ordinal);

      CREATE TABLE IF NOT EXISTS prompt_candidates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        frozen_at TEXT
      );

      CREATE TABLE IF NOT EXISTS eval_runs (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL REFERENCES prompt_candidates(id),
        dataset_id TEXT NOT NULL REFERENCES dataset_versions(id),
        split TEXT NOT NULL CHECK (split IN ('development', 'holdout')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        total INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL DEFAULT 0,
        raw_exact INTEGER NOT NULL DEFAULT 0,
        total_latency_ms REAL NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS eval_results (
        run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
        record_id TEXT NOT NULL REFERENCES records(id),
        output_text TEXT,
        normalized_output TEXT,
        normalized_expected TEXT,
        raw_exact INTEGER NOT NULL DEFAULT 0,
        normalized_exact INTEGER NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL DEFAULT 0,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        diagnostics_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        PRIMARY KEY (run_id, record_id)
      );

      CREATE TABLE IF NOT EXISTS promotions (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL REFERENCES prompt_candidates(id),
        model_key TEXT NOT NULL,
        config_path TEXT NOT NULL,
        backup_path TEXT,
        settings_json TEXT NOT NULL,
        promoted_at TEXT NOT NULL
      );
    `);
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMeta(key, fallback = null) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)
      ?.value ?? fallback;
  }

  setMeta(key, value) {
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, String(value));
  }

  getWorkflowPhase() {
    return this.getMeta("workflow_phase", "annotation");
  }

  setWorkflowPhase(phase) {
    if (!["annotation", "optimization"].includes(phase)) {
      throw new Error(`Invalid workflow phase: ${phase}`);
    }
    this.setMeta("workflow_phase", phase);
  }

  importHandyRows(rows) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO records (
        id, source_key, handy_history_id, file_name, timestamp, title, raw_text, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let imported = 0;
    this.transaction(() => {
      for (const row of rows) {
        const id = `handy-${row.id}-${row.source_key.slice(0, 12)}`;
        const result = insert.run(
          id,
          row.source_key,
          row.id,
          row.file_name,
          row.timestamp,
          row.title,
          row.transcription_text,
          now()
        );
        imported += Number(result.changes);
      }
    });
    return {
      discovered: rows.length,
      imported,
      existing: rows.length - imported,
      total: Number(
        this.db.prepare("SELECT COUNT(*) AS count FROM records").get().count
      ),
    };
  }

  listNeedingProposals({ limit = 20, cursor = null } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
    const params = [];
    let cursorClause = "";
    if (cursor) {
      const cursorRow = this.db
        .prepare("SELECT timestamp, handy_history_id FROM records WHERE id = ?")
        .get(cursor);
      if (cursorRow) {
        cursorClause =
          "AND (timestamp > ? OR (timestamp = ? AND handy_history_id > ?))";
        params.push(
          cursorRow.timestamp,
          cursorRow.timestamp,
          cursorRow.handy_history_id
        );
      }
    }
    const rows = this.db
      .prepare(
        `SELECT *
         FROM records
         WHERE proposal_text IS NULL
           AND annotation_status IS NULL
           ${cursorClause}
         ORDER BY timestamp ASC, handy_history_id ASC
         LIMIT ?`
      )
      .all(...params, safeLimit);
    const remaining = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM records
           WHERE proposal_text IS NULL AND annotation_status IS NULL`
        )
        .get().count
    );
    return {
      records: rows.map(recordFromRow),
      remaining,
      nextCursor: rows.at(-1)?.id ?? null,
    };
  }

  saveProposals(proposals, author = "Codex") {
    const update = this.db.prepare(`
      UPDATE records
      SET proposal_text = ?, proposal_author = ?, proposed_at = ?
      WHERE id = ? AND annotation_status IS NULL
    `);
    const saved = [];
    const missing = [];
    this.transaction(() => {
      for (const proposal of proposals) {
        const result = update.run(
          proposal.proposedText,
          author,
          now(),
          proposal.recordId
        );
        if (Number(result.changes) === 1) saved.push(proposal.recordId);
        else missing.push(proposal.recordId);
      }
    });
    return { saved, missing };
  }

  getRecord(id) {
    return recordFromRow(
      this.db.prepare("SELECT * FROM records WHERE id = ?").get(id)
    );
  }

  getRecords(ids) {
    return ids.map((id) => this.getRecord(id)).filter(Boolean);
  }

  listProposed({ limit = 20 } = {}) {
    return this.db
      .prepare(
        `SELECT *
         FROM records
         WHERE proposal_text IS NOT NULL AND annotation_status IS NULL
         ORDER BY timestamp ASC, handy_history_id ASC
         LIMIT ?`
      )
      .all(Math.max(1, Math.min(Number(limit) || 20, 50)))
      .map(recordFromRow);
  }

  saveAnnotation({ recordId, correctedText, status, notes = "" }) {
    const result = this.db
      .prepare(
        `UPDATE records
         SET annotation_text = ?,
             annotation_status = ?,
             notes = ?,
             annotated_at = ?
         WHERE id = ? AND proposal_text IS NOT NULL`
      )
      .run(correctedText, status, notes, now(), recordId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Annotation record was not found or lacks a proposal: ${recordId}`);
    }
    return this.getRecord(recordId);
  }

  annotationSummary() {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN proposal_text IS NULL THEN 1 ELSE 0 END) AS needs_proposal,
           SUM(CASE WHEN proposal_text IS NOT NULL AND annotation_status IS NULL THEN 1 ELSE 0 END) AS proposed,
           SUM(CASE WHEN annotation_status = 'approved' THEN 1 ELSE 0 END) AS approved,
           SUM(CASE WHEN annotation_status = 'edited' THEN 1 ELSE 0 END) AS edited,
           SUM(CASE WHEN annotation_status = 'skipped' THEN 1 ELSE 0 END) AS skipped
         FROM records`
      )
      .get();
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)])
    );
  }

  createDataset({ holdoutFraction = 0.2 } = {}) {
    const records = this.db
      .prepare(
        `SELECT id
         FROM records
         WHERE annotation_status IN ('approved', 'edited')
         ORDER BY timestamp ASC, handy_history_id ASC`
      )
      .all();
    if (records.length === 0) {
      throw new Error("No approved annotations are available.");
    }

    const fraction = Math.max(0, Math.min(Number(holdoutFraction) || 0.2, 0.5));
    const holdoutCount =
      records.length >= 5
        ? Math.max(1, Math.floor(records.length * fraction))
        : records.length >= 2
          ? 1
          : 0;
    const developmentCount = records.length - holdoutCount;
    const id = `dataset-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;

    this.transaction(() => {
      this.db
        .prepare("UPDATE dataset_versions SET status = 'retired' WHERE status = 'active'")
        .run();
      this.db
        .prepare(
          `INSERT INTO dataset_versions (
             id, created_at, status, record_count, development_count,
             holdout_count, holdout_fraction
           ) VALUES (?, ?, 'active', ?, ?, ?, ?)`
        )
        .run(
          id,
          now(),
          records.length,
          developmentCount,
          holdoutCount,
          fraction
        );
      const insert = this.db.prepare(
        `INSERT INTO dataset_members(dataset_id, record_id, split, ordinal)
         VALUES (?, ?, ?, ?)`
      );
      records.forEach((record, index) => {
        insert.run(
          id,
          record.id,
          index < developmentCount ? "development" : "holdout",
          index
        );
      });
      this.setWorkflowPhase("optimization");
    });
    return this.getDataset(id);
  }

  getDataset(id = null) {
    const row = id
      ? this.db.prepare("SELECT * FROM dataset_versions WHERE id = ?").get(id)
      : this.db
          .prepare(
            "SELECT * FROM dataset_versions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
          )
          .get();
    if (!row) return null;
    return {
      id: row.id,
      createdAt: row.created_at,
      status: row.status,
      recordCount: Number(row.record_count),
      developmentCount: Number(row.development_count),
      holdoutCount: Number(row.holdout_count),
      holdoutFraction: Number(row.holdout_fraction),
    };
  }

  listDatasetExamples(datasetId, split, { limit = 50, offset = 0 } = {}) {
    if (!["development", "holdout"].includes(split)) {
      throw new Error(`Invalid dataset split: ${split}`);
    }
    return this.db
      .prepare(
        `SELECT r.*, dm.ordinal
         FROM dataset_members dm
         JOIN records r ON r.id = dm.record_id
         WHERE dm.dataset_id = ? AND dm.split = ?
         ORDER BY dm.ordinal ASC
         LIMIT ? OFFSET ?`
      )
      .all(
        datasetId,
        split,
        Math.max(1, Math.min(Number(limit) || 50, 200)),
        Math.max(0, Number(offset) || 0)
      )
      .map((row) => ({
        record: recordFromRow(row),
        ordinal: Number(row.ordinal),
      }));
  }

  createCandidate({ name, prompt, model, settings }) {
    const id = `prompt-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO prompt_candidates (
           id, name, prompt, model, settings_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, name, prompt, model, JSON.stringify(settings), now());
    return this.getCandidate(id);
  }

  getCandidate(id) {
    const row = this.db
      .prepare("SELECT * FROM prompt_candidates WHERE id = ?")
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      model: row.model,
      settings: parseJson(row.settings_json, {}),
      createdAt: row.created_at,
      frozenAt: row.frozen_at,
    };
  }

  freezeCandidate(id) {
    this.db
      .prepare(
        "UPDATE prompt_candidates SET frozen_at = COALESCE(frozen_at, ?) WHERE id = ?"
      )
      .run(now(), id);
    return this.getCandidate(id);
  }

  startEvalRun({ candidateId, datasetId, split }) {
    const id = `eval-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO eval_runs (
           id, candidate_id, dataset_id, split, started_at, status
         ) VALUES (?, ?, ?, ?, ?, 'running')`
      )
      .run(id, candidateId, datasetId, split, now());
    return id;
  }

  addEvalResult(runId, result) {
    this.db
      .prepare(
        `INSERT INTO eval_results (
           run_id, record_id, output_text, normalized_output, normalized_expected,
           raw_exact, normalized_exact, latency_ms, prompt_tokens,
           completion_tokens, diagnostics_json, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        result.recordId,
        result.outputText ?? null,
        result.normalizedOutput ?? null,
        result.normalizedExpected ?? null,
        result.rawExact ? 1 : 0,
        result.normalizedExact ? 1 : 0,
        result.latencyMs ?? 0,
        result.promptTokens ?? null,
        result.completionTokens ?? null,
        JSON.stringify(result.diagnostics ?? {}),
        result.error ?? null
      );
  }

  finishEvalRun(runId, error = null) {
    const summary = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(normalized_exact) AS passed,
           SUM(raw_exact) AS raw_exact,
           SUM(latency_ms) AS total_latency_ms
         FROM eval_results
         WHERE run_id = ?`
      )
      .get(runId);
    this.db
      .prepare(
        `UPDATE eval_runs
         SET finished_at = ?,
             status = ?,
             total = ?,
             passed = ?,
             raw_exact = ?,
             total_latency_ms = ?,
             error = ?
         WHERE id = ?`
      )
      .run(
        now(),
        error ? "failed" : "completed",
        Number(summary.total ?? 0),
        Number(summary.passed ?? 0),
        Number(summary.raw_exact ?? 0),
        Number(summary.total_latency_ms ?? 0),
        error,
        runId
      );
    return this.getEvalRun(runId);
  }

  getEvalRun(id) {
    const row = this.db.prepare("SELECT * FROM eval_runs WHERE id = ?").get(id);
    if (!row) return null;
    const total = Number(row.total);
    const passed = Number(row.passed);
    return {
      id: row.id,
      candidateId: row.candidate_id,
      datasetId: row.dataset_id,
      split: row.split,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      total,
      passed,
      failed: total - passed,
      normalizedExactRate: total ? passed / total : 0,
      rawExactRate: total ? Number(row.raw_exact) / total : 0,
      averageLatencyMs: total ? Number(row.total_latency_ms) / total : 0,
      error: row.error,
    };
  }

  hasCompletedHoldoutEval(candidateId) {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM eval_runs
           WHERE candidate_id = ?
             AND split = 'holdout'
             AND status = 'completed'
           LIMIT 1`
        )
        .get(candidateId)
    );
  }

  listEvalFailures(runId, { limit = 20, includeText = true } = {}) {
    const rows = this.db
      .prepare(
        `SELECT er.*, r.raw_text, r.annotation_text
         FROM eval_results er
         JOIN records r ON r.id = er.record_id
         WHERE er.run_id = ? AND er.normalized_exact = 0
         ORDER BY er.latency_ms DESC, er.record_id ASC
         LIMIT ?`
      )
      .all(runId, Math.max(1, Math.min(Number(limit) || 20, 100)));
    return rows.map((row) => ({
      recordId: row.record_id,
      ...(includeText
        ? {
            raw: row.raw_text,
            expected: row.annotation_text,
            actual: row.output_text,
          }
        : {}),
      latencyMs: Number(row.latency_ms),
      diagnostics: parseJson(row.diagnostics_json, {}),
      error: row.error,
    }));
  }

  recordPromotion({
    candidateId,
    modelKey,
    configPath,
    backupPath,
    settings,
  }) {
    const id = `promotion-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO promotions (
           id, candidate_id, model_key, config_path, backup_path,
           settings_json, promoted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        candidateId,
        modelKey,
        configPath,
        backupPath,
        JSON.stringify(settings),
        now()
      );
    return { id, promotedAt: now() };
  }
}
