import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

function repositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

describe("the production image build", () => {
  it("keeps every generated Next.js output directory out of the Docker context", () => {
    const dockerignore = repositoryFile(".dockerignore")

    expect(dockerignore.split(/\r?\n/)).toEqual(expect.arrayContaining([
      ".next",
      ".next-*",
      "tmp",
      "backups",
      "outputs",
      "deliverables",
      "updatedReports",
      "logs",
      ".codex-doc-work",
    ]))
  })

  it("reclaims the browser-test build before both deployment image builds", () => {
    for (const workflow of [
      ".github/workflows/deploy-test.yml",
      ".github/workflows/deploy-prod.yml",
    ]) {
      expect(repositoryFile(workflow), workflow).toContain(
        "run: rm -rf -- .next-e2e",
      )
    }
  })

  it("does not declare secret-shaped Docker build arguments or image variables", () => {
    const dockerfile = repositoryFile("Dockerfile")

    expect(dockerfile).not.toMatch(
      /^(?:ARG|ENV)\s+(?:NEXTAUTH_SECRET|UPSTASH_REDIS_REST_TOKEN|CRON_SECRET)\b/m,
    )
    expect(dockerfile).toContain(
      "RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/builddb",
    )
  })
})
