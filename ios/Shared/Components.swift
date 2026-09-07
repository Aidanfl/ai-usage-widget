//
//  Components.swift
//  AIUsage (shared) — tiny SwiftUI building blocks used by both the app and the widget.
//

import SwiftUI

/// Gradient usage bar on a translucent track (styles.css `.track` / `.fill`).
struct GradientBar: View {
    let fraction: Double            // 0...1
    let gradient: BarGradient
    var height: CGFloat = 6
    var glow: Bool = true

    private var clamped: Double { return min(1.0, max(0.0, fraction.isFinite ? fraction : 0.0)) }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Theme.track)
                if clamped > 0 {
                    Capsule()
                        .fill(gradient.linear)
                        .frame(width: max(height, geo.size.width * CGFloat(clamped)))
                        .shadow(color: glow ? gradient.start.opacity(0.45) : Color.clear, radius: glow ? 4 : 0)
                }
            }
        }
        .frame(height: height)
    }
}

/// 7 px glowing status dot (styles.css `.dot`).
struct StatusDot: View {
    let color: Color
    var size: CGFloat = 7

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .shadow(color: color.opacity(0.7), radius: 3)
    }
}

/// Small rounded chip (plan label, ON/OFF pill, model availability).
struct Chip: View {
    let text: String
    let hue: Color
    var showDot: Bool = false

    var body: some View {
        HStack(spacing: 4) {
            if showDot {
                Circle().fill(hue).frame(width: 5, height: 5)
            }
            Text(text)
                .font(.system(size: 10, weight: .bold))
                .lineLimit(1)
        }
        .foregroundStyle(hue)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(hue.opacity(0.15))
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(hue.opacity(0.3), lineWidth: 1))
    }
}

/// Provider mark: an SF Symbol in the provider hue (no third-party logos).
struct ProviderMark: View {
    let providerId: String
    var size: CGFloat = 16

    private var symbolName: String {
        switch providerId {
        case "claude": return "asterisk"
        case "codex": return "hexagon"
        default: return "circle.fill"
        }
    }

    var body: some View {
        Image(systemName: symbolName)
            .font(.system(size: size * 0.8, weight: .semibold))
            .foregroundStyle(Theme.providerHue(providerId))
            .frame(width: size, height: size)
    }
}

/// Elapsed-window ring (styles.css `.ring`): r = 10, 3 px stroke, minimum visible arc 8°.
struct ElapsedRing: View {
    let fraction: Double
    let color: Color
    var size: CGFloat = 18

    private var shown: Double {
        let f = min(1.0, max(0.0, fraction.isFinite ? fraction : 0.0))
        return f > 0 ? max(f, 8.0 / 360.0) : 0
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(Theme.track, lineWidth: 3)
            Circle()
                .trim(from: 0, to: CGFloat(shown))
                .stroke(color, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: size, height: size)
    }
}
