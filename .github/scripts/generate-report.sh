#!/bin/bash
set -e

COMMIT_SHA="$1"
COMMIT_SHORT="${COMMIT_SHA:0:7}"
REPORT_MD="pipeline-report.md"
DATE_NOW=$(date -u '+%B %d, %Y at %H:%M UTC')

# ---- Count vulnerabilities from Trivy JSON (filesystem scan) ----
TRIVY_CRITICAL=0
TRIVY_HIGH=0
TRIVY_MEDIUM=0
TRIVY_LOW=0

if [ -f trivy-fs-report.json ]; then
  TRIVY_CRITICAL=$(grep -o '"Severity":"CRITICAL"' trivy-fs-report.json 2>/dev/null | wc -l || echo 0)
  TRIVY_HIGH=$(grep -o '"Severity":"HIGH"' trivy-fs-report.json 2>/dev/null | wc -l || echo 0)
  TRIVY_MEDIUM=$(grep -o '"Severity":"MEDIUM"' trivy-fs-report.json 2>/dev/null | wc -l || echo 0)
  TRIVY_LOW=$(grep -o '"Severity":"LOW"' trivy-fs-report.json 2>/dev/null | wc -l || echo 0)
fi

# ---- Count issues from Snyk JSON ----
SNYK_HIGH=0
SNYK_MEDIUM=0
SNYK_LOW=0
SNYK_TOTAL=0

if [ -f snyk-report.json ]; then
  SNYK_HIGH=$(grep -o '"severity":"high"' snyk-report.json 2>/dev/null | wc -l || echo 0)
  SNYK_MEDIUM=$(grep -o '"severity":"medium"' snyk-report.json 2>/dev/null | wc -l || echo 0)
  SNYK_LOW=$(grep -o '"severity":"low"' snyk-report.json 2>/dev/null | wc -l || echo 0)
  SNYK_TOTAL=$((SNYK_HIGH + SNYK_MEDIUM + SNYK_LOW))
fi

TRIVY_TOTAL=$((TRIVY_CRITICAL + TRIVY_HIGH + TRIVY_MEDIUM + TRIVY_LOW))
GRAND_TOTAL=$((TRIVY_TOTAL + SNYK_TOTAL))

# ---- Overall risk banner ----
if [ "$TRIVY_CRITICAL" -gt 0 ] || [ "$SNYK_HIGH" -gt 0 ]; then
  RISK_LEVEL="ATTENTION NEEDED"
elif [ "$TRIVY_HIGH" -gt 0 ]; then
  RISK_LEVEL="REVIEW RECOMMENDED"
else
  RISK_LEVEL="LOW RISK"
fi

cat > "$REPORT_MD" << EOF
<div style="text-align:center; margin-bottom: 30px;">
<h1 style="color:#1F3864; margin-bottom:4px;">OneFlower</h1>
<p style="color:#2E5C99; font-size:18px; font-weight:bold; margin-top:0;">Production Deployment Report</p>
<p style="color:#666;">Pending Manual Approval</p>
</div>

| | |
|---|---|
| **Commit** | \`${COMMIT_SHORT}\` (${COMMIT_SHA}) |
| **Branch** | main |
| **Generated** | ${DATE_NOW} |
| **Overall Status** | **${RISK_LEVEL}** |

---

## Summary

| Scanner | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Trivy (filesystem/dependencies) | ${TRIVY_CRITICAL} | ${TRIVY_HIGH} | ${TRIVY_MEDIUM} | ${TRIVY_LOW} | ${TRIVY_TOTAL} |
| Snyk (dependencies) | - | ${SNYK_HIGH} | ${SNYK_MEDIUM} | ${SNYK_LOW} | ${SNYK_TOTAL} |
| **Combined** | **${TRIVY_CRITICAL}** | **$((TRIVY_HIGH + SNYK_HIGH))** | **$((TRIVY_MEDIUM + SNYK_MEDIUM))** | **$((TRIVY_LOW + SNYK_LOW))** | **${GRAND_TOTAL}** |

*Code quality results are tracked separately in SonarCloud (link below) and are not included in these counts.*

---

## 1. Code Quality - SonarCloud

Static analysis of source code for bugs, code smells, and security hotspots.

**Full interactive results:** https://sonarcloud.io/dashboard?id=${SONAR_PROJECT_KEY}

---

## 2. Dependency & Filesystem Vulnerabilities - Trivy

Scans source code and installed dependencies for known vulnerabilities (CVEs).

| Severity | Count |
|---|---|
| Critical | ${TRIVY_CRITICAL} |
| High | ${TRIVY_HIGH} |
| Medium | ${TRIVY_MEDIUM} |
| Low | ${TRIVY_LOW} |

### Details

\`\`\`
$(cat trivy-fs-report.txt 2>/dev/null | head -c 4000 || echo "No findings, or report unavailable.")
\`\`\`

---

## 3. Docker Image Vulnerabilities - Trivy

Scans the final built container image for OS-level and package vulnerabilities.

\`\`\`
$(cat trivy-image-report.txt 2>/dev/null | head -c 4000 || echo "No findings, or report unavailable.")
\`\`\`

---

## 4. Dependency Vulnerabilities - Snyk

Cross-checks dependencies against Snyk's vulnerability database, with available fix guidance.

| Severity | Count |
|---|---|
| High | ${SNYK_HIGH} |
| Medium | ${SNYK_MEDIUM} |
| Low | ${SNYK_LOW} |

### Details

\`\`\`
$(cat snyk-report.json 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    vulns = data.get('vulnerabilities', [])
    if not vulns:
        print('No issues found.')
    for v in vulns[:20]:
        print(f\"[{v.get('severity','?').upper()}] {v.get('title','Unknown')}\")
        print(f\"  Package: {v.get('packageName','?')}@{v.get('version','?')}\")
        print(f\"  Fix: {v.get('isUpgradable') and 'Upgrade available' or 'No fix available'}\")
        print()
except Exception as e:
    print('No findings, or report unavailable.')
" 2>/dev/null || echo "No findings, or report unavailable.")
\`\`\`

---

## Next Step

This deployment is **paused pending manual approval**.

To review and approve or reject, go to:
**https://github.com/apricart/oneflowe-aws/actions**

Find the pending workflow run and click **Review deployments**.

EOF

sudo apt-get update -y -qq
sudo apt-get install -y -qq pandoc wkhtmltopdf

pandoc "$REPORT_MD" -o "pipeline-report-${COMMIT_SHA}.pdf" \
  --pdf-engine=wkhtmltopdf \
  -V margin-top=15 -V margin-bottom=15 -V margin-left=18 -V margin-right=18

echo "Report generated: pipeline-report-${COMMIT_SHA}.pdf"