import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  deriveAllowedCommands,
  deriveIgnorePatterns,
  deriveSourcePatterns,
  deriveTestPatterns,
} from "../derive.js"
import type { PackageManagerId, ToolchainProfile, VerificationCommand } from "../types.js"

function hasPyprojectSection(cwd: string, section: string): boolean {
  const pyprojectPath = join(cwd, "pyproject.toml")
  if (!existsSync(pyprojectPath)) return false
  try {
    const content = readFileSync(pyprojectPath, "utf-8")
    return new RegExp(`^\\[${section.replace(/\./g, "\\.")}`, "m").test(content)
  } catch {
    return false
  }
}

function detectPackageManager(cwd: string): PackageManagerId {
  if (existsSync(join(cwd, "poetry.lock"))) return "poetry"
  if (existsSync(join(cwd, "Pipfile.lock"))) return "pipenv"
  if (existsSync(join(cwd, "uv.lock"))) return "uv"
  return "pip"
}

function pkgRunPrefix(pkg: PackageManagerId): string[] {
  switch (pkg) {
    case "poetry":
      return ["poetry", "run"]
    case "pipenv":
      return ["pipenv", "run"]
    case "uv":
      return ["uv", "run"]
    default:
      return ["python", "-m"]
  }
}

function detectTypeChecker(cwd: string): VerificationCommand | undefined {
  if (
    existsSync(join(cwd, "mypy.ini")) ||
    existsSync(join(cwd, ".mypy.ini")) ||
    hasPyprojectSection(cwd, "tool.mypy")
  ) {
    return { label: "mypy", cmd: "mypy", args: ["."], source: "auto-detected" }
  }

  if (existsSync(join(cwd, "pyrightconfig.json")) || hasPyprojectSection(cwd, "tool.pyright")) {
    return { label: "pyright", cmd: "pyright", args: [], source: "auto-detected" }
  }

  return undefined
}

function detectLinter(cwd: string): VerificationCommand | undefined {
  if (existsSync(join(cwd, "ruff.toml")) || hasPyprojectSection(cwd, "tool.ruff")) {
    return { label: "Ruff", cmd: "ruff", args: ["check", "."], source: "auto-detected" }
  }

  if (existsSync(join(cwd, ".flake8")) || hasPyprojectSection(cwd, "flake8")) {
    return { label: "flake8", cmd: "flake8", args: ["."], source: "auto-detected" }
  }

  if (existsSync(join(cwd, "pylintrc")) || hasPyprojectSection(cwd, "tool.pylint")) {
    return { label: "pylint", cmd: "pylint", args: ["."], source: "auto-detected" }
  }

  return undefined
}

function detectTestFramework(cwd: string, pkg: PackageManagerId): VerificationCommand | undefined {
  const prefix = pkgRunPrefix(pkg)

  if (
    existsSync(join(cwd, "conftest.py")) ||
    existsSync(join(cwd, "pytest.ini")) ||
    hasPyprojectSection(cwd, "tool.pytest")
  ) {
    return {
      label: "pytest",
      cmd: prefix[0] ?? "python",
      args: [...prefix.slice(1), "pytest", "-v"],
      source: "auto-detected",
    }
  }

  return undefined
}

export async function detect(cwd: string): Promise<Partial<ToolchainProfile> | null> {
  const markers = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"]
  const found = markers.some((m) => existsSync(join(cwd, m)))
  if (!found) return null

  const pkg = detectPackageManager(cwd)
  const typecheck = detectTypeChecker(cwd)
  const linter = detectLinter(cwd)
  const test = detectTestFramework(cwd, pkg)

  const extraTools: string[] = []
  if (typecheck) extraTools.push(typecheck.cmd)
  if (linter) extraTools.push(linter.cmd)
  if (test) extraTools.push(test.cmd)
  extraTools.push("pip-audit")

  return {
    language: "python",
    packageManager: pkg,
    checks: {
      ...(typecheck ? { typecheck } : {}),
      ...(linter ? { lint: linter } : {}),
      ...(test ? { test } : {}),
      audit: { label: "pip-audit", cmd: "pip-audit", args: [], source: "auto-detected" },
    },
    sourcePatterns: deriveSourcePatterns("python"),
    testPatterns: deriveTestPatterns("python"),
    ignorePatterns: deriveIgnorePatterns("python"),
    allowedCommands: deriveAllowedCommands("python", pkg, extraTools),
  }
}
