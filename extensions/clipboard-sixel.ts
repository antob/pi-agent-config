/**
 * clipboard-sixel
 *
 * Pastes a clipboard image into the current message and shows an inline
 * Sixel preview in the TUI. The image is attached to the user message so
 * the agent can see it.
 *
 * Commands:
 *   /paste-image            read from clipboard
 *   /paste-image clipboard  explicit subcommand
 *
 * Shortcuts: Ctrl+V, Alt+V, Ctrl+Alt+V
 *
 * Requires one Sixel converter:
 *   img2sixel  (libsixel)
 *   magick     (ImageMagick v7)
 *   convert    (ImageMagick v6)
 *   chafa
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  calculateImageRows,
  getCellDimensions,
  getImageDimensions,
} from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Clipboard reading (cross-platform)
// ---------------------------------------------------------------------------

interface ClipboardImage {
  bytes: Uint8Array;
  mimeType: string;
}

interface CommandResult {
  ok: boolean;
  stdout: Buffer;
  missingCommand: boolean;
}

interface ClipboardReadResult {
  available: boolean;
  image: ClipboardImage | null;
}

const LIST_TYPES_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = 5000;
const MAX_CLIPBOARD_BYTES = 50 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
] as const;

function isErrnoException(error: Error): error is NodeJS.ErrnoException {
  return "code" in error;
}

function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function selectPreferredMimeType(mimeTypes: readonly string[]): string | null {
  const normalized = mimeTypes
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ raw: t, normalized: normalizeMimeType(t) }));

  for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
    const match = normalized.find((t) => t.normalized === preferred);
    if (match) return match.raw;
  }
  return normalized.find((t) => t.normalized.startsWith("image/"))?.raw ?? null;
}

function runCommand(
  command: string,
  args: string[],
  timeout: number,
): CommandResult {
  const result = spawnSync(command, args, {
    timeout,
    maxBuffer: MAX_CLIPBOARD_BYTES,
  });
  if (result.error) {
    return {
      ok: false,
      stdout: Buffer.alloc(0),
      missingCommand:
        isErrnoException(result.error) && result.error.code === "ENOENT",
    };
  }
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(
        result.stdout ?? "",
        typeof result.stdout === "string" ? "utf8" : undefined,
      );
  return { ok: result.status === 0, stdout, missingCommand: false };
}

function readViaWlPaste(): ClipboardReadResult {
  const list = runCommand("wl-paste", ["--list-types"], LIST_TYPES_TIMEOUT_MS);
  if (list.missingCommand) return { available: false, image: null };
  if (!list.ok) return { available: true, image: null };

  const mimeTypes = list.stdout
    .toString("utf8")
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean);
  const selected = selectPreferredMimeType(mimeTypes);
  if (!selected) return { available: true, image: null };

  const data = runCommand(
    "wl-paste",
    ["--type", selected, "--no-newline"],
    READ_TIMEOUT_MS,
  );
  if (!data.ok || data.stdout.length === 0)
    return { available: true, image: null };
  return {
    available: true,
    image: {
      bytes: new Uint8Array(data.stdout),
      mimeType: normalizeMimeType(selected),
    },
  };
}

function readViaXclip(): ClipboardReadResult {
  const targets = runCommand(
    "xclip",
    ["-selection", "clipboard", "-t", "TARGETS", "-o"],
    LIST_TYPES_TIMEOUT_MS,
  );
  if (targets.missingCommand) return { available: false, image: null };

  const advertised = targets.ok
    ? targets.stdout
        .toString("utf8")
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const preferred =
    advertised.length > 0 ? selectPreferredMimeType(advertised) : null;
  const toTry = preferred
    ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES]
    : [...SUPPORTED_IMAGE_MIME_TYPES];

  for (const mimeType of toTry) {
    const data = runCommand(
      "xclip",
      ["-selection", "clipboard", "-t", mimeType, "-o"],
      READ_TIMEOUT_MS,
    );
    if (data.ok && data.stdout.length > 0) {
      return {
        available: true,
        image: {
          bytes: new Uint8Array(data.stdout),
          mimeType: normalizeMimeType(mimeType),
        },
      };
    }
  }
  return { available: true, image: null };
}

async function readClipboardImage(): Promise<ClipboardImage | null> {
  const env = process.env;

  if (env.TERMUX_VERSION) return null;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw new Error(
      "Clipboard requires a graphical session (DISPLAY or WAYLAND_DISPLAY).",
    );
  }

  const readers = isWaylandSession(env)
    ? [readViaWlPaste, readViaXclip]
    : [readViaXclip, readViaWlPaste];

  const results: ClipboardReadResult[] = [];
  for (const reader of readers) {
    const result = reader();
    results.push(result);
    if (result.image) return result.image;
  }

  if (results.some((r) => r.available)) return null;
  throw new Error(
    "No clipboard image reader available. Install wl-clipboard or xclip.",
  );
}

// ---------------------------------------------------------------------------
// Sixel conversion
// ---------------------------------------------------------------------------

const CONVERTERS = [
  {
    bin: "img2sixel",
    args: (widthPx: number) => [`-w`, String(widthPx), `-`],
  },
  {
    bin: "magick",
    args: (widthPx: number) => [`-`, `-resize`, `${widthPx}x>`, `sixel:-`],
  },
  {
    bin: "convert",
    args: (widthPx: number) => [`-`, `-resize`, `${widthPx}x>`, `sixel:-`],
  },
  {
    bin: "chafa",
    args: (widthPx: number) => [
      `--format=sixel`,
      `--size=${Math.round(widthPx / (getCellDimensions().widthPx || 9))}x`,
      `-`,
    ],
  },
];

function findConverter(): (typeof CONVERTERS)[number] | null {
  for (const c of CONVERTERS) {
    if (spawnSync("which", [c.bin], { encoding: "utf8" }).status === 0)
      return c;
  }
  return null;
}

function toSixel(
  bytes: Uint8Array,
  widthPx: number,
  converter: (typeof CONVERTERS)[number],
): string | null {
  const result = spawnSync(converter.bin, converter.args(widthPx), {
    input: Buffer.from(bytes),
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status === 0 && result.stdout?.length > 0) {
    return (result.stdout as Buffer).toString("binary");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sixel TUI component
//
// Reserves `rows` lines in the TUI layout then moves the cursor back up and
// outputs the Sixel sequence. The IMAGE_LINE_GUARD prefix is a no-op Kitty
// APC chunk so pi-tui's isImageLine() skips width truncation on this line.
// ---------------------------------------------------------------------------

const IMAGE_LINE_GUARD = "\x1b_Gm=0;\x1b\\";

class SixelComponent implements Component {
  private readonly cachedLines: string[];

  constructor(sixelData: string, rows: number) {
    const safeRows = Math.max(1, Math.min(rows, 80));
    const blank = Array.from<string>({ length: safeRows - 1 }).fill("");
    const moveUp = safeRows > 1 ? `\x1b[${safeRows - 1}A` : "";
    this.cachedLines = [...blank, `${IMAGE_LINE_GUARD}${moveUp}${sixelData}`];
  }

  invalidate(): void {}

  render(_width: number): string[] {
    return this.cachedLines;
  }
}

// ---------------------------------------------------------------------------
// Marker helpers
// ---------------------------------------------------------------------------

const ATTACHMENT_MARKER = "[󰈟 Image Attached]";

function countMarkers(text: string): number {
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(ATTACHMENT_MARKER, i)) !== -1) {
    n++;
    i += ATTACHMENT_MARKER.length;
  }
  return n;
}

function removeMarkers(text: string): string {
  return text
    .split(ATTACHMENT_MARKER)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Custom message type for the Sixel preview
// ---------------------------------------------------------------------------

const PREVIEW_TYPE = "clipboard-sixel-preview";

type ImagePayload = { type: "image"; data: string; mimeType: string };
type PreviewDetails = { sixelData: string; rows: number };

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const pending: ImagePayload[] = [];

  pi.registerMessageRenderer<PreviewDetails>(PREVIEW_TYPE, (message) => {
    const d = message.details as PreviewDetails | undefined;
    if (!d?.sixelData) return undefined;
    return new SixelComponent(d.sixelData, d.rows);
  });

  pi.on("input", async (event) => {
    if (event.source === "extension" || pending.length === 0) {
      return { action: "continue" as const };
    }
    const markerCount = countMarkers(event.text);
    if (markerCount === 0) {
      pending.length = 0;
      return { action: "continue" as const };
    }
    const toAttach = pending.splice(0, markerCount);
    return {
      action: "transform" as const,
      text: removeMarkers(event.text),
      images: [...(event.images ?? []), ...toAttach],
    };
  });

  const pasteFromClipboard = async (
    ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
  ) => {
    if (!ctx.hasUI) return;

    const converter = findConverter();
    if (!converter) {
      ctx.ui.notify(
        "No Sixel converter found. Install one of: img2sixel, magick, convert, chafa",
        "error",
      );
      return;
    }

    let image: ClipboardImage | null;
    try {
      image = await readClipboardImage();
    } catch (err) {
      ctx.ui.notify(
        `Clipboard read failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return;
    }

    if (!image) {
      ctx.ui.notify("No image found in clipboard.", "warning");
      return;
    }

    const base64 = Buffer.from(image.bytes).toString("base64");

    const cell = getCellDimensions();
    const maxCols = Math.min((process.stdout.columns || 80) - 2, 80);
    const widthPx = maxCols * cell.widthPx;

    const dims = getImageDimensions(base64, image.mimeType);
    const rows = dims ? calculateImageRows(dims, maxCols, cell) : 12;

    const sixelData = toSixel(image.bytes, widthPx, converter);
    if (!sixelData) {
      ctx.ui.notify(
        `Sixel conversion failed (converter: ${converter.bin})`,
        "error",
      );
      return;
    }

    pending.push({ type: "image", data: base64, mimeType: image.mimeType });

    pi.sendMessage(
      {
        customType: PREVIEW_TYPE,
        content: "",
        display: true,
        details: { sixelData, rows } satisfies PreviewDetails,
      },
      { triggerTurn: false },
    );

    ctx.ui.pasteToEditor(`${ATTACHMENT_MARKER} `);
    ctx.ui.notify("Image attached. Add your message and send.", "info");
  };

  pi.registerCommand("paste-image", {
    description: "Attach clipboard image to the next message",
    getArgumentCompletions: (prefix) =>
      [
        {
          value: "clipboard",
          label: "clipboard",
          description: "Attach from clipboard",
        },
      ].filter((c) => c.value.startsWith(prefix.trim().toLowerCase())),
    handler: async (args, ctx) => {
      const sub = args?.trim().toLowerCase();
      if (!sub || sub === "clipboard") {
        await pasteFromClipboard(ctx);
        return;
      }
      ctx.ui.notify("Usage: /paste-image [clipboard]", "warning");
    },
  });

  pi.registerShortcut("ctrl+v", {
    description: "Paste image from clipboard",
    handler: async (ctx) => pasteFromClipboard(ctx),
  });
}
