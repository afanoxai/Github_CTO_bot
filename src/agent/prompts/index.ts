// Loads the externalized prompts (prompts.txt) into a typed, validated map at startup
// (CLAUDE_agent_v3.md Section 8). Nothing else in the codebase inlines a prompt string;
// they all come through here, so "edit a prompt" always means "edit prompts.txt".
//
// Parsing rules (kept deliberately simple so the file stays hand-editable):
//   - A line of the form  === name ===  begins a new section named `name`.
//   - Every following line belongs to that section, VERBATIM, until the next such line.
//   - A line whose first non-whitespace character is `#` is a comment and is dropped
//     (this is how the [SAFETY-CRITICAL]/[TUNABLE] labels and the file header work).
//   - Text before the first section header is ignored (the file's own instructions).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve the .txt next to this module. Works under both runtimes (tsx/node locally and
// the bundled Vercel function) because __dirname isn't available in NodeNext ESM.
const promptsFilePath = join(dirname(fileURLToPath(import.meta.url)), "prompts.txt");

// Every prompt key the code relies on. Kept as a const list so a typo in a lookup is a
// compile error, and a missing section is caught at startup (below) rather than at runtime.
const REQUIRED_PROMPTS = ["agent_system", "telegram_formatting"] as const;
export type PromptKey = (typeof REQUIRED_PROMPTS)[number];

const SECTION_HEADER = /^===\s*(.+?)\s*===\s*$/;
const COMMENT_LINE = /^\s*#/;

function parsePrompts(raw: string): Record<string, string> {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const header = line.match(SECTION_HEADER);
    if (header) {
      current = header[1];
      sections[current] ??= [];
      continue;
    }
    if (current === null) continue; // preamble before the first section
    if (COMMENT_LINE.test(line)) continue; // human-only comment
    sections[current].push(line);
  }

  const out: Record<string, string> = {};
  for (const [name, lines] of Object.entries(sections)) {
    out[name] = lines.join("\n").trim();
  }
  return out;
}

function loadPrompts(): Record<PromptKey, string> {
  let raw: string;
  try {
    raw = readFileSync(promptsFilePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read the prompts file at ${promptsFilePath}: ${(err as Error).message}. ` +
        `On Vercel, confirm it is bundled (see vercel.json "includeFiles").`
    );
  }

  const parsed = parsePrompts(raw);
  const missing = REQUIRED_PROMPTS.filter((k) => !parsed[k] || parsed[k].length === 0);
  if (missing.length > 0) {
    throw new Error(
      `prompts.txt is missing required section(s): ${missing.join(", ")}. ` +
        `Each must be present and non-empty under a "=== name ===" header.`
    );
  }

  // Narrow to exactly the required keys - extra sections in the file are allowed but not exposed.
  const result = {} as Record<PromptKey, string>;
  for (const key of REQUIRED_PROMPTS) result[key] = parsed[key];
  return result;
}

// Loaded once at module import; a malformed/missing file fails fast here with a clear message.
export const prompts: Record<PromptKey, string> = loadPrompts();
