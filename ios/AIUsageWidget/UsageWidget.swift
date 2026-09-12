//
//  UsageWidget.swift
//  AIUsageWidget — timeline provider (relay fetch → cache → placeholder) and the widget definition.
//
//  Timeline policy (docs/PHONE-SYNC.md): fetch with a 10 s timeout, fall back to the cached payload,
//  one entry, refresh `.after(now + 15 min)`.
//

import WidgetKit
import SwiftUI

// MARK: - Entry

enum UsageWidgetState {
    case unpaired
    case message(String)                                  // paired, but nothing to draw (with the reason)
    case data(PhonePayload, fetchedAt: Date, fromCache: Bool)
}

struct UsageEntry: TimelineEntry {
    let date: Date
    let state: UsageWidgetState
}

// MARK: - Loading

enum UsageWidgetLoader {
    static let refreshInterval: TimeInterval = 15 * 60

    static func load() async -> UsageEntry {
        let now = Date()
        let pairing: Pairing?
        do {
            pairing = try PairingStore.load()
        } catch {
            // PairingStore.load() returns nil when nothing is stored and THROWS when the key exists but
            // could not be read — a keychain failure (-34018), or the keychain still locked before the
            // first unlock after a reboot, since the item is kSecAttrAccessibleAfterFirstUnlock. Treating
            // that as "unpaired" would put "Pair in the app" on the home screen of a perfectly well paired
            // phone, on top of cached numbers we can still draw. Show the last known data instead and let
            // the next refresh recover.
            if let cached = PayloadCache.load() {
                return UsageEntry(date: now,
                                  state: .data(cached.payload, fetchedAt: cached.fetchedDate, fromCache: true))
            }
            return UsageEntry(date: now, state: .message(error.localizedDescription))
        }
        guard let pairing = pairing else {
            // A clean nil: there really is no pairing stored.
            return UsageEntry(date: now, state: .unpaired)
        }

        let client = RelayClient(pairing: pairing, timeout: 10)
        do {
            let result = try await client.fetchPayload()
            PayloadCache.save(CachedPayload(payload: result.payload,
                                            fetchedAtMs: Models.msFromDate(now),
                                            envelopeTs: result.envelope.ts))
            return UsageEntry(date: now, state: .data(result.payload, fetchedAt: now, fromCache: false))
        } catch {
            if let cached = PayloadCache.load() {
                return UsageEntry(date: now, state: .data(cached.payload, fetchedAt: cached.fetchedDate, fromCache: true))
            }
            let message: String
            if let relayError = error as? RelayError {
                message = relayError.userMessage
            } else {
                message = error.localizedDescription
            }
            return UsageEntry(date: now, state: .message(message))
        }
    }
}

// MARK: - Provider

struct UsageTimelineProvider: TimelineProvider {
    typealias Entry = UsageEntry

    func placeholder(in context: Context) -> UsageEntry {
        return UsageEntry(date: Date(), state: .data(SampleData.payload, fetchedAt: Date(), fromCache: false))
    }

    func getSnapshot(in context: Context, completion: @escaping (UsageEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        Task {
            let entry = await UsageWidgetLoader.load()
            completion(entry)
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UsageEntry>) -> Void) {
        Task {
            let entry = await UsageWidgetLoader.load()
            let next = Date().addingTimeInterval(UsageWidgetLoader.refreshInterval)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

// MARK: - Widget

struct UsageWidget: Widget {
    let kind: String = "AIUsageWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: UsageTimelineProvider()) { entry in
            UsageWidgetEntryView(entry: entry)
                .containerBackground(for: .widget) {
                    Theme.widgetBackground
                }
                .widgetURL(URL(string: "aiusage://open"))
        }
        .configurationDisplayName("AI Usage")
        .description("Claude and Codex usage limits, mirrored from your desktop widget.")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .systemLarge,
            .accessoryRectangular,
            .accessoryInline,
            .accessoryCircular,
        ])
    }
}

// MARK: - Entry view (family switch)

struct UsageWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UsageEntry

    var body: some View {
        switch entry.state {
        case .unpaired:
            UnpairedWidgetView(family: family)
        case .message(let text):
            MessageWidgetView(family: family, text: text)
        case .data(let payload, let fetchedAt, let fromCache):
            DataWidgetView(model: UsageWidgetModel(payload: payload, now: entry.date, fetchedAt: fetchedAt, fromCache: fromCache),
                           family: family)
        }
    }
}

struct DataWidgetView: View {
    let model: UsageWidgetModel
    let family: WidgetFamily

    var body: some View {
        switch family {
        case .systemSmall:
            SmallWidgetView(model: model)
        case .systemMedium:
            MediumWidgetView(model: model)
        case .systemLarge:
            LargeWidgetView(model: model)
        case .accessoryRectangular:
            AccessoryRectangularView(model: model)
        case .accessoryInline:
            AccessoryInlineView(model: model)
        case .accessoryCircular:
            AccessoryCircularView(model: model)
        default:
            SmallWidgetView(model: model)
        }
    }
}
