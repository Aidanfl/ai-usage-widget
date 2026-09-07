//
//  Models.swift
//  AIUsage (shared between the app and the widget extension)
//
//  Codable mirrors of the desktop JSON contract:
//    • PhonePayload            — docs/PHONE-SYNC.md "PhonePayload (plaintext)"
//    • Snapshot & friends      — ARCHITECTURE.md §3
//
//  Every field is optional and decoded leniently: a missing key, a `null`, or an unexpected
//  type never throws for the payload as a whole. Timestamps are ms-epoch numbers; `resetsAt`
//  and the other reset/expiry stamps are ISO-8601 strings (parsed lazily in Formatting).
//

import Foundation

// MARK: - Helpers shared by the custom decoders

enum Models {
    /// Largest |ms| a JS Date can hold; anything beyond is garbage (mirrors format.js MAX_DATE_MS).
    static let maxDateMs: Double = 8.64e15

    /// ms epoch → Date, or nil when missing / non-finite / out of range.
    static func dateFromMs(_ ms: Double?) -> Date? {
        guard let ms = ms, ms.isFinite, abs(ms) <= maxDateMs else { return nil }
        return Date(timeIntervalSince1970: ms / 1000.0)
    }

    /// Date → ms epoch (Double, as the desktop emits it).
    static func msFromDate(_ date: Date) -> Double {
        return date.timeIntervalSince1970 * 1000.0
    }

    /// Decodes an array while skipping elements that fail to decode (instead of failing the whole array).
    /// A missing key, `null`, or a non-array value yields an empty array.
    static func decodeLossyArray<T: Decodable, K: CodingKey>(_ type: T.Type,
                                                            from container: KeyedDecodingContainer<K>,
                                                            forKey key: K) -> [T] {
        guard var unkeyed = try? container.nestedUnkeyedContainer(forKey: key) else { return [] }
        var out: [T] = []
        while !unkeyed.isAtEnd {
            if let item = try? unkeyed.decode(T.self) {
                out.append(item)
            } else if (try? unkeyed.decode(EmptyDecodable.self)) == nil {
                // Could not even skip the element — bail out rather than spin forever.
                break
            }
        }
        return out
    }

    /// Accepts any JSON value; used to step over undecodable array elements.
    private struct EmptyDecodable: Decodable {
        init(from decoder: Decoder) throws {}
    }
}

// MARK: - PhonePayload

struct PhonePayload: Codable, Equatable {
    var v: Int?
    var generatedAt: Double?            // ms epoch when the desktop built this payload
    var source: PayloadSource?
    var snapshot: Snapshot?
    var settings: PhoneSettings?
    var history: History?

    enum CodingKeys: String, CodingKey {
        case v, generatedAt, source, snapshot, settings, history
    }

    var generatedDate: Date? { return Models.dateFromMs(generatedAt) }
    var effectiveSettings: EffectiveSettings { return EffectiveSettings(settings) }
    /// Providers in display order (claude, codex, then anything else); `null` providers are dropped.
    var providers: [ProviderSnapshot] { return snapshot?.orderedProviders ?? [] }

    func provider(_ id: String) -> ProviderSnapshot? {
        return providers.first { $0.providerId == id }
    }
}

extension PhonePayload {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try? c.decodeIfPresent(Int.self, forKey: .v)
        generatedAt = try? c.decodeIfPresent(Double.self, forKey: .generatedAt)
        source = try? c.decodeIfPresent(PayloadSource.self, forKey: .source)
        snapshot = try? c.decodeIfPresent(Snapshot.self, forKey: .snapshot)
        settings = try? c.decodeIfPresent(PhoneSettings.self, forKey: .settings)
        history = try? c.decodeIfPresent(History.self, forKey: .history)
    }
}

struct PayloadSource: Codable, Equatable {
    var app: String?
    var version: String?
    var platform: String?      // 'win32' | 'darwin' | 'linux'
    var host: String?
}

struct PhoneSettings: Codable, Equatable {
    var warnThreshold: Double?
    var dangerThreshold: Double?
    var timeFormat: String?    // '12h' | '24h'
    var dateFormat: String?    // 'date' | 'date-day' | 'date-day-time' (not in the v1 payload; tolerated)
}

/// Validated settings with the desktop defaults filled in (warn 75 / danger 90 / 12h / 'date').
struct EffectiveSettings: Equatable {
    var warnThreshold: Double = 75
    var dangerThreshold: Double = 90
    var timeFormat: String = "12h"
    var dateFormat: String = "date"

    init(_ settings: PhoneSettings?) {
        var warn: Double = 75
        var danger: Double = 90
        if let w = settings?.warnThreshold, w.isFinite, w >= 1, w <= 99 { warn = w.rounded() }
        if let d = settings?.dangerThreshold, d.isFinite, d >= 1, d <= 99 { danger = d.rounded() }
        if warn >= danger {
            warn = 75
            danger = 90
        }
        warnThreshold = warn
        dangerThreshold = danger
        if settings?.timeFormat == "24h" { timeFormat = "24h" }
        if let df = settings?.dateFormat, ["date", "date-day", "date-day-time"].contains(df) { dateFormat = df }
    }

    static let defaults = EffectiveSettings(nil)
}

// MARK: - Snapshot (ARCHITECTURE.md §3)

struct Snapshot: Codable, Equatable {
    var fetchedAt: Double?
    /// `null` values are legal (a provider disabled in the desktop settings).
    var providers: [String: ProviderSnapshot?]?

    enum CodingKeys: String, CodingKey {
        case fetchedAt, providers
    }

    static let providerOrder: [String] = ["claude", "codex"]

    var fetchedDate: Date? { return Models.dateFromMs(fetchedAt) }

    /// Known providers first, then any other id sorted; `null` entries drop out. Fills a missing `id` from the key.
    var orderedProviders: [ProviderSnapshot] {
        guard let providers = providers else { return [] }
        var ids: [String] = Snapshot.providerOrder.filter { providers.keys.contains($0) }
        let others: [String] = providers.keys.filter { !Snapshot.providerOrder.contains($0) }.sorted()
        ids.append(contentsOf: others)
        var out: [ProviderSnapshot] = []
        for id in ids {
            guard let maybe = providers[id], var p = maybe else { continue }
            if p.id == nil || p.id == "" { p.id = id }
            out.append(p)
        }
        return out
    }
}

extension Snapshot {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fetchedAt = try? c.decodeIfPresent(Double.self, forKey: .fetchedAt)
        providers = try? c.decodeIfPresent([String: ProviderSnapshot?].self, forKey: .providers)
    }
}

enum ProviderStatus: String {
    case ok
    case stale
    case authRequired = "auth_required"
    case error
}

struct ProviderError: Codable, Equatable {
    var code: String?
    var message: String?
}

struct ProviderSnapshot: Codable, Equatable {
    var id: String?                 // 'claude' | 'codex'
    var name: String?               // 'Claude' | 'Codex'
    var status: String?             // 'ok' | 'stale' | 'auth_required' | 'error'
    var error: ProviderError?
    var source: String?             // 'claude_code' | 'claude_web' | 'codex_auth_file'
    var plan: String?
    var account: String?
    var updatedAt: Double?
    var windows: [UsageWindow]?
    var extra: ExtraUsage?
    var credits: CodexCredits?
    // `raw` is stripped by the desktop before pushing; if it ever appears it is ignored.

    enum CodingKeys: String, CodingKey {
        case id, name, status, error, source, plan, account, updatedAt, windows, extra, credits
    }

    var providerId: String { return id ?? "" }

    var displayName: String {
        if let n = name, !n.isEmpty { return n }
        if let i = id, !i.isEmpty { return i.capitalized }
        return "Provider"
    }

    var statusKind: ProviderStatus { return ProviderStatus(rawValue: status ?? "ok") ?? .ok }
    var windowList: [UsageWindow] { return windows ?? [] }
    var updatedDate: Date? { return Models.dateFromMs(updatedAt) }
    var hasDetails: Bool { return extra != nil || credits != nil }
    var errorMessage: String? {
        guard let m = error?.message?.trimmingCharacters(in: .whitespacesAndNewlines), !m.isEmpty else { return nil }
        return m
    }
}

extension ProviderSnapshot {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        error = try? c.decodeIfPresent(ProviderError.self, forKey: .error)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        plan = try? c.decodeIfPresent(String.self, forKey: .plan)
        account = try? c.decodeIfPresent(String.self, forKey: .account)
        updatedAt = try? c.decodeIfPresent(Double.self, forKey: .updatedAt)
        windows = Models.decodeLossyArray(UsageWindow.self, from: c, forKey: .windows)
        extra = try? c.decodeIfPresent(ExtraUsage.self, forKey: .extra)
        credits = try? c.decodeIfPresent(CodexCredits.self, forKey: .credits)
    }
}

// MARK: - UsageWindow

struct UsageWindow: Codable, Equatable {
    var key: String?                // 'session' | 'weekly' | 'weekly_fable' | 'primary' | ...
    var label: String?              // 'Current Session', 'Weekly Limit', ...
    var kind: String?               // 'session' | 'weekly' | 'weekly_scoped' | 'other'
    var percent: Double?            // 0..100, may exceed 100 → clamp when drawing
    var resetsAt: String?           // ISO-8601 or nil
    var windowSeconds: Double?      // 18000 / 604800 / nil
    var severity: String?           // 'normal' | 'warning' | 'critical' | 'blocked' | nil
    var isActive: Bool?
    var color: String?              // series colour token
    var scope: String?
    var note: String?

    enum CodingKeys: String, CodingKey {
        case key, label, kind, percent, resetsAt, windowSeconds, severity, isActive, color, scope, note
    }

    var displayLabel: String { return label ?? key ?? "" }
    var isBlocked: Bool { return severity == "blocked" }
    var isWeeklyKind: Bool { return kind == "weekly" || kind == "weekly_scoped" }
    var resetsAtDate: Date? { return Formatting.parseISO(resetsAt) }
    var colorToken: String { return color ?? "purple" }
}

extension UsageWindow {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try? c.decodeIfPresent(String.self, forKey: .key)
        label = try? c.decodeIfPresent(String.self, forKey: .label)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        percent = try? c.decodeIfPresent(Double.self, forKey: .percent)
        // Contract says ISO string; tolerate a ms number too.
        if let s = try? c.decodeIfPresent(String.self, forKey: .resetsAt) {
            resetsAt = s
        } else if let n = try? c.decodeIfPresent(Double.self, forKey: .resetsAt) {
            resetsAt = Formatting.isoString(fromMs: n)
        }
        windowSeconds = try? c.decodeIfPresent(Double.self, forKey: .windowSeconds)
        severity = try? c.decodeIfPresent(String.self, forKey: .severity)
        isActive = try? c.decodeIfPresent(Bool.self, forKey: .isActive)
        color = try? c.decodeIfPresent(String.self, forKey: .color)
        scope = try? c.decodeIfPresent(String.self, forKey: .scope)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
    }
}

// MARK: - ExtraUsage (Claude) — amounts are MINOR units (cents)

struct ExtraUsage: Codable, Equatable {
    var enabled: Bool?
    var currency: String?
    var exponent: Int?
    var usedMinor: Double?
    var limitMinor: Double?
    var percent: Double?
    var balanceMinor: Double?
    var promoMinor: Double?
    var paidMinor: Double?
    var nextExpiresAt: String?
    var nextExpiryMinor: Double?
    var disabledReason: String?

    enum CodingKeys: String, CodingKey {
        case enabled, currency, exponent, usedMinor, limitMinor, percent, balanceMinor, promoMinor, paidMinor
        case nextExpiresAt, nextExpiryMinor, disabledReason
    }
}

extension ExtraUsage {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try? c.decodeIfPresent(Bool.self, forKey: .enabled)
        currency = try? c.decodeIfPresent(String.self, forKey: .currency)
        if let e = try? c.decodeIfPresent(Int.self, forKey: .exponent) {
            exponent = e
        } else if let e = try? c.decodeIfPresent(Double.self, forKey: .exponent), e.isFinite {
            exponent = Int(e)
        }
        usedMinor = try? c.decodeIfPresent(Double.self, forKey: .usedMinor)
        limitMinor = try? c.decodeIfPresent(Double.self, forKey: .limitMinor)
        percent = try? c.decodeIfPresent(Double.self, forKey: .percent)
        balanceMinor = try? c.decodeIfPresent(Double.self, forKey: .balanceMinor)
        promoMinor = try? c.decodeIfPresent(Double.self, forKey: .promoMinor)
        paidMinor = try? c.decodeIfPresent(Double.self, forKey: .paidMinor)
        nextExpiresAt = try? c.decodeIfPresent(String.self, forKey: .nextExpiresAt)
        nextExpiryMinor = try? c.decodeIfPresent(Double.self, forKey: .nextExpiryMinor)
        disabledReason = try? c.decodeIfPresent(String.self, forKey: .disabledReason)
    }
}

// MARK: - CodexCredits

struct ModelAvailability: Codable, Equatable {
    var available: Bool?
    var availableAt: String?
}

struct CodexCredits: Codable, Equatable {
    var hasCredits: Bool?
    var unlimited: Bool?
    var balance: Double?
    var overageLimitReached: Bool?
    var approxLocalMessages: Double?
    var approxCloudMessages: Double?
    var limitReached: Bool?
    var limitReachedType: String?
    var modelUsage: [String: ModelAvailability]?
    var resetCreditsAvailable: Double?

    enum CodingKeys: String, CodingKey {
        case hasCredits, unlimited, balance, overageLimitReached, approxLocalMessages, approxCloudMessages
        case limitReached, limitReachedType, modelUsage, resetCreditsAvailable
    }

    /// Model names in a stable order.
    var modelNames: [String] { return (modelUsage ?? [:]).keys.sorted() }
}

extension CodexCredits {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hasCredits = try? c.decodeIfPresent(Bool.self, forKey: .hasCredits)
        unlimited = try? c.decodeIfPresent(Bool.self, forKey: .unlimited)
        balance = try? c.decodeIfPresent(Double.self, forKey: .balance)
        overageLimitReached = try? c.decodeIfPresent(Bool.self, forKey: .overageLimitReached)
        approxLocalMessages = try? c.decodeIfPresent(Double.self, forKey: .approxLocalMessages)
        approxCloudMessages = try? c.decodeIfPresent(Double.self, forKey: .approxCloudMessages)
        limitReached = try? c.decodeIfPresent(Bool.self, forKey: .limitReached)
        limitReachedType = try? c.decodeIfPresent(String.self, forKey: .limitReachedType)
        modelUsage = try? c.decodeIfPresent([String: ModelAvailability].self, forKey: .modelUsage)
        resetCreditsAvailable = try? c.decodeIfPresent(Double.self, forKey: .resetCreditsAvailable)
    }
}

// MARK: - History (downsampled 7-day chart data)

struct HistorySeries: Codable, Equatable {
    var key: String?        // 'claude.session'
    var label: String?      // 'Claude · Current Session'
    var color: String?      // series colour token
}

struct HistorySample: Codable, Equatable {
    var t: Double                   // ms epoch
    var v: [String: Double]         // series key → percent (gaps simply absent)

    enum CodingKeys: String, CodingKey {
        case t, v
    }

    var date: Date { return Date(timeIntervalSince1970: t / 1000.0) }
}

extension HistorySample {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        t = try c.decode(Double.self, forKey: .t)
        let raw: [String: Double?] = (try? c.decodeIfPresent([String: Double?].self, forKey: .v)) ?? [:]
        v = raw.compactMapValues { $0 }
    }
}

struct History: Codable, Equatable {
    var days: Int?
    var samples: [HistorySample]?
    var series: [HistorySeries]?

    enum CodingKeys: String, CodingKey {
        case days, samples, series
    }

    /// Samples sorted by time, with non-finite timestamps dropped.
    var sampleList: [HistorySample] {
        return (samples ?? []).filter { $0.t.isFinite }.sorted { $0.t < $1.t }
    }

    /// Series descriptors that have a usable key.
    var seriesList: [HistorySeries] {
        return (series ?? []).filter { ($0.key ?? "").isEmpty == false }
    }

    var isEmpty: Bool { return sampleList.isEmpty || seriesList.isEmpty }
}

extension History {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        days = try? c.decodeIfPresent(Int.self, forKey: .days)
        samples = Models.decodeLossyArray(HistorySample.self, from: c, forKey: .samples)
        series = Models.decodeLossyArray(HistorySeries.self, from: c, forKey: .series)
    }
}

// MARK: - Cached payload wrapper (App Group container)

struct CachedPayload: Codable {
    var payload: PhonePayload
    var fetchedAtMs: Double         // when the phone fetched it
    var envelopeTs: Double?         // desktop push time from the wire envelope (plaintext `ts`)

    var fetchedDate: Date { return Date(timeIntervalSince1970: fetchedAtMs / 1000.0) }
}
