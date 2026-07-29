# Handy Optimized Prompts

A local MCP app for building a user-approved transcript corpus from Handy,
evaluating post-processing prompts against LM Studio, and promoting winning
inference settings.

> [!IMPORTANT]
> This repository is shared as an example for inspiration and adaptation. It
> reflects a personal local workflow and is not a production-ready package,
> supported product, or drop-in solution. Review and adapt its security,
> privacy, data-handling, and operational assumptions before using it.

## Safety and data boundaries

- Handy's `history.db` and `settings_store.json` are read-only.
- Only `transcription_history.transcription_text` is imported. Historical
  Handy post-processing output is ignored.
- Proposals, approved targets, dataset splits, prompts, and evaluation results
  live in this project's SQLite database.
- Holdout examples are sealed after dataset creation. Optimization tools expose
  development examples and development failures only.
- LM Studio settings are changed only by the promotion tool after a form
  confirmation. The existing per-model configuration is backed up first.
- The project never downloads LM Studio models.

## Requirements

- macOS
- Handy 0.9.0 or newer
- LM Studio 0.4.0 or newer
- Node.js 24 or newer

Default paths:

- Handy history:
  `~/Library/Application Support/com.pais.handy/history.db`
- Prompt-lab data: `./data/handy-prompts.sqlite`
- LM Studio: `~/.lmstudio`
- LM Studio API: `http://127.0.0.1:1234`

Override them with `HANDY_HISTORY_DB`, `HANDY_PROMPTS_DB`, `LM_STUDIO_HOME`,
or `LM_STUDIO_BASE_URL`.

## Install and verify

```bash
npm install
npm test
npm run smoke
```

The smoke test reads the live Handy history into a temporary database and
deletes that database afterward.

## Connect to Codex Desktop over STDIO

The MCP server communicates through stdin and stdout only. It does not open an
HTTP listener.

```toml
[mcp_servers.handy_prompt_lab]
command = "node"
args = ["/absolute/path/to/handy-optimized-prompts/src/server.js", "--stdio"]
startup_timeout_sec = 20
tool_timeout_sec = 1800
```

Restart Codex after changing the server code or configuration.

## Annotation workflow

Start a Codex task and say:

> Let's update Handy annotations.

Codex should:

1. Call `sync_handy_history`.
2. Call `list_transcripts_needing_proposals` with a maximum of 20.
3. Generate conservative corrections and call `save_correction_proposals`.
4. Call `show_annotation_lab`.

The widget saves each user decision through `save_annotation_and_next` and
loads the next proposal directly. It does not use `ui/message` or
`ui/update-model-context`.

End the task after annotation. Do not optimize the prompt in the same task,
because that task has seen the prospective holdout transcripts.

## Optimization workflow

Start a fresh Codex task and say:

> Optimize my Handy prompt using the approved annotations.

Codex should:

1. Call `prepare_optimization_dataset` with the required fresh-task
   confirmation.
2. Inspect `get_development_examples`.
3. Call `list_lm_studio_models`.
4. Create a prompt/model/settings candidate with `create_prompt_candidate`.
5. Call `run_development_eval`.
6. Inspect detailed development failures with `get_development_failures`.
7. Iterate until the development candidate is satisfactory.
8. Freeze it with `freeze_prompt_candidate`.
9. Call `run_holdout_eval` once. This returns aggregate metrics only.

The initial dataset uses a chronological split: the newest 20% are holdout.
With fewer than five approved records, one record is held out when possible.
Newly collected transcripts should supply rolling holdouts in later cycles.

## Evaluation behavior

Candidates version:

- Handy prompt-template text containing the literal `${output}` placeholder
- LM Studio model key
- Temperature
- Maximum output tokens
- Optional top-p, top-k, min-p, and repeat penalty

For every evaluation record, the evaluator replaces `${output}` with the raw
transcript and sends the complete rendered prompt as a single `user` message.
Candidates without `${output}` are rejected. This matches Handy's legacy path
for custom providers that do not advertise structured-output support.

Evaluation requests match Handy 0.9.0's custom-provider behavior by sending
top-level `reasoning_effort: "none"`. This is fixed rather than a candidate
setting because Handy does not expose it. Model-specific thinking toggles in
LM Studio remain unchanged during promotion.

The primary quality metric is normalized exact match. Normalization performs
Unicode NFC cleanup, line-ending normalization, non-breaking-space conversion,
outer trimming, and repeated horizontal-whitespace collapse. It preserves
capitalization, punctuation, quote and dash style, numbers, words, word order,
and line breaks.

The evaluator runs models sequentially. It records the initially loaded LM
Studio models, loads the candidate model if necessary, and restores the
originally loaded models after the run.

## Promotion

`plan_lm_studio_promotion` shows the proposed per-model default changes.

`promote_candidate_to_lm_studio` requires:

- A frozen candidate
- A completed holdout evaluation
- An accepted form confirmation

Promotion updates inference fields in:

`~/.lmstudio/.internal/user-concrete-model-default-config/<model-key>.json`

It preserves unrelated fields such as model-specific thinking toggles and
creates a timestamped backup. Reload the model after promotion. The tool
returns the winning prompt for manual entry in Handy; it does not write Handy
settings.

## References

- [MCP Apps UI bridge](https://developers.openai.com/apps-sdk/reference#mcp-apps-ui-bridge)
- [LM Studio REST API](https://lmstudio.ai/docs/developer/rest)
- [LM Studio model defaults](https://lmstudio.ai/docs/app/modelyaml)

## License

This example is shared under the [Common Grace License 1.0](./LICENSE).
