// 產生 Nous 的 App 圖示（Nous.iconset）與選單列範本圖示（trayTemplate*.png）。
// 用法：swift scripts/make-icons.swift assets
import AppKit
import CoreGraphics

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets"

/// 腦的側面輪廓：幾個腦葉圓形聯集成的「雲朵」形狀（單位座標，約 x∈[-1,1]、y∈[-0.85,0.8]）。
func brainSilhouette() -> CGPath {
    let lobes: [(CGFloat, CGFloat, CGFloat)] = [
        (-0.48, 0.12, 0.44), // 額葉
        (0.0, 0.36, 0.44),   // 頂葉
        (0.46, 0.16, 0.42),  // 枕葉
        (-0.08, -0.16, 0.44), // 顳葉
        (0.5, -0.36, 0.24),  // 小腦
    ]
    var shape = CGPath(ellipseIn: CGRect(x: lobes[0].0 - lobes[0].2, y: lobes[0].1 - lobes[0].2, width: 2 * lobes[0].2, height: 2 * lobes[0].2), transform: nil)
    for (x, y, r) in lobes.dropFirst() {
        shape = shape.union(CGPath(ellipseIn: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r), transform: nil))
    }
    // 腦幹：從顳葉與小腦之間往下延伸，讓輪廓不像雲朵。
    var tilt = CGAffineTransform(translationX: 0.2, y: -0.5).rotated(by: 0.18)
    let stem = CGPath(roundedRect: CGRect(x: -0.1, y: -0.38, width: 0.2, height: 0.42), cornerWidth: 0.09, cornerHeight: 0.09, transform: &tilt)
    return shape.union(stem)
}

/// 兩條腦溝（中央溝、外側溝），只畫在 App 圖示上。
func brainSulci() -> CGPath {
    let path = CGMutablePath()
    path.move(to: CGPoint(x: 0.08, y: 0.74))
    path.addCurve(to: CGPoint(x: -0.12, y: 0.06), control1: CGPoint(x: -0.06, y: 0.52), control2: CGPoint(x: 0.06, y: 0.28))
    path.move(to: CGPoint(x: -0.62, y: -0.08))
    path.addCurve(to: CGPoint(x: 0.36, y: -0.06), control1: CGPoint(x: -0.3, y: 0.06), control2: CGPoint(x: 0.04, y: -0.16))
    return path
}

/// 輪廓內均勻分布、加一點抖動的節點（可重現）。
func brainNodes(spacing: CGFloat, jitter: CGFloat, seed: UInt64, inset: CGFloat) -> [CGPoint] {
    var state = seed
    func next() -> CGFloat {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return CGFloat((state >> 33) % 10_000) / 10_000 - 0.5
    }
    let shape = brainSilhouette()
    let inner = shape.copy(strokingWithWidth: inset * 2, lineCap: .round, lineJoin: .round, miterLimit: 1)
    var points: [CGPoint] = []
    var y: CGFloat = -0.9
    var row = 0
    while y < 0.9 {
        var x: CGFloat = -1 + (row % 2 == 0 ? 0 : spacing / 2)
        while x < 1 {
            let p = CGPoint(x: x + next() * jitter, y: y + next() * jitter)
            if shape.contains(p) && !inner.contains(p) { points.append(p) }
            x += spacing
        }
        y += spacing * 0.87
        row += 1
    }
    return points
}

func edges(_ nodes: [CGPoint], within distance: CGFloat) -> [(CGPoint, CGPoint)] {
    var result: [(CGPoint, CGPoint)] = []
    for i in nodes.indices {
        for j in nodes.indices where j > i && hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) < distance {
            result.append((nodes[i], nodes[j]))
        }
    }
    return result
}

func png(width: Int, height: Int, draw: (CGContext) -> Void) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw(NSGraphicsContext.current!.cgContext)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

func write(_ data: Data, _ path: String) {
    try! data.write(to: URL(fileURLWithPath: path))
}

// ───────────── App 圖示 ─────────────

let appNodes = brainNodes(spacing: 0.2, jitter: 0.07, seed: 7, inset: 0.06)
let appEdges = edges(appNodes, within: 0.27)

func drawAppIcon(_ ctx: CGContext, size: CGFloat) {
    let s = size / 1024
    // macOS 圖示網格：824×824 的圓角方塊，四周留白。
    let body = CGRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
    let path = CGPath(roundedRect: body, cornerWidth: 185 * s, cornerHeight: 185 * s, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10 * s), blur: 28 * s, color: CGColor(gray: 0, alpha: 0.45))
    ctx.addPath(path)
    ctx.setFillColor(CGColor(red: 0.02, green: 0.03, blue: 0.07, alpha: 1))
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    let space = CGColorSpaceCreateDeviceRGB()
    let bg = CGGradient(colorsSpace: space, colors: [
        CGColor(red: 0.07, green: 0.12, blue: 0.27, alpha: 1),
        CGColor(red: 0.01, green: 0.02, blue: 0.05, alpha: 1),
    ] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(bg, start: CGPoint(x: 512 * s, y: 924 * s), end: CGPoint(x: 512 * s, y: 100 * s), options: [])
    let glow = CGGradient(colorsSpace: space, colors: [
        CGColor(red: 0.25, green: 0.75, blue: 1, alpha: 0.42),
        CGColor(red: 0.25, green: 0.75, blue: 1, alpha: 0),
    ] as CFArray, locations: [0, 1])!
    let center = CGPoint(x: 512 * s, y: 548 * s)
    ctx.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center, endRadius: 400 * s, options: [])

    let scale = 330 * s
    func map(_ p: CGPoint) -> CGPoint { CGPoint(x: center.x + p.x * scale, y: center.y + p.y * scale) }
    // 腦的輪廓：淡淡的填色與發光的邊。
    var transform = CGAffineTransform(translationX: center.x, y: center.y).scaledBy(x: scale, y: scale)
    let silhouette = brainSilhouette().copy(using: &transform)!
    ctx.saveGState()
    ctx.addPath(silhouette)
    ctx.setFillColor(CGColor(red: 0.3, green: 0.75, blue: 1, alpha: 0.10))
    ctx.fillPath()
    ctx.setShadow(offset: .zero, blur: 22 * s, color: CGColor(red: 0.45, green: 0.9, blue: 1, alpha: 0.9))
    ctx.addPath(silhouette)
    ctx.setStrokeColor(CGColor(red: 0.55, green: 0.92, blue: 1, alpha: 0.85))
    ctx.setLineWidth(7 * s)
    ctx.strokePath()
    ctx.addPath(brainSulci().copy(using: &transform)!)
    ctx.setStrokeColor(CGColor(red: 0.55, green: 0.92, blue: 1, alpha: 0.5))
    ctx.setLineCap(.round)
    ctx.setLineWidth(6 * s)
    ctx.strokePath()
    ctx.restoreGState()
    ctx.setLineCap(.round)
    for (a, b) in appEdges {
        ctx.setStrokeColor(CGColor(red: 0.45, green: 0.88, blue: 1, alpha: 0.55))
        ctx.setLineWidth(3.6 * s)
        ctx.move(to: map(a))
        ctx.addLine(to: map(b))
        ctx.strokePath()
    }
    for (i, n) in appNodes.enumerated() {
        let p = map(n)
        let r = (i % 5 == 0 ? 13 : 8.5) * s
        ctx.setShadow(offset: .zero, blur: 18 * s, color: CGColor(red: 0.5, green: 0.95, blue: 1, alpha: 0.9))
        ctx.setFillColor(i % 7 == 0 ? CGColor(red: 0.62, green: 1, blue: 0.86, alpha: 1) : CGColor(red: 0.78, green: 0.95, blue: 1, alpha: 1))
        ctx.fillEllipse(in: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r))
    }
    ctx.restoreGState()
}

let iconset = "\(outDir)/Nous.iconset"
try? FileManager.default.createDirectory(atPath: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    for factor in [1, 2] {
        let px = base * factor
        let name = factor == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
        write(png(width: px, height: px) { drawAppIcon($0, size: CGFloat(px)) }, "\(iconset)/\(name)")
    }
}
write(png(width: 1024, height: 1024) { drawAppIcon($0, size: 1024) }, "\(outDir)/icon-1024.png")

// ───────────── 選單列範本圖示（黑色＋透明，系統自動配合深淺色） ─────────────

func drawTray(_ ctx: CGContext, px: CGFloat, active: Bool) {
    let s = px / 18
    let center = CGPoint(x: 8.4 * s, y: 10.2 * s)
    let scale = 7.0 * s
    var transform = CGAffineTransform(translationX: center.x, y: center.y).scaledBy(x: scale, y: scale)
    let outline = brainSilhouette().copy(using: &transform)!
    func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: center.x + x * scale, y: center.y + y * scale) }
    ctx.setStrokeColor(CGColor(gray: 0, alpha: 1))
    ctx.setFillColor(CGColor(gray: 0, alpha: 1))
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.setLineWidth(1.25 * s)
    ctx.addPath(outline)
    ctx.strokePath()
    // 腦內的小網絡：三個節點連成三角形。
    let nodes = [map(-0.42, 0.12), map(0.12, 0.32), map(0.2, -0.22)]
    ctx.setLineWidth(0.9 * s)
    ctx.move(to: nodes[0]); ctx.addLine(to: nodes[1]); ctx.addLine(to: nodes[2]); ctx.closePath()
    ctx.strokePath()
    for p in nodes {
        let r = 1.45 * s
        ctx.fillEllipse(in: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r))
    }
    if active {
        // 語音開啟中：右下角實心圓點（像錄音指示燈），先挖出白邊再畫點。
        let dot = CGRect(x: 12.4 * s, y: 0.4 * s, width: 5.4 * s, height: 5.4 * s)
        ctx.setBlendMode(.clear)
        ctx.fillEllipse(in: dot.insetBy(dx: -1.2 * s, dy: -1.2 * s))
        ctx.setBlendMode(.normal)
        ctx.fillEllipse(in: dot)
    }
}

for (name, active) in [("trayTemplate", false), ("trayActiveTemplate", true)] {
    write(png(width: 18, height: 18) { drawTray($0, px: 18, active: active) }, "\(outDir)/\(name).png")
    write(png(width: 36, height: 36) { drawTray($0, px: 36, active: active) }, "\(outDir)/\(name)@2x.png")
}
print("圖示已產生：\(outDir)")
