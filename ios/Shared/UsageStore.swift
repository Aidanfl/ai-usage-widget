//
//  UsageStore.swift
//  AIUsage (shared; the app's single source of truth)
//
//  Holds the pairing, the latest decrypted payload and the last error. Refreshes from the relay,
//  caches to the App Group container and pokes WidgetKit after pairing / a successful refresh.
//

import Foundation
import SwiftUI
import WidgetKit

@MainActor
final class UsageStore: ObservableObject {
    @Published private(set) var pairing: Pairing?
    @Published private(set) var payload: PhonePayload?
    @Published private(set) var lastFetched: Date?
    @Published private(set) var lastEnvelopeTs: Date?
    @Published private(set) var isRefreshing: Bool = false
    /// Human-readable description of the last failed refresh (nil after a success).
    @Published private(set) var error: String?
    /// Typed form of `error` (nil when the last refresh succeeded or the failure was not a relay error).
    @Published private(set) var lastRelayError: RelayError?
    /// Problem loading the stored pairing (corrupt / keychain), shown on the pair screen.
    @Published private(set) var pairingLoadError: String?

    var isPaired: Bool { return pairing != nil }

    init() {
        loadPairing()
        if let cached = PayloadCache.load() {
            payload = cached.payload
            lastFetched = cached.fetchedDate
            lastEnvelopeTs = Models.dateFromMs(cached.envelopeTs)
        }
    }

    // MARK: Pairing

    private func loadPairing() {
        do {
            pairing = try PairingStore.load()
            pairingLoadError = nil
        } catch {
            pairing = nil
            pairingLoadError = error.localizedDescription
        }
    }

    /// Parses and stores a pairing string (`aiusage://pair?v=1&r=…&k=…`). Throws `PairingError`.
    func pair(from string: String) throws {
        let parsed = try Pairing.parse(string)
        try PairingStore.save(parsed)
        pairing = parsed
        pairingLoadError = nil
        payload = nil
        lastFetched = nil
        lastEnvelopeTs = nil
        error = nil
        lastRelayError = nil
        PayloadCache.clear()
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Handles an incoming URL (`aiusage://pair?…`). Returns nil on success, otherwise the error text.
    func handleIncomingURL(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == "aiusage" else { return nil }
        let host = (url.host ?? "").lowercased()
        guard host == "pair" else { return nil }   // aiusage://open (widget deep link) — nothing to do
        do {
            try pair(from: url.absoluteString)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Forgets the pairing, the payload and the cache.
    func unpair() {
        do {
            try PairingStore.clear()
        } catch {
            // Best effort: even if the keychain refuses, the in-memory state is reset.
        }
        pairing = nil
        payload = nil
        lastFetched = nil
        lastEnvelopeTs = nil
        error = nil
        lastRelayError = nil
        PayloadCache.clear()
        WidgetCenter.shared.reloadAllTimelines()
    }

    // MARK: Refresh

    func refresh() async {
        guard let current = pairing else {
            error = "Not paired."
            return
        }
        if isRefreshing { return }
        isRefreshing = true
        defer { isRefreshing = false }

        let client = RelayClient(pairing: current)
        do {
            let result = try await client.fetchPayload()
            let now = Date()
            payload = result.payload
            lastFetched = now
            lastEnvelopeTs = result.envelope.pushedDate
            error = nil
            lastRelayError = nil
            PayloadCache.save(CachedPayload(payload: result.payload,
                                            fetchedAtMs: Models.msFromDate(now),
                                            envelopeTs: result.envelope.ts))
            WidgetCenter.shared.reloadAllTimelines()
        } catch let relayError as RelayError {
            self.error = relayError.userMessage
            self.lastRelayError = relayError
        } catch {
            self.error = error.localizedDescription
            self.lastRelayError = nil
        }
    }
}
