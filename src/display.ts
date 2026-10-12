const terminalControl = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const terminalControls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const extendedControls = /[\u007f-\u009f\u2028\u2029]/gu;

function codePointEscape(character: string): string {
  return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
}

/** JSON rendering is readable for paths while explicitly escaping DEL, C1 and line separators. */
export function jsonDisplay(value: string): string {
  return JSON.stringify(value).replace(extendedControls, codePointEscape);
}

export function safeDisplay(value: string): string {
  return terminalControl.test(value) ? jsonDisplay(value) : value;
}

function diagnosticEscape(character: string): string {
  if (character === "\b") return "\\b";
  if (character === "\t") return "\\t";
  if (character === "\n") return "\\n";
  if (character === "\f") return "\\f";
  if (character === "\r") return "\\r";
  return codePointEscape(character);
}

function bashByteEscapes(character: string): string {
  return [...new TextEncoder().encode(character)]
    .map(byte => `\\${byte.toString(8).padStart(3, "0")}`)
    .join("");
}

/** Keep service errors on one safe display line without changing ordinary punctuation. */
export function safeDiagnostic(value: string): string {
  return value.replace(terminalControls, diagnosticEscape);
}

/** A diagnostic whose newlines are intentional layout; the CLI keeps them and escapes other controls. */
export class FormattedError extends Error {}

function bashAnsiCQuote(value: string): string {
  const contents = [...value].map(character => {
    if (character === "\\") return "\\\\";
    if (character === "'") return "\\'";
    if (character === "\b") return "\\b";
    if (character === "\t") return "\\t";
    if (character === "\n") return "\\n";
    if (character === "\f") return "\\f";
    if (character === "\r") return "\\r";
    if (character === "\v") return "\\v";
    if (character === "!" || terminalControl.test(character)) return bashByteEscapes(character);
    return character;
  }).join("");
  return `$'${contents}'`;
}

/** Ordinary paths keep their POSIX-quoted retry; control characters need a printable Bash command. */
export function retryForDisplay(path: string, ordinaryRetry: string, options = ""): string {
  return terminalControl.test(path)
    ? `timber open ${options ? options + " " : ""}-- ${bashAnsiCQuote(path)}`
    : ordinaryRetry;
}

/** Render a launch failure so its retry command stays pasteable even for control-character paths. */
export function failureWithRetry(message: string, retryCommand: string, path: string, options = ""): string {
  const retry = retryForDisplay(path, retryCommand, options);
  return safeDiagnostic(message.includes(retryCommand)
    ? message.replace(retryCommand, () => retry)
    : `${message} Retry with: ${retry}`);
}
