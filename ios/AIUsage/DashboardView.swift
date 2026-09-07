//
//  DashboardView.swift
//  AIUsage — provider cards mirroring the desktop panel.
//
//  Card = header (mark · name · plan chip · status dot · "updated Ns ago" · expand chevron)
//       + one row per UsageWindow (LABEL · resets in · resets at / gradient bar · % · elapsed ring)
//       + auth/error row when needed
//       + expand well (Extra Usage, Credits).
//

import SwiftUI

@MainActor
struct DashboardView: View {
    @EnvironmentObject private var store: UsageStore
    @State private var showSettings: Bool = false
    @State private var expanded: Set<String> = []

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: Date(), by: 30)) { context in
                DashboardContent(now: context.date, expanded: $expanded)
            }
            .background(Theme.screenBackground.ignoresSafeArea())
            .navigationTitle("AI Usage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if store.isRefreshing {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
            .task {
                await store.refresh()
            }
        }
    }
}

// MARK: - Scrolling content

@MainActor
struct DashboardContent: View {
    @EnvironmentObject private var store: UsageStore
    let now: Date
    @Binding var expanded: Set<String>

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let payload = store.payload {
                    PayloadView(payload: payload,
                                now: now,
                                expanded: $expanded,
                                lastFetched: store.lastFetched,
                                errorText: store.error)
                } else {
                    WaitingCard(errorText: store.error, isRefreshing: store.isRefreshing)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .refreshable {
            await store.refresh()
        }
    }
}

struct PayloadView: View {
    let payload: PhonePayload
    let now: Date
    @Binding var expanded: Set<String>
    let lastFetched: Date?
    let errorText: String?

    private var settings: EffectiveSettings { return payload.effectiveSettings }
    private var providers: [ProviderSnapshot] { return payload.providers }

    var body: some View {
        if providers.isEmpty {
            MessageCard(text: "The last snapshot has no providers — both are turned off in the desktop settings.")
        }
        ForEach(providers, id: \.providerId) { provider in
            ProviderCard(provider: provider,
                         settings: settings,
                         now: now,
                         isExpanded: expanded.contains(provider.providerId),
                         onToggle: { toggle(provider.providerId) })
        }
        HistoryChartView(history: payload.history, snapshot: payload.snapshot, settings: settings, now: now)
        DashboardFooter(payload: payload, lastFetched: lastFetched, errorText: errorText, now: now)
    }

    private func toggle(_ id: String) {
        if expanded.contains(id) {
            expanded.remove(id)
        } else {
            expanded.insert(id)
        }
    }
}

// MARK: - Provider card

/// Port of app.js `statusOf()`: dot colour, tooltip text and the header line shown instead of "updated Ns ago".
struct ProviderStatusInfo {
    let color: Color
    let title: String
    let headerLine: String
    let isStaleLine: Bool
    let needsAuthRow: Bool
    let isError: Bool

    init(provider: ProviderSnapshot, now: Date) {
        let msg = provider.errorMessage ?? ""
        let updated: String
        if let d = provider.updatedDate {
            updated = "updated " + Formatting.relativeAgo(d, now: now)
        } else {
            updated = "not updated yet"
        }
        let noWindows = provider.windowList.isEmpty
        switch provider.statusKind {
        case .authRequired:
            color = Theme.statusError
            title = msg.isEmpty ? "Sign-in required" : msg
            headerLine = updated
            isStaleLine = false
            needsAuthRow = true
            isError = false
        case .error:
            color = Theme.statusError
            title = msg.isEmpty ? "Could not fetch usage" : msg
            headerLine = updated
            isStaleLine = false
            needsAuthRow = true
            isError = true
        case .stale:
            color = Theme.statusStale
            let ago = provider.updatedDate != nil ? updated : "no successful fetch yet"
            title = msg.isEmpty ? "Showing last good values — \(ago)" : "\(msg) — showing last good values (\(ago))"
            headerLine = msg.isEmpty ? "Last good values · \(ago)" : msg
            isStaleLine = true
            needsAuthRow = noWindows
            isError = false
        case .ok:
            color = Theme.statusOk
            title = "Up to date"
            headerLine = updated
            isStaleLine = false
            needsAuthRow = false
            isError = false
        }
    }
}

struct ProviderCard: View {
    let provider: ProviderSnapshot
    let settings: EffectiveSettings
    let now: Date
    let isExpanded: Bool
    let onToggle: () -> Void

    private var status: ProviderStatusInfo { return ProviderStatusInfo(provider: provider, now: now) }
    private var windows: [UsageWindow] { return provider.windowList }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if windows.isEmpty && !status.needsAuthRow {
                Text("No usage windows reported")
                    .font(.caption)
                    .italic()
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(windows.enumerated()), id: \.offset) { item in
                UsageRowView(window: item.element, settings: settings, now: now)
            }
            if status.needsAuthRow {
                AuthRow(provider: provider, status: status)
            }
            if isExpanded && provider.hasDetails {
                DetailsWell(provider: provider, settings: settings, now: now)
            }
        }
        .padding(12)
        .background(Theme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var header: some View {
        HStack(spacing: 8) {
            ProviderMark(providerId: provider.providerId)
            Text(provider.displayName)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            if let plan = provider.plan, !plan.isEmpty {
                Chip(text: plan, hue: Theme.providerHue(provider.providerId))
            }
            StatusDot(color: status.color)
                .accessibilityLabel(status.title)
            Spacer(minLength: 4)
            Text(status.headerLine)
                .monospacedDigit()
                .font(.system(size: status.isStaleLine ? 9 : 10))
                .foregroundStyle(status.isStaleLine ? Theme.warnText : Color.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            if provider.hasDetails {
                Button(action: onToggle) {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isExpanded ? "Hide details" : "Show details")
            }
        }
    }
}

// MARK: - Usage row

struct UsageRowView: View {
    let window: UsageWindow
    let settings: EffectiveSettings
    let now: Date

    private var level: ThresholdLevel { return Formatting.rowLevel(window, settings: settings) }
    private var clamped: Double { return Formatting.clampPercent(window.percent) }
    private var gradient: BarGradient { return Theme.barGradient(token: window.colorToken, level: level) }
    private var resetDate: Date? { return window.resetsAtDate }
    private var resetsInText: String { return Formatting.resetsIn(resetsAt: resetDate, percent: window.percent, now: now) }
    private var resetsInDim: Bool { return resetsInText == "Not started" || resetsInText == "—" }
    private var resetsAtText: String {
        return Formatting.resetsAt(resetDate,
                                   isWeekly: Formatting.isWeeklyWindow(window, now: now),
                                   timeFormat: settings.timeFormat,
                                   dateFormat: settings.dateFormat)
    }
    private var elapsed: Double? {
        return Formatting.elapsedFraction(resetsAt: resetDate, windowSeconds: window.windowSeconds, now: now)
    }
    private var showRing: Bool { return (window.windowSeconds ?? 0) > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(window.displayLabel.uppercased())
                    .font(.system(size: 11, weight: .semibold))
                    .kerning(0.5)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 6)
                Text(resetsInText)
                    .monospacedDigit()
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(resetsInDim ? Color.secondary.opacity(0.7) : Color.primary)
                Text("·")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                Text(resetsAtText)
                    .monospacedDigit()
                    .font(.system(size: 11))
                    .foregroundStyle(resetDate == nil ? Color.secondary.opacity(0.6) : Color.secondary)
            }
            HStack(spacing: 8) {
                GradientBar(fraction: clamped / 100.0, gradient: gradient, height: 6)
                Text(Formatting.percentText(window.percent))
                    .monospacedDigit()
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(level == .danger ? Theme.dangerText : Color.primary)
                    .frame(width: 44, alignment: .trailing)
                if showRing {
                    ElapsedRing(fraction: elapsed ?? 0,
                                color: Theme.ringColor(token: window.colorToken, elapsedPercent: (elapsed ?? 0) * 100),
                                size: 18)
                }
            }
            if let note = window.note, !note.isEmpty {
                Text(note)
                    .font(.system(size: 10))
                    .italic()
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
        }
    }
}

// MARK: - Auth / error row

struct AuthRow: View {
    let provider: ProviderSnapshot
    let status: ProviderStatusInfo

    private var message: String {
        if let m = provider.errorMessage { return m }
        switch provider.statusKind {
        case .authRequired: return "Sign-in required"
        case .stale: return "Showing last good values"
        default: return "Could not fetch usage"
        }
    }

    private var hint: String {
        switch provider.source ?? "" {
        case "claude_web":
            return "Sign in again on the desktop widget (Settings ▸ Claude source ▸ Log in)."
        case "claude_code":
            return "Run any Claude Code command on the desktop to refresh the token."
        case "codex_auth_file":
            return "Sign in to Codex with ChatGPT on the desktop (codex login)."
        default:
            return "Fix this on the desktop — the phone only mirrors what the desktop sees."
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(status.isError ? Theme.statusError : Theme.statusStale)
            VStack(alignment: .leading, spacing: 2) {
                Text(message)
                    .font(.system(size: 12, weight: .semibold))
                Text(hint)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Expand well

struct DetailsWell: View {
    let provider: ProviderSnapshot
    let settings: EffectiveSettings
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let extra = provider.extra {
                ExtraUsageRow(extra: extra, settings: settings, now: now)
            }
            if let credits = provider.credits {
                CreditsRow(credits: credits, settings: settings)
            }
        }
        .padding(8)
        .background(Theme.wellBackground)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

/// Port of app.js `renderExtraRow()`.
struct ExtraUsageRow: View {
    let extra: ExtraUsage
    let settings: EffectiveSettings
    let now: Date

    static let creditExpiryWarnDays = 21
    static let creditExpiryDangerDays = 7

    private var currency: String { return extra.currency ?? "USD" }
    private var exponent: Int { return extra.exponent ?? 2 }

    private func money(_ minor: Double?, strip: Bool = false) -> String? {
        return Formatting.formatCurrency(minor: minor, currency: currency, exponent: exponent, stripWholeCents: strip)
    }

    private var used: Double? {
        if let u = extra.usedMinor, u.isFinite { return u }
        return nil
    }

    private var limit: Double? {
        if let l = extra.limitMinor, l.isFinite, l > 0 { return l }
        return nil
    }

    private var pct: Double? {
        if let p = extra.percent, p.isFinite { return p }
        if let u = used, let l = limit { return u / l * 100.0 }
        return nil
    }

    private var level: ThresholdLevel {
        guard pct != nil, limit != nil else { return .normal }
        return Formatting.thresholdLevel(percent: pct, warn: settings.warnThreshold, danger: settings.dangerThreshold)
    }

    private var gradient: BarGradient {
        switch level {
        case .normal: return Theme.spendGradient
        case .warning: return Theme.warningGradient
        case .danger: return Theme.dangerGradient
        }
    }

    private var valueText: String {
        if limit != nil { return Formatting.percentText(pct ?? 0) }
        if let u = used, let s = money(u) { return s }
        if let p = pct { return "\(Int(p.rounded()))%" }
        return "—"
    }

    private var capText: String {
        if let l = limit {
            let cap = money(l, strip: true) ?? ""
            if let u = used, let us = money(u) { return "\(us) / \(cap)" }
            return "/ \(cap)"
        }
        if used != nil { return "no cap" }
        if pct != nil { return "" }
        return extra.disabledReason ?? ""
    }

    private var splitText: String? {
        let promo: Double? = (extra.promoMinor?.isFinite == true) ? extra.promoMinor : nil
        let paid: Double? = (extra.paidMinor?.isFinite == true) ? extra.paidMinor : nil
        if let p = promo, let q = paid, (p > 0 || q > 0), let ps = money(p), let qs = money(q) {
            return "promo \(ps) / paid \(qs)"
        }
        if let p = promo, p > 0, let ps = money(p) { return "promo \(ps)" }
        if let q = paid, q > 0, let qs = money(q) { return "paid \(qs)" }
        return nil
    }

    private var expiryInfo: (text: String, level: ThresholdLevel)? {
        guard let expDate = Formatting.parseISO(extra.nextExpiresAt) else { return nil }
        let expMinor: Double? = (extra.nextExpiryMinor?.isFinite == true) ? extra.nextExpiryMinor : nil
        if let m = expMinor, m <= 0 { return nil }
        let days = Formatting.daysUntil(expDate, now: now)
        let soon = days <= ExtraUsageRow.creditExpiryWarnDays
        let level: ThresholdLevel = days <= ExtraUsageRow.creditExpiryDangerDays ? .danger : (soon ? .warning : .normal)
        let amount: String? = expMinor.flatMap { money($0) }
        let subject: String = amount.map { "\($0) " } ?? "Credits "
        let verb = amount != nil ? "expires" : "expire"
        let when = soon ? "in \(max(0, days))d" : Formatting.formatDate(expDate, dateFormat: "date")
        return (text: "\(subject)\(verb) \(when)", level: level)
    }

    private func expiryColor(_ level: ThresholdLevel) -> Color {
        switch level {
        case .danger: return Theme.dangerText
        case .warning: return Theme.warnText
        case .normal: return Color.secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if let enabled = extra.enabled {
                    Chip(text: enabled ? "ON" : "OFF", hue: enabled ? Theme.chipOn : Theme.chipOff)
                }
                Text("EXTRA USAGE")
                    .font(.system(size: 10, weight: .semibold))
                    .kerning(0.5)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                GradientBar(fraction: Formatting.clampPercent(pct) / 100.0, gradient: gradient, height: 6)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(valueText)
                        .monospacedDigit()
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(level == .danger ? Theme.dangerText : Color.primary)
                    if !capText.isEmpty {
                        Text(capText)
                            .monospacedDigit()
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            if let bal = extra.balanceMinor, bal.isFinite {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("Account Credits")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Text(money(bal) ?? "—")
                        .monospacedDigit()
                        .font(.system(size: 11, weight: .semibold))
                    if let split = splitText {
                        Text(split)
                            .monospacedDigit()
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    if let exp = expiryInfo {
                        Text(exp.text)
                            .monospacedDigit()
                            .font(.system(size: 10))
                            .foregroundStyle(expiryColor(exp.level))
                            .lineLimit(1)
                    }
                }
            }
        }
    }
}

/// Port of app.js `renderCreditsRow()` (Codex).
struct CreditsRow: View {
    let credits: CodexCredits
    let settings: EffectiveSettings

    static let maxChips = 3

    private var creditValue: String {
        if credits.unlimited == true { return "Unlimited" }
        if credits.hasCredits == true, let b = credits.balance, b.isFinite {
            return "\(Formatting.formatNumber(b)) credits"
        }
        if credits.hasCredits == true { return "Available" }
        return "No credits"
    }

    private var creditIsMuted: Bool {
        return !(credits.unlimited == true || credits.hasCredits == true)
    }

    private var extras: [String] {
        var out: [String] = []
        if let n = credits.approxLocalMessages, n.isFinite { out.append("~\(Int(n)) local messages") }
        if let n = credits.approxCloudMessages, n.isFinite { out.append("~\(Int(n)) cloud messages") }
        if let n = credits.resetCreditsAvailable, n.isFinite, n > 0 { out.append("\(Int(n)) reset credits available") }
        if credits.overageLimitReached == true { out.append("Overage limit reached") }
        return out
    }

    private var reached: Bool { return credits.limitReached == true }
    private var reachedDetail: String? {
        guard reached, let t = credits.limitReachedType, !t.isEmpty else { return nil }
        return t.replacingOccurrences(of: "_", with: " ")
    }
    private var models: [String] { return credits.modelNames }

    private func modelChip(_ name: String) -> Chip {
        let m: ModelAvailability? = credits.modelUsage?[name]
        let available: Bool = m?.available != false
        var statusText = available ? "available" : "unavailable"
        if !available, let at = Formatting.parseISO(m?.availableAt) {
            statusText = "until \(Formatting.formatTime(at, timeFormat: settings.timeFormat))"
        }
        return Chip(text: "\(name) · \(statusText)", hue: available ? Theme.chipOn : Theme.chipAmber, showDot: true)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("CREDITS")
                    .font(.system(size: 10, weight: .semibold))
                    .kerning(0.5)
                    .foregroundStyle(.secondary)
                Text(creditValue)
                    .monospacedDigit()
                    .font(.system(size: 11, weight: creditIsMuted ? .regular : .semibold))
                    .foregroundStyle(creditIsMuted ? Color.secondary : Color.primary)
                Text("·")
                    .foregroundStyle(.tertiary)
                Text("Limit reached")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Text(reached ? "Yes" : "No")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(reached ? Theme.warnText : Color.primary)
                Spacer(minLength: 0)
            }
            if let detail = reachedDetail {
                Text(detail)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.warnText)
            }
            if !extras.isEmpty {
                Text(extras.joined(separator: " · "))
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
            if !models.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(models.prefix(CreditsRow.maxChips)), id: \.self) { name in
                            modelChip(name)
                        }
                        if models.count > CreditsRow.maxChips {
                            Chip(text: "+\(models.count - CreditsRow.maxChips)", hue: Theme.chipSlate)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Footer, waiting & message cards

struct DashboardFooter: View {
    let payload: PhonePayload
    let lastFetched: Date?
    let errorText: String?
    let now: Date

    private var freshness: Freshness { return Formatting.freshness(generatedAt: payload.generatedDate, now: now) }

    private var updatedLine: String {
        var s: String
        if let g = payload.generatedDate {
            s = "Updated " + Formatting.relativeAgo(g, now: now)
        } else {
            s = "Updated — (no timestamp in payload)"
        }
        if let host = payload.source?.host, !host.isEmpty { s += " on \(host)" }
        return s
    }

    private var sourceLine: String? {
        var parts: [String] = []
        if let f = lastFetched { parts.append("fetched \(Formatting.relativeAgo(f, now: now))") }
        if let v = payload.source?.version, !v.isEmpty { parts.append("desktop v\(v)") }
        if let p = payload.source?.platform, !p.isEmpty { parts.append(p) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                StatusDot(color: Theme.freshnessColor(freshness))
                Text(updatedLine)
                    .monospacedDigit()
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let s = sourceLine {
                Text(s)
                    .monospacedDigit()
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if let e = errorText {
                Label(e, systemImage: "exclamationmark.circle")
                    .font(.caption2)
                    .foregroundStyle(Theme.dangerText)
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 4)
    }
}

struct WaitingCard: View {
    let errorText: String?
    let isRefreshing: Bool

    var body: some View {
        VStack(spacing: 10) {
            if let e = errorText {
                Image(systemName: "icloud.slash")
                    .font(.system(size: 28))
                    .foregroundStyle(.secondary)
                Text(e)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Text("Pull down to try again.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            } else {
                ProgressView()
                Text(isRefreshing ? "Fetching the latest snapshot from the relay…" : "Waiting for the first snapshot…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .background(Theme.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct MessageCard: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(16)
            .background(Theme.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
