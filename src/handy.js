import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function sourceKey(row) {
  return createHash("sha256")
    .update(
      [
        String(row.id),
        String(row.timestamp),
        String(row.file_name),
        String(row.transcription_text),
      ].join("\0")
    )
    .digest("hex");
}

export function readHandyHistory(historyPath) {
  if (!existsSync(historyPath)) {
    throw new Error(`Handy history database was not found at ${historyPath}`);
  }

  const database = new DatabaseSync(historyPath, {
    readOnly: true,
  });
  try {
    return database
      .prepare(
        `SELECT
           id,
           file_name,
           timestamp,
           saved,
           title,
           transcription_text
         FROM transcription_history
         WHERE length(trim(transcription_text)) > 0
         ORDER BY timestamp ASC, id ASC`
      )
      .all()
      .map((row) => ({
        ...row,
        source_key: sourceKey(row),
      }));
  } finally {
    database.close();
  }
}
