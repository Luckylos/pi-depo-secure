import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { runCommand, type CommandResult } from "./process.js";

type Primitive = string | number | boolean | null | undefined;

function tokenise(strings: TemplateStringsArray, values: Primitive[]): { file: string; args: string[] } {
  const markers = values.map((_, index) => "\u0001" + index + "\u0002");
  const source = strings.reduce((result, part, index) => result + part + (markers[index] ?? ""), "");
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = () => { if (current.length > 0) { tokens.push(current); current = ""; } };
  for (let index = 0; index < source.length;) {
    const markerIndex = source.charCodeAt(index) === 1 ? source.indexOf("\u0002", index + 1) : -1;
    if (markerIndex >= 0) {
      const marker = source.slice(index + 1, markerIndex);
      const valueIndex = Number(marker);
      if (Number.isInteger(valueIndex) && valueIndex >= 0 && valueIndex < values.length) current += String(values[valueIndex] ?? "");
      index = markerIndex + 1;
      continue;
    }
    const character = source[index++] ?? "";
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (character === "'" || character === '"') {
      if (quote === null) quote = character;
      else if (quote === character) quote = null;
      else current += character;
      continue;
    }
    if (/\s/.test(character) && quote === null) flush(); else current += character;
  }
  if (escaped) current += "\\";
  if (quote !== null) throw new Error("Unterminated quote in command template");
  flush();
  const [file, ...args] = tokens;
  if (!file) throw new Error("Empty command template");
  return { file, args };
}

class CommandHandle implements PromiseLike<CommandResult> {
  private promise: Promise<CommandResult> | undefined;
  private shouldThrow = true;
  constructor(private readonly file: string, private readonly args: string[]) {}
  quiet(): this { return this; }
  nothrow(): this { this.shouldThrow = false; return this; }
  private start(): Promise<CommandResult> {
    if (!this.promise) {
      this.promise = runCommand(this.file, this.args).then((result) => {
        if (this.shouldThrow && result.exitCode !== 0) throw new Error("Command failed: " + this.file + " (exit " + result.exitCode + ")");
        return result;
      });
    }
    return this.promise;
  }
  then<TResult1 = CommandResult, TResult2 = never>(onfulfilled?: ((value: CommandResult) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> {
    return this.start().then(onfulfilled, onrejected);
  }
}

export function $(strings: TemplateStringsArray, ...values: Primitive[]): CommandHandle {
  const { file, args } = tokenise(strings, values);
  return new CommandHandle(file, args);
}

function whichSync(file: string): string | null {
  if (isAbsolute(file) || file.includes("/")) {
    try { accessSync(file, constants.X_OK); return file; } catch { return null; }
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, file);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* continue */ }
  }
  return null;
}

export const Bun = { $, which: whichSync };
