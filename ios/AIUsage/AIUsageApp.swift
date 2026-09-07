//
//  AIUsageApp.swift
//  AIUsage — companion app for the desktop AI Usage widget.
//

import SwiftUI

@main
struct AIUsageApp: App {
    @StateObject private var store = UsageStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active && store.isPaired {
                Task { await store.refresh() }
            }
        }
    }
}

/// Switches between the pairing screen and the dashboard; handles `aiusage://pair?…` links.
@MainActor
struct RootView: View {
    @EnvironmentObject private var store: UsageStore
    @State private var pairFailure: String = ""
    @State private var showPairFailure: Bool = false

    var body: some View {
        Group {
            if store.isPaired {
                DashboardView()
            } else {
                PairView()
            }
        }
        .onOpenURL { url in
            if let failure = store.handleIncomingURL(url) {
                pairFailure = failure
                showPairFailure = true
            } else if (url.host ?? "").lowercased() == "pair" {
                Task { await store.refresh() }
            }
        }
        .alert("Pairing failed", isPresented: $showPairFailure) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(pairFailure)
        }
    }
}
