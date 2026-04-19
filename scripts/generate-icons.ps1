<#
.SYNOPSIS
    Generate PCDoctor tray + app icons via System.Drawing (multi-resolution ICO).
.DESCRIPTION
    Produces 5 ICO files at resources/icons/ with monitor-body + medical-cross design.
    Each ICO contains 256, 128, 64, 48, 32, 16 px variants so Windows picks the sharpest
    for the target context (tray=16, taskbar=32, installer=256).
#>
param(
    [string]$OutDir = "resources/icons"
)

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# ============================================================
# Draw a single PNG-backed Bitmap of a "PC Doctor" icon at size
# ============================================================
function New-IconBitmap {
    param(
        [string]$BodyHex,        # Main status color (background square)
        [int]$Size               # pixel dimension
    )
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $bodyColor = [System.Drawing.ColorTranslator]::FromHtml($BodyHex)
    $bodyBrush = New-Object System.Drawing.SolidBrush $bodyColor

    # Darker edge color (for a thin outline)
    $edge = [System.Drawing.Color]::FromArgb([math]::Max($bodyColor.R - 60, 0), [math]::Max($bodyColor.G - 60, 0), [math]::Max($bodyColor.B - 60, 0))
    $edgePen = New-Object System.Drawing.Pen $edge, ([math]::Max(1, $Size / 64))

    # Rounded-rect body (monitor shape)
    $pad = [int]($Size * 0.08)
    $bodyW = $Size - (2 * $pad)
    $bodyH = $Size - (2 * $pad)
    $r = [int]($Size * 0.15)    # corner radius

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($pad, $pad, $r * 2, $r * 2, 180, 90)
    $path.AddArc($pad + $bodyW - $r * 2, $pad, $r * 2, $r * 2, 270, 90)
    $path.AddArc($pad + $bodyW - $r * 2, $pad + $bodyH - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc($pad, $pad + $bodyH - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()

    $g.FillPath($bodyBrush, $path)
    $g.DrawPath($edgePen, $path)

    # Medical cross in white (centered)
    $cross = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $crossThick = [int]($Size * 0.22)
    $crossLen   = [int]($Size * 0.58)
    $cx = [int]($Size / 2)
    $cy = [int]($Size / 2)

    # Vertical bar (rounded-rect)
    $vPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $vr = [int]($crossThick / 4)
    $vx = $cx - [int]($crossThick / 2)
    $vy = $cy - [int]($crossLen / 2)
    $vPath.AddArc($vx, $vy, $vr * 2, $vr * 2, 180, 90)
    $vPath.AddArc($vx + $crossThick - $vr * 2, $vy, $vr * 2, $vr * 2, 270, 90)
    $vPath.AddArc($vx + $crossThick - $vr * 2, $vy + $crossLen - $vr * 2, $vr * 2, $vr * 2, 0, 90)
    $vPath.AddArc($vx, $vy + $crossLen - $vr * 2, $vr * 2, $vr * 2, 90, 90)
    $vPath.CloseFigure()
    $g.FillPath($cross, $vPath)

    # Horizontal bar (rounded-rect)
    $hPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $hx = $cx - [int]($crossLen / 2)
    $hy = $cy - [int]($crossThick / 2)
    $hPath.AddArc($hx, $hy, $vr * 2, $vr * 2, 180, 90)
    $hPath.AddArc($hx + $crossLen - $vr * 2, $hy, $vr * 2, $vr * 2, 270, 90)
    $hPath.AddArc($hx + $crossLen - $vr * 2, $hy + $crossThick - $vr * 2, $vr * 2, $vr * 2, 0, 90)
    $hPath.AddArc($hx, $hy + $crossThick - $vr * 2, $vr * 2, $vr * 2, 90, 90)
    $hPath.CloseFigure()
    $g.FillPath($cross, $hPath)

    $g.Dispose()
    $bodyBrush.Dispose()
    $edgePen.Dispose()
    $cross.Dispose()
    return $bmp
}

# ============================================================
# Write a multi-resolution ICO file by packing PNGs per size.
# Windows ICO format: ICONDIR header + ICONDIRENTRY[] + image data.
# For sizes >= 64 we store PNG-compressed (ICO supports this since Vista).
# For smaller sizes we also store PNG; Windows handles both.
# ============================================================
function Save-MultiSizeIco {
    param(
        [string]$BodyHex,
        [string]$OutPath,
        [int[]]$Sizes = @(256, 128, 64, 48, 32, 16)
    )

    $pngs = @()
    foreach ($sz in $Sizes) {
        $bmp = New-IconBitmap -BodyHex $BodyHex -Size $sz
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $pngs += ,@{ size = $sz; bytes = $ms.ToArray() }
        $bmp.Dispose()
        $ms.Dispose()
    }

    # Build ICO
    $fs = [System.IO.File]::Create($OutPath)
    $bw = New-Object System.IO.BinaryWriter $fs

    # ICONDIR: reserved(2) type(2) count(2)
    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$pngs.Count)

    # Compute data offsets: header (6) + entries (16 * count) + cumulative PNG sizes
    $dirSize = 6 + (16 * $pngs.Count)
    $offset = $dirSize

    foreach ($p in $pngs) {
        # ICONDIRENTRY: width(1) height(1) colors(1) reserved(1) planes(2) bpp(2) size(4) offset(4)
        $w = if ($p.size -ge 256) { 0 } else { $p.size }
        $h = if ($p.size -ge 256) { 0 } else { $p.size }
        $bw.Write([byte]$w)
        $bw.Write([byte]$h)
        $bw.Write([byte]0)       # palette count
        $bw.Write([byte]0)       # reserved
        $bw.Write([uint16]1)     # color planes
        $bw.Write([uint16]32)    # bpp
        $bw.Write([uint32]$p.bytes.Length)
        $bw.Write([uint32]$offset)
        $offset += $p.bytes.Length
    }

    foreach ($p in $pngs) {
        $bw.Write($p.bytes)
    }

    $bw.Flush()
    $bw.Close()
    $fs.Close()
    Write-Host "Wrote $OutPath ($(((Get-Item $OutPath).Length / 1KB).ToString('N1')) KB)"
}

# ============================================================
# Generate the 5 icons
# ============================================================
$icons = @(
    @{ name = 'icon.ico';        color = '#238636' }  # main app + installer (git-green)
    @{ name = 'tray-green.ico';  color = '#22c55e' }  # status = good
    @{ name = 'tray-yellow.ico'; color = '#f59e0b' }  # status = warn
    @{ name = 'tray-red.ico';    color = '#ef4444' }  # status = crit
    @{ name = 'tray-blue.ico';   color = '#3b82f6' }  # status = info
)

foreach ($i in $icons) {
    $out = Join-Path $OutDir $i.name
    Save-MultiSizeIco -BodyHex $i.color -OutPath $out
}

Write-Host ""
Write-Host "Generated $($icons.Count) icons in $OutDir/"
Get-ChildItem $OutDir -Filter '*.ico' | Select-Object Name, @{N='KB';E={[math]::Round($_.Length/1KB, 1)}}, LastWriteTime | Format-Table -AutoSize
