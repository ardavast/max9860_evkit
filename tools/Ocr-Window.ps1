<#
    Ocr-Window.ps1 - capture a Win32 window (or read an image) and OCR it with
    the built-in Windows.Media.Ocr engine. Nothing to install: the OCR engine
    ships with Windows 10/11.

    Recovers text from NON-WINDOWED controls (VCL TLabel, owner-drawn, MFC
    static paints) that EnumChildWindows / UI Automation cannot see.

    Usage:
      .\Ocr-Window.ps1 -Hwnd 132380 -Scale 4
      .\Ocr-Window.ps1 -ImagePath shot.png -Scale 4 -Filter '^K\d+'
#>
[CmdletBinding()]
param(
    [int]    $Hwnd,
    [string] $ImagePath,
    [double] $Scale = 4,          # upscale factor; small UI text needs >=3
    [string] $Filter,             # optional regex on word text
    [switch] $Raw                 # emit objects instead of a table
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

if (-not ('Win32Cap' -as [type])) {
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Win32Cap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
}

# --- WinRT async bridge (Windows PowerShell 5.1) --------------------------
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]        | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]           | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($task, $resultType) {
    $m  = $asTaskGeneric.MakeGenericMethod($resultType)
    $nt = $m.Invoke($null, @($task))
    $nt.Wait(-1) | Out-Null
    $nt.Result
}

# --- 1. obtain a bitmap ---------------------------------------------------
if ($Hwnd) {
    $r = New-Object Win32Cap+RECT
    [void][Win32Cap]::GetWindowRect([IntPtr]$Hwnd, [ref]$r)
    $w = $r.R - $r.L; $h = $r.B - $r.T
    if ($w -le 0 -or $h -le 0) { throw "window $Hwnd has no client area" }
    $shot = New-Object System.Drawing.Bitmap $w, $h
    $g    = [System.Drawing.Graphics]::FromImage($shot)
    $hdc  = $g.GetHdc()
    [void][Win32Cap]::PrintWindow([IntPtr]$Hwnd, $hdc, 2)   # 2 = PW_RENDERFULLCONTENT
    $g.ReleaseHdc($hdc); $g.Dispose()
}
elseif ($ImagePath) {
    $shot = [System.Drawing.Bitmap]::FromFile((Resolve-Path $ImagePath))
}
else { throw 'supply -Hwnd or -ImagePath' }

# --- 2. upscale: Windows OCR needs roughly >=12px glyph height ------------
$sw = [int]($shot.Width * $Scale); $sh = [int]($shot.Height * $Scale)
$big = New-Object System.Drawing.Bitmap $sw, $sh
$gg  = [System.Drawing.Graphics]::FromImage($big)
$gg.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gg.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$gg.DrawImage($shot, 0, 0, $sw, $sh)
$gg.Dispose(); $shot.Dispose()

$tmp = Join-Path $env:TEMP ("ocr_" + [guid]::NewGuid().ToString('N') + ".png")
$big.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png); $big.Dispose()

# --- 3. OCR ---------------------------------------------------------------
try {
    $file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
    $stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp     = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) { throw 'no OCR language pack available' }
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])

    $out = foreach ($line in $res.Lines) {
        foreach ($word in $line.Words) {
            if ($Filter -and $word.Text -notmatch $Filter) { continue }
            [pscustomobject]@{
                Text = $word.Text
                # divide back out so coordinates match the ORIGINAL window
                X    = [int]($word.BoundingRect.X / $Scale)
                Y    = [int]($word.BoundingRect.Y / $Scale)
                W    = [int]($word.BoundingRect.Width  / $Scale)
                H    = [int]($word.BoundingRect.Height / $Scale)
            }
        }
    }
    if ($Raw) { $out } else { $out | Sort-Object Y, X | Format-Table -AutoSize }
}
finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
