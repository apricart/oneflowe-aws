import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

function repositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const DEPLOYMENT_WORKFLOWS = [
  ".github/workflows/deploy-test.yml",
  ".github/workflows/deploy-prod.yml",
] as const

/** The job ids under `jobs:`, which the workflows indent by two spaces. */
function workflowJobNames(workflow: string): string[] {
  const jobs = repositoryFile(workflow).split(/^jobs:$/m)[1] ?? ""
  return [...jobs.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1])
}

/** The text of one job, from its id to the next job's. */
function workflowJob(workflow: string, job: string): string {
  const jobs = repositoryFile(workflow).split(/^jobs:$/m)[1] ?? ""
  const start = jobs.search(new RegExp(`^ {2}${job}:$`, "m"))
  if (start === -1) throw new Error(`${workflow} has no job named ${job}`)
  const rest = jobs.slice(start + 1)
  const next = rest.search(/^ {2}[a-z][a-z0-9-]*:$/m)
  return next === -1 ? jobs.slice(start) : jobs.slice(start, start + 1 + next)
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

  // The browser suite's webpack build can exceed 1 GB, and on a single runner it
  // once filled the disk the image build needed. Each deployment now builds
  // the image in a job of its own, where no browser test ever runs.
  it("builds both deployment images in a job that runs no browser tests", () => {
    for (const workflow of DEPLOYMENT_WORKFLOWS) {
      const buildImage = workflowJob(workflow, "build-image")

      expect(buildImage, workflow).toContain("docker/build-push-action@")
      expect(buildImage, workflow).not.toContain("e2e:smoke")
      expect(buildImage, workflow).not.toContain("playwright")
    }
  })

  // Building runs in parallel with the gates, so it must never publish: only
  // the job that waits for every gate may push to ECR.
  it("pushes an image to ECR only after every gate has passed", () => {
    const gates = ["checks", "unit-tests", "integration-tests", "e2e-smoke", "build-image"]

    for (const [workflow, publisher] of [
      [".github/workflows/deploy-test.yml", "deploy"],
      [".github/workflows/deploy-prod.yml", "build-and-report"],
    ] as const) {
      const buildImage = workflowJob(workflow, "build-image")
      expect(buildImage, workflow).toContain("push: false")
      expect(buildImage, workflow).not.toContain("docker push")

      const publish = workflowJob(workflow, publisher)
      expect(publish, workflow).toContain("docker push")
      const needs = publish.match(/^ {4}needs: \[([^\]]*)\]$/m)?.[1].split(",").map((job) => job.trim())
      expect(needs, workflow).toEqual(expect.arrayContaining(gates))

      const pushJobs = workflowJobNames(workflow).filter((job) =>
        workflowJob(workflow, job).includes("docker push"),
      )
      expect(pushJobs, workflow).toEqual([publisher])
    }

    expect(workflowJob(".github/workflows/deploy-prod.yml", "deploy")).toContain(
      "needs: build-and-report",
    )
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
