//
//  Cache.swift
//  AIUsage (shared)
//
//  Last decrypted payload, kept as JSON in the App Group container
//  (<container>/Library/Caches/last-payload.json) so the widget has something to draw when
//  the relay is unreachable. Falls back to the process's own Caches directory when the
//  App Group container is unavailable (e.g. missing entitlement during development).
//

import Foundation

enum PayloadCache {
    static let appGroup = "group.com.aidanfl.aiusage"
    static let fileName = "last-payload.json"

    /// Directory that holds the cache file (created on demand).
    static var directoryURL: URL? {
        let fm = FileManager.default
        let base: URL
        if let container = fm.containerURL(forSecurityApplicationGroupIdentifier: appGroup) {
            base = container.appendingPathComponent("Library", isDirectory: true)
                .appendingPathComponent("Caches", isDirectory: true)
        } else if let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first {
            base = caches
        } else {
            return nil
        }
        return base
    }

    static var fileURL: URL? {
        return directoryURL?.appendingPathComponent(fileName, isDirectory: false)
    }

    /// Whether the shared container is actually reachable (diagnostics in Settings).
    static var usesSharedContainer: Bool {
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) != nil
    }

    /// Writes atomically; failures are swallowed (a cache is best-effort).
    @discardableResult
    static func save(_ cached: CachedPayload) -> Bool {
        guard let dir = directoryURL, let url = fileURL else { return false }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: nil)
            let data = try JSONEncoder().encode(cached)
            try data.write(to: url, options: [.atomic])
            return true
        } catch {
            return false
        }
    }

    /// Reads the cache; nil when absent or unreadable.
    static func load() -> CachedPayload? {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(CachedPayload.self, from: data)
    }

    static func clear() {
        guard let url = fileURL else { return }
        _ = try? FileManager.default.removeItem(at: url)
    }
}
