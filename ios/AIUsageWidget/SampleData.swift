//
//  SampleData.swift
//  AIUsageWidget — a realistic PhonePayload for the widget gallery placeholder
//  (WidgetKit redacts it automatically while the real data loads), and a four-account payload
//  for the Xcode previews at the bottom.
//

import Foundation
import SwiftUI
import WidgetKit

enum SampleData {
    private static func iso(_ date: Date) -> String {
        return Formatting.isoString(fromMs: Models.msFromDate(date)) ?? ""
    }

    static var payload: PhonePayload {
        let now = Date()
        let nowMs = Models.msFromDate(now)

        let session = UsageWindow(key: "session",
                                  label: "Current Session",
                                  kind: "session",
                                  percent: 20,
                                  resetsAt: iso(now.addingTimeInterval(42 * 60)),
                                  windowSeconds: 18000,
                                  severity: "normal",
                                  isActive: true,
                                  color: "purple")
        let weekly = UsageWindow(key: "weekly",
                                 label: "Weekly Limit",
                                 kind: "weekly",
                                 percent: 22,
                                 resetsAt: iso(now.addingTimeInterval((24 + 8) * 3600)),
                                 windowSeconds: 604800,
                                 severity: "normal",
                                 isActive: false,
                                 color: "blue")
        let fable = UsageWindow(key: "weekly_fable",
                                label: "Fable Weekly",
                                kind: "weekly_scoped",
                                percent: 10,
                                resetsAt: iso(now.addingTimeInterval((24 + 8) * 3600)),
                                windowSeconds: 604800,
                                severity: nil,
                                isActive: nil,
                                color: "fuchsia",
                                scope: "Fable",
                                note: "Percent of Fable's 50% share of the weekly limit")
        let codexWeekly = UsageWindow(key: "secondary",
                                      label: "Weekly Limit",
                                      kind: "weekly",
                                      percent: 99,
                                      resetsAt: iso(now.addingTimeInterval((6 * 24 + 14) * 3600)),
                                      windowSeconds: 604800,
                                      severity: "critical",
                                      isActive: nil,
                                      color: "teal")

        let extra = ExtraUsage(enabled: true,
                               currency: "USD",
                               exponent: 2,
                               usedMinor: 7519,
                               limitMinor: nil,
                               percent: nil,
                               balanceMinor: 17500,
                               promoMinor: 5000,
                               paidMinor: 12500,
                               nextExpiresAt: iso(now.addingTimeInterval(18 * 86400)),
                               nextExpiryMinor: 5000,
                               disabledReason: nil)

        let credits = CodexCredits(hasCredits: false,
                                   unlimited: false,
                                   balance: nil,
                                   overageLimitReached: false,
                                   approxLocalMessages: nil,
                                   approxCloudMessages: nil,
                                   limitReached: false,
                                   limitReachedType: nil,
                                   modelUsage: ["gpt-6-astra": ModelAvailability(available: true, availableAt: nil)],
                                   resetCreditsAvailable: nil)

        let claude = ProviderSnapshot(id: "claude",
                                      name: "Claude",
                                      status: "ok",
                                      error: nil,
                                      source: "claude_code",
                                      plan: "Max 20x",
                                      account: nil,
                                      updatedAt: nowMs - 12_000,
                                      windows: [session, weekly, fable],
                                      extra: extra,
                                      credits: nil)
        let codex = ProviderSnapshot(id: "codex",
                                     name: "Codex",
                                     status: "ok",
                                     error: nil,
                                     source: "codex_auth_file",
                                     plan: "Team",
                                     account: nil,
                                     updatedAt: nowMs - 40_000,
                                     windows: [codexWeekly],
                                     extra: nil,
                                     credits: credits)

        let providers: [String: ProviderSnapshot?] = ["claude": claude, "codex": codex]
        let snapshot = Snapshot(fetchedAt: nowMs - 12_000, providers: providers)

        var samples: [HistorySample] = []
        var t = nowMs - 7 * 86_400_000
        var i = 0
        while t <= nowMs {
            let s = Double((i * 7) % 60) + 5
            let w = min(60.0, 5.0 + Double(i) / 6.0)
            samples.append(HistorySample(t: t, v: ["claude.session": s, "claude.weekly": w, "codex.secondary": min(99.0, Double(i) / 3.5)]))
            t += 30 * 60_000
            i += 1
        }
        let history = History(days: 7,
                              samples: samples,
                              series: [
                                HistorySeries(key: "claude.session", label: "Claude · Current Session", color: "purple"),
                                HistorySeries(key: "claude.weekly", label: "Claude · Weekly Limit", color: "blue"),
                                HistorySeries(key: "codex.secondary", label: "Codex · Weekly Limit", color: "teal"),
                              ])

        return PhonePayload(v: 1,
                            generatedAt: nowMs - 3 * 60_000,
                            source: PayloadSource(app: "ai-usage-widget", version: "0.2.0", platform: "win32", host: "DESKTOP"),
                            snapshot: snapshot,
                            settings: PhoneSettings(warnThreshold: 75, dangerThreshold: 90, timeFormat: "12h", dateFormat: nil),
                            history: history)
    }

    // MARK: - Four Claude accounts + Codex (desktop 1.1.0+), for the previews

    private static func window(_ key: String, _ label: String, kind: String, percent: Double, resetsIn: TimeInterval?,
                               seconds: Double, color: String, severity: String? = "normal", isActive: Bool? = nil,
                               scope: String? = nil, now: Date) -> UsageWindow {
        return UsageWindow(key: key, label: label, kind: kind, percent: percent,
                           resetsAt: resetsIn.map { iso(now.addingTimeInterval($0)) },
                           windowSeconds: seconds, severity: severity, isActive: isActive, color: color, scope: scope)
    }

    private static func claudeAccount(_ id: String, _ name: String, account: String?, status: String = "ok",
                                      message: String? = nil, source: String = "claude_code", plan: String?,
                                      updatedAgo: Double, windows: [UsageWindow], nowMs: Double) -> ProviderSnapshot {
        return ProviderSnapshot(id: id, name: name, status: status,
                                error: message.map { ProviderError(code: status == "stale" ? "http_429" : "session_expired", message: $0) },
                                source: source, plan: plan, account: account, updatedAt: nowMs - updatedAgo,
                                windows: windows, extra: nil, credits: nil)
    }

    /// Every state the multi-account layouts have to cope with: a calm account, one in the warning band,
    /// a stale one whose session is blocked (and whose label is not "Claude N", so its short name comes
    /// from the label), and a claude.ai sign-in that lapsed and has no windows at all.
    static var multiAccountPayload: PhonePayload {
        let now = Date()
        let nowMs = Models.msFromDate(now)
        let hour: TimeInterval = 3600
        let weekSeconds: Double = 604800

        let base = payload
        let claude1 = base.provider(ProviderIds.claude).map { p -> ProviderSnapshot in
            var c = p
            c.name = "Claude 1"
            c.account = "personal@example.com"
            return c
        }
        let claude2 = claudeAccount("claude-2", "Claude 2", account: "side-project@example.com", plan: "Max 5x", updatedAgo: 20_000, windows: [
            window("session", "Current Session", kind: "session", percent: 64, resetsIn: 2 * hour + 50 * 60,
                   seconds: 18000, color: "purple", isActive: true, now: now),
            window("weekly", "Weekly Limit", kind: "weekly", percent: 81, resetsIn: 3 * 24 * hour + 5 * hour,
                   seconds: weekSeconds, color: "blue", severity: "warning", now: now),
            window("weekly_fable", "Fable Weekly", kind: "weekly_scoped", percent: 30, resetsIn: 3 * 24 * hour + 5 * hour,
                   seconds: weekSeconds, color: "fuchsia", severity: nil, scope: "Fable", now: now),
        ], nowMs: nowMs)
        let claude3 = claudeAccount("claude-3", "Work", account: "Example Team", status: "stale",
                                    message: "Rate limited by Anthropic - showing last good values",
                                    plan: "Pro", updatedAgo: 9 * 60_000, windows: [
            window("session", "Current Session", kind: "session", percent: 100, resetsIn: 2 * hour + 5 * 60,
                   seconds: 18000, color: "purple", severity: "blocked", isActive: true, now: now),
            window("weekly", "Weekly Limit", kind: "weekly", percent: 47, resetsIn: 5 * 24 * hour + 2 * hour,
                   seconds: weekSeconds, color: "blue", now: now),
        ], nowMs: nowMs)
        let claude4 = claudeAccount("claude-4", "Claude 4", account: nil, status: "auth_required",
                                    message: "claude.ai session expired - sign in again on the desktop widget",
                                    source: "claude_web", plan: nil, updatedAgo: 26 * 3_600_000, windows: [], nowMs: nowMs)

        let providers: [String: ProviderSnapshot?] = [
            "claude": claude1, "claude-2": claude2, "claude-3": claude3, "claude-4": claude4,
            "codex": base.provider(ProviderIds.codex),
        ]

        // Sessions rise through a five-hour block and drop at its reset; weeklies only climb.
        var samples: [HistorySample] = []
        var t = nowMs - 7 * 86_400_000
        var i = 0
        while t <= nowMs {
            samples.append(HistorySample(t: t, v: [
                "claude.session": Double(i % 10) * 6,
                "claude.weekly": min(22.0, Double(i) / 15.0),
                "claude-2.session": Double((i + 4) % 10) * 9,
                "claude-2.weekly": min(81.0, Double(i) / 4.0),
                "claude-3.weekly": min(47.0, Double(i) / 7.0),
                "codex.secondary": min(99.0, Double(i) / 3.5),
            ]))
            t += 30 * 60_000
            i += 1
        }
        let history = History(days: 7, samples: samples, series: [
            HistorySeries(key: "claude.session", label: "Claude 1 · Current Session", color: "purple"),
            HistorySeries(key: "claude.weekly", label: "Claude 1 · Weekly Limit", color: "blue"),
            HistorySeries(key: "claude-2.session", label: "Claude 2 · Current Session", color: "purple"),
            HistorySeries(key: "claude-2.weekly", label: "Claude 2 · Weekly Limit", color: "blue"),
            HistorySeries(key: "claude-3.weekly", label: "Work · Weekly Limit", color: "blue"),
            HistorySeries(key: "codex.secondary", label: "Codex · Weekly Limit", color: "teal"),
        ])

        return PhonePayload(v: 1,
                            generatedAt: nowMs - 2 * 60_000,
                            source: PayloadSource(app: "ai-usage-widget", version: "1.1.0", platform: "darwin", host: "MAC"),
                            snapshot: Snapshot(fetchedAt: nowMs - 20_000, providers: providers),
                            settings: PhoneSettings(warnThreshold: 75, dangerThreshold: 90, timeFormat: "12h", dateFormat: nil),
                            history: history)
    }
}

#if DEBUG
private func sampleEntry(_ payload: PhonePayload) -> UsageEntry {
    return UsageEntry(date: Date(), state: .data(payload, fetchedAt: Date(), fromCache: false))
}

#Preview("Small · 4 accounts", as: .systemSmall) { UsageWidget() } timeline: { sampleEntry(SampleData.multiAccountPayload) }
#Preview("Medium · 4 accounts", as: .systemMedium) { UsageWidget() } timeline: { sampleEntry(SampleData.multiAccountPayload) }
#Preview("Large · 4 accounts", as: .systemLarge) { UsageWidget() } timeline: { sampleEntry(SampleData.multiAccountPayload) }
#Preview("Lock · 4 accounts", as: .accessoryRectangular) { UsageWidget() } timeline: { sampleEntry(SampleData.multiAccountPayload) }
#Preview("Inline · 4 accounts", as: .accessoryInline) { UsageWidget() } timeline: { sampleEntry(SampleData.multiAccountPayload) }
#Preview("Circular · 4 accounts", as: .accessoryCircular) { UsageWidget() } timeline: { sampleEntry(SampleData.multiAccountPayload) }
#Preview("Small · 1 account", as: .systemSmall) { UsageWidget() } timeline: { sampleEntry(SampleData.payload) }
#Preview("Medium · 1 account", as: .systemMedium) { UsageWidget() } timeline: { sampleEntry(SampleData.payload) }
#Preview("Large · 1 account", as: .systemLarge) { UsageWidget() } timeline: { sampleEntry(SampleData.payload) }
#endif
