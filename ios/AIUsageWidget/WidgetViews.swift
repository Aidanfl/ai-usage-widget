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
    let compactLabel: String        // "CLAUDE 5H"; "C2 5H" for a Claude account in multi-account mode
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
    /// Every Claude account in the payload, in slot order (account 1 is `claude`).
    let claudeAccounts: [ProviderSnapshot]
    /// "C2" per Claude account id — filled only in multi-account mode (`AccountShortNames`).
    let shortNames: [String: String]
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
        self.claudeAccounts = self.providers.filter { $0.isClaude }
        self.shortNames = self.claudeAccounts.count > 1 ? AccountShortNames.assign(self.claudeAccounts) : [:]
        self.generatedDate = payload.generatedDate
        self.freshness = Formatting.freshness(generatedAt: payload.generatedDate, now: now)
        let h = payload.source?.host ?? ""
        self.host = h.isEmpty ? nil : h
    }

    /// More than one Claude account (desktop 1.1.0+): every family switches to a per-account layout.
    /// With one account — every 1.0.x desktop, and most people — each family renders exactly as before.
    var isMultiAccount: Bool { return claudeAccounts.count > 1 }

    /// The first Claude account: `claude` unless account 1 is hidden on the desktop.
    var claude: ProviderSnapshot? { return claudeAccounts.first }
    var codex: ProviderSnapshot? { return providers.first { $0.providerId == ProviderIds.codex } }

    /// "C2" in multi-account mode, else the provider's own name.
    func shortName(for provider: ProviderSnapshot) -> String {
        return shortNames[provider.providerId] ?? provider.displayName
    }

    /// "C2 7D" / "C2 FABLE": an account's line label where the full compact label ("C2 FABLE 7D")
    /// does not fit — the small widget's tag column and the lock screen's 58pt label.
    func accountTag(for provider: ProviderSnapshot, row: UsageWidgetRow) -> String {
        return "\(shortName(for: provider)) \(row.windowTag)"
    }

    /// Single-account mode: the one Claude account's short name when the desktop calls it anything but
    /// the bare "Claude" — "PERS" for an account labelled "Personal", "C3" when account 3 is the only one
    /// visible of several. Its full compact labels ("PERSONAL 5H", "CLAUDE 3 5H") overflow the lock
    /// screen's 58pt and truncate to the same text on every row. nil for "Claude" (every 1.0.x desktop,
    /// and an unlabelled lone account), which keeps "CLAUDE 5H".
    var singleAccountShortName: String? {
        guard !isMultiAccount, let c = claude, c.displayName != "Claude" else { return nil }
        return AccountShortNames.derive(c.displayName) ?? "C\(ProviderIds.claudeSlot(c.providerId) ?? 1)"
    }

    func rows(for provider: ProviderSnapshot) -> [UsageWidgetRow] {
        return provider.windowList.map { makeRow($0, of: provider) }
    }

    fileprivate func makeRow(_ w: UsageWindow, of provider: ProviderSnapshot) -> UsageWidgetRow {
        let name = provider.displayName
        // Four accounts would otherwise all say "CLAUDE 5H"; the short name is what tells them apart
        // in the small widget's caption.
        let shortName: String? = isMultiAccount && provider.isClaude ? self.shortName(for: provider) : nil
        let level = Formatting.rowLevel(w, settings: settings)
        let short: String
        if w.kind == "weekly_scoped", let scope = w.scope, !scope.isEmpty {
            short = "\(scope) \(Formatting.shortWindowName(w))".trimmingCharacters(in: .whitespaces).uppercased()
        } else {
            let s = Formatting.shortWindowName(w)
            short = s.isEmpty ? w.displayLabel.uppercased() : s
        }
        let reset = w.resetsAtDate
        let compact: String
        if let shortName = shortName {
            // compactLabel with no provider name is just the window part: "5H", "FABLE 7D".
            compact = "\(shortName) \(Formatting.compactLabel(providerName: "", window: w))"
        } else {
            compact = Formatting.compactLabel(providerName: name, window: w)
        }
        return UsageWidgetRow(
            providerId: provider.providerId,
            providerName: name,
            window: w,
            compactLabel: compact,
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

    var allRows: [UsageWidgetRow] {
        return providers.flatMap { rows(for: $0) }
    }

    /// The row the circular widget headlines: Claude's lead window (`leadRow`), else the first row.
    /// "Claude" is the first Claude account, so a hidden account 1 hands the gauge to account 2.
    var headline: UsageWidgetRow? {
        if let c = claude, let lead = leadRow(for: c) { return lead }
        return allRows.first
    }

    /// The one window that speaks for a provider where one is all it gets: its active window, else its
    /// first. With no five-hour window (`weeklyPair`) the weekly leads whichever window the desktop marks
    /// active, so a bare "Claude 42%" is never the Fable share read as the weekly.
    private func leadRow(for provider: ProviderSnapshot) -> UsageWidgetRow? {
        if let pair = weeklyPair(for: provider) { return pair.outer }
        let rows = self.rows(for: provider)
        return rows.first(where: { $0.window.isActive == true }) ?? rows.first
    }

    /// Provider's headline percent for the inline text ("Claude 42%").
    private func headlinePercent(for provider: ProviderSnapshot) -> String? {
        return leadRow(for: provider)?.percentText
    }

    /// The inline widget's pieces: "Claude 42%", "Codex 12%". With several Claude accounts, the accounts in
    /// `accountsByRoom` order and then the others, each by its plain weekly as it stands now ("C4 4%"), one at a
    /// limit by when it frees up ("C1 🔒1d 8h"), one that needs a sign-in as "C2 !". The slot cuts the tail, and the
    /// account to reach for next must not be what it cuts.
    var inlinePieces: [InlinePiece] {
        guard isMultiAccount else {
            return providers.compactMap { p in headlinePercent(for: p).map { InlinePiece(name: p.displayName, value: $0) } }
        }
        let ordered = accountsByRoom + providers.filter { !$0.isClaude }
        return ordered.compactMap { p in
            let name = p.isClaude ? shortName(for: p) : p.displayName
            if !p.hasUsableNumbers { return InlinePiece(name: name, value: "!") }
            if let hold = holdingRow(for: p), hold.window.resetsAtDate != nil {
                return InlinePiece(name: name, value: hold.resetsIn, locked: true)
            }
            guard let row = plainWeeklyRow(for: p) ?? accountRow(for: p) else { return nil }
            return InlinePiece(name: name, value: current(row).percentText)
        }
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
    /// Providers a multi-account family had no line for, owned up to at the end ("+2 more").
    var hiddenProviders: Int = 0

    var body: some View {
        HStack(spacing: 5) {
            StatusDot(color: Theme.freshnessColor(model.freshness), size: 6)
            Text(showHost ? model.updatedWithHost : model.updatedText)
                .monospacedDigit()
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if hiddenProviders > 0 {
                Spacer(minLength: 4)
                Text("+\(hiddenProviders) more")
                    .monospacedDigit()
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .fixedSize()
            }
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

    /// `rows` worst first, by the same order as `urgentRow`.
    func worstFirst(_ rows: [UsageWidgetRow]) -> [UsageWidgetRow] {
        return rows.enumerated()
            .sorted { urgencyKey($0.element, index: $0.offset) > urgencyKey($1.element, index: $1.offset) }
            .map { $0.element }
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

// MARK: - Several Claude accounts (desktop 1.1.0+)

/// The two-to-four character names the lock screen and the small widget give each Claude account.
///
/// Built from the name the desktop sends (the account's label, else "Claude 2"), so "C2" means what the
/// desktop's card calls Claude 2 even when the user has numbered his accounts differently from the slots.
enum AccountShortNames {
    /// "Claude 3" → "C3" · "Claude Blender 2" → "CB2" · "Claude Blender" → "CB" · "Work" → "WORK" ·
    /// "Personal" → "PERS". nil when the name says nothing an account could be told apart by
    /// (empty, or the bare "Claude").
    static func derive(_ name: String) -> String? {
        let words = name.split(whereSeparator: { $0.isWhitespace || "-_.·/".contains($0) }).map { String($0) }
        guard let last = words.last else { return nil }
        let initials: ([String]) -> String = { $0.compactMap { $0.first.map { String($0) } }.joined() }
        let short: String
        if words.count >= 2, last.allSatisfy({ $0.isASCII && $0.isNumber }) {
            short = initials(Array(words.dropLast().prefix(2))) + last
        } else if words.count >= 2 {
            short = initials(Array(words.prefix(3)))
        } else if last.lowercased() == "claude" {
            return nil
        } else {
            short = String(last.prefix(4))
        }
        let out = String(short.uppercased().prefix(4))
        return out.isEmpty ? nil : out
    }

    /// Short name per account id. Any clash ("Claude 2" in slot 1 next to an unlabelled slot 2) makes
    /// EVERY account fall back to "C<slot>" — slots are unique, and two lines both saying "C2" would be
    /// worse than names that ignore the labels.
    static func assign(_ accounts: [ProviderSnapshot]) -> [String: String] {
        let bySlot: [String] = accounts.map { "C\(ProviderIds.claudeSlot($0.providerId) ?? 0)" }
        let derived: [String] = accounts.enumerated().map { derive($0.element.displayName) ?? bySlot[$0.offset] }
        let names = Set(derived).count == derived.count ? derived : bySlot
        var out: [String: String] = [:]
        for (index, account) in accounts.enumerated() { out[account.providerId] = names[index] }
        return out
    }
}

extension UsageWidgetRow {
    /// "5H" / "7D" — or the scope ("FABLE"), because the scope is the only thing that tells Claude's
    /// two 7D rows apart, and it fits where "FABLE 7D" does not.
    var windowTag: String {
        if window.kind == "weekly_scoped", let scope = window.scope, !scope.isEmpty {
            return scope.uppercased()
        }
        return shortLabel.isEmpty ? window.displayLabel.uppercased() : shortLabel
    }

    /// Weekly windows show the reset DAY ("Sep 14"); session windows show the reset CLOCK ("6:01 AM").
    /// A 7-day window's minute-of-day is noise, and the full "Sep 14, 11:50 AM" costs 82pt that the bar
    /// needs. A window already past its reset shows nothing — the stamp is in the past, and
    /// "Resetting..." needs the whole column.
    func resetStamp(settings: EffectiveSettings, now: Date) -> String? {
        guard let date = window.resetsAtDate, date > now else { return nil }
        if Formatting.isWeeklyWindow(window, now: nil) {
            return Formatting.formatDate(date, dateFormat: "date", timeFormat: settings.timeFormat)
        }
        return Formatting.formatTime(date, timeFormat: settings.timeFormat)
    }
}

extension UsageWidgetModel {
    /// The account's 5-hour window.
    func sessionRow(for provider: ProviderSnapshot) -> UsageWidgetRow? {
        return rows(for: provider).first { $0.window.kind == "session" }
    }

    /// The account's weekly: the plain weekly limit (else its most urgent scoped weekly), unless another
    /// limit longer than the session — a scoped "Fable" weekly, Codex's code-review window — sits at a
    /// WORSE threshold level: a calm 40% must never stand in for a red 95% next to it. Same-level
    /// siblings do not swap, or the line would flicker between "7D" and "FABLE" as two percents cross.
    func weeklyRow(for provider: ProviderSnapshot) -> UsageWidgetRow? {
        let longer = rows(for: provider).filter { $0.window.kind != "session" }
        let weekly = longer.first { $0.window.kind == "weekly" }
            ?? keepMostUrgent(longer.filter { $0.window.isWeeklyKind }, limit: 1).first
        let worst = keepMostUrgent(longer, limit: 1).first
        if let weekly = weekly, let worst = worst, worst.urgencyLevelRank > weekly.urgencyLevelRank { return worst }
        return weekly
    }

    /// The ONE row that stands for a Claude account where one line is all it gets (small, lock screen):
    /// its weekly, else its most urgent window. Weekly because that is the limit several accounts exist
    /// to spread; the session that is burning right now still reaches the headline through `urgentRow`.
    func accountRow(for provider: ProviderSnapshot) -> UsageWidgetRow? {
        return weeklyRow(for: provider) ?? keepMostUrgent(rows(for: provider), limit: 1).first
    }

    /// The two rings of a Claude account with NO five-hour window (Claude plans that dropped the session
    /// limit send only weeklies): its plain weekly outside, as the number to read, and its Fable weekly
    /// inside. nil for any other provider (Codex keeps `weeklyRow` over its windows), and for an account
    /// that still has a session or has no plain weekly to lead with.
    ///
    /// Fable is the inner ring whenever the account has one, whatever the other limits are doing: the
    /// rings are the weekly and Fable, and an inner ring that changed meaning as percents crossed would
    /// read as Fable when it was not. With no Fable limit (a renamed model scope) the most urgent other
    /// scoped weekly rides inside, named by its scope; with none of those the inner ring is left out.
    func weeklyPair(for provider: ProviderSnapshot) -> (outer: UsageWidgetRow, inner: UsageWidgetRow?)? {
        guard provider.isClaude else { return nil }
        var rest = rows(for: provider)
        guard !rest.contains(where: { $0.window.kind == "session" }),
              let index = rest.firstIndex(where: { $0.window.kind == "weekly" }) else { return nil }
        let weekly = rest.remove(at: index)
        if let fable = rest.first(where: { $0.window.isFableWeekly }) { return (weekly, fable) }
        let scoped = rest.filter { $0.window.kind == "weekly_scoped" && !($0.window.scope ?? "").isEmpty }
        return (weekly, worstFirst(scoped).first)
    }
}

extension UsageWindow {
    /// Claude's Fable weekly: the scoped weekly the desktop keys `weekly_fable` (scope "Fable").
    var isFableWeekly: Bool {
        guard kind == "weekly_scoped" else { return false }
        return (key ?? "").lowercased().contains("fable") || (scope ?? "").lowercased().contains("fable")
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
        return provider.widgetShortNote
    }
}

extension ProviderSnapshot {
    /// OK, or stale but still showing its last good values: numbers worth choosing an account by.
    var hasUsableNumbers: Bool { return statusKind == .ok || statusKind == .stale }

    /// The kind of problem, in the ~14 characters a small slot fits (see `ProviderBlockPlan.shortNote`).
    var widgetShortNote: String {
        switch statusKind {
        case .authRequired: return "Sign in needed"
        case .error: return "Unavailable"
        case .stale: return "Stale data"
        case .ok: return "No windows"
        }
    }
}

/// One provider as a ring in the multi-account home-screen families: its weekly on the outer ring (the
/// number in the middle), its five-hour session on the inner one. The windows it leaves out (a calm
/// scoped weekly) carry no "+1": `weeklyRow` already swaps in any of them that is worse than the weekly.
/// A provider with no five-hour window draws `weeklyPair` instead: the plain weekly outside, the Fable
/// weekly inside.
struct RingTilePlan: Identifiable {
    let id: Int
    let provider: ProviderSnapshot
    /// The weekly (`weeklyRow`, or `weeklyPair`'s plain weekly), else whatever single window the provider has.
    let outer: UsageWidgetRow?
    /// The session, when the outer ring is not already showing it; with no session, the Fable weekly.
    let inner: UsageWidgetRow?
    /// Draw the inner ring (empty when `inner` is nil). False only for a Claude account with no five-hour
    /// window and no second weekly to put inside: its rings are the weekly and Fable, so with no Fable it
    /// is the weekly alone rather than a dead track.
    var drawsInner: Bool = true

    /// The inner ring for the small widget, which leaves the session out by design: the second limit of
    /// a provider with no five-hour window (its Fable weekly), nil for one whose inner ring is a session.
    var secondLimit: UsageWidgetRow? {
        guard let inner = inner, inner.window.kind != "session" else { return nil }
        return inner
    }

    /// "Sign in needed" in place of the numbers when the provider reported no windows at all.
    var note: String? {
        guard outer == nil && inner == nil else { return nil }
        return provider.widgetShortNote
    }

    /// "FABLE" / "5H": says which window the outer ring is whenever it is not the plain weekly (a worse
    /// scoped weekly swapped in, or a provider with no weekly), so its number is never read as the weekly.
    var outerTag: String? {
        guard let outer = outer, outer.window.kind != "weekly" else { return nil }
        return outer.windowTag
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

    /// The multi-account families: one ring per provider — every Claude account in slot order, then the
    /// others — cut at `maxTiles`. `hidden` is how many providers were cut.
    static func ringTiles(model: UsageWidgetModel, maxTiles: Int) -> (tiles: [RingTilePlan], hidden: Int) {
        var candidates: [ProviderSnapshot] = model.claudeAccounts
        candidates.append(contentsOf: model.providers.filter { !$0.isClaude })
        let kept = Array(candidates.prefix(max(0, maxTiles)))
        var tiles: [RingTilePlan] = []
        for (index, provider) in kept.enumerated() {
            let session = model.sessionRow(for: provider)
            let longer = model.worstFirst(model.rows(for: provider).filter { $0.window.kind != "session" })
            let outer: UsageWidgetRow?
            let inner: UsageWidgetRow?
            if let pair = model.weeklyPair(for: provider) {
                // No five-hour window: the weekly outside, the Fable weekly inside (or the weekly alone).
                tiles.append(RingTilePlan(id: index, provider: provider, outer: pair.outer, inner: pair.inner,
                                          drawsInner: pair.inner != nil))
                continue
            } else if let weekly = model.weeklyRow(for: provider) {
                outer = weekly
                inner = session
            } else if let worst = longer.first {
                // No weekly (a daily limit, a code-review window, a provider this build does not know): the
                // worst of the longer limits outside, the session (else the next worst) inside.
                outer = worst
                inner = session ?? (longer.count > 1 ? longer[1] : nil)
            } else {
                outer = session
                inner = nil
            }
            tiles.append(RingTilePlan(id: index, provider: provider, outer: outer, inner: inner))
        }
        return (tiles, candidates.count - kept.count)
    }
}

extension UsageWidgetModel {
    /// The account's weekly for all models, else `weeklyRow`. Choosing an account goes by this rather than
    /// by the ring: a used-up Fable share does not stop the account for everything else.
    func plainWeeklyRow(for provider: ProviderSnapshot) -> UsageWidgetRow? {
        return rows(for: provider).first { $0.window.kind == "weekly" } ?? weeklyRow(for: provider)
    }

    /// The limits that decide whether an account can be used right now.
    private func gatingRows(for account: ProviderSnapshot) -> [UsageWidgetRow] {
        return [sessionRow(for: account), plainWeeklyRow(for: account)].compactMap { $0 }
    }

    /// The Claude account to reach for next: the lowest of (session, weekly) among the accounts with numbers
    /// to go on (`hasUsableNumbers`), skipping any at a limit. A limit whose reset has passed since the
    /// payload was built counts as reset (a sleeping desktop leaves the phone an old payload).
    /// nil when every account is at a limit or has nothing to show.
    var mostRoom: ProviderSnapshot? {
        var best: (provider: ProviderSnapshot, load: Double)? = nil
        for account in claudeAccounts where account.hasUsableNumbers {
            let windows = gatingRows(for: account)
            guard !windows.isEmpty, !windows.contains(where: { $0.isAtLimit(now: now) }) else { continue }
            let load = windows.map { $0.effectivePercent(now: now) }.max() ?? 0
            if best == nil || load < best!.load { best = (account, load) }
        }
        return best?.provider
    }

    /// With every account at a limit: the one that frees up first, and the window holding it back (its
    /// latest-resetting limit, since an account is only usable again once all of them clear). Accounts
    /// that need a sign-in are skipped, as in `mostRoom`.
    var nextFreed: (provider: ProviderSnapshot, row: UsageWidgetRow)? {
        var best: (provider: ProviderSnapshot, row: UsageWidgetRow, at: Date)? = nil
        for account in claudeAccounts where account.hasUsableNumbers {
            let blocking = gatingRows(for: account).filter { $0.isAtLimit(now: now) }
            let latest = blocking.compactMap { row in row.window.resetsAtDate.map { (row: row, at: $0) } }.max { $0.at < $1.at }
            guard let hold = latest else { continue }
            if best == nil || hold.at < best!.at { best = (account, hold.row, hold.at) }
        }
        return best.map { ($0.provider, $0.row) }
    }
}

extension UsageWidgetRow {
    /// Used up: 100%, or a window the desktop reports as blocked.
    var isAtLimit: Bool { return window.isBlocked || Formatting.clampPercent(window.percent) >= 100 }

    /// `isAtLimit`, unless the window has reset since the payload was built.
    func isAtLimit(now: Date) -> Bool {
        if let reset = window.resetsAtDate, reset <= now { return false }
        return isAtLimit
    }

    /// The percent, or 0 once the window has reset since the payload was built.
    func effectivePercent(now: Date) -> Double {
        if let reset = window.resetsAtDate, reset <= now { return 0 }
        return Formatting.clampPercent(window.percent)
    }

    /// A ring in a word: "idle" for a window that has not started (no reset time, 0%), else "45%". A scoped
    /// weekly is never "idle": "fable idle" under a ring reads as a state of Fable, so an untouched one is
    /// "fable 0%". Every other kind keeps "idle", as before scoped weeklies could be an inner ring.
    var innerValue: String {
        if window.kind != "weekly_scoped", window.resetsAtDate == nil, Formatting.clampPercent(window.percent) == 0 { return "idle" }
        return percentText
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

    var body: some View {
        HStack(spacing: 3) {
            ProviderMark(providerId: providerId, size: 10)
            Text(row.windowTag)
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

    /// The day for a weekly, the clock for a session (`resetStamp`); Large still shows the whole stamp.
    private var stamp: String? { return row.resetStamp(settings: settings, now: now) }

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

// MARK: - Rings (several Claude accounts)

/// One ring, drawn inside its frame: a track in the row's own colour and an arc for its percent.
/// No row → the bare track.
struct RingArc: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    let row: UsageWidgetRow?
    let lineWidth: CGFloat
    let diameter: CGFloat

    /// At least a dot for 1-2%, so an account used a little never reads as untouched; and short of a
    /// limit, a notch at the top: the round caps reach lineWidth / 2 past each end, so 96-99% would
    /// otherwise draw the same closed ring as 100%.
    private var shown: CGFloat {
        guard let row = row, row.fraction > 0 else { return 0 }
        if row.isAtLimit { return 1 }
        let circumference = CGFloat.pi * max(1, diameter - lineWidth)
        let maxTrim = max(0.5, 1 - (lineWidth + 1.5) / circumference)
        return min(CGFloat(max(row.fraction, 0.025)), maxTrim)
    }

    var body: some View {
        // The lock screen and a tinted home screen keep only brightness: a blue track at 22% vanishes there, so the
        // arc goes primary and the track a quarter of it, as the system's own gauges draw.
        let tinted = renderingMode != .fullColor
        let color = tinted ? Color.primary : (row?.color ?? Color.primary)
        let track = tinted ? Color.primary.opacity(0.25) : (row == nil ? Theme.track : color.opacity(0.22))
        ZStack {
            Circle()
                .inset(by: lineWidth / 2)
                .stroke(track, lineWidth: lineWidth)
            if shown > 0 {
                Circle()
                    .inset(by: lineWidth / 2)
                    .trim(from: 0, to: shown)
                    .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .widgetAccentable()
            }
        }
    }
}

/// The weekly as the outer ring with its percent in the middle and, with `showInner`, the session (or,
/// for an account with no five-hour window, its Fable weekly) as a thinner ring inside it: the
/// Activity-rings shape, so several accounts compare at a glance.
struct RingGauge: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    let outer: UsageWidgetRow?
    var inner: UsageWidgetRow? = nil
    var showInner: Bool = false
    let diameter: CGFloat
    /// Under the number when the outer ring is not the plain weekly (`RingTilePlan.outerTag`).
    var tag: String? = nil

    private var outerWidth: CGFloat { return max(3, (diameter * 0.11).rounded()) }
    private var innerWidth: CGFloat { return max(2, (outerWidth * 0.62).rounded()) }
    private var innerDiameter: CGFloat { return diameter - 2 * (outerWidth + 1.5) }
    /// The room left in the middle for the number.
    private var hole: CGFloat {
        return max(0, (showInner ? innerDiameter - 2 * innerWidth : diameter - 2 * outerWidth) - 4)
    }

    var body: some View {
        ZStack {
            RingArc(row: outer, lineWidth: outerWidth, diameter: diameter)
                .frame(width: diameter, height: diameter)
            if showInner {
                RingArc(row: inner, lineWidth: innerWidth, diameter: innerDiameter)
                    .frame(width: innerDiameter, height: innerDiameter)
            }
            centre
                .frame(width: hole)
        }
        .frame(width: diameter, height: diameter)
    }

    @ViewBuilder private var centre: some View {
        if let row = outer {
            // Below a 20pt hole "100%" would need a 6pt font; the bare number stays readable, and the arc
            // and the caption already say it is a percent.
            let bare = hole < 20
            let size = max(8, hole * (bare ? 0.5 : 0.47) * (tag == nil ? 1 : 0.88))
            let number = Text("\(Int(Formatting.clampPercent(row.window.percent).rounded()))")
                .font(.system(size: size, weight: .bold, design: .rounded))
            let sign = Text(bare ? "" : "%")
                .font(.system(size: size * 0.55, weight: .bold, design: .rounded))
            VStack(spacing: 0) {
                Text("\(number)\(sign)")
                    .monospacedDigit()
                    .foregroundStyle(row.level == .danger && renderingMode == .fullColor ? Theme.dangerText : Color.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                if let tag = tag {
                    Text(tag)
                        .font(.system(size: max(5.5, hole * 0.19), weight: .bold))
                        .kerning(0.2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
            }
        } else {
            Text("—")
                .font(.system(size: max(8, hole * 0.4), weight: .semibold, design: .rounded))
                .foregroundStyle(.secondary)
        }
    }
}

extension UsageWidgetRow {
    /// "WEEKLY" / "5-HOUR" / "FABLE": what a ring's colour stands for on a large card.
    var ringLabel: String {
        if window.kind == "weekly_scoped", let scope = window.scope, !scope.isEmpty { return scope.uppercased() }
        if window.kind == "weekly" { return "WEEKLY" }
        if window.kind == "session" { return shortLabel == "5H" ? "5-HOUR" : "SESSION" }
        return window.displayLabel.uppercased()
    }

    /// "5h idle" / "5h 45%" / "fable 98%": the inner ring in words, under a medium ring.
    var innerCaption: String {
        return "\(windowTag.lowercased()) \(innerValue)"
    }
}

/// "↻ 1d 8h": how long until a window resets. Nothing for a window with no reset ahead of it.
struct RingResetLine: View {
    let row: UsageWidgetRow
    let now: Date
    var size: CGFloat = 9
    var weight: Font.Weight = .medium
    var style: HierarchicalShapeStyle = .secondary

    var body: some View {
        if let date = row.window.resetsAtDate, date > now {
            HStack(spacing: 2) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: size * 0.78, weight: .bold))
                Text(row.resetsIn)
                    .monospacedDigit()
            }
            .font(.system(size: size, weight: weight))
            .foregroundStyle(style)
            .lineLimit(1)
        }
    }
}

/// One column of the multi-account medium: the rings, the provider's name, when the weekly resets and
/// what the inner ring is doing (the session, or the Fable weekly of an account with no session).
struct RingTile: View {
    let tile: RingTilePlan
    let model: UsageWidgetModel
    let diameter: CGFloat
    /// Six or seven providers: "C2" instead of "Claude 2", and no reset line (two of them side by side
    /// are wider than a 44pt column).
    let compactName: Bool

    var body: some View {
        VStack(spacing: 3) {
            RingGauge(outer: tile.outer, inner: tile.inner, showInner: tile.drawsInner, diameter: diameter, tag: tile.outerTag)
                .opacity(tile.note == nil ? 1 : 0.5)
            HStack(spacing: 3) {
                // Middle, so "Claude Blender 2" keeps the number that tells it from "Claude Blender 3".
                Text(compactName ? model.shortName(for: tile.provider) : tile.provider.displayName)
                    .font(.system(size: 10, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .truncationMode(.middle)
                if tile.provider.statusKind != .ok {
                    StatusDot(color: Theme.statusColor(tile.provider.statusKind), size: 5)
                }
            }
            VStack(spacing: 1) {
                if let note = tile.note {
                    Text(note)
                        .font(.system(size: 9))
                        .foregroundStyle(Theme.statusText(tile.provider.statusKind))
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                } else {
                    if let outer = tile.outer, !compactName {
                        RingResetLine(row: outer, now: model.now)
                    }
                    if let inner = tile.inner {
                        if compactName && inner.window.kind != "session" {
                            // "fable 100%" is wider than a six- or seven-across column (54pt of a 44pt one),
                            // so the name and the number take a line each: the reset line's, which a
                            // compact column does not show.
                            caption(inner.windowTag.lowercased(), of: inner)
                            caption(inner.innerValue, of: inner)
                        } else {
                            caption(inner.innerCaption, of: inner)
                        }
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(RingTile.accessibility(tile))
    }

    private func caption(_ text: String, of inner: UsageWidgetRow) -> some View {
        return Text(text)
            .monospacedDigit()
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(inner.level == .danger ? Theme.dangerText : Color.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

    static func accessibility(_ tile: RingTilePlan) -> String {
        var parts = [tile.provider.displayName]
        if let note = tile.note { parts.append(note) }
        if let outer = tile.outer { parts.append("\(outer.window.displayLabel) \(outer.percentText), resets in \(outer.resetsIn)") }
        if let inner = tile.inner { parts.append("\(inner.window.displayLabel) \(inner.innerValue)") }
        return parts.joined(separator: ", ")
    }
}

/// One ring explained on a large card: a dot in its colour, its label (and, for the inner ring, whose
/// number is not in the middle, its percent), then when it resets, or "idle".
struct CardStat: View {
    let row: UsageWidgetRow
    let now: Date
    var showPercent: Bool = false
    /// One line instead of two (a four-row grid): the dot, then the percent ("5H 17%") for the inner
    /// ring or the reset for the outer one; the dots' colours already say which ring is which.
    var compact: Bool = false

    private var isIdle: Bool { return row.innerValue == "idle" }

    var body: some View {
        if compact {
            HStack(spacing: 3) {
                Circle()
                    .fill(row.color)
                    .frame(width: 5, height: 5)
                if showPercent {
                    Text("\(row.windowTag) \(row.innerValue)")
                        .monospacedDigit()
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(row.level == .danger ? Theme.dangerText : Color.primary)
                } else if row.window.resetsAtDate.map({ $0 > now }) == true {
                    RingResetLine(row: row, now: now, size: 10, weight: .semibold, style: .primary)
                } else {
                    Text(row.percentText)
                        .monospacedDigit()
                        .font(.system(size: 10, weight: .semibold))
                }
            }
            .lineLimit(1)
        } else {
            full
        }
    }

    private var full: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 3) {
                Circle()
                    .fill(row.color)
                    .frame(width: 5, height: 5)
                Text(row.ringLabel)
                    .font(.system(size: 8, weight: .semibold))
                    .kerning(0.3)
                    .foregroundStyle(.secondary)
                if showPercent && !isIdle {
                    Text(row.percentText)
                        .monospacedDigit()
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(row.level == .danger ? Theme.dangerText : Color.primary)
                }
            }
            .lineLimit(1)
            if isIdle {
                Text("idle")
                    .font(.system(size: 10.5, weight: .semibold))
            } else if row.window.resetsAtDate.map({ $0 > now }) == true {
                RingResetLine(row: row, now: now, size: 10.5, weight: .semibold, style: .primary)
            } else {
                Text(row.resetsIn)
                    .font(.system(size: 10.5, weight: .semibold))
                    .lineLimit(1)
            }
        }
    }
}

/// One provider on the multi-account large: name over its rings, each ring explained beside them.
struct AccountCard: View {
    let tile: RingTilePlan
    let model: UsageWidgetModel
    let diameter: CGFloat
    /// A four-row grid: the stats fold to one line each (`CardStat.compact`).
    var compact: Bool = false

    var body: some View {
        // No Spacers: each would also be charged the VStack's spacing, which the four-row grid has not got.
        VStack(alignment: .leading, spacing: compact ? 3 : 6) {
            HStack(spacing: 4) {
                ProviderMark(providerId: tile.provider.providerId, size: 11)
                Text(tile.provider.displayName)
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if tile.provider.statusKind != .ok {
                    StatusDot(color: Theme.statusColor(tile.provider.statusKind), size: 5)
                }
                Spacer(minLength: 0)
            }
            HStack(alignment: .center, spacing: 8) {
                RingGauge(outer: tile.outer, inner: tile.inner, showInner: tile.drawsInner, diameter: diameter)
                    .opacity(tile.note == nil ? 1 : 0.5)
                VStack(alignment: .leading, spacing: 6) {
                    if let note = tile.note {
                        Text(note)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Theme.statusText(tile.provider.statusKind))
                            .lineLimit(3)
                    } else {
                        if let outer = tile.outer {
                            CardStat(row: outer, now: model.now, compact: compact)
                        }
                        if let inner = tile.inner {
                            CardStat(row: inner, now: model.now, showPercent: true, compact: compact)
                        }
                    }
                }
                // Not a Spacer: the HStack would charge its 8pt spacing for it too, out of the stats.
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Theme.wellBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(RingTile.accessibility(tile))
    }
}

/// The large's last card: which account has the most room right now (the question several accounts
/// exist to answer), or, with all of them at a limit, which one frees up first; then the freshness line.
struct MostRoomCard: View {
    let model: UsageWidgetModel
    var hiddenProviders: Int = 0

    private func detail(_ account: ProviderSnapshot) -> String {
        var parts: [String] = []
        if let weekly = model.plainWeeklyRow(for: account) { parts.append("\(weekly.percentText) \(weekly.ringLabel.lowercased())") }
        // The inner ring in words: the session, or the Fable weekly of an account with no session.
        if let session = model.sessionRow(for: account) {
            parts.append(session.innerCaption)
        } else if let second = model.weeklyPair(for: account)?.inner {
            parts.append(second.innerCaption)
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let pick = model.mostRoom {
                headline(label: "MOST ROOM", provider: pick, detail: detail(pick))
            } else if let freed = model.nextFreed {
                headline(label: "NEXT TO FREE UP", provider: freed.provider, detail: "back in \(freed.row.resetsIn)")
            } else {
                Text("NO ACCOUNT READY")
                    .font(.system(size: 8, weight: .semibold))
                    .kerning(0.5)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 2)
            WidgetFreshnessLine(model: model, hiddenProviders: hiddenProviders)
        }
        .padding(8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.wellBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder private func headline(label: String, provider: ProviderSnapshot, detail: String) -> some View {
        Text(label)
            .font(.system(size: 8, weight: .semibold))
            .kerning(0.5)
            .foregroundStyle(.secondary)
        HStack(spacing: 4) {
            ProviderMark(providerId: provider.providerId, size: 13)
            Text(provider.displayName)
                .font(.system(size: 15, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        Text(detail)
            .monospacedDigit()
            .font(.system(size: 9.5, weight: .medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
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
// With several Claude accounts it becomes a 2 x 2 of weekly rings (`SmallRingsView`).

struct SmallWidgetView: View {
    let model: UsageWidgetModel

    var body: some View {
        if model.isMultiAccount {
            SmallRingsView(model: model)
        } else {
            SmallRowsView(model: model)
        }
    }
}

/// The one-Claude-account small (every 1.0.x desktop): the most urgent number over up to four bars.
struct SmallRowsView: View {
    let model: UsageWidgetModel

    /// Four usage lines is the hard ceiling at 126pt tall once the headline is paid for.
    private static let maxLines = 4

    private var blocks: [ProviderBlockPlan] {
        return WidgetPlanner.blocks(model: model, maxProviders: 3, totalRows: SmallRowsView.maxLines)
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

/// The multi-account small: a weekly ring per provider, two by two — the Claude accounts first, Codex
/// only if a cell is left over (so "+N" counts accounts only) — under a "WEEKLY" caption with the freshness dot. The session is left
/// out by design: the weekly is the limit several accounts exist to spread, and medium / large show both.
/// An account with no five-hour window gets its Fable weekly as an inner ring (`RingTilePlan.secondLimit`),
/// and the caption then names both rings, outside in: "WEEKLY · FABLE".
struct SmallRingsView: View {
    let model: UsageWidgetModel

    private static let maxTiles = 4
    private static let headerHeight: CGFloat = 14
    private static let rowGap: CGFloat = 6

    var body: some View {
        let plan = WidgetPlanner.ringTiles(model: model, maxTiles: SmallRingsView.maxTiles)
        let rows: [[RingTilePlan]] = stride(from: 0, to: plan.tiles.count, by: 2).map {
            Array(plan.tiles[$0..<min($0 + 2, plan.tiles.count)])
        }
        let hiddenAccounts = model.claudeAccounts.count - plan.tiles.filter { $0.provider.isClaude }.count
        // What the inner rings are, when they are all the same limit: one caption cannot name two.
        let innerTags = Set(plan.tiles.compactMap { $0.secondLimit?.windowTag })
        let innerName: String? = innerTags.count == 1 ? innerTags.first : nil
        let age = Formatting.relativeAgo(model.generatedDate, now: model.now)
        return GeometryReader { geo in
            let rowCount = CGFloat(max(1, rows.count))
            let cellHeight = (geo.size.height - SmallRingsView.headerHeight - (rowCount - 1) * SmallRingsView.rowGap) / rowCount
            let diameter = max(24, min(rows.count > 1 ? 46 : 56, cellHeight - 15, geo.size.width / 2 - 10))
            VStack(spacing: 0) {
                HStack(spacing: 4) {
                    Text(innerName.map { "WEEKLY · \($0)" } ?? "WEEKLY")
                        .font(.system(size: 8.5, weight: .semibold))
                        .kerning(innerName == nil ? 0.6 : 0.3)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    if hiddenAccounts > 0 {
                        Text("+\(hiddenAccounts)")
                            .monospacedDigit()
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundStyle(.tertiary)
                            .fixedSize()
                    }
                    Spacer(minLength: 2)
                    StatusDot(color: Theme.freshnessColor(model.freshness), size: 5)
                    // The longer caption takes the room "ago" had; the dot beside it already says this is an age.
                    Text(innerName != nil && age.hasSuffix(" ago") ? String(age.dropLast(4)) : age)
                        .monospacedDigit()
                        .font(.system(size: 8.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .fixedSize()
                }
                .frame(height: SmallRingsView.headerHeight, alignment: .top)
                Spacer(minLength: 0)
                VStack(spacing: SmallRingsView.rowGap) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { row in
                        HStack(spacing: 0) {
                            ForEach(row.element) { tile in
                                cell(tile, diameter: diameter)
                                    .frame(maxWidth: .infinity)
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    private func cell(_ tile: RingTilePlan, diameter: CGFloat) -> some View {
        VStack(spacing: 2) {
            RingGauge(outer: tile.outer, inner: tile.secondLimit, showInner: tile.secondLimit != nil,
                      diameter: diameter, tag: tile.outerTag)
                .opacity(tile.note == nil ? 1 : 0.5)
            HStack(spacing: 2) {
                Text(tile.provider.displayName)
                    .font(.system(size: 9, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if tile.provider.statusKind != .ok {
                    StatusDot(color: Theme.statusColor(tile.provider.statusKind), size: 4)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(RingTile.accessibility(tile))
    }
}

// MARK: - systemMedium  (306 x 126pt of content)
//
// Carries what systemLarge carried before: per-provider blocks with a header and plan badge,
// each row showing LABEL / time left / reset stamp / bar / percentage, plus the "Updated …" line.
// The two side-by-side columns are gone — they were what forced "FABLE..." — and every row is
// folded from two lines onto one, which is the entire 236pt -> 126pt saving.
//
// Several Claude accounts do not fit that shape: five 20pt headers alone are 100 of the 111pt.
// So each provider becomes one column (`RingTile`): weekly and session rings (weekly and Fable for an
// account with no five-hour window), the name, when the weekly resets and what the inner ring is
// doing — four accounts and Codex side by side.

struct MediumWidgetView: View {
    let model: UsageWidgetModel

    var body: some View {
        if model.isMultiAccount {
            MediumRingsView(model: model)
        } else {
            MediumBlocksView(model: model)
        }
    }
}

/// The multi-account medium: the freshness line, then a ring column per provider (up to seven: six
/// Claude accounts and Codex), centred in what is left.
struct MediumRingsView: View {
    let model: UsageWidgetModel

    private static let maxTiles = 7

    var body: some View {
        let plan = WidgetPlanner.ringTiles(model: model, maxTiles: MediumRingsView.maxTiles)
        let count = CGFloat(max(1, plan.tiles.count))
        return GeometryReader { geo in
            let column = geo.size.width / count
            // Header 11 + name 12 + two caption lines 23 + gaps 12 = 58pt that are not ring.
            let diameter = max(24, min(56, column - 8, geo.size.height - 58))
            VStack(spacing: 0) {
                WidgetFreshnessLine(model: model, hiddenProviders: plan.hidden)
                Spacer(minLength: 4)
                HStack(alignment: .top, spacing: 0) {
                    ForEach(plan.tiles) { tile in
                        RingTile(tile: tile, model: model, diameter: diameter, compactName: column < 54)
                            .frame(width: column)
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }
}

/// The one-Claude-account medium (every 1.0.x desktop): a header per provider, rows under it.
struct MediumBlocksView: View {
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
//
// Several Claude accounts: a two-column grid of cards (`AccountCard`), one per provider with its
// rings and their reset times spelled out, closed by a card saying which account has the most room
// (`MostRoomCard`) — the urgency banner's job, answered the way several accounts need it answered.

struct LargeWidgetView: View {
    let model: UsageWidgetModel

    var body: some View {
        if model.isMultiAccount {
            LargeCardsView(model: model)
        } else {
            LargeBlocksView(model: model)
        }
    }
}

struct LargeCardsView: View {
    let model: UsageWidgetModel

    /// Six Claude accounts and Codex, plus the summary card: four rows of two.
    private static let maxTiles = 7
    private static let gap: CGFloat = 8

    var body: some View {
        let plan = WidgetPlanner.ringTiles(model: model, maxTiles: LargeCardsView.maxTiles)
        let cells = plan.tiles.count + 1
        let rows = (cells + 1) / 2
        return GeometryReader { geo in
            let rowHeight = (geo.size.height - CGFloat(rows - 1) * LargeCardsView.gap) / CGFloat(rows)
            // Height: padding 12 + name 14 + gap 6 + slack 4 = 36pt of every card that is not ring. Width:
            // the stats beside the ring need ~72pt of the card's (width - gap) / 2 - 16.
            let cardWidth = (geo.size.width - LargeCardsView.gap) / 2 - 16
            let compact = rowHeight < 88
            let diameter = max(28, min(56, rowHeight - (compact ? 30 : 36), cardWidth - 8 - 76))
            VStack(spacing: LargeCardsView.gap) {
                ForEach(0..<rows, id: \.self) { row in
                    HStack(spacing: LargeCardsView.gap) {
                        ForEach([row * 2, row * 2 + 1].filter { $0 < cells }, id: \.self) { index in
                            if index < plan.tiles.count {
                                AccountCard(tile: plan.tiles[index], model: model, diameter: diameter, compact: compact)
                            } else {
                                MostRoomCard(model: model, hiddenProviders: plan.hidden)
                            }
                        }
                    }
                    .frame(height: rowHeight)
                }
            }
        }
    }
}

/// The one-Claude-account large: the banner over a card per provider.
struct LargeBlocksView: View {
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


// MARK: - Lock screen plans

extension UsageWidgetModel {
    /// `row` as it stands at `now`: a window whose reset has passed since the payload was built (a sleeping desktop
    /// leaves the phone an old one) reads as a new window — 0%, not started — so what the lock screen draws agrees
    /// with the account `mostRoom` picks, which already counts that limit as reset.
    func current(_ row: UsageWidgetRow) -> UsageWidgetRow {
        guard let reset = row.window.resetsAtDate, reset <= now,
              let provider = providers.first(where: { $0.providerId == row.providerId }) else { return row }
        var w = row.window
        w.percent = 0
        w.resetsAt = nil
        w.severity = nil
        w.isActive = false
        return makeRow(w, of: provider)
    }

    /// The limit keeping the provider out right now: of its session and plain weekly at a limit, the one that frees
    /// up last (a limit with no reset time counts as last). nil when it is not at a limit.
    func holdingRow(for provider: ProviderSnapshot) -> UsageWidgetRow? {
        return gatingRows(for: provider)
            .filter { $0.isAtLimit(now: now) }
            .max { ($0.window.resetsAtDate ?? .distantFuture) < ($1.window.resetsAtDate ?? .distantFuture) }
    }

    /// At a limit right now: the session or the plain weekly used up, its reset still ahead.
    func isBlocked(_ provider: ProviderSnapshot) -> Bool {
        return holdingRow(for: provider) != nil
    }

    /// Claude accounts in the order to reach for them: `mostRoom` first, then the other open ones by their weekly,
    /// lowest first, then the ones at a limit, soonest free first, then the ones with nothing to go on; slot order
    /// breaks ties.
    /// The pick leads even when its weekly is not the lowest: a session near its limit can rule out the rest.
    var accountsByRoom: [ProviderSnapshot] {
        let pick = mostRoom?.providerId
        let keyed = claudeAccounts.enumerated().map { (index, account) -> (account: ProviderSnapshot, key: (Int, Double, Int)) in
            guard account.hasUsableNumbers, let row = plainWeeklyRow(for: account) ?? accountRow(for: account) else {
                return (account, (3, 0, index))
            }
            if account.providerId == pick { return (account, (0, 0, index)) }
            // At a limit: the one that frees up first comes first.
            if let hold = holdingRow(for: account) {
                return (account, (2, hold.window.resetsAtDate?.timeIntervalSince(now) ?? .greatestFiniteMagnitude, index))
            }
            return (account, (1, row.effectivePercent(now: now), index))
        }
        return keyed.sorted { $0.key < $1.key }.map { $0.account }
    }

    /// The circular gauge: with several accounts, the one with the most room by its weekly (the limit several
    /// accounts exist to spread), else the first to free up by the limit holding it; with one, Claude's
    /// headline window. The account's other limit rides inside.
    var lockGauge: LockGaugePlan? {
        if isMultiAccount {
            if let pick = mostRoom, let row = plainWeeklyRow(for: pick) ?? accountRow(for: pick) {
                return gaugePlan(row, of: pick, caption: shortName(for: pick))
            }
            if let next = nextFreed {
                return gaugePlan(next.row, of: next.provider, caption: shortName(for: next.provider))
            }
            // Nothing to recommend: the first account with numbers worth showing, else nothing — the last numbers of
            // an account that needs a sign-in must not read as a live gauge.
            guard let open = accountsByRoom.first(where: { $0.hasUsableNumbers }),
                  let row = plainWeeklyRow(for: open) ?? accountRow(for: open) else { return nil }
            return gaugePlan(row, of: open, caption: shortName(for: open))
        }
        guard let h = headline, let provider = providers.first(where: { $0.providerId == h.providerId }) else { return nil }
        return gaugePlan(h, of: provider, caption: provider.isClaude ? h.windowTag : provider.displayName.uppercased())
    }

    /// `row` outside — or, at a limit, the limit that frees up last, so the countdown in the middle is when the
    /// account is usable again; inside, the session when the outer ring is a longer limit, else the plain weekly.
    /// An account with no five-hour window (`weeklyPair`) has its Fable weekly inside the weekly.
    private func gaugePlan(_ row: UsageWidgetRow, of provider: ProviderSnapshot, caption: String) -> LockGaugePlan {
        let outer = holdingRow(for: provider) ?? row
        let other: UsageWidgetRow?
        if outer.window.kind == "session" {
            other = plainWeeklyRow(for: provider)
        } else if let session = sessionRow(for: provider) {
            other = session
        } else if let pair = weeklyPair(for: provider) {
            // Whichever of the pair the outer ring is not already showing.
            other = pair.outer.window.key == outer.window.key ? pair.inner : pair.outer
        } else {
            other = nil
        }
        return LockGaugePlan(outer: current(outer), inner: other.map { current($0) }, caption: caption)
    }
}

/// One provider on the inline lock widget: "C4 4%", or "C1 🔒 1d 8h" while it is at a limit.
struct InlinePiece {
    let name: String
    let value: String
    /// At a limit: `value` is when it frees up, after a lock.
    var locked: Bool = false

    var text: Text {
        guard locked else { return Text(verbatim: "\(name) \(value)") }
        return Text(verbatim: "\(name) ") + Text(Image(systemName: "lock.fill")) + Text(verbatim: value)
    }
}

struct LockGaugePlan {
    let outer: UsageWidgetRow
    let inner: UsageWidgetRow?
    /// Under the number: whose limit it is ("C4"), or which ("5H").
    let caption: String
}

// MARK: - Lock screen: accessoryRectangular

struct AccessoryRectangularView: View {
    let model: UsageWidgetModel

    var body: some View {
        if model.isMultiAccount {
            AccessoryRingsView(model: model)
        } else {
            AccessoryBarsView(model: model)
        }
    }
}

/// Several Claude accounts: which one to reach for, over a ring per provider (its plain weekly, up to five).
struct AccessoryRingsView: View {
    let model: UsageWidgetModel
    static let maxTiles = 5

    var body: some View {
        let plan = WidgetPlanner.ringTiles(model: model, maxTiles: AccessoryRingsView.maxTiles)
        let pick = model.mostRoom?.providerId
        GeometryReader { geo in
            let count = CGFloat(max(1, plan.tiles.count))
            let spacing: CGFloat = plan.tiles.count > 3 ? 3 : 6
            let column = ((geo.size.width - spacing * (count - 1)) / count).rounded(.down)
            // Header 13 + gap 3 + ring + gap 2 + name 12.
            let diameter = max(18, min(column, geo.size.height - 30, 40)).rounded(.down)
            VStack(alignment: .leading, spacing: 3) {
                LockRingsHeader(model: model, hidden: plan.hidden)
                HStack(alignment: .top, spacing: spacing) {
                    ForEach(plan.tiles) { tile in
                        LockMiniRing(tile: tile, model: model, diameter: diameter, isPick: tile.provider.providerId == pick)
                            .frame(width: column)
                    }
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .leading)
        }
    }
}

/// "MOST ROOM C4", "NEXT FREE C1 ↻ 1d 8h" or "NO ACCOUNT READY"; then, beside MOST ROOM, how old the numbers
/// are once they are not fresh, and how many providers had no ring.
struct LockRingsHeader: View {
    let model: UsageWidgetModel
    let hidden: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            if let pick = model.mostRoom {
                caption("MOST ROOM")
                name(model.shortName(for: pick))
            } else if let next = model.nextFreed {
                caption("NEXT FREE")
                name(model.shortName(for: next.provider))
                // The reason this header exists: the name truncates before it does.
                RingResetLine(row: next.row, now: model.now, size: 10, weight: .semibold)
                    .fixedSize()
            } else {
                caption("NO ACCOUNT READY")
            }
            Spacer(minLength: 2)
            // Only beside MOST ROOM, where it changes the answer: a countdown runs from the reset time, not the
            // payload's age, and with every account out the rings already say so.
            if model.mostRoom != nil, model.freshness != .fresh, model.generatedDate != nil {
                Text(Formatting.relativeAgo(model.generatedDate, now: model.now))
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.secondary)
                    .layoutPriority(-1)
            }
            if hidden > 0 {
                Text("+\(hidden)")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.secondary)
            }
        }
        .monospacedDigit()
        .lineLimit(1)
        .frame(height: 13)
    }

    private func caption(_ text: String) -> some View {
        return Text(text)
            .font(.system(size: 9, weight: .bold))
            .kerning(0.4)
            .foregroundStyle(.secondary)
            .fixedSize()
    }

    private func name(_ text: String) -> some View {
        return Text(text)
            .font(.system(size: 11, weight: .bold))
            .minimumScaleFactor(0.8)
    }
}

/// One provider on the rectangular lock widget: its plain weekly as a ring with the number inside (a lock
/// while the account is at a limit, "!" when it has nothing to show), its short name under it.
struct LockMiniRing: View {
    let tile: RingTilePlan
    let model: UsageWidgetModel
    let diameter: CGFloat
    /// The account `MOST ROOM` names: its name stands out from the others.
    let isPick: Bool

    /// Nothing to show, or only the last numbers of an account that needs a sign-in.
    private var unusable: Bool { return tile.note != nil || !tile.provider.hasUsableNumbers }
    /// The plain weekly, not `tile.outer`: a used-up Fable share does not stop the account, and a ring this
    /// small has no room for the tag that would say it is not the weekly.
    private var row: UsageWidgetRow? {
        guard !unusable else { return nil }
        return (model.plainWeeklyRow(for: tile.provider) ?? tile.outer).map { model.current($0) }
    }
    private var lineWidth: CGFloat { return max(3, (diameter * 0.12).rounded()) }
    private var hole: CGFloat { return max(0, diameter - 2 * lineWidth - 2) }

    var body: some View {
        VStack(spacing: 2) {
            ZStack {
                RingArc(row: row, lineWidth: lineWidth, diameter: diameter)
                centre
            }
            .frame(width: diameter, height: diameter)
            .opacity(unusable ? 0.6 : 1)
            Text(tile.provider.isClaude ? model.shortName(for: tile.provider) : tile.provider.displayName)
                .font(.system(size: 10, weight: isPick ? .heavy : .semibold))
                .foregroundStyle(isPick ? HierarchicalShapeStyle.primary : HierarchicalShapeStyle.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(height: 12)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
    }

    private var accessibility: String {
        var parts = [tile.provider.displayName]
        if unusable {
            parts.append(tile.note ?? tile.provider.widgetShortNote)
        } else if let hold = model.holdingRow(for: tile.provider) {
            parts.append(hold.window.resetsAtDate.map { $0 > model.now } == true ? "at a limit, free in \(hold.resetsIn)" : "at a limit")
        } else if let row = row {
            parts.append("\(row.window.displayLabel) \(row.percentText)")
        }
        if isPick { parts.append("most room") }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder private var centre: some View {
        if unusable {
            Image(systemName: "exclamationmark")
                .font(.system(size: hole * 0.5, weight: .bold))
        } else if model.isBlocked(tile.provider) {
            Image(systemName: "lock.fill")
                .font(.system(size: hole * 0.45, weight: .semibold))
        } else if let row = row {
            // Five rings across fit the bare number (the ring already says it is a percent); three have room for "%".
            let bare = hole < 26
            let size = hole * (bare ? 0.52 : 0.42)
            let number = Text("\(Int(Formatting.clampPercent(row.window.percent).rounded()))")
                .font(.system(size: size, weight: .bold, design: .rounded))
            let sign = Text(bare ? "" : "%")
                .font(.system(size: size * 0.55, weight: .bold, design: .rounded))
            Text("\(number)\(sign)")
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .frame(width: hole)
        }
    }
}

/// One Claude account: Claude's session and weekly, then Codex's first window, as labelled bars.
struct AccessoryBarsView: View {
    let model: UsageWidgetModel

    private struct Line {
        let label: String
        let row: UsageWidgetRow
    }

    private var lines: [Line] {
        var out: [UsageWidgetRow] = []
        if let c = model.claude { out.append(contentsOf: model.rows(for: c).prefix(2)) }
        if let x = model.codex, let first = model.rows(for: x).first { out.append(first) }
        if out.isEmpty { out = Array(model.allRows.prefix(3)) }
        // An account named other than "Claude" is labelled "PERS 5H", so the window half survives the label
        // column and the two bars stay told apart.
        let claudeTag = model.singleAccountShortName
        let claudeId = model.claude?.providerId
        return out.prefix(3).map { row in
            if let tag = claudeTag, row.providerId == claudeId {
                return Line(label: "\(tag) \(row.windowTag)", row: model.current(row))
            }
            return Line(label: row.compactLabel, row: model.current(row))
        }
    }

    var body: some View {
        let lines = self.lines
        VStack(alignment: .leading, spacing: 4) {
            if lines.isEmpty {
                Text("AI Usage — no data")
                    .font(.system(size: 12, weight: .semibold))
            }
            ForEach(Array(lines.enumerated()), id: \.offset) { item in
                HStack(spacing: 6) {
                    Text(item.element.label)
                        .font(.system(size: 11, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .frame(width: 62, alignment: .leading)
                    AccessoryBar(fraction: item.element.row.fraction)
                    // "100%" wrapped to "100" over "%" without the line limit, which a full lock screen then
                    // clipped to "10...".
                    Text(item.element.row.percentText)
                        .monospacedDigit()
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(width: 34, alignment: .trailing)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(item.element.row.providerName) \(item.element.row.window.displayLabel) \(item.element.row.percentText)")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

/// Monochrome-friendly thin bar for the lock screen (the system tints accentable content).
struct AccessoryBar: View {
    let fraction: Double

    private func fillWidth(total: CGFloat) -> CGFloat {
        let clamped: Double = min(1.0, max(0.0, fraction.isFinite ? fraction : 0.0))
        let minimum: CGFloat = clamped > 0 ? 5 : 0
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
        .frame(height: 5)
    }
}

// MARK: - Lock screen: accessoryInline

struct AccessoryInlineView: View {
    let model: UsageWidgetModel

    var body: some View {
        let pieces = model.inlinePieces
        if pieces.isEmpty {
            Text("AI Usage — no data")
        } else {
            // Whole pieces or none, and a count of the rest: the slot would cut "C1 100%" to "C1 10…", which reads
            // as 10%.
            ViewThatFits(in: .horizontal) {
                ForEach((1...pieces.count).reversed(), id: \.self) { n in
                    line(pieces, count: n)
                }
            }
        }
    }

    private func line(_ pieces: [InlinePiece], count: Int) -> Text {
        var text = pieces[0].text
        for piece in pieces[1..<count] { text = text + Text(" · ") + piece.text }
        return count < pieces.count ? text + Text(" +\(pieces.count - count)") : text
    }
}

// MARK: - Lock screen: accessoryCircular

/// One account's limit as the outer ring with its number in the middle, its other limit as the inner ring,
/// and whose (or which) it is under the number. At a limit the middle says when it frees up instead.
struct AccessoryCircularView: View {
    let model: UsageWidgetModel

    var body: some View {
        GeometryReader { geo in
            let d = min(geo.size.width, geo.size.height)
            let outerWidth = max(4, (d * 0.085).rounded())
            let innerWidth = max(3, (outerWidth * 0.7).rounded())
            let innerDiameter = d - 2 * (outerWidth + 2)
            let plan = model.lockGauge
            let showInner = plan?.inner != nil
            let hole = max(0, (showInner ? innerDiameter - 2 * innerWidth : d - 2 * outerWidth) - 2)
            ZStack {
                RingArc(row: plan?.outer, lineWidth: outerWidth, diameter: d)
                    .frame(width: d, height: d)
                if showInner {
                    RingArc(row: plan?.inner, lineWidth: innerWidth, diameter: innerDiameter)
                        .frame(width: innerDiameter, height: innerDiameter)
                }
                centre(plan, hole: hole)
                    .frame(width: hole)
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
    }

    @ViewBuilder private func centre(_ plan: LockGaugePlan?, hole: CGFloat) -> some View {
        if let plan = plan {
            let row = plan.outer
            VStack(spacing: 0) {
                if row.isAtLimit(now: model.now), let reset = row.window.resetsAtDate, reset > model.now {
                    // The middle is a circle: a 6-character countdown has to stay inside its chord.
                    Image(systemName: "lock.fill")
                        .font(.system(size: hole * 0.18, weight: .semibold))
                    Text(row.resetsIn)
                        .font(.system(size: hole * 0.23, weight: .bold, design: .rounded))
                } else {
                    let size = hole * 0.4
                    let number = Text("\(Int(Formatting.clampPercent(row.window.percent).rounded()))")
                        .font(.system(size: size, weight: .bold, design: .rounded))
                    let sign = Text("%")
                        .font(.system(size: size * 0.55, weight: .bold, design: .rounded))
                    Text("\(number)\(sign)")
                }
                Text(plan.caption)
                    .font(.system(size: max(8, hole * 0.21), weight: .semibold))
                    .kerning(0.3)
                    .foregroundStyle(.secondary)
            }
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.6)
        } else {
            VStack(spacing: 0) {
                Text("—")
                    .font(.system(size: hole * 0.4, weight: .semibold, design: .rounded))
                Text("AI")
                    .font(.system(size: max(8, hole * 0.21), weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var accessibility: String {
        guard let plan = model.lockGauge else { return "AI Usage, no data" }
        var parts = [plan.caption, "\(plan.outer.window.displayLabel) \(plan.outer.percentText)"]
        if plan.outer.isAtLimit(now: model.now) { parts.append("resets in \(plan.outer.resetsIn)") }
        if let inner = plan.inner { parts.append("\(inner.window.displayLabel) \(inner.innerValue)") }
        return parts.joined(separator: ", ")
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
                    .font(.system(size: 18))
                VStack(alignment: .leading, spacing: 1) {
                    Text("AI Usage")
                        .font(.system(size: 13, weight: .semibold))
                    Text("Pair in the app")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
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
                    .font(.system(size: 16))
                Text(text)
                    .font(.system(size: 11))
                    .lineLimit(3)
                    .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
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
