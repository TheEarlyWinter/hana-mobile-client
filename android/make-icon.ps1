# 生成 App 图标：192x192 PNG，纸色底 + 蓝色圆形 + 白 H
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "res\drawable"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$size = 192
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# 背景（透明外圈 + 圆角方块感）
$g.Clear([System.Drawing.Color]::Transparent)

$paper = [System.Drawing.ColorTranslator]::FromHtml("#F7F1E7")
$blue  = [System.Drawing.ColorTranslator]::FromHtml("#2F6FB3")

# 圆角底板
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 42
$pad = 6
$w = $size - ($pad * 2)
$rect = New-Object System.Drawing.Rectangle($pad, $pad, $w, $w)
$path.AddArc($rect.X, $rect.Y, $r, $r, 180, 90)
$path.AddArc($rect.Right - $r, $rect.Y, $r, $r, 270, 90)
$path.AddArc($rect.Right - $r, $rect.Bottom - $r, $r, $r, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath((New-Object System.Drawing.SolidBrush($blue)), $path)

# 白色 H
$font = New-Object System.Drawing.Font("Segoe UI", 96, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("H", $font, (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)),
    (New-Object System.Drawing.RectangleF(0, -4, $size, $size)), $fmt)

$g.Dispose()
$target = Join-Path $outDir "ic_launcher.png"
$bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "icon written: $target"
