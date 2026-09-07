//
//  Theme.swift
//  AIUsage (shared)
//
//  Colour tokens lifted from src/renderer/styles.css so the phone paints the same hues as the desktop.
//  Every fixed hue is chosen to read on both light and dark backgrounds; text colours that differ
//  between the two themes use `adaptive(light:dark:)`.
//

import SwiftUI
import UIKit

extension Color {
    /// `Color(hex: 0x8b5cf6)`
    init(hex: UInt32, opacity: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1.0) {
        let r = CGFloat((hex >> 16) & 0xFF) / 255.0
        let g = CGFloat((hex >> 8) & 0xFF) / 255.0
        let b = CGFloat(hex & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b, alpha: alpha)
    }
}

/// Two-stop gradient for a usage bar (`.fill.<token>` in styles.css: --c1 → --c2).
struct BarGradient: Equatable {
    let start: Color
    let end: Color

    var linear: LinearGradient {
        return LinearGradient(colors: [start, end], startPoint: .leading, endPoint: .trailing)
    }
}

enum Theme {

    // MARK: Series colour tokens (styles.css `.fill.*` / app.js SERIES_HEX)

    private static let seriesHex: [String: (UInt32, UInt32)] = [
        "purple": (0x8b5cf6, 0xa78bfa),
        "blue": (0x3b82f6, 0x60a5fa),
        "fuchsia": (0xd946ef, 0xe879f9),
        "green": (0x10a37f, 0x34d399),
        "teal": (0x14b8a6, 0x2dd4bf),
        "amber": (0xf59e0b, 0xfbbf24),
        "rose": (0xf43f5e, 0xfb7185),
        "slate": (0x64748b, 0x94a3b8),
        "spend": (0x10b981, 0x34d399),
    ]

    static let defaultToken = "purple"

    /// Gradient for a series token; unknown tokens fall back to purple.
    static func seriesGradient(_ token: String?) -> BarGradient {
        let pair = seriesHex[token ?? defaultToken] ?? seriesHex[defaultToken] ?? (0x8b5cf6, 0xa78bfa)
        return BarGradient(start: Color(hex: pair.0), end: Color(hex: pair.1))
    }

    /// Solid colour for a series token (chart lines, legend dots, compact dots).
    static func seriesColor(_ token: String?) -> Color {
        let pair = seriesHex[token ?? defaultToken] ?? seriesHex[defaultToken] ?? (0x8b5cf6, 0xa78bfa)
        return Color(hex: pair.0)
    }

    static let warningGradient = BarGradient(start: Color(hex: 0xf59e0b), end: Color(hex: 0xfbbf24))
    static let dangerGradient = BarGradient(start: Color(hex: 0xef4444), end: Color(hex: 0xf87171))
    static let spendGradient = BarGradient(start: Color(hex: 0x10b981), end: Color(hex: 0x34d399))

    /// Bar gradient after applying the thresholds: series colour < warn → amber ≥ warnThreshold → red ≥ dangerThreshold.
    static func barGradient(token: String?, level: ThresholdLevel) -> BarGradient {
        switch level {
        case .danger: return dangerGradient
        case .warning: return warningGradient
        case .normal: return seriesGradient(token)
        }
    }

    /// Solid colour after thresholds (widgets, rings, chips).
    static func barColor(token: String?, level: ThresholdLevel) -> Color {
        switch level {
        case .danger: return dangerGradient.start
        case .warning: return warningGradient.start
        case .normal: return seriesColor(token)
        }
    }

    // MARK: Status / freshness dots (styles.css `.dot`)

    static let statusOk = Color(hex: 0x34d399)
    static let statusStale = Color(hex: 0xf59e0b)
    static let statusError = Color(hex: 0xef4444)

    static func statusColor(_ status: ProviderStatus) -> Color {
        switch status {
        case .ok: return statusOk
        case .stale: return statusStale
        case .authRequired, .error: return statusError
        }
    }

    static func freshnessColor(_ f: Freshness) -> Color {
        switch f {
        case .fresh: return statusOk
        case .aging: return statusStale
        case .stale: return statusError
        case .unknown: return Color.secondary
        }
    }

    // MARK: Elapsed ring overrides

    static let elapsedWarn = Color(hex: 0xf59e0b)
    static let elapsedSoon = Color(hex: 0x10b981)

    static func ringColor(token: String?, elapsedPercent: Double?) -> Color {
        guard let e = elapsedPercent, e.isFinite else { return seriesColor(token) }
        if e >= Formatting.elapsedGreenThreshold { return elapsedSoon }
        if e >= Formatting.elapsedAmberThreshold { return elapsedWarn }
        return seriesColor(token)
    }

    // MARK: Provider hues (app.js PROVIDER_HUE) & chips

    static let claudeHue = Color(hex: 0xd97757)
    static let codexHue = Color(hex: 0x10a37f)
    static let genericHue = Color(hex: 0x8b5cf6)

    static func providerHue(_ id: String?) -> Color {
        switch id ?? "" {
        case "claude": return claudeHue
        case "codex": return codexHue
        default: return genericHue
        }
    }

    static let chipOn = Color(hex: 0x34d399)
    static let chipOff = Color(hex: 0xa0a0af)
    static let chipAmber = Color(hex: 0xf59e0b)
    static let chipSlate = Color(hex: 0x94a3b8)

    // MARK: Adaptive text colours

    static func adaptive(light: UInt32, dark: UInt32) -> Color {
        let ui = UIColor { (traits: UITraitCollection) -> UIColor in
            return traits.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
        }
        return Color(uiColor: ui)
    }

    static let accent = adaptive(light: 0x7c3aed, dark: 0x8b5cf6)
    static let accentText = adaptive(light: 0x6d28d9, dark: 0xb6a0ff)
    static let dangerText = adaptive(light: 0xdc2626, dark: 0xf87171)
    static let warnText = adaptive(light: 0xb45309, dark: 0xfbbf24)

    // MARK: Surfaces

    static var screenBackground: Color { return Color(uiColor: UIColor.systemGroupedBackground) }
    static var cardBackground: Color { return Color(uiColor: UIColor.secondarySystemGroupedBackground) }
    static var widgetBackground: Color { return Color(uiColor: UIColor.systemBackground) }
    static var wellBackground: Color { return Color.primary.opacity(0.05) }
    static var track: Color { return Color.primary.opacity(0.10) }
    static var divider: Color { return Color.primary.opacity(0.08) }
}
