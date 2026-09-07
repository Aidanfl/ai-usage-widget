//
//  SettingsView.swift
//  AIUsage — pairing details, refresh, unpair, diagnostics and attribution.
//

import SwiftUI
import UIKit

@MainActor
struct SettingsView: View {
    @EnvironmentObject private var store: UsageStore
    @Environment(\.dismiss) private var dismiss
    @State private var confirmUnpair: Bool = false
    @State private var copiedSlot: Bool = false

    // Literal constants — the only force-unwraps in the project.
    static let repoURL = URL(string: "https://github.com/Aidanfl/ai-usage-widget")!
    static let protocolURL = URL(string: "https://github.com/Aidanfl/ai-usage-widget/blob/main/docs/PHONE-SYNC.md")!
    static let upstreamURL = URL(string: "https://github.com/SlavomirDurej/claude-usage-widget")!

    private var appVersion: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(short) (\(build))"
    }

    var body: some View {
        NavigationStack {
            Form {
                pairingSection
                statusSection
                aboutSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .confirmationDialog("Unpair this phone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    store.unpair()
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The pairing key and the cached snapshot are removed from this phone and its widgets. The desktop keeps pushing until you also unpair there (Settings ▸ Phone ▸ Unpair).")
            }
        }
    }

    // MARK: Sections

    private var pairingSection: some View {
        Section("Pairing") {
            if let p = store.pairing {
                LabeledContent("Relay", value: p.relayURL.absoluteString)
                LabeledContent("Slot") {
                    Text(p.slotId)
                        .font(.system(size: 12, design: .monospaced))
                        .textSelection(.enabled)
                }
                Button {
                    UIPasteboard.general.string = p.slotId
                    copiedSlot = true
                } label: {
                    Label(copiedSlot ? "Slot id copied" : "Copy slot id", systemImage: copiedSlot ? "checkmark" : "doc.on.doc")
                }
                Button {
                    Task { await store.refresh() }
                } label: {
                    Label(store.isRefreshing ? "Refreshing…" : "Refresh now", systemImage: "arrow.clockwise")
                }
                .disabled(store.isRefreshing)
                Button(role: .destructive) {
                    confirmUnpair = true
                } label: {
                    Label("Unpair", systemImage: "xmark.circle")
                }
            } else {
                Text("Not paired")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var statusSection: some View {
        Section("Status") {
            LabeledContent("Last fetched", value: store.lastFetched.map { dateText($0) } ?? "never")
            LabeledContent("Desktop pushed", value: store.lastEnvelopeTs.map { dateText($0) } ?? "—")
            LabeledContent("Snapshot built", value: store.payload?.generatedDate.map { dateText($0) } ?? "—")
            if let src = store.payload?.source {
                LabeledContent("Desktop", value: sourceText(src))
            }
            LabeledContent("Shared container", value: PayloadCache.usesSharedContainer ? "available" : "missing (App Group?)")
            if let e = store.error {
                Text(e)
                    .font(.footnote)
                    .foregroundStyle(Theme.dangerText)
            }
        }
    }

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("Version", value: appVersion)
            Link(destination: SettingsView.repoURL) {
                Label("GitHub — Aidanfl/ai-usage-widget", systemImage: "link")
            }
            Link(destination: SettingsView.protocolURL) {
                Label("How phone sync works (docs/PHONE-SYNC.md)", systemImage: "lock.shield")
            }
            Link(destination: SettingsView.upstreamURL) {
                Label("Based on claude-usage-widget by Slavomir Durej (MIT)", systemImage: "heart")
            }
            Text("Unofficial — not affiliated with Anthropic or OpenAI. This phone never holds Claude or Codex credentials; it only decrypts usage snapshots pushed by your own desktop widget.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Helpers

    private func dateText(_ date: Date) -> String {
        let tf = store.payload?.effectiveSettings.timeFormat ?? "12h"
        return Formatting.formatDateTime(date, timeFormat: tf)
    }

    private func sourceText(_ src: PayloadSource) -> String {
        var parts: [String] = []
        if let h = src.host, !h.isEmpty { parts.append(h) }
        if let v = src.version, !v.isEmpty { parts.append("v\(v)") }
        if let p = src.platform, !p.isEmpty { parts.append(p) }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }
}
