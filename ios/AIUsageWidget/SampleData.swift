//
//  SampleData.swift
//  AIUsageWidget — a realistic PhonePayload for the widget gallery placeholder
//  (WidgetKit redacts it automatically while the real data loads).
//

import Foundation

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
}
