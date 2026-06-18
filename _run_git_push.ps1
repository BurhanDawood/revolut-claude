# revolut-claude git push script
Set-Location "C:\Users\owner\revolut-claude"

$output = @()
$timestamp = Get-Date -Format "yyyy-MM-dd-HH-mm"
$readbackPath = "C:\Users\owner\Google Drive\revolut-claude-readbacks\readback-$timestamp.txt"

# Step 1: Delete lock file
if (Test-Path ".git\HEAD.lock") {
    Remove-Item ".git\HEAD.lock" -Force
    $output += "1. Lock file .git\HEAD.lock deleted successfully."
} else {
    $output += "1. Lock file .git\HEAD.lock not found (already clean)."
}

# Step 2: Git status
$output += ""
$output += "2. GIT STATUS:"
$gitStatus = git status 2>&1
$output += $gitStatus

# Step 3: Git push
$output += ""
$output += "3. GIT PUSH:"
$gitPush = git push origin main 2>&1
$output += $gitPush

# Step 4: Git log
$output += ""
$output += "4. GIT LOG (last 2 commits):"
$gitLog = git log --oneline -2 2>&1
$output += $gitLog

# Write readback file
$output | Out-File -FilePath $readbackPath -Encoding UTF8
Write-Host "Done. Readback written to: $readbackPath"
Write-Host ""
$output | ForEach-Object { Write-Host $_ }
Read-Host "Press Enter to close"
