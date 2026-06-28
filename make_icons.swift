import AppKit

func makeIcon(size: Int, outputPath: String) {
    let imgSize = CGFloat(size)
    let image = NSImage(size: NSSize(width: imgSize, height: imgSize))
    image.lockFocus()

    // Rounded corners clip
    let radius = imgSize * 0.2
    let roundedPath = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: imgSize, height: imgSize), xRadius: radius, yRadius: radius)
    roundedPath.addClip()

    // Background: #d4f53c
    NSColor(red: 0.831, green: 0.961, blue: 0.235, alpha: 1.0).setFill()
    roundedPath.fill()

    // Emoji
    let emoji = "💪"
    let fontSize = imgSize * 0.55
    let font = NSFont.systemFont(ofSize: fontSize)
    let attr: [NSAttributedString.Key: Any] = [.font: font]
    let str = NSAttributedString(string: emoji, attributes: attr)
    let strSize = str.size()
    let x = (imgSize - strSize.width) / 2
    let y = (imgSize - strSize.height) / 2 + imgSize * 0.02
    str.draw(at: NSPoint(x: x, y: y))

    image.unlockFocus()

    if let tiff = image.tiffRepresentation,
       let bitmap = NSBitmapImageRep(data: tiff),
       let png = bitmap.representation(using: .png, properties: [:]) {
        try? png.write(to: URL(fileURLWithPath: outputPath))
        print("Created: \(outputPath)")
    }
}

makeIcon(size: 192, outputPath: "icon-192.png")
makeIcon(size: 512, outputPath: "icon-512.png")
