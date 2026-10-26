export type DisclosureKind = "thinking" | "tool" | "group" | "activity";

export function disclosureKey(kind: DisclosureKind, ...parts: (string | number | undefined)[]): string {
  return [kind, ...parts.map((part) => (part === undefined ? "" : String(part)))].join("|");
}

const choices = new Map<string, boolean>();

export function rememberDisclosureChoice(key: string | undefined, open: boolean): void {
  if (!key) return;
  choices.set(key, open);
}

export function forgetDisclosureChoice(key: string | undefined): void {
  if (!key) return;
  choices.delete(key);
}

export function readDisclosureChoice(key: string | undefined): boolean | undefined {
  if (!key) return undefined;
  return choices.get(key);
}

export function resolveDisclosureOpen(key: string | undefined, automatic: boolean): boolean {
  const choice = readDisclosureChoice(key);
  return choice === undefined ? automatic : choice;
}

export function clearDisclosureChoices(): void {
  choices.clear();
}
