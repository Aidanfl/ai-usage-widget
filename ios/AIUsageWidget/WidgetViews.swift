//
//  WidgetViews.swift
//  AIUsageWidget — view model + one view per widget family.
//
//  Colours follow the desktop rules: series colour < warn → amber ≥ warnThreshold → red ≥ dangerThreshold;
//  the freshness dot is green < 10 min, amber < 60 min, red otherwise (payload age).
//

import WidgetKit
import SwiftUI

// MARK: - View model

struct UsageWidgetRow {
    let providerId: String
    let providerName: String
    let window: UsageWindow
    let compactLabel: String        // "CLAUDE 5H"
    let shortLabel: String          // "5H" / "7D" / "FABLE 7D"
    let level: ThresholdLevel
    let gradient: BarGradient
    let color: Color
    let fraction: Double            // 0...1 (clamped)
    let percentText: String
    let resetsIn: String
    let resetsAt: String
}

struct UsageWidgetModel {
    let payload: PhonePayload
    let now: Date
    let fetchedAt: Date
    let fromCache: Bool
    let settings: EffectiveSettings
    let providers: [ProviderSnapshot]
    let freshness: Freshness
    let generatedDate: Date?
    let host: String?

    init(payload: PhonePayload, now: Date, fetchedAt: Date, fromCache: Bool) {
        self.payload = payload
        self.now = now
        self.fetchedAt = fetchedAt
        self.fromCache = fromCache
        self.settings = payload.effectiveSettings
        self.providers = payload.providers
        self.generatedDate = payload.generatedDate
        self.freshness = Formatting.freshness(generatedAt: payload.generatedDate, now: now)
        let h = payload.source?.host ?? ""
        self.host = h.isEmpty ? nil : h
    }

    var claude: ProviderSnapshot? { return providers.first { $0.providerId == "claude" } }
    var codex: ProviderSnapshot? { return providers.first { $0.providerId == "codex" } }

    func rows(for provider: ProviderSnapshot) -> [UsageWidgetRow] {
        let name = provider.displayName
        return provider.windowList.map { (w: UsageWindow) -> UsageWidgetRow in
            let level = Formatting.rowLevel(w, settings: settings)
            let short: String
            if w.kind == "weekly_scoped", let scope = w.scope, !scope.isEmpty {
                short = "\(scope) \(Formatting.shortWindowName(w))".trimmingCharacters(in: .whitespaces).uppercased()
            } else {
                let s = Formatting.shortWindowName(w)
                short = s.isEmpty ? w.displayLabel.uppercased() : s
            }
            let reset = w.resetsAtDate
            return UsageWidgetRow(
                providerId: provider.providerId,
                providerName: name,
                window: w,
                compactLabel: Formatting.compactLabel(providerName: name, window: w),
                shortLabel: short,
                level: level,
                gradient: Theme.barGradient(token: w.colorToken, level: level),
                color: Theme.barColor(token: w.colorToken, level: level),
                fraction: Formatting.clampPercent(w.percent) / 100.0,
                percentText: Formatting.percentText(w.percent),
                resetsIn: Formatting.resetsIn(resetsAt: reset, percent: w.percent, now: now),
                resetsAt: Formatting.resetsAt(reset,
                                              isWeekly: Formatting.isWeeklyWindow(w, now: now),
                                              timeFormat: settings.timeFormat,
                                              dateFormat: settings.dateFormat)
            )
        }
    }

    var allRows: [UsageWidgetRow] {
        return providers.flatMap { rows(for: $0) }
    }

    /// The row the small/circular widgets headline: Claude's active window, else Claude's first, else the first row.
    var headline: UsageWidgetRow? {
        if let c = claude {
            let rows = self.rows(for: c)
            if let active = rows.first(where: { $0.window.isActive == true }) { return active }
            if let first = rows.first { return first }
        }
        return allRows.first
    }

    /// Provider's headline percent for the inline text ("Claude 42%").
    private func headlinePercent(for provider: ProviderSnapshot) -> String? {
        let rows = self.rows(for: provider)
        if let active = rows.first(where: { $0.window.isActive == true }) { return active.percentText }
        return rows.first?.percentText
    }

    /// "Claude 42% · Codex 12%"
    var inlineText: String {
        let parts: [String] = providers.compactMap { p in
            guard let pct = headlinePercent(for: p) else { return nil }
            return "\(p.displayName) \(pct)"
        }
        return parts.isEmpty ? "AI Usage — no data" : parts.joined(separator: " · ")
    }

    var updatedText: String {
        guard let g = generatedDate else { return "no timestamp" }
        return "Updated " + Formatting.relativeAgo(g, now: now)
    }

    var updatedWithHost: String {
        var s = updatedText
        if let h = host { s += " on \(h)" }
        if fromCache { s += " (cached)" }
        return s
    }
}

// MARK: - Shared pieces

struct WidgetRowLine: View {
    let row: UsageWidgetRow
    var label: String
    var barHeight: CGFloat = 6
    var labelWidth: CGFloat = 60
    var percentFont: Font = .system(size: 11, weight: .bold)

    var body: some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .kerning(0.4)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: labelWidth, alignment: .leading)
            GradientBar(fraction: row.fraction, gradient: row.gradient, height: barHeight, glow: false)
            Text(row.percentText)
                .monospacedDigit()
                .font(percentFont)
                .foregroundStyle(row.level == .danger ? Theme.dangerText : Color.primary)
                .frame(width: 34, alignment: .trailing)
        }
    }
}

struct WidgetProviderHeader: View {
    let provider: ProviderSnapshot
    var showPlan: Bool = true

    var body: some View {
        HStack(spacing: 5) {
            ProviderMark(providerId: provider.providerId, size: 12)
            Text(provider.displayName)
                .font(.system(size: 11, weight: .semibold))
                .lineLimit(1)
            if showPlan, let plan = provider.plan, !plan.isEmpty {
                Chip(text: plan, hue: Theme.providerHue(provider.providerId))
            }
            StatusDot(color: Theme.statusColor(provider.statusKind), size: 6)
        }
    }
}

struct WidgetFreshnessLine: View {
    let model: UsageWidgetModel
    var showHost: Bool = false

    var body: some View {
        HStack(spacing: 5) {
            StatusDot(color: Theme.freshnessColor(model.freshness), size: 6)
            Text(showHost ? model.updatedWithHost : model.updatedText)
                .monospacedDigit()
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

// MARK: - systemSmall

struct SmallWidgetView: View {
    let model: UsageWidgetModel

    private var provider: ProviderSnapshot? { return model.claude ?? model.providers.first }
    private var rows: [UsageWidgetRow] { return provider.map { model.rows(for: $0) } ?? [] }
    private var headline: UsageWidgetRow? { return model.headline }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let p = provider {
                HStack {
                    WidgetProviderHeader(provider: p, showPlan: false)
                    Spacer(minLength: 0)
                    StatusDot(color: Theme.freshnessColor(model.freshness), size: 6)
                }
            }
            if let h = headline {
                Text(h.percentText)
                    .monospacedDigit()
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(h.level == .danger ? Theme.dangerText : Color.primary)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                Text("\(h.window.displayLabel.uppercased()) · \(h.resetsIn)")
                    .monospacedDigit()
                    .font(.system(size: 8, weight: .semibold))
                    .kerning(0.3)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                Text("No usage windows")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 2)
            ForEach(Array(rows.prefix(2).enumerated()), id: \.offset) { item in
                WidgetRowLine(row: item.element, label: item.element.shortLabel, barHeight: 5, labelWidth: 26,
                              percentFont: .system(size: 10, weight: .bold))
            }
        }
    }
}

// MARK: - systemMedium

struct MediumWidgetView: View {
    let model: UsageWidgetModel

    private var columns: [ProviderSnapshot] { return Array(model.providers.prefix(2)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 14) {
                if columns.isEmpty {
                    Text("No providers in the last snapshot")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                ForEach(Array(columns.enumerated()), id: \.offset) { item in
                    ProviderColumn(provider: item.element, model: model)
                }
            }
            Spacer(minLength: 0)
            WidgetFreshnessLine(model: model, showHost: false)
        }
    }
}

struct ProviderColumn: View {
    let provider: ProviderSnapshot
    let model: UsageWidgetModel

    private var rows: [UsageWidgetRow] { return model.rows(for: provider) }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            WidgetProviderHeader(provider: provider, showPlan: false)
            if rows.isEmpty {
                Text(provider.errorMessage ?? "No usage windows")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            ForEach(Array(rows.prefix(3).enumerated()), id: \.offset) { item in
                WidgetRowLine(row: item.element, label: item.element.shortLabel, barHeight: 5, labelWidth: 46,
                              percentFont: .system(size: 10, weight: .bold))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - systemLarge

struct LargeWidgetView: View {
    let model: UsageWidgetModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.providers.isEmpty {
                Text("No providers in the last snapshot")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(model.providers.enumerated()), id: \.offset) { item in
                LargeProviderBlock(provider: item.element, model: model)
            }
            Spacer(minLength: 0)
            WidgetFreshnessLine(model: model, showHost: true)
        }
    }
}

struct LargeProviderBlock: View {
    let provider: ProviderSnapshot
    let model: UsageWidgetModel

    private var rows: [UsageWidgetRow] { return model.rows(for: provider) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                WidgetProviderHeader(provider: provider, showPlan: true)
                Spacer(minLength: 0)
                if let d = provider.updatedDate {
                    Text("updated " + Formatting.relativeAgo(d, now: model.now))
                        .monospacedDigit()
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            if rows.isEmpty {
                Text(provider.errorMessage ?? "No usage windows reported")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            ForEach(Array(rows.prefix(4).enumerated()), id: \.offset) { item in
                LargeRow(row: item.element)
            }
        }
        .padding(8)
        .background(Theme.wellBackground)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct LargeRow: View {
    let row: UsageWidgetRow

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(row.window.displayLabel.uppercased())
                    .font(.system(size: 9, weight: .semibold))
                    .kerning(0.4)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(row.resetsIn)
                    .monospacedDigit()
                    .font(.system(size: 10, weight: .medium))
                    .lineLimit(1)
                Text("·")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                Text(row.resetsAt)
                    .monospacedDigit()
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            HStack(spacing: 6) {
                GradientBar(fraction: row.fraction, gradient: row.gradient, height: 5, glow: false)
                Text(row.percentText)
                    .monospacedDigit()
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(row.level == .danger ? Theme.dangerText : Color.primary)
                    .frame(width: 34, alignment: .trailing)
            }
        }
    }
}

// MARK: - Lock screen: accessoryRectangular

struct AccessoryRectangularView: View {
    let model: UsageWidgetModel

    /// Claude session + weekly, then the first Codex row (three thin bars).
    private var rows: [UsageWidgetRow] {
        var out: [UsageWidgetRow] = []
        if let c = model.claude { out.append(contentsOf: model.rows(for: c).prefix(2)) }
        if let x = model.codex, let first = model.rows(for: x).first { out.append(first) }
        if out.isEmpty { out = Array(model.allRows.prefix(3)) }
        return Array(out.prefix(3))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if rows.isEmpty {
                Text("AI Usage — no data")
                    .font(.system(size: 11))
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { item in
                HStack(spacing: 5) {
                    Text(item.element.compactLabel)
                        .font(.system(size: 9, weight: .semibold))
                        .lineLimit(1)
                        .frame(width: 58, alignment: .leading)
                    AccessoryBar(fraction: item.element.fraction)
                    Text(item.element.percentText)
                        .monospacedDigit()
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 30, alignment: .trailing)
                }
            }
        }
    }
}

/// Monochrome-friendly thin bar for the lock screen (the system tints accentable content).
struct AccessoryBar: View {
    let fraction: Double

    private func fillWidth(total: CGFloat) -> CGFloat {
        let clamped: Double = min(1.0, max(0.0, fraction.isFinite ? fraction : 0.0))
        let minimum: CGFloat = clamped > 0 ? 4 : 0
        return max(minimum, total * CGFloat(clamped))
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.primary.opacity(0.25))
                Capsule()
                    .fill(Color.primary)
                    .frame(width: fillWidth(total: geo.size.width))
                    .widgetAccentable()
            }
        }
        .frame(height: 4)
    }
}

// MARK: - Lock screen: accessoryInline

struct AccessoryInlineView: View {
    let model: UsageWidgetModel

    var body: some View {
        Text(model.inlineText)
    }
}

// MARK: - Lock screen: accessoryCircular

struct AccessoryCircularView: View {
    let model: UsageWidgetModel

    private var headline: UsageWidgetRow? { return model.headline }

    var body: some View {
        if let h = headline {
            Gauge(value: h.fraction, in: 0...1, label: {
                Text(h.providerName.prefix(1).uppercased())
                    .font(.system(size: 10, weight: .bold))
            }, currentValueLabel: {
                Text("\(Int((h.fraction * 100).rounded()))")
                    .monospacedDigit()
                    .font(.system(size: 14, weight: .bold))
            })
            .gaugeStyle(.accessoryCircular)
            .widgetAccentable()
        } else {
            Gauge(value: 0, in: 0...1, label: {
                Text("AI")
                    .font(.system(size: 10, weight: .bold))
            }, currentValueLabel: {
                Text("—")
            })
            .gaugeStyle(.accessoryCircular)
        }
    }
}

// MARK: - Unpaired / message placeholders

struct UnpairedWidgetView: View {
    let family: WidgetFamily

    var body: some View {
        switch family {
        case .accessoryInline:
            Text("AI Usage — pair in the app")
        case .accessoryCircular:
            VStack(spacing: 0) {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 16, weight: .semibold))
                Text("Pair")
                    .font(.system(size: 9, weight: .semibold))
            }
        case .accessoryRectangular:
            HStack(spacing: 6) {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 16))
                VStack(alignment: .leading, spacing: 1) {
                    Text("AI Usage")
                        .font(.system(size: 11, weight: .semibold))
                    Text("Pair in the app")
                        .font(.system(size: 10))
                }
            }
        default:
            VStack(spacing: 6) {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                Text("Pair in the app")
                    .font(.system(size: 13, weight: .semibold))
                Text("Open AI Usage and scan the pairing code shown by the desktop widget.")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct MessageWidgetView: View {
    let family: WidgetFamily
    let text: String

    var body: some View {
        switch family {
        case .accessoryInline:
            Text("AI Usage — no data yet")
        case .accessoryCircular:
            VStack(spacing: 0) {
                Image(systemName: "icloud.slash")
                    .font(.system(size: 14, weight: .semibold))
                Text("—")
                    .font(.system(size: 9, weight: .semibold))
            }
        case .accessoryRectangular:
            HStack(spacing: 6) {
                Image(systemName: "icloud.slash")
                    .font(.system(size: 14))
                Text(text)
                    .font(.system(size: 10))
                    .lineLimit(3)
            }
        default:
            VStack(spacing: 6) {
                Image(systemName: "icloud.slash")
                    .font(.system(size: 22))
                    .foregroundStyle(.secondary)
                Text("No snapshot yet")
                    .font(.system(size: 12, weight: .semibold))
                Text(text)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(4)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
