/**
 * clipboard-image extension
 *
 * Reads an image from the Wayland clipboard and appends it to the prompt
 * as an @file reference, so the agent can process it as an attachment.
 *
 * Dependencies: wl-paste (wl-clipboard), ImageMagick (convert)
 *
 * Keybinding: Ctrl+V
 * Command:    paste-image
 *
 * Linux/Wayland only.
 */
import type {
  ExtensionAPI,
  ExtensionContext
} from "@mariozechner/pi-coding-agent";
import os from "node:os";
import path from "node:path";

const SUPPORTED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/x-bmp",
  "image/x-ms-bmp",
  "image/x-ms-bitmap"
];
const MAX_DIMENSION = 2000;
const STATUS_KEY = "clipboard-image";

function pickImageType(types: string[]): string | null {
  for (const t of SUPPORTED_TYPES) {
    if (types.includes(t)) return t;
  }
  return types.find((t) => t.startsWith("image/")) ?? null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function outputPath(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T.]/g, "")
    .slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 8);
  return path.join(os.tmpdir(), `pi-clipboard-${ts}-${rand}.png`);
}

async function exec(
  pi: ExtensionAPI,
  cmd: string
): Promise<{ code?: number; stdout: string; stderr: string }> {
  return pi.exec("bash", ["-lc", `set -o pipefail; ${cmd}`], {
    timeout: 10000
  }) as Promise<{
    code?: number;
    stdout: string;
    stderr: string;
  }>;
}

async function captureWayland(pi: ExtensionAPI, out: string): Promise<void> {
  const listResult = await exec(pi, "wl-paste --list-types");
  if ((listResult.code ?? 0) !== 0) {
    throw new Error(
      `wl-paste --list-types failed: ${listResult.stderr.trim() || "unknown error"}`
    );
  }

  const types = listResult.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const imageType = pickImageType(types);
  if (!imageType) {
    throw new Error(
      `No image in clipboard (types: ${types.slice(0, 8).join(", ") || "none"}).`
    );
  }

  const result = await exec(
    pi,
    `wl-paste --type ${shellQuote(imageType)} | convert - -resize '${MAX_DIMENSION}x${MAX_DIMENSION}>' -strip png:${shellQuote(out)}`
  );
  if ((result.code ?? 0) !== 0) {
    throw new Error(
      `Clipboard capture failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`
    );
  }
}

function appendToEditor(ctx: ExtensionContext, ref: string): void {
  const current = ctx.ui.getEditorText();
  const sep =
    current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : "";
  ctx.ui.setEditorText(`${current}${sep}${ref}`);
}

async function pasteImage(
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<void> {
  ctx.ui.setStatus(STATUS_KEY, "Reading clipboard image…");

  try {
    const out = outputPath();
    await captureWayland(pi, out);
    appendToEditor(ctx, `@${out}`);
    ctx.ui.setStatus(STATUS_KEY, "Pasted.");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Clipboard capture failed.";
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.notify(message, "warning");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("alt+super+v", {
    description: "Paste clipboard image",
    handler: async (ctx) => pasteImage(pi, ctx)
  });

  pi.registerCommand("paste-image", {
    description: "Paste clipboard image into prompt",
    handler: async (_args, ctx) => pasteImage(pi, ctx)
  });
}
