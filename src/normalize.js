const NON_BREAKING_SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
const HORIZONTAL_WHITESPACE = /[^\S\r\n]+/g;

export function normalizeTranscript(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(NON_BREAKING_SPACES, " ")
    .split("\n")
    .map((line) => line.replace(HORIZONTAL_WHITESPACE, " ").trimEnd())
    .join("\n")
    .trim();
}

export function scoreTranscript(actual, expected) {
  const actualText = String(actual ?? "");
  const expectedText = String(expected ?? "");
  const normalizedActual = normalizeTranscript(actualText);
  const normalizedExpected = normalizeTranscript(expectedText);
  const rawExact = actualText === expectedText;
  const normalizedExact = normalizedActual === normalizedExpected;

  return {
    rawExact,
    normalizedExact,
    normalizedActual,
    normalizedExpected,
    diagnostics: {
      extraWrapperText:
        /^(?:here(?:'s| is)|cleaned transcript|output|answer)\s*:/i.test(
          normalizedActual
        ) || /```/.test(normalizedActual),
      reasoningTrace:
        /<(?:think|analysis)>|<\/(?:think|analysis)>|^(?:thought|reasoning|analysis)\s*:/im.test(
          normalizedActual
        ),
      changedCaseOnly:
        !normalizedExact &&
        normalizedActual.toLocaleLowerCase() ===
          normalizedExpected.toLocaleLowerCase(),
      missingTerminalPunctuation:
        /[.!?]$/.test(normalizedExpected) &&
        !/[.!?]$/.test(normalizedActual),
    },
  };
}
