// deskscan — streams the on-screen window layout as JSON lines on stdout.
//
// Runs as a long-lived child process rather than being spawned per poll, so the
// cost of desktop awareness stays near zero. Emits one JSON object per tick and
// only when the layout actually changed, so the renderer is not woken up for
// nothing.
//
// Uses CGWindowListCopyWindowInfo, which returns window *bounds* and owner names
// without any TCC permission. Window *titles* (kCGWindowName) are redacted on
// macOS 10.15+ unless Screen Recording is granted, so we deliberately do not ask
// for them — the pet only needs geometry and the owning app.

import Foundation
import CoreGraphics

struct Win: Codable, Equatable {
    let id: Int
    let app: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

/// Windows smaller than this in either axis are ignored — they are almost always
/// tooltips, shadows, status items or other chrome the pet should not stand on.
let MIN_SIZE: Double = 120

func scan() -> [Win] {
    let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
    guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }

    // Stage Manager renders its left-edge strip as real layer-0 windows: one owned
    // by "WindowManager" plus a shadow copy owned by the actual app, sharing the
    // same bounds. Collect the strip rects first so we can drop both.
    var stripRects: [CGRect] = []
    for info in raw {
        guard let owner = info[kCGWindowOwnerName as String] as? String, owner == "WindowManager",
              let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
        else { continue }
        stripRects.append(rect)
    }

    func isStageManagerThumbnail(_ rect: CGRect) -> Bool {
        stripRects.contains { abs($0.minX - rect.minX) < 2 && abs($0.minY - rect.minY) < 2
                           && abs($0.width - rect.width) < 2 && abs($0.height - rect.height) < 2 }
    }

    var out: [Win] = []
    for info in raw {
        // Layer 0 is the normal application window layer. Anything else is the
        // dock, menu bar, floating panels, screen-saver level, etc.
        guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { continue }

        // Fully transparent windows are invisible helpers, not surfaces.
        if let alpha = info[kCGWindowAlpha as String] as? Double, alpha < 0.15 { continue }

        guard let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
              let owner = info[kCGWindowOwnerName as String] as? String,
              let number = info[kCGWindowNumber as String] as? Int
        else { continue }

        if rect.width < MIN_SIZE || rect.height < MIN_SIZE { continue }
        if isStageManagerThumbnail(rect) { continue }

        // Our own overlay must never become a platform, or the pet stands on itself.
        if owner == "Electron" || owner == "desktop-pet" || owner == "WindowManager" { continue }

        out.append(Win(id: number, app: owner,
                       x: rect.origin.x, y: rect.origin.y,
                       w: rect.width, h: rect.height))
    }
    // CGWindowList returns front-to-back; keep that order so the renderer knows
    // which window is on top when they overlap.
    return out
}

let encoder = JSONEncoder()
var previous: [Win] = []

// Interval in milliseconds, overridable so the main process can throttle us when
// the pet is asleep or the machine is on battery.
let intervalMs = CommandLine.arguments.count > 1 ? (Int(CommandLine.arguments[1]) ?? 500) : 500

while true {
    let current = scan()
    if current != previous {
        previous = current
        if let data = try? encoder.encode(current),
           let line = String(data: data, encoding: .utf8) {
            print(line)
            fflush(stdout)
        }
    }
    // Exit quietly if the parent goes away. A broken stdout is the clean signal;
    // getppid() == 1 catches the case where the parent was killed outright and
    // we were reparented to launchd, which would otherwise leave us running
    // forever after the app is gone.
    if ferror(stdout) != 0 || getppid() == 1 { exit(0) }
    usleep(UInt32(intervalMs * 1000))
}
