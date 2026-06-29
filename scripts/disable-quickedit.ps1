Add-Type -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr GetStdHandle(int nStdHandle);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
'@ -Name "ConsoleUtil" -Namespace "Win32"

$handle = [Win32.ConsoleUtil]::GetStdHandle(-10)
$mode = 0
$oldMode = $mode
if ([Win32.ConsoleUtil]::GetConsoleMode($handle, [ref]$mode)) {
    $oldMode = $mode
    $hadQuickEdit = ($mode -band 0x0040) -ne 0
    $mode = $mode -band -bnot 0x0040
    $mode = $mode -band -bnot 0x0008
    [Win32.ConsoleUtil]::SetConsoleMode($handle, $mode)
    if ($hadQuickEdit) {
        Write-Host "QuickEdit disabled (was enabled, mode changed: $oldMode → $mode)"
    } else {
        Write-Host "QuickEdit already disabled (mode: $mode)"
    }
} else {
    Write-Host "Failed to get console mode (error: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}
