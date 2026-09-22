param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$outDir = $null
$convertTo = $null
for ($i = 0; $i -lt $RemainingArgs.Count; $i++) {
    if ($RemainingArgs[$i] -eq '--outdir' -and $i + 1 -lt $RemainingArgs.Count) {
        $outDir = $RemainingArgs[$i + 1]
    }
    if ($RemainingArgs[$i] -eq '--convert-to' -and $i + 1 -lt $RemainingArgs.Count) {
        $convertTo = $RemainingArgs[$i + 1]
    }
}

$inputPath = $RemainingArgs[-1]
if (-not $outDir -or -not $inputPath) {
    Write-Error 'Missing --outdir or input path.'
    exit 2
}

if ($convertTo -notmatch '^pdf') {
    Write-Error "Unsupported conversion target: $convertTo"
    exit 3
}

New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$outputPath = Join-Path $outDir (([System.IO.Path]::GetFileNameWithoutExtension($inputPath)) + '.pdf')

$word = $null
$document = $null
$ownsWord = $false
$oldDisplayAlerts = $null
try {
    try {
        $word = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
    }
    catch {
        $word = New-Object -ComObject Word.Application
        $ownsWord = $true
    }
    if ($ownsWord) { $word.Visible = $false }
    else { $oldDisplayAlerts = $word.DisplayAlerts }
    $word.DisplayAlerts = 0
    $document = $word.Documents.Open($inputPath, $false, $true, $false, '', '', $false, '', '', 0, $false, $false)
    $document.ExportAsFixedFormat($outputPath, 17)
    $document.Close($false)
    $document = $null
    if ($ownsWord) { $word.Quit() }
    $word = $null
    Write-Output "Converted $inputPath to $outputPath"
    exit 0
}
catch {
    Write-Error $_
    exit 1
}
finally {
    if ($document) {
        try { $document.Close($false) } catch {}
    }
    if ($word -and -not $ownsWord -and $null -ne $oldDisplayAlerts) {
        try { $word.DisplayAlerts = $oldDisplayAlerts } catch {}
    }
    if ($word -and $ownsWord) {
        try { $word.Quit() } catch {}
    }
}
