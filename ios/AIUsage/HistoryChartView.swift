//
//  HistoryChartView.swift
//  AIUsage — 7-day usage history (Swift Charts), one stepped line per series, y 0–100 %,
//  dashed rule at the danger threshold. Mirrors the desktop Chart.js graph.
//

import SwiftUI
import Charts

struct HistoryChartView: View {
    let history: History?
    let snapshot: Snapshot?
    let settings: EffectiveSettings
    let now: Date

    static let historyDays: Double = 7

    /// The desktop's dash per Claude account slot (slot 1 solid), so the same account draws the same
    /// line on both screens. A slot past six starts the cycle again.
    static let accountDashes: [[CGFloat]] = [[], [6, 3], [2, 3], [8, 3, 2, 3], [12, 4], [1, 4]]

    private struct ChartPoint: Identifiable {
        let id: Int
        let series: String      // legend label (unique)
        let key: String         // series key — what a line is grouped by with several accounts
        let colorLabel: String  // several accounts: the window's legend entry ("Claude 5h"), shared by the accounts
        let account: String     // several accounts: the account's legend entry (its dash)
        let date: Date
        let value: Double
    }

    private struct SeriesInfo {
        let key: String
        let label: String
        let color: Color
        let colorLabel: String
        let account: String
        let dash: [CGFloat]
    }

    /// More than one Claude account: four accounts' "5h" lines would all be the same purple, so the
    /// hue keeps meaning "which limit" (as on the desktop) and a dash per account says "whose".
    private var isMultiAccount: Bool {
        return (snapshot?.orderedProviders.filter { $0.isClaude }.count ?? 0) > 1
    }

    // MARK: Data shaping

    /// Legend label for a series key: "Claude 5h" / "Fable 7d" / "Codex 7d" / "Claude extra".
    private func legendLabel(for series: HistorySeries) -> String {
        let key = series.key ?? ""
        let parts = key.split(separator: ".", maxSplits: 1).map { String($0) }
        if parts.count == 2,
           let provider = snapshot?.orderedProviders.first(where: { $0.providerId == parts[0] }) {
            if parts[1] == "extra" { return "\(provider.displayName) extra" }
            if let w = provider.windowList.first(where: { $0.key == parts[1] }) {
                return Formatting.seriesLabel(providerName: provider.displayName, window: w)
            }
        }
        if let l = series.label, !l.isEmpty { return l }
        return key.isEmpty ? "?" : key
    }

    /// Several accounts: the window half of the legend. A Claude account's series reads as plain
    /// "Claude 5h" / "Fable 7d" / "Claude extra" — the account is in its dash — and every other
    /// provider keeps its usual label ("Codex 7d").
    private func colorLabel(for series: HistorySeries, providerId: String) -> String {
        guard ProviderIds.isClaude(providerId) else { return legendLabel(for: series) }
        let windowKey = (series.key ?? "").split(separator: ".", maxSplits: 1).dropFirst().first.map { String($0) } ?? ""
        if windowKey == "extra" { return "Claude extra" }
        // Its own account first; an account that is no longer in the snapshot borrows the window from
        // any other (every Claude account has the same "session" / "weekly" / "weekly_fable" keys).
        let claudes = (snapshot?.orderedProviders ?? []).filter { $0.isClaude }
        let owner = claudes.filter { $0.providerId == providerId } + claudes.filter { $0.providerId != providerId }
        for provider in owner {
            if let w = provider.windowList.first(where: { $0.key == windowKey }) {
                return Formatting.seriesLabel(providerName: "Claude", window: w)
            }
        }
        return legendLabel(for: series)
    }

    /// "claude-3.weekly" → "claude-3": the provider a series belongs to, and so whose dash it draws.
    private static func providerId(ofKey key: String) -> String {
        return key.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).first.map { String($0) } ?? ""
    }

    /// Several accounts: an account's name for the legend — the provider's own, else (an account hidden,
    /// deduped or removed on the desktop, which still has seven days of history) the desktop's default
    /// name derived from the id: "Claude 3", or the id itself for anything that is not a Claude account.
    /// Never the series label: the desktop sends "<name> <window label>" ("Claude 3 Weekly" for a
    /// leftover), with no separator to split the window off, so labels would give one entry per window.
    private func accountName(providerId: String) -> String {
        if let p = snapshot?.orderedProviders.first(where: { $0.providerId == providerId }) { return p.displayName }
        if let slot = ProviderIds.claudeSlot(providerId) { return "Claude \(slot)" }
        return providerId.isEmpty ? "?" : providerId
    }

    /// Several accounts: the account half of the legend, ONE entry per provider id (the line style scale
    /// maps entry → dash, so the entry must be as unique as the slot). Two accounts the user gave the
    /// same label each carry their slot ("Work (1)", "Work (2)") instead of sharing an entry and a dash.
    private func accountLabels(for providerIds: [String]) -> [String: String] {
        var order: [String] = []
        for id in providerIds where !order.contains(id) { order.append(id) }
        let names = order.map { accountName(providerId: $0) }
        var counts: [String: Int] = [:]
        for name in names { counts[name, default: 0] += 1 }
        var used = Set<String>()
        var out: [String: String] = [:]
        for (id, name) in zip(order, names) {
            var label = name
            if counts[name, default: 0] > 1 {
                label = ProviderIds.claudeSlot(id).map { "\(name) (\($0))" } ?? "\(name) (\(id))"
            }
            // A label that happens to read like another's disambiguated one ("Work (2)") still gets its own.
            while used.contains(label) { label += " (\(id))" }
            used.insert(label)
            out[id] = label
        }
        return out
    }

    private var seriesInfos: [SeriesInfo] {
        guard let h = history else { return [] }
        let multi = isMultiAccount
        let series = h.seriesList.compactMap { s in s.key.map { (series: s, key: $0) } }
        let accounts = multi ? accountLabels(for: series.map { HistoryChartView.providerId(ofKey: $0.key) }) : [:]
        var used = Set<String>()
        var out: [SeriesInfo] = []
        for (s, key) in series {
            var label = legendLabel(for: s)
            if used.contains(label) { label = "\(label) (\(key))" }
            used.insert(label)
            let providerId = HistoryChartView.providerId(ofKey: key)
            let slot = ProviderIds.claudeSlot(providerId) ?? 1
            out.append(SeriesInfo(key: key,
                                  label: label,
                                  color: Theme.seriesColor(s.color),
                                  colorLabel: multi ? colorLabel(for: s, providerId: providerId) : label,
                                  account: accounts[providerId] ?? "",
                                  dash: HistoryChartView.accountDashes[(slot - 1) % HistoryChartView.accountDashes.count]))
        }
        return out
    }

    private func points(for infos: [SeriesInfo]) -> [ChartPoint] {
        guard let h = history else { return [] }
        let samples = h.sampleList
        var out: [ChartPoint] = []
        var index = 0
        for info in infos {
            for sample in samples {
                guard let v = sample.v[info.key], v.isFinite else { continue }
                out.append(ChartPoint(id: index, series: info.label, key: info.key, colorLabel: info.colorLabel,
                                      account: info.account, date: sample.date, value: min(100, max(0, v))))
                index += 1
            }
        }
        return out
    }

    private var xDomain: ClosedRange<Date> {
        let samples = history?.sampleList ?? []
        let maxX = max(samples.last?.date ?? now, now)
        let earliest = samples.first?.date ?? now
        let lower = max(earliest, maxX.addingTimeInterval(-HistoryChartView.historyDays * 86400))
        let start = Calendar.current.startOfDay(for: lower)
        return start...maxX
    }

    // MARK: View

    var body: some View {
        let infos = seriesInfos
        let pts = points(for: infos)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("USAGE HISTORY")
                    .font(.system(size: 10, weight: .semibold))
                    .kerning(0.6)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("LAST 7 DAYS")
                    .font(.system(size: 9, weight: .semibold))
                    .kerning(0.6)
                    .foregroundStyle(.tertiary)
            }
            if pts.isEmpty {
                Text("No history yet — the graph fills in as the desktop samples usage over the next few refreshes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else if isMultiAccount {
                multiAccountChart(points: pts, infos: infos)
            } else {
                chart(points: pts, infos: infos)
            }
        }
        .padding(12)
        .background(Theme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func chart(points: [ChartPoint], infos: [SeriesInfo]) -> some View {
        let labels: [String] = infos.map { $0.label }
        let colors: [Color] = infos.map { $0.color }
        return axes(Chart {
            ForEach(points) { p in
                LineMark(
                    x: .value("Time", p.date),
                    y: .value("Usage", p.value)
                )
                .foregroundStyle(by: .value("Series", p.series))
                .interpolationMethod(.stepEnd)
                .lineStyle(StrokeStyle(lineWidth: 1.5))
            }
            RuleMark(y: .value("Danger", settings.dangerThreshold))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundStyle(Theme.statusError.opacity(0.45))
        }
        .chartForegroundStyleScale(domain: labels, range: colors))
    }

    /// Several Claude accounts: one line per series key, coloured by WINDOW ("Claude 5h", shared by
    /// every account) and dashed by ACCOUNT, so the legend reads as two short keys — limits and
    /// accounts — instead of a dozen "Claude 3 5h"-style entries in four identical purples.
    private func multiAccountChart(points: [ChartPoint], infos: [SeriesInfo]) -> some View {
        var colorLabels: [String] = []
        var colors: [Color] = []
        var accounts: [String] = []
        var strokes: [StrokeStyle] = []
        for info in infos {
            if !colorLabels.contains(info.colorLabel) {
                colorLabels.append(info.colorLabel)
                colors.append(info.color)
            }
            if !accounts.contains(info.account) {
                accounts.append(info.account)
                strokes.append(StrokeStyle(lineWidth: 1.5, dash: info.dash))
            }
        }
        return axes(Chart {
            ForEach(points) { p in
                LineMark(
                    x: .value("Time", p.date),
                    y: .value("Usage", p.value),
                    series: .value("Key", p.key)
                )
                .foregroundStyle(by: .value("Limit", p.colorLabel))
                .lineStyle(by: .value("Account", p.account))
                .interpolationMethod(.stepEnd)
            }
            RuleMark(y: .value("Danger", settings.dangerThreshold))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundStyle(Theme.statusError.opacity(0.45))
        }
        .chartForegroundStyleScale(domain: colorLabels, range: colors)
        .chartLineStyleScale(domain: accounts, range: strokes))
    }

    /// Scales, axes, legend and height shared by both charts.
    private func axes<C: View>(_ chart: C) -> some View {
        let yTicks: [Double] = [0, 25, 50, 75, 100]
        return chart
            .chartXScale(domain: xDomain)
            .chartYScale(domain: 0...100)
            .chartYAxis {
                AxisMarks(position: .leading, values: yTicks) { value in
                    AxisGridLine()
                        .foregroundStyle(Theme.divider)
                    AxisValueLabel {
                        if let v = value.as(Double.self) {
                            Text("\(Int(v))%")
                                .font(.system(size: 9))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .day)) { _ in
                    AxisValueLabel(format: .dateTime.month(.abbreviated).day(), centered: false)
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
            }
            .chartLegend(position: .top, alignment: .leading, spacing: 6)
            .frame(height: 170)
    }
}
