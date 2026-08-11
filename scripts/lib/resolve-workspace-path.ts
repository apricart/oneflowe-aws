import { isAbsolute, relative, resolve, sep } from "node:path"

const WORKSPACE_ROOT = resolve(process.cwd())

export function resolveWorkspacePath(input: string): string {
  const resolvedPath = resolve(WORKSPACE_ROOT, input)
  const pathFromWorkspace = relative(WORKSPACE_ROOT, resolvedPath)
  const escapesWorkspace = pathFromWorkspace === ".."
    || pathFromWorkspace.startsWith(`..${sep}`)
    || isAbsolute(pathFromWorkspace)

  if (escapesWorkspace) {
    throw new Error(`Path must stay within the workspace: ${input}`)
  }

  return resolvedPath
}
