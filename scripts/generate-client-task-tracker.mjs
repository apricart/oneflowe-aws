import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import XLSX from "xlsx"

const reportingPeriod = "13 July 2026 to 21 July 2026"
const outputPath = resolve(
  process.cwd(),
  "deliverables",
  "OneFlowe_Client_Task_Tracker_2026-07-13_to_2026-07-21.xlsx",
)

const taskGroups = [
  {
    category: "Data Migration & Product Management",
    date: "2026-07-13",
    tasks: [
      "Migrated 594 eligible K-Electric historical orders and their related order items.",
      "Added validation so only complete and accurate legacy orders are migrated.",
      "Added exclusion reporting for legacy orders that could not be migrated.",
      "Added migration backups, rollback support, and duplicate-import prevention.",
      "Protected stock, budgets, invoice numbering, and notifications from unwanted migration side effects.",
    ],
  },
  {
    category: "Refund Improvements",
    date: "2026-07-13",
    tasks: [
      "Enabled refund requests for users whose product prices are hidden.",
      "Added quantity-based refund selection without exposing monetary values.",
      "Added requested, refunded, and remaining quantity tracking.",
      "Added price-safe refund history for restricted users.",
      "Fixed the Super Admin refund review workflow.",
      "Allowed Super Admins to approve the exact pending refund request being reviewed.",
      "Preserved the original refund reason during approval.",
      "Automatically closed other pending requests after a refund was approved.",
      "Prevented duplicate, overlapping, and excessive refunds.",
      "Added safeguards for older refunds with incomplete item details.",
      "Added clearer refund status and review information.",
      "Fixed organization filtering in the product performance report.",
    ],
  },
  {
    category: "Data Migration & Product Management",
    date: "2026-07-14",
    tasks: [
      "Standardized 144 imported K-Electric product codes.",
      "Updated historical order items to use the standardized product codes.",
      "Prevented duplicate product codes regardless of capitalization or spacing.",
      "Corrected automatic generation of the next product code.",
      "Removed an incorrect cross-organization product assignment.",
      "Added validation and rollback support for product-code updates.",
    ],
  },
  {
    category: "Order & Budget Management",
    date: "2026-07-16",
    tasks: [
      "Strengthened product availability checks during checkout.",
      "Ensured orders use the correct organization price.",
      "Added quantity, stock, and budget validation before order placement.",
      "Prevented duplicate orders caused by retries or repeated clicks.",
      "Protected order processing from simultaneous conflicting actions.",
      "Improved order approval and rejection workflows.",
      "Improved order fulfilment and payment workflows.",
      "Enforced the correct sequence for delivery status updates.",
      "Improved automatic order fulfilment after delivery.",
      "Ensured stock and budgets are restored correctly when orders are rejected or deleted.",
      "Protected budget and product-allocation usage from becoming inconsistent.",
      "Prevented active budget commitments from being accidentally reset.",
      "Improved invoice-number generation to prevent duplicates.",
      "Restricted order deletion to safe and eligible orders.",
      "Strengthened organization settings and prevented duplicate settings.",
      "Added safeguards against invalid prices, quantities, refunds, stock, and budget values.",
    ],
  },
  {
    category: "User & Access Management",
    date: "2026-07-16",
    tasks: [
      "Added safer role, organization, branch, group, and account access management.",
      "Prevented users from changing their own access level.",
      "Protected Super Admin accounts from unauthorized management.",
      "Prevented users from assigning roles above their own authority.",
      "Automatically ended active sessions after important access changes.",
      "Added secure bulk user importing with validation and duplicate checking.",
      "Added branch and role mapping during user imports.",
      "Added temporary-password generation and mandatory password changes.",
      "Added secure credential handoff for imported users.",
      "Added a controlled Super Admin account-creation process.",
      "Added a direct login button and login URL to new-user welcome emails.",
    ],
  },
  {
    category: "Security & Reliability",
    date: "2026-07-16",
    tasks: [
      "Added stronger protection against unauthorized field and status changes.",
      "Strengthened organization and branch data separation.",
      "Secured login redirects and removed unsafe page-rendering behavior.",
      "Added stronger browser and page security protections.",
      "Added same-site protection for account and business actions.",
      "Improved session-cookie security.",
      "Added stronger protection for login and one-time password actions.",
      "Added stronger protection for uploads, imports, and administrative actions.",
      "Added request-size and result-size limits to prevent system overload.",
      "Secured image uploads with file-type, size, dimension, and content validation.",
      "Secured spreadsheet and data imports with strict validation and all-or-nothing processing.",
      "Protected spreadsheet exports from unsafe formulas.",
      "Secured database export and backup operations.",
      "Improved error messages while preventing sensitive system information from being exposed.",
      "Added safer handling of passwords, emails, environment settings, and service credentials.",
      "Updated core application packages to safer supported versions.",
      "Prepared staged database permission hardening and rollback procedures.",
    ],
  },
  {
    category: "User & Access Management",
    date: "2026-07-18",
    tasks: [
      "Completed consolidated credential preparation for 23 UBL accounts.",
      "Reconciled existing UBL user records with the approved onboarding information.",
    ],
  },
  {
    category: "Deployment & System Fixes",
    date: "2026-07-18",
    tasks: [
      "Repaired missing support for branch baseline budgets.",
      "Repaired budget add-on functionality.",
      "Repaired scheduled-report storage and processing support.",
      "Fixed database setup and initial configuration reliability.",
      "Fixed database failures being shown as incorrect permission errors.",
    ],
  },
  {
    category: "Deployment & System Fixes",
    date: "2026-07-20",
    tasks: [
      "Added reliable AWS Amplify deployment configuration.",
      "Added secure server settings for the hosted application.",
      "Added automatic validation for missing deployment settings.",
    ],
  },
  {
    category: "Order Notifications",
    date: "2026-07-21",
    tasks: [
      "Added in-app and email notifications when an order is created.",
      "Added notifications to the order creator when an order is approved.",
      "Added notifications to the order creator when an order is rejected.",
      "Added Super Admin notifications when a Branch Admin approves an order.",
      "Added automatic retrying for failed notification emails.",
      "Prevented duplicate order notifications.",
      "Ensured email failures do not interrupt order processing.",
      "Restricted notifications to the correct organization, branch, role, and recipient.",
      "Removed sensitive prices and approval information from notification emails.",
      "Improved notification refresh and unread-status handling.",
    ],
  },
  {
    category: "Deployment & System Fixes",
    date: "2026-07-21",
    status: "Ready for commit",
    tasks: [
      "Ensured previously skipped business-protection updates can be applied correctly.",
    ],
  },
  {
    category: "User Interface",
    date: "2026-07-21",
    status: "Ready for commit",
    tasks: [
      "Improved the order-shop layout so the cart no longer overlaps pagination controls.",
    ],
  },
]

function localDate(value) {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year, month - 1, day)
}

const tasks = taskGroups.flatMap((group) =>
  group.tasks.map((task) => ({
    date: localDate(group.date),
    category: group.category,
    task,
    status: group.status ?? "Completed",
  })),
)

const workbook = XLSX.utils.book_new()
workbook.Props = {
  Title: "OneFlowe Client Task Tracker",
  Subject: `Work completed from ${reportingPeriod}`,
  Author: "OneFlowe Development Team",
  Company: "OneFlowe",
  Comments: "Client-facing functionality tracker",
  CreatedDate: new Date(),
}

const trackerRows = [
  ["OneFlowe Client Task Tracker"],
  [`Reporting period: ${reportingPeriod}`],
  [],
  ["Task ID", "Date", "Category", "Task / Functionality", "Status", "Client Review", "Client Comments"],
  ...tasks.map((item, index) => [
    `OF-${String(index + 1).padStart(3, "0")}`,
    item.date,
    item.category,
    item.task,
    item.status,
    "",
    "",
  ]),
]

const trackerSheet = XLSX.utils.aoa_to_sheet(trackerRows, { cellDates: true })
trackerSheet["!merges"] = [
  { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
  { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } },
]
trackerSheet["!cols"] = [
  { wch: 12 },
  { wch: 14 },
  { wch: 38 },
  { wch: 92 },
  { wch: 20 },
  { wch: 20 },
  { wch: 45 },
]
trackerSheet["!rows"] = [
  { hpt: 30 },
  { hpt: 22 },
  { hpt: 8 },
  { hpt: 25 },
  ...tasks.map(() => ({ hpt: 36 })),
]
trackerSheet["!autofilter"] = { ref: `A4:G${tasks.length + 4}` }
trackerSheet["!freeze"] = { xSplit: 0, ySplit: 4, topLeftCell: "A5", activePane: "bottomLeft" }
trackerSheet["!sheetViews"] = [{ showGridLines: false }]

for (let row = 5; row <= tasks.length + 4; row += 1) {
  if (trackerSheet[`B${row}`]) trackerSheet[`B${row}`].z = "dd-mmm-yyyy"
}

const titleStyle = {
  font: { bold: true, color: { rgb: "FFFFFF" }, sz: 18 },
  fill: { patternType: "solid", fgColor: { rgb: "17365D" } },
  alignment: { horizontal: "center", vertical: "center" },
}
const subtitleStyle = {
  font: { bold: true, color: { rgb: "17365D" }, sz: 11 },
  fill: { patternType: "solid", fgColor: { rgb: "DCE6F1" } },
  alignment: { horizontal: "center", vertical: "center" },
}
const headerStyle = {
  font: { bold: true, color: { rgb: "FFFFFF" } },
  fill: { patternType: "solid", fgColor: { rgb: "1F4E78" } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: {
    top: { style: "thin", color: { rgb: "B4C6E7" } },
    bottom: { style: "thin", color: { rgb: "B4C6E7" } },
    left: { style: "thin", color: { rgb: "B4C6E7" } },
    right: { style: "thin", color: { rgb: "B4C6E7" } },
  },
}
const bodyStyle = {
  alignment: { vertical: "top", wrapText: true },
  border: {
    bottom: { style: "thin", color: { rgb: "D9E2F3" } },
    left: { style: "thin", color: { rgb: "D9E2F3" } },
    right: { style: "thin", color: { rgb: "D9E2F3" } },
  },
}

trackerSheet.A1.s = titleStyle
trackerSheet.A2.s = subtitleStyle
for (let column = 0; column < 7; column += 1) {
  const header = trackerSheet[XLSX.utils.encode_cell({ r: 3, c: column })]
  if (header) header.s = headerStyle
}
for (let row = 4; row < tasks.length + 4; row += 1) {
  for (let column = 0; column < 7; column += 1) {
    const cell = trackerSheet[XLSX.utils.encode_cell({ r: row, c: column })]
    if (!cell) continue
    cell.s = {
      ...bodyStyle,
      fill: {
        patternType: "solid",
        fgColor: { rgb: row % 2 === 0 ? "FFFFFF" : "F7FAFC" },
      },
      alignment: {
        ...bodyStyle.alignment,
        horizontal: column === 0 || column === 1 || column === 4 ? "center" : "left",
      },
    }
  }
}

XLSX.utils.book_append_sheet(workbook, trackerSheet, "Task Tracker")

const categories = [...new Set(tasks.map((item) => item.category))]
const summaryRows = [
  ["OneFlowe Task Tracker Summary"],
  [`Reporting period: ${reportingPeriod}`],
  [],
  ["Overall Status", "Task Count"],
  ["Completed", tasks.filter((item) => item.status === "Completed").length],
  ["Ready for commit", tasks.filter((item) => item.status === "Ready for commit").length],
  ["Total", tasks.length],
  [],
  ["Category", "Completed", "Ready for commit", "Total"],
  ...categories.map((category) => {
    const categoryTasks = tasks.filter((item) => item.category === category)
    return [
      category,
      categoryTasks.filter((item) => item.status === "Completed").length,
      categoryTasks.filter((item) => item.status === "Ready for commit").length,
      categoryTasks.length,
    ]
  }),
]

const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows)
summarySheet["!merges"] = [
  { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
  { s: { r: 1, c: 0 }, e: { r: 1, c: 3 } },
]
summarySheet["!cols"] = [{ wch: 42 }, { wch: 18 }, { wch: 20 }, { wch: 14 }]
summarySheet["!rows"] = [{ hpt: 30 }, { hpt: 22 }, { hpt: 8 }, { hpt: 24 }]
summarySheet["!sheetViews"] = [{ showGridLines: false }]
summarySheet.A1.s = titleStyle
summarySheet.A2.s = subtitleStyle
for (const rowIndex of [3, 8]) {
  const columnCount = rowIndex === 3 ? 2 : 4
  for (let column = 0; column < columnCount; column += 1) {
    const cell = summarySheet[XLSX.utils.encode_cell({ r: rowIndex, c: column })]
    if (cell) cell.s = headerStyle
  }
}
for (let row = 4; row < summaryRows.length; row += 1) {
  for (let column = 0; column < 4; column += 1) {
    const cell = summarySheet[XLSX.utils.encode_cell({ r: row, c: column })]
    if (cell) cell.s = bodyStyle
  }
}

XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary")
workbook.SheetNames = ["Summary", "Task Tracker"]

mkdirSync(dirname(outputPath), { recursive: true })
XLSX.writeFile(workbook, outputPath, {
  bookType: "xlsx",
  compression: true,
  cellStyles: true,
})

const workbookArchive = unzipSync(readFileSync(outputPath))

workbookArchive["xl/styles.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="60" formatCode="dd-mmm-yyyy"/></numFmts>
  <fonts count="7">
    <font><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <font><b/><sz val="18"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FF17365D"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FF548235"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FFC65911"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FF17365D"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="10">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF17365D"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF7FAFC"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFCE4D6"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD9E2F3"/></left><right style="thin"><color rgb="FFD9E2F3"/></right><top style="thin"><color rgb="FFD9E2F3"/></top><bottom style="thin"><color rgb="FFD9E2F3"/></bottom><diagonal/></border>
    <border><left style="thin"><color rgb="FFB4C6E7"/></left><right style="thin"><color rgb="FFB4C6E7"/></right><top style="thin"><color rgb="FFB4C6E7"/></top><bottom style="thin"><color rgb="FFB4C6E7"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="16">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="60" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="60" fontId="0" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="60" fontId="0" fillId="6" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="5" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="6" fillId="9" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="6" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="6" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleMedium4"/>
</styleSheet>`)

function styleCellTag(match, column, rowText, attributes, styleIndex) {
  const cleanedAttributes = attributes.replace(/\s+s="[^"]*"/, "")
  return `<c r="${column}${rowText}"${cleanedAttributes} s="${styleIndex}">`
}

function patchTrackerSheet(xml) {
  const styled = xml.replace(/<c r="([A-G])(\d+)"([^>]*)>/g, (match, column, rowText, attributes) => {
    const row = Number(rowText)
    let styleIndex = 0

    if (row === 1 && column === "A") styleIndex = 2
    else if (row === 2 && column === "A") styleIndex = 3
    else if (row === 4) styleIndex = 4
    else if (row >= 5) {
      const alternate = row % 2 !== 0
      if (column === "A") styleIndex = alternate ? 8 : 7
      else if (column === "B") styleIndex = alternate ? 10 : 9
      else if (column === "C") styleIndex = alternate ? 15 : 14
      else if (column === "E") styleIndex = row >= 92 ? 12 : 11
      else styleIndex = alternate ? 6 : 5
    }

    return styleCellTag(match, column, rowText, attributes, styleIndex)
  })

  const frozen = styled.replace(
    /<sheetViews><sheetView workbookViewId="0"\/><\/sheetViews>/,
    '<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A5" sqref="A5"/></sheetView></sheetViews>',
  )

  return frozen.replace(
    /(<mergeCells[\s\S]*?<\/mergeCells>)/,
    '$1<dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" promptTitle="Client Review" prompt="Select the client review status." errorTitle="Invalid Review Status" error="Select a value from the list." sqref="F5:F93"><formula1>&quot;Pending Review,Approved,Changes Requested&quot;</formula1></dataValidation></dataValidations>',
  )
}

function patchSummarySheet(xml) {
  const styled = xml.replace(/<c r="([A-D])(\d+)"([^>]*)>/g, (match, column, rowText, attributes) => {
    const row = Number(rowText)
    let styleIndex = 0

    if (row === 1 && column === "A") styleIndex = 2
    else if (row === 2 && column === "A") styleIndex = 3
    else if (row === 4 || row === 9) styleIndex = 4
    else if (row === 7) styleIndex = 13
    else if (row >= 5) {
      const alternate = row % 2 !== 0
      if (column === "A") styleIndex = alternate ? 15 : 14
      else styleIndex = alternate ? 8 : 7
    }

    return styleCellTag(match, column, rowText, attributes, styleIndex)
  })

  return styled.replace(
    /<sheetViews><sheetView workbookViewId="0"\/><\/sheetViews>/,
    '<sheetViews><sheetView showGridLines="0" workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>',
  )
}

workbookArchive["xl/worksheets/sheet1.xml"] = strToU8(
  patchSummarySheet(strFromU8(workbookArchive["xl/worksheets/sheet1.xml"])),
)
workbookArchive["xl/worksheets/sheet2.xml"] = strToU8(
  patchTrackerSheet(strFromU8(workbookArchive["xl/worksheets/sheet2.xml"])),
)
writeFileSync(outputPath, zipSync(workbookArchive, { level: 6 }))

console.log(JSON.stringify({ outputPath, taskCount: tasks.length, categories: categories.length }, null, 2))
