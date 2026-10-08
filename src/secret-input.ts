export interface SecretInputComponent {
  focused: boolean;
  handleInput(data: string): void;
  invalidate(): void;
  render(width: number): string[];
}

export interface SecretPromptUI {
  custom<T>(
    factory: (tui: { requestRender?: () => void }, theme: unknown, keybindings: unknown, done: (value: T) => void) => SecretInputComponent | Promise<SecretInputComponent>,
    options?: unknown,
  ): Promise<T>;
}

class MaskedInput implements SecretInputComponent {
  focused = true;
  private value = "";

  constructor(
    private readonly title: string,
    private readonly done: (value: string | undefined) => void,
    private readonly tui: { requestRender?: () => void },
  ) {}

  handleInput(data: string): void {
    if (data === "\u001b" || data === "\u0003") {
      this.done(undefined);
      return;
    }
    // Escape-prefixed sequences are navigation/control keys, not passphrase text.
    if (data.includes("\u001b")) return;

    for (const character of Array.from(data)) {
      if (character === "\r" || character === "\n") {
        this.done(this.value);
        return;
      }
      if (character === "\u007f" || character === "\b") {
        this.value = Array.from(this.value).slice(0, -1).join("");
      } else if (character === "\u0015") {
        this.value = "";
      } else {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint >= 0x20 && codePoint !== 0x7f) this.value += character;
      }
    }
    this.tui.requestRender?.();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const prefix = this.title + ": ";
    const available = Math.max(0, width - prefix.length - 1);
    const mask = "•".repeat(Math.min(Array.from(this.value).length, available));
    return [prefix + mask + (available > 0 ? "▌" : "")];
  }
}

export async function promptSecret(ui: SecretPromptUI, title: string): Promise<string | undefined> {
  if (!ui || typeof ui.custom !== "function") throw new Error("Secure passphrase input is unavailable in this Pi UI");
  return ui.custom<string | undefined>((tui, _theme, _keybindings, done) => new MaskedInput(title, done, tui));
}

export async function promptConfirmedSecret(ui: SecretPromptUI, title: string): Promise<string> {
  const first = await promptSecret(ui, title);
  if (first === undefined) throw new Error("Passphrase input was cancelled");
  const second = await promptSecret(ui, "Confirm " + title);
  if (second === undefined) throw new Error("Passphrase confirmation was cancelled");
  if (first !== second) throw new Error("Passphrases do not match");
  return first;
}
