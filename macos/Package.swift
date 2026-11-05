// swift-tools-version:5.9
import PackageDescription

// hop for Mac: a native window around hop's web app (see README.md).
let package = Package(
    name: "Hop",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Hop", path: "Sources/Hop")
    ]
)
