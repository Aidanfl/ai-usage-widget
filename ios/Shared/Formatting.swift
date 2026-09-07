//
//  Formatting.swift
//  AIUsage (shared)
//
//  Swift port of src/renderer/format.js — same wording, same granularity:
//    "43m" · "4h 12m" · "1d 8h" · "Not started" · "—" · "Resetting..." · "3:59 PM" / "15:59" · "Sep 7"
//

import Foundation

enum ThresholdLevel {
    case normal
    case warning
    case danger
}

/// Payload age classification (PHONE-SYNC.md): green < 10 min, amber < 60 min, red otherwise.
enum Freshness {
    case fresh
    case aging
    case stale
    case unknown
}

enum Formatting {

    // MARK: Constants

    static let dayNames: [String] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    static let monthNames: [String] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    static let currencySymbols: [String: String] = ["USD": "$", "EUR": "€", "GBP": "£"]

    static let minuteMs: Double = 60_000
    static let hourMs: Double = 3_600_000
    static let dayMs: Double = 86_400_000

    /// Elapsed-ring thresholds (fixed, independent from the usage thresholds — v1.7.6 rule).
    static let elapsedAmberThreshold: Double = 75
    static let elapsedGreenThreshold: Double = 90

    static let freshMaxSeconds: TimeInterval = 10 * 60
    static let agingMaxSeconds: TimeInterval = 60 * 60

    // MARK: ISO-8601

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// ISO-8601 string (with or without fractional seconds) → Date. Also accepts a numeric ms string.
    static func parseISO(_ value: String?) -> Date? {
        guard let raw = value else { return nil }
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if let d = isoFractional.date(from: s) { return d }
        if let d = isoPlain.date(from: s) { return d }
        if let ms = Double(s), ms.isFinite { return Models.dateFromMs(ms) }
        return nil
    }

    /// ms epoch → ISO-8601 string (UTC, fractional seconds), nil when out of range.
    static func isoString(fromMs ms: Double) -> String? {
        guard let d = Models.dateFromMs(ms) else { return nil }
        return isoFractional.string(from: d)
    }

    // MARK: Durations & relative time

    /// ms → "43m" | "4h 12m" | "1d 8h". Negative/zero/non-finite → "0m".
    static func formatDuration(ms: Double) -> String {
        guard ms.isFinite, ms > 0 else { return "0m" }
        let totalMinutes = Int(ms / minuteMs)
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours >= 24 { return "\(hours / 24)d \(hours % 24)h" }
        if hours > 0 { return "\(hours)h \(minutes)m" }
        return "\(minutes)m"
    }

    /// "Resets in" cell text (format.js formatResetsIn).
    ///  - no resetsAt and no usage → "Not started"
    ///  - no resetsAt but usage > 0 → "—"
    ///  - resetsAt in the past      → "Resetting..."
    ///  - otherwise the duration until reset.
    static func resetsIn(resetsAt: Date?, percent: Double?, now: Date) -> String {
        guard let t = resetsAt else {
            return ((percent ?? 0) > 0) ? "—" : "Not started"
        }
        let diffMs = t.timeIntervalSince(now) * 1000.0
        if diffMs <= 0 { return "Resetting..." }
        return formatDuration(ms: diffMs)
    }

    /// "12s ago" | "3m ago" | "2h ago" | "5d ago" | "never".
    static func relativeAgo(_ date: Date?, now: Date) -> String {
        guard let d = date else { return "never" }
        let s = max(0, Int(now.timeIntervalSince(d)))
        if s < 60 { return "\(s)s ago" }
        let m = s / 60
        if m < 60 { return "\(m)m ago" }
        let h = m / 60
        if h < 24 { return "\(h)h ago" }
        return "\(h / 24)d ago"
    }

    /// Whole days until a date (ceil).
    static func daysUntil(_ date: Date, now: Date) -> Int {
        let days = date.timeIntervalSince(now) * 1000.0 / dayMs
        return Int(days.rounded(.up))
    }

    // MARK: Clock & calendar text (local time zone, English 3-letter names — as the original)

    static func pad2(_ n: Int) -> String {
        return n < 10 ? "0\(n)" : "\(n)"
    }

    /// "3:59 PM" (12h) or "15:59" (24h).
    static func formatTime(_ date: Date, timeFormat: String) -> String {
        let comps = Calendar.current.dateComponents([.hour, .minute], from: date)
        let h = comps.hour ?? 0
        let mm = pad2(comps.minute ?? 0)
        if timeFormat == "24h" { return "\(pad2(h)):\(mm)" }
        let period = h >= 12 ? "PM" : "AM"
        var h12 = h % 12
        if h12 == 0 { h12 = 12 }
        return "\(h12):\(mm) \(period)"
    }

    /// 'date' "Sep 7" | 'date-day' "Mon Sep 7" | 'date-day-time' "Mon Sep 7 3:59 PM".
    static func formatDate(_ date: Date, dateFormat: String, timeFormat: String = "12h") -> String {
        let comps = Calendar.current.dateComponents([.month, .day, .weekday], from: date)
        let monthIndex = max(0, min(11, (comps.month ?? 1) - 1))
        let weekdayIndex = max(0, min(6, (comps.weekday ?? 1) - 1))
        let base = "\(monthNames[monthIndex]) \(comps.day ?? 1)"
        switch dateFormat {
        case "date-day":
            return "\(dayNames[weekdayIndex]) \(base)"
        case "date-day-time":
            return "\(dayNames[weekdayIndex]) \(base) \(formatTime(date, timeFormat: timeFormat))"
        default:
            return base
        }
    }

    /// "Resets at" cell text: session-style windows show the time only; weekly-style windows show the date
    /// AND the time ("Sep 7, 3:59 PM" / "Sun Sep 7, 15:59"), matching the desktop widget. `dateFormat` only
    /// decides whether the weekday is included; the legacy "date-day-time" behaves like "date-day".
    /// Missing → "—".
    static func resetsAt(_ date: Date?, isWeekly: Bool, timeFormat: String, dateFormat: String) -> String {
        guard let d = date else { return "—" }
        if !isWeekly { return formatTime(d, timeFormat: timeFormat) }
        let withDay: Bool = (dateFormat == "date-day" || dateFormat == "date-day-time")
        let datePart: String = formatDate(d, dateFormat: withDay ? "date-day" : "date", timeFormat: timeFormat)
        return "\(datePart), \(formatTime(d, timeFormat: timeFormat))"
    }

    /// Tooltip-style "Sep 7, 3:59 PM".
    static func formatDateTime(_ date: Date, timeFormat: String) -> String {
        return "\(formatDate(date, dateFormat: "date")), \(formatTime(date, timeFormat: timeFormat))"
    }

    // MARK: Money & numbers

    /// Minor units + ISO currency → "$75.19" / "€12.00" / "12.34 CHF". `stripWholeCents` drops ".00" (caps: "$50").
    static func formatCurrency(minor: Double?, currency: String?, exponent: Int? = 2, stripWholeCents: Bool = false) -> String? {
        guard let minor = minor, minor.isFinite else { return nil }
        let exp = max(0, min(20, exponent ?? 2))
        let code = (currency ?? "USD").uppercased()
        let amount = abs(minor) / pow(10.0, Double(exp))
        var str = String(format: "%.\(exp)f", amount)
        if stripWholeCents && exp > 0, let dot = str.firstIndex(of: ".") {
            let fraction = str[str.index(after: dot)...]
            if !fraction.isEmpty && fraction.allSatisfy({ $0 == "0" }) {
                str = String(str[..<dot])
            }
        }
        let sign = minor < 0 ? "-" : ""
        if let sym = currencySymbols[code] { return sign + sym + str }
        return sign + str + " " + code
    }

    private static let decimalFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 2
        f.minimumFractionDigits = 0
        return f
    }()

    /// Locale-aware "1,234.5" (max 2 fraction digits).
    static func formatNumber(_ n: Double) -> String {
        return decimalFormatter.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    // MARK: Percent & thresholds

    /// 0..100 clamp; nil / non-finite → 0.
    static func clampPercent(_ p: Double?) -> Double {
        guard let p = p, p.isFinite else { return 0 }
        return min(100, max(0, p))
    }

    /// "42%" from a (clamped, rounded) percent.
    static func percentText(_ p: Double?) -> String {
        return "\(Int(clampPercent(p).rounded()))%"
    }

    /// Threshold class by the user thresholds (>= comparisons, as the original).
    static func thresholdLevel(percent: Double?, warn: Double, danger: Double) -> ThresholdLevel {
        guard let p = percent, p.isFinite else { return .normal }
        if p >= danger { return .danger }
        if p >= warn { return .warning }
        return .normal
    }

    /// Row colour level: `blocked` severity forces danger, otherwise the thresholds.
    static func rowLevel(_ window: UsageWindow, settings: EffectiveSettings) -> ThresholdLevel {
        if window.isBlocked { return .danger }
        return thresholdLevel(percent: window.percent, warn: settings.warnThreshold, danger: settings.dangerThreshold)
    }

    // MARK: Windows

    /// Fraction of the window that has elapsed (0..1); nil when inputs are missing.
    static func elapsedFraction(resetsAt: Date?, windowSeconds: Double?, now: Date) -> Double? {
        guard let t = resetsAt, let ws = windowSeconds, ws.isFinite, ws > 0 else { return nil }
        let windowMs = ws * 1000.0
        let diff = t.timeIntervalSince(now) * 1000.0
        if diff <= 0 { return 1 }
        let frac = (windowMs - diff) / windowMs
        return min(1, max(0, frac))
    }

    /// Weekly-style rows (and any row whose reset is ≥ 1 day away) show a date instead of a time.
    static func isWeeklyWindow(_ w: UsageWindow, now: Date?) -> Bool {
        if w.isWeeklyKind { return true }
        if let ws = w.windowSeconds, ws >= dayMs / 1000.0 { return true }
        if let now = now, let t = w.resetsAtDate, t.timeIntervalSince(now) * 1000.0 >= dayMs { return true }
        return false
    }

    /// "5H" | "7D" | "24H" | "30D" | "".
    static func shortWindowName(_ w: UsageWindow) -> String {
        if let ws = w.windowSeconds, ws.isFinite, ws > 0 {
            let daySeconds = dayMs / 1000.0
            if ws >= daySeconds { return "\(Int((ws / daySeconds).rounded()))D" }
            return "\(Int((ws / 3600.0).rounded()))H"
        }
        if w.kind == "session" { return "5H" }
        if w.isWeeklyKind { return "7D" }
        return ""
    }

    /// Compact-row label: "CLAUDE 5H" / "FABLE 7D" / "CODEX 7D".
    static func compactLabel(providerName: String, window w: UsageWindow) -> String {
        let base: String
        if w.kind == "weekly_scoped", let scope = w.scope, !scope.isEmpty {
            base = scope
        } else {
            base = providerName
        }
        let short = shortWindowName(w)
        let text = short.isEmpty ? "\(base) \(w.displayLabel)" : "\(base) \(short)"
        return text.trimmingCharacters(in: .whitespaces).uppercased()
    }

    /// Legend label: "Claude 5h" / "Fable 7d" / "Codex 7d".
    static func seriesLabel(providerName: String, window w: UsageWindow) -> String {
        let base: String
        if w.kind == "weekly_scoped", let scope = w.scope, !scope.isEmpty {
            base = scope
        } else {
            base = providerName
        }
        let short = shortWindowName(w)
        if short.isEmpty { return "\(base) \(w.displayLabel)".trimmingCharacters(in: .whitespaces) }
        return "\(base) \(short.lowercased())"
    }

    // MARK: Freshness

    static func freshness(generatedAt: Date?, now: Date) -> Freshness {
        guard let g = generatedAt else { return .unknown }
        let age = now.timeIntervalSince(g)
        if age < freshMaxSeconds { return .fresh }
        if age < agingMaxSeconds { return .aging }
        return .stale
    }
}
