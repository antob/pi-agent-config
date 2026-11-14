/**
 * Subagent plumbing for the subagent skill (skills/subagent).
 *
 * Parent mode (default): creates an inbox directory, exports PI_SUBAGENT_INBOX,
 * PI_SUBAGENT_MODEL and PI_SUBAGENT_THINKING for the bash tool, and turns report
 * files dropped into the inbox into "subagent-report" messages that start a turn
 * when idle or queue as a follow-up when busy.
 *
 * Child mode (PI_SUBAGENT_REPORT_TO set by spawn.sh): registers the
 * subagent_report tool, which writes a report into the parent inbox and shuts pi
 * down unless PI_SUBAGENT_KEEP_OPEN=1. Quitting without a report sends an
 * "exited-without-report" entry so the parent is never left waiting.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MESSAGE_TYPE = "subagent-report";
const TOOL_NAME = "subagent_report";

type ReportStatus = "done" | "exited-without-report";

interface Report {
  id: string;
  name: string;
  status: ReportStatus;
  summary: string;
  pane?: string;
  keepOpen: boolean;
  sessionFile?: string;
  cwd: string;
}

export default function (pi: ExtensionAPI) {
  const reportTo = process.env.PI_SUBAGENT_REPORT_TO;
  if (reportTo) setupChild(pi, reportTo);
  else setupParent(pi);
}

// ---------------------------------------------------------------- parent

function setupParent(pi: ExtensionAPI) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const inbox = path.join(runtimeDir, "pi-subagents", String(process.pid));
  let watcher: fs.FSWatcher | undefined;
  const seen = new Set<string>();

  function exportModel(ctx: ExtensionContext) {
    if (ctx.model) process.env.PI_SUBAGENT_MODEL = `${ctx.model.provider}/${ctx.model.id}`;
    process.env.PI_SUBAGENT_THINKING = pi.getThinkingLevel();
  }

  function deliver(file: string) {
    if (!file.endsWith(".json") || seen.has(file)) return;
    const full = path.join(inbox, file);
    let report: Report;
    try {
      report = JSON.parse(fs.readFileSync(full, "utf-8")) as Report;
    } catch {
      return; // not there (yet), or already handled
    }
    seen.add(file);
    try {
      fs.unlinkSync(full);
    } catch {}

    const lines = [
      `Subagent report from "${report.name}" (id ${report.id}, status ${report.status}).`,
      `Pane: ${report.pane ?? "unknown"} (${report.keepOpen ? "kept open" : "closing"})`,
      `Session file: ${report.sessionFile ?? "none"}`,
      `Working directory: ${report.cwd}`,
      "",
      report.summary || "(empty report)",
    ];
    pi.sendMessage(
      { customType: MESSAGE_TYPE, content: lines.join("\n"), display: true, details: report },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
    process.env.PI_SUBAGENT_INBOX = inbox;
    exportModel(ctx);

    watcher?.close();
    watcher = fs.watch(inbox, (_type, file) => {
      if (file) deliver(file.toString());
    });
    for (const file of fs.readdirSync(inbox)) deliver(file);
  });

  pi.on("model_select", async (_event, ctx) => exportModel(ctx));
  pi.on("thinking_level_select", async (_event, ctx) => exportModel(ctx));

  pi.on("session_shutdown", async (event) => {
    watcher?.close();
    watcher = undefined;
    // Keep the inbox across reload/new/resume so in-flight reports are not lost.
    if (event.reason === "quit") fs.rmSync(inbox, { recursive: true, force: true });
  });
}

// ----------------------------------------------------------------- child

function setupChild(pi: ExtensionAPI, inbox: string) {
  const id = process.env.PI_SUBAGENT_ID || String(process.pid);
  const name = process.env.PI_SUBAGENT_NAME || id;
  const keepOpen = process.env.PI_SUBAGENT_KEEP_OPEN === "1";
  let reported = false;
  let seq = 0;

  function writeReport(ctx: ExtensionContext, status: ReportStatus, summary: string) {
    const report: Report = {
      id,
      name,
      status,
      summary,
      pane: process.env.TMUX_PANE,
      keepOpen,
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      cwd: ctx.cwd,
    };
    const base = path.join(inbox, `${id}-${++seq}`);
    // Write then rename, so the parent never reads a partial file.
    fs.writeFileSync(`${base}.tmp`, JSON.stringify(report));
    fs.renameSync(`${base}.tmp`, `${base}.json`);
  }

  function lastAssistantText(ctx: ExtensionContext): string {
    const branch = ctx.sessionManager.getBranch() as Array<{
      type: string;
      message?: { role?: string; content?: unknown };
    }>;
    for (let i = branch.length - 1; i >= 0; i--) {
      const msg = branch[i].message;
      if (branch[i].type !== "message" || msg?.role !== "assistant") continue;
      if (!Array.isArray(msg.content)) continue;
      const text = msg.content
        .filter((c): c is { type: "text"; text: string } => c?.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return "";
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: "Subagent Report",
    description:
      "Send your final result to the main agent that started you. Call it once when the task " +
      "is finished, or when you are blocked and need the main agent to decide.",
    promptSnippet: "Report your result to the main agent that started this subagent",
    promptGuidelines: [
      `Call ${TOOL_NAME} when the delegated task is finished or blocked. The main agent only sees what you pass to ${TOOL_NAME}, not your conversation.`,
    ],
    parameters: Type.Object({
      summary: Type.String({
        description:
          "Self-contained result for the main agent: findings, files changed, commands run, open questions.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { summary } = params as { summary: string };
      writeReport(ctx, "done", summary);
      reported = true;
      if (!keepOpen) ctx.shutdown();
      return {
        content: [
          {
            type: "text",
            text: keepOpen
              ? "Report sent to the main agent. This session stays open for the user."
              : "Report sent to the main agent. Shutting down.",
          },
        ],
        details: undefined,
        terminate: !keepOpen,
      };
    },
  });

  pi.on("session_start", async () => {
    // A --tools allowlist from spawn.sh may not name the tool, so force it on.
    pi.setActiveTools([...new Set([...pi.getActiveTools(), TOOL_NAME])]);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "quit" || reported) return;
    reported = true;
    try {
      const last = lastAssistantText(ctx);
      writeReport(
        ctx,
        "exited-without-report",
        last ? `Last assistant message:\n\n${last}` : "No assistant output.",
      );
    } catch {
      // Parent gone or inbox removed; nothing to report to.
    }
  });
}
