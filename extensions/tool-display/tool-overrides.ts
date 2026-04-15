import type {
  BashToolDetails,
  EditToolDetails,
  ExtensionAPI,
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
  ReadToolDetails,
} from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  formatSize,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { renderBashCall } from "./bash-display.js";
import {
  renderEditDiffResult,
  renderWriteDiffResult,
} from "./diff-renderer.js";
import {
  compactOutputLines,
  countNonEmptyLines,
  extractTextOutput,
  isLikelyQuietCommand,
  pluralize,
  previewLines,
  sanitizeAnsiForThemedOutput,
  shortenPath,
  splitLines,
} from "./render-utils.js";
import {
  countWriteContentLines,
  getWriteContentSizeBytes,
} from "./write-display-utils.js";

// Hardcoded from config.json
const PREVIEW_LINES = 8;
const EXPANDED_MAX_LINES = 4000;
const WRITE_EXECUTION_META_STATE_KEY = "__piToolDisplayWriteExecutionMeta";

interface BuiltInTools {
  read: ReturnType<typeof createReadTool>;
  grep: ReturnType<typeof createGrepTool>;
  find: ReturnType<typeof createFindTool>;
  ls: ReturnType<typeof createLsTool>;
  bash: ReturnType<typeof createBashTool>;
  edit: ReturnType<typeof createEditTool>;
  write: ReturnType<typeof createWriteTool>;
}

interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface ToolRenderContextLike {
  args?: unknown;
  toolCallId?: string;
  state?: unknown;
  isError?: boolean;
}

interface WriteExecutionMeta {
  previousContent?: string;
  fileExistedBeforeWrite: boolean;
}

const builtInToolCache = new Map<string, BuiltInTools>();

function readShellCommandPrefix(): string | undefined {
  try {
    const settingsPath = `${getAgentDir()}/settings.json`;
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const prefix = parsed["shellCommandPrefix"];
    return typeof prefix === "string" && prefix.length > 0 ? prefix : undefined;
  } catch {
    return undefined;
  }
}

function cloneToolParameters<T>(
  parameters: T,
  seen = new WeakMap<object, unknown>(),
): T {
  if (parameters === null || typeof parameters !== "object") return parameters;
  if (seen.has(parameters)) return seen.get(parameters) as T;
  const clone = Array.isArray(parameters)
    ? []
    : Object.create(Object.getPrototypeOf(parameters));
  seen.set(parameters, clone);
  for (const key of Reflect.ownKeys(parameters)) {
    const descriptor = Object.getOwnPropertyDescriptor(parameters, key);
    if (!descriptor) continue;
    if ("value" in descriptor)
      descriptor.value = cloneToolParameters(descriptor.value, seen);
    Object.defineProperty(clone, key, descriptor);
  }
  return clone as T;
}

function getBuiltInTools(cwd: string): BuiltInTools {
  let tools = builtInToolCache.get(cwd);
  if (!tools) {
    tools = {
      read: createReadTool(cwd),
      grep: createGrepTool(cwd),
      find: createFindTool(cwd),
      ls: createLsTool(cwd),
      bash: createBashTool(cwd, { commandPrefix: readShellCommandPrefix() }),
      edit: createEditTool(cwd),
      write: createWriteTool(cwd),
    };
    builtInToolCache.set(cwd, tools);
  }
  return tools;
}

function resolveWriteTargetPath(cwd: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return cwd;
  const expandedHome =
    trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? `${homedir()}${trimmed.slice(1)}`
      : trimmed;
  return isAbsolute(expandedHome) ? expandedHome : resolve(cwd, expandedHome);
}

function captureExistingWriteContent(
  cwd: string,
  rawPath: unknown,
): { existed: boolean; content?: string } {
  if (typeof rawPath !== "string" || !rawPath.trim()) return { existed: false };
  const resolvedPath = resolveWriteTargetPath(cwd, rawPath);
  if (!existsSync(resolvedPath)) return { existed: false };
  try {
    return { existed: true, content: readFileSync(resolvedPath, "utf8") };
  } catch {
    return { existed: true };
  }
}

function buildPreviewText(
  lines: string[],
  maxLines: number,
  theme: RenderTheme,
  expanded: boolean,
): string {
  if (lines.length === 0) return theme.fg("muted", "↳ (no output)");
  const { shown, remaining } = previewLines(lines, maxLines);
  let text = shown
    .map((line) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(line)))
    .join("\n");
  if (remaining > 0) {
    const hint = expanded ? "" : " • Ctrl+O to expand";
    text += `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")}${hint})`)}`;
  }
  return text;
}

function prepareOutputLines(
  rawText: string,
  options: { expanded: boolean },
): string[] {
  return compactOutputLines(splitLines(rawText), {
    expanded: options.expanded,
    maxCollapsedConsecutiveEmptyLines: 1,
  });
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "string" ? raw : undefined;
}

function getNumericField(value: unknown, field: string): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function getToolPathArg(value: unknown): string | undefined {
  return getStringField(value, "file_path") ?? getStringField(value, "path");
}

function getToolContentArg(value: unknown): string | undefined {
  return getStringField(value, "content");
}

function getEditLineCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const record = value as Record<string, unknown>;
  const edits = Array.isArray(record.edits) ? record.edits : [];
  if (edits.length > 0) {
    return edits.reduce((total: number, edit: unknown) => {
      const editRecord =
        edit && typeof edit === "object"
          ? (edit as Record<string, unknown>)
          : {};
      const newText = editRecord.newText;
      return (
        total + (typeof newText === "string" ? splitLines(newText).length : 0)
      );
    }, 0);
  }
  return typeof record.newText === "string"
    ? splitLines(record.newText).length
    : 0;
}

function isToolError(
  result: unknown,
  context?: ToolRenderContextLike,
): boolean {
  return (
    context?.isError === true ||
    (result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>).isError === true
      : false)
  );
}

function getWriteExecutionMeta(
  context: ToolRenderContextLike | undefined,
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
): WriteExecutionMeta | undefined {
  if (!context) return undefined;
  const carrier =
    context.state &&
    typeof context.state === "object" &&
    !Array.isArray(context.state)
      ? (context.state as Record<string, unknown>)
      : undefined;
  const existing = carrier
    ? (carrier[WRITE_EXECUTION_META_STATE_KEY] as
        | WriteExecutionMeta
        | undefined)
    : undefined;
  if (existing && Object.keys(existing).length > 0) return existing;
  if (!context.toolCallId) return undefined;
  const pending = pendingMetaByToolCallId.get(context.toolCallId);
  if (!pending) return undefined;
  if (carrier) {
    carrier[WRITE_EXECUTION_META_STATE_KEY] = { ...pending };
    pendingMetaByToolCallId.delete(context.toolCallId);
    return carrier[WRITE_EXECUTION_META_STATE_KEY] as WriteExecutionMeta;
  }
  return pending;
}

function formatLineCountSuffix(lineCount: number, theme: RenderTheme): string {
  return theme.fg("muted", ` (${lineCount} ${pluralize(lineCount, "line")})`);
}

function formatInProgressLineCount(
  action: string,
  lineCount: number,
  theme: RenderTheme,
): string {
  return (
    theme.fg("warning", `${action}...`) +
    formatLineCountSuffix(lineCount, theme)
  );
}

export function registerToolOverrides(pi: ExtensionAPI): void {
  const bootstrapTools = getBuiltInTools(process.cwd());
  const builtInPromptMetadata = {
    read: extractPromptMetadata(bootstrapTools.read),
    grep: extractPromptMetadata(bootstrapTools.grep),
    find: extractPromptMetadata(bootstrapTools.find),
    ls: extractPromptMetadata(bootstrapTools.ls),
    bash: extractPromptMetadata(bootstrapTools.bash),
    edit: extractPromptMetadata(bootstrapTools.edit),
    write: extractPromptMetadata(bootstrapTools.write),
  };
  const clonedParameters = {
    read: cloneToolParameters(bootstrapTools.read.parameters),
    grep: cloneToolParameters(bootstrapTools.grep.parameters),
    find: cloneToolParameters(bootstrapTools.find.parameters),
    ls: cloneToolParameters(bootstrapTools.ls.parameters),
    bash: cloneToolParameters(bootstrapTools.bash.parameters),
    edit: cloneToolParameters(bootstrapTools.edit.parameters),
    write: cloneToolParameters(bootstrapTools.write.parameters),
  };
  const writeExecutionMetaByToolCallId = new Map<string, WriteExecutionMeta>();

  pi.registerTool({
    name: "read",
    label: "read",
    description: bootstrapTools.read.description,
    ...builtInPromptMetadata.read,
    parameters: clonedParameters.read,
    prepareArguments: bootstrapTools.read.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).read.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const path = shortenPath(getToolPathArg(args));
      const offset = getNumericField(args, "offset");
      const limit = getNumericField(args, "limit");
      let suffix = "";
      if (offset !== undefined || limit !== undefined) {
        const from = offset ?? 1;
        const to = limit !== undefined ? from + limit - 1 : undefined;
        suffix = to ? `:${from}-${to}` : `:${from}`;
      }
      return new Text(
        `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path || "...")}${theme.fg("warning", suffix)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      if (options.isPartial)
        return new Text(theme.fg("warning", "reading..."), 0, 0);
      const rawOutput = extractTextOutput(result);
      // readOutputMode: "summary"
      const lines = compactOutputLines(splitLines(rawOutput), {
        expanded: true,
      });
      return new Text(
        theme.fg(
          "muted",
          `↳ loaded ${lines.length} ${pluralize(lines.length, "line")}`,
        ),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "grep",
    label: "grep",
    description: bootstrapTools.grep.description,
    ...builtInPromptMetadata.grep,
    parameters: clonedParameters.grep,
    prepareArguments: bootstrapTools.grep.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).grep.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const scope = shortenPath(getStringField(args, "path") || ".");
      const globSuffix = getStringField(args, "glob")
        ? ` (${getStringField(args, "glob")})`
        : "";
      const limitVal = getNumericField(args, "limit");
      const limitSuffix = limitVal !== undefined ? ` limit ${limitVal}` : "";
      const pattern = getStringField(args, "pattern") || "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${pattern}/`)}${theme.fg("muted", ` in ${scope}${globSuffix}${limitSuffix}`)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      if (options.isPartial)
        return new Text(theme.fg("warning", "running..."), 0, 0);
      // searchOutputMode: "count"
      const lines = prepareOutputLines(extractTextOutput(result), options);
      const count = countNonEmptyLines(lines);
      return new Text(
        theme.fg(
          "muted",
          `↳ ${count} ${pluralize(count, "match", "matches")} returned`,
        ),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description: bootstrapTools.find.description,
    ...builtInPromptMetadata.find,
    parameters: clonedParameters.find,
    prepareArguments: bootstrapTools.find.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).find.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const scope = shortenPath(getStringField(args, "path") || ".");
      const limitVal = getNumericField(args, "limit");
      const limitSuffix = limitVal !== undefined ? ` (limit ${limitVal})` : "";
      const pattern = getStringField(args, "pattern") || "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}${theme.fg("muted", ` in ${scope}${limitSuffix}`)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      if (options.isPartial)
        return new Text(theme.fg("warning", "running..."), 0, 0);
      // searchOutputMode: "count"
      const lines = prepareOutputLines(extractTextOutput(result), options);
      const count = countNonEmptyLines(lines);
      return new Text(
        theme.fg("muted", `↳ ${count} ${pluralize(count, "result")} returned`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "ls",
    label: "ls",
    description: bootstrapTools.ls.description,
    ...builtInPromptMetadata.ls,
    parameters: clonedParameters.ls,
    prepareArguments: bootstrapTools.ls.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).ls.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const scope = shortenPath(getStringField(args, "path") || ".");
      const limitVal = getNumericField(args, "limit");
      const limitSuffix = limitVal !== undefined ? ` (limit ${limitVal})` : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", scope)}${theme.fg("muted", limitSuffix)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      if (options.isPartial)
        return new Text(theme.fg("warning", "running..."), 0, 0);
      // searchOutputMode: "count"
      const lines = prepareOutputLines(extractTextOutput(result), options);
      const count = countNonEmptyLines(lines);
      return new Text(
        theme.fg(
          "muted",
          `↳ ${count} ${pluralize(count, "entry", "entries")} returned`,
        ),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: bootstrapTools.edit.description,
    ...builtInPromptMetadata.edit,
    parameters: clonedParameters.edit,
    prepareArguments: bootstrapTools.edit.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).edit.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const path = shortenPath(getToolPathArg(args));
      const lineCount = getEditLineCount(args);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path || "...")}${formatLineCountSuffix(lineCount, theme)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      const lineCount = getEditLineCount(context?.args);
      if (options.isPartial) {
        return new Text(
          formatInProgressLineCount("editing", lineCount, theme),
          0,
          0,
        );
      }
      const fallbackText = extractTextOutput(result);
      if (isToolError(result, context)) {
        return new Text(
          theme.fg("error", fallbackText || "Edit failed."),
          0,
          0,
        );
      }
      return renderEditDiffResult(
        result.details as EditToolDetails | undefined,
        { expanded: options.expanded, filePath: getToolPathArg(context?.args) },
        theme,
        fallbackText,
      );
    },
  });

  pi.registerTool({
    name: "write",
    label: "write",
    description: bootstrapTools.write.description,
    ...builtInPromptMetadata.write,
    parameters: clonedParameters.write,
    prepareArguments: bootstrapTools.write.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const previous = captureExistingWriteContent(ctx.cwd, params.path);
      writeExecutionMetaByToolCallId.set(toolCallId, {
        fileExistedBeforeWrite: previous.existed,
        previousContent: previous.content,
      });
      return getBuiltInTools(ctx.cwd).write.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const content = getToolContentArg(args);
      const lineCount = countWriteContentLines(content);
      const sizeBytes = getWriteContentSizeBytes(content);
      const path = shortenPath(getToolPathArg(args));
      const suffix =
        content !== undefined
          ? theme.fg(
              "muted",
              ` (${lineCount} ${pluralize(lineCount, "line")} • ${formatSize(sizeBytes)})`,
            )
          : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path || "...")}${suffix}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      const content = getToolContentArg(context?.args);
      const lineCount = countWriteContentLines(content);
      if (options.isPartial) {
        return new Text(
          formatInProgressLineCount("writing", lineCount, theme),
          0,
          0,
        );
      }
      const fallbackText = extractTextOutput(result);
      if (isToolError(result, context)) {
        return new Text(
          theme.fg("error", fallbackText || "Write failed."),
          0,
          0,
        );
      }
      const executionMeta = getWriteExecutionMeta(
        context,
        writeExecutionMetaByToolCallId,
      );
      return renderWriteDiffResult(
        content,
        {
          expanded: options.expanded,
          filePath: getToolPathArg(context?.args),
          previousContent: executionMeta?.previousContent,
          fileExistedBeforeWrite:
            executionMeta?.fileExistedBeforeWrite ?? false,
        },
        theme,
        fallbackText,
      );
    },
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: bootstrapTools.bash.description,
    ...builtInPromptMetadata.bash,
    parameters: clonedParameters.bash,
    prepareArguments: bootstrapTools.bash.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).bash.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, context) {
      return renderBashCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      const rawOutput = extractTextOutput(result);

      if (options.isPartial) {
        const lines = prepareOutputLines(rawOutput, options);
        if (lines.length === 0) return new Text("", 0, 0);
        const maxLines = options.expanded
          ? Math.min(lines.length, EXPANDED_MAX_LINES)
          : PREVIEW_LINES;
        return new Text(
          buildPreviewText(lines, maxLines, theme, options.expanded),
          0,
          0,
        );
      }

      if (isToolError(result, context)) {
        const lines = prepareOutputLines(rawOutput, options);
        let text = theme.fg("error", "↳ command failed");
        if (lines.length > 0) {
          const maxLines = options.expanded
            ? Math.min(lines.length, EXPANDED_MAX_LINES)
            : PREVIEW_LINES;
          const { shown, remaining } = previewLines(lines, maxLines);
          text +=
            "\n" +
            shown
              .map((l) => theme.fg("error", sanitizeAnsiForThemedOutput(l)))
              .join("\n");
          if (remaining > 0) {
            const hint = options.expanded ? "" : " • Ctrl+O to expand";
            text +=
              "\n" +
              theme.fg(
                "muted",
                `... (${remaining} more ${pluralize(remaining, "line")}${hint})`,
              );
          }
        }
        return new Text(text, 0, 0);
      }

      // bashOutputMode: "summary"
      const lines = prepareOutputLines(rawOutput, options);
      if (lines.length === 0) {
        const command = getStringField(context?.args, "command");
        return new Text(
          theme.fg(
            "muted",
            isLikelyQuietCommand(command)
              ? "↳ command completed (no output)"
              : "↳ (no output)",
          ),
          0,
          0,
        );
      }
      return new Text(
        theme.fg(
          "muted",
          `↳ ${lines.length} ${pluralize(lines.length, "line")} returned`,
        ),
        0,
        0,
      );
    },
  });
}

function extractPromptMetadata(tool: unknown): { promptSnippet?: string; promptGuidelines?: string[] } {
  const t = tool as Record<string, unknown>;
  const promptSnippet =
    typeof t.promptSnippet === "string" &&
    t.promptSnippet.trim().length > 0
      ? t.promptSnippet
      : undefined;
  const guidelines = Array.isArray(t.promptGuidelines)
    ? t.promptGuidelines.filter(
        (g): g is string => typeof g === "string" && g.trim().length > 0,
      )
    : undefined;
  return {
    promptSnippet,
    promptGuidelines: guidelines?.length ? [...guidelines] : undefined,
  };
}
