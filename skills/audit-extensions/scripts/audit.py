#!/usr/bin/env python3
"""Collect facts for auditing Pi extensions, skills and packages.

Read-only: reads files, runs tsc (noEmit), `pi --version`, `git rev-parse`,
`git ls-remote` and queries the npm registry. Prints a Markdown report.
"""
import argparse
import contextlib
import datetime
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PI_PKGS = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]
LEGACY_SCOPE = "@mariozechner/"
CODE_EXT = {".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".py", ".sh", ".bash", ".zsh"}
SKIP_DIRS = {"node_modules", "__pycache__", ".git", "dist", "build", "coverage", "test", "tests", "__tests__"}

# Ordered by priority. shell-string is the high-signal one: a shell command built from a
# string with interpolation or concatenation, where quoting mistakes become injection.
SECURITY_PATTERNS = {
    "shell-string": r"\b(execSync|exec|execAsync)\(\s*`[^`]*\$\{|\b(execSync|exec)\(\s*['\"][^'\"]*['\"]\s*\+|shell:\s*true|\bos\.system\(|shell\s*=\s*True|\b(spawn|spawnSync|execFile|exec)\(\s*['\"](ba|z)?sh['\"]\s*,\s*\[\s*['\"]-c",
    "exec": r"child_process|\bexecSync\b|\bexecFile(Sync)?\b|\bspawn(Sync)?\(|(?<!\.)\bexec\(|Bun\.spawn|\bsubprocess\.|os\.system|pi\.exec\(",
    "eval": r"\beval\(|new Function\(|\bvm\.run|runInNewContext|importScripts",
    "network": r"\bfetch\(|https?\.request|\bWebSocket\b|\baxios\b|urllib\.request|\brequests\.(get|post)|\bcurl\b|\bwget\b|net\.connect|dgram",
    "secrets": r"auth\.json|API_KEY|apiKey|accessToken|refreshToken|[Bb]earer |\.ssh/|\.gnupg|keychain|secret-tool|getApiKey|credentials",
    "fs-write": r"writeFile|appendFile|\brmSync\b|\bunlink|\bfs\.rm\b|rm -rf|chmod|symlink|renameSync",
    "obfuscation": r"[A-Za-z0-9+/]{200,}={0,2}|(\\x[0-9a-fA-F]{2}){8,}",
    "env": r"process\.env|os\.environ|Bun\.env",
}
# Documentation only counts for these; prose mentions of files, keys or env vars are noise.
DOC_CATEGORIES = {"shell-string", "network", "obfuscation"}
LOW_PRIORITY = {"env"}
CHANGELOG = ROOT / "node_modules" / "@earendil-works" / "pi-coding-agent" / "CHANGELOG.md"
URL_RE = re.compile(r"https?://([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|127\.0\.0\.1)(:\d+)?")
LIFECYCLE = ("preinstall", "install", "postinstall", "prepare", "prepublish")


# ---------- helpers ----------

def run(cmd, cwd=None, timeout=60):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return -1, str(e)


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def rel(p):
    try:
        return str(Path(p).relative_to(ROOT))
    except ValueError:
        return str(p)


def npm_latest(name, offline):
    if offline:
        return "skipped"
    url = "https://registry.npmjs.org/" + urllib.parse.quote(name, safe="@") + "/latest"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "pi-audit-extensions"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r).get("version")
    except Exception as e:  # noqa: BLE001
        return f"error: {e.__class__.__name__}"


# ---------- semver (subset: *, x, ^, ~, comparators, ||, partial versions) ----------

def parse_ver(s):
    m = re.match(r"^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+.*)?$", s.strip())
    if not m:
        return None
    parts = []
    for g in m.groups():
        if g is None or g in ("x", "X", "*"):
            break
        parts.append(int(g))
    return parts


def pad(p):
    return tuple((list(p) + [0, 0, 0])[:3])


def _upper(p):
    return (p[0] + 1, 0, 0) if len(p) == 1 else (p[0], p[1] + 1, 0)


def _comp(v, c):
    m = re.match(r"^(\^|~|>=|<=|>|<|=)?(.*)$", c)
    op, rest = m.group(1) or "", m.group(2)
    if rest in ("", "*", "x", "X", "latest"):
        return True
    p = parse_ver(rest)
    if p is None:
        return None
    if not p:
        return True
    lo = pad(p)
    if op == "^":
        if lo[0] > 0 or len(p) == 1:
            hi = (lo[0] + 1, 0, 0)
        elif lo[1] > 0 or len(p) == 2:
            hi = (0, lo[1] + 1, 0)
        else:
            hi = (0, 0, lo[2] + 1)
        return lo <= v < hi
    if op == "~":
        return lo <= v < _upper(p if len(p) < 3 else p[:2])
    if op in ("", "="):
        return v == lo if len(p) == 3 else lo <= v < _upper(p)
    if op == ">=":
        return v >= lo
    if op == "<":
        return v < lo
    if op == ">":
        return v > lo if len(p) == 3 else v >= _upper(p)
    if op == "<=":
        return v <= lo if len(p) == 3 else v < _upper(p)
    return None


def satisfies(version, rng):
    """True / False / None (range form not understood)."""
    pv = parse_ver(version or "")
    if not pv:
        return None
    v = pad(pv)
    unknown = False
    for alt in rng.split("||"):
        alt = re.sub(r"(>=|<=|>|<|=|\^|~)\s+", r"\1", alt.strip())
        if " - " in alt:
            unknown = True
            continue
        results = [_comp(v, c) for c in alt.split()] or [True]
        if None in results:
            unknown = True
        elif all(results):
            return True
    return None if unknown else False


def newer(a, b):
    pa, pb = parse_ver(a or ""), parse_ver(b or "")
    if not pa or not pb:
        return None
    return pad(pa) > pad(pb)


def min_version(rng):
    m = re.search(r"\d+(\.\d+){0,2}", rng or "")
    return m.group(0) if m else None


# ---------- discovery ----------

def code_files(base):
    base = Path(base)
    if base.is_file():
        return [base] if base.suffix in CODE_EXT else []
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for f in filenames:
            p = Path(dirpath) / f
            if p.suffix in CODE_EXT and not f.endswith(".d.ts") and ".test." not in f and ".spec." not in f:
                out.append(p)
    return sorted(out)


def frontmatter(path):
    try:
        text = Path(path).read_text()
    except OSError:
        return {}
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    if not m:
        return {}
    fm = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip().strip("\"'")
    return fm


def pi_imports(files):
    mods = set()
    for f in files:
        try:
            text = f.read_text(errors="replace")
        except OSError:
            continue
        for m in re.finditer(r"""from\s+["']((?:@earendil-works|@mariozechner)/[^"']+)["']|import\(\s*["']((?:@earendil-works|@mariozechner)/[^"']+)["']""", text):
            mods.add(m.group(1) or m.group(2))
    return sorted(mods)


def parse_source(src):
    """Return (kind, name_or_url, ref, install_dir)."""
    if src.startswith("npm:"):
        spec = src[4:]
        at = spec.rfind("@")
        name, ver = (spec[:at], spec[at + 1:]) if at > 0 else (spec, None)
        return "npm", name, ver, ROOT / "npm" / "node_modules" / name
    s = src
    if s.startswith("git:"):
        s = s[4:]
    if re.match(r"^(https?|ssh|git)://", s) or re.match(r"^[\w.-]+\.[a-z]{2,}/", s) or s.startswith("git@"):
        s2 = re.sub(r"^(https?|ssh|git)://", "", s).replace("git@", "").replace(":", "/", 1 if s.startswith("git@") else 0)
        ref = None
        m = re.match(r"^(.*?)@([^/]+)$", s2)
        if m:
            s2, ref = m.group(1), m.group(2)
        s2 = s2.removesuffix(".git").rstrip("/")
        return "git", "https://" + s2, ref, ROOT / "git" / s2
    p = Path(os.path.expanduser(s))
    return "local", s, None, p if p.is_absolute() else ROOT / p


def package_resources(pkg_dir, pj):
    manifest = (pj or {}).get("pi") or {}
    exts = manifest.get("extensions")
    skills = manifest.get("skills")
    if exts is None and (pkg_dir / "extensions").is_dir():
        exts = ["./extensions"]
    if skills is None and (pkg_dir / "skills").is_dir():
        skills = ["./skills"]
    return [pkg_dir / e for e in (exts or [])], [pkg_dir / s for s in (skills or [])]


def doc_comment(path):
    """First block or line comment near the top of a source file, flattened to one line."""
    try:
        text = Path(path).read_text(errors="replace")
    except OSError:
        return None
    body = ""
    for m in re.finditer(r"/\*\*?(.*?)\*/", text[:3000], re.S):
        cand = " ".join(l.strip().lstrip("*").strip() for l in m.group(1).splitlines())
        if len(re.findall(r"[A-Za-z]{3,}", cand)) >= 4:  # skip separators like /* ── Types ── */
            body = cand
            break
    if not body:
        lines = []
        for l in text.splitlines()[:40]:
            s = l.strip()
            if s.startswith("//"):
                lines.append(s.lstrip("/").strip())
            elif lines and not s.startswith("//"):
                break
        body = " ".join(lines)
        if len(re.findall(r"[A-Za-z]{3,}", body)) < 4:
            body = ""
    body = re.sub(r"\s+", " ", body).strip()
    return (body[:240] + "...") if len(body) > 240 else (body or None)


def registrations(files):
    """Tool and command names an extension registers, for the summary column."""
    tools, cmds, providers, dynamic = set(), set(), set(), 0
    for f in files:
        try:
            text = f.read_text(errors="replace")
        except OSError:
            continue
        tools.update(re.findall(r"registerTool\(\s*\{[\s\S]{0,400}?\bname:\s*[\"']([\w-]+)[\"']", text))
        cmds.update(re.findall(r"registerCommand\(\s*[\"']([\w:-]+)[\"']", text))
        providers.update(re.findall(r"registerProvider\(\s*[\"']?([\w-]+)", text))
        dynamic += len(re.findall(r"registerTool\(\s*\{[\s\S]{0,400}?\bname:\s*[A-Za-z_]", text))
    parts = ["providers " + ", ".join(sorted(providers))] if providers else []
    if tools:
        parts.append("tools " + ", ".join(sorted(tools)))
    if dynamic:
        parts.append(f"{dynamic} registerTool call(s) with computed names")
    if cmds:
        parts.append("commands " + ", ".join("/" + c for c in sorted(cmds)))
    return "; ".join(parts) or "none"


def extension_entry(path):
    """Entry file for a local extension path (file or directory)."""
    path = Path(path)
    if path.is_file():
        return path
    for name in ("index.ts", "src/index.ts"):
        if (path / name).exists():
            return path / name
    return None


def find_skills(base):
    base = Path(base)
    if base.is_file() and base.name == "SKILL.md":
        return [base]
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        if "SKILL.md" in filenames:
            out.append(Path(dirpath) / "SKILL.md")
    return sorted(out)


# ---------- security scan ----------

def scan(files, max_hits):
    hits = {k: [] for k in SECURITY_PATTERNS}
    counts = {k: 0 for k in SECURITY_PATTERNS}
    hosts = set()
    regs = {k: re.compile(v) for k, v in SECURITY_PATTERNS.items()}
    for f in files:
        try:
            lines = f.read_text(errors="replace").splitlines()
        except OSError:
            continue
        is_doc = f.suffix == ".md"
        for i, line in enumerate(lines, 1):
            for h in URL_RE.finditer(line):
                hosts.add(h.group(1))
            for k, r in regs.items():
                if is_doc and k not in DOC_CATEGORIES:
                    continue
                if r.search(line):
                    counts[k] += 1
                    if len(hits[k]) < max_hits:
                        hits[k].append(f"{rel(f)}:{i}")
    return counts, hits, sorted(hosts)


def print_scan(files, max_hits):
    counts, hits, hosts = scan(files, max_hits)
    print(f"- files scanned: {len(files)}")
    for k in SECURITY_PATTERNS:
        if counts[k]:
            shown = hits[k][:3] if k in LOW_PRIORITY else hits[k]
            more = f" (+{counts[k] - len(shown)} more)" if counts[k] > len(shown) else ""
            label = "SHELL-STRING (high priority)" if k == "shell-string" else k
            print(f"- {label}: {counts[k]} hits: {', '.join(shown)}{more}")
    print(f"- hosts referenced: {', '.join(hosts) if hosts else 'none'}")


# ---------- sections ----------

def section_versions(offline):
    print("## Pi versions\n")
    pj = read_json(ROOT / "package.json") or {}
    deps = {**pj.get("dependencies", {}), **pj.get("devDependencies", {})}
    code, out = run(["pi", "--version"], timeout=20)
    global_ver = out.splitlines()[-1].strip() if code == 0 and out else None
    print(f"- global `pi --version`: {global_ver or 'not found: ' + out}")
    repo_core = None
    warnings = []
    for name in PI_PKGS:
        declared = deps.get(name)
        inst = (read_json(ROOT / "node_modules" / name / "package.json") or {}).get("version")
        npm_copy = (read_json(ROOT / "npm" / "node_modules" / name / "package.json") or {}).get("version")
        latest = npm_latest(name, offline)
        if name.endswith("pi-coding-agent"):
            repo_core = inst
        print(f"- {name}: declared {declared}, installed {inst}, npm/node_modules copy {npm_copy}, latest {latest}")
        if declared and inst and satisfies(inst, declared) is False:
            warnings.append(f"{name}: installed {inst} does not match declared {declared} (run bun install)")
        if npm_copy and inst and npm_copy != inst:
            warnings.append(f"{name}: npm/node_modules has {npm_copy}, repo has {inst}")
        if latest and inst and newer(latest, inst):
            warnings.append(f"{name}: newer release {latest} available (repo {inst})")
    if global_ver and repo_core and parse_ver(global_ver) and pad(parse_ver(global_ver)) != pad(parse_ver(repo_core)):
        warnings.insert(0, f"GLOBAL PI {global_ver} DIFFERS FROM REPO PI {repo_core}")
    legacy = sorted(p.parent.name for p in (ROOT / "node_modules" / "@mariozechner").glob("*/package.json"))
    if legacy:
        v = (read_json(ROOT / "node_modules/@mariozechner/pi-coding-agent/package.json") or {}).get("version")
        warnings.append(f"stale legacy packages in node_modules/@mariozechner: {', '.join(legacy)} (pi-coding-agent at {v}); not in package.json")
    print("\n### Version warnings\n")
    for w in warnings or ["none"]:
        print(f"- {w}")
    print()
    return repo_core


TSC = ROOT / "node_modules" / ".bin" / "tsc"


def pi_paths(include_current):
    """tsconfig paths that point Pi imports (and legacy @mariozechner ones) at the repo's packages."""
    nm = ROOT / "node_modules" / "@earendil-works"
    names = ("pi-coding-agent", "pi-ai", "pi-tui", "pi-agent-core")
    paths = {}
    scopes = [LEGACY_SCOPE] + (["@earendil-works/"] if include_current else [])
    for scope in scopes:
        for n in names:
            paths[f"{scope}{n}"] = [str(nm / n)]
            paths[f"{scope}{n}/*"] = [str(nm / n / "*")]
    return paths


def run_tsc(config):
    """Run tsc on a generated tsconfig. Returns (exit code, {file: [errors]}, other lines)."""
    with tempfile.TemporaryDirectory(prefix="pi-audit-") as td:
        cfg = Path(td) / "tsconfig.json"
        cfg.write_text(json.dumps(config))
        code, out = run([str(TSC), "-p", str(cfg), "--pretty", "false"], cwd=ROOT, timeout=300)
    errors, other = {}, []
    for line in out.splitlines():
        m = re.match(r"^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$", line)
        if m:
            f = m.group(1)
            f = str((ROOT / f).resolve()) if not os.path.isabs(f) else f
            errors.setdefault(f, []).append(f"{m.group(2)}: {m.group(4)} {m.group(5)}")
        elif line.strip() and not line.startswith(" "):
            other.append(line)
    return code, errors, other


def print_tsc(code, errors, other, max_hits, note, indent=""):
    if code == 0:
        print(f"{indent}- no errors ({note})")
        return
    total = sum(len(v) for v in errors.values())
    print(f"{indent}- exit {code}, {total} errors in {len(errors)} files ({note})")
    for f, errs in sorted(errors.items()):
        print(f"{indent}- {rel(f)}: {len(errs)}")
        for e in errs[:max_hits]:
            print(f"{indent}  - {e}")
    for line in other[:max_hits]:
        print(f"{indent}- {line}")


def section_typecheck(max_hits):
    print("## TypeScript check (local, against repo Pi)\n")
    if not TSC.exists():
        print("- tsc not found in node_modules/.bin, run `bun install`\n")
        return
    config = {"extends": str(ROOT / "tsconfig.json"), "compilerOptions": {"paths": pi_paths(False)}}
    print_tsc(*run_tsc(config), max_hits, "legacy @mariozechner imports mapped to @earendil-works")
    print()


def package_typecheck(pdir, exts, max_hits):
    """Type-check a package's extension entry points against the repo's Pi packages."""
    if not TSC.exists() or not exts:
        return
    files, include = [], []
    for e in exts:
        if e.is_file():
            files.append(str(e))
        elif e.is_dir():
            include.append(str(e / "**" / "*.ts"))
    own = pdir / "tsconfig.json"
    roots = [str(p) for p in (pdir / "node_modules" / "@types", ROOT / "node_modules" / "@types") if p.is_dir()]
    opts = {"paths": pi_paths(True), "noEmit": True, "skipLibCheck": True, "composite": False,
            "declaration": False, "incremental": False, "typeRoots": roots}

    def config(base, **extra):
        return {"extends": base, "compilerOptions": {**opts, **extra}, "files": files, "include": include,
                "exclude": ["**/*.test.ts", "**/*.spec.ts", "**/__tests__/**"]}

    if own.exists():
        print_tsc(*run_tsc(config(str(own))), max_hits, "against repo Pi, package tsconfig")
        return
    # No shipped tsconfig, so the package's real strictness is unknown. Errors that appear
    # both with and without strict are the likely API breaks; the rest depend on settings.
    base = str(ROOT / "tsconfig.json")
    types = ["node"] if (ROOT / "node_modules" / "@types" / "node").is_dir() else []
    c1, strict_errs, other = run_tsc(config(base, strict=True, types=types))
    c2, loose_errs, _ = run_tsc(config(base, strict=False, types=types))
    both = {}
    for f, errs in strict_errs.items():
        common = [e for e in errs if e in loose_errs.get(f, [])]
        if common:
            both[f] = common
    n_strict = sum(len(v) for v in strict_errs.values()) - sum(len(v) for v in both.values())
    n_loose = sum(len(v) for v in loose_errs.values()) - sum(len(v) for v in both.values())
    code = 1 if both or other else 0
    print_tsc(code, both, other, max_hits, "against repo Pi, repo tsconfig, errors present with and without strict")
    if n_strict or n_loose:
        print(f"- settings-dependent errors ignored: {n_strict} strict-only, {n_loose} non-strict-only")


def changelog_sections(since, until):
    """Breaking/Removed bullets from the Pi changelog for versions in (since, until]."""
    try:
        text = CHANGELOG.read_text()
    except OSError:
        return []
    lo, hi = pad(parse_ver(since)), pad(parse_ver(until))
    out, version, sub = [], None, None
    for line in text.splitlines():
        m = re.match(r"^## \[(\d+\.\d+\.\d+)\]", line)
        if m:
            v = pad(parse_ver(m.group(1)))
            version = m.group(1) if lo < v <= hi else None
            sub = None
            continue
        if line.startswith("### "):
            sub = line[4:].strip()
            continue
        if version and sub and re.match(r"(Breaking|Removed)", sub) and line.startswith("- "):
            out.append((version, sub, line[2:]))
    return out


COMMON_WORDS = {"null", "true", "false", "undefined", "string", "number", "object", "model", "models", "tools",
                "settings", "options", "context", "message", "messages", "result", "action", "prompt", "images"}


RECEIVERS = {"pi", "ctx", "session", "event", "e", "this"}


def changelog_symbols(bullet):
    """API-looking identifiers from backticks: camelCase, PascalCase, snake_case or dotted."""
    syms = set()
    for tok in re.findall(r"`([^`]+)`", bullet):
        tok = re.sub(r"\(.*\)$", "", tok.strip())
        if "/" in tok or " " in tok or not re.fullmatch(r"[A-Za-z_$][\w$.]*", tok):
            continue
        parts = tok.split(".")
        if parts[-1].lower() in {"json", "jsonl", "md", "ts", "js", "yaml", "yml", "toml", "ini"}:
            continue
        if len(parts) > 1 and parts[0] in RECEIVERS:
            parts = parts[1:]
        if len(parts) > 1:
            syms.add(".".join(parts))  # e.g. Type.Promise: only the qualified form is meaningful
            continue
        word = parts[0]
        if word.lower() in COMMON_WORDS or len(word) < 5:
            continue
        if re.search(r"[a-z][A-Z]", word) or "_" in word.strip("_") or re.fullmatch(r"[A-Z][a-z]+[A-Z]\w*", word):
            syms.add(word)
    return syms


def package_changelog(built, repo_core, files, max_hits):
    entries = changelog_sections(built, repo_core)
    print(f"- changelog {built} -> {repo_core}: {len(entries)} Breaking/Removed entries ({rel(CHANGELOG)})")
    texts = {}
    for f in files:
        try:
            texts[f] = f.read_text(errors="replace").splitlines()
        except OSError:
            pass
    matched = 0
    for version, sub, bullet in entries:
        locs = []
        for sym in sorted(changelog_symbols(bullet)):
            r = re.compile(rf"\b{re.escape(sym)}\b")
            for f, lines in texts.items():
                for i, line in enumerate(lines, 1):
                    if r.search(line):
                        locs.append(f"{sym} @ {rel(f)}:{i}")
        if locs:
            matched += 1
            short = bullet if len(bullet) <= 220 else bullet[:220] + "..."
            print(f"  - [{version} {sub}] {short}")
            more = f" (+{len(locs) - max_hits} more)" if len(locs) > max_hits else ""
            print(f"    - used: {', '.join(locs[:max_hits])}{more}")
    if entries and not matched:
        print("  - no symbol from those entries appears in the package source")


def section_local_extensions(max_hits):
    print("## Local extensions (extensions/)\n")
    for entry in sorted((ROOT / "extensions").iterdir()):
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            pj = read_json(entry / "package.json")
            entries, _ = package_resources(entry, pj) if pj else ([], [])
            if not entries and (entry / "index.ts").exists():
                entries = [entry / "index.ts"]
            if not entries:
                print(f"### {entry.name}/\n\n- not an extension (no index.ts or package.json), contents: {', '.join(sorted(p.name for p in entry.iterdir()))}\n")
                continue
        elif entry.suffix == ".ts":
            entries = [entry]
        else:
            continue
        files = code_files(entry)
        loc = sum(len(f.read_text(errors="replace").splitlines()) for f in files)
        imports = pi_imports(files)
        main_file = extension_entry(entry)
        print(f"### {entry.name}\n")
        print(f"- path: {rel(entry)}, {len(files)} files, {loc} lines")
        print(f"- doc: {(doc_comment(main_file) if main_file else None) or 'none'}")
        print(f"- registers: {registrations(files)}")
        print(f"- pi imports: {', '.join(imports) or 'none'}")
        if any(i.startswith(LEGACY_SCOPE) for i in imports):
            print("- LEGACY IMPORT: uses @mariozechner/* (old package scope)")
        print_scan(files, max_hits)
        print()


def section_skill(skill_md, max_hits, origin):
    d = skill_md.parent
    fm = frontmatter(skill_md)
    name = fm.get("name")
    print(f"### {name or d.name} ({origin})\n")
    print(f"- path: {rel(d)}")
    print(f"- description: {fm.get('description', 'MISSING')}")
    problems = []
    if not name:
        problems.append("missing name")
    elif name != d.name:
        problems.append(f"name '{name}' != dir '{d.name}'")
    elif not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", name) or len(name) > 64:
        problems.append("invalid name format")
    if not fm.get("description"):
        problems.append("missing description")
    if problems:
        print(f"- FRONTMATTER: {'; '.join(problems)}")
    nested_dirs = [s.parent for s in find_skills(d) if s != skill_md]
    files = [f for f in code_files(d) if not any(nd in f.parents for nd in nested_dirs)]
    print(f"- scripts: {', '.join(rel(f) for f in files) or 'none'}")
    if (d / "package.json").exists():
        pj = read_json(d / "package.json") or {}
        print(f"- package.json deps: {', '.join(f'{k}@{v}' for k, v in pj.get('dependencies', {}).items()) or 'none'}")
    print_scan(files + [skill_md], max_hits)
    print()


def section_local_skills(max_hits):
    print("## Local skills (skills/)\n")
    for s in find_skills(ROOT / "skills"):
        section_skill(s, max_hits, "local")


def section_packages(repo_core, offline, max_hits, typecheck):
    print("## Packages (settings.json)\n")
    settings = read_json(ROOT / "settings.json") or {}
    for item in settings.get("packages", []):
        src = item if isinstance(item, str) else item.get("source", "")
        kind, ident, ref, pdir = parse_source(src)
        pj = read_json(pdir / "package.json") or {}
        print(f"### {pj.get('name') or ident}\n")
        print(f"- source: {src} ({kind}), dir: {rel(pdir)}{'' if pdir.exists() else ' MISSING'}")
        print(f"- description: {pj.get('description') or 'none'}")
        version = pj.get("version")
        if kind == "npm":
            latest = npm_latest(ident, offline)
            flag = " UPDATE AVAILABLE" if newer(latest, version) else ""
            print(f"- version: {version}, latest: {latest}{flag}{', pinned to ' + ref if ref else ''}")
        elif kind == "git":
            _, head = run(["git", "-C", str(pdir), "rev-parse", "HEAD"])
            _, date = run(["git", "-C", str(pdir), "log", "-1", "--format=%cs"])
            remote = None
            if not offline:
                c, out = run(["git", "ls-remote", ident, ref or "HEAD"], timeout=20)
                remote = out.split()[0] if c == 0 and out else f"error: {out[:80]}"
            flag = " UPDATE AVAILABLE" if remote and head and not remote.startswith("error") and remote != head else ""
            print(f"- version: {version}, local {head[:10]} ({date}), remote {ref or 'HEAD'} {str(remote)[:10]}{flag}")
        else:
            print(f"- version: {version} (local path, no update check)")
        peers = pj.get("peerDependencies", {})
        dev = pj.get("devDependencies", {})
        for name, rng in sorted(peers.items()):
            if name.startswith(("@earendil-works/pi-", LEGACY_SCOPE)):
                ok = satisfies(repo_core, rng) if name.startswith("@earendil-works/") else False
                state = {True: "ok", False: "MISMATCH", None: "unknown range"}[ok]
                print(f"- peer {name} {rng}: {state} for repo {repo_core}")
        built = None
        for name, rng in sorted(dev.items()):
            if name.startswith(("@earendil-works/pi-", LEGACY_SCOPE)):
                mv = min_version(rng)
                drift = mv and repo_core and pad(parse_ver(mv))[:2] != pad(parse_ver(repo_core))[:2]
                if drift and name.endswith("pi-coding-agent"):
                    built = mv
                print(f"- built against {name} {rng}{' (OLDER THAN REPO, verify API use)' if drift else ''}")
        if not any(n.startswith(("@earendil-works/pi-", LEGACY_SCOPE)) for n in dev):
            print("- built against: unknown (no Pi devDependencies)")
        hooks = {k: v for k, v in pj.get("scripts", {}).items() if k in LIFECYCLE}
        for k, v in hooks.items():
            print(f"- LIFECYCLE SCRIPT {k}: `{v}`")
        print(f"- runtime deps: {', '.join(f'{k}@{v}' for k, v in pj.get('dependencies', {}).items()) or 'none'}")
        exts, skill_dirs = package_resources(pdir, pj)
        files = sorted({f for e in exts for f in code_files(e.parent if e.is_file() else e)})
        # Same-scope runtime deps often hold the real logic (e.g. @scope/core), so scan them too.
        scope = (pj.get("name") or "").split("/")[0] if (pj.get("name") or "").startswith("@") else None
        for dep in pj.get("dependencies", {}):
            if scope and dep.startswith(scope + "/"):
                dep_dir = pdir / "node_modules" / dep
                if not dep_dir.is_dir() and kind == "npm":
                    dep_dir = ROOT / "npm" / "node_modules" / dep
                dep_files = code_files(dep_dir)
                print(f"- same-scope dep {dep}: {rel(dep_dir)}, {len(dep_files)} files included in scan")
                files += dep_files
        imports = pi_imports(files)
        print(f"- extensions: {', '.join(rel(e) for e in exts) or 'none'}")
        print(f"- registers: {registrations(files)}")
        print(f"- pi imports: {', '.join(imports) or 'none'}")
        if any(i.startswith(LEGACY_SCOPE) for i in imports):
            print("- LEGACY IMPORT: uses @mariozechner/* (old package scope)")
        if typecheck:
            package_typecheck(pdir, exts, max_hits)
        if built and repo_core:
            package_changelog(built, repo_core, files, max_hits)
        print_scan(files, max_hits)
        print()
        for sd in skill_dirs:
            for s in find_skills(sd):
                section_skill(s, max_hits, f"from {pj.get('name') or ident}")


def section_install_scripts():
    print("## Installed dependencies with lifecycle scripts\n")
    found = []
    for nm in [ROOT / "node_modules", ROOT / "npm" / "node_modules", *(ROOT / "git").glob("*/*/*/node_modules")]:
        if not nm.is_dir():
            continue
        for pjp in list(nm.glob("*/package.json")) + list(nm.glob("@*/*/package.json")):
            pj = read_json(pjp) or {}
            hooks = {k: v for k, v in pj.get("scripts", {}).items() if k in ("preinstall", "install", "postinstall")}
            if hooks:
                cmds = "; ".join(f"{k}: `{v}`" for k, v in hooks.items())
                found.append(f"{rel(pjp.parent)}@{pj.get('version')} ({cmds})")
    for f in found or ["none"]:
        print(f"- {f}")
    print()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--offline", action="store_true", help="skip npm registry and git remote checks")
    ap.add_argument("--no-typecheck", action="store_true")
    ap.add_argument("--max-hits", type=int, default=6, help="locations listed per category")
    ap.add_argument("--out", type=Path, default=ROOT / "tmp" / "pi-audit", help="directory for the facts file")
    a = ap.parse_args()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        print(f"# Pi extension audit facts\n\nroot: {ROOT}\n")
        repo_core = section_versions(a.offline)
        if not a.no_typecheck:
            section_typecheck(a.max_hits)
        section_local_extensions(a.max_hits)
        section_local_skills(a.max_hits)
        section_packages(repo_core, a.offline, a.max_hits, not a.no_typecheck)
        section_install_scripts()
    a.out.mkdir(parents=True, exist_ok=True)
    path = a.out / f"{datetime.date.today().isoformat()}-facts.md"
    path.write_text(buf.getvalue())
    print(buf.getvalue())
    print(f"facts saved to {path}")


if __name__ == "__main__":
    sys.exit(main())
