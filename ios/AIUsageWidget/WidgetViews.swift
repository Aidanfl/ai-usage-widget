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

/// Payload-age dot + "Updated 4m ago"; the one place the widget admits how old its numbers are.
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

// MARK: - Cross-provider urgency (the "headline" every family leads with)

extension UsageWidgetRow {
    /// 2 = danger/blocked, 1 = warning, 0 = normal. Used only for ranking.
    fileprivate var urgencyLevelRank: Int {
        switch level {
        case .danger: return 2
        case .warning: return 1
        case .normal: return 0
        }
    }
}

extension UsageWidgetModel {
    /// The single most urgent row across EVERY provider — not just Claude's.
    ///
    /// Order: worst threshold level, then highest percent, then the row that stays locked
    /// the longest (two rows both pinned at 100% are not equally bad — the one that frees
    /// up in four days hurts more than the one that frees up in two), then payload order.
    var urgentRow: UsageWidgetRow? {
        let rows = allRows
        guard let first = rows.first else { return nil }
        var best = first
        var bestKey = urgencyKey(first, index: 0)
        for (index, row) in rows.enumerated() where index > 0 {
            let key = urgencyKey(row, index: index)
            if key > bestKey {
                best = row
                bestKey = key
            }
        }
        return best
    }

    private func urgencyKey(_ row: UsageWidgetRow, index: Int) -> (Int, Double, Double, Int) {
        let remaining = row.window.resetsAtDate.map { $0.timeIntervalSince(now) } ?? 0
        return (row.urgencyLevelRank,
                Formatting.clampPercent(row.window.percent),
                max(0, remaining),
                -index)
    }

    /// Which rows survive when a family cannot show them all.
    ///
    /// NOT `prefix(limit)`: the payload orders windows session → weekly → scoped, so taking the
    /// first N is exactly how you lose a provider's 100% row (Codex's weekly sits behind its 5h
    /// window). Rank by severity first, then by "is this the window I am burning right now",
    /// then by magnitude — and put the survivors back into payload order so the list still
    /// reads in its natural sequence.
    func keepMostUrgent(_ rows: [UsageWidgetRow], limit: Int) -> [UsageWidgetRow] {
        guard limit > 0 else { return [] }
        guard rows.count > limit else { return rows }
        let ranked = rows.enumerated().sorted {
            retentionKey($0.element, index: $0.offset) > retentionKey($1.element, index: $1.offset)
        }
        let keep = Set(ranked.prefix(limit).map { $0.offset })
        return rows.enumerated().filter { keep.contains($0.offset) }.map { $0.element }
    }

    private func retentionKey(_ row: UsageWidgetRow, index: Int) -> (Int, Int, Double, Double, Int) {
        let remaining = row.window.resetsAtDate.map { $0.timeIntervalSince(now) } ?? 0
        return (row.urgencyLevelRank,
                (row.window.isActive == true) ? 1 : 0,
                Formatting.clampPercent(row.window.percent),
                max(0, remaining),
                -index)
    }
}

// MARK: - Line budgeting (every family has a hard line count, so decide it once)

enum WidgetRowBudget {
    /// Trim per-provider line counts down to `total`, keeping at least one line for every
    /// provider (both providers must always be visible) and handing the remainder to
    /// whichever provider still has the most left to show.
    ///
    ///   allocate([3, 1], total: 4) -> [3, 1]      (Aidan's real payload: nothing is dropped)
    ///   allocate([4, 2], total: 4) -> [3, 1]
    ///   allocate([3, 3], total: 4) -> [2, 2]
    static func allocate(_ wanted: [Int], total: Int) -> [Int] {
        guard !wanted.isEmpty else { return [] }
        if total <= 0 { return wanted.map { _ in 0 } }
        if wanted.reduce(0, +) <= total { return wanted }

        var out = [Int](repeating: 0, count: wanted.count)
        var left = total
        for i in wanted.indices where left > 0 && wanted[i] > 0 {
            out[i] = 1
            left -= 1
        }
        while left > 0 {
            var pick = -1
            var deficit = 0
            for i in wanted.indices where wanted[i] - out[i] > deficit {
                deficit = wanted[i] - out[i]
                pick = i
            }
            if pick < 0 { break }
            out[pick] += 1
            left -= 1
        }
        return out
    }
}

/// What one provider is allowed to show in a given family.
struct ProviderBlockPlan: Identifiable {
    let id: Int
    let provider: ProviderSnapshot
    let rows: [UsageWidgetRow]
    let hidden: Int

    /// Shown instead of bars when the provider reported no windows at all.
    var note: String? {
        guard rows.isEmpty else { return nil }
        return provider.errorMessage ?? "No usage windows"
    }

    /// The same fact in the ~14 characters systemSmall can actually fit. A real relay error
    /// message ("Sign in to Codex on the desktop") is 150pt wide at 9pt and would ellipsise
    /// into nonsense in a 112pt slot, so small states the KIND of problem and large states it
    /// in full.
    var shortNote: String? {
        guard rows.isEmpty else { return nil }
        switch provider.statusKind {
        case .authRequired: return "Sign in needed"
        case .error: return "Unavailable"
        case .stale: return "Stale data"
        case .ok: return "No windows"
        }
    }
}

enum WidgetPlanner {
    static func blocks(model: UsageWidgetModel, maxProviders: Int, totalRows: Int) -> [ProviderBlockPlan] {
        let providers = Array(model.providers.prefix(maxProviders))
        let perProvider = providers.map { model.rows(for: $0) }
        // A provider with zero windows still needs one line for its error / empty note.
        let wanted = perProvider.map { max(1, $0.count) }
        let allocation = WidgetRowBudget.allocate(wanted, total: totalRows)
        var out: [ProviderBlockPlan] = []
        for (index, provider) in providers.enumerated() {
            let available = perProvider[index]
            let take = max(0, min(allocation[index], available.count))
            out.append(ProviderBlockPlan(id: index,
                                         provider: provider,
                                         rows: model.keepMostUrgent(available, limit: take),
                                         hidden: available.count - take))
        }
        return out
    }
}

// MARK: - Row + header components

/// Provider header for the medium / large blocks: mark, name, plan badge, status dot, and one
/// line of trailing context. The trailing slot is free real estate on a 306pt row, so it carries
/// the most useful thing available: the error that explains bad numbers, else pay-as-you-go
/// headroom (the actual answer to "I'm at 100%, now what?"), else the per-provider update stamp.
struct BlockProviderHeader: View {
    let provider: ProviderSnapshot
    var showPlan: Bool = true
    var hidden: Int = 0
    var trailing: String? = nil

    var body: some View {
        HStack(spacing: 5) {
            ProviderMark(providerId: provider.providerId, size: 12)
            Text(provider.displayName)
                .font(.system(size: 11, weight: .semibold))
                .lineLimit(1)
                .layoutPriority(2)
            if showPlan, let plan = provider.plan, !plan.isEmpty {
                Chip(text: plan, hue: Theme.providerHue(provider.providerId))
                    .layoutPriority(1)
            }
            StatusDot(color: Theme.statusColor(provider.statusKind), size: 6)
            if hidden > 0 {
                Text("+\(hidden)")
                    .monospacedDigit()
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 6)
            if let trailing = trailing, !trailing.isEmpty {
                Text(trailing)
                    .monospacedDigit()
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(-1)
            }
        }
    }
}

enum ProviderContext {
    /// One short line of "anything else I need to know about this provider".
    /// `includeError` is false when the block is already printing the error on its own line,
    /// so the message is never shown twice in the same card.
    static func detail(_ provider: ProviderSnapshot, now: Date, includeError: Bool = true) -> String? {
        if includeError, provider.statusKind != .ok, let message = provider.errorMessage { return message }

        if let extra = provider.extra, extra.enabled == true {
            let used = Formatting.formatCurrency(minor: extra.usedMinor, currency: extra.currency,
                                                 exponent: extra.exponent, stripWholeCents: true)
            let left = Formatting.formatCurrency(minor: extra.balanceMinor, currency: extra.currency,
                                                 exponent: extra.exponent, stripWholeCents: true)
            if let used = used, let left = left { return "extra \(used) used · \(left) left" }
            if let used = used { return "extra \(used) used" }
            if let left = left { return "extra \(left) left" }
        }

        if let credits = provider.credits {
            if credits.unlimited == true { return "credits: no cap" }
            if let balance = credits.balance, balance.isFinite, balance > 0 {
                return "credits \(Formatting.formatNumber(balance))"
            }
            if credits.hasCredits == false { return "no credits" }
        }

        if let updated = provider.updatedDate { return "updated " + Formatting.relativeAgo(updated, now: now) }
        return nil
    }
}

/// One usage line at systemSMALL width (126pt of content).
///
/// The fixed-width-text-label row shape cannot survive here: "FABLE 7D" alone measures 47.3pt
/// of a 126pt box, which is why today's medium truncates it to "FABLE...". So the provider moves
/// out of the text and into a coloured mark (shape + hue, not hue alone), and the window keeps
/// only the part that distinguishes it from its sibling.
struct CompactUsageRow: View {
    let providerId: String
    let row: UsageWidgetRow
    /// 126 - mark 10 - 3 - tag 34 - 3 - 3 - percent 34 = 39pt of bar. Measured: "FABLE" is
    /// 30.3pt at 9pt semibold and "100%" is 31.0pt at 10pt bold monospaced, so neither
    /// fixed column truncates or wraps.
    var tagWidth: CGFloat = 34
    var percentWidth: CGFloat = 34

    /// "5H" / "7D" — or the scope ("FABLE"), because the scope is the only thing that tells
    /// Claude's two 7D rows apart, and it fits where "FABLE 7D" does not.
    private var tag: String {
        if row.window.kind == "weekly_scoped", let scope = row.window.scope, !scope.isEmpty {
            return scope.uppercased()
        }
        let short = row.shortLabel
        return short.isEmpty ? row.window.displayLabel.uppercased() : short
    }

    var body: some View {
        HStack(spacing: 3) {
            ProviderMark(providerId: providerId, size: 10)
            Text(tag)
                .font(.system(size: 9, weight: .semibold))
                .kerning(0.15)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: tagWidth, alignment: .leading)
            GradientBar(fraction: row.fraction, gradient: row.gradient, height: 5, glow: false)
            Text(row.percentText)
                .monospacedDigit()
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(row.level == .danger ? Theme.dangerText : Color.primary)
                .lineLimit(1)
                .frame(width: percentWidth, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.providerName) \(row.window.displayLabel), \(row.percentText), resets in \(row.resetsIn)")
    }
}

/// One usage line at systemMEDIUM width (306pt of content): the full window LABEL, the bar,
/// the percentage and a right-aligned "time left · reset stamp" column — everything today's
/// two-line LargeRow shows, folded onto ONE line. That fold is where the 47% vertical cut
/// from large to medium is paid for.
struct DetailUsageRow: View {
    let row: UsageWidgetRow
    let settings: EffectiveSettings
    let now: Date
    /// 306 - label 96 - 6 - 6 - percent 36 - 6 - meta 86 = 70pt of bar.
    var labelWidth: CGFloat = 96
    var percentWidth: CGFloat = 36
    var metaWidth: CGFloat = 86

    /// Weekly windows show the reset DAY ("Sep 14"); session windows show the reset CLOCK
    /// ("6:01 AM"). A 7-day window's minute-of-day is noise, and the full "Sep 14, 11:50 AM"
    /// costs 82pt that the bar needs. Large still shows the whole stamp.
    /// A window already past its reset shows nothing here — the stamp is in the past, and
    /// "Resetting..." needs the whole column.
    private var stamp: String? {
        guard let date = row.window.resetsAtDate, date > now else { return nil }
        if Formatting.isWeeklyWindow(row.window, now: nil) {
            return Formatting.formatDate(date, dateFormat: "date", timeFormat: settings.timeFormat)
        }
        return Formatting.formatTime(date, timeFormat: settings.timeFormat)
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(row.window.displayLabel.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .kerning(0.3)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: labelWidth, alignment: .leading)
            GradientBar(fraction: row.fraction, gradient: row.gradient, height: 5, glow: false)
            Text(row.percentText)
                .monospacedDigit()
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(row.level == .danger ? Theme.dangerText : Color.primary)
                .lineLimit(1)
                .frame(width: percentWidth, alignment: .trailing)
            HStack(spacing: 4) {
                Text(row.resetsIn)
                    .monospacedDigit()
                    .font(.system(size: 10, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.9)
                if let stamp = stamp {
                    Text(stamp)
                        .monospacedDigit()
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.9)
                }
            }
            .frame(width: metaWidth, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.window.displayLabel), \(row.percentText), \(row.resetsIn) left, resets \(row.resetsAt)")
    }
}

/// Two-line usage row: LABEL / time left / reset stamp above, bar + percentage below.
/// Only systemLarge can still afford it (28.3pt each).
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

/// The headline, given real presence: the one number that is worst across BOTH providers,
/// named, timed, and drawn on a full-width 8pt bar. Nothing else in the widget ranks the
/// providers against each other, so this is the only place the answer to "what is actually
/// blocking me right now" is stated once.
struct UrgencyBanner: View {
    let row: UsageWidgetRow
    let settings: EffectiveSettings

    private var when: String {
        let stamp = row.resetsAt
        if stamp.isEmpty || stamp == "—" { return row.resetsIn }
        return "\(row.resetsIn) left · resets \(stamp)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                Text(row.percentText)
                    .monospacedDigit()
                    .font(.system(size: 36, weight: .bold, design: .rounded))
                    .foregroundStyle(row.level == .danger ? Theme.dangerText : Color.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 1) {
                    HStack(spacing: 4) {
                        ProviderMark(providerId: row.providerId, size: 11)
                        // Named exactly as the provider block below names it, so the banner
                        // reads as a pointer into the list rather than a fifth number.
                        Text("\(row.providerName.uppercased()) · \(row.window.displayLabel.uppercased())")
                            .font(.system(size: 11, weight: .semibold))
                            .kerning(0.3)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    Text(when)
                        .monospacedDigit()
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            GradientBar(fraction: row.fraction, gradient: row.gradient, height: 8, glow: false)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.wellBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Most urgent: \(row.providerName) \(row.window.displayLabel), \(row.percentText), \(when)")
    }
}

// MARK: - systemSmall  (126 x 126pt of content)
//
// Carries what systemMedium carried before: BOTH providers, every Claude row and Codex's row,
// as label + bar + percent, plus a freshness indication — under a Philosophy-C headline.

struct SmallWidgetView: View {
    let model: UsageWidgetModel

    /// Four usage lines is the hard ceiling at 126pt tall once the headline is paid for.
    private static let maxLines = 4

    private var blocks: [ProviderBlockPlan] {
        return WidgetPlanner.blocks(model: model, maxProviders: 3, totalRows: SmallWidgetView.maxLines)
    }
    private var headline: UsageWidgetRow? { return model.urgentRow }
    private var headlineIsDanger: Bool { return headline.map { $0.level == .danger } ?? false }
    private var hidden: Int { return blocks.reduce(0) { $0 + $1.hidden } }

    /// "CODEX 7D · 4d 1h" — compactLabel already resolves scoped windows to "FABLE 7D",
    /// so the headline never says "CLAUDE FABLE WEEKLY".
    private var caption: String {
        guard let headline = headline else { return "NO USAGE DATA" }
        let left = headline.resetsIn
        return left.isEmpty ? headline.compactLabel : "\(headline.compactLabel) · \(left)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Exactly ONE dot on this family — payload freshness. The provider status dot that
            // used to sit beside it (and read as a rendering glitch) is gone; a provider that is
            // not OK now says so in words on its own line instead.
            HStack(spacing: 4) {
                StatusDot(color: Theme.freshnessColor(model.freshness), size: 5)
                Text(caption)
                    .font(.system(size: 9, weight: .semibold))
                    .kerning(0.2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 2)
                if hidden > 0 {
                    Text("+\(hidden)")
                        .monospacedDigit()
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.tertiary)
                }
            }
            Text(headline?.percentText ?? "—")
                .monospacedDigit()
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(headlineIsDanger ? Theme.dangerText : Color.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)

            Spacer(minLength: 4)

            VStack(alignment: .leading, spacing: 4) {
                if blocks.isEmpty {
                    Text("No providers in the last snapshot")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                ForEach(blocks) { block in
                    if let note = block.shortNote {
                        HStack(spacing: 4) {
                            ProviderMark(providerId: block.provider.providerId, size: 10)
                            Text(note)
                                .font(.system(size: 9))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                    }
                    ForEach(Array(block.rows.enumerated()), id: \.offset) { item in
                        CompactUsageRow(providerId: block.provider.providerId, row: item.element)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - systemMedium  (306 x 126pt of content)
//
// Carries what systemLarge carried before: per-provider blocks with a header and plan badge,
// each row showing LABEL / time left / reset stamp / bar / percentage, plus the "Updated …" line.
// The two side-by-side columns are gone — they were what forced "FABLE..." — and every row is
// folded from two lines onto one, which is the entire 236pt -> 126pt saving.

struct MediumWidgetView: View {
    let model: UsageWidgetModel

    private var providerCount: Int { return min(3, model.providers.count) }

    /// 126pt - freshness (11) - gaps ≈ 111pt, minus 20pt of header per provider.
    private var rowCap: Int {
        switch providerCount {
        case 0, 1: return 5
        case 2: return 4
        default: return 3
        }
    }

    private var blocks: [ProviderBlockPlan] {
        return WidgetPlanner.blocks(model: model, maxProviders: 3, totalRows: rowCap)
    }

    var body: some View {
        // spacing: 0 on purpose — an outer VStack spacing would also be charged between the
        // last block, the Spacer and the freshness line, which is 14pt this family cannot spare.
        VStack(alignment: .leading, spacing: 0) {
            if blocks.isEmpty {
                Text("No providers in the last snapshot")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            ForEach(blocks) { block in
                VStack(alignment: .leading, spacing: 3) {
                    // The plan badge is the first thing to go if a third provider ever shows up:
                    // three 16pt headers plus three rows is 124 of the 126pt box.
                    BlockProviderHeader(provider: block.provider,
                                        showPlan: providerCount <= 2,
                                        hidden: block.hidden,
                                        trailing: ProviderContext.detail(block.provider, now: model.now,
                                                                         includeError: block.note == nil))
                    if let note = block.note {
                        Text(note)
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    ForEach(Array(block.rows.enumerated()), id: \.offset) { item in
                        DetailUsageRow(row: item.element, settings: model.settings, now: model.now)
                    }
                }
                .padding(.top, block.id == 0 ? 0 : 6)
            }
            Spacer(minLength: 4)
            WidgetFreshnessLine(model: model, showHost: false)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - systemLarge  (306 x 322pt of content)
//
// The headline gets real presence at the top, the per-provider blocks keep the full two-line row
// (the only family that can still afford the exact reset minute), and the 85.7pt of dead bottom
// third is spent rather than left: ~77pt on the banner, the rest on wider row spacing.

struct LargeWidgetView: View {
    let model: UsageWidgetModel

    private var blocks: [ProviderBlockPlan] {
        return WidgetPlanner.blocks(model: model, maxProviders: 4, totalRows: 8)
    }
    private var shownRows: Int { return blocks.reduce(0) { $0 + $1.rows.count } }

    /// Tall two-line rows while they fit; a busier payload silently falls back to medium's
    /// one-line row rather than clipping off the bottom of the widget.
    private var useTallRows: Bool { return shownRows <= 4 && blocks.count <= 2 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let headline = model.urgentRow {
                UrgencyBanner(row: headline, settings: model.settings)
            }
            if blocks.isEmpty {
                Text("No providers in the last snapshot")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            // One Spacer above every card and one above the freshness line: whatever the
            // payload does not use is split evenly between them, so a sparse payload reads as
            // an airy layout instead of a widget with a dead bottom third.
            ForEach(blocks) { block in
                Spacer(minLength: 8)
                VStack(alignment: .leading, spacing: useTallRows ? 6 : 3) {
                    BlockProviderHeader(provider: block.provider,
                                        showPlan: true,
                                        hidden: block.hidden,
                                        trailing: ProviderContext.detail(block.provider, now: model.now,
                                                                         includeError: block.note == nil))
                    if let note = block.note {
                        Text(note)
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    ForEach(Array(block.rows.enumerated()), id: \.offset) { item in
                        if useTallRows {
                            LargeRow(row: item.element)
                        } else {
                            DetailUsageRow(row: item.element, settings: model.settings, now: model.now)
                        }
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.wellBackground)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            Spacer(minLength: 8)
            WidgetFreshnessLine(model: model, showHost: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
