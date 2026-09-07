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

    private struct ChartPoint: Identifiable {
        let id: Int
        let series: String      // legend label (unique)
        let date: Date
        let value: Double
    }

    private struct SeriesInfo {
        let key: String
        let label: String
        let color: Color
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

    private var seriesInfos: [SeriesInfo] {
        guard let h = history else { return [] }
        var used = Set<String>()
        var out: [SeriesInfo] = []
        for s in h.seriesList {
            guard let key = s.key else { continue }
            var label = legendLabel(for: s)
            if used.contains(label) { label = "\(label) (\(key))" }
            used.insert(label)
            out.append(SeriesInfo(key: key, label: label, color: Theme.seriesColor(s.color)))
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
                out.append(ChartPoint(id: index, series: info.label, date: sample.date, value: min(100, max(0, v))))
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
        let yTicks: [Double] = [0, 25, 50, 75, 100]
        return Chart {
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
        .chartForegroundStyleScale(domain: labels, range: colors)
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
