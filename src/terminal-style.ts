import { safeDiagnostic } from "./display";

/** Only Timber's labels receive ANSI; all external values are escaped first. */
export function terminalStyle(isTTY: boolean, env: NodeJS.ProcessEnv = process.env) {
  const enabled = !env.NO_COLOR && env.FORCE_COLOR !== "0"
    && (env.FORCE_COLOR !== undefined || (isTTY && env.TERM !== "dumb"));
  const paint = (code: string, value: string) => enabled ? `\u001b[${code}m${safeDiagnostic(value)}\u001b[0m` : safeDiagnostic(value);
  return {
    heading: (value: string) => paint("1;36", value),
    label: (value: string) => paint("33", value),
    success: (value: string) => paint("32", value),
    warning: (value: string) => paint("38;2;229;206;116", value),
    error: (value: string) => paint("1;38;2;224;117;104", value),
  };
}
